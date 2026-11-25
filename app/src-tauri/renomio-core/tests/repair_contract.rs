//! 数据目录自检与修复的平台契约：任何平台、任何构建都必须满足以下行为。
//!
//! 断言只认稳定 `code` 与退出语义，不匹配中文文案；`path` 一律相对数据目录、
//! 用 `/` 分隔，这样脚本在三平台上判定一致。

use std::fs;
use std::path::{Path, PathBuf};

use renomio_core::repair::{self, QUARANTINE_DIR, REQUIRED_DIRS, STALE_TMP_MS};

const FIX_NOW: i64 = 1_700_000_000_000;

fn temp_root(tag: &str) -> PathBuf {
    static SEQ: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!(
        "renomio-repair-contract-{tag}-{}-{seq}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn with_dirs(root: &Path) {
    for name in REQUIRED_DIRS {
        fs::create_dir_all(root.join(name)).unwrap();
    }
}

fn write(root: &Path, rel_path: &str, text: &str) {
    let path = root.join(rel_path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(path, text).unwrap();
}

/// 把对外的 `/` 相对路径按段拼回本机路径（逐字前缀路径不接受 `/`）。
fn at(root: &Path, rel_path: &str) -> PathBuf {
    let mut p = root.to_path_buf();
    for seg in rel_path.split('/') {
        p.push(seg);
    }
    p
}

fn batch_json(id: &str) -> String {
    format!(
        r#"{{"id":"{id}","createdAt":1,"state":"completed","policy":"rename","roots":[],"counts":{{"total":0,"done":0,"skipped":0,"failed":0}},"items":[]}}"#
    )
}

fn snapshot_json(id: &str) -> String {
    format!(
        r#"{{"schema":"renomio-snapshot-v1","id":"{id}","createdAt":1,"roots":[],"entryCount":0,"hashed":0,"skipped":0,"entries":[]}}"#
    )
}

fn codes(r: &repair::Report) -> Vec<String> {
    r.findings.iter().map(|f| f.code.clone()).collect()
}

fn has(r: &repair::Report, code: &str) -> bool {
    r.findings.iter().any(|f| f.code == code)
}

#[test]
fn clean_data_dir_reports_nothing() {
    let root = temp_root("clean");
    with_dirs(&root);
    write(&root, "batches/1-000.json", &batch_json("1-000"));
    write(&root, "snapshots/s-1.json", &snapshot_json("s-1"));
    write(&root, "rule-history.json", r#"["a","b"]"#);
    let r = repair::check(&root);
    assert!(r.ok, "{:?}", codes(&r));
    assert!(r.findings.is_empty(), "{:?}", codes(&r));
    assert!(r.fixed.is_empty());
    assert!(r.quarantine.is_none());
    assert!(r.scanned >= 3, "扫过的文件数应计入真实文件：{}", r.scanned);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn missing_dirs_are_info_and_created() {
    let root = temp_root("dirs");
    let r = repair::check(&root);
    assert_eq!(r.findings.len(), 4, "{:?}", codes(&r));
    for f in &r.findings {
        assert_eq!(f.code, "missing-dir");
        assert_eq!(f.severity, "info");
        assert!(f.fixable);
        assert!(!f.path.contains('\\'), "path 必须用 / 分隔：{}", f.path);
    }
    let f = repair::fix(&root, FIX_NOW);
    assert_eq!(f.fixed.len(), 4);
    assert!(f.fixed.iter().all(|x| x.action == "create-dir"));
    for name in REQUIRED_DIRS {
        assert!(root.join(name).is_dir(), "{name} 必须被创建");
    }
    assert!(repair::check(&root).findings.is_empty());
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn missing_root_is_error_and_fix_creates_it() {
    let root = temp_root("noroot");
    fs::remove_dir_all(&root).unwrap();
    let r = repair::check(&root);
    assert_eq!(r.findings.len(), 1, "{:?}", codes(&r));
    assert_eq!(r.findings[0].code, "missing-root");
    assert_eq!(r.findings[0].severity, "error");
    assert!(r.findings[0].fixable);
    assert!(!r.ok);
    let f = repair::fix(&root, FIX_NOW);
    assert!(root.is_dir());
    assert!(f.fixed.iter().any(|x| x.code == "missing-root"));
    assert!(f.ok);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn root_is_file_is_error_and_not_fixable() {
    let root = temp_root("rootfile");
    fs::remove_dir_all(&root).unwrap();
    fs::write(&root, "x").unwrap();
    let r = repair::check(&root);
    assert_eq!(r.findings[0].code, "root-is-file");
    assert_eq!(r.findings[0].severity, "error");
    assert!(!r.findings[0].fixable);
    let f = repair::fix(&root, FIX_NOW);
    assert!(f.fixed.is_empty());
    assert!(
        fs::metadata(&root).unwrap().is_file(),
        "不能把文件当目录改掉"
    );
    assert!(!f.ok);
    let _ = fs::remove_file(&root);
}

#[test]
fn empty_batch_says_empty_file_in_detail() {
    let root = temp_root("emptybatch");
    with_dirs(&root);
    write(&root, "batches/1-000.json", "");
    let r = repair::check(&root);
    let f = r
        .findings
        .iter()
        .find(|f| f.code == "bad-batch")
        .expect("空批次必须被报出");
    assert_eq!(f.severity, "error");
    assert!(
        f.detail.contains("空文件"),
        "detail 必须说明空文件：{}",
        f.detail
    );
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn bad_batch_is_quarantined_never_deleted() {
    let root = temp_root("badbatch");
    with_dirs(&root);
    write(&root, "batches/2-000.json", "{ broken");
    let f = repair::fix(&root, FIX_NOW);
    assert_eq!(f.fixed.len(), 1);
    assert_eq!(f.fixed[0].action, "quarantine");
    assert_eq!(f.fixed[0].code, "bad-batch");
    assert_eq!(f.fixed[0].path, "batches/2-000.json");
    assert!(!at(&root, "batches/2-000.json").exists());
    let target = f.fixed[0].target.clone().expect("隔离必须给出目标路径");
    assert!(target.starts_with(QUARANTINE_DIR), "{target}");
    assert_eq!(
        fs::read_to_string(at(&root, &target)).unwrap(),
        "{ broken",
        "隔离副本必须原字节保留"
    );
    assert!(f.quarantine.is_some());
    assert!(repair::check(&root).ok, "修完之后必须干净");
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn batch_id_mismatch_is_warn_and_quarantined() {
    let root = temp_root("mismatch");
    with_dirs(&root);
    write(&root, "batches/8-000.json", &batch_json("9-000"));
    let r = repair::check(&root);
    let f = r
        .findings
        .iter()
        .find(|f| f.code == "batch-id-mismatch")
        .expect("id 不一致必须被报出");
    assert_eq!(f.severity, "warn");
    assert!(f.fixable);
    assert!(
        f.detail.contains("8-000") && f.detail.contains("9-000"),
        "{}",
        f.detail
    );
    let fixed = repair::fix(&root, FIX_NOW);
    assert_eq!(fixed.fixed[0].code, "batch-id-mismatch");
    assert!(repair::check(&root).ok);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn good_batch_bytes_are_untouched() {
    let root = temp_root("goodbatch");
    with_dirs(&root);
    write(&root, "batches/1-000.json", &batch_json("1-000"));
    let before = fs::read(at(&root, "batches/1-000.json")).unwrap();
    let f = repair::fix(&root, FIX_NOW);
    assert!(f.fixed.is_empty(), "{:?}", f.fixed.len());
    assert!(f.ok);
    assert_eq!(before, fs::read(at(&root, "batches/1-000.json")).unwrap());
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn bad_snapshot_and_id_mismatch_have_own_codes() {
    let root = temp_root("snap");
    with_dirs(&root);
    write(&root, "snapshots/broken.json", "");
    write(&root, "snapshots/file.json", &snapshot_json("other"));
    let r = repair::check(&root);
    assert!(has(&r, "bad-snapshot"), "{:?}", codes(&r));
    assert!(has(&r, "snapshot-id-mismatch"), "{:?}", codes(&r));
    let f = repair::fix(&root, FIX_NOW);
    assert_eq!(f.fixed.len(), 2);
    assert!(f.fixed.iter().all(|x| x.action == "quarantine"));
    assert!(repair::check(&root).ok);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn rule_history_must_be_array_or_object() {
    let root = temp_root("history");
    with_dirs(&root);
    for (text, ok) in [
        ("[]", true),
        ("{}", true),
        ("\"scalar\"", false),
        ("", false),
    ] {
        write(&root, "rule-history.json", text);
        let r = repair::check(&root);
        assert_eq!(
            has(&r, "bad-rule-history"),
            !ok,
            "rule-history `{text}` 的判定错了：{:?}",
            codes(&r)
        );
    }
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn stale_temp_is_deleted_fresh_temp_is_skipped() {
    let root = temp_root("tmp");
    with_dirs(&root);
    write(&root, "batches/3-000.json.tmp", "{}");
    // 临时文件的 mtime 是真实当前时间，所以「现在」也必须取真实时间，
    // 否则 age 会饱和到 0，看起来永远「太新」。
    let real_now = renomio_core::journal::now_ms();
    let fresh = repair::fix(&root, real_now);
    assert!(fresh.fixed.is_empty(), "新写的临时文件不能删");
    assert!(fresh.skipped.iter().any(|f| f.code == "leftover-temp"));
    assert!(at(&root, "batches/3-000.json.tmp").exists());
    let later = repair::fix(&root, real_now + STALE_TMP_MS + 60_000);
    assert_eq!(later.fixed.len(), 1);
    assert_eq!(later.fixed[0].action, "delete-temp");
    assert!(!at(&root, "batches/3-000.json.tmp").exists());
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn orphan_backup_is_info_and_never_touched() {
    let root = temp_root("orphan");
    with_dirs(&root);
    write(&root, "batches/1-000.json", &batch_json("1-000"));
    write(&root, "backups/1-000/20240101/x.jpg", "bin");
    write(&root, "backups/9-000/20240101/y.jpg", "bin");
    fs::create_dir_all(root.join("backups/7-000")).unwrap();
    let r = repair::check(&root);
    let orphans: Vec<&repair::Finding> = r
        .findings
        .iter()
        .filter(|f| f.code == "orphan-backup")
        .collect();
    assert_eq!(orphans.len(), 1, "只有 9-000 是孤儿：{:?}", codes(&r));
    assert_eq!(orphans[0].path, "backups/9-000");
    assert!(!orphans[0].fixable);
    assert_eq!(orphans[0].severity, "info");
    let f = repair::fix(&root, FIX_NOW);
    assert!(f.fixed.is_empty());
    assert!(
        at(&root, "backups/9-000/20240101/y.jpg").exists(),
        "备份不能被删"
    );
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn fix_is_idempotent_and_quarantine_not_duplicated() {
    let root = temp_root("idem");
    with_dirs(&root);
    write(&root, "batches/5-000.json", "{}");
    let first = repair::fix(&root, FIX_NOW);
    assert_eq!(first.fixed.len(), 1);
    let second = repair::fix(&root, FIX_NOW);
    assert!(second.fixed.is_empty(), "同一毫秒重跑不能再隔离一份");
    assert!(second.ok);
    let qdir = root.join(QUARANTINE_DIR).join(FIX_NOW.to_string());
    let entries: Vec<_> = fs::read_dir(&qdir)
        .expect("隔离目录必须存在")
        .flatten()
        .collect();
    assert_eq!(entries.len(), 1, "隔离目录里只该有一个文件");
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn check_never_writes_anything() {
    let root = temp_root("readonly");
    with_dirs(&root);
    write(&root, "batches/6-000.json", "{ broken");
    write(&root, "rule-history.json", "");
    let before = fs::read(at(&root, "batches/6-000.json")).unwrap();
    let r = repair::check(&root);
    assert!(r.fixed.is_empty(), "check 模式不能有修复记录");
    assert!(r.quarantine.is_none(), "check 模式下不会产出隔离目录");
    assert!(
        at(&root, "batches/6-000.json").exists(),
        "check 不能动文件"
    );
    assert!(!root.join(QUARANTINE_DIR).exists(), "check 不能建隔离目录");
    assert_eq!(before, fs::read(at(&root, "batches/6-000.json")).unwrap());
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn report_serializes_with_camel_case_and_stable_codes() {
    let root = temp_root("ser");
    with_dirs(&root);
    write(&root, "batches/7-000.json", "{");
    write(&root, "batches/8-000.json.tmp", "{}");
    write(&root, "backups/9-000/x.jpg", "bin");
    let f = repair::fix(&root, renomio_core::journal::now_ms());
    let text = serde_json::to_string(&f).unwrap();
    assert!(text.contains("\"root\""), "{text}");
    assert!(text.contains("\"scanned\""), "{text}");
    assert!(text.contains("\"findings\""), "{text}");
    assert!(text.contains("\"quarantine\""), "{text}");
    assert!(text.contains("\"target\""), "{text}");
    assert!(text.contains("\"fixable\""), "{text}");
    assert!(text.contains("\"code\":\"bad-batch\""), "{text}");
    assert!(text.contains("\"code\":\"orphan-backup\""), "{text}");
    assert!(!text.contains("\"fixable\":null"), "布尔字段不能为空");
    let _ = fs::remove_dir_all(&root);
}

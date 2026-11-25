//! 数据目录自检与修复：把「坏了但没人发现」的数据文件找出来，并给出可执行修法。
//!
//! 设计约束：
//! - **只碰 Renomio 自己的数据目录**，路径由调用方传入（`datadir::resolve` 的结果）。
//! - **不删用户数据**：坏文件一律**隔离**到 `repair-quarantine/<时间戳>/<原相对路径>`，而不是删除；
//!   只有本程序自己写的临时文件（`*.tmp` / `*.json.tmp`）才会被删，且要超过 24 小时。
//! - **幂等**：修完再查必须干净；同一个目录跑两次 `fix` 不会产生第二份隔离副本。
//! - 每个发现都带稳定 `code`，脚本与界面按 code 断言，不靠中文文案匹配。

use std::fs;
use std::path::{Path, PathBuf};

use crate::platform::native_path;

/// 隔离目录名（相对数据目录）。
pub const QUARANTINE_DIR: &str = "repair-quarantine";
/// 临时文件超过这个年龄才允许删除（24 小时）。
pub const STALE_TMP_MS: i64 = 24 * 60 * 60 * 1000;
/// 程序会用到、缺失就该重建的子目录。
pub const REQUIRED_DIRS: [&str; 4] = ["batches", "backups", "logs", "snapshots"];

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    /// 稳定标识：`missing-root` / `missing-dir` / `bad-batch` …
    pub code: String,
    /// `error` 阻断正常使用；`warn` 有风险但能跑；`info` 只是提示
    pub severity: String,
    /// 出问题的文件或目录（相对数据目录；根目录本身用绝对路径）
    pub path: String,
    /// 人话说明（含具体原因，如「空文件（0 字节）」）
    pub detail: String,
    /// 能否自动修
    pub fixable: bool,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FixedItem {
    pub code: String,
    pub path: String,
    /// `create-dir` / `quarantine` / `delete-temp`
    pub action: String,
    /// 隔离后的新路径（仅 quarantine）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// 被检查的数据目录
    pub root: String,
    /// 处理完是否已经没有 `error` 级发现
    pub ok: bool,
    /// 扫过的文件数（不含目录）
    pub scanned: usize,
    pub findings: Vec<Finding>,
    /// 本次真正修掉的项（`check` 恒为空）
    pub fixed: Vec<FixedItem>,
    /// 发现但没动的项（不可修，或临时文件太新）；`check` 时为空
    pub skipped: Vec<Finding>,
    /// 本次隔离目录（没隔离东西时为 None）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quarantine: Option<String>,
}

fn finding(
    code: &str,
    severity: &str,
    path: impl Into<String>,
    detail: impl Into<String>,
    fixable: bool,
) -> Finding {
    Finding {
        code: code.to_string(),
        severity: severity.to_string(),
        path: path.into(),
        detail: detail.into(),
        fixable,
    }
}

fn rel(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| path.to_string_lossy().to_string())
}

fn mtime_ms(path: &Path) -> Option<i64> {
    let meta = fs::metadata(native_path(path)).ok()?;
    let modified = meta.modified().ok()?;
    let since = modified.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(since.as_millis() as i64)
}

fn is_dir(path: &Path) -> bool {
    fs::metadata(native_path(path))
        .map(|m| m.is_dir())
        .unwrap_or(false)
}

fn is_file(path: &Path) -> bool {
    fs::metadata(native_path(path))
        .map(|m| m.is_file())
        .unwrap_or(false)
}

fn is_empty_file(path: &Path) -> bool {
    fs::metadata(native_path(path))
        .map(|m| m.len() == 0)
        .unwrap_or(false)
}

fn read_text(path: &Path) -> Result<String, String> {
    fs::read_to_string(native_path(path)).map_err(|e| format!("无法读取：{e}"))
}

fn parse_batch(text: &str) -> Result<crate::journal::Batch, String> {
    serde_json::from_str::<crate::journal::Batch>(text).map_err(|e| format!("不是合法批次：{e}"))
}

fn parse_snapshot(text: &str) -> Result<crate::snapshot::Snapshot, String> {
    serde_json::from_str::<crate::snapshot::Snapshot>(text).map_err(|e| format!("不是合法快照：{e}"))
}

struct Acc {
    report: Report,
}

impl Acc {
    fn new(root: &Path) -> Self {
        Self {
            report: Report {
                root: root.to_string_lossy().to_string(),
                ok: true,
                scanned: 0,
                findings: Vec::new(),
                fixed: Vec::new(),
                skipped: Vec::new(),
                quarantine: None,
            },
        }
    }

    fn push(&mut self, f: Finding) {
        self.report.findings.push(f);
    }

    fn fixed(&mut self, code: &str, path: &str, action: &str, target: Option<String>) {
        self.report.fixed.push(FixedItem {
            code: code.to_string(),
            path: path.to_string(),
            action: action.to_string(),
            target,
        });
    }

    fn skipped(&mut self, f: Finding) {
        self.report.skipped.push(f);
    }

    /// 丢掉已经修掉的发现，然后按「还有没有 error」收口
    fn finish(mut self) -> Report {
        let fixed = self.report.fixed.clone();
        self.report.findings.retain(|f| {
            !fixed
                .iter()
                .any(|x| x.code == f.code && x.path == f.path)
        });
        self.report.ok = !self
            .report
            .findings
            .iter()
            .any(|f| f.severity == "error");
        self.report
    }
}

/// 只看不改。
pub fn check(root: &Path) -> Report {
    scan(root, None)
}

/// 检查并尽量修。`now_ms` 由调用方给，便于测试里把时间推到未来。
pub fn fix(root: &Path, now_ms: i64) -> Report {
    scan(root, Some(now_ms))
}

fn scan(root: &Path, fix_at: Option<i64>) -> Report {
    let mut acc = Acc::new(root);
    let root_native = native_path(root);
    let root_text = root.to_string_lossy().to_string();

    if is_file(root) {
        acc.push(finding(
            "root-is-file",
            "error",
            root_text.clone(),
            "数据目录位置是一个文件，不是目录；请改名或换一个目录",
            false,
        ));
        return acc.finish();
    }

    if !is_dir(root) {
        acc.push(finding(
            "missing-root",
            "error",
            root_text.clone(),
            "数据目录不存在（首次运行或目录被手工删除）",
            true,
        ));
        if fix_at.is_some() {
            match fs::create_dir_all(&root_native) {
                Ok(()) => acc.fixed("missing-root", &root_text, "create-dir", None),
                Err(e) => acc.skipped(finding(
                    "missing-root",
                    "error",
                    root_text.clone(),
                    format!("创建失败：{e}"),
                    false,
                )),
            }
        }
        return acc.finish();
    }

    // 1. 必需子目录
    for name in REQUIRED_DIRS {
        let dir = root.join(name);
        if is_dir(&dir) {
            continue;
        }
        acc.push(finding(
            "missing-dir",
            "info",
            name,
            "子目录缺失，程序会在用到时重建",
            true,
        ));
        if fix_at.is_some() {
            match fs::create_dir_all(native_path(&dir)) {
                Ok(()) => acc.fixed("missing-dir", name, "create-dir", None),
                Err(e) => acc.skipped(finding(
                    "missing-dir",
                    "info",
                    name,
                    format!("创建失败：{e}"),
                    false,
                )),
            }
        }
    }

    // 2. 批次日志
    let batches = root.join("batches");
    for entry in list_files(&batches, &mut acc.report.scanned) {
        let name = file_name(&entry);
        let rel_path = rel(root, &entry);
        if name.ends_with(".tmp") {
            handle_temp(root, &entry, &rel_path, fix_at, &mut acc);
            continue;
        }
        if !name.ends_with(".json") {
            continue;
        }
        let text = match read_text(&entry) {
            Ok(t) => t,
            Err(e) => {
                acc.push(finding("bad-batch", "error", &rel_path, e, true));
                quarantine_if_needed(root, &entry, &rel_path, "bad-batch", fix_at, &mut acc);
                continue;
            }
        };
        let empty = is_empty_file(&entry);
        match parse_batch(&text) {
            Ok(batch) => {
                let stem = file_stem(&name);
                if stem != batch.id {
                    let detail = format!("文件名 `{stem}` 与内部 id `{}` 不一致", batch.id);
                    acc.push(finding("batch-id-mismatch", "warn", &rel_path, detail, true));
                    quarantine_if_needed(
                        root,
                        &entry,
                        &rel_path,
                        "batch-id-mismatch",
                        fix_at,
                        &mut acc,
                    );
                }
            }
            Err(reason) => {
                let detail = if empty {
                    format!("空文件（0 字节）；{reason}")
                } else {
                    reason
                };
                acc.push(finding("bad-batch", "error", &rel_path, detail, true));
                quarantine_if_needed(root, &entry, &rel_path, "bad-batch", fix_at, &mut acc);
            }
        }
    }

    // 3. 快照
    let snapshots = root.join("snapshots");
    for entry in list_files(&snapshots, &mut acc.report.scanned) {
        let name = file_name(&entry);
        let rel_path = rel(root, &entry);
        if name.ends_with(".tmp") {
            handle_temp(root, &entry, &rel_path, fix_at, &mut acc);
            continue;
        }
        if !name.ends_with(".json") {
            continue;
        }
        let text = match read_text(&entry) {
            Ok(t) => t,
            Err(e) => {
                acc.push(finding("bad-snapshot", "error", &rel_path, e, true));
                quarantine_if_needed(root, &entry, &rel_path, "bad-snapshot", fix_at, &mut acc);
                continue;
            }
        };
        let empty = is_empty_file(&entry);
        match parse_snapshot(&text) {
            Ok(snap) => {
                let stem = file_stem(&name);
                if stem != snap.id {
                    let detail = format!("文件名 `{stem}` 与内部 id `{}` 不一致", snap.id);
                    acc.push(finding("snapshot-id-mismatch", "warn", &rel_path, detail, true));
                    quarantine_if_needed(
                        root,
                        &entry,
                        &rel_path,
                        "snapshot-id-mismatch",
                        fix_at,
                        &mut acc,
                    );
                }
            }
            Err(reason) => {
                let detail = if empty {
                    format!("空文件（0 字节）；{reason}")
                } else {
                    reason
                };
                acc.push(finding("bad-snapshot", "error", &rel_path, detail, true));
                quarantine_if_needed(root, &entry, &rel_path, "bad-snapshot", fix_at, &mut acc);
            }
        }
    }

    // 4. 规则链输入历史（数据目录顶层文件）
    let history = root.join("rule-history.json");
    if history.exists() {
        acc.report.scanned += 1;
        let rel_path = rel(root, &history);
        let problem = if is_empty_file(&history) {
            Some("空文件（0 字节）".to_string())
        } else {
            match read_text(&history) {
                Err(e) => Some(e),
                Ok(t) => match serde_json::from_str::<serde_json::Value>(&t) {
                    Ok(v) if v.is_array() || v.is_object() => None,
                    Ok(_) => Some("顶层不是数组或对象".to_string()),
                    Err(e) => Some(format!("不是合法 JSON：{e}")),
                },
            }
        };
        if let Some(detail) = problem {
            acc.push(finding("bad-rule-history", "error", &rel_path, detail, true));
            quarantine_if_needed(root, &history, &rel_path, "bad-rule-history", fix_at, &mut acc);
        }
    }

    // 5. 孤儿备份（有备份目录但批次日志没了）——只提示，不动
    let backups = root.join("backups");
    for entry in list_dirs(&backups) {
        let batch_id = file_name(&entry);
        if root.join("batches").join(format!("{batch_id}.json")).exists() {
            continue;
        }
        // 只有目录里真放了东西才算孤儿（空目录不值得提示）。
        // 真实布局是 `backups/<batchId>/<时间戳>/<文件>`，所以得看一层子目录，
        // 不能只数直接文件。
        if dir_is_empty(&entry) {
            continue;
        }
        acc.push(finding(
            "orphan-backup",
            "info",
            rel(root, &entry),
            "批次日志已不存在，这批备份不会被撤销引用；确认不需要后可手工删除",
            false,
        ));
    }

    // 6. backups 里可能残留的临时文件
    for entry in list_files(&backups, &mut acc.report.scanned) {
        let name = file_name(&entry);
        if name.ends_with(".tmp") {
            let rel_path = rel(root, &entry);
            handle_temp(root, &entry, &rel_path, fix_at, &mut acc);
        }
    }

    acc.finish()
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default()
}

fn file_stem(name: &str) -> String {
    Path::new(name)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default()
}

// 注意：`read_dir(native_path(dir))` 读出来的 entry 路径会带 `\\?\` 前缀，
// 与调用方传进来的 `dir` 不一致，后续 `strip_prefix(root)` 就切不掉前缀。
// 所以一律用 `dir.join(file_name)` 重新拼，保证路径前缀与 root 完全同源。
fn list_files(dir: &Path, scanned: &mut usize) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(read) = fs::read_dir(native_path(dir)) else {
        return out;
    };
    for entry in read.flatten() {
        let path = dir.join(entry.file_name());
        if let Ok(meta) = entry.metadata() {
            if meta.is_file() {
                *scanned += 1;
                out.push(path);
            }
        }
    }
    out.sort();
    out
}

fn list_dirs(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(read) = fs::read_dir(native_path(dir)) else {
        return out;
    };
    for entry in read.flatten() {
        if let Ok(meta) = entry.metadata() {
            if meta.is_dir() {
                out.push(dir.join(entry.file_name()));
            }
        }
    }
    out.sort();
    out
}

fn dir_is_empty(dir: &Path) -> bool {
    match fs::read_dir(native_path(dir)) {
        Ok(mut read) => read.next().is_none(),
        Err(_) => true,
    }
}

fn handle_temp(root: &Path, file: &Path, rel_path: &str, fix_at: Option<i64>, acc: &mut Acc) {
    let age = fix_at.and_then(|now| mtime_ms(file).map(|m| now.saturating_sub(m)));
    match (fix_at, age) {
        (None, _) => acc.push(finding(
            "leftover-temp",
            "warn",
            rel_path,
            "临时文件残留（可能是上次写入被中断）；修复时超过 24 小时会清理",
            true,
        )),
        (Some(_), None) => acc.push(finding(
            "leftover-temp",
            "warn",
            rel_path,
            "临时文件残留，读不到修改时间，本次不动".to_string(),
            false,
        )),
        (Some(_), Some(age_ms)) if age_ms >= STALE_TMP_MS => {
            match fs::remove_file(native_path(file)) {
                Ok(()) => acc.fixed("leftover-temp", rel_path, "delete-temp", None),
                Err(e) => acc.skipped(finding(
                    "leftover-temp",
                    "warn",
                    rel_path,
                    format!("删除失败：{e}"),
                    false,
                )),
            }
        }
        (Some(_), Some(age_ms)) => {
            acc.push(finding(
                "leftover-temp",
                "warn",
                rel_path,
                format!(
                    "临时文件残留，但只有 {} 分钟，可能正在写入；超过 24 小时才会清理",
                    age_ms / 60_000
                ),
                true,
            ));
            acc.skipped(finding(
                "leftover-temp",
                "warn",
                rel_path,
                "未到清理时限，本次不动".to_string(),
                true,
            ));
        }
    }
    let _ = root;
}

fn quarantine_if_needed(
    root: &Path,
    file: &Path,
    rel_path: &str,
    code: &str,
    fix_at: Option<i64>,
    acc: &mut Acc,
) {
    let Some(now) = fix_at else {
        return;
    };
    let qroot = root.join(QUARANTINE_DIR).join(now.to_string());
    // rel_path 是对外的「/ 分隔」形式，但 `\\?\` 前缀路径不接受 `/`（会报 os error 123），
    // 所以这里必须按段重新拼回本机分隔符。
    let dest_of = |suffix: &str| -> PathBuf {
        let mut p = qroot.clone();
        for seg in rel_path.split('/') {
            p.push(seg);
        }
        if !suffix.is_empty() {
            let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            p.set_file_name(format!("{name}{suffix}"));
        }
        p
    };
    let mut dest = dest_of("");
    if let Some(parent) = dest.parent() {
        if fs::create_dir_all(parent).is_err() {
            acc.skipped(finding(
                code,
                "error",
                rel_path,
                "隔离目录创建失败，文件未动".to_string(),
                false,
            ));
            return;
        }
    }
    // 同一毫秒重复跑时加序号，避免覆盖上一份隔离副本
    let mut seq = 0;
    while dest.exists() && seq < 99 {
        seq += 1;
        dest = dest_of(&format!(".{seq}"));
    }
    match fs::rename(native_path(file), native_path(&dest)) {
        Ok(()) => {
            acc.fixed(code, rel_path, "quarantine", Some(rel(root, &dest)));
            acc.report.quarantine = Some(rel(root, &qroot));
        }
        Err(e) => acc.skipped(finding(
            code,
            "error",
            rel_path,
            format!("隔离失败：{e}"),
            false,
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "renomio-repair-{tag}-{}-{}",
            std::process::id(),
            crate::journal::now_ms()
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

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(native_path(path), text).unwrap();
    }

    #[test]
    fn clean_dir_is_ok() {
        let root = temp_root("clean");
        with_dirs(&root);
        let r = check(&root);
        assert!(r.ok, "干净目录不该报错：{:?}", r.findings);
        assert!(r.findings.is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_dirs_are_created_by_fix() {
        let root = temp_root("dirs");
        let r = check(&root);
        assert_eq!(r.findings.len(), 4, "{:?}", r.findings);
        assert!(r.findings.iter().all(|f| f.code == "missing-dir"));
        let fixed = fix(&root, crate::journal::now_ms());
        assert_eq!(fixed.fixed.len(), 4);
        for name in REQUIRED_DIRS {
            assert!(root.join(name).is_dir(), "{name} 应该被重建");
        }
        assert!(check(&root).findings.is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn bad_batch_is_quarantined_not_deleted() {
        let root = temp_root("badbatch");
        with_dirs(&root);
        let path = root.join("batches").join("123-000.json");
        write(&path, "{ not json");
        let r = check(&root);
        assert!(r
            .findings
            .iter()
            .any(|f| f.code == "bad-batch" && f.severity == "error"));
        let fixed = fix(&root, 1_700_000_000_000);
        assert_eq!(fixed.fixed.len(), 1);
        assert_eq!(fixed.fixed[0].action, "quarantine");
        assert!(!path.exists(), "坏文件必须离开原位置");
                // target 是对外的 `/` 分隔形式；本机路径要按段拼回去，逐字前缀路径不接受 `/`
        let rel_target = fixed.fixed[0].target.clone().unwrap();
        let mut target = root.clone();
        for seg in rel_target.split('/') {
            target.push(seg);
        }
        assert!(target.exists(), "隔离副本必须存在");
        assert_eq!(
            fs::read_to_string(&target).unwrap(),
            "{ not json"
        );
        assert!(fixed.quarantine.as_deref().unwrap().starts_with(QUARANTINE_DIR));
        assert!(check(&root).ok);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn good_batch_is_untouched() {
        let root = temp_root("goodbatch");
        with_dirs(&root);
        let text = r#"{"id":"1-000","createdAt":1,"state":"completed","policy":"rename","roots":[],"counts":{"total":0,"done":0,"skipped":0,"failed":0},"items":[]}"#;
        let path = root.join("batches").join("1-000.json");
        write(&path, text);
        let before = fs::read(native_path(&path)).unwrap();
        let r = fix(&root, 1_700_000_000_000);
        assert!(r.fixed.is_empty());
        assert!(r.findings.is_empty(), "{:?}", r.findings);
        assert_eq!(before, fs::read(native_path(&path)).unwrap());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn stale_temp_is_removed_fresh_temp_is_kept() {
        let root = temp_root("tmp");
        with_dirs(&root);
        let tmp = root.join("batches").join("x.json.tmp");
        write(&tmp, "{}");
        let now = crate::journal::now_ms();
        let fresh = fix(&root, now);
        assert!(fresh.fixed.is_empty(), "刚写的临时文件不能被删");
        assert!(fresh.skipped.iter().any(|f| f.code == "leftover-temp"));
        assert!(tmp.exists());
        let later = fix(&root, now + STALE_TMP_MS + 60_000);
        assert_eq!(later.fixed.len(), 1);
        assert_eq!(later.fixed[0].action, "delete-temp");
        assert!(!tmp.exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn empty_rule_history_is_flagged_with_reason() {
        let root = temp_root("history");
        with_dirs(&root);
        write(&root.join("rule-history.json"), "");
        let r = check(&root);
        let f = r
            .findings
            .iter()
            .find(|f| f.code == "bad-rule-history")
            .expect("空历史必须被发现");
        assert!(f.detail.contains("空文件"), "{}", f.detail);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_root_is_reported_and_created() {
        let root = std::env::temp_dir().join(format!(
            "renomio-repair-noroot-{}",
            crate::journal::now_ms()
        ));
        let _ = fs::remove_dir_all(&root);
        let r = check(&root);
        assert_eq!(r.findings.len(), 1);
        assert_eq!(r.findings[0].code, "missing-root");
        assert!(!r.ok);
        let fixed = fix(&root, crate::journal::now_ms());
        assert!(root.is_dir());
        assert!(fixed.fixed.iter().any(|x| x.code == "missing-root"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn root_that_is_a_file_is_not_fixable() {
        let root = std::env::temp_dir().join(format!(
            "renomio-repair-file-{}",
            crate::journal::now_ms()
        ));
        let _ = fs::remove_file(&root);
        fs::write(native_path(&root), "x").unwrap();
        let r = check(&root);
        assert_eq!(r.findings[0].code, "root-is-file");
        assert!(!r.findings[0].fixable);
        assert!(!r.ok);
        let _ = fs::remove_file(&root);
    }

    #[test]
    fn fix_is_idempotent() {
        let root = temp_root("idem");
        with_dirs(&root);
        write(&root.join("batches").join("2-000.json"), "{}");
        let first = fix(&root, 1_700_000_000_000);
        assert_eq!(first.fixed.len(), 1);
        let second = fix(&root, 1_700_000_000_000);
        assert!(second.fixed.is_empty(), "第二次不该再隔离");
        assert!(second.ok);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn batch_id_mismatch_is_quarantined() {
        let root = temp_root("mismatch");
        with_dirs(&root);
        let text = r#"{"id":"9-000","createdAt":1,"state":"completed","policy":"rename","roots":[],"counts":{"total":0,"done":0,"skipped":0,"failed":0},"items":[]}"#;
        write(&root.join("batches").join("8-000.json"), text);
        let r = check(&root);
        assert!(r.findings.iter().any(|f| f.code == "batch-id-mismatch"));
        let fixed = fix(&root, 1_700_000_000_000);
        assert_eq!(fixed.fixed.len(), 1);
        assert_eq!(fixed.fixed[0].code, "batch-id-mismatch");
        assert!(check(&root).ok);
        let _ = fs::remove_dir_all(&root);
    }
}

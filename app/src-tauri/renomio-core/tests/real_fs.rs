//! 真实文件系统测试：全部在临时目录中执行，覆盖中文、emoji、0 字节、
//! 仅大小写、同名冲突、覆盖备份、交换、只读、锁定、超长路径、跨重启撤销。

use std::fs;
use std::path::{Path, PathBuf};

use renomio_core::platform::native_path;
use renomio_core::rename::{ApplyItem, ApplyOptions};
use renomio_core::scan::ScanOptions;
use renomio_core::Core;

fn stamp() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

struct Temp {
    base: PathBuf,
    root: PathBuf,
    data: PathBuf,
}

impl Temp {
    fn new(tag: &str) -> Self {
        let base = std::env::temp_dir().join(format!("renomio-test-{tag}-{}", stamp()));
        let root = base.join("files");
        let data = base.join("data");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&data).unwrap();
        Self { base, root, data }
    }

    fn core(&self) -> Core {
        Core::new(&self.data)
    }

    fn dir(&self) -> &Path {
        &self.root
    }

    fn file(&self, name: &str, content: &str) -> PathBuf {
        let path = self.root.join(name);
        fs::write(native_path(&path), content.as_bytes()).unwrap();
        path
    }

    fn opts(&self) -> ApplyOptions {
        ApplyOptions {
            policy: "skip".into(),
            skip_readonly: false,
            windows_safe: true,
            roots: vec![self.root.to_string_lossy().to_string()],
            label: None,
        }
    }
}

impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(native_path(&self.base));
    }
}

fn item(source: &Path, target: &str, is_dir: bool) -> ApplyItem {
    ApplyItem {
        id: source.to_string_lossy().to_string(),
        source: source.to_string_lossy().to_string(),
        target_name: target.to_string(),
        is_dir,
    }
}

fn names_in(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(native_path(dir))
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    names.sort();
    names
}

#[test]
fn batch_undo_status_detects_external_changes() {
    let t = Temp::new("undo-status");
    let src = t.file("alpha.txt", "a");
    let core = t.core();
    let outcome = core
        .apply(vec![item(&src, "beta.txt", false)], &t.opts())
        .unwrap();

    let list = core.batches();
    let summary = list.iter().find(|b| b.id == outcome.batch.id).unwrap();
    assert!(summary.undoable, "刚执行完的批次应可撤销");
    assert!(summary.undo_reason.is_none());

    // 外部把目标文件移走：撤销应被标记为不可行，并给出原因
    let target = t.dir().join("beta.txt");
    fs::rename(
        native_path(&target),
        native_path(&t.dir().join("gamma.txt")),
    )
    .unwrap();
    let list = core.batches();
    let summary = list.iter().find(|b| b.id == outcome.batch.id).unwrap();
    assert!(!summary.undoable, "目标被外部移动后不应再标记可撤销");
    assert!(summary
        .undo_reason
        .as_deref()
        .unwrap_or("")
        .contains("目标文件已不存在"));

    // 撤销确实失败且不丢文件
    let undo = core.undo(&outcome.batch.id).unwrap();
    assert!(!undo.failed.is_empty());
    assert!(t.dir().join("gamma.txt").exists());
}

#[test]
fn batch_undo_status_after_undo_is_final() {
    let t = Temp::new("undo-final");
    let src = t.file("one.txt", "1");
    let core = t.core();
    let outcome = core
        .apply(vec![item(&src, "two.txt", false)], &t.opts())
        .unwrap();
    let undo = core.undo(&outcome.batch.id).unwrap();
    assert_eq!(undo.failed.len(), 0);
    let list = core.batches();
    let summary = list.iter().find(|b| b.id == outcome.batch.id).unwrap();
    assert_eq!(summary.state, "undone");
    assert!(!summary.undoable);
    assert!(summary
        .undo_reason
        .as_deref()
        .unwrap_or("")
        .contains("已经撤销"));
}

#[test]
fn chinese_emoji_zero_byte_rename_and_undo() {
    let t = Temp::new("basic");
    let a = t.file("旧照片 001.JPG", "aaa");
    let b = t.file("😀 照片 副本.png", "bbb");
    let zero = t.file("空文件.dat", "");

    let core = t.core();
    let outcome = core
        .apply(
            vec![
                item(&a, "旅行_001.jpg", false),
                item(&b, "😀 照片.png", false),
                item(&zero, "零字节.txt", false),
            ],
            &t.opts(),
        )
        .unwrap();

    assert_eq!(outcome.applied.len(), 3);
    assert_eq!(outcome.skipped.len(), 0);
    assert_eq!(outcome.failed.len(), 0);
    assert!(t.dir().join("旅行_001.jpg").exists());
    assert!(t.dir().join("😀 照片.png").exists());
    assert!(t.dir().join("零字节.txt").exists());
    assert!(!t.dir().join("旧照片 001.JPG").exists());
    assert!(!t.dir().join("😀 照片 副本.png").exists());

    let undo = core.undo(&outcome.batch.id).unwrap();
    assert_eq!(undo.failed.len(), 0);
    assert!(a.exists());
    assert!(b.exists());
    assert!(zero.exists());
    assert!(!t.dir().join("旅行_001.jpg").exists());
}

#[test]
fn case_only_rename_and_undo() {
    let t = Temp::new("case");
    let src = t.file("CaseTest.TXT", "x");
    let core = t.core();
    let outcome = core
        .apply(vec![item(&src, "casetest.txt", false)], &t.opts())
        .unwrap();
    assert_eq!(outcome.applied.len(), 1);
    let names = names_in(t.dir());
    assert_eq!(names.len(), 1, "不应残留临时文件：{names:?}");
    assert_eq!(names[0], "casetest.txt");

    let undo = core.undo(&outcome.batch.id).unwrap();
    assert_eq!(undo.failed.len(), 0);
    let names = names_in(t.dir());
    assert_eq!(names.len(), 1);
    assert_eq!(names[0], "CaseTest.TXT");
}

#[test]
fn conflict_skip_leaves_both_files() {
    let t = Temp::new("skip");
    let a = t.file("a.txt", "A");
    let b = t.file("b.txt", "B");
    let core = t.core();
    let outcome = core
        .apply(vec![item(&b, "a.txt", false)], &t.opts())
        .unwrap();

    assert_eq!(outcome.applied.len(), 0);
    assert_eq!(outcome.skipped.len(), 1);
    assert!(a.exists() && b.exists());
    assert_eq!(fs::read_to_string(&a).unwrap(), "A");

    // 撤销一个"全部跳过"的批次不应改动文件
    let undo = core.undo(&outcome.batch.id).unwrap();
    assert_eq!(undo.failed.len(), 0);
    assert!(a.exists() && b.exists());
    assert_eq!(fs::read_to_string(&a).unwrap(), "A");
}

#[test]
fn conflict_suffix_generates_new_name_and_undo() {
    let t = Temp::new("suffix");
    let a = t.file("a.txt", "A");
    let b = t.file("b.txt", "B");
    let core = t.core();
    let mut opts = t.opts();
    opts.policy = "suffix".into();
    let outcome = core.apply(vec![item(&b, "a.txt", false)], &opts).unwrap();
    assert_eq!(outcome.applied.len(), 1);
    let applied_to = PathBuf::from(&outcome.applied[0].to);
    assert!(applied_to.exists());
    assert_eq!(
        applied_to.file_name().unwrap().to_string_lossy(),
        "a (1).txt"
    );
    assert!(a.exists() && !b.exists());
    assert_eq!(fs::read_to_string(&a).unwrap(), "A");

    core.undo(&outcome.batch.id).unwrap();
    assert!(b.exists() && a.exists());
    assert!(!applied_to.exists());
}

#[test]
fn conflict_overwrite_backs_up_and_undo_restores() {
    let t = Temp::new("overwrite");
    let a = t.file("keep.txt", "OLD");
    let b = t.file("incoming.txt", "NEW");
    let core = t.core();
    let mut opts = t.opts();
    opts.policy = "overwrite".into();
    let outcome = core
        .apply(vec![item(&b, "keep.txt", false)], &opts)
        .unwrap();

    assert_eq!(outcome.applied.len(), 1);
    let backup = outcome.applied[0].backup.clone().expect("覆盖前应备份");
    assert!(PathBuf::from(&backup).exists());
    assert_eq!(fs::read_to_string(&a).unwrap(), "NEW");
    assert!(!b.exists());

    let undo = core.undo(&outcome.batch.id).unwrap();
    assert_eq!(undo.failed.len(), 0);
    assert_eq!(fs::read_to_string(&a).unwrap(), "OLD");
    assert_eq!(fs::read_to_string(&b).unwrap(), "NEW");
    assert!(!PathBuf::from(&backup).exists());
}

#[test]
fn swap_two_files_via_temp_names_and_undo() {
    let t = Temp::new("swap");
    let x = t.file("x.txt", "X");
    let y = t.file("y.txt", "Y");
    let core = t.core();
    let outcome = core
        .apply(
            vec![item(&x, "y.txt", false), item(&y, "x.txt", false)],
            &t.opts(),
        )
        .unwrap();
    assert_eq!(outcome.applied.len(), 2);
    assert_eq!(fs::read_to_string(t.dir().join("y.txt")).unwrap(), "X");
    assert_eq!(fs::read_to_string(t.dir().join("x.txt")).unwrap(), "Y");

    let undo = core.undo(&outcome.batch.id).unwrap();
    assert_eq!(undo.failed.len(), 0);
    assert_eq!(fs::read_to_string(&x).unwrap(), "X");
    assert_eq!(fs::read_to_string(&y).unwrap(), "Y");
}

#[test]
fn invalid_and_reserved_names_are_rejected() {
    let t = Temp::new("invalid");
    let a = t.file("ok.txt", "A");
    let core = t.core();
    let outcome = core
        .apply(
            vec![item(&a, "CON.txt", false), item(&a, "a:b.txt", false)],
            &t.opts(),
        )
        .unwrap();
    assert_eq!(outcome.applied.len(), 0);
    assert_eq!(outcome.failed.len(), 2);
    assert!(a.exists());
}

#[test]
fn readonly_file_skip_or_rename() {
    let t = Temp::new("readonly");
    let a = t.file("readonly.txt", "RO");
    let mut perms = fs::metadata(&a).unwrap().permissions();
    perms.set_readonly(true);
    fs::set_permissions(&a, perms.clone()).unwrap();

    let core = t.core();
    let mut opts = t.opts();
    opts.skip_readonly = true;
    let skipped = core
        .apply(vec![item(&a, "ro-new.txt", false)], &opts)
        .unwrap();
    assert_eq!(skipped.skipped.len(), 1);
    assert!(a.exists());

    opts.skip_readonly = false;
    let renamed = core
        .apply(vec![item(&a, "ro-new.txt", false)], &opts)
        .unwrap();
    assert_eq!(renamed.applied.len(), 1);
    assert!(t.dir().join("ro-new.txt").exists());

    core.undo(&renamed.batch.id).unwrap();
    assert!(a.exists());

    let mut perms = fs::metadata(&a).unwrap().permissions();
    #[allow(clippy::permissions_set_readonly_false)]
    perms.set_readonly(false);
    let _ = fs::set_permissions(&a, perms);
}

#[cfg(windows)]
#[test]
fn locked_file_fails_without_losing_source() {
    use std::os::windows::fs::OpenOptionsExt;

    let t = Temp::new("locked");
    let a = t.file("locked.txt", "L");
    let handle = fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(&a)
        .unwrap();

    let core = t.core();
    let outcome = core
        .apply(vec![item(&a, "unlocked.txt", false)], &t.opts())
        .unwrap();
    drop(handle);

    assert_eq!(outcome.applied.len(), 0);
    assert_eq!(outcome.failed.len(), 1);
    assert!(a.exists(), "源文件必须原样保留");
    assert!(!t.dir().join("unlocked.txt").exists());
    assert_eq!(outcome.batch.state, "partial");
    let _ = core.undo(&outcome.batch.id);
}

#[cfg(windows)]
#[test]
fn long_path_over_260_rename_and_undo() {
    let t = Temp::new("longpath");
    let mut dir = t.root.clone();
    while dir.to_string_lossy().chars().count() < 320 {
        dir.push("deep-folder-0123456789");
    }
    fs::create_dir_all(native_path(&dir)).unwrap();
    let src = dir.join("很长的文件名.txt");
    fs::write(native_path(&src), b"long").unwrap();

    let core = t.core();
    let outcome = core
        .apply(vec![item(&src, "改名后.txt", false)], &t.opts())
        .unwrap();
    assert_eq!(outcome.applied.len(), 1, "failed: {:?}", outcome.failed);
    assert!(native_path(&dir.join("改名后.txt")).exists());

    core.undo(&outcome.batch.id).unwrap();
    assert!(native_path(&src).exists());
}

#[test]
fn journal_survives_restart_for_undo() {
    let t = Temp::new("restart");
    let a = t.file("重启前.txt", "A");
    let batch_id;
    {
        let core = t.core();
        let outcome = core
            .apply(vec![item(&a, "重启后.txt", false)], &t.opts())
            .unwrap();
        batch_id = outcome.batch.id.clone();
        assert!(t.dir().join("重启后.txt").exists());
    }
    // 模拟应用重启：新的 Core 只依赖持久化日志
    let core2 = Core::new(&t.data);
    let batches = core2.batches();
    assert!(batches.iter().any(|b| b.id == batch_id));
    let undo = core2.undo(&batch_id).unwrap();
    assert_eq!(undo.failed.len(), 0);
    assert!(a.exists());
    assert!(!t.dir().join("重启后.txt").exists());
}

#[test]
fn scan_recursive_filter_and_dedup() {
    let t = Temp::new("scan");
    fs::create_dir_all(t.dir().join("sub/深一层")).unwrap();
    fs::write(t.dir().join("a.jpg"), b"1").unwrap();
    fs::write(t.dir().join("b.png"), b"2").unwrap();
    fs::write(t.dir().join("sub/c.jpg"), b"3").unwrap();
    fs::write(t.dir().join("sub/深一层/d.JPG"), b"4").unwrap();

    let core = t.core();
    let root = t.dir().to_string_lossy().to_string();
    let mut opts = ScanOptions::default();
    opts.recursive = true;
    opts.include_files = true;
    opts.include_dirs = false;
    opts.include_patterns = vec!["*.jpg".into(), "*.JPG".into()];
    let result = core.scan(&[root], &opts);
    assert_eq!(result.entries.len(), 3, "warnings: {:?}", result.warnings);
    assert!(result.entries.iter().all(|e| !e.is_dir));

    // 重复添加同一路径不应出现重复项
    let root2 = t.dir().join("a.jpg").to_string_lossy().to_string();
    let result2 = core.scan(&[root2.clone(), root2], &opts);
    assert_eq!(result2.entries.len(), 1);
}

#[test]
fn cancel_before_start_keeps_all_files() {
    let t = Temp::new("cancel-start");
    let a = t.file("a.txt", "A");
    let b = t.file("b.txt", "B");
    let core = t.core();
    let outcome = core
        .apply_with_progress(
            vec![item(&a, "a2.txt", false), item(&b, "b2.txt", false)],
            &t.opts(),
            &mut |_phase, _done, _total, _current| {},
            &|| true,
        )
        .unwrap();

    assert_eq!(outcome.batch.state, "cancelled");
    assert!(outcome.applied.is_empty());
    assert!(a.exists() && b.exists());
    assert_eq!(
        names_in(t.dir()),
        vec!["a.txt".to_string(), "b.txt".to_string()]
    );
    assert!(!t.dir().join("a2.txt").exists());
}

#[test]
fn cancel_midway_rolls_back_unapplied_items() {
    let t = Temp::new("cancel-mid");
    let a = t.file("a.txt", "A");
    let b = t.file("b.txt", "B");
    let core = t.core();
    let calls = std::cell::Cell::new(0usize);
    let mut phases: Vec<(String, usize, usize)> = Vec::new();

    let outcome = core
        .apply_with_progress(
            vec![item(&a, "a2.txt", false), item(&b, "b2.txt", false)],
            &t.opts(),
            &mut |phase: &str, done: usize, total: usize, _current: &str| {
                phases.push((phase.to_string(), done, total));
            },
            // 阶段 A 两次检查 + 阶段 B 第一条 → 共 3 次 false；第 4 次（第二条落位前）取消
            &|| {
                let n = calls.get() + 1;
                calls.set(n);
                n >= 4
            },
        )
        .unwrap();

    assert_eq!(outcome.batch.state, "cancelled");
    assert_eq!(outcome.applied.len(), 1, "已完成的第一条不回退");
    assert!(t.dir().join("a2.txt").exists());
    assert!(b.exists(), "未落位的条目应从临时名回退到原名");
    assert!(!t.dir().join("b2.txt").exists());
    assert!(phases.iter().any(|(phase, _, _)| phase == "cancelled"));
}

#[test]
fn paths_exist_check() {
    let t = Temp::new("exists");
    let a = t.file("a.txt", "A");
    let ghost = t.dir().join("ghost.txt");
    let core = t.core();
    let flags = core.paths_exist(&[
        a.to_string_lossy().to_string(),
        ghost.to_string_lossy().to_string(),
    ]);
    assert_eq!(flags, vec![true, false]);
}

//! “UI 触发路径”回归测试：用真实 Core API（与 Tauri command 相同的参数结构）
//! 覆盖曾经修复的两类缺陷：
//!   1. 批次内多个项目指向同一目标时的“同名输出覆盖”；
//!   2. 应用/撤销后残留 `.renomio-*` 临时文件。
//! 说明：本测试不经过 Tauri IPC（那需要启动 GUI），属于核心层回归；
//! UI 层的交互路径由 `app/e2e` 的无头浏览器脚本覆盖。

use std::fs;
use std::path::{Path, PathBuf};

use renomio_core::platform::native_path;
use renomio_core::rename::{ApplyItem, ApplyOptions};
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
        let base = std::env::temp_dir().join(format!("renomio-ui-{tag}-{}", stamp()));
        let root = base.join("files");
        let data = base.join("data");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&data).unwrap();
        Self { base, root, data }
    }

    fn core(&self) -> Core {
        Core::new(&self.data)
    }

    fn file(&self, name: &str, content: &str) -> PathBuf {
        let path = self.root.join(name);
        fs::write(native_path(&path), content.as_bytes()).unwrap();
        path
    }

    fn opts(&self, policy: &str) -> ApplyOptions {
        ApplyOptions {
            policy: policy.into(),
            skip_readonly: false,
            windows_safe: true,
            roots: vec![self.root.to_string_lossy().to_string()],
            label: Some("e2e-ui-path".into()),
        }
    }

    fn names(&self) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(native_path(&self.root))
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        names.sort();
        names
    }

    fn temps(&self) -> Vec<String> {
        self.names()
            .into_iter()
            .filter(|n| n.starts_with(".renomio-"))
            .collect()
    }
}

impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(native_path(&self.base));
    }
}

fn item(source: &Path, target: &str) -> ApplyItem {
    ApplyItem {
        id: source.to_string_lossy().to_string(),
        source: source.to_string_lossy().to_string(),
        target_name: target.to_string(),
        is_dir: false,
    }
}

#[test]
fn duplicate_targets_never_chain_overwrite() {
    let t = Temp::new("duplicate");
    let a = t.file("a.txt", "A");
    let b = t.file("b.txt", "B");
    let core = t.core();
    // 用户选择“覆盖”，但两行都改成 same.txt：第二行必须被拒绝，
    // 否则第二行的输出会覆盖第一行的输出，撤销将无法完整还原。
    let outcome = core
        .apply(
            vec![item(&a, "same.txt"), item(&b, "same.txt")],
            &t.opts("overwrite"),
        )
        .unwrap();

    assert_eq!(outcome.applied.len(), 1, "只允许第一行落到目标");
    assert_eq!(outcome.skipped.len(), 1, "第二行必须显式跳过");
    assert!(outcome.skipped[0].reason.contains("同一目标"));
    assert_eq!(fs::read_to_string(t.root.join("same.txt")).unwrap(), "A");
    assert_eq!(
        fs::read_to_string(&b).unwrap(),
        "B",
        "被跳过行的源文件必须原样保留"
    );
    assert!(t.temps().is_empty(), "不应残留临时文件：{:?}", t.temps());

    let undo = core.undo(&outcome.batch.id).unwrap();
    assert_eq!(undo.failed.len(), 0, "撤销不应失败：{:?}", undo.failed);
    assert_eq!(fs::read_to_string(&a).unwrap(), "A");
    assert_eq!(fs::read_to_string(&b).unwrap(), "B");
    assert!(!t.root.join("same.txt").exists());
    assert!(
        t.temps().is_empty(),
        "撤销后不应残留临时文件：{:?}",
        t.temps()
    );
}

#[test]
fn skip_conflict_rolls_back_temp_and_undo_stays_clean() {
    let t = Temp::new("skip-temp");
    let a = t.file("keep.txt", "KEEP");
    let b = t.file("incoming.txt", "NEW");
    let core = t.core();
    let outcome = core
        .apply(vec![item(&b, "keep.txt")], &t.opts("skip"))
        .unwrap();

    assert_eq!(outcome.applied.len(), 0);
    assert_eq!(outcome.skipped.len(), 1);
    assert_eq!(fs::read_to_string(&a).unwrap(), "KEEP");
    assert_eq!(fs::read_to_string(&b).unwrap(), "NEW");
    assert!(
        t.temps().is_empty(),
        "跳过回滚后不应残留临时文件：{:?}",
        t.temps()
    );

    let undo = core.undo(&outcome.batch.id).unwrap();
    assert_eq!(undo.failed.len(), 0);
    assert_eq!(fs::read_to_string(&a).unwrap(), "KEEP");
    assert_eq!(fs::read_to_string(&b).unwrap(), "NEW");
    assert!(t.temps().is_empty());
}

#[test]
fn overwrite_backup_and_undo_restore_are_clean() {
    let t = Temp::new("overwrite-temp");
    let target = t.file("photo.jpg", "OLD");
    let incoming = t.file("new-photo.jpg", "NEW");
    let core = t.core();
    let outcome = core
        .apply(vec![item(&incoming, "photo.jpg")], &t.opts("overwrite"))
        .unwrap();

    let backup = outcome.applied[0].backup.clone().expect("覆盖前必须备份");
    assert!(Path::new(&backup).exists());
    assert_eq!(fs::read_to_string(&target).unwrap(), "NEW");
    assert!(t.temps().is_empty());

    let undo = core.undo(&outcome.batch.id).unwrap();
    assert_eq!(undo.failed.len(), 0);
    assert_eq!(fs::read_to_string(&target).unwrap(), "OLD");
    assert_eq!(fs::read_to_string(&incoming).unwrap(), "NEW");
    assert!(!Path::new(&backup).exists(), "撤销后备份应已归位");
    assert!(
        t.temps().is_empty(),
        "撤销后不应残留临时文件：{:?}",
        t.temps()
    );
}

#[test]
fn batch_survives_restart_and_undo_after_duplicate_target() {
    let t = Temp::new("restart-dup");
    let a = t.file("one.txt", "ONE");
    let b = t.file("two.txt", "TWO");
    let batch_id;
    {
        let core = t.core();
        let outcome = core
            .apply(
                vec![item(&a, "merged.txt"), item(&b, "merged.txt")],
                &t.opts("overwrite"),
            )
            .unwrap();
        assert_eq!(outcome.applied.len(), 1);
        assert_eq!(outcome.skipped.len(), 1);
        batch_id = outcome.batch.id.clone();
    }
    // 模拟应用重启：只依赖持久化批次日志
    let core2 = Core::new(&t.data);
    assert!(core2.batches().iter().any(|x| x.id == batch_id));
    let undo = core2.undo(&batch_id).unwrap();
    assert_eq!(undo.failed.len(), 0);
    assert_eq!(fs::read_to_string(&a).unwrap(), "ONE");
    assert_eq!(fs::read_to_string(&b).unwrap(), "TWO");
    assert!(!t.root.join("merged.txt").exists());
    assert!(t.temps().is_empty());
}

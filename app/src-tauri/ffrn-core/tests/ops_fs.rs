//! P1 第二梯队真实文件系统测试：时间修改、只读/隐藏属性、归类移动与撤销。
//! 全部在临时目录执行；跨盘路径用 force_copy 强制走「复制 → 校验 → 删除源」。

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use ffrn_core::ops::{AttrSpec, MoveItem, MoveSpec, OpTarget, TimeSpec};
use ffrn_core::platform::native_path;
use ffrn_core::Core;

fn stamp() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
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
        let base = std::env::temp_dir().join(format!("ffrn-ops-{tag}-{}", stamp()));
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
}

impl Drop for Temp {
    fn drop(&mut self) {
        // 只读属性会阻止删除，先尽力清除
        let _ = clear_readonly_tree(&self.base);
        let _ = fs::remove_dir_all(native_path(&self.base));
    }
}

fn clear_readonly_tree(dir: &Path) {
    if let Ok(entries) = fs::read_dir(native_path(dir)) {
        for entry in entries.flatten() {
            let path = entry.path();
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                clear_readonly_tree(&path);
            } else if let Ok(meta) = fs::metadata(native_path(&path)) {
                if meta.permissions().readonly() {
                    let mut perms = meta.permissions();
                    perms.set_readonly(false);
                    let _ = fs::set_permissions(native_path(&path), perms);
                }
            }
        }
    }
}

fn set_times(path: &Path, ms: i64) {
    let when = UNIX_EPOCH + Duration::from_millis(ms.max(0) as u64);
    let file = fs::OpenOptions::new().write(true).open(native_path(path)).unwrap();
    file.set_times(fs::FileTimes::new().set_modified(when).set_accessed(when))
        .unwrap();
}

fn mtime_ms(core: &Core, path: &Path) -> i64 {
    core.read_times(&[path.to_string_lossy().to_string()])[0]
        .mtime_ms
        .expect("应读到修改时间")
}

fn target(path: &Path) -> OpTarget {
    OpTarget {
        id: path.to_string_lossy().to_string(),
        path: path.to_string_lossy().to_string(),
        is_dir: false,
    }
}

fn left_temp_files(dir: &Path) -> Vec<String> {
    let mut leftovers = Vec::new();
    if let Ok(entries) = fs::read_dir(native_path(dir)) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(".ffrn-move-") {
                leftovers.push(name);
            }
        }
    }
    leftovers
}

const T0: i64 = 1_577_836_800_000; // 2020-01-01T00:00:00Z

#[test]
fn time_shift_then_undo_restores_original() {
    let t = Temp::new("time-shift");
    let file = t.file("照片.jpg", "abc");
    set_times(&file, T0);
    let core = t.core();
    assert_eq!(mtime_ms(&core, &file), T0);

    let spec = TimeSpec {
        mode: "shift".into(),
        shift_seconds: 3600,
        fixed_ms: 0,
        fields: vec!["mtime".into(), "atime".into()],
    };
    let outcome = core.apply_time(vec![target(&file)], &spec).unwrap();
    assert_eq!(outcome.applied.len(), 1);
    assert_eq!(outcome.failed.len(), 0);
    assert_eq!(mtime_ms(&core, &file), T0 + 3_600_000);

    let undo = core.undo(&outcome.batch.id).unwrap();
    assert_eq!(undo.restored.len(), 1);
    assert!(undo.failed.is_empty(), "{:?}", undo.failed);
    assert_eq!(mtime_ms(&core, &file), T0);
}

#[test]
fn time_fixed_value_survives_restart_and_undo() {
    let t = Temp::new("time-fixed");
    let file = t.file("fixed.txt", "x");
    let fixed = 1_609_459_200_000; // 2021-01-01T00:00:00Z
    set_times(&file, T0);
    let core = t.core();
    let spec = TimeSpec {
        mode: "fixed".into(),
        shift_seconds: 0,
        fixed_ms: fixed,
        fields: vec!["mtime".into()],
    };
    let outcome = core.apply_time(vec![target(&file)], &spec).unwrap();
    assert_eq!(mtime_ms(&core, &file), fixed);

    // 换一个 Core 实例（模拟重启）后仍能撤销
    let restarted = Core::new(&t.data);
    let undo = restarted.undo(&outcome.batch.id).unwrap();
    assert_eq!(undo.restored.len(), 1);
    assert_eq!(mtime_ms(&restarted, &file), T0);
}

#[test]
fn time_skips_unchanged_and_marks_locked_per_item() {
    let t = Temp::new("time-per-item");
    let ok = t.file("ok.txt", "1");
    let busy = t.file("busy.txt", "2");
    set_times(&ok, T0);
    set_times(&busy, T0);
    let core = t.core();

    let locked = lock_file(&busy);
    let spec = TimeSpec {
        mode: "shift".into(),
        shift_seconds: 600,
        fixed_ms: 0,
        fields: vec!["mtime".into()],
    };
    let outcome = core.apply_time(vec![target(&ok), target(&busy)], &spec).unwrap();
    drop(locked);

    assert_eq!(outcome.applied.len(), 1, "未锁定的文件应成功");
    assert_eq!(outcome.failed.len(), 1, "被占用文件应逐条失败");
    assert!(outcome.failed[0].reason.contains("无法")
        || outcome.failed[0].reason.contains("占用")
        || outcome.failed[0].reason.contains("拒绝")
        || outcome.failed[0].reason.contains("sharing"));
    assert_eq!(mtime_ms(&core, &ok), T0 + 600_000);
    assert_eq!(mtime_ms(&core, &busy), T0, "失败条目必须保持原时间");
}

#[cfg(windows)]
fn lock_file(path: &Path) -> std::fs::File {
    use std::os::windows::fs::OpenOptionsExt;
    fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(native_path(path))
        .unwrap()
}

#[cfg(not(windows))]
fn lock_file(path: &Path) -> std::fs::File {
    fs::File::open(native_path(path)).unwrap()
}

#[cfg(windows)]
#[test]
fn time_creation_time_writes_and_undoes() {
    let t = Temp::new("time-creation");
    let file = t.file("created.txt", "c");
    let core = t.core();
    let before = core.read_times(&[file.to_string_lossy().to_string()])[0]
        .creation_ms
        .expect("Windows 应能读取创建时间");
    let spec = TimeSpec {
        mode: "shift".into(),
        shift_seconds: 86_400,
        fixed_ms: 0,
        fields: vec!["creation".into()],
    };
    let outcome = core.apply_time(vec![target(&file)], &spec).unwrap();
    assert_eq!(outcome.applied.len(), 1, "{:?}", outcome.failed);
    let after = core.read_times(&[file.to_string_lossy().to_string()])[0].creation_ms.unwrap();
    assert!((after - (before + 86_400_000)).abs() < 1_500, "创建时间应平移一天：{before} -> {after}");

    core.undo(&outcome.batch.id).unwrap();
    let restored = core.read_times(&[file.to_string_lossy().to_string()])[0].creation_ms.unwrap();
    assert!((restored - before).abs() < 1_500, "撤销应还原创建时间");
}

#[cfg(not(windows))]
#[test]
fn time_creation_time_rejected_per_item_on_non_windows() {
    let t = Temp::new("time-creation-no");
    let file = t.file("a.txt", "a");
    let core = t.core();
    let spec = TimeSpec {
        mode: "shift".into(),
        shift_seconds: 60,
        fixed_ms: 0,
        fields: vec!["creation".into()],
    };
    let outcome = core.apply_time(vec![target(&file)], &spec).unwrap();
    assert_eq!(outcome.applied.len(), 0);
    assert_eq!(outcome.failed.len(), 1);
    assert!(outcome.failed[0].reason.contains("创建时间"));
}

#[test]
fn attrs_readonly_set_and_undo() {
    let t = Temp::new("attrs-readonly");
    let file = t.file("ro.txt", "r");
    let core = t.core();
    let spec = AttrSpec { readonly: Some(true), hidden: None };
    let outcome = core.apply_attrs(vec![target(&file)], &spec).unwrap();
    assert_eq!(outcome.applied.len(), 1, "{:?}", outcome.failed);
    assert!(core.read_attrs(&[file.to_string_lossy().to_string()])[0].readonly);

    let undo = core.undo(&outcome.batch.id).unwrap();
    assert_eq!(undo.restored.len(), 1);
    assert!(!core.read_attrs(&[file.to_string_lossy().to_string()])[0].readonly);
}

#[cfg(windows)]
#[test]
fn attrs_hidden_set_and_undo() {
    let t = Temp::new("attrs-hidden");
    let file = t.file("hidden.txt", "h");
    let core = t.core();
    let spec = AttrSpec { readonly: None, hidden: Some(true) };
    let outcome = core.apply_attrs(vec![target(&file)], &spec).unwrap();
    assert_eq!(outcome.applied.len(), 1, "{:?}", outcome.failed);
    assert!(core.read_attrs(&[file.to_string_lossy().to_string()])[0].hidden);

    core.undo(&outcome.batch.id).unwrap();
    assert!(!core.read_attrs(&[file.to_string_lossy().to_string()])[0].hidden);
}

#[test]
fn move_creates_target_dirs_and_undo_removes_them() {
    let t = Temp::new("move-mkdir");
    let file = t.file("a.jpg", "img");
    let core = t.core();
    let target_path = t.root.join("归类").join("JPG").join("a.jpg");
    let spec = MoveSpec {
        create_dirs: true,
        roots: vec![t.root.to_string_lossy().to_string()],
        force_copy: false,
    };
    let outcome = core
        .apply_move(
            vec![MoveItem {
                id: file.to_string_lossy().to_string(),
                source: file.to_string_lossy().to_string(),
                target: target_path.to_string_lossy().to_string(),
                is_dir: false,
            }],
            &spec,
        )
        .unwrap();
    assert_eq!(outcome.applied.len(), 1, "{:?}", outcome.failed);
    assert!(target_path.exists());
    assert!(!file.exists());
    assert!(!outcome.batch.created_dirs.is_empty(), "应记录新建目录");
    assert_eq!(fs::read_to_string(native_path(&target_path)).unwrap(), "img");

    let undo = core.undo(&outcome.batch.id).unwrap();
    assert_eq!(undo.restored.len(), 1);
    assert!(file.exists(), "撤销应把文件移回原位置");
    assert!(!target_path.exists());
    assert!(!t.root.join("归类").exists(), "撤销应移除本次新建的空目录");
}

#[test]
fn move_force_copy_verifies_before_deleting_source_then_undo() {
    let t = Temp::new("move-copy");
    let content = "跨盘复制内容".repeat(4_000);
    let file = t.file("big.dat", &content);
    let core = t.core();
    let target_path = t.root.join("copy").join("big.dat");
    let spec = MoveSpec { create_dirs: true, roots: vec![], force_copy: true };
    let outcome = core
        .apply_move(
            vec![MoveItem {
                id: file.to_string_lossy().to_string(),
                source: file.to_string_lossy().to_string(),
                target: target_path.to_string_lossy().to_string(),
                is_dir: false,
            }],
            &spec,
        )
        .unwrap();
    assert_eq!(outcome.applied.len(), 1, "{:?}", outcome.failed);
    assert!(!file.exists(), "校验通过后才删除源");
    assert_eq!(fs::read_to_string(native_path(&target_path)).unwrap(), content);
    assert!(left_temp_files(target_path.parent().unwrap()).is_empty(), "不应残留临时副本");

    let undo = core.undo(&outcome.batch.id).unwrap();
    assert_eq!(undo.restored.len(), 1);
    assert!(file.exists());
    assert!(!target_path.exists());
}

#[cfg(windows)]
#[test]
fn move_copy_failure_keeps_source_and_cleans_temp() {
    let t = Temp::new("move-copy-fail");
    let file = t.file("locked.dat", "locked");
    let core = t.core();
    let target_dir = t.root.join("dest");
    let target_path = target_dir.join("locked.dat");
    let spec = MoveSpec { create_dirs: true, roots: vec![], force_copy: true };

    let guard = lock_file(&file);
    let outcome = core
        .apply_move(
            vec![MoveItem {
                id: file.to_string_lossy().to_string(),
                source: file.to_string_lossy().to_string(),
                target: target_path.to_string_lossy().to_string(),
                is_dir: false,
            }],
            &spec,
        )
        .unwrap();
    drop(guard);

    assert_eq!(outcome.applied.len(), 0);
    assert_eq!(outcome.failed.len(), 1);
    assert!(file.exists(), "复制失败后源文件必须保留");
    assert!(!target_path.exists(), "不应出现半成品目标文件");
    assert!(left_temp_files(&target_dir).is_empty(), "失败后应清理临时副本");
    assert_eq!(fs::read_to_string(native_path(&file)).unwrap(), "locked");
}

#[test]
fn move_capture_group_targets_into_new_dirs_and_undo() {
    // 正则捕获组本身由前端求值；这里验证捕获结果作为目标路径的真实落盘与撤销。
    let t = Temp::new("move-capture");
    let a = t.file("照片 001.jpg", "1");
    let b = t.file("照片 002.jpg", "2");
    let core = t.core();
    let targets: Vec<PathBuf> = ["001", "002"]
        .iter()
        .enumerate()
        .map(|(i, group)| {
            let name = if i == 0 { "照片 001.jpg" } else { "照片 002.jpg" };
            t.root.join("capture").join(group).join(name)
        })
        .collect();
    let items = vec![
        MoveItem {
            id: a.to_string_lossy().to_string(),
            source: a.to_string_lossy().to_string(),
            target: targets[0].to_string_lossy().to_string(),
            is_dir: false,
        },
        MoveItem {
            id: b.to_string_lossy().to_string(),
            source: b.to_string_lossy().to_string(),
            target: targets[1].to_string_lossy().to_string(),
            is_dir: false,
        },
    ];
    let spec = MoveSpec { create_dirs: true, roots: vec![], force_copy: false };
    let outcome = core.apply_move(items, &spec).unwrap();
    assert_eq!(outcome.applied.len(), 2, "{:?}", outcome.failed);
    assert!(targets[0].exists() && targets[1].exists());
    assert_eq!(fs::read_to_string(native_path(&targets[0])).unwrap(), "1");
    assert!(!a.exists() && !b.exists());
    assert_eq!(outcome.batch.created_dirs.len(), 3, "capture 根与两个捕获组目录都应记录");

    let undo = core.undo(&outcome.batch.id).unwrap();
    assert_eq!(undo.restored.len(), 2);
    assert!(a.exists() && b.exists());
    assert!(!t.root.join("capture").exists(), "撤销应清理本次新建的捕获组目录");
}

#[test]
fn move_existing_target_is_skipped_not_overwritten() {
    let t = Temp::new("move-conflict");
    let file = t.file("a.txt", "source");
    let target_path = t.root.join("sub").join("a.txt");
    fs::create_dir_all(native_path(target_path.parent().unwrap())).unwrap();
    fs::write(native_path(&target_path), b"existing").unwrap();
    let core = t.core();
    let spec = MoveSpec { create_dirs: true, roots: vec![], force_copy: false };
    let outcome = core
        .apply_move(
            vec![MoveItem {
                id: file.to_string_lossy().to_string(),
                source: file.to_string_lossy().to_string(),
                target: target_path.to_string_lossy().to_string(),
                is_dir: false,
            }],
            &spec,
        )
        .unwrap();
    assert_eq!(outcome.applied.len(), 0);
    assert_eq!(outcome.skipped.len(), 1);
    assert!(file.exists());
    assert_eq!(fs::read_to_string(native_path(&target_path)).unwrap(), "existing");
}

#[test]
fn move_missing_dir_without_create_is_reported_per_item() {
    let t = Temp::new("move-nodir");
    let file = t.file("a.txt", "x");
    let core = t.core();
    let target_path = t.root.join("深").join("层").join("a.txt");
    let spec = MoveSpec { create_dirs: false, roots: vec![], force_copy: false };
    let outcome = core
        .apply_move(
            vec![MoveItem {
                id: file.to_string_lossy().to_string(),
                source: file.to_string_lossy().to_string(),
                target: target_path.to_string_lossy().to_string(),
                is_dir: false,
            }],
            &spec,
        )
        .unwrap();
    assert_eq!(outcome.failed.len(), 1);
    assert!(outcome.failed[0].reason.contains("目标目录不存在"));
    assert!(file.exists());
}

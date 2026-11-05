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
    let file = fs::OpenOptions::new()
        .write(true)
        .open(native_path(path))
        .unwrap();
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
    let before_creation = creation_ms(&file);

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
    assert_eq!(mtime_ms(&core, &file), T0, "mtime 必须恢复");
    if ffrn_core::platform::can_write_btime() {
        assert!(undo.skipped_fields.is_empty(), "{:?}", undo.skipped_fields);
        assert_eq!(creation_ms(&file), before_creation, "btime 应被恢复");
        assert!(undo.failed.is_empty(), "{:?}", undo.failed);
    } else {
        assert_eq!(
            undo.skipped_fields.len(),
            1,
            "btime 不可写的平台应记录一条跳过项：{:?}",
            undo.skipped_fields
        );
        assert_eq!(undo.skipped_fields[0].field, "creation");
        assert!(undo.skipped_fields[0].reason.contains("创建时间"));
        assert!(
            undo.failed.is_empty(),
            "跳过 btime 不得进入失败路径：{:?}",
            undo.failed
        );
    }
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

    // 换一个 Core 实例（模拟重启）后仍能撤销；btime 跳过与否必须与平台能力一致
    let restarted = Core::new(&t.data);
    let undo = restarted.undo(&outcome.batch.id).unwrap();
    assert_eq!(undo.restored.len(), 1);
    assert_eq!(mtime_ms(&restarted, &file), T0);
    let creation_skipped = undo.skipped_fields.iter().any(|f| f.field == "creation");
    assert_eq!(
        creation_skipped,
        !ffrn_core::platform::can_write_btime(),
        "跳过的字段必须与平台 btime 能力一致：{:?}",
        undo.skipped_fields
    );
    assert!(
        undo.failed.is_empty(),
        "跳过 btime 不得进入失败路径：{:?}",
        undo.failed
    );
}

#[test]
fn time_skips_unchanged_and_marks_locked_per_item() {
    let t = Temp::new("time-per-item");
    let ok = t.file("ok.txt", "1");
    let busy = t.file("busy.txt", "2");
    set_times(&ok, T0);
    set_times(&busy, T0);
    let core = t.core();

    // 用只读属性制造「无法写入」：Windows 上同样会让写权限打开失败，
    // 不依赖 Windows 独占锁语义（Linux 的锁与写打开并不互斥）。
    set_readonly(&busy, true);
    let spec = TimeSpec {
        mode: "shift".into(),
        shift_seconds: 600,
        fixed_ms: 0,
        fields: vec!["mtime".into()],
    };
    let outcome = core
        .apply_time(vec![target(&ok), target(&busy)], &spec)
        .unwrap();
    set_readonly(&busy, false);

    assert_eq!(outcome.applied.len(), 1, "可写文件应成功");
    assert_eq!(outcome.failed.len(), 1, "只读文件应逐条失败");
    assert!(
        outcome.failed[0].reason.contains("无法")
            || outcome.failed[0].reason.contains("占用")
            || outcome.failed[0].reason.contains("拒绝")
            || outcome.failed[0].reason.contains("sharing")
            || outcome.failed[0].reason.contains("权限")
    );
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
    let after = core.read_times(&[file.to_string_lossy().to_string()])[0]
        .creation_ms
        .unwrap();
    assert!(
        (after - (before + 86_400_000)).abs() < 1_500,
        "创建时间应平移一天：{before} -> {after}"
    );

    core.undo(&outcome.batch.id).unwrap();
    let restored = core.read_times(&[file.to_string_lossy().to_string()])[0]
        .creation_ms
        .unwrap();
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
    let spec = AttrSpec {
        readonly: Some(true),
        hidden: None,
    };
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
    let spec = AttrSpec {
        readonly: None,
        hidden: Some(true),
    };
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
    assert_eq!(
        fs::read_to_string(native_path(&target_path)).unwrap(),
        "img"
    );

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
    let spec = MoveSpec {
        create_dirs: true,
        roots: vec![],
        force_copy: true,
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
    assert!(!file.exists(), "校验通过后才删除源");
    assert_eq!(
        fs::read_to_string(native_path(&target_path)).unwrap(),
        content
    );
    assert!(
        left_temp_files(target_path.parent().unwrap()).is_empty(),
        "不应残留临时副本"
    );

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
    let spec = MoveSpec {
        create_dirs: true,
        roots: vec![],
        force_copy: true,
    };

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
    assert!(
        left_temp_files(&target_dir).is_empty(),
        "失败后应清理临时副本"
    );
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
            let name = if i == 0 {
                "照片 001.jpg"
            } else {
                "照片 002.jpg"
            };
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
    let spec = MoveSpec {
        create_dirs: true,
        roots: vec![],
        force_copy: false,
    };
    let outcome = core.apply_move(items, &spec).unwrap();
    assert_eq!(outcome.applied.len(), 2, "{:?}", outcome.failed);
    assert!(targets[0].exists() && targets[1].exists());
    assert_eq!(fs::read_to_string(native_path(&targets[0])).unwrap(), "1");
    assert!(!a.exists() && !b.exists());
    assert_eq!(
        outcome.batch.created_dirs.len(),
        3,
        "capture 根与两个捕获组目录都应记录"
    );

    let undo = core.undo(&outcome.batch.id).unwrap();
    assert_eq!(undo.restored.len(), 2);
    assert!(a.exists() && b.exists());
    assert!(
        !t.root.join("capture").exists(),
        "撤销应清理本次新建的捕获组目录"
    );
}

#[test]
fn move_existing_target_is_skipped_not_overwritten() {
    let t = Temp::new("move-conflict");
    let file = t.file("a.txt", "source");
    let target_path = t.root.join("sub").join("a.txt");
    fs::create_dir_all(native_path(target_path.parent().unwrap())).unwrap();
    fs::write(native_path(&target_path), b"existing").unwrap();
    let core = t.core();
    let spec = MoveSpec {
        create_dirs: true,
        roots: vec![],
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
    assert_eq!(outcome.applied.len(), 0);
    assert_eq!(outcome.skipped.len(), 1);
    assert!(file.exists());
    assert_eq!(
        fs::read_to_string(native_path(&target_path)).unwrap(),
        "existing"
    );
}

#[test]
fn move_missing_dir_without_create_is_reported_per_item() {
    let t = Temp::new("move-nodir");
    let file = t.file("a.txt", "x");
    let core = t.core();
    let target_path = t.root.join("深").join("层").join("a.txt");
    let spec = MoveSpec {
        create_dirs: false,
        roots: vec![],
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
    assert_eq!(outcome.failed.len(), 1);
    assert!(outcome.failed[0].reason.contains("目标目录不存在"));
    assert!(file.exists());
}

/// 只读取创建时间（仅 Windows 有可写/可读的 btime 语义；其它平台分支不会调用）。
fn creation_ms(path: &Path) -> i64 {
    #[cfg(windows)]
    {
        use std::time::UNIX_EPOCH;
        let created = fs::metadata(native_path(path)).unwrap().created().unwrap();
        created.duration_since(UNIX_EPOCH).unwrap().as_millis() as i64
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        0
    }
}

fn set_readonly(path: &Path, on: bool) {
    let mut perms = fs::metadata(native_path(path)).unwrap().permissions();
    perms.set_readonly(on);
    fs::set_permissions(native_path(path), perms).unwrap();
}

/// 撤销跳过日志的端到端闭环：两平台都跑。
///
/// - btime 不可写的平台（Linux）：连做两次「改时间 → 撤销」，每次撤销都应往
///   `<dataDir>/logs/undo.log` 追加一行 `undo\t<ts>\tbatch=<id>\tfield=creation\tpath=…\treason=…`，
///   两次共 2 行（追加而非覆盖），且不得泄漏文件内容。
/// - btime 可写的平台（Windows NTFS）：撤销不产生跳过项，断言无跳过字段、不写日志。
#[test]
fn undo_logs_btime_skip_and_appends() {
    let t = Temp::new("undo-log");
    // 文件名与内容都带标记，用于检查日志只记元数据、不含文件内容
    let secret = "secret-content-should-not-be-logged";
    let file = t.file("泄漏检查.txt", secret);
    set_times(&file, T0);
    let core = t.core();
    let log_path = t.data.join("logs").join("undo.log");

    let spec = TimeSpec {
        mode: "shift".into(),
        shift_seconds: 600, // 用 shift 而非 fixed，避免「未变化被跳过」导致无操作
        fixed_ms: 0,
        fields: vec!["mtime".into(), "atime".into()],
    };

    let mut outcomes = Vec::new();
    for _ in 0..2 {
        let applied = core.apply_time(vec![target(&file)], &spec).unwrap();
        assert_eq!(applied.applied.len(), 1, "{:?}", applied.failed);
        let undo = core.undo(&applied.batch.id).unwrap();
        assert!(
            undo.failed.is_empty(),
            "跳过项不得进入失败路径：{:?}",
            undo.failed
        );
        outcomes.push((applied.batch.id.clone(), undo));
    }

    if ffrn_core::platform::can_write_btime() {
        // Windows：btime 可写，撤销后没有跳过项，也就不该写 undo.log
        for (_, undo) in &outcomes {
            assert!(
                undo.skipped_fields.is_empty(),
                "可写 btime 的平台不应有跳过项：{:?}",
                undo.skipped_fields
            );
        }
        assert!(!log_path.exists(), "无跳过项时不应生成 undo.log");
        return;
    }

    for (batch_id, undo) in &outcomes {
        assert_eq!(undo.restored.len(), 1, "mtime/atime 应照常恢复");
        assert_eq!(undo.skipped_fields.len(), 1, "应记录一条 btime 跳过项");
        assert_eq!(undo.skipped_fields[0].field, "creation");
        assert_eq!(undo.skipped_fields[0].path, file.to_string_lossy());
        assert!(undo.skipped_fields[0].reason.contains("创建时间"));

        let raw = fs::read_to_string(native_path(&log_path)).expect("撤销后应有 undo.log");
        let lines: Vec<&str> = raw.lines().collect();
        let line = lines
            .iter()
            .find(|l| l.contains(&format!("batch={batch_id}")));
        let line = line.unwrap_or_else(|| panic!("undo.log 缺少批次 {batch_id} 的行：{raw}"));
        let cols: Vec<&str> = line.split('\t').collect();
        assert_eq!(cols.len(), 6, "行格式应为 6 列：{line}");
        assert_eq!(cols[0], "undo", "{line}");
        let ts: i64 = cols[1].parse().expect("时间戳应为可解析的整数毫秒");
        assert!(ts > 1_500_000_000_000, "时间戳明显异常：{ts}");
        assert_eq!(cols[2], format!("batch={batch_id}"), "{line}");
        assert_eq!(cols[3], "field=creation", "{line}");
        assert_eq!(
            cols[4],
            format!("path={}", file.to_string_lossy()),
            "{line}"
        );
        assert!(cols[5].starts_with("reason="), "{line}");
        // 只允许路径/原因等元数据；不得出现文件内容或结构化片段
        assert!(!line.contains(secret), "日志泄漏了文件内容：{line}");
        assert!(!line.contains('{') && !line.contains('}'), "{line}");
    }

    // 追加而非覆盖：两次撤销后恰好 2 行
    let raw = fs::read_to_string(native_path(&log_path)).unwrap();
    assert_eq!(raw.lines().count(), 2, "日志必须追加而不是覆盖：{raw}");
}

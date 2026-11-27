//! 属性备份库契约：写入属性 → 生成独立备份 → 删掉批次日志后仍能还原。
//! 只用「只读」这一路（全平台可用），隐藏/系统/存档在 Windows 下另有一段真跑。

use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use renomio_core::attrbackup::{self, AttrBackupStore};
use renomio_core::ops::{AttrAction, AttrSpec, OpTarget};
use renomio_core::platform::native_path;
use renomio_core::Core;

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
        let base = std::env::temp_dir().join(format!("renomio-attrbackup-{tag}-{}", stamp()));
        let root = base.join("files");
        let data = base.join("data");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&data).unwrap();
        Self { base, root, data }
    }

    fn core(&self) -> Core {
        Core::new(&self.data)
    }

    fn file(&self, name: &str) -> PathBuf {
        let path = self.root.join(name);
        fs::write(native_path(&path), b"x").unwrap();
        path
    }
}

impl Drop for Temp {
    fn drop(&mut self) {
        let _ = clear_readonly_tree(&self.base);
        let _ = fs::remove_dir_all(native_path(&self.base));
    }
}

fn clear_readonly_tree(dir: &std::path::Path) {
    if let Ok(entries) = fs::read_dir(native_path(dir)) {
        for entry in entries.flatten() {
            let path = entry.path();
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                clear_readonly_tree(&path);
            } else if let Ok(meta) = fs::metadata(native_path(&path)) {
                let mut perms = meta.permissions();
                #[allow(clippy::permissions_set_readonly_false)]
                perms.set_readonly(false);
                let _ = fs::set_permissions(native_path(&path), perms);
            }
        }
    }
}

fn readonly_spec() -> AttrSpec {
    AttrSpec {
        readonly: Some(AttrAction::Set),
        hidden: None,
        system: None,
        archive: None,
    }
}

#[test]
fn apply_attrs_writes_standalone_backup() {
    let temp = Temp::new("write");
    let file = temp.file("a.txt");
    let path = file.to_string_lossy().to_string();
    let core = temp.core();
    let outcome = core
        .apply_attrs(
            vec![OpTarget {
                id: "1".into(),
                path: path.clone(),
                is_dir: false,
            }],
            &readonly_spec(),
        )
        .unwrap();
    assert_eq!(outcome.applied.len(), 1);

    let store = AttrBackupStore::new(core.data_dir());
    let list = store.list();
    assert_eq!(list.len(), 1, "每次改属性都该落一份独立备份");
    assert_eq!(list[0].batch_id, outcome.batch.id);
    assert_eq!(list[0].entries, 1);
    let backup = store.load(&outcome.batch.id).unwrap();
    assert!(!backup.entries[0].readonly, "备份记的是改之前的值");
    assert_eq!(backup.entries[0].path, path);
}

#[test]
fn restore_survives_batch_log_removal() {
    let temp = Temp::new("restore");
    let file = temp.file("b.txt");
    let path = file.to_string_lossy().to_string();
    let core = temp.core();
    let outcome = core
        .apply_attrs(
            vec![OpTarget {
                id: "1".into(),
                path: path.clone(),
                is_dir: false,
            }],
            &readonly_spec(),
        )
        .unwrap();
    assert!(core.read_attrs(&[path.clone()])[0].readonly);

    // 模拟历史被清理：批次日志没了，备份库还在
    fs::remove_file(core.data_dir().join("batches").join(format!("{}.json", outcome.batch.id)))
        .unwrap();
    assert!(core.batch(&outcome.batch.id).is_none());

    let backup = AttrBackupStore::new(core.data_dir())
        .load(&outcome.batch.id)
        .expect("批次日志删掉后仍要能从备份库读到");
    let report = attrbackup::restore(&backup);
    assert_eq!(report.restored, vec![path.clone()]);
    assert!(report.missing.is_empty() && report.failed.is_empty());
    assert!(!core.read_attrs(&[path.clone()])[0].readonly, "还原后只读要回到 false");

    // 幂等：第二次还原不应再写，只记 unchanged
    let again = attrbackup::restore(&backup);
    assert!(again.restored.is_empty());
    assert_eq!(again.unchanged, vec![path]);
}

#[test]
fn restore_reports_missing_and_keeps_going() {
    let temp = Temp::new("missing");
    let a = temp.file("a.txt").to_string_lossy().to_string();
    let b = temp.file("b.txt").to_string_lossy().to_string();
    let backup = renomio_core::attrbackup::AttrBackup {
        batch_id: "manual".into(),
        created_at: 1,
        entries: vec![
            renomio_core::attrbackup::AttrSnapshot {
                path: a.clone(),
                readonly: true,
                hidden: false,
                system: false,
                archive: false,
            },
            renomio_core::attrbackup::AttrSnapshot {
                path: temp.root.join("gone.txt").to_string_lossy().to_string(),
                readonly: false,
                hidden: false,
                system: false,
                archive: false,
            },
            renomio_core::attrbackup::AttrSnapshot {
                path: b.clone(),
                readonly: true,
                hidden: false,
                system: false,
                archive: false,
            },
        ],
    };
    let report = attrbackup::restore(&backup);
    assert_eq!(report.restored.len(), 2, "不存在的条目不该拖累其他条目");
    assert_eq!(report.missing.len(), 1);
    assert!(report.failed.is_empty());
}

#[cfg(windows)]
#[test]
fn windows_flags_round_trip_through_backup() {
    let temp = Temp::new("winflags");
    let file = temp.file("c.txt");
    let path = file.to_string_lossy().to_string();
    let core = temp.core();
    let outcome = core
        .apply_attrs(
            vec![OpTarget {
                id: "1".into(),
                path: path.clone(),
                is_dir: false,
            }],
            &AttrSpec {
                readonly: None,
                hidden: Some(AttrAction::Set),
                system: Some(AttrAction::Set),
                archive: Some(AttrAction::Clear),
            },
        )
        .unwrap();
    assert_eq!(outcome.applied.len(), 1);
    let info = &core.read_attrs(&[path.clone()])[0];
    assert!(info.hidden && info.system && !info.archive);

    let backup = AttrBackupStore::new(core.data_dir())
        .load(&outcome.batch.id)
        .unwrap();
    let report = attrbackup::restore(&backup);
    assert_eq!(report.restored, vec![path.clone()]);
    let info = &core.read_attrs(&[path])[0];
    assert!(!info.hidden && !info.system && info.archive, "四路必须整体还原");
}

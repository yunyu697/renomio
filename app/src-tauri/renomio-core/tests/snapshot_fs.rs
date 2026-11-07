//! 快照与还原的真实文件系统测试：中文名、无扩展名、冲突跳过、哈希不符、可撤销。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use renomio_core::journal::BatchStore;
use renomio_core::platform::Platform;
use renomio_core::rename;
use renomio_core::snapshot::{self, SnapshotInput};

static SEQ: AtomicUsize = AtomicUsize::new(0);

fn root(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "renomio-snap-{label}-{}-{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn write(path: &Path, content: &[u8]) {
    fs::write(path, content).unwrap();
}

fn input(root: &Path, from: &str, to: &str) -> SnapshotInput {
    SnapshotInput {
        from: root.join(from).to_string_lossy().to_string(),
        to: root.join(to).to_string_lossy().to_string(),
    }
}

fn noop_progress(_done: usize, _total: usize, _current: &str) {}
fn noop_apply(_phase: &str, _done: usize, _total: usize, _current: &str) {}

#[test]
fn create_plan_restore_and_undo_roundtrip() {
    let dir = root("roundtrip");
    let files = dir.join("files");
    fs::create_dir_all(&files).unwrap();
    let names = ["旧照片 001.jpg", "无扩展名", "春节 合影.JPG"];
    for (i, name) in names.iter().enumerate() {
        write(&files.join(name), format!("content-{i}").as_bytes());
    }

    let data_dir = dir.join("data");
    let store = BatchStore::new(&data_dir);
    let snapshot = snapshot::create(
        &data_dir,
        vec![files.to_string_lossy().to_string()],
        vec![
            input(&files, "旧照片 001.jpg", "旅行_001.jpg"),
            input(&files, "无扩展名", "无扩展名_2024"),
            input(&files, "春节 合影.JPG", "2024-02-03 春节 合影.JPG"),
        ],
        false,
        &mut noop_progress,
        &|| false,
    )
    .unwrap()
    .0;
    assert_eq!(snapshot.entry_count, 3);
    assert_eq!(snapshot.hashed, 0);
    assert!(data_dir.join("snapshots").join(format!("{}.json", snapshot.id)).exists());

    // 模拟用户执行改名
    fs::rename(files.join("旧照片 001.jpg"), files.join("旅行_001.jpg")).unwrap();
    fs::rename(files.join("无扩展名"), files.join("无扩展名_2024")).unwrap();
    fs::rename(files.join("春节 合影.JPG"), files.join("2024-02-03 春节 合影.JPG")).unwrap();

    let plan = snapshot::plan(&snapshot);
    assert!(plan.iter().all(|p| p.action == "restore"), "{plan:?}");
    assert_eq!(plan.len(), 3);

    let outcome = snapshot::restore(
        &store,
        Platform::current(),
        &snapshot,
        &mut noop_apply,
        &|| false,
    )
    .unwrap();
    assert_eq!(outcome.restored.len(), 3);
    assert!(outcome.skipped.is_empty(), "{:?}", outcome.skipped);
    assert_eq!(outcome.batch.as_ref().unwrap().kind, "restore");
    assert!(files.join("旧照片 001.jpg").exists());
    assert!(files.join("无扩展名").exists());
    assert!(files.join("春节 合影.JPG").exists());
    assert!(!files.join("旅行_001.jpg").exists());

    // 还原批次本身也可以撤销（回到快照时的新名）
    let batch_id = outcome.batch.unwrap().id;
    let undo = rename::undo(&store, &batch_id).unwrap();
    assert!(undo.failed.is_empty(), "{:?}", undo.failed);
    assert!(files.join("旅行_001.jpg").exists());
    assert!(!files.join("旧照片 001.jpg").exists());
}

#[test]
fn occupied_original_name_is_skipped_never_overwritten() {
    let dir = root("occupied");
    let files = dir.join("files");
    fs::create_dir_all(&files).unwrap();
    write(&files.join("旧照片 001.jpg"), b"a");
    write(&files.join("旧照片 002.jpg"), b"b");
    let data_dir = dir.join("data");
    let store = BatchStore::new(&data_dir);
    let snapshot = snapshot::create(
        &data_dir,
        vec![files.to_string_lossy().to_string()],
        vec![
            input(&files, "旧照片 001.jpg", "旅行_001.jpg"),
            input(&files, "旧照片 002.jpg", "旅行_002.jpg"),
        ],
        false,
        &mut noop_progress,
        &|| false,
    )
    .unwrap()
    .0;

    fs::rename(files.join("旧照片 001.jpg"), files.join("旅行_001.jpg")).unwrap();
    fs::rename(files.join("旧照片 002.jpg"), files.join("旅行_002.jpg")).unwrap();
    // 原位置后来被别的文件占用（还原绝不能覆盖）
    write(&files.join("旧照片 001.jpg"), b"decoy");

    let plan = snapshot::plan(&snapshot);
    let skip = plan.iter().find(|p| p.from.ends_with("旧照片 001.jpg")).unwrap();
    assert_eq!(skip.action, "skip");
    assert_eq!(skip.reason_code.as_deref(), Some("occupied"));

    let outcome = snapshot::restore(
        &store,
        Platform::current(),
        &snapshot,
        &mut noop_apply,
        &|| false,
    )
    .unwrap();
    assert_eq!(outcome.restored.len(), 1);
    assert_eq!(outcome.skipped.len(), 1);
    assert_eq!(fs::read(files.join("旧照片 001.jpg")).unwrap(), b"decoy");
    assert!(files.join("旅行_001.jpg").exists(), "冲突条目的文件必须原地不动");
    assert!(files.join("旧照片 002.jpg").exists());
}

#[test]
fn hash_mismatch_is_skipped() {
    let dir = root("hash");
    let files = dir.join("files");
    fs::create_dir_all(&files).unwrap();
    write(&files.join("旧照片 001.jpg"), b"original-content");
    let data_dir = dir.join("data");
    let store = BatchStore::new(&data_dir);
    let (snapshot, _) = snapshot::create(
        &data_dir,
        vec![files.to_string_lossy().to_string()],
        vec![input(&files, "旧照片 001.jpg", "旅行_001.jpg")],
        true,
        &mut noop_progress,
        &|| false,
    )
    .unwrap();
    assert_eq!(snapshot.hashed, 1);
    assert_eq!(snapshot.entries[0].sha256.as_deref().map(str::len), Some(64));

    fs::rename(files.join("旧照片 001.jpg"), files.join("旅行_001.jpg")).unwrap();
    write(&files.join("旅行_001.jpg"), b"changed-content");

    let plan = snapshot::plan(&snapshot);
    assert_eq!(plan[0].action, "restore");
    assert!(plan[0].hash_check);

    let outcome = snapshot::restore(
        &store,
        Platform::current(),
        &snapshot,
        &mut noop_apply,
        &|| false,
    )
    .unwrap();
    assert!(outcome.restored.is_empty());
    assert_eq!(outcome.hash_checked, 1);
    assert!(outcome.batch.is_none(), "没有可还原条目时不应写批次日志");
    assert!(outcome.skipped[0].reason.contains("SHA-256"));
    assert_eq!(fs::read(files.join("旅行_001.jpg")).unwrap(), b"changed-content");
    assert!(!files.join("旧照片 001.jpg").exists());
}

#[test]
fn size_change_without_hash_is_skipped() {
    let dir = root("size");
    let files = dir.join("files");
    fs::create_dir_all(&files).unwrap();
    write(&files.join("无扩展名"), b"short");
    let data_dir = dir.join("data");
    let snapshot = snapshot::create(
        &data_dir,
        vec![],
        vec![input(&files, "无扩展名", "无扩展名_2024")],
        false,
        &mut noop_progress,
        &|| false,
    )
    .unwrap()
    .0;
    fs::rename(files.join("无扩展名"), files.join("无扩展名_2024")).unwrap();
    write(&files.join("无扩展名_2024"), b"much-longer-content");

    let plan = snapshot::plan(&snapshot);
    assert_eq!(plan[0].action, "skip");
    assert_eq!(plan[0].reason_code.as_deref(), Some("changed"));

    let store = BatchStore::new(&data_dir);
    let outcome = snapshot::restore(
        &store,
        Platform::current(),
        &snapshot,
        &mut noop_apply,
        &|| false,
    )
    .unwrap();
    assert!(outcome.batch.is_none());
    assert!(files.join("无扩展名_2024").exists());
}

#[test]
fn list_and_delete() {
    let dir = root("list");
    let data_dir = dir.join("data");
    let files = dir.join("files");
    fs::create_dir_all(&files).unwrap();
    write(&files.join("a.txt"), b"a");
    let snap = snapshot::create(
        &data_dir,
        vec![],
        vec![input(&files, "a.txt", "b.txt")],
        false,
        &mut noop_progress,
        &|| false,
    )
    .unwrap()
    .0;
    let list = snapshot::list(&data_dir);
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].id, snap.id);
    assert_eq!(list[0].entry_count, 1);
    snapshot::remove(&data_dir, &snap.id).unwrap();
    assert!(snapshot::list(&data_dir).is_empty());
    assert!(snapshot::load(&data_dir, &snap.id).is_none());
}

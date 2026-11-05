//! 10,000 文件性能基线：真实磁盘扫描 / 冲突查询 / 批量改名执行。
//! 运行：cargo run --release --example perf_10k --manifest-path src-tauri/ffrn-core/Cargo.toml
//! 语料建在系统临时目录，结束后清理；不写用户目录。

use std::fs;
use std::path::Path;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use ffrn_core::platform::native_path;
use ffrn_core::rename::{ApplyItem, ApplyOptions};
use ffrn_core::scan::ScanOptions;
use ffrn_core::Core;

fn stamp() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

fn main() {
    let base = std::env::temp_dir().join(format!("ffrn-perf-10k-{}", stamp()));
    let root = base.join("files");
    let data = base.join("data");
    fs::create_dir_all(&root).unwrap();
    fs::create_dir_all(&data).unwrap();

    let dirs = 100;
    let per_dir = 100;
    let exts = ["jpg", "png", "mp3", "pdf", "txt", "docx"];
    let mut t = Instant::now();
    for d in 0..dirs {
        let dir = root.join(format!("批次 {d:03}"));
        fs::create_dir_all(native_path(&dir)).unwrap();
        for i in 0..per_dir {
            let ext = exts[(d + i) % exts.len()];
            let long = if i % 50 == 0 {
                "这是一个比较长的中文文件名用于测试长路径与渲染"
            } else {
                ""
            };
            let name = format!("照片_{long}_中文_{d:03}_{i:03}.{ext}");
            fs::write(native_path(&dir.join(name)), b"x").unwrap();
        }
    }
    println!("create_ms={}", t.elapsed().as_millis());
    t = Instant::now();

    let core = Core::new(&data);
    let opts = ScanOptions {
        recursive: true,
        include_files: true,
        include_dirs: false,
        max_entries: 20_000,
        ..Default::default()
    };
    let scan = core.scan(&[root.to_string_lossy().to_string()], &opts);
    println!(
        "scan_ms={} entries={} dirs={} warnings={}",
        t.elapsed().as_millis(),
        scan.entries.len(),
        scan.visited_dirs,
        scan.warnings.len()
    );

    t = Instant::now();
    let candidates: Vec<String> = scan
        .entries
        .iter()
        .map(|e| format!("{}\\__conflict_probe__\\{}", e.parent, e.name))
        .collect();
    let exists = core.paths_exist(&candidates);
    println!(
        "conflict_probe_ms={} hits={}",
        t.elapsed().as_millis(),
        exists.iter().filter(|v| **v).count()
    );

    let items: Vec<ApplyItem> = scan
        .entries
        .iter()
        .map(|e| ApplyItem {
            id: e.id.clone(),
            source: e.path.clone(),
            target_name: format!("r_{}", e.name),
            is_dir: false,
        })
        .collect();
    let apply_opts = ApplyOptions {
        policy: "skip".into(),
        skip_readonly: false,
        windows_safe: true,
        roots: vec![root.to_string_lossy().to_string()],
        label: Some("perf-10k".into()),
    };
    t = Instant::now();
    let outcome = core.apply(items, &apply_opts).unwrap();
    println!(
        "apply_ms={} applied={} skipped={} failed={}",
        t.elapsed().as_millis(),
        outcome.applied.len(),
        outcome.skipped.len(),
        outcome.failed.len()
    );

    t = Instant::now();
    let undo = core.undo(&outcome.batch.id).unwrap();
    println!(
        "undo_ms={} restored={} failed={}",
        t.elapsed().as_millis(),
        undo.restored.len(),
        undo.failed.len()
    );

    t = Instant::now();
    let _ = fs::remove_dir_all(native_path(&base));
    println!(
        "cleanup_ms={} base={}",
        t.elapsed().as_millis(),
        Path::new(&base).display()
    );
}

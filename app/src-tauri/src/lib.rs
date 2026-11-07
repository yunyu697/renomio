use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use renomio_core::journal::{Batch, BatchSummary};
use renomio_core::metaedit::dedupe::DuplicateReport;
use renomio_core::metaedit::{
    MetaCapability, MetaEditRequest, MetaEditResult, MetaSnapshot,
};
use renomio_core::metadata::MetadataInfo;
use renomio_core::ops::{
    AttrInfo, AttrSpec, MoveItem, MoveSpec, OpTarget, OpsOutcome, TimeInfo, TimeSpec,
};
use renomio_core::rename::{AppliedChange, ApplyItem, ApplyOptions, UndoOutcome};
use renomio_core::snapshot::{RestorePlanItem, Snapshot, SnapshotInput, SnapshotSummary};
use renomio_core::scan::{ScanOptions, ScanResult};
use renomio_core::{Core, EnvInfo};
use tauri::window::Color;
use tauri::{Emitter, Manager};

mod migrate;
mod update;

/// 与 tauri.conf.json 的 identifier 保持一致：启动日志要在 Tauri 就绪前就能落盘。
pub const APP_IDENTIFIER: &str = "app.renomio.desktop";
/// 用户可见产品名（前端品牌常量为 src/lib/branding.ts 的 PRODUCT_NAME，两处必须一致）。
pub const PRODUCT_NAME: &str = "Renomio";
/// 旧版标识与显示名：仅用于旧数据迁移与旧版并存检测，不对用户展示。
const LEGACY_IDENTIFIER: &str = "com.rename.studio";
const LEGACY_PRODUCT_NAME: &str = "Rename Studio";

static PROCESS_START_MS: AtomicU64 = AtomicU64::new(0);
static APPLY_RUNNING: AtomicBool = AtomicBool::new(false);
static APPLY_CANCELLED: AtomicBool = AtomicBool::new(false);
static HASH_CANCELLED: AtomicBool = AtomicBool::new(false);
static SNAPSHOT_RUNNING: AtomicBool = AtomicBool::new(false);
static SNAPSHOT_CANCELLED: AtomicBool = AtomicBool::new(false);

fn epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// `%APPDATA%\app.renomio.desktop\logs\startup.log`（与 `append_log` 的 app.log 同目录、同 TSV 格式）。
fn startup_log_path() -> Option<std::path::PathBuf> {
    let base = if cfg!(windows) {
        std::env::var_os("APPDATA").map(std::path::PathBuf::from)
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .map(std::path::PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".local/share"))
            })
    }?;
    Some(base.join(APP_IDENTIFIER).join("logs").join("startup.log"))
}

fn startup_log(event: &str, message: &str) {
    let Some(path) = startup_log_path() else {
        return;
    };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    else {
        return;
    };
    let ts = epoch_ms();
    let start = PROCESS_START_MS.load(Ordering::SeqCst);
    let elapsed = ts.saturating_sub(start);
    let _ = writeln!(
        file,
        "{ts}\tstartup\t{event}\telapsed={elapsed}ms\t{}",
        message.replace('\n', " ")
    );
}

/// 由 `main` 在进入 Tauri 之前调用：记录进程起点并重置本次启动日志。
pub fn mark_process_start() {
    let now = epoch_ms();
    PROCESS_START_MS.store(now, Ordering::SeqCst);
    if let Some(path) = startup_log_path() {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        // 每次启动覆盖，避免多次运行的时间戳混在一起
        let _ = std::fs::write(&path, "");
    }
    startup_log("proc_start", "main entry");
}

#[derive(serde::Deserialize)]
struct StartupMark {
    name: String,
    /// `performance.timeOrigin + performance.now()`，epoch 毫秒
    at: f64,
    /// 页面内 `performance.now()`，便于与 navigationStart 对齐
    #[serde(default)]
    ms: f64,
}

/// 前端首帧完成后回报：写启动日志，然后显示主窗口（`visible: false` 的收口）。
#[tauri::command]
fn startup_report(
    app: tauri::AppHandle,
    marks: Vec<StartupMark>,
    theme: Option<String>,
    reveal: bool,
) {
    let start = PROCESS_START_MS.load(Ordering::SeqCst);
    for mark in &marks {
        let at = mark.at.max(0.0) as u64;
        let elapsed = at.saturating_sub(start);
        startup_log(
            &mark.name,
            &format!("elapsed={elapsed}ms at={at} local={:.1}ms", mark.ms),
        );
    }
    if !reveal {
        return;
    }
    let Some(window) = app.get_webview_window("main") else {
        startup_log("window_show", "main window missing");
        return;
    };
    let dark = theme.as_deref() == Some("dark");
    let color = if dark {
        Color(11, 15, 22, 255)
    } else {
        Color(238, 241, 246, 255)
    };
    let _ = window.set_background_color(Some(color));
    let shown = window.show();
    startup_log(
        "window_show",
        &format!(
            "ok={} theme={}",
            shown.is_ok(),
            theme.as_deref().unwrap_or("light")
        ),
    );
    let _ = window.set_focus();
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ApplyProgress {
    phase: String,
    done: usize,
    total: usize,
    current: String,
}

#[tauri::command]
fn env_info(core: tauri::State<'_, Core>) -> EnvInfo {
    core.env(true)
}

/// 单条失败/跳过条目的前端视图：`code` 由核心的中文原因归一而来，界面据此选择文案与动作。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FailureView {
    id: String,
    source: String,
    code: String,
    reason: String,
}

/// 把核心原因文案归一为稳定代码（不改核心，避免改动公开结构体）。
fn classify_failure(reason: &str) -> &'static str {
    let r = reason.to_lowercase();
    if r.contains("os error 32")
        || r.contains("os error 33")
        || r.contains("being used by another process")
        || r.contains("正由另一进程")
        || r.contains("被其他进程")
    {
        return "in-use";
    }
    if r.contains("os error 5") || r.contains("access is denied") || r.contains("拒绝访问") {
        return "access-denied";
    }
    if r.contains("os error 3")
        || r.contains("not found")
        || r.contains("找不到")
        || r.contains("不可访问")
    {
        return "not-found";
    }
    if r.contains("只读") || r.contains("read-only") || r.contains("readonly") {
        return "readonly";
    }
    if r.contains("目标已存在") || r.contains("同一目标") || r.contains("冲突") {
        return "conflict";
    }
    if r.contains("过长")
        || r.contains("too long")
        || r.contains("超长")
        || r.contains("超过平台上限")
        || r.contains("超过单段上限")
        || r.contains("接近平台上限")
    {
        return "path-too-long";
    }
    if r.contains("非法") || r.contains("保留名") || r.contains("为空") {
        return "invalid-name";
    }
    "io-error"
}

fn failure_view(item: &renomio_core::rename::SkippedChange) -> FailureView {
    FailureView {
        id: item.id.clone(),
        source: item.source.clone(),
        code: classify_failure(&item.reason).to_string(),
        reason: item.reason.clone(),
    }
}

/// 执行结果：在原 `ApplyOutcome` 上给每条跳过/失败补 `code`。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ApplyResult {
    batch: Batch,
    applied: Vec<renomio_core::rename::AppliedChange>,
    skipped: Vec<FailureView>,
    failed: Vec<FailureView>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PrivilegeInfo {
    elevated: bool,
    platform: String,
    exe_path: String,
    install_dir: String,
    app_data_dir: String,
}

/// 当前进程是否提权 + 安装目录/数据目录，用于权限提示与 UIPI 拖放限制说明。
#[tauri::command]
fn privilege_info(core: tauri::State<'_, Core>) -> PrivilegeInfo {
    let exe = std::env::current_exe().ok();
    let exe_path = exe
        .as_ref()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let install_dir = exe
        .as_ref()
        .and_then(|p| p.parent())
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    PrivilegeInfo {
        elevated: is_elevated(),
        platform: std::env::consts::OS.to_string(),
        exe_path,
        install_dir,
        app_data_dir: core.env(true).data_dir,
    }
}

/// 通过 `ShellExecuteW(runas)` 重建提权进程。返回 `Ok(false)` 表示用户取消了 UAC。
#[tauri::command]
fn relaunch_as_admin() -> Result<bool, String> {
    relaunch_elevated()
}

#[tauri::command]
fn scan_paths(
    core: tauri::State<'_, Core>,
    paths: Vec<String>,
    options: ScanOptions,
) -> ScanResult {
    core.scan(&paths, &options)
}

#[tauri::command]
fn paths_exist(core: tauri::State<'_, Core>, paths: Vec<String>) -> Vec<bool> {
    core.paths_exist(&paths)
}

/// 批次执行：逐条推进并通过 `apply-progress` 事件回报（已处理/总数/当前文件名）。
/// 长任务节流到约 80ms 一次；取消通过 `cancel_apply` 置位，核心在条目边界安全回退。
#[tauri::command]
fn apply_plan(
    app: tauri::AppHandle,
    core: tauri::State<'_, Core>,
    items: Vec<ApplyItem>,
    options: ApplyOptions,
) -> Result<ApplyResult, String> {
    let requested = items.len();
    APPLY_CANCELLED.store(false, Ordering::SeqCst);
    APPLY_RUNNING.store(true, Ordering::SeqCst);

    let mut last_emit = std::time::Instant::now() - Duration::from_millis(200);
    let mut last_phase = String::new();

    let outcome = core.apply_with_progress(
        items,
        &options,
        &mut |phase: &str, done: usize, total: usize, current: &str| {
            let phase_changed = phase != last_phase;
            if phase_changed || done == total || last_emit.elapsed() >= Duration::from_millis(80) {
                last_emit = std::time::Instant::now();
                last_phase = phase.to_string();
                let _ = app.emit(
                    "apply-progress",
                    ApplyProgress {
                        phase: phase.to_string(),
                        done,
                        total,
                        current: current.to_string(),
                    },
                );
            }
        },
        &|| APPLY_CANCELLED.load(Ordering::SeqCst),
    );

    APPLY_RUNNING.store(false, Ordering::SeqCst);
    APPLY_CANCELLED.store(false, Ordering::SeqCst);

    if let Ok(outcome) = &outcome {
        let cancelled = outcome.batch.state == "cancelled";
        let _ = app.emit(
            "apply-progress",
            ApplyProgress {
                phase: if cancelled { "cancelled" } else { "done" }.to_string(),
                done: if cancelled {
                    outcome.applied.len()
                } else {
                    requested
                },
                total: requested,
                current: String::new(),
            },
        );
    }
    outcome.map(|o| ApplyResult {
        batch: o.batch,
        applied: o.applied,
        skipped: o.skipped.iter().map(failure_view).collect(),
        failed: o.failed.iter().map(failure_view).collect(),
    })
}

/// 请求取消正在执行的批次；未在执行时返回 false。
#[tauri::command]
fn cancel_apply() -> bool {
    if APPLY_RUNNING.load(Ordering::SeqCst) {
        APPLY_CANCELLED.store(true, Ordering::SeqCst);
        true
    } else {
        false
    }
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotProgress {
    phase: String,
    done: usize,
    total: usize,
    current: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotRestoreView {
    batch: Option<Batch>,
    restored: Vec<AppliedChange>,
    skipped: Vec<FailureView>,
    failed: Vec<FailureView>,
    hash_checked: usize,
}

/// 生成快照：默认只记名称/大小/时间；`withHash` 为真时逐条算 SHA-256，
/// 进度经 `snapshot-progress` 事件回报（约 80ms 节流），`cancel_snapshot` 可随时中止。
#[tauri::command]
fn create_snapshot(
    app: tauri::AppHandle,
    core: tauri::State<'_, Core>,
    entries: Vec<SnapshotInput>,
    with_hash: bool,
    roots: Vec<String>,
) -> Result<Snapshot, String> {
    SNAPSHOT_CANCELLED.store(false, Ordering::SeqCst);
    SNAPSHOT_RUNNING.store(true, Ordering::SeqCst);
    let mut last_emit = std::time::Instant::now() - Duration::from_millis(200);

    let result = core.snapshot_create(
        roots,
        entries,
        with_hash,
        &mut |done: usize, total: usize, current: &str| {
            if done == total || last_emit.elapsed() >= Duration::from_millis(80) {
                last_emit = std::time::Instant::now();
                let _ = app.emit(
                    "snapshot-progress",
                    SnapshotProgress {
                        phase: "hash".into(),
                        done,
                        total,
                        current: current.to_string(),
                    },
                );
            }
        },
        &|| SNAPSHOT_CANCELLED.load(Ordering::SeqCst),
    );

    let cancelled = SNAPSHOT_CANCELLED.load(Ordering::SeqCst);
    SNAPSHOT_RUNNING.store(false, Ordering::SeqCst);
    SNAPSHOT_CANCELLED.store(false, Ordering::SeqCst);
    if cancelled {
        let _ = app.emit(
            "snapshot-progress",
            SnapshotProgress {
                phase: "cancelled".into(),
                done: 0,
                total: 0,
                current: String::new(),
            },
        );
        return Err("已取消".into());
    }
    match &result {
        Ok((snap, _)) => {
            let _ = app.emit(
                "snapshot-progress",
                SnapshotProgress {
                    phase: "done".into(),
                    done: snap.entry_count,
                    total: snap.entry_count,
                    current: String::new(),
                },
            );
        }
        Err(_) => {
            let _ = app.emit(
                "snapshot-progress",
                SnapshotProgress {
                    phase: "failed".into(),
                    done: 0,
                    total: 0,
                    current: String::new(),
                },
            );
        }
    }
    result.map(|(snap, _)| snap)
}

#[tauri::command]
fn cancel_snapshot() -> bool {
    if SNAPSHOT_RUNNING.load(Ordering::SeqCst) {
        SNAPSHOT_CANCELLED.store(true, Ordering::SeqCst);
        true
    } else {
        false
    }
}

#[tauri::command]
fn list_snapshots(core: tauri::State<'_, Core>) -> Vec<SnapshotSummary> {
    renomio_core::snapshot::list(std::path::Path::new(&core.env(true).data_dir))
}

#[tauri::command]
fn preview_snapshot(core: tauri::State<'_, Core>, id: String) -> Result<Vec<RestorePlanItem>, String> {
    let snap = renomio_core::snapshot::load(std::path::Path::new(&core.env(true).data_dir), &id)
        .ok_or_else(|| "快照不存在或已损坏".to_string())?;
    Ok(renomio_core::snapshot::plan(&snap))
}

#[tauri::command]
fn restore_snapshot(
    app: tauri::AppHandle,
    core: tauri::State<'_, Core>,
    id: String,
) -> Result<SnapshotRestoreView, String> {
    let dir = core.env(true).data_dir;
    let snap = renomio_core::snapshot::load(std::path::Path::new(&dir), &id)
        .ok_or_else(|| "快照不存在或已损坏".to_string())?;

    SNAPSHOT_CANCELLED.store(false, Ordering::SeqCst);
    SNAPSHOT_RUNNING.store(true, Ordering::SeqCst);
    let mut last_emit = std::time::Instant::now() - Duration::from_millis(200);
    let mut last_phase = String::new();

    let result = core.snapshot_restore(
        &snap,
        &mut |phase: &str, done: usize, total: usize, current: &str| {
            let phase_changed = phase != last_phase;
            if phase_changed || done == total || last_emit.elapsed() >= Duration::from_millis(80) {
                last_emit = std::time::Instant::now();
                last_phase = phase.to_string();
                let _ = app.emit(
                    "snapshot-progress",
                    SnapshotProgress {
                        phase: phase.to_string(),
                        done,
                        total,
                        current: current.to_string(),
                    },
                );
            }
        },
        &|| SNAPSHOT_CANCELLED.load(Ordering::SeqCst),
    );

    let cancelled = SNAPSHOT_CANCELLED.load(Ordering::SeqCst);
    SNAPSHOT_RUNNING.store(false, Ordering::SeqCst);
    SNAPSHOT_CANCELLED.store(false, Ordering::SeqCst);
    if cancelled {
        let _ = app.emit(
            "snapshot-progress",
            SnapshotProgress {
                phase: "cancelled".into(),
                done: 0,
                total: 0,
                current: String::new(),
            },
        );
        return Err("已取消".into());
    }

    let outcome = result?;
    let _ = app.emit(
        "snapshot-progress",
        SnapshotProgress {
            phase: "done".into(),
            done: outcome.restored.len(),
            total: outcome.restored.len(),
            current: String::new(),
        },
    );
    Ok(SnapshotRestoreView {
        batch: outcome.batch,
        restored: outcome.restored,
        skipped: outcome.skipped.iter().map(failure_view).collect(),
        failed: outcome.failed.iter().map(failure_view).collect(),
        hash_checked: outcome.hash_checked,
    })
}

#[tauri::command]
fn delete_snapshot(core: tauri::State<'_, Core>, id: String) -> Result<(), String> {
    renomio_core::snapshot::remove(std::path::Path::new(&core.env(true).data_dir), &id)
}

#[tauri::command]
fn undo_batch(core: tauri::State<'_, Core>, id: String) -> Result<UndoOutcome, String> {
    core.undo(&id)
}

#[tauri::command]
fn list_batches(core: tauri::State<'_, Core>) -> Vec<BatchSummary> {
    core.batches()
}

#[tauri::command]
fn get_batch(core: tauri::State<'_, Core>, id: String) -> Option<Batch> {
    core.batch(&id)
}

#[tauri::command]
fn pending_batches(core: tauri::State<'_, Core>) -> Vec<BatchSummary> {
    core.pending_batches()
}

/// 只读元数据（图片 / 音乐 / 文档）；不写入任何文件或标签。
#[tauri::command]
fn read_metadata(core: tauri::State<'_, Core>, path: String) -> Result<MetadataInfo, String> {
    core.metadata(&path)
}

/// 元数据编辑支持矩阵（哪些格式可写、哪些如实拒绝）。
#[tauri::command]
fn meta_capabilities() -> Vec<MetaCapability> {
    renomio_core::metaedit::capabilities()
}

/// 读取可编辑字段（编辑对话框预填；不写文件）。
#[tauri::command]
fn meta_read(path: String) -> Result<MetaSnapshot, String> {
    renomio_core::metaedit::snapshot(&path)
}

/// 批量写入字段：逐文件「备份 → 改写 → 原子替换 → 回读校验」，单条失败不影响其它文件。
#[tauri::command]
async fn meta_edit(items: Vec<MetaEditRequest>) -> Result<Vec<MetaEditResult>, String> {
    tauri::async_runtime::spawn_blocking(move || renomio_core::metaedit::edit_batch(items))
        .await
        .map_err(|e| format!("元数据写入线程异常：{e}"))
}

/// 从备份还原文件（还原前会为当前文件再留一份保险备份）。
#[tauri::command]
async fn meta_restore_backup(backup: String, target: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        renomio_core::metaedit::restore_backup(&backup, &target)
    })
    .await
    .map_err(|e| format!("还原线程异常：{e}"))?
}

/// 疑似重复内容（不同路径、内容完全相同）：只读检测，不删除任何文件。
#[tauri::command]
async fn find_duplicates(paths: Vec<String>) -> Result<DuplicateReport, String> {
    tauri::async_runtime::spawn_blocking(move || renomio_core::metaedit::dedupe::find_duplicates(&paths))
        .await
        .map_err(|e| format!("重复检测线程异常：{e}"))
}

/// 批量只读元数据（九类列表页签）；单条失败逐条返回，不中断整批。
#[tauri::command]
fn read_metadata_batch(
    core: tauri::State<'_, Core>,
    paths: Vec<String>,
) -> Vec<renomio_core::metadata::BatchMetadata> {
    core.metadata_batch(&paths)
}

/// 读取文件时间（访问 / 修改 / 创建），用于「原值 → 新值」预览。
#[tauri::command]
fn read_times(core: tauri::State<'_, Core>, paths: Vec<String>) -> Vec<TimeInfo> {
    core.read_times(&paths)
}

/// 供「按元数据取名」规则使用的字段：EXIF 拍摄时间/相机型号、音频标题/艺术家/专辑/音轨。
/// 只读；缺失字段返回空串。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RenameFields {
    path: String,
    taken: String,
    camera: String,
    title: String,
    artist: String,
    album: String,
    track: String,
}

#[tauri::command]
fn rename_fields(paths: Vec<String>) -> Vec<RenameFields> {
    paths
        .iter()
        .map(|path| {
            let info = renomio_core::metadata::read_metadata(path).ok();
            let field = |labels: &[&str]| -> String {
                info.as_ref()
                    .and_then(|m| {
                        m.fields
                            .iter()
                            .find(|f| labels.iter().any(|l| f.label == *l))
                            .map(|f| f.value.clone())
                    })
                    .unwrap_or_default()
            };
            RenameFields {
                path: path.clone(),
                taken: field(&["拍摄时间"]).replace(':', "-"),
                camera: field(&["相机型号", "相机品牌"]),
                title: field(&["标题"]),
                artist: field(&["艺术家"]),
                album: field(&["专辑"]),
                track: field(&["音轨"]),
            }
        })
        .collect()
}

/// 元变量用的内容哈希结果：单文件失败只影响该文件。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct HashEntry {
    path: String,
    crc32: Option<String>,
    md5: Option<String>,
    sha1: Option<String>,
    error: Option<String>,
}

/// 批量流式计算内容哈希（CRC32 / MD5 / SHA-1），单遍读取；不阻塞 UI。
/// 取消通过 `cancel_hash` 置位，每个读取块都检查一次。
#[tauri::command]
async fn file_hashes(paths: Vec<String>, algos: Vec<String>) -> Result<Vec<HashEntry>, String> {
    HASH_CANCELLED.store(false, Ordering::SeqCst);
    let want_crc32 = algos.iter().any(|a| a.eq_ignore_ascii_case("crc32"));
    let want_md5 = algos.iter().any(|a| a.eq_ignore_ascii_case("md5"));
    let want_sha1 = algos.iter().any(|a| a.eq_ignore_ascii_case("sha1"));
    if !(want_crc32 || want_md5 || want_sha1) {
        return Ok(Vec::new());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = Vec::with_capacity(paths.len());
        for path in paths {
            if HASH_CANCELLED.load(Ordering::SeqCst) {
                out.push(HashEntry {
                    path,
                    crc32: None,
                    md5: None,
                    sha1: None,
                    error: Some("已取消".into()),
                });
                continue;
            }
            match renomio_core::hashing::file_hashes(
                std::path::Path::new(&path),
                want_crc32,
                want_md5,
                want_sha1,
                &|| HASH_CANCELLED.load(Ordering::SeqCst),
            ) {
                Ok(hash) => out.push(HashEntry {
                    path,
                    crc32: hash.crc32,
                    md5: hash.md5,
                    sha1: hash.sha1,
                    error: None,
                }),
                Err(err) => out.push(HashEntry {
                    path,
                    crc32: None,
                    md5: None,
                    sha1: None,
                    error: Some(err),
                }),
            }
        }
        out
    })
    .await
    .map_err(|e| format!("哈希计算线程异常：{e}"))
}

/// 请求取消正在进行的哈希计算；未在执行时返回 false。
#[tauri::command]
fn cancel_hash() -> bool {
    HASH_CANCELLED.store(true, Ordering::SeqCst);
    true
}

/// 读取基础属性（只读 / 隐藏），用于预览。
#[tauri::command]
fn read_attrs(core: tauri::State<'_, Core>, paths: Vec<String>) -> Vec<AttrInfo> {
    core.read_attrs(&paths)
}

/// 批量修改时间：先写批次日志并 fsync，再逐条写入；逐条失败只记录原因。
#[tauri::command]
fn apply_time(
    core: tauri::State<'_, Core>,
    items: Vec<OpTarget>,
    spec: TimeSpec,
) -> Result<OpsOutcome, String> {
    core.apply_time(items, &spec)
}

/// 批量修改只读 / 隐藏属性。
#[tauri::command]
fn apply_attrs(
    core: tauri::State<'_, Core>,
    items: Vec<OpTarget>,
    spec: AttrSpec,
) -> Result<OpsOutcome, String> {
    core.apply_attrs(items, &spec)
}

/// 归类移动：目标目录不存在时创建；跨盘走复制 → 校验 → 删除源。
#[tauri::command]
fn apply_move(
    core: tauri::State<'_, Core>,
    items: Vec<MoveItem>,
    spec: MoveSpec,
) -> Result<OpsOutcome, String> {
    core.apply_move(items, &spec)
}

/// 读取文本文件（方案 JSON 等）；限制大小，避免误读超大文件。
#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    let meta = std::fs::metadata(&path).map_err(|e| format!("无法读取文件信息：{e}"))?;
    if meta.len() > 4 * 1024 * 1024 {
        return Err("文件超过 4MB，已拒绝读取".into());
    }
    std::fs::read_to_string(&path).map_err(|e| format!("读取失败：{e}"))
}

static EXPORT_SEQ: AtomicU64 = AtomicU64::new(0);

/// 原子写入任意字节：同目录临时文件 → fsync → 两阶段改名。
/// 目标已存在时先移入数据目录的 exports-backup，返回备份路径；不允许覆盖时直接拒绝。
fn write_atomic_bytes(
    core: &Core,
    path: &str,
    bytes: &[u8],
    overwrite: Option<bool>,
) -> Result<Option<String>, String> {
    use std::path::PathBuf;

    let target = PathBuf::from(path);
    let parent = target
        .parent()
        .ok_or_else(|| "目标路径无效".to_string())?
        .to_path_buf();
    if !parent.exists() {
        return Err(format!("目标目录不存在：{}", parent.to_string_lossy()));
    }

    let seq = EXPORT_SEQ.fetch_add(1, Ordering::Relaxed);
    let temp = parent.join(format!(".renomio-export-{}-{seq}.tmp", std::process::id()));
    {
        let mut file =
            std::fs::File::create(&temp).map_err(|e| format!("创建临时文件失败：{e}"))?;
        file.write_all(bytes)
            .map_err(|e| format!("写入临时文件失败：{e}"))?;
        file.sync_all()
            .map_err(|e| format!("临时文件落盘失败：{e}"))?;
    }

    let mut backup: Option<PathBuf> = None;
    if target.exists() {
        if !overwrite.unwrap_or(false) {
            let _ = std::fs::remove_file(&temp);
            return Err("目标文件已存在，且未允许覆盖".into());
        }
        let dir = PathBuf::from(core.env(true).data_dir).join("exports-backup");
        std::fs::create_dir_all(&dir).map_err(|e| format!("创建备份目录失败：{e}"))?;
        let name = target
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "export".into());
        let safe: String = name.chars().take(80).collect();
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let bak = dir.join(format!("{stamp}-{seq}-{safe}"));
        std::fs::rename(&target, &bak).map_err(|e| {
            let _ = std::fs::remove_file(&temp);
            format!("备份已有目标失败，未写入：{e}")
        })?;
        backup = Some(bak);
    }

    if let Err(err) = std::fs::rename(&temp, &target) {
        let _ = std::fs::remove_file(&temp);
        if let Some(bak) = &backup {
            let _ = std::fs::rename(bak, &target);
        }
        return Err(format!("替换目标失败：{err}"));
    }

    Ok(backup.map(|b| b.to_string_lossy().to_string()))
}

#[tauri::command]
fn write_text_atomic(
    core: tauri::State<'_, Core>,
    path: String,
    content: String,
    overwrite: Option<bool>,
) -> Result<Option<String>, String> {
    write_atomic_bytes(&core, &path, content.as_bytes(), overwrite)
}

/// 原子写入二进制文件（导出 xlsx 等）：content 为 base64，备份/覆盖策略与文本写入一致。
#[tauri::command]
fn write_bytes_atomic(
    core: tauri::State<'_, Core>,
    path: String,
    content: String,
    overwrite: Option<bool>,
) -> Result<Option<String>, String> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(content.as_bytes())
        .map_err(|e| format!("内容不是合法 base64：{e}"))?;
    write_atomic_bytes(&core, &path, &bytes, overwrite)
}

/// 规则链输入历史：存放在数据目录下的 `rule-history.json`（`%APPDATA%\app.renomio.desktop`），
/// 与安装目录无关，升级/覆盖安装后仍然保留；坏文件改名留证并按「无历史」继续启动。
#[tauri::command]
fn load_rule_history(core: tauri::State<'_, Core>) -> Result<String, String> {
    let path = std::path::PathBuf::from(core.env(true).data_dir).join("rule-history.json");
    match std::fs::read_to_string(&path) {
        Ok(text) => {
            if serde_json::from_str::<serde_json::Value>(&text).is_err() {
                let _ = std::fs::rename(&path, path.with_extension("json.bad"));
                return Ok(String::new());
            }
            Ok(text)
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(err) => Err(format!("读取输入历史失败：{err}")),
    }
}

/// 原子写入输入历史：同目录临时文件 → fsync → 改名，避免中断留下半截 JSON。
#[tauri::command]
fn save_rule_history(core: tauri::State<'_, Core>, content: String) -> Result<(), String> {
    if content.len() > 512 * 1024 {
        return Err("输入历史超过 512KB，已拒绝写入".into());
    }
    serde_json::from_str::<serde_json::Value>(&content)
        .map_err(|_| "输入历史不是合法 JSON，已拒绝写入".to_string())?;

    let dir = std::path::PathBuf::from(core.env(true).data_dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建数据目录失败：{e}"))?;
    let target = dir.join("rule-history.json");
    let temp = dir.join(".rule-history.tmp");
    {
        let mut file =
            std::fs::File::create(&temp).map_err(|e| format!("创建临时文件失败：{e}"))?;
        file.write_all(content.as_bytes())
            .map_err(|e| format!("写入临时文件失败：{e}"))?;
        file.sync_all()
            .map_err(|e| format!("临时文件落盘失败：{e}"))?;
    }
    std::fs::rename(&temp, &target).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        format!("替换历史文件失败：{e}")
    })
}

#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    let target = std::path::Path::new(&path);
    if !target.exists() {
        return Err("路径不存在".into());
    }
    #[cfg(target_os = "windows")]
    {
        let arg = format!("/select,\"{}\"", target.to_string_lossy());
        std::process::Command::new("explorer.exe")
            .arg(arg)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("无法打开资源管理器：{e}"))
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(target)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("无法打开访达：{e}"))
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        let dir = target.parent().unwrap_or(target);
        std::process::Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("无法打开文件管理器：{e}"))
    }
}

/// 基础层 Logger 的落盘 sink：追加写入 app data/logs/app.log（超过 2MB 轮转一次）
#[tauri::command]
fn append_log(
    core: tauri::State<'_, Core>,
    level: String,
    event: String,
    message: Option<String>,
) -> Result<(), String> {
    let dir = core.env(true).data_dir;
    let dir = std::path::PathBuf::from(dir).join("logs");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join("app.log");
    if let Ok(meta) = std::fs::metadata(&file) {
        if meta.len() > 2 * 1024 * 1024 {
            let _ = std::fs::rename(&file, dir.join("app.1.log"));
        }
    }
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&file)
        .map_err(|e| e.to_string())?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    writeln!(
        f,
        "{ts}\t{level}\t{event}\t{}",
        message.unwrap_or_default().replace('\n', " ")
    )
    .map_err(|e| e.to_string())
}

/// 旧版数据迁移结果（首次启动时已在 Tauri 就绪前完成）。
#[tauri::command]
fn migration_info(state: tauri::State<'_, migrate::MigrationState>) -> migrate::MigrationInfo {
    state.info()
}

/// 设置里的「从旧版导入数据」：先整份备份当前数据目录，再补齐旧目录独有的文件。
#[tauri::command]
fn import_legacy_data(
    state: tauri::State<'_, migrate::MigrationState>,
) -> Result<migrate::ImportReport, String> {
    migrate::import_legacy(&state.new_dir, &state.old_dir)
}

#[cfg(windows)]
mod win_elevation {
    use std::ffi::{c_void, OsStr};
    use std::os::windows::ffi::OsStrExt;

    type Handle = *mut c_void;

    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentProcess() -> Handle;
        fn CloseHandle(h: Handle) -> i32;
    }

    #[link(name = "advapi32")]
    extern "system" {
        fn OpenProcessToken(process: Handle, access: u32, token: *mut Handle) -> i32;
        fn GetTokenInformation(
            token: Handle,
            class: u32,
            info: *mut c_void,
            len: u32,
            ret: *mut u32,
        ) -> i32;
    }

    #[link(name = "shell32")]
    extern "system" {
        fn ShellExecuteW(
            hwnd: Handle,
            op: *const u16,
            file: *const u16,
            params: *const u16,
            dir: *const u16,
            show: i32,
        ) -> Handle;
    }

    const TOKEN_QUERY: u32 = 0x0008;
    const TOKEN_ELEVATION: u32 = 20;

    pub fn elevated() -> bool {
        unsafe {
            let mut token: Handle = std::ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return false;
            }
            let mut elevation: u32 = 0;
            let mut len: u32 = 0;
            let ok = GetTokenInformation(
                token,
                TOKEN_ELEVATION,
                &mut elevation as *mut u32 as *mut c_void,
                std::mem::size_of::<u32>() as u32,
                &mut len,
            );
            let _ = CloseHandle(token);
            ok != 0 && elevation != 0
        }
    }

    pub enum LaunchOutcome {
        Started,
        Cancelled,
    }

    /// 以 `runas` 启动任意程序（唯一提权入口）：`Err(code)` 为 ShellExecuteW 原始返回码。
    pub fn run_elevated(file: &OsStr, params: Option<&str>) -> Result<LaunchOutcome, isize> {
        let verb = wide("runas");
        let file_wide: Vec<u16> = file.encode_wide().chain(std::iter::once(0)).collect();
        let params_wide = params.map(wide);
        let ret = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                verb.as_ptr(),
                file_wide.as_ptr(),
                params_wide
                    .as_ref()
                    .map(|v| v.as_ptr())
                    .unwrap_or(std::ptr::null()),
                std::ptr::null(),
                1,
            )
        };
        let code = ret as isize;
        if code > 32 {
            Ok(LaunchOutcome::Started)
        } else if code == 1223 {
            Ok(LaunchOutcome::Cancelled)
        } else {
            Err(code)
        }
    }

    /// 以 `runas` 重新启动自身：`Ok(true)` 表示新进程已创建，`Ok(false)` 表示用户取消 UAC。
    pub fn relaunch() -> Result<bool, String> {
        let exe = std::env::current_exe().map_err(|e| format!("无法定位当前程序：{e}"))?;
        let args: Vec<String> = std::env::args().skip(1).collect();
        let params = args
            .iter()
            .map(|a| format!("\"{}\"", a.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(" ");
        match run_elevated(
            exe.as_os_str(),
            (params.is_empty()).then_some(params.as_str()),
        ) {
            Ok(LaunchOutcome::Started) => Ok(true),
            Ok(LaunchOutcome::Cancelled) => Ok(false),
            Err(code) => Err(format!("提权启动失败（ShellExecuteW 返回 {code}）")),
        }
    }

    fn wide(s: &str) -> Vec<u16> {
        OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }
}

#[cfg(windows)]
fn is_elevated() -> bool {
    win_elevation::elevated()
}

#[cfg(windows)]
fn relaunch_elevated() -> Result<bool, String> {
    win_elevation::relaunch()
}

#[cfg(not(windows))]
fn is_elevated() -> bool {
    false
}

#[cfg(not(windows))]
fn relaunch_elevated() -> Result<bool, String> {
    Err("当前平台不支持以管理员身份重启".to_string())
}

#[cfg(test)]
mod tests {
    use super::classify_failure;

    #[test]
    fn classifies_os_failures() {
        assert_eq!(
            classify_failure("移动到临时名失败：拒绝访问。 (os error 5)"),
            "access-denied"
        );
        assert_eq!(
            classify_failure("移动到临时名失败：另一个程序正在使用此文件。 (os error 32)"),
            "in-use"
        );
        assert_eq!(
            classify_failure("源文件不可访问：系统找不到指定的文件。 (os error 3)"),
            "not-found"
        );
        assert_eq!(classify_failure("只读文件，按设置跳过"), "readonly");
        assert_eq!(classify_failure("目标已存在，按策略跳过"), "conflict");
        assert_eq!(classify_failure("路径过长：超过平台上限"), "path-too-long");
        assert_eq!(
            classify_failure("完整路径 300 字符，接近平台上限"),
            "path-too-long"
        );
        assert_eq!(
            classify_failure("名称 300 个字符，超过单段上限 255"),
            "path-too-long"
        );
        assert_eq!(classify_failure("新名称含非法字符"), "invalid-name");
        assert_eq!(classify_failure("未知问题"), "io-error");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 迁移必须在 Core::new 之前完成：Core 会创建/写入新数据目录，之后就分不清「新目录本来就存在」。
    let new_dir = migrate::data_root(APP_IDENTIFIER);
    let old_dir = migrate::data_root(LEGACY_IDENTIFIER);
    let migration = migrate::MigrationState::new(
        migrate::run(&old_dir, &new_dir, LEGACY_PRODUCT_NAME, PRODUCT_NAME),
        new_dir,
        old_dir,
    );

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            startup_log("setup_begin", "");
            let data_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("无法获取应用数据目录：{e}"))?;
            app.manage(migration);
            app.manage(Core::new(data_dir));
            update::cleanup_stale_parts();
            startup_log("core_ready", "Core::new done");
            if let Some(window) = app.get_webview_window("main") {
                let visible = window.is_visible().unwrap_or(false);
                startup_log("window_created", &format!("visible={visible}"));
            } else {
                startup_log("window_created", "main window not found in setup");
            }
            // 兜底：前端异常或首帧回调未触发时，5 秒后也把窗口显示出来，避免永久隐藏
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(5000));
                if let Some(window) = handle.get_webview_window("main") {
                    if !window.is_visible().unwrap_or(true) {
                        let _ = window.show();
                        startup_log("show_fallback", "frontend did not report first frame in 5s");
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            startup_report,
            env_info,
            privilege_info,
            relaunch_as_admin,
            scan_paths,
            paths_exist,
            apply_plan,
            cancel_apply,
            create_snapshot,
            cancel_snapshot,
            list_snapshots,
            preview_snapshot,
            restore_snapshot,
            delete_snapshot,
            undo_batch,
            list_batches,
            get_batch,
            pending_batches,
            read_metadata,
            read_metadata_batch,
            meta_capabilities,
            meta_read,
            meta_edit,
            meta_restore_backup,
            find_duplicates,
            rename_fields,
            file_hashes,
            cancel_hash,
            read_times,
            read_attrs,
            apply_time,
            apply_attrs,
            apply_move,
            read_text_file,
            write_text_atomic,
            write_bytes_atomic,
            load_rule_history,
            save_rule_history,
            update::check_update,
            update::download_update,
            update::install_saved_update,
            update::open_homepage,
            reveal_path,
            append_log,
            migration_info,
            import_legacy_data
        ])
        .run(tauri::generate_context!())
        .unwrap_or_else(|e| panic!("启动 {} 失败：{e}", PRODUCT_NAME));
}

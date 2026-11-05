//! 批量操作：时间 / 属性 / 归类移动。
//!
//! 统一约束：
//! 1. 先把计划（含原值）写入批次日志并 fsync，再动文件；
//! 2. 逐条执行，单条失败只记录原因，不影响其它条目；
//! 3. 移动先尝试同盘 rename；跨盘（或强制测试）走「复制 → 逐字节校验 → 删除源」，
//!    任一步失败都回滚，绝不出现「源已删除而副本不完整」；
//! 4. 三种操作都可在批次历史中撤销。

use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::journal::{new_batch_id, now_ms, Batch, BatchCounts, BatchOp, BatchStore};
use crate::platform::{is_readonly, native_path, Platform};
use crate::rename::{AppliedChange, SkippedChange, SkippedField, UndoOutcome};

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpsChange {
    pub id: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    pub before: String,
    pub after: String,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpsOutcome {
    pub batch: Batch,
    pub applied: Vec<OpsChange>,
    pub skipped: Vec<SkippedChange>,
    pub failed: Vec<SkippedChange>,
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct OpTarget {
    pub id: String,
    pub path: String,
    pub is_dir: bool,
}

impl Default for OpTarget {
    fn default() -> Self {
        Self {
            id: String::new(),
            path: String::new(),
            is_dir: false,
        }
    }
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TimeSpec {
    /// shift = 按偏移平移；fixed = 设为固定时间
    pub mode: String,
    pub shift_seconds: i64,
    /// 固定值（毫秒时间戳）
    pub fixed_ms: i64,
    /// mtime / atime / creation 的子集
    pub fields: Vec<String>,
}

impl Default for TimeSpec {
    fn default() -> Self {
        Self {
            mode: "shift".into(),
            shift_seconds: 0,
            fixed_ms: 0,
            fields: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AttrSpec {
    /// None = 保持原状
    pub readonly: Option<bool>,
    pub hidden: Option<bool>,
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveItem {
    pub id: String,
    pub source: String,
    pub target: String,
    #[serde(default)]
    pub is_dir: bool,
}

#[derive(Clone, Debug, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct MoveSpec {
    pub create_dirs: bool,
    pub roots: Vec<String>,
    /// 测试/诊断用：即使同盘也强制走复制-校验-删除路径
    pub force_copy: bool,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeInfo {
    pub path: String,
    pub name: String,
    pub atime_ms: Option<i64>,
    pub mtime_ms: Option<i64>,
    pub creation_ms: Option<i64>,
    pub creation_writable: bool,
    pub error: Option<String>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttrInfo {
    pub path: String,
    pub name: String,
    pub readonly: bool,
    pub hidden: bool,
    pub hidden_supported: bool,
    pub error: Option<String>,
}

fn to_system(ms: i64) -> SystemTime {
    if ms >= 0 {
        UNIX_EPOCH + Duration::from_millis(ms as u64)
    } else {
        UNIX_EPOCH - Duration::from_millis((-ms) as u64)
    }
}

fn from_system(time: SystemTime) -> Option<i64> {
    match time.duration_since(UNIX_EPOCH) {
        Ok(after) => Some(after.as_millis() as i64),
        Err(before) => Some(-(before.duration().as_millis() as i64)),
    }
}

fn accessed_ms(meta: &fs::Metadata) -> Option<i64> {
    meta.accessed().ok().and_then(from_system)
}

fn modified_ms(meta: &fs::Metadata) -> Option<i64> {
    meta.modified().ok().and_then(from_system)
}

fn name_of(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default()
}

fn creation_writable() -> bool {
    crate::platform::can_write_btime()
}

pub fn read_times(paths: &[String]) -> Vec<TimeInfo> {
    paths
        .iter()
        .map(|raw| {
            let path = PathBuf::from(raw);
            let base = TimeInfo {
                path: raw.clone(),
                name: name_of(&path),
                atime_ms: None,
                mtime_ms: None,
                creation_ms: None,
                creation_writable: creation_writable(),
                error: None,
            };
            match fs::metadata(native_path(&path)) {
                Ok(meta) => TimeInfo {
                    atime_ms: accessed_ms(&meta),
                    mtime_ms: modified_ms(&meta),
                    creation_ms: meta.created().ok().and_then(from_system),
                    ..base
                },
                Err(err) => TimeInfo {
                    error: Some(format!("无法读取文件信息：{err}")),
                    ..base
                },
            }
        })
        .collect()
}

pub fn read_attrs(paths: &[String]) -> Vec<AttrInfo> {
    paths
        .iter()
        .map(|raw| {
            let path = PathBuf::from(raw);
            let base = AttrInfo {
                path: raw.clone(),
                name: name_of(&path),
                readonly: false,
                hidden: false,
                hidden_supported: cfg!(windows),
                error: None,
            };
            match fs::metadata(native_path(&path)) {
                Ok(meta) => AttrInfo {
                    readonly: is_readonly(&meta),
                    hidden: is_hidden(&path).unwrap_or(false),
                    ..base
                },
                Err(err) => AttrInfo {
                    error: Some(format!("无法读取文件信息：{err}")),
                    ..base
                },
            }
        })
        .collect()
}

fn pick(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(Value::as_i64)
}

fn parse_time_values(raw: &str) -> (Option<i64>, Option<i64>, Option<i64>) {
    let value: Value = serde_json::from_str(raw).unwrap_or(Value::Null);
    (
        pick(&value, "atime"),
        pick(&value, "mtime"),
        pick(&value, "creation"),
    )
}

fn write_times(
    path: &Path,
    atime: Option<i64>,
    mtime: Option<i64>,
    creation: Option<i64>,
) -> Result<(), String> {
    let native = native_path(path);
    if atime.is_some() || mtime.is_some() {
        let mut times = fs::FileTimes::new();
        if let Some(ms) = atime {
            times = times.set_accessed(to_system(ms));
        }
        if let Some(ms) = mtime {
            times = times.set_modified(to_system(ms));
        }
        let file = fs::OpenOptions::new()
            .write(true)
            .open(&native)
            .map_err(|e| format!("无法以写权限打开（只读、被占用或权限不足）：{e}"))?;
        file.set_times(times)
            .map_err(|e| format!("写入访问/修改时间失败：{e}"))?;
    }
    if let Some(ms) = creation {
        #[cfg(windows)]
        {
            set_creation_time(&native, to_system(ms))
                .map_err(|e| format!("写入创建时间失败：{e}"))?;
        }
        #[cfg(not(windows))]
        {
            let _ = ms;
            return Err("当前平台不支持写入创建时间（仅 Windows）".into());
        }
    }
    Ok(())
}

fn time_desired(old: Option<i64>, spec: &TimeSpec) -> Option<i64> {
    match spec.mode.as_str() {
        "fixed" => Some(spec.fixed_ms),
        _ => old.map(|v| v.saturating_add(spec.shift_seconds.saturating_mul(1000))),
    }
}

pub fn apply_time(
    store: &BatchStore,
    items: Vec<OpTarget>,
    spec: &TimeSpec,
) -> Result<OpsOutcome, String> {
    let batch_id = new_batch_id();
    let fields: HashSet<String> = spec.fields.iter().cloned().collect();
    let mut ops: Vec<BatchOp> = Vec::new();
    let mut skipped: Vec<SkippedChange> = Vec::new();
    let mut failed: Vec<SkippedChange> = Vec::new();

    if fields.is_empty() {
        return Err("未选择任何时间字段".into());
    }
    if spec.mode != "shift" && spec.mode != "fixed" {
        return Err(format!("未知的时间模式：{}", spec.mode));
    }
    let wants_creation = fields.contains("creation");
    let platform_supports_creation = creation_writable();

    for item in items {
        let path = PathBuf::from(&item.path);
        let base_fail = |reason: String| SkippedChange {
            id: item.id.clone(),
            source: item.path.clone(),
            reason,
        };
        let meta = match fs::metadata(native_path(&path)) {
            Ok(m) => m,
            Err(err) => {
                let reason = format!("无法读取文件信息：{err}");
                failed.push(base_fail(reason.clone()));
                ops.push(BatchOp {
                    id: item.id.clone(),
                    kind: "time".into(),
                    path: item.path.clone(),
                    target: None,
                    before: "{}".into(),
                    after: "{}".into(),
                    state: "failed".into(),
                    reason: Some(reason),
                });
                continue;
            }
        };
        if wants_creation && !platform_supports_creation {
            let reason = "当前平台不支持写入创建时间（仅 Windows）".to_string();
            failed.push(base_fail(reason.clone()));
            ops.push(BatchOp {
                id: item.id.clone(),
                kind: "time".into(),
                path: item.path.clone(),
                target: None,
                before: json!({
                    "atime": accessed_ms(&meta),
                    "mtime": modified_ms(&meta),
                    "creation": meta.created().ok().and_then(from_system),
                })
                .to_string(),
                after: "{}".into(),
                state: "failed".into(),
                reason: Some(reason),
            });
            continue;
        }

        let old_atime = accessed_ms(&meta);
        let old_mtime = modified_ms(&meta);
        let old_creation = meta.created().ok().and_then(from_system);
        let before =
            json!({ "atime": old_atime, "mtime": old_mtime, "creation": old_creation }).to_string();

        let new_atime = if fields.contains("atime") {
            time_desired(old_atime, spec)
        } else {
            None
        };
        let new_mtime = if fields.contains("mtime") {
            time_desired(old_mtime, spec)
        } else {
            None
        };
        let new_creation = if wants_creation {
            time_desired(old_creation, spec)
        } else {
            None
        };

        if (fields.contains("atime") && new_atime.is_none())
            || (fields.contains("mtime") && new_mtime.is_none())
            || (wants_creation && new_creation.is_none())
        {
            let reason = "无法读取原时间值，已跳过".to_string();
            failed.push(base_fail(reason.clone()));
            ops.push(BatchOp {
                id: item.id.clone(),
                kind: "time".into(),
                path: item.path.clone(),
                target: None,
                before,
                after: "{}".into(),
                state: "failed".into(),
                reason: Some(reason),
            });
            continue;
        }

        let changed = (fields.contains("atime") && new_atime != old_atime)
            || (fields.contains("mtime") && new_mtime != old_mtime)
            || (wants_creation && new_creation != old_creation);

        if !changed {
            let reason = "时间未变更".to_string();
            skipped.push(base_fail(reason.clone()));
            ops.push(BatchOp {
                id: item.id.clone(),
                kind: "time".into(),
                path: item.path.clone(),
                target: None,
                before,
                after: "{}".into(),
                state: "skipped".into(),
                reason: Some(reason),
            });
            continue;
        }

        let after =
            json!({ "atime": new_atime, "mtime": new_mtime, "creation": new_creation }).to_string();
        ops.push(BatchOp {
            id: item.id.clone(),
            kind: "time".into(),
            path: item.path.clone(),
            target: None,
            before,
            after,
            state: "planned".into(),
            reason: None,
        });
    }

    let mut batch = Batch {
        id: batch_id.clone(),
        created_at: now_ms(),
        finished_at: None,
        state: "pending".into(),
        kind: "time".into(),
        policy: "skip".into(),
        roots: collect_roots(&ops),
        counts: BatchCounts {
            total: ops.len(),
            done: 0,
            skipped: skipped.len(),
            failed: failed.len(),
        },
        items: Vec::new(),
        ops,
        created_dirs: Vec::new(),
    };

    if batch.ops.is_empty() {
        batch.state = "completed".into();
        batch.finished_at = Some(now_ms());
        return Ok(OpsOutcome {
            batch,
            applied: Vec::new(),
            skipped,
            failed,
        });
    }

    store
        .save(&batch)
        .map_err(|e| format!("无法写入批次日志，已中止（未改动任何文件）：{e}"))?;

    let mut applied: Vec<OpsChange> = Vec::new();
    for op in batch.ops.iter_mut() {
        if op.state != "planned" {
            continue;
        }
        let (atime, mtime, creation) = parse_time_values(&op.after);
        match write_times(Path::new(&op.path), atime, mtime, creation) {
            Ok(()) => {
                op.state = "done".into();
                applied.push(OpsChange {
                    id: op.id.clone(),
                    path: op.path.clone(),
                    target: None,
                    before: op.before.clone(),
                    after: op.after.clone(),
                });
            }
            Err(reason) => {
                op.state = "failed".into();
                op.reason = Some(reason.clone());
                failed.push(SkippedChange {
                    id: op.id.clone(),
                    source: op.path.clone(),
                    reason,
                });
            }
        }
    }

    finish(
        store,
        &mut batch,
        applied.len(),
        skipped.len(),
        failed.len(),
    );
    Ok(OpsOutcome {
        batch,
        applied,
        skipped,
        failed,
    })
}

pub fn apply_attrs(
    store: &BatchStore,
    items: Vec<OpTarget>,
    spec: &AttrSpec,
) -> Result<OpsOutcome, String> {
    let batch_id = new_batch_id();
    let mut ops: Vec<BatchOp> = Vec::new();
    let mut skipped: Vec<SkippedChange> = Vec::new();
    let mut failed: Vec<SkippedChange> = Vec::new();

    if spec.readonly.is_none() && spec.hidden.is_none() {
        return Err("未选择任何属性".into());
    }

    for item in items {
        let path = PathBuf::from(&item.path);
        let base_fail = |reason: String| SkippedChange {
            id: item.id.clone(),
            source: item.path.clone(),
            reason,
        };
        let meta = match fs::metadata(native_path(&path)) {
            Ok(m) => m,
            Err(err) => {
                let reason = format!("无法读取文件信息：{err}");
                failed.push(base_fail(reason.clone()));
                ops.push(BatchOp {
                    id: item.id.clone(),
                    kind: "attrs".into(),
                    path: item.path.clone(),
                    target: None,
                    before: "{}".into(),
                    after: "{}".into(),
                    state: "failed".into(),
                    reason: Some(reason),
                });
                continue;
            }
        };
        let old_readonly = is_readonly(&meta);
        let old_hidden = is_hidden(&path).unwrap_or(false);
        let new_readonly = spec.readonly.unwrap_or(old_readonly);
        let new_hidden = spec.hidden.unwrap_or(old_hidden);
        let before = json!({ "readonly": old_readonly, "hidden": old_hidden }).to_string();

        if spec.hidden.is_some() && !cfg!(windows) {
            let reason = "当前平台不支持隐藏属性（仅 Windows）".to_string();
            failed.push(base_fail(reason.clone()));
            ops.push(BatchOp {
                id: item.id.clone(),
                kind: "attrs".into(),
                path: item.path.clone(),
                target: None,
                before,
                after: "{}".into(),
                state: "failed".into(),
                reason: Some(reason),
            });
            continue;
        }

        if new_readonly == old_readonly && new_hidden == old_hidden {
            let reason = "属性未变更".to_string();
            skipped.push(base_fail(reason.clone()));
            ops.push(BatchOp {
                id: item.id.clone(),
                kind: "attrs".into(),
                path: item.path.clone(),
                target: None,
                before,
                after: "{}".into(),
                state: "skipped".into(),
                reason: Some(reason),
            });
            continue;
        }

        let after = json!({ "readonly": new_readonly, "hidden": new_hidden }).to_string();
        ops.push(BatchOp {
            id: item.id.clone(),
            kind: "attrs".into(),
            path: item.path.clone(),
            target: None,
            before,
            after,
            state: "planned".into(),
            reason: None,
        });
    }

    let mut batch = Batch {
        id: batch_id.clone(),
        created_at: now_ms(),
        finished_at: None,
        state: "pending".into(),
        kind: "attrs".into(),
        policy: "skip".into(),
        roots: collect_roots(&ops),
        counts: BatchCounts {
            total: ops.len(),
            done: 0,
            skipped: skipped.len(),
            failed: failed.len(),
        },
        items: Vec::new(),
        ops,
        created_dirs: Vec::new(),
    };

    if batch.ops.is_empty() {
        batch.state = "completed".into();
        batch.finished_at = Some(now_ms());
        return Ok(OpsOutcome {
            batch,
            applied: Vec::new(),
            skipped,
            failed,
        });
    }

    store
        .save(&batch)
        .map_err(|e| format!("无法写入批次日志，已中止（未改动任何文件）：{e}"))?;

    let mut applied: Vec<OpsChange> = Vec::new();
    for op in batch.ops.iter_mut() {
        if op.state != "planned" {
            continue;
        }
        let (before_readonly, before_hidden) = parse_attr_values(&op.before);
        let (want_readonly, want_hidden) = parse_attr_bool(&op.after);
        let path = PathBuf::from(&op.path);
        if let Err(reason) = apply_attr_values(
            &path,
            want_readonly,
            want_hidden,
            before_readonly,
            before_hidden,
        ) {
            op.state = "failed".into();
            op.reason = Some(reason.clone());
            failed.push(SkippedChange {
                id: op.id.clone(),
                source: op.path.clone(),
                reason,
            });
            continue;
        }
        op.state = "done".into();
        applied.push(OpsChange {
            id: op.id.clone(),
            path: op.path.clone(),
            target: None,
            before: op.before.clone(),
            after: op.after.clone(),
        });
    }

    finish(
        store,
        &mut batch,
        applied.len(),
        skipped.len(),
        failed.len(),
    );
    Ok(OpsOutcome {
        batch,
        applied,
        skipped,
        failed,
    })
}

fn parse_attr_values(raw: &str) -> (bool, bool) {
    let value: Value = serde_json::from_str(raw).unwrap_or(Value::Null);
    (
        value
            .get("readonly")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        value
            .get("hidden")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    )
}

fn parse_attr_bool(raw: &str) -> (bool, bool) {
    parse_attr_values(raw)
}

/// 只读与隐藏一起写入；隐藏失败时回滚只读，保证条目要么全成功要么保持原状。
fn apply_attr_values(
    path: &Path,
    readonly: bool,
    hidden: bool,
    old_readonly: bool,
    old_hidden: bool,
) -> Result<(), String> {
    let native = native_path(path);
    if readonly != old_readonly {
        let meta = fs::metadata(&native).map_err(|e| format!("读取属性失败：{e}"))?;
        let mut perms = meta.permissions();
        perms.set_readonly(readonly);
        fs::set_permissions(&native, perms).map_err(|e| format!("设置只读属性失败：{e}"))?;
    }
    if hidden != old_hidden {
        #[cfg(windows)]
        {
            if let Err(err) = set_hidden(path, hidden) {
                if readonly != old_readonly {
                    if let Ok(meta) = fs::metadata(&native) {
                        let mut perms = meta.permissions();
                        perms.set_readonly(old_readonly);
                        let _ = fs::set_permissions(&native, perms);
                    }
                }
                return Err(format!("设置隐藏属性失败（已回滚只读）：{err}"));
            }
        }
        #[cfg(not(windows))]
        {
            let _ = (hidden, old_hidden);
            return Err("当前平台不支持隐藏属性（仅 Windows）".into());
        }
    }
    Ok(())
}

pub fn apply_move(
    store: &BatchStore,
    items: Vec<MoveItem>,
    spec: &MoveSpec,
) -> Result<OpsOutcome, String> {
    let batch_id = new_batch_id();
    let mut ops: Vec<BatchOp> = Vec::new();
    let mut skipped: Vec<SkippedChange> = Vec::new();
    let mut failed: Vec<SkippedChange> = Vec::new();
    let mut created: Vec<String> = Vec::new();
    let mut created_set: HashSet<String> = HashSet::new();

    for item in items {
        let source = PathBuf::from(&item.source);
        let target = PathBuf::from(&item.target);
        let change = |reason: String| SkippedChange {
            id: item.id.clone(),
            source: item.source.clone(),
            reason,
        };
        if source == target {
            let reason = "位置未变更".to_string();
            skipped.push(change(reason.clone()));
            ops.push(BatchOp {
                id: item.id.clone(),
                kind: "move".into(),
                path: item.source.clone(),
                target: Some(item.target.clone()),
                before: json!({ "path": item.source }).to_string(),
                after: json!({ "path": item.target }).to_string(),
                state: "skipped".into(),
                reason: Some(reason),
            });
            continue;
        }
        match fs::symlink_metadata(native_path(&source)) {
            Ok(_) => {}
            Err(err) => {
                let reason = format!("源文件不可访问：{err}");
                failed.push(change(reason.clone()));
                ops.push(BatchOp {
                    id: item.id.clone(),
                    kind: "move".into(),
                    path: item.source.clone(),
                    target: Some(item.target.clone()),
                    before: "{}".into(),
                    after: "{}".into(),
                    state: "failed".into(),
                    reason: Some(reason),
                });
                continue;
            }
        }
        if exists_native(&target) {
            let reason = "目标位置已存在同名文件，已跳过（移动不覆盖）".to_string();
            skipped.push(change(reason.clone()));
            ops.push(BatchOp {
                id: item.id.clone(),
                kind: "move".into(),
                path: item.source.clone(),
                target: Some(item.target.clone()),
                before: json!({ "path": item.source }).to_string(),
                after: json!({ "path": item.target }).to_string(),
                state: "skipped".into(),
                reason: Some(reason),
            });
            continue;
        }

        let parent = match target.parent() {
            Some(p) => p.to_path_buf(),
            None => {
                let reason = "目标路径无效（缺少父目录）".to_string();
                failed.push(change(reason.clone()));
                ops.push(BatchOp {
                    id: item.id.clone(),
                    kind: "move".into(),
                    path: item.source.clone(),
                    target: Some(item.target.clone()),
                    before: "{}".into(),
                    after: "{}".into(),
                    state: "failed".into(),
                    reason: Some(reason),
                });
                continue;
            }
        };
        if !exists_native(&parent) {
            if !spec.create_dirs {
                let reason = format!(
                    "目标目录不存在且未允许自动创建：{}",
                    parent.to_string_lossy()
                );
                failed.push(change(reason.clone()));
                ops.push(BatchOp {
                    id: item.id.clone(),
                    kind: "move".into(),
                    path: item.source.clone(),
                    target: Some(item.target.clone()),
                    before: "{}".into(),
                    after: "{}".into(),
                    state: "failed".into(),
                    reason: Some(reason),
                });
                continue;
            }
            for dir in missing_ancestors(&parent) {
                let text = dir.to_string_lossy().to_string();
                if created_set.insert(text.clone()) {
                    created.push(text);
                }
            }
        }

        ops.push(BatchOp {
            id: item.id.clone(),
            kind: "move".into(),
            path: item.source.clone(),
            target: Some(item.target.clone()),
            before: json!({ "path": item.source, "parent": parent.to_string_lossy() }).to_string(),
            after: json!({ "path": item.target, "parent": parent.to_string_lossy() }).to_string(),
            state: "planned".into(),
            reason: None,
        });
    }

    let mut batch = Batch {
        id: batch_id.clone(),
        created_at: now_ms(),
        finished_at: None,
        state: "pending".into(),
        kind: "move".into(),
        policy: "skip".into(),
        roots: if spec.roots.is_empty() {
            collect_roots(&ops)
        } else {
            spec.roots.clone()
        },
        counts: BatchCounts {
            total: ops.len(),
            done: 0,
            skipped: skipped.len(),
            failed: failed.len(),
        },
        items: Vec::new(),
        ops,
        created_dirs: created,
    };

    if batch.ops.is_empty() {
        batch.state = "completed".into();
        batch.finished_at = Some(now_ms());
        return Ok(OpsOutcome {
            batch,
            applied: Vec::new(),
            skipped,
            failed,
        });
    }

    store
        .save(&batch)
        .map_err(|e| format!("无法写入批次日志，已中止（未改动任何文件）：{e}"))?;

    let mut applied: Vec<OpsChange> = Vec::new();
    for (index, op) in batch.ops.iter_mut().enumerate() {
        if op.state != "planned" {
            continue;
        }
        let source = PathBuf::from(&op.path);
        let target = PathBuf::from(op.target.clone().unwrap_or_default());
        let is_dir = fs::symlink_metadata(native_path(&source))
            .map(|m| m.is_dir())
            .unwrap_or(false);
        let result = (|| -> Result<(), String> {
            if let Some(parent) = target.parent() {
                if !exists_native(parent) {
                    fs::create_dir_all(native_path(parent))
                        .map_err(|e| format!("创建目标目录失败：{e}"))?;
                }
            }
            move_path(&source, &target, spec.force_copy, &batch_id, index, is_dir)
        })();
        match result {
            Ok(()) => {
                op.state = "done".into();
                applied.push(OpsChange {
                    id: op.id.clone(),
                    path: op.path.clone(),
                    target: op.target.clone(),
                    before: op.before.clone(),
                    after: op.after.clone(),
                });
            }
            Err(reason) => {
                op.state = "failed".into();
                op.reason = Some(reason.clone());
                failed.push(SkippedChange {
                    id: op.id.clone(),
                    source: op.path.clone(),
                    reason,
                });
            }
        }
    }

    finish(
        store,
        &mut batch,
        applied.len(),
        skipped.len(),
        failed.len(),
    );
    Ok(OpsOutcome {
        batch,
        applied,
        skipped,
        failed,
    })
}

pub fn undo_ops(store: &BatchStore, id: &str) -> Result<UndoOutcome, String> {
    let mut batch = store
        .load(id)
        .map_err(|e| format!("读取批次失败：{e}"))?
        .ok_or_else(|| "批次不存在".to_string())?;
    if !batch.kind.is_empty()
        && batch.kind != "time"
        && batch.kind != "attrs"
        && batch.kind != "move"
    {
        return Err("该批次不是时间/属性/移动批次".into());
    }
    if batch.ops.is_empty() {
        return Err("该批次没有可撤销的操作".into());
    }
    if batch.state == "undone" {
        return Err("该批次已经撤销过".into());
    }

    let mut restored: Vec<AppliedChange> = Vec::new();
    let mut failed: Vec<SkippedChange> = Vec::new();
    let mut skipped_fields: Vec<SkippedField> = Vec::new();

    for op in batch.ops.iter_mut().rev() {
        if op.state != "done" {
            continue;
        }
        match op.kind.as_str() {
            "move" => {
                let Some(target) = op.target.clone() else {
                    failed.push(SkippedChange {
                        id: op.id.clone(),
                        source: op.path.clone(),
                        reason: "批次记录缺少移动目标".into(),
                    });
                    continue;
                };
                if !exists_native(&PathBuf::from(&target)) {
                    failed.push(SkippedChange {
                        id: op.id.clone(),
                        source: target,
                        reason: "移动后的文件不存在，可能已在外部被移动".into(),
                    });
                    continue;
                }
                if exists_native(&PathBuf::from(&op.path)) {
                    failed.push(SkippedChange {
                        id: op.id.clone(),
                        source: op.path.clone(),
                        reason: "原位置已被其他文件占用，无法撤销".into(),
                    });
                    continue;
                }
                let is_dir = fs::symlink_metadata(native_path(Path::new(&target)))
                    .map(|m| m.is_dir())
                    .unwrap_or(false);
                let result = move_path(
                    Path::new(&target),
                    Path::new(&op.path),
                    false,
                    &format!("undo-{id}"),
                    restored.len(),
                    is_dir,
                );
                match result {
                    Ok(()) => restored.push(AppliedChange {
                        id: op.id.clone(),
                        from: target,
                        to: op.path.clone(),
                        backup: None,
                    }),
                    Err(reason) => failed.push(SkippedChange {
                        id: op.id.clone(),
                        source: op.path.clone(),
                        reason,
                    }),
                }
            }
            "time" => {
                let (atime, mtime, creation) = parse_time_values(&op.before);
                // btime 不可写的平台（Linux）在计划阶段就标注跳过，不进入失败路径：
                // mtime / atime 照常恢复，创建时间记为「未恢复项」。
                let creation_to_write = match creation {
                    Some(_) if !crate::platform::can_write_btime() => {
                        skipped_fields.push(SkippedField {
                            field: "creation".into(),
                            path: op.path.clone(),
                            reason: crate::platform::btime_support()
                                .skip_reason()
                                .unwrap_or("当前平台不支持写回创建时间")
                                .into(),
                        });
                        None
                    }
                    other => other,
                };
                match write_times(Path::new(&op.path), atime, mtime, creation_to_write) {
                    Ok(()) => restored.push(AppliedChange {
                        id: op.id.clone(),
                        from: op.path.clone(),
                        to: op.path.clone(),
                        backup: None,
                    }),
                    Err(reason) => failed.push(SkippedChange {
                        id: op.id.clone(),
                        source: op.path.clone(),
                        reason,
                    }),
                }
            }
            "attrs" => {
                let (readonly, hidden) = parse_attr_values(&op.before);
                let (cur_readonly, cur_hidden) = fs::metadata(native_path(Path::new(&op.path)))
                    .map(|m| {
                        (
                            is_readonly(&m),
                            is_hidden(Path::new(&op.path)).unwrap_or(false),
                        )
                    })
                    .unwrap_or((readonly, hidden));
                match apply_attr_values(
                    Path::new(&op.path),
                    readonly,
                    hidden,
                    cur_readonly,
                    cur_hidden,
                ) {
                    Ok(()) => restored.push(AppliedChange {
                        id: op.id.clone(),
                        from: op.path.clone(),
                        to: op.path.clone(),
                        backup: None,
                    }),
                    Err(reason) => failed.push(SkippedChange {
                        id: op.id.clone(),
                        source: op.path.clone(),
                        reason,
                    }),
                }
            }
            other => failed.push(SkippedChange {
                id: op.id.clone(),
                source: op.path.clone(),
                reason: format!("未知操作类型：{other}"),
            }),
        }
    }

    // 撤销新建的空目录（由深到浅）
    let dirs = batch.created_dirs.clone();
    for dir in dirs.iter().rev() {
        let path = PathBuf::from(dir);
        if exists_native(&path) {
            let _ = fs::remove_dir(native_path(&path));
        }
    }

    batch.state = if failed.is_empty() {
        "undone".into()
    } else {
        "undo-partial".into()
    };
    batch.finished_at = Some(now_ms());
    store
        .save(&batch)
        .map_err(|e| format!("写入撤销日志失败：{e}"))?;
    append_undo_skip_log(store.data_dir(), &batch.id, &skipped_fields);

    Ok(UndoOutcome {
        batch,
        restored,
        failed,
        skipped_fields,
    })
}

/// 把本次撤销中被平台能力跳过的字段追加到 `<dataDir>/logs/undo.log`，不静默。
fn append_undo_skip_log(data_dir: &Path, batch_id: &str, skipped: &[SkippedField]) {
    use std::io::Write as _;
    if skipped.is_empty() {
        return;
    }
    let dir = data_dir.join("logs");
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let Ok(mut file) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("undo.log"))
    else {
        return;
    };
    for skip in skipped {
        let _ = writeln!(
            file,
            "undo\t{}\tbatch={}\tfield={}\tpath={}\treason={}",
            now_ms(),
            batch_id,
            skip.field,
            skip.path,
            skip.reason
        );
    }
}

fn finish(store: &BatchStore, batch: &mut Batch, done: usize, skipped: usize, failed: usize) {
    batch.counts.done = done;
    batch.counts.skipped = skipped;
    batch.counts.failed = failed;
    batch.finished_at = Some(now_ms());
    batch.state = if failed == 0 {
        "completed".into()
    } else {
        "partial".into()
    };
    let _ = store.save(batch);
}

fn collect_roots(ops: &[BatchOp]) -> Vec<String> {
    let mut roots: Vec<String> = Vec::new();
    for op in ops {
        if let Some(parent) = Path::new(&op.path).parent() {
            let text = parent.to_string_lossy().to_string();
            if !roots.contains(&text) {
                roots.push(text);
            }
        }
    }
    roots
}

fn exists_native(path: &Path) -> bool {
    native_path(path).exists()
}

fn rename_native(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::rename(native_path(from), native_path(to))
}

fn is_cross_device(err: &std::io::Error) -> bool {
    matches!(err.raw_os_error(), Some(17) | Some(18))
}

fn remove_path(path: &Path) -> std::io::Result<()> {
    let native = native_path(path);
    if !native.exists() {
        return Ok(());
    }
    if fs::symlink_metadata(&native)
        .map(|m| m.is_dir())
        .unwrap_or(false)
    {
        fs::remove_dir_all(&native)
    } else {
        fs::remove_file(&native)
    }
}

fn missing_ancestors(dir: &Path) -> Vec<PathBuf> {
    let mut chain: Vec<PathBuf> = Vec::new();
    let mut current = Some(dir.to_path_buf());
    while let Some(path) = current {
        if path.as_os_str().is_empty() || exists_native(&path) {
            break;
        }
        chain.push(path.clone());
        current = path.parent().map(Path::to_path_buf);
    }
    chain.reverse();
    chain
}

fn free_temp(parent: &Path, tag: &str, index: usize) -> PathBuf {
    for attempt in 0..1000u32 {
        let candidate = parent.join(format!(".ffrn-move-{tag}-{index}-{attempt}.tmp"));
        if !exists_native(&candidate) {
            return candidate;
        }
    }
    parent.join(format!(".ffrn-move-{tag}-{index}-fallback.tmp"))
}

fn copy_dir_all(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(native_path(to))?;
    for entry in fs::read_dir(native_path(from))? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        // 符号链接 / 目录联接可能指向目录外，跨盘复制时不做跟随，避免复制不完整或递归
        if file_type.is_symlink() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Unsupported,
                "目录中包含符号链接或联接，跨盘移动暂不支持",
            ));
        }
        let src = entry.path();
        let dest = native_path(to).join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_all(&src, &dest)?;
        } else {
            fs::copy(&src, &dest)?;
        }
    }
    Ok(())
}

fn compare_files(a: &Path, b: &Path) -> Result<(), String> {
    let na = native_path(a);
    let nb = native_path(b);
    let len_a = fs::metadata(&na)
        .map_err(|e| format!("读取副本信息失败：{e}"))?
        .len();
    let len_b = fs::metadata(&nb)
        .map_err(|e| format!("读取副本信息失败：{e}"))?
        .len();
    if len_a != len_b {
        return Err(format!("大小不一致（{len_a} vs {len_b}）"));
    }
    let mut fa = fs::File::open(&na).map_err(|e| format!("打开源文件失败：{e}"))?;
    let mut fb = fs::File::open(&nb).map_err(|e| format!("打开副本失败：{e}"))?;
    let mut buf_a = vec![0u8; 64 * 1024];
    let mut buf_b = vec![0u8; 64 * 1024];
    loop {
        let read_a = fa
            .read(&mut buf_a)
            .map_err(|e| format!("读取源文件失败：{e}"))?;
        let read_b = fb
            .read(&mut buf_b)
            .map_err(|e| format!("读取副本失败：{e}"))?;
        if read_a != read_b {
            return Err("读取长度不一致".into());
        }
        if read_a == 0 {
            break;
        }
        if buf_a[..read_a] != buf_b[..read_b] {
            return Err("内容不一致".into());
        }
    }
    Ok(())
}

fn verify_copy(from: &Path, temp: &Path, is_dir: bool) -> Result<(), String> {
    if !is_dir {
        return compare_files(from, temp);
    }
    let src_dir = native_path(from);
    let dst_dir = native_path(temp);
    let src_entries = fs::read_dir(&src_dir).map_err(|e| format!("读取源目录失败：{e}"))?;
    let mut count = 0usize;
    for entry in src_entries {
        let entry = entry.map_err(|e| format!("读取源目录项失败：{e}"))?;
        let name = entry.file_name();
        let src = src_dir.join(&name);
        let dst = dst_dir.join(&name);
        if !dst.exists() {
            return Err(format!("目录副本缺少 {} ", name.to_string_lossy()));
        }
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            verify_copy(&src, &dst, true)?;
        } else {
            compare_files(&src, &dst)?;
        }
        count += 1;
    }
    let copied = fs::read_dir(&dst_dir)
        .map_err(|e| format!("读取副本目录失败：{e}"))?
        .count();
    if copied != count {
        return Err(format!("目录项数量不一致（{count} vs {copied}）"));
    }
    Ok(())
}

/// 移动一个文件/目录：同盘 rename；跨盘或 force_copy 时复制 → 校验 → 删除源。
fn move_path(
    from: &Path,
    to: &Path,
    force_copy: bool,
    batch_tag: &str,
    index: usize,
    is_dir: bool,
) -> Result<(), String> {
    if !force_copy {
        match rename_native(from, to) {
            Ok(()) => return Ok(()),
            Err(err) => {
                if !is_cross_device(&err) {
                    return Err(format!("移动失败：{err}"));
                }
            }
        }
    }

    let parent = to.parent().ok_or_else(|| "目标路径无效".to_string())?;
    let temp = free_temp(parent, batch_tag, index);
    let copied = if is_dir {
        copy_dir_all(from, &temp).map_err(|e| format!("复制目录失败：{e}"))
    } else {
        fs::copy(native_path(from), native_path(&temp))
            .map(|_| ())
            .map_err(|e| format!("复制文件失败：{e}"))
    };
    if let Err(err) = copied {
        let _ = remove_path(&temp);
        return Err(format!("{err}；源文件未改动"));
    }
    if let Err(err) = verify_copy(from, &temp, is_dir) {
        let _ = remove_path(&temp);
        return Err(format!("复制校验失败（{err}），已删除副本，源文件未改动"));
    }
    if let Err(err) = rename_native(&temp, to) {
        let _ = remove_path(&temp);
        return Err(format!("副本落位失败：{err}；源文件未改动"));
    }
    if let Err(err) = remove_path(from) {
        if is_dir {
            // 目录删除可能部分完成，此时删除副本才是真正的数据丢失；保留副本并明确告警
            return Err(format!(
                "源目录删除未完成（{err}）；已保留完整副本：{}，请先确认副本再手动清理源目录",
                to.display()
            ));
        }
        return match remove_path(to) {
            Ok(()) => Err(format!("删除源文件失败（{err}），已删除副本、源文件保留")),
            Err(rollback) => Err(format!(
                "删除源文件失败（{err}），且副本回滚失败（{rollback}）；源与副本同时存在，请手动检查"
            )),
        };
    }
    Ok(())
}

#[cfg(windows)]
fn is_hidden(path: &Path) -> std::io::Result<bool> {
    use std::os::windows::ffi::OsStrExt;
    const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
    extern "system" {
        fn GetFileAttributesW(name: *const u16) -> u32;
    }
    let native = native_path(path);
    let wide: Vec<u16> = native.as_os_str().encode_wide().chain(Some(0)).collect();
    let attrs = unsafe { GetFileAttributesW(wide.as_ptr()) };
    if attrs == u32::MAX {
        return Err(std::io::Error::last_os_error());
    }
    Ok(attrs & FILE_ATTRIBUTE_HIDDEN != 0)
}

#[cfg(not(windows))]
fn is_hidden(_path: &Path) -> std::io::Result<bool> {
    Ok(false)
}

#[cfg(windows)]
fn set_hidden(path: &Path, hidden: bool) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
    extern "system" {
        fn GetFileAttributesW(name: *const u16) -> u32;
        fn SetFileAttributesW(name: *const u16, attrs: u32) -> i32;
    }
    let native = native_path(path);
    let wide: Vec<u16> = native.as_os_str().encode_wide().chain(Some(0)).collect();
    let old = unsafe { GetFileAttributesW(wide.as_ptr()) };
    if old == u32::MAX {
        return Err(std::io::Error::last_os_error());
    }
    let next = if hidden {
        old | FILE_ATTRIBUTE_HIDDEN
    } else {
        old & !FILE_ATTRIBUTE_HIDDEN
    };
    if unsafe { SetFileAttributesW(wide.as_ptr(), next) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(windows))]
fn set_hidden(_path: &Path, _hidden: bool) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "当前平台不支持隐藏属性",
    ))
}

#[cfg(windows)]
fn set_creation_time(path: &Path, when: SystemTime) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    type Handle = *mut core::ffi::c_void;

    #[repr(C)]
    struct FileTime {
        low: u32,
        high: u32,
    }

    extern "system" {
        fn CreateFileW(
            name: *const u16,
            access: u32,
            share: u32,
            security: *mut core::ffi::c_void,
            disposition: u32,
            flags: u32,
            template: Handle,
        ) -> Handle;
        fn SetFileTime(
            handle: Handle,
            creation: *const FileTime,
            access: *const FileTime,
            written: *const FileTime,
        ) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
    }

    const FILE_WRITE_ATTRIBUTES: u32 = 0x0100;
    const FILE_SHARE_ALL: u32 = 0x1 | 0x2 | 0x4;
    const OPEN_EXISTING: u32 = 3;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;

    let native = native_path(path);
    let wide: Vec<u16> = native.as_os_str().encode_wide().chain(Some(0)).collect();
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            FILE_WRITE_ATTRIBUTES,
            FILE_SHARE_ALL,
            std::ptr::null_mut(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            std::ptr::null_mut(),
        )
    };
    if handle == (-1isize) as Handle {
        return Err(std::io::Error::last_os_error());
    }
    let ms = from_system(when).unwrap_or(0) as i128;
    let ticks = ms * 10_000 + 116_444_736_000_000_000i128;
    let ft = FileTime {
        low: (ticks & 0xFFFF_FFFF) as u32,
        high: (ticks >> 32) as u32,
    };
    let ok = unsafe { SetFileTime(handle, &ft, std::ptr::null(), std::ptr::null()) };
    let err = std::io::Error::last_os_error();
    unsafe { CloseHandle(handle) };
    if ok == 0 {
        return Err(err);
    }
    Ok(())
}

#[cfg(test)]
mod undo_log_tests {
    use super::*;

    /// 撤销跳过日志的写入语义：两平台都跑（Windows 上 btime 可写，端到端不会产生跳过项，这里直接验证写入器）。
    #[test]
    fn undo_skip_log_appends_with_parseable_ts() {
        let dir = std::env::temp_dir().join("ffrn-core-undo-log-unit");
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::create_dir_all(&dir);

        let skip = SkippedField {
            field: "creation".into(),
            path: "files/photo.jpg".into(),
            reason: crate::platform::btime_support()
                .skip_reason()
                .unwrap_or("创建时间（btime）在当前平台不支持写回，撤销时已跳过该字段")
                .into(),
        };
        append_undo_skip_log(&dir, "b-001", std::slice::from_ref(&skip));
        append_undo_skip_log(&dir, "b-002", std::slice::from_ref(&skip));

        let log = fs::read_to_string(dir.join("logs").join("undo.log")).unwrap();
        let lines: Vec<&str> = log.lines().collect();
        assert_eq!(lines.len(), 2, "日志必须追加而不是覆盖：{log}");

        for line in &lines {
            let cols: Vec<&str> = line.split('\t').collect();
            assert_eq!(cols.len(), 6, "字段数不对：{line}");
            assert_eq!(cols[0], "undo");
            let ts: i64 = cols[1].parse().expect("时间戳必须是整数毫秒");
            assert!(ts > 1_500_000_000_000, "时间戳不可解析或明显异常：{ts}");
            assert!(cols[2].starts_with("batch="), "{line}");
            assert_eq!(cols[3], "field=creation");
            assert!(cols[4].starts_with("path="), "{line}");
            assert!(cols[5].starts_with("reason="), "{line}");
            // 只允许路径/原因等元数据，不得出现文件内容或 JSON 片段
            assert!(!line.contains("CONTENT_SHOULD_NOT_LEAK"), "{line}");
            assert!(!line.contains('{') && !line.contains('}'), "{line}");
        }
        assert!(lines[0].contains("batch=b-001"), "{}", lines[0]);
        assert!(lines[1].contains("batch=b-002"), "{}", lines[1]);
    }
}

//! 快照：记录「当前名 → 计划新名」映射，之后可按原名还原。
//!
//! 默认只存名称 + 大小 + 修改时间（轻量）；勾选时才逐条算 SHA-256。
//! 还原严格「只改回原名」：目标名已存在、文件已变化、路径非法一律跳过，绝不覆盖。

use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::journal::{new_batch_id, now_ms, Batch, BatchStore};
use crate::metaedit::util::Sha256;
use crate::platform::{native_path, Platform};
use crate::rename::{self, AppliedChange, ApplyItem, ApplyOptions, SkippedChange};

pub const SCHEMA: &str = "renomio-snapshot/v1";

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotInput {
    pub from: String,
    pub to: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotEntry {
    /// 快照时的原名（还原目标）
    pub from: String,
    /// 快照时的计划新名（还原起点）
    pub to: String,
    pub size: u64,
    pub mtime_ms: i64,
    pub is_dir: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub schema: String,
    pub id: String,
    pub created_at: i64,
    pub roots: Vec<String>,
    /// 纳入的条目数
    pub entry_count: usize,
    /// 实际带 SHA-256 的条目数
    pub hashed: usize,
    /// 因跨目录 / 路径非法而未纳入的条目数
    pub skipped: usize,
    pub entries: Vec<SnapshotEntry>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotSummary {
    pub id: String,
    pub created_at: i64,
    pub entry_count: usize,
    pub hashed: usize,
    pub skipped: usize,
    pub roots: Vec<String>,
}

/// 还原预览行：`action = restore | skip`，`reason_code` 供前端翻译。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestorePlanItem {
    pub id: String,
    pub from: String,
    pub to: String,
    pub is_dir: bool,
    pub action: String,
    pub reason_code: Option<String>,
    pub reason: Option<String>,
    pub hash_check: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreOutcome {
    /// 没有任何可还原条目时为 None（不写空批次日志）
    pub batch: Option<Batch>,
    pub restored: Vec<AppliedChange>,
    pub skipped: Vec<SkippedChange>,
    pub failed: Vec<SkippedChange>,
    pub hash_checked: usize,
}

fn snapshots_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("snapshots")
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() < 120
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn path_exists(path: &str) -> bool {
    fs::symlink_metadata(native_path(Path::new(path))).is_ok()
}

fn mtime_ms(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn same_file(a: &str, b: &str) -> bool {
    match (
        fs::canonicalize(native_path(Path::new(a))),
        fs::canonicalize(native_path(Path::new(b))),
    ) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    }
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// 流式 SHA-256；每块检查一次取消。
fn sha256_of(path: &str, cancel: &dyn Fn() -> bool) -> Result<String, String> {
    let native = native_path(Path::new(path));
    let mut file = File::open(&native).map_err(|e| format!("无法打开文件：{e}"))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        if cancel() {
            return Err("已取消".into());
        }
        let n = file.read(&mut buf).map_err(|e| format!("读取文件失败：{e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex(&hasher.finish()))
}

fn save_snapshot(dir: &Path, snap: &Snapshot) -> Result<(), String> {
    fs::create_dir_all(native_path(dir)).map_err(|e| format!("无法创建快照目录：{e}"))?;
    let dest = dir.join(format!("{}.json", snap.id));
    let tmp = dir.join(format!("{}.json.tmp", snap.id));
    let json = serde_json::to_vec_pretty(snap).map_err(|e| format!("无法序列化快照：{e}"))?;
    {
        let mut file = File::create(native_path(&tmp)).map_err(|e| format!("无法写入快照：{e}"))?;
        file.write_all(&json).map_err(|e| format!("无法写入快照：{e}"))?;
        file.sync_all().map_err(|e| format!("无法写入快照：{e}"))?;
    }
    let dest_native = native_path(&dest);
    if dest_native.exists() {
        let _ = fs::remove_file(&dest_native);
    }
    fs::rename(native_path(&tmp), &dest_native).map_err(|e| format!("无法保存快照：{e}"))?;
    Ok(())
}

/// 生成快照。`on_progress(已处理, 总数, 当前路径)`，`is_cancelled` 在每个条目前检查。
pub fn create(
    data_dir: &Path,
    roots: Vec<String>,
    inputs: Vec<SnapshotInput>,
    with_hash: bool,
    on_progress: &mut dyn FnMut(usize, usize, &str),
    is_cancelled: &dyn Fn() -> bool,
) -> Result<(Snapshot, usize), String> {
    let total = inputs.len();
    let mut seen = std::collections::HashSet::new();
    let mut entries: Vec<SnapshotEntry> = Vec::new();
    let mut skipped = 0usize;

    for (index, input) in inputs.iter().enumerate() {
        if is_cancelled() {
            return Err("已取消".into());
        }
        on_progress(index, total, &input.from);

        // 同一文件重复出现（列表里有重复项）只记一次
        let key = input.from.to_lowercase();
        if !seen.insert(key) {
            skipped += 1;
            continue;
        }
        if input.from.trim().is_empty() || input.to.trim().is_empty() {
            skipped += 1;
            continue;
        }
        // 快照只承载「同目录改名」；跨目录 / 移动类不纳入
        let from_parent = Path::new(&input.from).parent().map(|p| p.to_path_buf());
        let to_parent = Path::new(&input.to).parent().map(|p| p.to_path_buf());
        if from_parent != to_parent {
            skipped += 1;
            continue;
        }
        if input.from == input.to {
            skipped += 1;
            continue;
        }
        let meta = match fs::symlink_metadata(native_path(Path::new(&input.from))) {
            Ok(meta) => meta,
            Err(_) => {
                skipped += 1;
                continue;
            }
        };
        let is_dir = meta.is_dir();
        let sha256 = if with_hash && !is_dir {
            Some(sha256_of(&input.from, is_cancelled)?)
        } else {
            None
        };
        entries.push(SnapshotEntry {
            from: input.from.clone(),
            to: input.to.clone(),
            size: meta.len(),
            mtime_ms: mtime_ms(&meta),
            is_dir,
            sha256,
        });
    }

    on_progress(total, total, "");
    let hashed = entries.iter().filter(|e| e.sha256.is_some()).count();
    let snap = Snapshot {
        schema: SCHEMA.into(),
        id: format!("snap-{}", new_batch_id()),
        created_at: now_ms(),
        roots,
        entry_count: entries.len(),
        hashed,
        skipped,
        entries,
    };
    save_snapshot(&snapshots_dir(data_dir), &snap)?;
    Ok((snap, skipped))
}

pub fn list(data_dir: &Path) -> Vec<SnapshotSummary> {
    let dir = snapshots_dir(data_dir);
    let Ok(read) = fs::read_dir(native_path(&dir)) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in read.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(snap) = serde_json::from_str::<Snapshot>(&raw) else {
            continue;
        };
        out.push(SnapshotSummary {
            id: snap.id,
            created_at: snap.created_at,
            entry_count: snap.entry_count,
            hashed: snap.hashed,
            skipped: snap.skipped,
            roots: snap.roots,
        });
    }
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    out
}

pub fn load(data_dir: &Path, id: &str) -> Option<Snapshot> {
    if !valid_id(id) {
        return None;
    }
    let path = snapshots_dir(data_dir).join(format!("{id}.json"));
    let raw = fs::read_to_string(native_path(&path)).ok()?;
    let snap = serde_json::from_str::<Snapshot>(&raw).ok()?;
    if snap.schema != SCHEMA {
        return None;
    }
    Some(snap)
}

pub fn remove(data_dir: &Path, id: &str) -> Result<(), String> {
    if !valid_id(id) {
        return Err("非法快照 ID".into());
    }
    let path = snapshots_dir(data_dir).join(format!("{id}.json"));
    if !path_exists(path.to_string_lossy().as_ref()) {
        return Ok(());
    }
    fs::remove_file(native_path(&path)).map_err(|e| format!("删除快照失败：{e}"))
}

/// 预览：只做存在性与大小/时间比对（读盘量小，不阻塞）。
pub fn plan(snap: &Snapshot) -> Vec<RestorePlanItem> {
    snap.entries
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            let id = index.to_string();
            let skip = |code: &str, reason: &str| RestorePlanItem {
                id: id.clone(),
                from: entry.from.clone(),
                to: entry.to.clone(),
                is_dir: entry.is_dir,
                action: "skip".into(),
                reason_code: Some(code.into()),
                reason: Some(reason.into()),
                hash_check: false,
            };
            if Path::new(&entry.from).parent() != Path::new(&entry.to).parent() {
                return skip("bad-path", "快照中的路径非法（不在同一目录）");
            }
            let to_exists = path_exists(&entry.to);
            let from_exists = path_exists(&entry.from);
            if !to_exists {
                return if from_exists {
                    skip("already-original", "文件已在原名，无需还原")
                } else {
                    skip("missing", "文件不存在（可能已被移动或删除）")
                };
            }
            if from_exists && !same_file(&entry.from, &entry.to) {
                return skip("occupied", "原位置已被其他文件占用");
            }
            if entry.from == entry.to {
                return skip("already-original", "文件已在原名，无需还原");
            }
            let meta = match fs::symlink_metadata(native_path(Path::new(&entry.to))) {
                Ok(meta) => meta,
                Err(err) => return skip("missing", &format!("无法读取文件信息：{err}")),
            };
            let is_dir = meta.is_dir();
            if is_dir != entry.is_dir {
                return skip("changed", "文件类型已变化（文件/目录不符）");
            }
            let hash_check = entry.sha256.is_some() && !is_dir;
            if !hash_check {
                if meta.len() != entry.size || mtime_ms(&meta) != entry.mtime_ms {
                    return skip("changed", "文件已变化（大小或修改时间不符）");
                }
            }
            RestorePlanItem {
                id,
                from: entry.from.clone(),
                to: entry.to.clone(),
                is_dir,
                action: "restore".into(),
                reason_code: None,
                reason: None,
                hash_check,
            }
        })
        .collect()
}

/// 执行前校验哈希；只读、逐条可取消。
fn prepare(
    snap: &Snapshot,
    items: &[RestorePlanItem],
    on_progress: &mut dyn FnMut(&str, usize, usize, &str),
    is_cancelled: &dyn Fn() -> bool,
) -> Result<(Vec<ApplyItem>, Vec<SkippedChange>, usize), String> {
    let restorable: Vec<&RestorePlanItem> = items
        .iter()
        .filter(|i| i.action == "restore")
        .collect();
    let total = restorable.len();
    let mut apply_items = Vec::new();
    let mut skipped = Vec::new();
    let mut checked = 0usize;

    for (index, item) in restorable.iter().enumerate() {
        if is_cancelled() {
            return Err("已取消".into());
        }
        on_progress("verify", index, total, &item.to);
        if item.hash_check {
            let entry = snap
                .entries
                .get(item.id.parse::<usize>().unwrap_or(usize::MAX))
                .ok_or_else(|| "快照条目索引越界".to_string())?;
            checked += 1;
            let actual = sha256_of(&item.to, is_cancelled)?;
            if entry.sha256.as_deref() != Some(actual.as_str()) {
                skipped.push(SkippedChange {
                    id: item.id.clone(),
                    source: item.to.clone(),
                    reason: "文件内容已变化（SHA-256 不符）".into(),
                });
                continue;
            }
        }
        let target_name = Path::new(&item.from)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        apply_items.push(ApplyItem {
            id: item.id.clone(),
            source: item.to.clone(),
            target_name,
            is_dir: item.is_dir,
        });
    }
    Ok((apply_items, skipped, checked))
}

/// 还原：先校验/过滤，再用既有两阶段改名（policy=skip，绝不覆盖），
/// 最后把批次 kind 记为 `restore` 并落盘，因此还原本身也能撤销。
pub fn restore(
    store: &BatchStore,
    platform: Platform,
    snap: &Snapshot,
    on_progress: &mut dyn FnMut(&str, usize, usize, &str),
    is_cancelled: &dyn Fn() -> bool,
) -> Result<RestoreOutcome, String> {
    let preview = plan(snap);
    let mut skipped: Vec<SkippedChange> = preview
        .iter()
        .filter(|i| i.action == "skip")
        .map(|i| SkippedChange {
            id: i.id.clone(),
            source: i.to.clone(),
            reason: i.reason.clone().unwrap_or_default(),
        })
        .collect();

    let (items, hash_skipped, hash_checked) =
        prepare(snap, &preview, on_progress, is_cancelled)?;
    skipped.extend(hash_skipped);

    if items.is_empty() {
        return Ok(RestoreOutcome {
            batch: None,
            restored: Vec::new(),
            skipped,
            failed: Vec::new(),
            hash_checked,
        });
    }

    let opts = ApplyOptions {
        policy: "skip".into(),
        skip_readonly: false,
        windows_safe: true,
        roots: snap.roots.clone(),
        label: Some("restore".into()),
    };
    let outcome = rename::apply_with_hooks(store, platform, items, &opts, on_progress, is_cancelled)?;

    let mut batch = outcome.batch;
    batch.kind = "restore".into();
    batch.policy = "skip".into();
    store
        .save(&batch)
        .map_err(|e| format!("无法更新批次日志：{e}"))?;

    skipped.extend(outcome.skipped);
    Ok(RestoreOutcome {
        batch: Some(batch),
        restored: outcome.applied,
        skipped,
        failed: outcome.failed,
        hash_checked,
    })
}

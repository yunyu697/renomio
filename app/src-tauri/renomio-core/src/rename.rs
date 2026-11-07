//! 两阶段改名与批次撤销。
//!
//! 安全约束：
//! 1. 先把计划写入日志并 fsync，再动文件；
//! 2. 所有改名都经过唯一临时名，支持交换与"仅改大小写"；
//! 3. 冲突默认不覆盖；选择覆盖时必须先把原目标移入批次备份目录，撤销时还原；
//! 4. 撤销逐条反向执行，日志持久化，重启后仍可用。

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use crate::journal::{new_batch_id, now_ms, Batch, BatchCounts, BatchItem, BatchStore};
use crate::platform::{
    is_readonly, native_path, path_length_issue, validate_component, NamePolicy, Platform,
};

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyItem {
    pub id: String,
    pub source: String,
    pub target_name: String,
    #[serde(default)]
    pub is_dir: bool,
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ApplyOptions {
    /// overwrite / skip / suffix
    pub policy: String,
    pub skip_readonly: bool,
    pub windows_safe: bool,
    pub roots: Vec<String>,
    pub label: Option<String>,
}

impl Default for ApplyOptions {
    fn default() -> Self {
        Self {
            policy: "skip".into(),
            skip_readonly: false,
            windows_safe: true,
            roots: Vec::new(),
            label: None,
        }
    }
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppliedChange {
    pub id: String,
    pub from: String,
    pub to: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup: Option<String>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedChange {
    pub id: String,
    pub source: String,
    pub reason: String,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyOutcome {
    pub batch: Batch,
    pub applied: Vec<AppliedChange>,
    pub skipped: Vec<SkippedChange>,
    pub failed: Vec<SkippedChange>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoOutcome {
    pub batch: Batch,
    pub restored: Vec<AppliedChange>,
    pub failed: Vec<SkippedChange>,
    /// 本次撤销因平台能力缺失而主动跳过的字段（不会计入 failed）
    #[serde(default)]
    pub skipped_fields: Vec<SkippedField>,
}

/// 撤销时被跳过的字段，例如 Linux 上无法写回的 btime（创建时间）。
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedField {
    /// 字段名：creation / mtime / atime
    pub field: String,
    pub path: String,
    pub reason: String,
}

fn rename_native(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::rename(native_path(from), native_path(to))
}

/// 判断目录项是否存在：用 symlink_metadata 而不是 `exists()`，
/// 这样断链的符号链接也会被当作「已存在」，避免 rename 撞上无法覆盖的目录项。
fn exists_native(path: &Path) -> bool {
    fs::symlink_metadata(native_path(path)).is_ok()
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (
        fs::canonicalize(native_path(a)),
        fs::canonicalize(native_path(b)),
    ) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    }
}

fn parent_of(path: &Path) -> PathBuf {
    path.parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn split_name(name: &str) -> (String, String) {
    match name.rfind('.') {
        Some(idx) if idx > 0 && idx + 1 < name.len() => {
            (name[..idx].to_string(), name[idx + 1..].to_string())
        }
        Some(idx) if idx > 0 => (name[..idx].to_string(), String::new()),
        _ => (name.to_string(), String::new()),
    }
}

fn free_temp_path(dir: &Path, batch_id: &str, index: usize, is_dir: bool) -> PathBuf {
    let suffix = if is_dir { "" } else { ".tmp" };
    for attempt in 0..1000u32 {
        let candidate = dir.join(format!(".renomio-{batch_id}-{index}-{attempt}{suffix}"));
        if !exists_native(&candidate) {
            return candidate;
        }
    }
    dir.join(format!(".renomio-{batch_id}-{index}-fallback.tmp"))
}

fn suffix_candidate(name: &str, attempt: usize, is_dir: bool) -> String {
    if is_dir {
        return format!("{name} ({attempt})");
    }
    let (stem, ext) = split_name(name);
    if ext.is_empty() {
        format!("{stem} ({attempt})")
    } else {
        format!("{stem} ({attempt}).{ext}")
    }
}

/// 把仍处于 `staged`（文件停在临时名）的条目回退到原名，用于取消时的安全收尾。
fn rollback_staged(batch: &mut Batch) {
    for item in batch.items.iter_mut() {
        if item.state == "staged" {
            let _ = rename_native(Path::new(&item.temp), Path::new(&item.from));
            item.state = "planned".into();
        }
    }
}

fn backup_path(store: &BatchStore, batch_id: &str, index: usize, name: &str) -> PathBuf {
    let dir = store.backup_dir(batch_id);
    let _ = fs::create_dir_all(native_path(&dir));
    let safe_name: String = name.chars().take(80).collect();
    dir.join(format!("{index:04}-{safe_name}"))
}

pub fn apply(
    store: &BatchStore,
    platform: Platform,
    items: Vec<ApplyItem>,
    opts: &ApplyOptions,
) -> Result<ApplyOutcome, String> {
    apply_with_hooks(
        store,
        platform,
        items,
        opts,
        &mut |_phase, _done, _total, _current| {},
        &|| false,
    )
}

/// 带进度回调与取消检查的批量改名。
///
/// 取消只在条目边界生效：已完成的条目不回退，仍在临时名的条目会先回退到原名，
/// 批次状态记为 `cancelled`，不会留下悬挂的临时文件。
pub fn apply_with_hooks(
    store: &BatchStore,
    platform: Platform,
    items: Vec<ApplyItem>,
    opts: &ApplyOptions,
    on_progress: &mut dyn FnMut(&str, usize, usize, &str),
    is_cancelled: &dyn Fn() -> bool,
) -> Result<ApplyOutcome, String> {
    let policy = match opts.policy.as_str() {
        "overwrite" | "skip" | "suffix" => opts.policy.clone(),
        _ => "skip".to_string(),
    };
    let name_policy = NamePolicy::new(platform, opts.windows_safe);
    let batch_id = new_batch_id();

    let mut skipped: Vec<SkippedChange> = Vec::new();
    let mut failed: Vec<SkippedChange> = Vec::new();
    let mut work: Vec<(ApplyItem, PathBuf, PathBuf, String)> = Vec::new();

    for item in items {
        let source = PathBuf::from(&item.source);
        let meta = match fs::symlink_metadata(native_path(&source)) {
            Ok(m) => m,
            Err(err) => {
                failed.push(SkippedChange {
                    id: item.id,
                    source: item.source,
                    reason: format!("源文件不可访问：{err}"),
                });
                continue;
            }
        };

        if item.target_name.trim().is_empty() {
            failed.push(SkippedChange {
                id: item.id,
                source: item.source,
                reason: "目标名称为空".into(),
            });
            continue;
        }

        let mut issues = validate_component(&item.target_name, name_policy);
        let target = parent_of(&source).join(&item.target_name);
        if let Some(issue) = path_length_issue(&target, name_policy) {
            if issue.severity == "block" {
                issues.push(issue);
            }
        }
        if let Some(issue) = issues.into_iter().find(|i| i.severity == "block") {
            failed.push(SkippedChange {
                id: item.id,
                source: item.source,
                reason: issue.message,
            });
            continue;
        }

        let current_name = source
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        // 只跳过大小写完全一致的名称；仅大小写变化（Windows / macOS）不能在这里拦下，
        // 否则「Report.txt → REPORT.txt」会被当成未变更。此类改名会经由唯一临时名两步完成。
        if current_name == item.target_name {
            skipped.push(SkippedChange {
                id: item.id,
                source: item.source,
                reason: "名称未变更".into(),
            });
            continue;
        }

        if opts.skip_readonly && is_readonly(&meta) {
            skipped.push(SkippedChange {
                id: item.id,
                source: item.source,
                reason: "文件为只读，按设置跳过".into(),
            });
            continue;
        }

        work.push((item, source, target, current_name));
    }

    let mut entries: Vec<BatchItem> = Vec::new();
    let mut staged: HashSet<String> = HashSet::new();

    for (index, (item, source, target, _current)) in work.iter().enumerate() {
        let is_dir = fs::symlink_metadata(native_path(source))
            .map(|m| m.is_dir())
            .unwrap_or(item.is_dir);
        let temp = free_temp_path(&parent_of(source), &batch_id, index, is_dir);
        entries.push(BatchItem {
            id: item.id.clone(),
            from: source.to_string_lossy().to_string(),
            to: target.to_string_lossy().to_string(),
            temp: temp.to_string_lossy().to_string(),
            is_dir,
            state: "planned".into(),
            reason: None,
            backup: None,
        });
        staged.insert(item.id.clone());
    }

    let mut batch = Batch {
        id: batch_id.clone(),
        created_at: now_ms(),
        finished_at: None,
        state: "pending".into(),
        kind: "rename".into(),
        policy,
        roots: opts.roots.clone(),
        counts: BatchCounts {
            total: entries.len(),
            done: 0,
            skipped: skipped.len(),
            failed: failed.len(),
        },
        items: entries,
        ops: Vec::new(),
        created_dirs: Vec::new(),
    };

    if batch.items.is_empty() {
        batch.state = "completed".into();
        batch.finished_at = Some(now_ms());
        return Ok(ApplyOutcome {
            batch,
            applied: Vec::new(),
            skipped,
            failed,
        });
    }

    // 先落盘再动文件
    store
        .save(&batch)
        .map_err(|e| format!("无法写入批次日志，已中止（未改动任何文件）：{e}"))?;

    let stage_total = batch
        .items
        .iter()
        .filter(|i| staged.contains(&i.id))
        .count();
    on_progress("prepare", 0, stage_total, "");

    // 阶段 A：全部源移入临时名
    let mut processed_stage = 0usize;
    let mut cancelled = false;
    for item in batch.items.iter_mut() {
        if !staged.contains(&item.id) {
            continue;
        }
        if is_cancelled() {
            cancelled = true;
            break;
        }
        let current = Path::new(&item.from)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        match rename_native(Path::new(&item.from), Path::new(&item.temp)) {
            Ok(()) => item.state = "staged".into(),
            Err(err) => {
                item.state = "failed".into();
                item.reason = Some(format!("移动到临时名失败：{err}"));
                failed.push(SkippedChange {
                    id: item.id.clone(),
                    source: item.from.clone(),
                    reason: item.reason.clone().unwrap_or_default(),
                });
                staged.remove(&item.id);
            }
        }
        processed_stage += 1;
        on_progress("stage", processed_stage, stage_total, &current);
    }

    if cancelled {
        // 取消发生在阶段 A：把所有已移入临时名的条目回退到原名，不留悬挂临时文件
        rollback_staged(&mut batch);
        batch.counts.done = 0;
        batch.counts.skipped = skipped.len();
        batch.counts.failed = failed.len();
        batch.finished_at = Some(now_ms());
        batch.state = "cancelled".into();
        let _ = store.save(&batch);
        on_progress("cancelled", processed_stage, stage_total, "");
        return Ok(ApplyOutcome {
            batch,
            applied: Vec::new(),
            skipped,
            failed,
        });
    }

    // 阶段 B：临时名落到目标（逐项解决冲突）
    let mut applied: Vec<AppliedChange> = Vec::new();
    // 批次内多个项目可能指向同一目标；即使选择“覆盖”，也要拒绝后来的项目，
    // 否则会形成“备份被新输出覆盖”的链式覆盖，撤销无法还原任何一份数据。
    let mut claimed: HashSet<String> = HashSet::new();
    let target_key = |path: &Path| -> String {
        let raw = path.to_string_lossy().to_string();
        if platform == Platform::Linux {
            raw
        } else {
            raw.to_lowercase()
        }
    };
    let apply_total = batch.items.iter().filter(|i| i.state == "staged").count();
    let mut processed_apply = 0usize;
    let mut index = 0usize;
    for item in batch.items.iter_mut() {
        if item.state != "staged" {
            index += 1;
            continue;
        }
        if is_cancelled() {
            cancelled = true;
            break;
        }
        let current = Path::new(&item.to)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        on_progress("apply", processed_apply, apply_total, &current);
        processed_apply += 1;
        let temp = PathBuf::from(&item.temp);
        let from = PathBuf::from(&item.from);
        let mut target = PathBuf::from(&item.to);

        if claimed.contains(&target_key(&target)) {
            item.state = "skipped".into();
            item.reason = Some("批次内多个项目指向同一目标，已跳过以避免覆盖".into());
            skipped.push(SkippedChange {
                id: item.id.clone(),
                source: item.from.clone(),
                reason: item.reason.clone().unwrap_or_default(),
            });
            let _ = rename_native(&temp, &from);
            index += 1;
            continue;
        }

        if exists_native(&target) {
            match batch.policy.as_str() {
                "suffix" => {
                    let name = target
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default();
                    let dir = parent_of(&target);
                    let mut found: Option<PathBuf> = None;
                    for attempt in 1..=999 {
                        let candidate = dir.join(suffix_candidate(&name, attempt, item.is_dir));
                        if !exists_native(&candidate) {
                            found = Some(candidate);
                            break;
                        }
                    }
                    match found {
                        Some(candidate) => target = candidate,
                        None => {
                            item.state = "failed".into();
                            item.reason = Some("无法自动生成不冲突的名称（已尝试 999 次）".into());
                            failed.push(SkippedChange {
                                id: item.id.clone(),
                                source: item.from.clone(),
                                reason: item.reason.clone().unwrap_or_default(),
                            });
                            let _ = rename_native(&temp, &from);
                            index += 1;
                            continue;
                        }
                    }
                }
                "skip" => {
                    item.state = "skipped".into();
                    item.reason = Some("目标已存在，按策略跳过".into());
                    skipped.push(SkippedChange {
                        id: item.id.clone(),
                        source: item.from.clone(),
                        reason: item.reason.clone().unwrap_or_default(),
                    });
                    if let Err(err) = rename_native(&temp, &from) {
                        item.state = "failed".into();
                        item.reason =
                            Some(format!("回退失败，文件仍在临时名 {}：{err}", item.temp));
                        failed.push(SkippedChange {
                            id: item.id.clone(),
                            source: item.from.clone(),
                            reason: item.reason.clone().unwrap_or_default(),
                        });
                    }
                    index += 1;
                    continue;
                }
                _ => {
                    // 覆盖：先把原目标移入备份目录
                    let name = target
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default();
                    let backup = backup_path(store, &batch_id, index, &name);
                    match rename_native(&target, &backup) {
                        Ok(()) => item.backup = Some(backup.to_string_lossy().to_string()),
                        Err(err) => {
                            item.state = "failed".into();
                            item.reason = Some(format!("无法备份已存在的目标：{err}"));
                            failed.push(SkippedChange {
                                id: item.id.clone(),
                                source: item.from.clone(),
                                reason: item.reason.clone().unwrap_or_default(),
                            });
                            let _ = rename_native(&temp, &from);
                            index += 1;
                            continue;
                        }
                    }
                }
            }
        }

        claimed.insert(target_key(&target));
        match rename_native(&temp, &target) {
            Ok(()) => {
                item.state = "done".into();
                item.to = target.to_string_lossy().to_string();
                applied.push(AppliedChange {
                    id: item.id.clone(),
                    from: item.from.clone(),
                    to: item.to.clone(),
                    backup: item.backup.clone(),
                });
            }
            Err(err) => {
                item.state = "failed".into();
                item.reason = Some(format!("改名失败：{err}"));
                failed.push(SkippedChange {
                    id: item.id.clone(),
                    source: item.from.clone(),
                    reason: item.reason.clone().unwrap_or_default(),
                });
                let _ = rename_native(&temp, &from);
            }
        }
        index += 1;
    }

    if cancelled {
        // 取消发生在阶段 B：尚未落位的条目从临时名回退到原名，已完成的条目保持
        rollback_staged(&mut batch);
        on_progress("cancelled", processed_apply, apply_total, "");
    }

    batch.counts.done = applied.len();
    batch.counts.skipped = skipped.len();
    batch.counts.failed = failed.len();
    batch.finished_at = Some(now_ms());
    batch.state = if cancelled {
        "cancelled".into()
    } else if failed.is_empty() {
        "completed".into()
    } else {
        "partial".into()
    };
    let _ = store.save(&batch);

    Ok(ApplyOutcome {
        batch,
        applied,
        skipped,
        failed,
    })
}

pub fn undo(store: &BatchStore, id: &str) -> Result<UndoOutcome, String> {
    let mut batch = store
        .load(id)
        .map_err(|e| format!("读取批次失败：{e}"))?
        .ok_or_else(|| "批次不存在".to_string())?;

    if !batch.kind.is_empty() && batch.kind != "rename" && batch.kind != "restore" {
        return Err("该批次不是改名批次，请使用对应的撤销入口".into());
    }

    if batch.state == "undone" {
        return Err("该批次已经撤销过".into());
    }

    let mut restored: Vec<AppliedChange> = Vec::new();
    let mut failed: Vec<SkippedChange> = Vec::new();

    struct UndoMove {
        current: PathBuf,
        staged: PathBuf,
        from: PathBuf,
        to: PathBuf,
        id: String,
    }

    // 阶段 1：把本批次产生的所有新文件先移入撤销临时名。
    // 这样交换、环形改名、仅大小写改名都能安全回退。
    let mut moves: Vec<UndoMove> = Vec::new();
    for (idx, item) in batch.items.iter().enumerate() {
        let from = PathBuf::from(&item.from);
        let to = PathBuf::from(&item.to);
        let temp = PathBuf::from(&item.temp);
        let to_exists = exists_native(&to);
        let temp_exists = exists_native(&temp);

        if item.state == "done" {
            let current = if to_exists {
                Some(to.clone())
            } else if temp_exists {
                Some(temp.clone())
            } else {
                None
            };
            let Some(current) = current else {
                failed.push(SkippedChange {
                    id: item.id.clone(),
                    source: item.from.clone(),
                    reason: "目标文件不存在，可能已在外部被移动".into(),
                });
                continue;
            };
            let staged = free_temp_path(
                &parent_of(&current),
                &format!("undo-{id}"),
                idx,
                item.is_dir,
            );
            match rename_native(&current, &staged) {
                Ok(()) => moves.push(UndoMove {
                    current,
                    staged,
                    from,
                    to,
                    id: item.id.clone(),
                }),
                Err(err) => failed.push(SkippedChange {
                    id: item.id.clone(),
                    source: current.to_string_lossy().to_string(),
                    reason: format!("准备撤销失败：{err}"),
                }),
            }
        } else if temp_exists && !to_exists {
            // 上一次执行在阶段 A 后中断，文件仍在临时名
            moves.push(UndoMove {
                current: temp.clone(),
                staged: temp,
                from,
                to,
                id: item.id.clone(),
            });
        }
    }

    // 阶段 2：临时名回到原位
    for mv in moves.iter().rev() {
        let from_exists = exists_native(&mv.from);
        let same = from_exists && same_file(&mv.from, &mv.staged);
        if from_exists && !same {
            failed.push(SkippedChange {
                id: mv.id.clone(),
                source: mv.from.to_string_lossy().to_string(),
                reason: "原位置已被其他文件占用，无法撤销".into(),
            });
            let _ = rename_native(&mv.staged, &mv.current);
            continue;
        }
        match rename_native(&mv.staged, &mv.from) {
            Ok(()) => restored.push(AppliedChange {
                id: mv.id.clone(),
                from: mv.to.to_string_lossy().to_string(),
                to: mv.from.to_string_lossy().to_string(),
                backup: None,
            }),
            Err(err) => {
                let _ = rename_native(&mv.staged, &mv.current);
                failed.push(SkippedChange {
                    id: mv.id.clone(),
                    source: mv.to.to_string_lossy().to_string(),
                    reason: format!("撤销改名失败：{err}"),
                });
            }
        }
    }

    // 覆盖过的文件：目标位空出后再还原备份
    for item in batch.items.iter() {
        let Some(backup) = item.backup.clone().map(PathBuf::from) else {
            continue;
        };
        if !exists_native(&backup) {
            continue;
        }
        let target = PathBuf::from(&item.to);
        if exists_native(&target) {
            failed.push(SkippedChange {
                id: item.id.clone(),
                source: backup.to_string_lossy().to_string(),
                reason: "目标位置仍被占用，备份未还原".into(),
            });
        } else if let Err(err) = rename_native(&backup, &target) {
            failed.push(SkippedChange {
                id: item.id.clone(),
                source: backup.to_string_lossy().to_string(),
                reason: format!("备份还原失败：{err}"),
            });
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

    Ok(UndoOutcome {
        batch,
        restored,
        failed,
        skipped_fields: Vec::new(),
    })
}

/// 供启动恢复使用：列出尚未完成的批次
pub fn pending_batches(store: &BatchStore) -> Vec<crate::journal::BatchSummary> {
    store
        .list()
        .into_iter()
        .filter(|b| b.state == "pending" || b.state == "partial")
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::journal::undo_status;
    use crate::platform::Platform;
    use std::io::Write;
    use std::sync::atomic::{AtomicU32, Ordering};

    static SEQ: AtomicU32 = AtomicU32::new(0);

    struct Sandbox {
        root: PathBuf,
        data: PathBuf,
    }

    impl Sandbox {
        fn new(label: &str) -> Self {
            let seq = SEQ.fetch_add(1, Ordering::Relaxed);
            let root =
                std::env::temp_dir().join(format!("renomio-{label}-{}-{seq}", std::process::id()));
            let _ = fs::remove_dir_all(native_path(&root));
            fs::create_dir_all(native_path(&root)).unwrap();
            let data = root.join(".data");
            fs::create_dir_all(native_path(&data)).unwrap();
            Self { root, data }
        }

        fn path(&self, name: &str) -> PathBuf {
            self.root.join(name)
        }

        fn file(&self, name: &str, body: &str) -> PathBuf {
            let path = self.path(name);
            let mut f = fs::File::create(native_path(&path)).unwrap();
            f.write_all(body.as_bytes()).unwrap();
            path
        }

        fn store(&self) -> BatchStore {
            BatchStore::new(&self.data)
        }
    }

    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(native_path(&self.root));
        }
    }

    fn item(id: &str, source: &Path, target: &str) -> ApplyItem {
        ApplyItem {
            id: id.into(),
            source: source.to_string_lossy().to_string(),
            target_name: target.into(),
            is_dir: false,
        }
    }

    fn opts(policy: &str) -> ApplyOptions {
        ApplyOptions {
            policy: policy.into(),
            ..Default::default()
        }
    }

    #[test]
    fn only_case_change_is_renamed_via_temp() {
        let sb = Sandbox::new("case-only");
        let file = sb.file("Report.txt", "body");
        let outcome = apply(
            &sb.store(),
            Platform::current(),
            vec![item("a", &file, "REPORT.TXT")],
            &opts("skip"),
        )
        .unwrap();
        assert_eq!(outcome.applied.len(), 1, "仅改大小写应执行");
        // Windows 文件系统大小写不敏感，exists() 无法区分；直接读目录项确认实际大小写已改变
        let names: Vec<String> = fs::read_dir(native_path(&sb.root))
            .unwrap()
            .flatten()
            .filter_map(|e| e.file_name().to_str().map(str::to_string))
            .collect();
        assert!(
            names.iter().any(|n| n == "REPORT.TXT"),
            "目录项应为 REPORT.TXT，实际 {names:?}"
        );
        assert!(
            !names.iter().any(|n| n == "Report.txt"),
            "旧大小写名称不应继续存在"
        );
    }

    #[test]
    fn existing_target_is_skipped_or_suffixed() {
        let sb = Sandbox::new("conflict");
        sb.file("A.txt", "existing");
        let src = sb.file("b.txt", "source");

        let skipped = apply(
            &sb.store(),
            Platform::current(),
            vec![item("a", &src, "A.txt")],
            &opts("skip"),
        )
        .unwrap();
        assert_eq!(skipped.applied.len(), 0);
        assert!(skipped
            .skipped
            .iter()
            .any(|s| s.reason.contains("目标已存在")));

        let suffixed = apply(
            &sb.store(),
            Platform::current(),
            vec![item("a", &src, "A.txt")],
            &opts("suffix"),
        )
        .unwrap();
        assert_eq!(suffixed.applied.len(), 1);
        assert!(exists_native(&sb.path("A (1).txt")));
    }

    #[cfg(any(target_os = "windows", target_os = "macos"))]
    #[test]
    fn case_insensitive_target_counts_as_conflict() {
        let sb = Sandbox::new("case-conflict");
        sb.file("A.txt", "existing");
        let src = sb.file("b.txt", "source");
        let outcome = apply(
            &sb.store(),
            Platform::current(),
            vec![item("a", &src, "a.txt")],
            &opts("skip"),
        )
        .unwrap();
        assert_eq!(outcome.applied.len(), 0, "大小写不敏感平台应视为同名冲突");
        assert!(outcome
            .skipped
            .iter()
            .any(|s| s.reason.contains("目标已存在")));
    }

    #[test]
    fn overwrite_backs_up_and_undo_restores_both() {
        let sb = Sandbox::new("overwrite");
        let target = sb.file("A.txt", "old");
        let src = sb.file("b.txt", "new");
        let store = sb.store();
        let outcome = apply(
            &store,
            Platform::current(),
            vec![item("a", &src, "A.txt")],
            &opts("overwrite"),
        )
        .unwrap();
        assert_eq!(outcome.applied.len(), 1);
        let backup = outcome.applied[0].backup.clone().expect("覆盖必须留备份");
        assert!(exists_native(Path::new(&backup)));
        assert_eq!(fs::read_to_string(native_path(&target)).unwrap(), "new");

        let undone = undo(&store, &outcome.batch.id).unwrap();
        assert_eq!(undone.restored.len(), 1);
        assert_eq!(fs::read_to_string(native_path(&target)).unwrap(), "old");
        assert!(exists_native(&sb.path("b.txt")));
    }

    #[test]
    fn journal_survives_store_reopen_and_undo_still_works() {
        let sb = Sandbox::new("restart");
        let src = sb.file("old.txt", "body");
        let store = sb.store();
        let outcome = apply(
            &store,
            Platform::current(),
            vec![item("a", &src, "new.txt")],
            &opts("skip"),
        )
        .unwrap();
        assert!(exists_native(&sb.path("new.txt")));

        // 模拟进程重启：重新打开同一数据目录（不共享内存状态）
        let reopened = BatchStore::new(&sb.data);
        let listed = reopened.list();
        assert_eq!(listed.len(), 1);
        let batch = reopened.load(&outcome.batch.id).unwrap().unwrap();
        assert_eq!(undo_status(&batch).0, true, "重启后批次仍应可撤销");

        let undone = undo(&reopened, &outcome.batch.id).unwrap();
        assert_eq!(undone.restored.len(), 1);
        assert!(exists_native(&sb.path("old.txt")));
    }

    #[test]
    fn undo_unavailable_after_external_move() {
        let sb = Sandbox::new("external");
        let src = sb.file("old.txt", "body");
        let store = sb.store();
        let outcome = apply(
            &store,
            Platform::current(),
            vec![item("a", &src, "new.txt")],
            &opts("skip"),
        )
        .unwrap();
        fs::rename(
            native_path(&sb.path("new.txt")),
            native_path(&sb.path("moved.txt")),
        )
        .unwrap();
        let batch = store.load(&outcome.batch.id).unwrap().unwrap();
        let (ok, reason) = undo_status(&batch);
        assert!(!ok);
        assert!(reason.unwrap().contains("不存在"));
    }

    #[test]
    fn hard_link_is_renamed_without_touching_peer() {
        let sb = Sandbox::new("hardlink");
        let original = sb.file("orig.txt", "shared");
        let link = sb.path("link.txt");
        if fs::hard_link(native_path(&original), native_path(&link)).is_err() {
            return; // 文件系统不支持硬链接时跳过
        }
        let outcome = apply(
            &sb.store(),
            Platform::current(),
            vec![item("a", &link, "renamed.txt")],
            &opts("skip"),
        )
        .unwrap();
        assert_eq!(outcome.applied.len(), 1);
        assert_eq!(
            fs::read_to_string(native_path(&sb.path("renamed.txt"))).unwrap(),
            "shared"
        );
        assert_eq!(
            fs::read_to_string(native_path(&original)).unwrap(),
            "shared"
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlink_is_renamed_as_a_link() {
        use std::os::unix::fs::symlink;
        let sb = Sandbox::new("symlink");
        let target = sb.file("target.txt", "body");
        let link = sb.path("link.txt");
        symlink(native_path(&target), native_path(&link)).unwrap();
        let outcome = apply(
            &sb.store(),
            Platform::current(),
            vec![item("a", &link, "renamed-link.txt")],
            &opts("skip"),
        )
        .unwrap();
        assert_eq!(outcome.applied.len(), 1);
        let meta = fs::symlink_metadata(native_path(&sb.path("renamed-link.txt"))).unwrap();
        assert!(meta.file_type().is_symlink());
    }

    #[test]
    fn readonly_file_is_skipped_when_configured() {
        let sb = Sandbox::new("readonly");
        let file = sb.file("ro.txt", "body");
        let mut perms = fs::metadata(native_path(&file)).unwrap().permissions();
        perms.set_readonly(true);
        fs::set_permissions(native_path(&file), perms).unwrap();

        let mut options = opts("skip");
        options.skip_readonly = true;
        let outcome = apply(
            &sb.store(),
            Platform::current(),
            vec![item("a", &file, "rw.txt")],
            &options,
        )
        .unwrap();
        assert_eq!(outcome.applied.len(), 0);
        assert!(outcome.skipped.iter().any(|s| s.reason.contains("只读")));
    }

    #[test]
    fn invalid_target_name_is_rejected_before_touching_disk() {
        let sb = Sandbox::new("invalid");
        let file = sb.file("ok.txt", "body");
        let outcome = apply(
            &sb.store(),
            Platform::current(),
            vec![item("a", &file, "bad:name.txt")],
            &opts("skip"),
        )
        .unwrap();
        assert_eq!(outcome.applied.len(), 0);
        assert!(outcome.failed.iter().any(|s| s.reason.contains("非法字符")));
        assert!(exists_native(&file), "被拒绝时源文件必须保持原样");
    }

    #[test]
    fn duplicate_targets_inside_one_batch_are_not_double_written() {
        let sb = Sandbox::new("dup");
        let one = sb.file("one.txt", "1");
        let two = sb.file("two.txt", "2");
        let outcome = apply(
            &sb.store(),
            Platform::current(),
            vec![item("1", &one, "same.txt"), item("2", &two, "same.txt")],
            &opts("overwrite"),
        )
        .unwrap();
        assert_eq!(outcome.applied.len(), 1);
        assert!(outcome
            .skipped
            .iter()
            .any(|s| s.reason.contains("同一目标")));
    }

    #[cfg(windows)]
    #[test]
    fn directory_junction_is_renamed_as_a_link() {
        use std::process::Command;
        let sb = Sandbox::new("junction");
        let target = sb.path("target-dir");
        fs::create_dir_all(native_path(&target)).unwrap();
        {
            let inside = target.join("inside.txt");
            let mut f = fs::File::create(native_path(&inside)).unwrap();
            f.write_all(b"body").unwrap();
        }
        let link = sb.path("junction");
        let status = Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(native_path(&link))
            .arg(native_path(&target))
            .status();
        let Ok(status) = status else { return };
        if !status.success() {
            return; // 无创建联接权限时跳过（不影响其他平台用例）
        }
        let outcome = apply(
            &sb.store(),
            Platform::current(),
            vec![ApplyItem {
                id: "j".into(),
                source: link.to_string_lossy().to_string(),
                target_name: "renamed-junction".into(),
                is_dir: true,
            }],
            &opts("skip"),
        )
        .unwrap();
        assert_eq!(outcome.applied.len(), 1, "目录联接应作为目录项改名");
        let renamed = sb.path("renamed-junction");
        assert!(fs::metadata(native_path(&renamed)).unwrap().is_dir());
        assert!(
            exists_native(&target.join("inside.txt")),
            "联接目标内容不应被移动"
        );
    }

    #[cfg(windows)]
    #[test]
    fn path_longer_than_260_is_renamed_with_prefix() {
        let sb = Sandbox::new("longpath");
        let mut dir = sb.root.clone();
        // 每段 45 字符，累计超过 260 但远低于 32767
        for i in 0..6 {
            dir = dir.join(format!("segment-{i}-{}", "x".repeat(38)));
            fs::create_dir_all(native_path(&dir)).unwrap();
        }
        assert!(dir.to_string_lossy().len() > 260);
        let src = dir.join("old.txt");
        {
            let mut f = fs::File::create(native_path(&src)).unwrap();
            f.write_all(b"long").unwrap();
        }
        let outcome = apply(
            &sb.store(),
            Platform::current(),
            vec![item("a", &src, "new.txt")],
            &opts("skip"),
        )
        .unwrap();
        assert_eq!(outcome.applied.len(), 1, "长路径应通过 \\\\?\\ 前缀完成");
        assert!(exists_native(&dir.join("new.txt")));
    }

    #[test]
    fn name_policy_still_blocks_overhard_limit() {
        let target = Path::new("C:\\").join("z".repeat(40000));
        let policy = NamePolicy::new(Platform::Windows, true);
        let issue = path_length_issue(&target, policy).expect("超硬上限必须阻断");
        assert_eq!(issue.severity, "block");
    }
}

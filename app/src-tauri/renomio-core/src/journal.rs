//! 批次日志：先写日志、再动文件；日志落盘可跨重启撤销。

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::platform::native_path;

static BATCH_SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchItem {
    pub id: String,
    pub from: String,
    /// 计划目标；执行后可能因"自动加后缀"变化，以实际值为准
    pub to: String,
    pub temp: String,
    pub is_dir: bool,
    /// done / skipped / failed / planned
    pub state: String,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub backup: Option<String>,
}

/// 非改名批次的操作记录（时间 / 属性 / 移动）。before/after 为 JSON 文本，
/// 由各操作自行解释；撤销时按 before 还原。
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchOp {
    pub id: String,
    /// time / attrs / move
    pub kind: String,
    /// 执行前路径
    pub path: String,
    /// 移动后的路径（仅 move）
    #[serde(default)]
    pub target: Option<String>,
    /// 执行前状态（JSON）
    pub before: String,
    /// 计划/执行后状态（JSON）
    #[serde(default)]
    pub after: String,
    /// done / skipped / failed
    pub state: String,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchCounts {
    pub total: usize,
    pub done: usize,
    pub skipped: usize,
    pub failed: usize,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Batch {
    pub id: String,
    pub created_at: i64,
    #[serde(default)]
    pub finished_at: Option<i64>,
    /// pending / completed / partial / undone / undo-partial
    pub state: String,
    /// rename / time / attrs / move；旧批次缺省为空，按 rename 处理
    #[serde(default)]
    pub kind: String,
    pub policy: String,
    pub roots: Vec<String>,
    pub counts: BatchCounts,
    pub items: Vec<BatchItem>,
    /// 非改名操作；旧批次为空
    #[serde(default)]
    pub ops: Vec<BatchOp>,
    /// 本次执行新建的目录（撤销时在为空的情况下移除）
    #[serde(default)]
    pub created_dirs: Vec<String>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchSummary {
    pub id: String,
    pub created_at: i64,
    pub finished_at: Option<i64>,
    pub state: String,
    pub kind: String,
    pub policy: String,
    pub roots: Vec<String>,
    pub counts: BatchCounts,
    /// 当前是否可撤销（会检查目标文件是否仍在原位）
    pub undoable: bool,
    /// 不可撤销的原因（可撤销时为 None）
    pub undo_reason: Option<String>,
}

impl Batch {
    pub fn summary(&self) -> BatchSummary {
        BatchSummary {
            id: self.id.clone(),
            created_at: self.created_at,
            finished_at: self.finished_at,
            state: self.state.clone(),
            kind: if self.kind.is_empty() {
                "rename".into()
            } else {
                self.kind.clone()
            },
            policy: self.policy.clone(),
            roots: self.roots.clone(),
            counts: self.counts.clone(),
            undoable: false,
            undo_reason: None,
        }
    }
}

/// 撤销可行性：状态 + 真实磁盘校验。
/// 只检查已执行条目当前是否仍在「执行后的位置」，以及覆盖备份是否还在。
pub fn undo_status(batch: &Batch) -> (bool, Option<String>) {
    if batch.state == "undone" {
        return (false, Some("该批次已经撤销".into()));
    }
    if batch.state == "undo-partial" {
        return (false, Some("上次撤销部分失败，请先检查残留文件".into()));
    }
    if batch.counts.done == 0
        && batch.items.iter().filter(|i| i.state == "done").count() == 0
        && batch.ops.is_empty()
    {
        return (false, Some("批次没有实际执行的条目".into()));
    }
    if batch.state == "pending" && batch.counts.done == 0 {
        return (false, Some("批次未完成；请先恢复执行或清理临时文件".into()));
    }
    for item in &batch.items {
        if item.state != "done" {
            continue;
        }
        if !path_exists(&item.to) {
            return (
                false,
                Some(format!(
                    "目标文件已不存在：{}（可能被外部移动或删除）",
                    item.to
                )),
            );
        }
        if let Some(backup) = &item.backup {
            if !path_exists(backup) {
                return (false, Some(format!("覆盖备份已丢失：{backup}")));
            }
        }
    }
    for op in &batch.ops {
        if op.state != "done" {
            continue;
        }
        let current = op.target.as_deref().unwrap_or(&op.path);
        if !path_exists(current) {
            return (
                false,
                Some(format!("文件已不存在：{current}（可能被外部移动或删除）")),
            );
        }
    }
    (true, None)
}

fn path_exists(path: &str) -> bool {
    fs::metadata(native_path(Path::new(path))).is_ok()
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn new_batch_id() -> String {
    let seq = BATCH_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("{}-{:03}", now_ms(), seq % 1000)
}

pub struct BatchStore {
    data_dir: PathBuf,
}

impl BatchStore {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            data_dir: data_dir.to_path_buf(),
        }
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    pub fn batches_dir(&self) -> PathBuf {
        self.data_dir.join("batches")
    }

    pub fn backup_dir(&self, batch_id: &str) -> PathBuf {
        self.data_dir.join("backups").join(batch_id)
    }

    fn ensure_dirs(&self) -> std::io::Result<()> {
        fs::create_dir_all(self.batches_dir())?;
        fs::create_dir_all(self.data_dir.join("backups"))?;
        Ok(())
    }

    fn valid_id(id: &str) -> bool {
        !id.is_empty()
            && id.len() < 120
            && id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    }

    pub fn save(&self, batch: &Batch) -> std::io::Result<()> {
        if !Self::valid_id(&batch.id) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "非法批次 ID",
            ));
        }
        self.ensure_dirs()?;
        let dest = self.batches_dir().join(format!("{}.json", batch.id));
        let tmp = self.batches_dir().join(format!("{}.json.tmp", batch.id));
        let json = serde_json::to_vec_pretty(batch)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;

        {
            let path = native_path(&tmp);
            let mut file = fs::File::create(&path)?;
            file.write_all(&json)?;
            // 关键：日志必须先真正落盘，再开始改名
            file.sync_all()?;
        }

        let dest_native = native_path(&dest);
        if dest_native.exists() {
            // Windows 不允许 rename 覆盖已存在文件；日志更新允许极小窗口
            let _ = fs::remove_file(&dest_native);
        }
        fs::rename(&native_path(&tmp), &dest_native)?;
        Ok(())
    }

    pub fn load(&self, id: &str) -> std::io::Result<Option<Batch>> {
        if !Self::valid_id(id) {
            return Ok(None);
        }
        let path = self.batches_dir().join(format!("{id}.json"));
        if !path.exists() {
            return Ok(None);
        }
        let raw = fs::read_to_string(native_path(&path))?;
        let batch = serde_json::from_str::<Batch>(&raw)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        Ok(Some(batch))
    }

    pub fn list(&self) -> Vec<BatchSummary> {
        let mut summaries = Vec::new();
        let dir = self.batches_dir();
        let Ok(read) = fs::read_dir(&dir) else {
            return summaries;
        };
        for entry in read.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let Some(id) = path
                .file_stem()
                .and_then(|s| s.to_str())
                .map(str::to_string)
            else {
                continue;
            };
            match self.load(&id) {
                Ok(Some(batch)) => summaries.push(batch.summary()),
                _ => continue,
            }
        }
        summaries.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        summaries
    }

    /// 清理临时文件（不改动用户文件），仅用于测试与维护
    pub fn cleanup_temp(&self, batch_id: &str) {
        let dir = self.backup_dir(batch_id);
        let _ = fs::remove_dir_all(dir);
    }
}

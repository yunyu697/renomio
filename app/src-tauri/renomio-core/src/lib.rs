//! Renomio 核心：只做文件系统与事务，不依赖 Tauri / 前端。

pub mod hashing;
pub mod journal;
pub mod metaedit;
pub mod metadata;
pub mod ops;
pub mod platform;
pub mod rename;
pub mod scan;
pub mod snapshot;

use std::path::{Path, PathBuf};

use journal::{Batch, BatchStore, BatchSummary};
use ops::{AttrInfo, AttrSpec, MoveItem, MoveSpec, OpTarget, OpsOutcome, TimeInfo, TimeSpec};
use platform::{probe_case_sensitivity, Platform};
use rename::{ApplyItem, ApplyOptions, ApplyOutcome, UndoOutcome};
use scan::{ScanOptions, ScanResult};

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvInfo {
    pub os: &'static str,
    pub separator: &'static str,
    pub case_sensitive: bool,
    pub component_limit: usize,
    pub path_warn_threshold: usize,
    pub path_hard_limit: usize,
    pub data_dir: String,
    /// Linux 通常无法写入创建时间
    pub creation_time_writable: bool,
    pub long_path_support: bool,
}

pub struct Core {
    store: BatchStore,
    platform: Platform,
    case_sensitive: bool,
}

impl Core {
    pub fn new(data_dir: impl AsRef<Path>) -> Self {
        let data_dir = data_dir.as_ref().to_path_buf();
        let _ = std::fs::create_dir_all(&data_dir);
        let platform = Platform::current();
        let case_sensitive = probe_case_sensitivity(&data_dir);
        Self {
            store: BatchStore::new(&data_dir),
            platform,
            case_sensitive,
        }
    }

    pub fn env(&self, windows_safe: bool) -> EnvInfo {
        let _ = windows_safe;
        EnvInfo {
            os: self.platform.as_str(),
            separator: if self.platform.separator() == '\\' {
                "\\"
            } else {
                "/"
            },
            case_sensitive: self.case_sensitive,
            component_limit: self.platform.component_limit(),
            path_warn_threshold: self.platform.path_warn_threshold(),
            path_hard_limit: self.platform.path_hard_limit(),
            data_dir: self.store.data_dir().to_string_lossy().to_string(),
            // 仅 Windows 可通过 SetFileTime 改写创建时间
            creation_time_writable: self.platform == Platform::Windows,
            long_path_support: self.platform == Platform::Windows,
        }
    }

    pub fn platform(&self) -> Platform {
        self.platform
    }

    pub fn scan(&self, inputs: &[String], opts: &ScanOptions) -> ScanResult {
        scan::scan_paths(inputs, opts, self.platform)
    }

    pub fn paths_exist(&self, paths: &[String]) -> Vec<bool> {
        paths.iter().map(|p| PathBuf::from(p).exists()).collect()
    }

    pub fn apply(
        &self,
        items: Vec<ApplyItem>,
        opts: &ApplyOptions,
    ) -> Result<ApplyOutcome, String> {
        rename::apply(&self.store, self.platform, items, opts)
    }

    /// 带进度回调与取消检查的批量改名。
    /// `on_progress(阶段, 已处理, 总数, 当前文件名)`；`is_cancelled` 在每个条目边界检查。
    pub fn apply_with_progress(
        &self,
        items: Vec<ApplyItem>,
        opts: &ApplyOptions,
        on_progress: &mut dyn FnMut(&str, usize, usize, &str),
        is_cancelled: &dyn Fn() -> bool,
    ) -> Result<ApplyOutcome, String> {
        rename::apply_with_hooks(
            &self.store,
            self.platform,
            items,
            opts,
            on_progress,
            is_cancelled,
        )
    }

    pub fn apply_time(&self, items: Vec<OpTarget>, spec: &TimeSpec) -> Result<OpsOutcome, String> {
        ops::apply_time(&self.store, items, spec)
    }

    pub fn apply_attrs(&self, items: Vec<OpTarget>, spec: &AttrSpec) -> Result<OpsOutcome, String> {
        ops::apply_attrs(&self.store, items, spec)
    }

    pub fn apply_move(&self, items: Vec<MoveItem>, spec: &MoveSpec) -> Result<OpsOutcome, String> {
        ops::apply_move(&self.store, items, spec)
    }

    pub fn read_times(&self, paths: &[String]) -> Vec<TimeInfo> {
        ops::read_times(paths)
    }

    pub fn read_attrs(&self, paths: &[String]) -> Vec<AttrInfo> {
        ops::read_attrs(paths)
    }

    /// 快照目录（与批次日志同在数据目录下）。
    pub fn snapshot_dir(&self) -> PathBuf {
        self.store.data_dir().join("snapshots")
    }

    pub fn snapshot_create(
        &self,
        roots: Vec<String>,
        entries: Vec<snapshot::SnapshotInput>,
        with_hash: bool,
        on_progress: &mut dyn FnMut(usize, usize, &str),
        is_cancelled: &dyn Fn() -> bool,
    ) -> Result<(snapshot::Snapshot, usize), String> {
        snapshot::create(
            self.store.data_dir(),
            roots,
            entries,
            with_hash,
            on_progress,
            is_cancelled,
        )
    }

    pub fn snapshot_restore(
        &self,
        snap: &snapshot::Snapshot,
        on_progress: &mut dyn FnMut(&str, usize, usize, &str),
        is_cancelled: &dyn Fn() -> bool,
    ) -> Result<snapshot::RestoreOutcome, String> {
        snapshot::restore(
            &self.store,
            self.platform,
            snap,
            on_progress,
            is_cancelled,
        )
    }

    pub fn undo(&self, batch_id: &str) -> Result<UndoOutcome, String> {
        let ops_batch = match self.store.load(batch_id) {
            Ok(Some(batch)) => {
                !batch.kind.is_empty() && batch.kind != "rename" && batch.kind != "restore"
            }
            _ => false,
        };
        if ops_batch {
            ops::undo_ops(&self.store, batch_id)
        } else {
            rename::undo(&self.store, batch_id)
        }
    }

    pub fn batches(&self) -> Vec<BatchSummary> {
        let mut list = self.store.list();
        for summary in &mut list {
            if let Ok(Some(batch)) = self.store.load(&summary.id) {
                let (undoable, reason) = journal::undo_status(&batch);
                summary.undoable = undoable;
                summary.undo_reason = reason;
            }
        }
        list
    }

    pub fn batch(&self, id: &str) -> Option<Batch> {
        self.store.load(id).ok().flatten()
    }

    pub fn pending_batches(&self) -> Vec<BatchSummary> {
        rename::pending_batches(&self.store)
    }

    /// 只读元数据：不写文件、不写入元数据，解析失败只返回警告。
    pub fn metadata(&self, path: &str) -> Result<metadata::MetadataInfo, String> {
        metadata::read_metadata(path)
    }

    /// 批量读取只读元数据；单条失败逐条返回，不中断整批。
    pub fn metadata_batch(&self, paths: &[String]) -> Vec<metadata::BatchMetadata> {
        metadata::read_metadata_batch(paths)
    }
}

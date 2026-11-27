//! 属性备份库（域六 6.3 的剩余缺口）：每次成功写入属性后，把「改之前的四属性」按批次另存一份。
//!
//! 为什么不能只靠批次日志：批次日志会被历史清理/损坏，而且它记录的是「这条批次做了什么」，
//! 想「把某次属性改动整体还原」还得先把批次读出来再逐条推。备份库是**独立、只写不改**的一层，
//! 一个批次一个文件（`<created_at>-<batch_id>.json`），损坏的文件在列表里直接跳过，不影响其他批次。
//!
//! 保留策略：默认只留最近 [`DEFAULT_KEEP`] 份，写入后自动裁剪；删除的是最旧的备份文件，
//! 不碰批次日志，也不碰 `backups/` 里的文件备份。

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// 默认保留的备份份数（按创建时间从新到旧）。
pub const DEFAULT_KEEP: usize = 50;

/// 一个文件的四属性快照。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttrSnapshot {
    pub path: String,
    pub readonly: bool,
    pub hidden: bool,
    pub system: bool,
    pub archive: bool,
}

/// 一次属性写入前的完整快照（按批次）。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttrBackup {
    pub batch_id: String,
    pub created_at: i64,
    pub entries: Vec<AttrSnapshot>,
}

/// 列表项：够界面显示，不带每一条路径。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttrBackupSummary {
    pub batch_id: String,
    pub created_at: i64,
    pub entries: usize,
    /// 第一条路径，给界面当提示用（可能为空）
    pub first_path: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreFailure {
    pub path: String,
    pub reason: String,
}

/// 一次还原的结果：改成功的、本来就没变的、文件已不在的、写失败的。
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreReport {
    pub batch_id: String,
    pub restored: Vec<String>,
    pub unchanged: Vec<String>,
    pub missing: Vec<String>,
    pub failed: Vec<RestoreFailure>,
}

/// 备份库：`<data_dir>/attr-backups/` 下每批次一个 JSON。
pub struct AttrBackupStore {
    dir: PathBuf,
}

impl AttrBackupStore {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            dir: data_dir.join("attr-backups"),
        }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn file_name(&self, backup: &AttrBackup) -> String {
        format!("{}-{}.json", backup.created_at, safe_id(&backup.batch_id))
    }

    /// 原子写：先写 `.tmp` 再改名，避免半截 JSON。
    pub fn save(&self, backup: &AttrBackup) -> std::io::Result<PathBuf> {
        fs::create_dir_all(&self.dir)?;
        let dest = self.dir.join(self.file_name(backup));
        let tmp = dest.with_extension("json.tmp");
        let body = serde_json::to_vec(backup)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        fs::write(&tmp, body)?;
        fs::rename(&tmp, &dest)?;
        Ok(dest)
    }

    /// 按创建时间从新到旧列出；坏文件跳过（不因一份坏备份让整个列表不可用）。
    pub fn list(&self) -> Vec<AttrBackupSummary> {
        let mut out = Vec::new();
        let Ok(entries) = fs::read_dir(&self.dir) else {
            return out;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let Ok(raw) = fs::read_to_string(&path) else {
                continue;
            };
            let Ok(backup) = serde_json::from_str::<AttrBackup>(&raw) else {
                continue;
            };
            out.push(AttrBackupSummary {
                batch_id: backup.batch_id,
                created_at: backup.created_at,
                entries: backup.entries.len(),
                first_path: backup
                    .entries
                    .first()
                    .map(|e| e.path.clone())
                    .unwrap_or_default(),
            });
        }
        out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        out
    }

    /// 按批次 id 读一份备份；id 不合法或文件不存在都返回 None。
    pub fn load(&self, batch_id: &str) -> Option<AttrBackup> {
        let safe = safe_id(batch_id);
        let Ok(entries) = fs::read_dir(&self.dir) else {
            return None;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.ends_with(&format!("-{safe}.json")) {
                continue;
            }
            let Ok(raw) = fs::read_to_string(&path) else {
                continue;
            };
            if let Ok(backup) = serde_json::from_str::<AttrBackup>(&raw) {
                if backup.batch_id == batch_id {
                    return Some(backup);
                }
            }
        }
        None
    }

    /// 只留最近 `keep` 份，返回删掉的份数。`keep=0` 视为 1（至少留最新一份）。
    pub fn prune(&self, keep: usize) -> std::io::Result<usize> {
        let keep = keep.max(1);
        let Ok(entries) = fs::read_dir(&self.dir) else {
            return Ok(0);
        };
        let mut files: Vec<(i64, PathBuf)> = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let created = fs::read_to_string(&path)
                .ok()
                .and_then(|raw| serde_json::from_str::<AttrBackup>(&raw).ok())
                .map(|b| b.created_at)
                .unwrap_or(0);
            files.push((created, path));
        }
        files.sort_by(|a, b| b.0.cmp(&a.0));
        let mut removed = 0;
        for (_, path) in files.into_iter().skip(keep) {
            if fs::remove_file(&path).is_ok() {
                removed += 1;
            }
        }
        Ok(removed)
    }
}

/// 把一份备份还原到磁盘：只写「有变化」的文件，文件不在的单独列出，失败逐条带回原因。
pub fn restore(backup: &AttrBackup) -> RestoreReport {
    let mut report = RestoreReport {
        batch_id: backup.batch_id.clone(),
        ..Default::default()
    };
    for snap in &backup.entries {
        if !Path::new(&snap.path).exists() {
            report.missing.push(snap.path.clone());
            continue;
        }
        let want = (snap.readonly, snap.hidden, snap.system, snap.archive);
        match crate::ops::attr_flags(&snap.path) {
            Some(current) if current == want => report.unchanged.push(snap.path.clone()),
            Some(_) => match crate::ops::write_attr_flags(&snap.path, want) {
                Ok(()) => report.restored.push(snap.path.clone()),
                Err(reason) => report.failed.push(RestoreFailure {
                    path: snap.path.clone(),
                    reason,
                }),
            },
            None => report.failed.push(RestoreFailure {
                path: snap.path.clone(),
                reason: "无法读取当前属性".to_string(),
            }),
        }
    }
    report
}

/// 文件名只保留字母数字、`-`、`_`，其余替换成 `_`，避免批次 id 带出路径分隔符。
fn safe_id(id: &str) -> String {
    let cleaned: String = id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    if cleaned.is_empty() {
        "batch".to_string()
    } else {
        cleaned
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn backup(id: &str, created: i64, paths: &[&str]) -> AttrBackup {
        AttrBackup {
            batch_id: id.to_string(),
            created_at: created,
            entries: paths
                .iter()
                .map(|p| AttrSnapshot {
                    path: p.to_string(),
                    readonly: false,
                    hidden: true,
                    system: false,
                    archive: true,
                })
                .collect(),
        }
    }

    #[test]
    fn save_list_and_load_round_trip() {
        let dir = std::env::temp_dir().join(format!("renomio-attrbackup-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let store = AttrBackupStore::new(&dir);
        store.save(&backup("b1", 100, &["C:/a.txt", "C:/b.txt"])).unwrap();
        store.save(&backup("b2", 200, &["C:/c.txt"])).unwrap();
        let list = store.list();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].batch_id, "b2", "最新的排最前");
        assert_eq!(list[1].entries, 2);
        let loaded = store.load("b1").unwrap();
        assert_eq!(loaded.entries.len(), 2);
        assert!(loaded.entries[0].hidden && loaded.entries[0].archive);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn prune_keeps_newest_only() {
        let dir = std::env::temp_dir().join(format!("renomio-attrbackup-prune-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let store = AttrBackupStore::new(&dir);
        for i in 0..5 {
            store.save(&backup(&format!("b{i}"), i as i64, &["C:/x.txt"])).unwrap();
        }
        assert_eq!(store.prune(2).unwrap(), 3);
        let list = store.list();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].batch_id, "b4");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_file_is_skipped() {
        let dir = std::env::temp_dir().join(format!("renomio-attrbackup-corrupt-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let store = AttrBackupStore::new(&dir);
        store.save(&backup("ok", 100, &["C:/a.txt"])).unwrap();
        fs::write(store.dir().join("broken.json"), "{not json").unwrap();
        let list = store.list();
        assert_eq!(list.len(), 1, "坏文件要被跳过");
        assert_eq!(list[0].batch_id, "ok");
        assert_eq!(store.prune(1).unwrap(), 1, "裁剪顺手清掉坏文件");
        assert!(store.list().iter().all(|b| b.batch_id == "ok"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn safe_id_strips_separators() {
        assert_eq!(safe_id("a/b\\c:d"), "a_b_c_d");
        assert_eq!(safe_id(""), "batch");
    }
}

//! 旧版数据迁移（Rename Studio / `com.rename.studio` → Renomio / `app.renomio.desktop`）。
//!
//! 纪律：
//! - 只复制、**绝不删除**旧目录；
//! - 先写同卷临时目录 → 校验文件数/字节数 → 原子 rename 落位；
//! - 任一步失败都清掉临时目录，旧目录保持原样，新目录不出现半套数据；
//! - 新旧目录同时存在时不合并、不覆盖，改由设置里的「从旧版导入数据」手动入口处理（导入前先备份）。

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// 迁移结果，同时供 `migration_info` 命令返回给界面。
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationInfo {
    /// no-legacy | skipped-both | migrated | failed
    pub status: String,
    pub old_dir: String,
    pub new_dir: String,
    pub old_dir_exists: bool,
    pub files: usize,
    pub bytes: u64,
    pub migrated_at: Option<i64>,
    pub error: Option<String>,
}

/// 手动导入结果：导入前已把当前数据目录整份备份。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub imported: usize,
    pub skipped: usize,
    pub bytes: u64,
    pub backup_dir: String,
}

pub struct MigrationState {
    info: MigrationInfo,
    pub new_dir: PathBuf,
    pub old_dir: PathBuf,
}

impl MigrationState {
    pub fn new(info: MigrationInfo, new_dir: PathBuf, old_dir: PathBuf) -> Self {
        Self {
            info,
            new_dir,
            old_dir,
        }
    }

    pub fn info(&self) -> MigrationInfo {
        let mut info = self.info.clone();
        info.old_dir_exists = self.old_dir.is_dir();
        info
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 与 Tauri `app_data_dir()` 对齐的每用户数据目录。
pub fn data_root(identifier: &str) -> PathBuf {
    if cfg!(windows) {
        let base = std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_default();
        return base.join(identifier);
    }
    if cfg!(target_os = "macos") {
        let base = std::env::var_os("HOME")
            .map(|h| PathBuf::from(h).join("Library/Application Support"))
            .unwrap_or_default();
        return base.join(identifier);
    }
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
        .unwrap_or_default();
    base.join(identifier)
}

/// 递归复制目录；返回（文件数, 字节数）。符号链接按指向的内容复制。
fn copy_dir(src: &Path, dst: &Path) -> io::Result<(usize, u64)> {
    fs::create_dir_all(dst)?;
    let mut files = 0usize;
    let mut bytes = 0u64;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let path = entry.path();
        let meta = fs::metadata(&path)?;
        let name = entry.file_name();
        let target = dst.join(&name);
        if meta.is_dir() {
            let (f, b) = copy_dir(&path, &target)?;
            files += f;
            bytes += b;
        } else {
            fs::copy(&path, &target)?;
            files += 1;
            bytes += meta.len();
        }
    }
    Ok((files, bytes))
}

/// 递归统计（文件数, 字节数），用于落位前校验。
fn stats(src: &Path) -> io::Result<(usize, u64)> {
    let mut files = 0usize;
    let mut bytes = 0u64;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let path = entry.path();
        let meta = fs::metadata(&path)?;
        if meta.is_dir() {
            let (f, b) = stats(&path)?;
            files += f;
            bytes += b;
        } else {
            files += 1;
            bytes += meta.len();
        }
    }
    Ok((files, bytes))
}

fn append_record(dir: &Path, file: &str, line: &str) {
    let logs = dir.join("logs");
    if fs::create_dir_all(&logs).is_err() {
        return;
    }
    if let Ok(mut f) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(logs.join(file))
    {
        use std::io::Write;
        let _ = writeln!(f, "{}", line.replace('\n', " "));
    }
}

fn base_info(old_dir: &Path, new_dir: &Path) -> MigrationInfo {
    MigrationInfo {
        status: "no-legacy".into(),
        old_dir: old_dir.to_string_lossy().to_string(),
        new_dir: new_dir.to_string_lossy().to_string(),
        old_dir_exists: old_dir.is_dir(),
        files: 0,
        bytes: 0,
        migrated_at: None,
        error: None,
    }
}

/// 首次启动时执行迁移。`new_dir` 必须尚不存在才迁移。
pub fn run(old_dir: &Path, new_dir: &Path, old_product: &str, new_product: &str) -> MigrationInfo {
    let mut info = base_info(old_dir, new_dir);
    if !old_dir.is_dir() {
        return info;
    }
    if new_dir.exists() {
        // 两个目录都在：保留新目录，不合并；界面提供手动导入入口。
        info.status = "skipped-both".into();
        append_record(
            new_dir,
            "migration.log",
            &format!(
                "skip\tsource={}\ttarget={}\treason=target-exists\tat={}",
                info.old_dir, info.new_dir, now_ms()
            ),
        );
        return info;
    }

    let Some(parent) = new_dir.parent() else {
        info.status = "failed".into();
        info.error = Some("新数据目录没有父目录".into());
        return info;
    };
    let tmp = parent.join(format!(
        ".renomio-migrate-{}-{}",
        std::process::id(),
        now_ms()
    ));

    let result = (|| -> io::Result<(usize, u64)> {
        let (files, bytes) = copy_dir(old_dir, &tmp)?;
        let (vfiles, vbytes) = stats(&tmp)?;
        if vfiles != files || vbytes != bytes {
            return Err(io::Error::new(
                io::ErrorKind::Other,
                format!("校验不一致：复制 {files} 个/{bytes} 字节，落盘 {vfiles} 个/{vbytes} 字节"),
            ));
        }
        let at = now_ms();
        let record = serde_json::json!({
            "sourceDir": old_dir.to_string_lossy(),
            "sourceIdentifier": "com.rename.studio",
            "sourceProduct": old_product,
            "targetDir": new_dir.to_string_lossy(),
            "targetIdentifier": "app.renomio.desktop",
            "targetProduct": new_product,
            "migratedAt": at,
            "files": files,
            "bytes": bytes,
            "note": "旧目录已保留，未删除；本记录由首次启动迁移写入",
        });
        fs::write(
            tmp.join("migration.json"),
            format!(
                "{}\n",
                serde_json::to_string_pretty(&record)
                    .map_err(|e| io::Error::new(io::ErrorKind::Other, e))?
            ),
        )?;
        append_record(
            &tmp,
            "migration.log",
            &format!(
                "migrated\tsource={}\ttarget={}\tfiles={files}\tbytes={bytes}\tat={at}",
                info.old_dir, info.new_dir
            ),
        );
        fs::rename(&tmp, new_dir)?;
        Ok((files, bytes))
    })();

    match result {
        Ok((files, bytes)) => {
            info.status = "migrated".into();
            info.files = files;
            info.bytes = bytes;
            info.migrated_at = Some(now_ms());
        }
        Err(err) => {
            // 失败：只清理临时目录，旧目录原样保留，新目录不落位。
            let _ = fs::remove_dir_all(&tmp);
            info.status = "failed".into();
            info.error = Some(err.to_string());
        }
    }
    info
}

/// 手动「从旧版导入数据」：先把当前新目录整份备份，再只补充旧目录里新目录没有的文件。
/// 不覆盖已有文件、不删除旧目录。
pub fn import_legacy(new_dir: &Path, old_dir: &Path) -> Result<ImportReport, String> {
    if !old_dir.is_dir() {
        return Err(format!("旧版数据目录不存在：{}", old_dir.to_string_lossy()));
    }
    let parent = new_dir
        .parent()
        .ok_or_else(|| "新数据目录没有父目录".to_string())?;
    let backup = parent.join(format!("import-backup-{}", now_ms()));
    let existed = new_dir.is_dir();
    if existed {
        copy_dir(new_dir, &backup).map_err(|e| format!("导入前备份失败，已中止：{e}"))?;
    } else {
        fs::create_dir_all(&backup).map_err(|e| format!("创建备份目录失败，已中止：{e}"))?;
    }

    let (imported, skipped, bytes) =
        merge_missing(old_dir, new_dir).map_err(|e| format!("导入失败（已备份原数据）：{e}"))?;
    append_record(
        new_dir,
        "migration.log",
        &format!(
            "import\tsource={}\tbackup={}\timported={imported}\tskipped={skipped}\tbytes={bytes}\tat={}",
            old_dir.to_string_lossy(),
            backup.to_string_lossy(),
            now_ms()
        ),
    );
    Ok(ImportReport {
        imported,
        skipped,
        bytes,
        backup_dir: backup.to_string_lossy().to_string(),
    })
}

fn merge_missing(src: &Path, dst: &Path) -> io::Result<(usize, usize, u64)> {
    fs::create_dir_all(dst)?;
    let mut imported = 0usize;
    let mut skipped = 0usize;
    let mut bytes = 0u64;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let path = entry.path();
        let meta = fs::metadata(&path)?;
        let target = dst.join(entry.file_name());
        if meta.is_dir() {
            let (i, s, b) = merge_missing(&path, &target)?;
            imported += i;
            skipped += s;
            bytes += b;
        } else if target.exists() {
            skipped += 1;
        } else {
            fs::copy(&path, &target)?;
            imported += 1;
            bytes += meta.len();
        }
    }
    Ok((imported, skipped, bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "renomio-migrate-test-{tag}-{}",
            now_ms()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn migrates_and_keeps_legacy_dir() {
        let root = temp_dir("ok");
        let old = root.join("old");
        let new = root.join("app.renomio.desktop");
        fs::create_dir_all(old.join("batches")).unwrap();
        fs::create_dir_all(old.join("backups/b1")).unwrap();
        fs::write(old.join("batches/b1.json"), "{\"id\":\"b1\"}").unwrap();
        fs::write(old.join("backups/b1/a.jpg"), b"12345").unwrap();

        let info = run(&old, &new, "Rename Studio", "Renomio");
        assert_eq!(info.status, "migrated");
        assert_eq!(info.files, 2);
        assert_eq!(info.bytes, 16);
        assert!(new.join("batches/b1.json").exists());
        assert!(new.join("backups/b1/a.jpg").exists());
        assert!(new.join("migration.json").exists());
        assert!(old.join("batches/b1.json").exists(), "旧目录不得被删除");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn does_not_touch_legacy_when_target_exists() {
        let root = temp_dir("both");
        let old = root.join("old");
        let new = root.join("app.renomio.desktop");
        fs::create_dir_all(old.join("batches")).unwrap();
        fs::create_dir_all(&new).unwrap();
        fs::write(old.join("batches/b1.json"), "{}").unwrap();
        fs::write(new.join("marker"), "new").unwrap();

        let info = run(&old, &new, "Rename Studio", "Renomio");
        assert_eq!(info.status, "skipped-both");
        assert!(new.join("marker").exists());
        assert!(!new.join("batches/b1.json").exists(), "并存时不得合并");
        assert!(old.join("batches/b1.json").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn migrated_journal_still_undoes() {
        use ffrn_core::rename::{ApplyItem, ApplyOptions};
        use ffrn_core::Core;

        let root = temp_dir("journal");
        let old = root.join("old");
        let new = root.join("app.renomio.desktop");
        fs::create_dir_all(&old).unwrap();
        let work = root.join("work");
        fs::create_dir_all(&work).unwrap();
        let src = work.join("a.txt");
        fs::write(&src, b"hi").unwrap();

        // 用真实 Core 在旧数据目录里执行一批改名，生成真实 journal
        let core = Core::new(&old);
        let outcome = core
            .apply(
                vec![ApplyItem {
                    id: "i1".into(),
                    source: src.to_string_lossy().to_string(),
                    target_name: "b.txt".into(),
                    is_dir: false,
                }],
                &ApplyOptions::default(),
            )
            .unwrap();
        let batch_id = outcome.batch.id.clone();
        assert!(work.join("b.txt").exists());

        // 迁移到新目录
        let info = run(&old, &new, "Rename Studio", "Renomio");
        assert_eq!(info.status, "migrated");

        // 迁移后仍能看到该批次并成功撤销（journal 里是绝对路径）
        let core2 = Core::new(&new);
        assert!(
            core2.batches().iter().any(|b| b.id == batch_id),
            "迁移后应能看到旧批次"
        );
        core2.undo(&batch_id).unwrap();
        assert!(work.join("a.txt").exists(), "迁移后的 journal 仍应能撤销");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn manual_import_backs_up_and_skips_existing() {
        let root = temp_dir("import");
        let old = root.join("old");
        let new = root.join("app.renomio.desktop");
        fs::create_dir_all(old.join("batches")).unwrap();
        fs::create_dir_all(new.join("batches")).unwrap();
        fs::write(old.join("batches/b1.json"), "{}").unwrap();
        fs::write(old.join("batches/b2.json"), "{}").unwrap();
        fs::write(new.join("batches/b1.json"), "{\"mine\":true}").unwrap();

        let report = import_legacy(&new, &old).unwrap();
        assert_eq!(report.imported, 1);
        assert_eq!(report.skipped, 1);
        let backup = PathBuf::from(&report.backup_dir);
        assert!(backup.join("batches/b1.json").exists(), "导入前必须备份当前数据");
        assert_eq!(
            fs::read_to_string(new.join("batches/b1.json")).unwrap(),
            "{\"mine\":true}",
            "已有文件不得被覆盖"
        );
        assert!(old.join("batches/b2.json").exists());
        let _ = fs::remove_dir_all(&root);
    }
}

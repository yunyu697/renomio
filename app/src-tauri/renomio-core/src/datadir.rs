//! 数据目录解析：便携模式（U 盘）与命令行/环境变量覆盖，全部收敛到一处。
//!
//! 优先级（高到低）：
//! 1. 命令行 `--data-dir <路径>`（或 `--data-dir=<路径>`）
//! 2. 环境变量 `RENOMIO_DATA_DIR`
//! 3. 程序所在目录存在便携标记 `renomio.portable`，且 `data` 子目录可用 → 便携模式
//! 4. 每用户数据目录（Windows `%APPDATA%\app.renomio.desktop`，macOS/Linux 对应目录）
//!
//! 便携标记存在但 `data` 子目录建不出来（例如 `data` 是个同名文件、或目录无写权限）时**不静默失败**：
//! 回落到每用户目录，并把原因写进 `note`，界面直接展示。

use std::fs;
use std::path::{Path, PathBuf};

/// 便携标记文件名：放在可执行文件旁边。
pub const PORTABLE_MARKER: &str = "renomio.portable";
/// 便携模式下数据落在程序旁边的子目录名。
pub const PORTABLE_SUBDIR: &str = "data";
/// 覆盖数据目录的环境变量名。
pub const ENV_KEY: &str = "RENOMIO_DATA_DIR";
/// 覆盖数据目录的命令行开关。
pub const CLI_FLAG: &str = "--data-dir";

/// 数据目录来源，供界面与日志说明「这套数据为什么在这个位置」。
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RootSource {
    /// 命令行 `--data-dir`
    CliArg,
    /// 环境变量 `RENOMIO_DATA_DIR`
    EnvVar,
    /// 程序旁边的 `renomio.portable`
    PortableMarker,
    /// 每用户数据目录
    OsDefault,
}

impl RootSource {
    pub fn as_str(self) -> &'static str {
        match self {
            RootSource::CliArg => "cli-arg",
            RootSource::EnvVar => "env-var",
            RootSource::PortableMarker => "portable-marker",
            RootSource::OsDefault => "os-default",
        }
    }
}

/// 解析结果。
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataRoot {
    /// 最终使用的数据目录（已做 `~` 之外的字符串原样保留，界面按需展示）。
    pub path: String,
    pub source: RootSource,
    /// 便携模式是否真的生效（标记存在但回落时为 false）。
    pub portable: bool,
    /// 回落/忽略原因；没有异常时为 `None`。
    pub note: Option<String>,
}

impl DataRoot {
    fn empty(path: impl Into<String>, source: RootSource) -> Self {
        Self {
            path: path.into(),
            source,
            portable: source == RootSource::PortableMarker,
            note: None,
        }
    }

    fn with_note(mut self, note: Option<String>) -> Self {
        self.note = note;
        self
    }
}

/// 从命令行参数里取 `--data-dir` 的值（兼容 `--data-dir=/x` 与 `--data-dir /x`）。
pub fn parse_cli_args<I, S>(args: I) -> Option<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut expect_value = false;
    for raw in args {
        let arg = raw.as_ref().trim();
        if expect_value {
            return non_empty(arg);
        }
        if arg == CLI_FLAG {
            expect_value = true;
            continue;
        }
        if let Some(rest) = arg.strip_prefix(CLI_FLAG) {
            if let Some(value) = rest.strip_prefix('=') {
                return non_empty(value);
            }
        }
    }
    None
}

fn non_empty(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.starts_with('-') {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// 便携标记是否放在 `exe_dir` 里。
pub fn portable_marker_path(exe_dir: &Path) -> PathBuf {
    exe_dir.join(PORTABLE_MARKER)
}

/// 目标目录是否真的能用来存数据：能建目录、能写一个探针文件再删掉。
pub fn usable_dir(dir: &Path) -> Result<(), String> {
    if let Some(parent) = dir.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("父目录不可创建：{e}"))?;
    }
    if dir.is_file() {
        return Err(format!("{} 是一个文件，不是目录", dir.display()));
    }
    fs::create_dir_all(dir).map_err(|e| format!("目录不可创建：{e}"))?;
    let probe = dir.join(format!(".renomio-probe-{}", std::process::id()));
    let write = fs::write(&probe, b"ok");
    let _ = fs::remove_file(&probe);
    write.map_err(|e| format!("目录不可写：{e}"))
}

/// 按优先级解析数据目录。`os_default` 由调用方给出（Tauri 的 `app_data_dir`），本函数不碰全局状态。
pub fn resolve(
    exe_dir: &Path,
    os_default: &Path,
    cli: Option<&str>,
    env: Option<&str>,
) -> DataRoot {
    if let Some(value) = cli.and_then(non_empty) {
        return DataRoot::empty(value, RootSource::CliArg);
    }
    if let Some(value) = env.and_then(non_empty) {
        return DataRoot::empty(value, RootSource::EnvVar);
    }
    let marker = portable_marker_path(exe_dir);
    if marker.is_file() {
        let target = exe_dir.join(PORTABLE_SUBDIR);
        return match usable_dir(&target) {
            Ok(()) => DataRoot::empty(target.to_string_lossy().to_string(), RootSource::PortableMarker),
            Err(err) => DataRoot::empty(
                os_default.to_string_lossy().to_string(),
                RootSource::OsDefault,
            )
            .with_note(Some(format!(
                "程序旁边有 {PORTABLE_MARKER}，但便携数据目录 {} 不可用（{err}），已回落到每用户目录",
                target.display()
            ))),
        };
    }
    DataRoot::empty(os_default.to_string_lossy().to_string(), RootSource::OsDefault)
}

/// 便携模式说明（给界面与日志共用的一句话）。
pub fn describe(root: &DataRoot) -> String {
    match (&root.source, root.portable, &root.note) {
        (_, _, Some(note)) => note.clone(),
        (RootSource::PortableMarker, true, None) => format!(
            "便携模式：数据写在程序旁边的 {} 文件夹，整个目录拷到 U 盘即可带走全部配置与历史",
            PORTABLE_SUBDIR
        ),
        (RootSource::CliArg, ..) => "数据目录由命令行 --data-dir 指定".to_string(),
        (RootSource::EnvVar, ..) => format!("数据目录由环境变量 {ENV_KEY} 指定"),
        (RootSource::OsDefault, ..) => "数据目录为每用户默认位置".to_string(),
        // 正常路径不会走到：标记存在但 portable=false 一定带 note（上面首个分支已拦下）
        (RootSource::PortableMarker, false, None) => {
            format!("便携标记存在，但便携数据目录 {} 未生效", PORTABLE_SUBDIR)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "renomio-datadir-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn cli_value_forms_are_both_accepted_and_empty_is_ignored() {
        let args = ["renomio.exe", "--data-dir", "D:\\portable"];
        assert_eq!(parse_cli_args(args), Some("D:\\portable".to_string()));
        let eq = ["renomio.exe", "--data-dir=E:/x"];
        assert_eq!(parse_cli_args(eq), Some("E:/x".to_string()));
        let empty = ["renomio.exe", "--data-dir="];
        assert_eq!(parse_cli_args(empty), None);
        let missing = ["renomio.exe", "--data-dir"];
        assert_eq!(parse_cli_args(missing), None);
    }

    #[test]
    fn cli_beats_env_beats_marker() {
        let exe = temp_dir("exe");
        let os_default = exe.join("os-default");
        fs::write(portable_marker_path(&exe), b"portable").unwrap();
        let root = resolve(&exe, &os_default, Some("C:/cli"), Some("C:/env"));
        assert_eq!(root.source, RootSource::CliArg);
        assert_eq!(root.path, "C:/cli");
        let env_only = resolve(&exe, &os_default, None, Some("C:/env"));
        assert_eq!(env_only.source, RootSource::EnvVar);
        assert_eq!(env_only.path, "C:/env");
    }

    #[test]
    fn portable_marker_redirects_into_exe_dir() {
        let exe = temp_dir("marker-exe");
        let os_default = exe.join("os-default");
        fs::write(portable_marker_path(&exe), b"portable").unwrap();
        let root = resolve(&exe, &os_default, None, None);
        assert_eq!(root.source, RootSource::PortableMarker);
        assert!(root.portable);
        assert_eq!(root.path, exe.join(PORTABLE_SUBDIR).to_string_lossy());
        assert!(root.note.is_none());
        assert!(Path::new(&root.path).is_dir());
    }

    #[test]
    fn unusable_portable_dir_falls_back_with_reason() {
        let exe = temp_dir("broken-exe");
        let os_default = exe.join("os-default");
        fs::write(portable_marker_path(&exe), b"portable").unwrap();
        // `data` 是同名文件：便携目录建不出来
        fs::write(exe.join(PORTABLE_SUBDIR), b"not a dir").unwrap();
        let root = resolve(&exe, &os_default, None, None);
        assert_eq!(root.source, RootSource::OsDefault);
        assert!(!root.portable);
        assert_eq!(root.path, os_default.to_string_lossy());
        let note = root.note.unwrap_or_default();
        assert!(note.contains(PORTABLE_MARKER), "{note}");
        assert!(note.contains("已回落到每用户目录"), "{note}");
    }

    #[test]
    fn without_marker_or_overrides_the_default_is_used() {
        let exe = temp_dir("plain-exe");
        let os_default = exe.join("os-default");
        let root = resolve(&exe, &os_default, None, None);
        assert_eq!(root.source, RootSource::OsDefault);
        assert!(!root.portable);
        assert_eq!(root.path, os_default.to_string_lossy());
        assert!(root.note.is_none());
    }

    #[test]
    fn serialization_is_camel_case_with_stable_source_values() {
        let root = DataRoot::empty("D:/data", RootSource::PortableMarker);
        let json = serde_json::to_string(&root).unwrap();
        assert!(json.contains("\"source\":\"portable-marker\""), "{json}");
        assert!(json.contains("\"portable\":true"), "{json}");
        assert!(json.contains("\"note\":null"), "{json}");
        for source in [
            RootSource::CliArg,
            RootSource::EnvVar,
            RootSource::PortableMarker,
            RootSource::OsDefault,
        ] {
            let json = serde_json::to_string(&source).unwrap();
            assert_eq!(json, format!("\"{}\"", source.as_str()));
        }
    }

    #[test]
    fn describe_explains_every_source() {
        let cases = [
            (RootSource::CliArg, false, None, "--data-dir"),
            (RootSource::EnvVar, false, None, ENV_KEY),
            (RootSource::PortableMarker, true, None, "便携模式"),
            (RootSource::OsDefault, false, None, "每用户默认位置"),
        ];
        for (source, portable, note, needle) in cases {
            let root = DataRoot::empty("x", source)
                .with_note(note)
                .clone();
            let root = DataRoot { portable, ..root };
            assert!(describe(&root).contains(needle), "{source:?}");
        }
        let fallback = DataRoot::empty("x", RootSource::OsDefault)
            .with_note(Some("标记存在但不可用".to_string()));
        assert_eq!(describe(&fallback), "标记存在但不可用");
    }
}

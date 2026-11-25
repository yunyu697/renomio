//! 数据目录契约（FEATURE-GAP 6.12「便携模式」）：优先级、便携标记、回落原因、序列化与写入链路。
//!
//! 全部用临时目录真实建/写，不依赖任何环境变量与用户目录。

use std::fs;
use std::path::{Path, PathBuf};

use renomio_core::datadir::{self, RootSource};
use renomio_core::Core;

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "renomio-datadir-contract-{tag}-{}-{}",
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
fn portable_marker_constants_are_the_documented_names() {
    assert_eq!(datadir::PORTABLE_MARKER, "renomio.portable");
    assert_eq!(datadir::PORTABLE_SUBDIR, "data");
    assert_eq!(datadir::ENV_KEY, "RENOMIO_DATA_DIR");
    assert_eq!(datadir::CLI_FLAG, "--data-dir");
    let exe = temp_dir("names");
    assert_eq!(
        datadir::portable_marker_path(&exe),
        exe.join("renomio.portable")
    );
}

#[test]
fn precedence_is_cli_then_env_then_marker_then_default() {
    let exe = temp_dir("precedence");
    let os_default = exe.join("os-default");
    fs::write(datadir::portable_marker_path(&exe), b"portable").unwrap();

    let all = datadir::resolve(&exe, &os_default, Some("C:/cli"), Some("C:/env"));
    assert_eq!(all.source, RootSource::CliArg);
    assert_eq!(all.path, "C:/cli");
    assert!(!all.portable);

    let env_only = datadir::resolve(&exe, &os_default, None, Some("C:/env"));
    assert_eq!(env_only.source, RootSource::EnvVar);
    assert_eq!(env_only.path, "C:/env");

    let marker_only = datadir::resolve(&exe, &os_default, Some("  "), Some(""));
    assert_eq!(marker_only.source, RootSource::PortableMarker);
    assert!(marker_only.portable);
    assert_eq!(
        marker_only.path,
        exe.join("data").to_string_lossy().to_string()
    );
}

#[test]
fn portable_mode_really_writes_into_the_exe_folder() {
    let exe = temp_dir("write");
    let os_default = exe.join("os-default");
    fs::write(datadir::portable_marker_path(&exe), b"portable").unwrap();
    let root = datadir::resolve(&exe, &os_default, None, None);
    let core = Core::new_at(root);
    let env = core.env(true);
    assert_eq!(env.data_dir, exe.join("data").to_string_lossy());
    assert_eq!(env.data_root_source, "portable-marker");
    assert!(env.portable);
    assert!(env.data_root_note.is_none());
    // 批次目录真的落在程序旁边，而不是每用户目录
    assert!(Path::new(&env.data_dir).is_dir());
    assert!(!Path::new(&env.data_dir).starts_with(&os_default));
}

#[test]
fn broken_portable_marker_falls_back_and_keeps_the_reason() {
    let exe = temp_dir("broken");
    let os_default = exe.join("os-default");
    fs::write(datadir::portable_marker_path(&exe), b"portable").unwrap();
    fs::write(exe.join("data"), b"same name as a file").unwrap();
    let root = datadir::resolve(&exe, &os_default, None, None);
    let env = Core::new_at(root).env(true);
    assert_eq!(env.data_root_source, "os-default");
    assert!(!env.portable);
    assert_eq!(env.data_dir, os_default.to_string_lossy());
    let note = env.data_root_note.unwrap_or_default();
    assert!(note.contains("renomio.portable"), "{note}");
    assert!(note.contains("回落到每用户目录"), "{note}");
}

#[test]
fn default_root_has_no_note_and_reports_os_default() {
    let exe = temp_dir("default");
    let os_default = exe.join("os-default");
    let env = Core::new_at(datadir::resolve(&exe, &os_default, None, None)).env(true);
    assert_eq!(env.data_root_source, "os-default");
    assert!(!env.portable);
    assert!(env.data_root_note.is_none());
    assert_eq!(env.data_dir, os_default.to_string_lossy());
}

#[test]
fn cli_and_env_overrides_are_labelled_in_env_info() {
    let exe = temp_dir("override");
    let os_default = exe.join("os-default");
    let cli_dir = exe.join("cli-data");
    let cli_env = Core::new_at(datadir::resolve(
        &exe,
        &os_default,
        Some(&cli_dir.to_string_lossy()),
        None,
    ))
    .env(true);
    assert_eq!(cli_env.data_root_source, "cli-arg");
    assert_eq!(cli_env.data_dir, cli_dir.to_string_lossy());
    assert!(!cli_env.portable);

    let env_dir = exe.join("env-data");
    let env_env = Core::new_at(datadir::resolve(
        &exe,
        &os_default,
        None,
        Some(&env_dir.to_string_lossy()),
    ))
    .env(true);
    assert_eq!(env_env.data_root_source, "env-var");
    assert_eq!(env_env.data_dir, env_dir.to_string_lossy());
}

#[test]
fn cli_parsing_covers_space_equals_and_malformed_forms() {
    assert_eq!(
        datadir::parse_cli_args(["renomio.exe", "--data-dir", "D:\\usb"]),
        Some("D:\\usb".to_string())
    );
    assert_eq!(
        datadir::parse_cli_args(["renomio.exe", "--data-dir=E:/usb"]),
        Some("E:/usb".to_string())
    );
    // 空值、缺值、把另一个开关当值时都不算数
    assert_eq!(datadir::parse_cli_args(["renomio.exe", "--data-dir="]), None);
    assert_eq!(datadir::parse_cli_args(["renomio.exe", "--data-dir"]), None);
    assert_eq!(
        datadir::parse_cli_args(["renomio.exe", "--data-dir", "--verbose"]),
        None
    );
    assert_eq!(datadir::parse_cli_args(["renomio.exe", "--minimized"]), None);
}

#[test]
fn usable_dir_probe_rejects_a_file_and_cleans_up_after_itself() {
    let dir = temp_dir("usable");
    let file = dir.join("as-file");
    fs::write(&file, b"x").unwrap();
    let err = datadir::usable_dir(&file).unwrap_err();
    assert!(err.contains("不是目录"), "{err}");

    let ok_dir = dir.join("nested/deeper");
    datadir::usable_dir(&ok_dir).unwrap();
    assert!(ok_dir.is_dir());
    let leftovers: Vec<_> = fs::read_dir(&ok_dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().starts_with(".renomio-probe-"))
        .collect();
    assert!(leftovers.is_empty(), "探针文件未清理：{:?}", leftovers);
}

#[test]
fn report_serializes_with_camel_case_fields_and_kebab_sources() {
    let exe = temp_dir("serde");
    let os_default = exe.join("os-default");
    fs::write(datadir::portable_marker_path(&exe), b"portable").unwrap();
    let root = datadir::resolve(&exe, &os_default, None, None);
    let json = serde_json::to_string(&root).unwrap();
    for key in ["\"path\"", "\"source\"", "\"portable\"", "\"note\""] {
        assert!(json.contains(key), "{json}");
    }
    assert!(json.contains("\"source\":\"portable-marker\""), "{json}");
    for (source, text) in [
        (RootSource::CliArg, "cli-arg"),
        (RootSource::EnvVar, "env-var"),
        (RootSource::PortableMarker, "portable-marker"),
        (RootSource::OsDefault, "os-default"),
    ] {
        assert_eq!(serde_json::to_string(&source).unwrap(), format!("\"{text}\""));
        assert_eq!(source.as_str(), text);
    }
}

#[test]
fn env_info_exposes_the_new_fields_to_the_ui() {
    let exe = temp_dir("envinfo");
    let os_default = exe.join("os-default");
    let env = Core::new_at(datadir::resolve(&exe, &os_default, None, None)).env(true);
    let json = serde_json::to_string(&env).unwrap();
    assert!(json.contains("\"dataRootSource\""), "{json}");
    assert!(json.contains("\"portable\""), "{json}");
    assert!(json.contains("\"dataRootNote\""), "{json}");
}

#[test]
fn describe_matches_each_source_in_plain_words() {
    let exe = temp_dir("describe");
    let os_default = exe.join("os-default");
    let cases: [(Option<&str>, Option<&str>, &str); 3] = [
        (Some("C:/cli"), None, "--data-dir"),
        (None, Some("C:/env"), "RENOMIO_DATA_DIR"),
        (None, None, "每用户默认位置"),
    ];
    for (cli, env, needle) in cases {
        let root = datadir::resolve(&exe, &os_default, cli, env);
        assert!(datadir::describe(&root).contains(needle), "{needle}");
    }
    fs::write(datadir::portable_marker_path(&exe), b"portable").unwrap();
    let portable = datadir::resolve(&exe, &os_default, None, None);
    assert!(datadir::describe(&portable).contains("便携模式"));
}

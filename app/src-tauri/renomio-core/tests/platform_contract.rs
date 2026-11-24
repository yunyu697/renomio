//! 跨平台能力契约（FEATURE-GAP 6.11）。
//!
//! 这个测试文件在 **Windows / macOS / Linux 三个真实 OS 上都跑**（CI 的 `cross-os` 矩阵），
//! 断言的是「当前平台的能力与文档写着的一致」：
//! - 平台识别、分隔符、大小写默认值、路径阈值；
//! - btime 三态（Windows 读写 / Linux 只读 / macOS 不支持）与随之给出的跳过原因；
//! - 隐藏·系统·存档属性的「仅 Windows」边界，以及非 Windows 上给出的原因文案；
//! - Windows 名称规则**与宿主 OS 无关**（Linux 上也能按 Windows 语义校验，反之亦然）；
//! - 只读位三平台都真的能设、能识别、能还原。
//!
//! 任何一处平台差异被改错（比如 macOS 被误报成 Linux、Linux 被误标成 btime 可写），
//! 都会在对应 OS 上失败。

use std::fs;
use std::path::PathBuf;

use renomio_core::platform::{self, AttrSupport, BtimeSupport, NamePolicy, Platform};

fn expected_os() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

fn expected_platform() -> Platform {
    if cfg!(target_os = "windows") {
        Platform::Windows
    } else if cfg!(target_os = "macos") {
        Platform::MacOs
    } else {
        Platform::Linux
    }
}

struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> Self {
        let mut path = std::env::temp_dir();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        path.push(format!(
            "renomio-platform-{tag}-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("建临时目录");
        TempDir(path)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn report_identifies_the_compile_target() {
    let report = platform::report();
    assert_eq!(report.os, expected_os(), "平台识别必须与编译目标一致");
    assert_eq!(Platform::current(), expected_platform());
    assert_eq!(Platform::current().as_str(), expected_os());
}

#[test]
fn separator_and_case_default_per_os() {
    let report = platform::report();
    if cfg!(windows) {
        assert_eq!(report.separator, '\\', "Windows 用反斜杠");
        assert!(!report.case_sensitive_default, "Windows 默认大小写不敏感");
    } else {
        assert_eq!(report.separator, '/', "UNIX 用正斜杠");
        assert_eq!(
            report.case_sensitive_default,
            cfg!(target_os = "linux"),
            "只有 Linux 默认大小写敏感，macOS 默认不敏感"
        );
    }
}

#[test]
fn case_probe_agrees_with_platform_defaults() {
    let dir = TempDir::new("case");
    let probed = platform::probe_case_sensitivity(&dir.0);
    if cfg!(windows) {
        assert!(!probed, "NTFS 必然大小写不敏感");
    }
    // 其它平台取决于文件系统（APFS 可能不敏感、ext4 敏感），只断言探测能给出确定结果，
    // 且与平台默认值一致时不会互相矛盾。
    if probed {
        assert!(
            Platform::current() != Platform::Windows,
            "Windows 上不应探测出大小写敏感"
        );
    }
}

#[test]
fn path_limits_are_documented_and_ordered() {
    let report = platform::report();
    match expected_platform() {
        Platform::Windows => {
            assert_eq!(report.path_warn_threshold, 240);
            assert_eq!(report.path_hard_limit, 32767);
            assert!(report.long_path_prefix, "Windows 必须自动加 \\\\?\\ 前缀");
        }
        Platform::MacOs => {
            assert_eq!(report.path_warn_threshold, 900);
            assert_eq!(report.path_hard_limit, 1024);
            assert!(!report.long_path_prefix);
        }
        Platform::Linux => {
            assert_eq!(report.path_warn_threshold, 3800);
            assert_eq!(report.path_hard_limit, 4096);
            assert!(!report.long_path_prefix);
        }
    }
    assert_eq!(report.component_limit, 255, "三平台单段上限统一 255");
    assert!(
        report.path_warn_threshold < report.path_hard_limit,
        "警告阈值必须小于硬上限"
    );
}

#[test]
fn btime_contract_per_os() {
    let report = platform::report();
    match expected_platform() {
        Platform::Windows => {
            assert_eq!(report.btime, BtimeSupport::ReadWrite);
            assert!(platform::can_read_btime() && platform::can_write_btime());
            assert!(report.btime_skip_reason.is_none(), "可写时不该给跳过原因");
        }
        Platform::Linux => {
            assert_eq!(report.btime, BtimeSupport::ReadOnly);
            assert!(platform::can_read_btime(), "Linux 能读 statx btime");
            assert!(!platform::can_write_btime(), "Linux 没有写回 btime 的 syscall");
            let reason = report.btime_skip_reason.expect("必须给出原因");
            assert!(reason.contains("Linux"), "原因要写明平台：{reason}");
            assert!(reason.contains("不支持写回"));
        }
        Platform::MacOs => {
            assert_eq!(report.btime, BtimeSupport::Unsupported);
            assert!(!platform::can_read_btime() && !platform::can_write_btime());
            let reason = report.btime_skip_reason.expect("必须给出原因");
            assert!(reason.contains("macOS"), "原因要写明平台：{reason}");
        }
    }
    assert_eq!(report.btime.as_str(), report.btime.as_str().to_lowercase());
}

#[test]
fn windows_only_attributes_are_bounded() {
    let report = platform::report();
    if cfg!(windows) {
        assert!(report.windows_only_attrs);
        assert!(report.windows_only_attrs_reason.is_none());
        assert_eq!(report.readonly_attr, AttrSupport::ReadWrite);
    } else {
        assert!(!report.windows_only_attrs, "隐藏/系统/存档位仅 Windows");
        let reason = report
            .windows_only_attrs_reason
            .expect("非 Windows 必须给出原因，不能静默");
        assert_eq!(reason, "当前平台不支持隐藏/系统/存档属性（仅 Windows）");
        assert_eq!(
            report.readonly_attr,
            AttrSupport::ReadonlyOnly,
            "UNIX 只有只读位可写"
        );
    }
}

#[test]
fn attribute_write_on_non_windows_fails_loudly() {
    // 非 Windows 上申请「隐藏」必须逐条失败并带原因，而不是假装成功。
    let dir = TempDir::new("attrs");
    let file = dir.0.join("sample.txt");
    fs::write(&file, b"x").expect("写样本");
    let spec = renomio_core::ops::AttrSpec {
        readonly: None,
        hidden: Some(renomio_core::ops::AttrAction::Set),
        system: None,
        archive: None,
    };
    let store = renomio_core::journal::BatchStore::new(&dir.0.join("journal"));
    let outcome = renomio_core::ops::apply_attrs(
        &store,
        vec![renomio_core::ops::OpTarget {
            id: "a".into(),
            path: file.to_string_lossy().to_string(),
            is_dir: false,
        }],
        &spec,
    )
    .expect("apply_attrs 不应整体报错");
    if cfg!(windows) {
        assert_eq!(outcome.failed.len(), 0, "Windows 上隐藏属性应可写");
        assert_eq!(outcome.applied.len(), 1, "Windows 上应真的应用一条");
    } else {
        assert_eq!(outcome.applied.len(), 0, "非 Windows 不该有任何“已应用”");
        assert_eq!(outcome.failed.len(), 1);
        assert!(
            outcome.failed[0].reason.contains("仅 Windows"),
            "失败原因要写明仅 Windows：{}",
            outcome.failed[0].reason
        );
    }
}

#[test]
fn readonly_flag_roundtrips_on_this_os() {
    let dir = TempDir::new("readonly");
    let file = dir.0.join("ro.txt");
    fs::write(&file, b"body").expect("写样本");
    let before = fs::metadata(&file).expect("metadata");
    assert!(!platform::is_readonly(&before), "新文件默认可写");

    set_readonly(&file, true);
    let locked = fs::metadata(&file).expect("metadata");
    assert!(platform::is_readonly(&locked), "置只读后必须识别为只读");

    set_readonly(&file, false);
    let again = fs::metadata(&file).expect("metadata");
    assert!(!platform::is_readonly(&again), "还原后可写");
    fs::remove_file(&file).expect("清样本");
}

fn set_readonly(path: &std::path::Path, on: bool) {
    let meta = fs::metadata(path).expect("metadata");
    let mut perms = meta.permissions();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = perms.mode();
        perms.set_mode(if on { mode & !0o222 } else { mode | 0o600 });
    }
    #[cfg(not(unix))]
    {
        perms.set_readonly(on);
    }
    fs::set_permissions(path, perms).expect("set_permissions");
}

#[test]
fn windows_name_rules_are_host_independent() {
    // 不管宿主是哪个 OS，windows_safe 策略都必须按 Windows 语义拒绝。
    let strict = NamePolicy::new(expected_platform(), true);
    for bad in ["a:b.txt", "CON.txt", "report.", "a*b.txt"] {
        let issues = platform::validate_component(bad, strict);
        assert!(
            !issues.is_empty(),
            "windows_safe 策略必须拒绝 {bad}（宿主 {}）",
            expected_os()
        );
    }
    assert!(platform::validate_component("ok-中文-01.txt", strict).is_empty());

    // 反之，非 Windows 平台原生策略允许冒号（Linux/macOS 文件名里合法）。
    let native = NamePolicy::new(Platform::Linux, false);
    assert!(
        platform::validate_component("a:b.txt", native).is_empty(),
        "Linux 原生策略应允许冒号"
    );
    assert!(platform::is_reserved_windows_name("con"));
    assert!(platform::is_reserved_windows_name("LPT9.txt"));
    assert!(!platform::is_reserved_windows_name("console"));
}

#[test]
fn native_path_adds_prefix_only_on_windows() {
    let plain = PathBuf::from(if cfg!(windows) {
        "D:\\renomio\\sample"
    } else {
        "/tmp/renomio/sample"
    });
    let mapped = platform::native_path(&plain);
    if cfg!(windows) {
        let text = mapped.to_string_lossy();
        assert!(text.starts_with("\\\\?\\"), "Windows 绝对路径要加长路径前缀");
        // 再加一次也不能叠成 `\\?\\\?\`
        let twice = platform::native_path(&mapped);
        assert_eq!(twice, mapped, "已带前缀时不重复添加");
    } else {
        assert_eq!(mapped, plain, "UNIX 原样返回");
    }
    // 相对路径不加前缀（加了会改变语义）
    let rel = PathBuf::from("relative.txt");
    assert_eq!(platform::native_path(&rel), rel);
}

#[test]
fn report_serializes_with_stable_field_names() {
    let value = serde_json::to_value(platform::report()).expect("报告可序列化");
    for key in [
        "os",
        "separator",
        "case_sensitive_default",
        "long_path_prefix",
        "path_warn_threshold",
        "path_hard_limit",
        "component_limit",
        "btime",
        "btime_skip_reason",
        "readonly_attr",
        "windows_only_attrs",
        "windows_only_attrs_reason",
        "summary",
    ] {
        assert!(value.get(key).is_some(), "JSON 缺字段 {key}");
    }
    assert_eq!(value["os"], expected_os());
    assert_eq!(
        value["btime"],
        match expected_platform() {
            Platform::Windows => "readwrite",
            Platform::Linux => "readonly",
            Platform::MacOs => "unsupported",
        },
        "btime 序列化口径要与探针/前端一致"
    );
}

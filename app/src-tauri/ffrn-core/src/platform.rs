//! 平台差异：路径语义、非法字符、保留名、长度、大小写探测、长路径前缀。

use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Windows,
    #[serde(alias = "macos")]
    MacOs,
    Linux,
}

/// btime（创建时间）的跨平台能力三态。
///
/// 关键事实：Linux 的 `statx` 能读 `STATX_BTIME`，但**没有任何 syscall 可以写回 btime**，
/// 所以 Linux 的正确语义是「只读、不可撤销」，而不是「实现坏了」。
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BtimeSupport {
    /// 可读可写（Windows：NTFS 通过 SetFileTime 写回）
    ReadWrite,
    /// 可读（是否真的有值取决于文件系统是否暴露 btime），但不可写
    ReadOnly,
    /// 读写都不支持（macOS：标准 API 没有可移植的 btime 写回，本轮尚未验证，按不支持处理）
    Unsupported,
}

impl BtimeSupport {
    pub fn can_read(self) -> bool {
        !matches!(self, BtimeSupport::Unsupported)
    }

    pub fn can_write(self) -> bool {
        matches!(self, BtimeSupport::ReadWrite)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            BtimeSupport::ReadWrite => "read-write",
            BtimeSupport::ReadOnly => "read-only",
            BtimeSupport::Unsupported => "unsupported",
        }
    }

    /// btime 无法写回时给用户/日志看的原因；可写时返回 None。
    pub fn skip_reason(self) -> Option<&'static str> {
        match self {
            BtimeSupport::ReadWrite => None,
            BtimeSupport::ReadOnly => {
                Some("创建时间（btime）在 Linux 上不支持写回，撤销时已跳过该字段")
            }
            BtimeSupport::Unsupported => {
                Some("创建时间（btime）在 macOS 上尚未实现写回，撤销时已跳过该字段")
            }
        }
    }
}

pub fn btime_support() -> BtimeSupport {
    match Platform::current() {
        Platform::Windows => BtimeSupport::ReadWrite,
        Platform::Linux => BtimeSupport::ReadOnly,
        Platform::MacOs => BtimeSupport::Unsupported,
    }
}

pub fn can_read_btime() -> bool {
    btime_support().can_read()
}

pub fn can_write_btime() -> bool {
    btime_support().can_write()
}

impl Platform {
    pub fn current() -> Self {
        #[cfg(target_os = "windows")]
        {
            Platform::Windows
        }
        #[cfg(target_os = "macos")]
        {
            Platform::MacOs
        }
        #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
        {
            Platform::Linux
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Platform::Windows => "windows",
            Platform::MacOs => "macos",
            Platform::Linux => "linux",
        }
    }

    pub fn separator(self) -> char {
        if self == Platform::Windows {
            '\\'
        } else {
            '/'
        }
    }

    /// 各平台默认的大小写敏感性（实际值由 Core 启动时探测）
    pub fn default_case_sensitive(self) -> bool {
        self == Platform::Linux
    }

    pub fn component_limit(self) -> usize {
        255
    }

    /// 全路径提示阈值；超过后 UI 给出琥珀色警告
    pub fn path_warn_threshold(self) -> usize {
        match self {
            Platform::Windows => 240,
            Platform::MacOs => 900,
            Platform::Linux => 3800,
        }
    }

    pub fn path_hard_limit(self) -> usize {
        match self {
            Platform::Windows => 32767,
            Platform::MacOs => 1024,
            Platform::Linux => 4096,
        }
    }
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct NameIssue {
    /// block = 不能执行；warn = 可执行但提示
    pub severity: &'static str,
    pub code: &'static str,
    pub message: String,
    pub detail: Option<String>,
}

impl NameIssue {
    fn block(code: &'static str, message: impl Into<String>, detail: Option<String>) -> Self {
        Self {
            severity: "block",
            code,
            message: message.into(),
            detail,
        }
    }
    fn warn(code: &'static str, message: impl Into<String>, detail: Option<String>) -> Self {
        Self {
            severity: "warn",
            code,
            message: message.into(),
            detail,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct NamePolicy {
    pub platform: Platform,
    /// true = 采用 Windows 安全字符集（默认），保证方案在三大平台都能落地
    pub windows_safe: bool,
}

impl NamePolicy {
    pub fn new(platform: Platform, windows_safe: bool) -> Self {
        Self {
            platform,
            windows_safe,
        }
    }
    fn strict(self) -> bool {
        self.platform == Platform::Windows || self.windows_safe
    }
}

const WINDOWS_RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "CLOCK$", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
    "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

pub fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

pub fn is_reserved_windows_name(name: &str) -> bool {
    let stem = match name.rfind('.') {
        Some(idx) if idx > 0 => &name[..idx],
        _ => name,
    };
    let upper = stem.trim().to_ascii_uppercase();
    WINDOWS_RESERVED.contains(&upper.as_str())
}

/// 校验单个文件/文件夹名（不含父路径）
pub fn validate_component(name: &str, policy: NamePolicy) -> Vec<NameIssue> {
    let mut issues = Vec::new();
    if name.is_empty() {
        issues.push(NameIssue::block("empty", "名称为空", None));
        return issues;
    }
    if name == "." || name == ".." {
        issues.push(NameIssue::block("dot", "名称不能是 . 或 ..", None));
        return issues;
    }

    for ch in name.chars() {
        if (ch as u32) < 0x20 || ch == '\u{7f}' {
            issues.push(NameIssue::block(
                "control",
                "名称包含控制字符",
                Some(format!("U+{:04X}", ch as u32)),
            ));
            break;
        }
    }

    if policy.strict() {
        const INVALID: &[char] = &['<', '>', ':', '"', '|', '?', '*', '/', '\\'];
        if let Some(ch) = name.chars().find(|c| INVALID.contains(c)) {
            issues.push(NameIssue::block(
                "invalid_char",
                format!("名称包含非法字符 “{}”", ch),
                Some("Windows 安全字符集".into()),
            ));
        }
        if name.ends_with(' ') || name.ends_with('.') {
            issues.push(NameIssue::block(
                "trailing",
                "名称不能以空格或点结尾",
                Some("Windows 会拒绝此类名称".into()),
            ));
        }
        if is_reserved_windows_name(name) {
            issues.push(NameIssue::block(
                "reserved",
                "名称是系统保留名",
                Some("CON / PRN / AUX / NUL / COM1-9 / LPT1-9".into()),
            ));
        }
    } else if name.contains(['/', '\0']) {
        issues.push(NameIssue::block(
            "invalid_char",
            "名称包含路径分隔符或空字符",
            None,
        ));
    }

    match policy.platform {
        Platform::Linux => {
            let bytes = name.len();
            if bytes > policy.platform.component_limit() {
                issues.push(NameIssue::block(
                    "too_long",
                    format!("名称 {bytes} 字节，超过 Linux 单段上限 255 字节"),
                    None,
                ));
            }
        }
        _ => {
            let units = utf16_len(name);
            if units > policy.platform.component_limit() {
                issues.push(NameIssue::block(
                    "too_long",
                    format!("名称 {units} 个字符，超过单段上限 255"),
                    None,
                ));
            }
        }
    }

    issues
}

/// 全路径长度：warning 级别，不阻断（Windows 使用 \\?\ 前缀越过 260）
pub fn path_length_issue(path: &Path, policy: NamePolicy) -> Option<NameIssue> {
    let display = path.to_string_lossy();
    let len = if policy.platform == Platform::Linux {
        display.len()
    } else {
        utf16_len(&display)
    };
    if len > policy.platform.path_hard_limit() {
        return Some(NameIssue::block(
            "path_too_long",
            format!(
                "完整路径 {len} 字符，超过平台上限 {}",
                policy.platform.path_hard_limit()
            ),
            None,
        ));
    }
    if len > policy.platform.path_warn_threshold() {
        return Some(NameIssue::warn(
            "path_long",
            format!("完整路径 {len} 字符，接近平台上限"),
            Some(format!(
                "阈值 {} 字符",
                policy.platform.path_warn_threshold()
            )),
        ));
    }
    None
}

/// 探测目录所在文件系统是否区分大小写（true = 区分）
pub fn probe_case_sensitivity(dir: &Path) -> bool {
    use std::time::{SystemTime, UNIX_EPOCH};
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let upper = dir.join(format!("FFRN-CASE-PROBE-{stamp}.tmp"));
    let lower = dir.join(format!("ffrn-case-probe-{stamp}.tmp"));
    if std::fs::write(&upper, b"probe").is_err() {
        return Platform::current().default_case_sensitive();
    }
    let exists_lower = lower.exists();
    let _ = std::fs::remove_file(&upper);
    !exists_lower
}

/// Windows 长路径前缀；其它平台原样返回
pub fn native_path(path: &Path) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let text = path.to_string_lossy();
        if text.starts_with("\\\\?\\") || !path.is_absolute() {
            return path.to_path_buf();
        }
        if let Some(rest) = text.strip_prefix("\\\\") {
            return PathBuf::from(format!("\\\\?\\UNC\\{rest}"));
        }
        // 普通路径也可能超过 260，统一加前缀最稳（不改变语义）
        return PathBuf::from(format!("\\\\?\\{text}"));
    }
    #[cfg(not(target_os = "windows"))]
    {
        path.to_path_buf()
    }
}

pub fn canonical_display(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

pub fn is_readonly(meta: &std::fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o222 == 0
    }
    #[cfg(not(unix))]
    {
        meta.permissions().readonly()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_windows_specific_names() {
        let p = NamePolicy::new(Platform::Windows, true);
        assert!(validate_component("a:b.txt", p)
            .iter()
            .any(|i| i.code == "invalid_char"));
        assert!(validate_component("CON.txt", p)
            .iter()
            .any(|i| i.code == "reserved"));
        assert!(validate_component("report.", p)
            .iter()
            .any(|i| i.code == "trailing"));
        assert!(validate_component("ok-中文.txt", p).is_empty());
    }

    #[test]
    fn linux_native_allows_colon() {
        let p = NamePolicy::new(Platform::Linux, false);
        assert!(validate_component("a:b.txt", p).is_empty());
        let strict = NamePolicy::new(Platform::Linux, true);
        assert!(!validate_component("a:b.txt", strict).is_empty());
    }

    #[test]
    fn long_component_is_blocked() {
        let p = NamePolicy::new(Platform::Linux, false);
        let name = "汉".repeat(100); // 300 bytes
        assert!(validate_component(&name, p)
            .iter()
            .any(|i| i.code == "too_long"));
    }
}

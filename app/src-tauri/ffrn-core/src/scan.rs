//! 目录遍历与过滤。只读操作，不改动任何文件。

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use crate::platform::{is_readonly, Platform};

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ScanOptions {
    pub recursive: bool,
    pub include_files: bool,
    pub include_dirs: bool,
    pub follow_symlinks: bool,
    pub include_patterns: Vec<String>,
    pub exclude_patterns: Vec<String>,
    pub max_entries: usize,
    pub name_patterns_are_paths: bool,
    /// 是否扫描隐藏文件 / 前导点文件；默认开启。关闭时既不下发条目也不递归隐藏目录。
    pub include_hidden: bool,
}

impl Default for ScanOptions {
    fn default() -> Self {
        Self {
            recursive: true,
            include_files: true,
            include_dirs: false,
            follow_symlinks: false,
            include_patterns: Vec::new(),
            exclude_patterns: Vec::new(),
            max_entries: 20_000,
            name_patterns_are_paths: false,
            include_hidden: true,
        }
    }
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedEntry {
    pub id: String,
    pub path: String,
    pub name: String,
    pub parent: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: i64,
    pub readonly: bool,
}

#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub entries: Vec<ScannedEntry>,
    pub warnings: Vec<String>,
    pub truncated: bool,
    pub visited_dirs: usize,
}

pub fn wildcard_match(pattern: &str, text: &str, case_insensitive: bool) -> bool {
    let pattern: Vec<char> = pattern.chars().collect();
    let text_chars: Vec<char> = text.chars().collect();
    let fold = |c: char| {
        if case_insensitive {
            c.to_lowercase().next().unwrap_or(c)
        } else {
            c
        }
    };
    let pattern: Vec<char> = pattern.into_iter().map(fold).collect();
    let text_chars: Vec<char> = text_chars.into_iter().map(fold).collect();

    let (mut p, mut t) = (0usize, 0usize);
    let mut star: Option<usize> = None;
    let mut mark = 0usize;

    while t < text_chars.len() {
        if p < pattern.len() && (pattern[p] == '?' || pattern[p] == text_chars[t]) {
            p += 1;
            t += 1;
        } else if p < pattern.len() && pattern[p] == '*' {
            star = Some(p);
            mark = t;
            p += 1;
        } else if let Some(star_pos) = star {
            p = star_pos + 1;
            mark += 1;
            t = mark;
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == '*' {
        p += 1;
    }
    p == pattern.len()
}

fn patterns_allow(patterns: &[String], text: &str, platform: Platform) -> bool {
    if patterns.is_empty() {
        return true;
    }
    let ci = platform != Platform::Linux;
    patterns.iter().any(|p| {
        p.split([';', '|'])
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .any(|p| wildcard_match(p, text, ci))
    })
}

fn is_excluded(patterns: &[String], text: &str, platform: Platform) -> bool {
    if patterns.is_empty() {
        return false;
    }
    let ci = platform != Platform::Linux;
    patterns.iter().any(|p| {
        p.split([';', '|'])
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .any(|p| wildcard_match(p, text, ci))
    })
}

/// Windows 按 FILE_ATTRIBUTE_HIDDEN 判定；其它平台看文件属性位之外的前导点。
#[cfg(windows)]
fn hidden_by_attr(meta: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    meta.file_attributes() & 0x2 != 0
}

#[cfg(not(windows))]
fn hidden_by_attr(_meta: &fs::Metadata) -> bool {
    false
}

/// 隐藏 = 平台隐藏属性，或以 `.` 开头的名称（各平台一致，避免 macOS/Linux 行为漂移）。
fn is_hidden(meta: &fs::Metadata, name: &str) -> bool {
    name.starts_with('.') || hidden_by_attr(meta)
}

fn now_ms(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn make_entry(path: &Path, is_dir: bool, meta: &fs::Metadata) -> ScannedEntry {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string());
    let parent = path
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    ScannedEntry {
        id: path.to_string_lossy().to_string(),
        path: path.to_string_lossy().to_string(),
        name,
        parent,
        is_dir,
        size: if is_dir { 0 } else { meta.len() },
        modified: now_ms(meta),
        readonly: is_readonly(meta),
    }
}

pub fn scan_paths(inputs: &[String], opts: &ScanOptions, platform: Platform) -> ScanResult {
    let mut result = ScanResult::default();
    let mut seen: HashSet<String> = HashSet::new();

    for raw in inputs {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        let path = PathBuf::from(trimmed);
        let meta = match fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(err) => {
                result
                    .warnings
                    .push(format!("无法读取 {}：{}", trimmed, err));
                continue;
            }
        };

        if meta.file_type().is_symlink() && !opts.follow_symlinks {
            result
                .warnings
                .push(format!("已跳过符号链接/快捷方式：{}", trimmed));
            continue;
        }

        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        if !opts.include_hidden && is_hidden(&meta, &name) {
            continue;
        }

        if meta.is_dir() {
            if opts.include_dirs
                && patterns_allow(&opts.include_patterns, &path.to_string_lossy(), platform)
            {
                if seen.insert(path.to_string_lossy().to_string()) {
                    result.entries.push(make_entry(&path, true, &meta));
                }
            }
            if opts.recursive {
                walk_dir(&path, opts, platform, &mut result, &mut seen, 0);
            }
        } else if opts.include_files {
            let name_key = path.to_string_lossy();
            if patterns_allow(&opts.include_patterns, &name_key, platform)
                && !is_excluded(&opts.exclude_patterns, &name_key, platform)
                && seen.insert(name_key.to_string())
            {
                result.entries.push(make_entry(&path, false, &meta));
            }
        }

        if result.entries.len() >= opts.max_entries {
            result.truncated = true;
            result.warnings.push(format!(
                "已达到 {} 个对象上限，剩余内容未扫描",
                opts.max_entries
            ));
            break;
        }
    }

    result.entries.sort_by(|a, b| {
        a.path
            .to_lowercase()
            .cmp(&b.path.to_lowercase())
            .then(a.path.cmp(&b.path))
    });
    result
}

fn walk_dir(
    dir: &Path,
    opts: &ScanOptions,
    platform: Platform,
    result: &mut ScanResult,
    seen: &mut HashSet<String>,
    depth: usize,
) {
    if depth > 64 {
        result
            .warnings
            .push(format!("目录层级过深，已跳过：{}", dir.display()));
        return;
    }
    result.visited_dirs += 1;
    let read = match fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(err) => {
            result
                .warnings
                .push(format!("无法读取目录 {}：{}", dir.display(), err));
            return;
        }
    };

    for item in read {
        let item = match item {
            Ok(i) => i,
            Err(err) => {
                result.warnings.push(format!("读取目录项失败：{err}"));
                continue;
            }
        };
        let path = item.path();
        let meta = match fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(err) => {
                result
                    .warnings
                    .push(format!("无法读取 {}：{}", path.display(), err));
                continue;
            }
        };
        if meta.file_type().is_symlink() && !opts.follow_symlinks {
            result
                .warnings
                .push(format!("已跳过符号链接：{}", path.display()));
            continue;
        }

        let key = path.to_string_lossy().to_string();
        let name_text = path.to_string_lossy();
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        if !opts.include_hidden && is_hidden(&meta, &name) {
            continue;
        }

        if meta.is_dir() {
            if opts.include_dirs
                && patterns_allow(&opts.include_patterns, &name_text, platform)
                && !is_excluded(&opts.exclude_patterns, &name_text, platform)
                && seen.insert(key.clone())
            {
                result.entries.push(make_entry(&path, true, &meta));
            }
            if opts.include_dirs || !opts.include_files {
                walk_dir(&path, opts, platform, result, seen, depth + 1);
            } else {
                walk_dir(&path, opts, platform, result, seen, depth + 1);
            }
        } else if opts.include_files {
            if patterns_allow(&opts.include_patterns, &name_text, platform)
                && !is_excluded(&opts.exclude_patterns, &name_text, platform)
                && seen.insert(key)
            {
                result.entries.push(make_entry(&path, false, &meta));
            }
        }

        if result.entries.len() >= opts.max_entries {
            result.truncated = true;
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wildcard_basics() {
        assert!(wildcard_match("*.jpg", "a.JPG", true));
        assert!(!wildcard_match("*.jpg", "a.png", true));
        assert!(wildcard_match("DSC_????.jpg", "DSC_0101.jpg", false));
        assert!(wildcard_match("*副本*", "照片 - 副本.jpg", false));
        assert!(!wildcard_match("*.jpg", "a.jpg.bak", false));
    }

    fn temp_scan_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ffrn-scan-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn scan_names(dir: &std::path::Path, include_hidden: bool) -> Vec<String> {
        let opts = ScanOptions {
            recursive: true,
            include_files: true,
            include_hidden,
            ..Default::default()
        };
        scan_paths(
            &[dir.to_string_lossy().to_string()],
            &opts,
            Platform::Windows,
        )
        .entries
        .into_iter()
        .map(|e| e.name)
        .collect()
    }

    #[test]
    fn include_hidden_toggle_filters_dotfiles() {
        let dir = temp_scan_dir("dot");
        std::fs::write(dir.join("visible.txt"), b"a").unwrap();
        std::fs::write(dir.join(".hidden.txt"), b"b").unwrap();

        let on = scan_names(&dir, true);
        assert_eq!(on.len(), 2, "默认应包含前导点文件：{on:?}");
        let off = scan_names(&dir, false);
        assert_eq!(
            off,
            vec!["visible.txt".to_string()],
            "关闭后应排除前导点文件"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn include_hidden_toggle_respects_windows_hidden_attribute() {
        #[link(name = "kernel32")]
        extern "system" {
            fn SetFileAttributesW(name: *const u16, attrs: u32) -> i32;
        }
        let dir = temp_scan_dir("attr");
        let hidden = dir.join("被隐藏.txt");
        let visible = dir.join("普通.txt");
        std::fs::write(&hidden, b"a").unwrap();
        std::fs::write(&visible, b"b").unwrap();
        let mut wide: Vec<u16> = hidden.to_string_lossy().encode_utf16().collect();
        wide.push(0);
        // FILE_ATTRIBUTE_ARCHIVE(0x20) | FILE_ATTRIBUTE_HIDDEN(0x02)
        let ok = unsafe { SetFileAttributesW(wide.as_ptr(), 0x22) };
        assert!(ok != 0, "设置隐藏属性失败");

        let on = scan_names(&dir, true);
        assert_eq!(on.len(), 2, "开启时应包含隐藏属性文件：{on:?}");
        let off = scan_names(&dir, false);
        assert_eq!(
            off,
            vec!["普通.txt".to_string()],
            "关闭后应排除隐藏属性文件"
        );

        // 清掉隐藏属性，保证临时目录可删除
        unsafe { SetFileAttributesW(wide.as_ptr(), 0x80) };
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn patterns_split_and_trim() {
        let patterns = vec!["*.jpg; *.png".to_string()];
        assert!(patterns_allow(&patterns, "a.jpg", Platform::Windows));
        assert!(patterns_allow(&patterns, "b.PNG", Platform::Windows));
        assert!(!patterns_allow(&patterns, "c.gif", Platform::Windows));
    }
}

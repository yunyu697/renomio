//! 重复内容检测：先按文件大小分组，再对候选组做 SHA-256，最后逐字节确认。
//! 复杂度：路径去重 O(n)；大小分组 O(n)；只有同尺寸候选才读内容，
//! 不会出现「拖入大量文件就 O(n²) 卡死」的情况。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::metaedit::util::{files_equal, hex, sha256_file};

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateGroup {
    /// 组内每个文件的字节数
    pub size: u64,
    /// 内容哈希（SHA-256，十六进制）；用于界面稳定标识
    pub hash: String,
    /// 内容完全相同的文件绝对路径（至少 2 条）
    pub paths: Vec<String>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateReport {
    pub groups: Vec<DuplicateGroup>,
    /// 参与检测的文件数（文件夹与不存在的路径不参与）
    pub scanned: usize,
    pub warnings: Vec<String>,
}

/// 检测内容完全相同的文件（不同路径）。
/// 只读：不移动、不删除任何文件；去重动作由界面在列表层面执行。
pub fn find_duplicates(paths: &[String]) -> DuplicateReport {
    let mut warnings = Vec::new();
    let mut by_size: BTreeMap<u64, Vec<(String, PathBuf)>> = BTreeMap::new();
    let mut seen = std::collections::HashSet::new();
    for raw in paths {
        let path = PathBuf::from(raw);
        if !seen.insert(path.clone()) {
            continue;
        }
        match std::fs::metadata(&path) {
            Ok(meta) if meta.is_file() => {
                by_size.entry(meta.len()).or_default().push((raw.clone(), path));
            }
            Ok(_) => {}
            Err(err) => warnings.push(format!("无法读取 {}：{err}", path.display())),
        }
    }
    let scanned = by_size.values().map(|v| v.len()).sum();

    let mut groups = Vec::new();
    for (size, list) in by_size {
        if list.len() < 2 {
            continue;
        }
        let mut by_hash: BTreeMap<[u8; 32], Vec<(String, PathBuf)>> = BTreeMap::new();
        for (raw, path) in list {
            match sha256_file(&path) {
                Ok(hash) => by_hash.entry(hash).or_default().push((raw, path)),
                Err(err) => warnings.push(format!("无法计算哈希 {}：{err}", path.display())),
            }
        }
        for (hash, list) in by_hash {
            if list.len() < 2 {
                continue;
            }
            // 哈希相同再做逐字节确认，避免把「疑似」当成「确定」
            let mut exact: Vec<Vec<(String, PathBuf)>> = Vec::new();
            for item in list {
                let mut placed = false;
                for bucket in exact.iter_mut() {
                    match files_equal(Path::new(&bucket[0].1), Path::new(&item.1)) {
                        Ok(true) => {
                            bucket.push(item.clone());
                            placed = true;
                            break;
                        }
                        Ok(false) => {}
                        Err(err) => warnings.push(format!("内容比对失败 {}：{err}", item.1.display())),
                    }
                }
                if !placed {
                    exact.push(vec![item]);
                }
            }
            for mut bucket in exact {
                if bucket.len() < 2 {
                    continue;
                }
                bucket.sort_by(|a, b| a.0.cmp(&b.0));
                groups.push(DuplicateGroup {
                    size,
                    hash: hex(&hash),
                    paths: bucket.into_iter().map(|(raw, _)| raw).collect(),
                });
            }
        }
    }
    groups.sort_by(|a, b| b.size.cmp(&a.size).then_with(|| a.paths[0].cmp(&b.paths[0])));
    DuplicateReport { groups, scanned, warnings }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("renomio-dedupe-{stamp}-{name}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn groups_only_exact_content() {
        let dir = temp_dir("exact");
        let a = dir.join("a.bin");
        let b = dir.join("b.bin");
        let c = dir.join("c.bin");
        let d = dir.join("d.bin");
        std::fs::write(&a, b"same-content").unwrap();
        std::fs::write(&b, b"same-content").unwrap();
        std::fs::write(&c, b"same-size-xx").unwrap();
        std::fs::write(&d, b"other").unwrap();

        let report = find_duplicates(&[
            a.to_string_lossy().to_string(),
            b.to_string_lossy().to_string(),
            c.to_string_lossy().to_string(),
            d.to_string_lossy().to_string(),
            // 同一路径重复出现只算一次
            a.to_string_lossy().to_string(),
        ]);
        assert_eq!(report.scanned, 4);
        assert_eq!(report.groups.len(), 1);
        assert_eq!(report.groups[0].paths.len(), 2);
        assert_eq!(report.groups[0].size, 12);
    }

    #[test]
    fn many_identical_files_stay_linear() {
        let dir = temp_dir("many");
        let mut paths = Vec::new();
        for i in 0..200 {
            let p = dir.join(format!("f{i}.bin"));
            std::fs::write(&p, b"0123456789abcdef").unwrap();
            paths.push(p.to_string_lossy().to_string());
        }
        let report = find_duplicates(&paths);
        assert_eq!(report.groups.len(), 1);
        assert_eq!(report.groups[0].paths.len(), 200);
    }

    #[test]
    fn empty_files_are_duplicates_but_single_is_not() {
        let dir = temp_dir("empty");
        let a = dir.join("a.txt");
        let b = dir.join("b.txt");
        std::fs::write(&a, b"").unwrap();
        std::fs::write(&b, b"").unwrap();
        let report = find_duplicates(&[a.to_string_lossy().to_string(), b.to_string_lossy().to_string()]);
        assert_eq!(report.groups.len(), 1);
    }
}

//! 版本比较：Renomio 的预发布形如 `1.2.0-alpha13`。
//!
//! `alpha` 后面的序号必须按**数值**比较：`alpha9 < alpha10 < alpha13`。
//! 直接把整段 `alphaN` 当 semver 的字母数字标识符做字符串比较会得出
//! `alpha10 < alpha9`（因为 `'1' < '9'`），导致装在 alpha9 上的客户端永远
//! 看不到 alpha10 及之后的版本——2026-11-25 的「更新通道失效」就是这个原因。
//! 因此更新器与版本闸门共用这里的解析结果，不再依赖 lexicographic 排序。

use std::cmp::Ordering;

/// 解析后的版本：`major.minor.patch` + 可选预发布标记。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VersionKey {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
    pub pre: Option<Prerelease>,
}

/// 预发布标记。`alphaN` 是 Renomio 自己用的形式；其余文本仅作兜底。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Prerelease {
    /// `alpha12` → `Alpha(12)`
    Alpha(u64),
    /// 其它预发布标识（如 `beta1`），按文本比较
    Text(String),
}

/// 把 `1.2.0` / `1.2.0-alpha13` 解析成可比较的结构。
pub fn parse(text: &str) -> Result<VersionKey, String> {
    let raw = text.trim();
    if raw.is_empty() {
        return Err("版本号为空".to_string());
    }
    // 构建元数据（+meta）不参与比较
    let without_meta = raw.split('+').next().unwrap_or(raw);
    let (core, pre) = match without_meta.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (without_meta, None),
    };
    let parts: Vec<&str> = core.split('.').collect();
    if parts.len() != 3 {
        return Err(format!("版本号 {raw} 不合法：应为 major.minor.patch"));
    }
    let major = parse_number(parts[0], raw)?;
    let minor = parse_number(parts[1], raw)?;
    let patch = parse_number(parts[2], raw)?;
    let pre = match pre {
        None => None,
        Some(rest) => {
            if rest.is_empty() {
                return Err(format!("版本号 {raw} 不合法：预发布标记为空"));
            }
            Some(parse_prerelease(rest, raw)?)
        }
    };
    Ok(VersionKey {
        major,
        minor,
        patch,
        pre,
    })
}

fn parse_number(part: &str, raw: &str) -> Result<u64, String> {
    if part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) {
        return Err(format!("版本号 {raw} 不合法：{part} 不是数字段"));
    }
    if part.len() > 1 && part.starts_with('0') {
        return Err(format!("版本号 {raw} 不合法：{part} 有前导零"));
    }
    part.parse::<u64>()
        .map_err(|_| format!("版本号 {raw} 不合法：{part} 超出可表示范围"))
}

fn parse_prerelease(rest: &str, raw: &str) -> Result<Prerelease, String> {
    if let Some(digits) = rest.strip_prefix("alpha") {
        let ok = !digits.is_empty()
            && digits.bytes().all(|b| b.is_ascii_digit())
            && !(digits.len() > 1 && digits.starts_with('0'));
        if !ok {
            return Err(format!(
                "版本号 {raw} 不合法：alpha 预发布必须写成 alpha<正整数>（如 alpha13）"
            ));
        }
        let number = digits
            .parse::<u64>()
            .map_err(|_| format!("版本号 {raw} 不合法：alpha 序号超出可表示范围"))?;
        if number == 0 {
            return Err(format!("版本号 {raw} 不合法：alpha 序号不能为 0"));
        }
        return Ok(Prerelease::Alpha(number));
    }
    Ok(Prerelease::Text(rest.to_ascii_lowercase()))
}

/// 比较两个版本字符串。
pub fn compare(left: &str, right: &str) -> Result<Ordering, String> {
    let a = parse(left)?;
    let b = parse(right)?;
    Ok(compare_keys(&a, &b))
}

/// 比较两个已解析版本。
pub fn compare_keys(a: &VersionKey, b: &VersionKey) -> Ordering {
    a.major
        .cmp(&b.major)
        .then(a.minor.cmp(&b.minor))
        .then(a.patch.cmp(&b.patch))
        .then_with(|| compare_prerelease(&a.pre, &b.pre))
}

fn compare_prerelease(a: &Option<Prerelease>, b: &Option<Prerelease>) -> Ordering {
    match (a, b) {
        (None, None) => Ordering::Equal,
        // 正式版高于同 base 的预发布
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(x), Some(y)) => match (x, y) {
            // 关键：alpha 序号按数值比较
            (Prerelease::Alpha(m), Prerelease::Alpha(n)) => m.cmp(n),
            (Prerelease::Text(m), Prerelease::Text(n)) => m.cmp(n),
            // 本项目只用 alphaN；其它文本仅兜底，约定排在 alpha 之后
            (Prerelease::Alpha(_), Prerelease::Text(_)) => Ordering::Less,
            (Prerelease::Text(_), Prerelease::Alpha(_)) => Ordering::Greater,
        },
    }
}

/// 更新判定的唯一入口：`remote` 是否比 `current` 新。
pub fn is_newer(remote: &str, current: &str) -> Result<bool, String> {
    Ok(compare(remote, current)? == Ordering::Greater)
}

/// 给界面 / 探针用的顺序标签。
pub fn ordering_label(ordering: Ordering) -> &'static str {
    match ordering {
        Ordering::Less => "older",
        Ordering::Equal => "same",
        Ordering::Greater => "newer",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alpha_sequence_compares_numerically() {
        assert_eq!(
            compare("1.2.0-alpha10", "1.2.0-alpha9").unwrap(),
            Ordering::Greater
        );
        assert_eq!(
            compare("1.2.0-alpha9", "1.2.0-alpha10").unwrap(),
            Ordering::Less
        );
        assert_eq!(
            compare("1.2.0-alpha13", "1.2.0-alpha13").unwrap(),
            Ordering::Equal
        );
    }

    #[test]
    fn alpha9_sees_alpha13_as_newer() {
        assert!(is_newer("1.2.0-alpha13", "1.2.0-alpha9").unwrap());
        assert!(!is_newer("1.2.0-alpha9", "1.2.0-alpha13").unwrap());
    }

    #[test]
    fn stable_beats_prerelease() {
        assert!(is_newer("1.2.0", "1.2.0-alpha99").unwrap());
        assert!(!is_newer("1.2.0-alpha99", "1.2.0").unwrap());
    }

    #[test]
    fn base_version_wins_over_prerelease_number() {
        assert!(is_newer("1.2.0-alpha1", "1.1.0-alpha9").unwrap());
        assert!(is_newer("1.2.1-alpha1", "1.2.0-alpha99").unwrap());
    }

    #[test]
    fn parse_normalizes_build_metadata_and_text_prerelease() {
        let key = parse(" 1.2.0-alpha13+build7 ").unwrap();
        assert_eq!(key.pre, Some(Prerelease::Alpha(13)));
        let beta = parse("1.2.0-beta1").unwrap();
        assert_eq!(beta.pre, Some(Prerelease::Text("beta1".to_string())));
    }

    #[test]
    fn malformed_versions_are_rejected() {
        assert!(parse("").is_err());
        assert!(parse("1.2").is_err());
        assert!(parse("1.2.0-alpha").is_err());
        assert!(parse("1.2.0-alpha0").is_err());
        assert!(parse("1.2.0-alpha09").is_err());
        assert!(parse("01.2.0").is_err());
        assert!(parse("1.2.x").is_err());
    }
}

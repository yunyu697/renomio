//! 版本比较契约：`alpha` 序号必须按数值比较，alpha9 必须看到 alpha10 及之后。
//!
//! 这批断言钉住 2026-11-25 的「更新通道失效」回归：旧实现直接把 `alphaN`
//! 当 semver 的字母数字标识符做字符串比较，`alpha10 < alpha9`，于是装在
//! alpha9 的客户端永远认为已是最新。任何回退都会让本文件失败。

use std::cmp::Ordering;

use renomio_core::version::{self, Prerelease, VersionKey};

#[test]
fn alpha_suffix_is_compared_as_a_number() {
    assert_eq!(
        version::compare("1.2.0-alpha9", "1.2.0-alpha10").unwrap(),
        Ordering::Less
    );
    assert_eq!(
        version::compare("1.2.0-alpha10", "1.2.0-alpha9").unwrap(),
        Ordering::Greater
    );
    assert_eq!(
        version::compare("1.2.0-alpha12", "1.2.0-alpha13").unwrap(),
        Ordering::Less
    );
    assert_eq!(
        version::compare("1.2.0-alpha19", "1.2.0-alpha20").unwrap(),
        Ordering::Less
    );
}

#[test]
fn installed_alpha9_sees_alpha13_as_an_update() {
    // 真实场景：用户机器装的是 1.2.0-alpha9，清单是 1.2.0-alpha13
    assert!(version::is_newer("1.2.0-alpha13", "1.2.0-alpha9").unwrap());
    // 反向必须为假，避免「降级也算更新」
    assert!(!version::is_newer("1.2.0-alpha9", "1.2.0-alpha13").unwrap());
    // 同版本不算更新
    assert!(!version::is_newer("1.2.0-alpha13", "1.2.0-alpha13").unwrap());
}

#[test]
fn every_alpha_after_nine_is_newer_than_nine() {
    for n in 10..=20u64 {
        let remote = format!("1.2.0-alpha{n}");
        assert!(
            version::is_newer(&remote, "1.2.0-alpha9").unwrap(),
            "{remote} 应比 1.2.0-alpha9 新"
        );
    }
}

#[test]
fn rc_suffix_is_numeric_and_sits_between_alpha_and_stable() {
    assert_eq!(
        version::compare("1.3.0-RC2", "1.3.0-RC10").unwrap(),
        Ordering::Less
    );
    assert!(version::is_newer("1.3.0-RC1", "1.3.0-alpha99").unwrap());
    assert!(version::is_newer("1.3.0-RC1", "1.2.0-alpha38").unwrap());
    assert!(version::is_newer("1.3.0", "1.3.0-RC1").unwrap());
    assert!(!version::is_newer("1.3.0-RC1", "1.3.0").unwrap());
}

#[test]
fn rc_parse_accepts_uppercase_and_lowercase() {
    assert_eq!(
        version::parse("1.3.0-RC1").unwrap().pre,
        Some(Prerelease::Rc(1))
    );
    assert_eq!(
        version::parse("1.3.0-rc2").unwrap().pre,
        Some(Prerelease::Rc(2))
    );
}

#[test]
fn stable_release_outranks_any_alpha_of_the_same_base() {
    assert!(version::is_newer("1.2.0", "1.2.0-alpha99").unwrap());
    assert!(!version::is_newer("1.2.0-alpha99", "1.2.0").unwrap());
    assert!(!version::is_newer("1.2.0", "1.2.0").unwrap());
}

#[test]
fn major_minor_patch_dominate_prerelease_number() {
    assert!(version::is_newer("1.2.0-alpha1", "1.1.0-alpha99").unwrap());
    assert!(version::is_newer("1.3.0-alpha1", "1.2.0").unwrap());
    assert!(version::is_newer("2.0.0-alpha1", "1.9.9").unwrap());
}

#[test]
fn parse_extracts_alpha_number_and_ignores_build_metadata() {
    let key: VersionKey = version::parse(" 1.2.0-alpha13+build.7 ").unwrap();
    assert_eq!(key.major, 1);
    assert_eq!(key.minor, 2);
    assert_eq!(key.patch, 0);
    assert_eq!(key.pre, Some(Prerelease::Alpha(13)));
}

#[test]
fn text_prerelease_is_supported_and_sorted_after_alpha() {
    let beta = version::parse("1.2.0-beta1").unwrap();
    assert_eq!(beta.pre, Some(Prerelease::Text("beta1".to_string())));
    // 本项目只用 alphaN；其它文本预发布排在 alpha 之后，_稳定版_ 排最后
    assert_eq!(
        version::compare("1.2.0-beta1", "1.2.0-alpha13").unwrap(),
        Ordering::Greater
    );
    assert!(version::is_newer("1.2.0", "1.2.0-beta1").unwrap());
}

#[test]
fn malformed_versions_are_rejected_with_the_offending_text() {
    for bad in [
        "",
        "1.2",
        "1.2.0.0",
        "1.2.0-alpha",
        "1.2.0-alpha0",
        "1.2.0-alpha09",
        "1.3.0-RC",
        "1.3.0-RC0",
        "1.3.0-RC01",
        "01.2.0",
        "1.2.x",
    ] {
        let err = version::parse(bad).unwrap_err();
        if !bad.is_empty() {
            assert!(err.contains(bad.trim()), "错误信息应带原文：{err}");
        }
    }
}

#[test]
fn ordering_labels_are_stable() {
    assert_eq!(version::ordering_label(Ordering::Less), "older");
    assert_eq!(version::ordering_label(Ordering::Equal), "same");
    assert_eq!(version::ordering_label(Ordering::Greater), "newer");
}

#[test]
fn compare_keys_matches_compare_on_strings() {
    let a = version::parse("1.2.0-alpha13").unwrap();
    let b = version::parse("1.2.0-alpha9").unwrap();
    assert_eq!(
        version::compare_keys(&a, &b),
        version::compare("1.2.0-alpha13", "1.2.0-alpha9").unwrap()
    );
}

#[test]
fn probe_example_is_the_documented_entry_point() {
    // 文档与脚本都引用这个探针路径；改文件名会让机器验证失效
    let probe = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("examples/version_probe.rs");
    assert!(probe.exists(), "缺少 examples/version_probe.rs：{}", probe.display());
    let source = std::fs::read_to_string(&probe).unwrap();
    assert!(source.contains("--pair"), "探针必须支持 --pair 参数");
    assert!(
        source.contains("renomio_core::version::compare"),
        "探针必须调用 core 的 version::compare，不能自己再实现一遍比较"
    );
}

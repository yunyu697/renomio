//! 设置文件 INI 编解码的平台契约：任何平台、任何构建都必须满足以下行为。
//!
//! 这些断言对着「真实设置形状」写，而不是玩具结构——设置里有空字符串、中文、
//! 带连字符的对象键、数组里套对象、对象里套数组，这些边角只要漏一个，
//! 用户导出的设置再导入就变形。

use renomio_core::ini;
use serde_json::{json, Value};

fn settings_shape() -> Value {
    json!({
        "theme": "system",
        "palette": "graphite",
        "language": "zh-CN",
        "strictWindowsNames": true,
        "nameMaxLength": 255,
        "invalidReplacement": "_",
        "emptyNameFallback": "未命名",
        "userVars": ["", "剧名", "", "", "", "", "", "", ""],
        "userVar0": "",
        "shortcuts": { "focusSearch": "Ctrl+Shift+F", "toggleRules": "Ctrl+Shift+R" },
        "columns": { "name": true, "size": false },
        "columnWidths": {},
        "rules": [
            {
                "id": "r1",
                "type": "replace",
                "enabled": true,
                "pattern": "第(\\d+)集",
                "replacement": "Ep$1",
                "caseSensitive": true,
                "keywords": ["片头", "片尾"]
            },
            {
                "id": "r2",
                "type": "case",
                "enabled": false,
                "mode": "title",
                "exceptions": ["OK", "iPhone"]
            }
        ],
        "ruleUi": { "expanded": ["r1"], "openId": null, "collapsed": false },
        "layout": {
            "view": "files-left",
            "advanced": false,
            "side": 400,
            "stack": 320,
            "sizes": { "files-left": 400, "rules-left": 400 },
            "compactOpen": false
        }
    })
}

#[test]
fn real_settings_survive_round_trip() {
    let value = settings_shape();
    let back = ini::round_trip(&value).expect("往返必须成功");
    assert_eq!(back, value, "设置结构往返后必须逐键一致");
}

#[test]
fn text_is_sectioned_and_human_editable() {
    let text = ini::to_ini(&settings_shape()).unwrap();
    assert!(text.starts_with("; Renomio"), "文件要以说明注释开头：{text}");
    assert!(text.contains("[@root]"), "顶层标量要有 [@root] 分节：{text}");
    assert!(text.contains("[rules]"), "规则数组要独立成分节：{text}");
    assert!(text.contains("[0].type = replace") || text.contains("[0].type = \"replace\""));
    assert!(text.contains("nameMaxLength = 255"), "数字要裸写：{text}");
    assert!(text.contains("emptyNameFallback = 未命名"), "中文要裸写，不污染可读性：{text}");
}

#[test]
fn empty_containers_keep_their_kind() {
    let value = json!({ "columnWidths": {}, "tags": [], "nested": { "inner": [] } });
    let back = ini::round_trip(&value).unwrap();
    assert_eq!(back, value);
    let text = ini::to_ini(&value).unwrap();
    assert!(text.contains("columnWidths = {}"), "{text}");
    assert!(text.contains("tags = []"), "{text}");
}

#[test]
fn strings_that_look_like_scalars_are_quoted() {
    let value = json!({
        "invalidReplacement": "=",
        "emptyNameFallback": "false",
        "blank": "",
        "padded": " x ",
        "multiline": "第一行\n第二行",
        "quoted": "带\"引号\"和\\反斜杠",
        "semicolon": "; 不是注释",
        "numberish": "007"
    });
    let back = ini::round_trip(&value).unwrap();
    assert_eq!(back, value, "会被读错类型的字符串必须加引号");
    let text = ini::to_ini(&value).unwrap();
    assert!(text.contains("invalidReplacement = \"=\""));
    assert!(text.contains("multiline = \"第一行\\n第二行\""));
}

#[test]
fn bare_numbers_and_booleans_infer_correctly() {
    let text = "[@root]\nflag = true\ncount = 42\nratio = 0.5\nname = abc\n";
    let value = ini::from_ini(text).unwrap();
    assert_eq!(value, json!({ "flag": true, "count": 42, "ratio": 0.5, "name": "abc" }));
}

#[test]
fn duplicate_key_reports_line_number() {
    let err = ini::from_ini("[a]\nx = 1\nx = 2\n").unwrap_err();
    assert!(err.contains("第 3 行"), "{err}");
    assert!(err.contains("重复"), "{err}");
    assert!(err.contains('x'), "错误信息要带原文键名：{err}");
}

#[test]
fn key_before_any_section_is_rejected() {
    let err = ini::from_ini("theme = dark\n").unwrap_err();
    assert!(err.contains("第 1 行"), "{err}");
    assert!(err.contains("分节之前"), "{err}");
}

#[test]
fn bad_array_index_reports_line_number() {
    let err = ini::from_ini("[rules]\n[0].type = replace\n[2].type = case\n").unwrap_err();
    assert!(err.contains("第 3 行"), "{err}");
    assert!(err.contains("跳号"), "{err}");

    let err = ini::from_ini("[rules]\n[x].type = replace\n").unwrap_err();
    assert!(err.contains("整数"), "{err}");

    let err = ini::from_ini("[rules]\n[0].type = replace\n[0].type = case\n").unwrap_err();
    assert!(err.contains("第 3 行"), "{err}");
    assert!(err.contains("重复"), "{err}");
}

#[test]
fn unterminated_quote_and_value_noise_are_rejected() {
    let err = ini::from_ini("[a]\nnote = \"没闭合\n").unwrap_err();
    assert!(err.contains("第 2 行"), "{err}");
    assert!(err.contains("未闭合"), "{err}");

    let err = ini::from_ini("[a]\nnote = \"闭合\" 多余\n").unwrap_err();
    assert!(err.contains("第 2 行"), "{err}");
    assert!(err.contains("多余内容"), "{err}");
}

#[test]
fn comments_crlf_and_blank_lines_are_ignored() {
    let lf = "; 顶部注释\n\n[a]\n# 另一种注释\nx = 1\n";
    let crlf = lf.replace('\n', "\r\n");
    let from_lf = ini::from_ini(lf).unwrap();
    let from_crlf = ini::from_ini(&crlf).unwrap();
    assert_eq!(from_lf, json!({ "a": { "x": 1 } }));
    assert_eq!(from_crlf, from_lf, "CRLF 与 LF 必须等价");
    // BOM 也不能把第一行弄坏
    let with_bom = format!("\u{feff}{lf}");
    assert_eq!(ini::from_ini(&with_bom).unwrap(), from_lf);
}

#[test]
fn top_level_array_gets_its_own_section() {
    let value = json!({ "tags": ["a", "b"], "theme": "dark" });
    let text = ini::to_ini(&value).unwrap();
    assert!(text.contains("[tags]"), "{text}");
    assert!(text.contains("[0] = a"), "{text}");
    assert_eq!(ini::from_ini(&text).unwrap(), value);
}

#[test]
fn illegal_section_names_are_rejected() {
    let err = ini::from_ini("[a b]\nx = 1\n").unwrap_err();
    assert!(err.contains("非法字符"), "{err}");
    let err = ini::from_ini("[a\nx = 1\n").unwrap_err();
    assert!(err.contains("右方括号"), "{err}");
    let err = ini::from_ini("[]\n").unwrap_err();
    assert!(err.contains("分节名为空"), "{err}");
}

#[test]
fn non_object_input_is_rejected() {
    assert!(ini::to_ini(&json!([])).is_err());
    assert!(ini::to_ini(&json!("x")).is_err());
    assert!(ini::to_ini(&json!(3)).is_err());
}

#[test]
fn probe_exposes_bidirectional_contract() {
    let probe = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/examples/ini_probe.rs"))
        .expect("探针源码必须存在");
    assert!(probe.contains("--roundtrip"), "探针要支持往返模式");
    assert!(probe.contains("renomio_core::ini"), "探针必须走 core 的实现，不能自己写一套");
    assert!(probe.contains("ini::to_ini") && probe.contains("ini::from_ini"), "探针要双向都覆盖");
}

#[test]
fn settings_sections_are_stable_for_diffing() {
    // 同一份设置连续导出两次必须字节一致，否则用户拿去做版本对比会满屏假差异
    let a = ini::to_ini(&settings_shape()).unwrap();
    let b = ini::to_ini(&settings_shape()).unwrap();
    assert_eq!(a, b);
    // 键按字典序排列：只看真正的分节头行（形如 `[name]`，不含等号）
    let mut sorted: Vec<&str> = a
        .lines()
        .map(|l| l.trim())
        .filter(|l| l.starts_with('[') && l.ends_with(']') && !l.contains('='))
        .collect();
    let before = sorted.clone();
    sorted.sort();
    assert_eq!(before, sorted, "分节要按名字排序");
}

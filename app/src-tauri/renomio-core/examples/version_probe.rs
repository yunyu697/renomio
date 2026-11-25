//! 版本比较探针：把「谁比谁新」打成 JSON，供脚本逐条比对。
//!
//! 用法：
//!   cargo run --example version_probe -- --pair 1.2.0-alpha13 1.2.0-alpha9
//!   cargo run --example version_probe -- --compare 1.2.0-alpha13 1.2.0-alpha12
//!
//! 输出：`{"pairs":[{"remote":...,"current":...,"newer":true,"order":"newer"}],"compare":{...}}`

use std::process::exit;

fn main() {
    let mut args = std::env::args().skip(1).peekable();
    let mut pairs: Vec<(String, String)> = Vec::new();
    let mut compare: Option<(String, String)> = None;

    while let Some(flag) = args.next() {
        match flag.as_str() {
            "--pair" => {
                let remote = args.next().unwrap_or_default();
                let current = args.next().unwrap_or_default();
                pairs.push((remote, current));
            }
            "--compare" => {
                let left = args.next().unwrap_or_default();
                let right = args.next().unwrap_or_default();
                compare = Some((left, right));
            }
            other => {
                eprintln!("未知参数：{other}");
                exit(2);
            }
        }
    }

    if pairs.is_empty() && compare.is_none() {
        eprintln!("用法：--pair <remote> <current> … 或 --compare <left> <right>");
        exit(2);
    }

    let mut out = String::from("{\n");
    out.push_str("  \"pairs\": [\n");
    for (index, (remote, current)) in pairs.iter().enumerate() {
        let entry = match renomio_core::version::compare(remote, current) {
            Ok(ordering) => format!(
                "    {{\"remote\":{},\"current\":{},\"newer\":{},\"order\":\"{}\"}}",
                quote(remote),
                quote(current),
                renomio_core::version::ordering_label(ordering) == "newer",
                renomio_core::version::ordering_label(ordering)
            ),
            Err(err) => format!(
                "    {{\"remote\":{},\"current\":{},\"error\":{}}}",
                quote(remote),
                quote(current),
                quote(&err)
            ),
        };
        out.push_str(&entry);
        out.push_str(if index + 1 < pairs.len() { ",\n" } else { "\n" });
    }
    out.push_str("  ],\n");
    out.push_str("  \"compare\": ");
    match compare {
        Some((left, right)) => match renomio_core::version::compare(&left, &right) {
            Ok(ordering) => out.push_str(&format!(
                "{{\"left\":{},\"right\":{},\"order\":\"{}\"}}\n",
                quote(&left),
                quote(&right),
                renomio_core::version::ordering_label(ordering)
            )),
            Err(err) => out.push_str(&format!(
                "{{\"left\":{},\"right\":{},\"error\":{}}}\n",
                quote(&left),
                quote(&right),
                quote(&err)
            )),
        },
        None => out.push_str("null\n"),
    }
    out.push_str("}\n");
    println!("{out}");
}

fn quote(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_else(|_| "\"\"".to_string())
}

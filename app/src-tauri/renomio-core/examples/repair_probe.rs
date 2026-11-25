//! 数据目录自检探针：给自测脚本与人工排查用，输出 JSON 便于机器判定。
//!
//! 用法：
//!   repair_probe check <数据目录>              只检查，打印 Report JSON
//!   repair_probe fix <数据目录> [now_ms]       检查并修，打印 Report JSON
//! 退出码：0 = 结果里没有 error 级发现；1 = 仍有 error；2 = 参数错误。

use std::path::PathBuf;

use renomio_core::repair;
use serde_json::json;

fn usage() -> String {
    "用法：repair_probe check <dir> | repair_probe fix <dir> [now_ms]".to_string()
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(report_json) => {
            let ok = serde_json::from_str::<serde_json::Value>(&report_json)
                .ok()
                .and_then(|v| v.get("ok").and_then(|x| x.as_bool()))
                .unwrap_or(false);
            println!("{report_json}");
            if !ok {
                std::process::exit(1);
            }
        }
        Err(err) => {
            println!("{}", json!({ "ok": false, "error": err }));
            std::process::exit(2);
        }
    }
}

fn run(args: &[String]) -> Result<String, String> {
    match args.first().map(|s| s.as_str()) {
        Some("check") | Some("fix") => {}
        _ => return Err(usage()),
    }
    let mode = args[0].as_str();
    let root = PathBuf::from(args.get(1).ok_or_else(usage)?);
    let report = if mode == "check" {
        repair::check(&root)
    } else {
        let now = match args.get(2) {
            Some(raw) => raw
                .parse::<i64>()
                .map_err(|_| format!("now_ms 不是整数：{raw}"))?,
            None => renomio_core::journal::now_ms(),
        };
        repair::fix(&root, now)
    };
    serde_json::to_string(&report).map_err(|err| err.to_string())
}

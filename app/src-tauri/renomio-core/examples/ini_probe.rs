//! INI 编解码探针：给自测脚本与人工排查用，输出 JSON 便于机器判定。
//!
//! 用法：
//!   ini_probe --to <settings.json> --out <settings.ini>   写出 INI
//!   ini_probe --from <settings.ini> --out <settings.json> 解析回 JSON
//!   ini_probe --roundtrip <settings.json>                 往返比对（不一致退出码 1）
//! 无参数时打印用法并退出码 2。

use std::path::PathBuf;

use renomio_core::ini;
use serde_json::{json, Value};

fn usage() -> String {
    "用法：ini_probe --to <json> [--out <ini>] | --from <ini> [--out <json>] | --roundtrip <json>".to_string()
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(out) => println!("{}", out),
        Err(err) => {
            println!("{}", json!({ "ok": false, "error": err }));
            std::process::exit(if args.is_empty() { 2 } else { 1 });
        }
    }
}

fn run(args: &[String]) -> Result<String, String> {
    if args.is_empty() {
        return Err(usage());
    }
    let mut mode = "";
    let mut input: Option<PathBuf> = None;
    let mut output: Option<PathBuf> = None;
    let mut i = 0usize;
    while i < args.len() {
        match args[i].as_str() {
            "--to" => {
                mode = "to";
                input = Some(PathBuf::from(args.get(i + 1).ok_or("--to 缺少文件路径")?));
                i += 2;
            }
            "--from" => {
                mode = "from";
                input = Some(PathBuf::from(args.get(i + 1).ok_or("--from 缺少文件路径")?));
                i += 2;
            }
            "--roundtrip" => {
                mode = "roundtrip";
                input = Some(PathBuf::from(args.get(i + 1).ok_or("--roundtrip 缺少文件路径")?));
                i += 2;
            }
            "--out" => {
                output = Some(PathBuf::from(args.get(i + 1).ok_or("--out 缺少文件路径")?));
                i += 2;
            }
            other => return Err(format!("无法识别的参数：{other}（{}）", usage())),
        }
    }
    let input = input.ok_or_else(usage)?;

    match mode {
        "to" => {
            let raw = std::fs::read_to_string(&input).map_err(|err| format!("读取 {} 失败：{err}", input.display()))?;
            let value: Value = serde_json::from_str(&raw).map_err(|err| format!("JSON 解析失败：{err}"))?;
            let text = ini::to_ini(&value)?;
            let lines = text.lines().filter(|l| l.contains('=')).count();
            let sections = text.lines().filter(|l| l.starts_with('[')).count();
            if let Some(path) = &output {
                std::fs::write(path, text.as_bytes()).map_err(|err| format!("写入 {} 失败：{err}", path.display()))?;
            }
            Ok(json!({ "ok": true, "lines": lines, "sections": sections, "path": output.map(|p| p.display().to_string()) }).to_string())
        }
        "from" => {
            let text = std::fs::read_to_string(&input).map_err(|err| format!("读取 {} 失败：{err}", input.display()))?;
            let value = ini::from_ini(&text)?;
            let keys = value.as_object().map(|o| o.len()).unwrap_or(0);
            if let Some(path) = &output {
                std::fs::write(path, serde_json::to_vec_pretty(&value).map_err(|err| err.to_string())?)
                    .map_err(|err| format!("写入 {} 失败：{err}", path.display()))?;
            }
            Ok(json!({ "ok": true, "keys": keys, "path": output.map(|p| p.display().to_string()) }).to_string())
        }
        "roundtrip" => {
            let raw = std::fs::read_to_string(&input).map_err(|err| format!("读取 {} 失败：{err}", input.display()))?;
            let value: Value = serde_json::from_str(&raw).map_err(|err| format!("JSON 解析失败：{err}"))?;
            let back = ini::round_trip(&value)?;
            let same = back == value;
            let text = ini::to_ini(&value)?;
            Ok(json!({
                "ok": same,
                "same": same,
                "lines": text.lines().filter(|l| l.contains('=')).count(),
                "sections": text.lines().filter(|l| l.starts_with('[')).count(),
            })
            .to_string())
        }
        _ => Err(usage()),
    }
}

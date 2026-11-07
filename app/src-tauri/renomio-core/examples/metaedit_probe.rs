//! 真实文件验证用的命令行探针（不参与 Tauri 打包）。
//!
//! 用法：
//!   cargo run -q -p renomio-core --example metaedit_probe -- read <path>
//!   cargo run -q -p renomio-core --example metaedit_probe -- edit <path> key=value... [clear:key] [cover:<img>]
//!   cargo run -q -p renomio-core --example metaedit_probe -- batch key=value <path...>
//!   cargo run -q -p renomio-core --example metaedit_probe -- restore <backup> <target>
//!   cargo run -q -p renomio-core --example metaedit_probe -- caps

use renomio_core::metaedit::{capabilities, edit, edit_batch, restore_backup, snapshot, MetaEditRequest};
use std::collections::BTreeMap;

fn usage() -> ! {
    eprintln!("usage: metaedit_probe read|edit|batch|restore|caps ...");
    std::process::exit(2);
}

fn parse_fields(args: &[String]) -> (BTreeMap<String, String>, Option<String>, bool) {
    let mut fields = BTreeMap::new();
    let mut cover = None;
    let mut clear_cover = false;
    for arg in args {
        if let Some(key) = arg.strip_prefix("clear:") {
            fields.insert(key.to_string(), String::new());
        } else if let Some(path) = arg.strip_prefix("cover:") {
            cover = Some(path.to_string());
        } else if arg == "clear-cover" {
            clear_cover = true;
        } else if let Some((key, value)) = arg.split_once('=') {
            fields.insert(key.to_string(), value.to_string());
        } else {
            eprintln!("bad argument: {arg}");
            std::process::exit(2);
        }
    }
    (fields, cover, clear_cover)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cmd = match args.first() {
        Some(c) => c.as_str(),
        None => usage(),
    };
    let result = match cmd {
        "caps" => {
            println!("{}", serde_json::to_string(&capabilities()).unwrap());
            return;
        }
        "read" => {
            let path = args.get(1).unwrap_or_else(|| usage());
            snapshot(path).map(|s| serde_json::to_string(&s).unwrap())
        }
        "edit" => {
            let path = args.get(1).unwrap_or_else(|| usage()).clone();
            let (fields, cover, clear_cover) = parse_fields(&args[2..]);
            let out = edit(&MetaEditRequest {
                path,
                fields,
                cover_path: cover,
                clear_cover,
                backup: true,
            });
            Ok(serde_json::to_string(&out).unwrap())
        }
        "batch" => {
            let pair = args.get(1).unwrap_or_else(|| usage());
            let (key, value) = pair.split_once('=').unwrap_or_else(|| usage());
            let mut fields = BTreeMap::new();
            fields.insert(key.to_string(), value.to_string());
            let requests: Vec<MetaEditRequest> = args[2..]
                .iter()
                .map(|path| MetaEditRequest {
                    path: path.clone(),
                    fields: fields.clone(),
                    cover_path: None,
                    clear_cover: false,
                    backup: true,
                })
                .collect();
            Ok(serde_json::to_string(&edit_batch(requests)).unwrap())
        }
        "restore" => {
            let backup = args.get(1).unwrap_or_else(|| usage());
            let target = args.get(2).unwrap_or_else(|| usage());
            restore_backup(backup, target)
        }
        _ => usage(),
    };
    match result {
        Ok(text) => println!("{text}"),
        Err(err) => {
            eprintln!("ERROR: {err}");
            std::process::exit(1);
        }
    }
}

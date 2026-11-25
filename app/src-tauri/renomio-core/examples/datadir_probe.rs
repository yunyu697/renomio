//! 数据目录解析探针：把「这套数据为什么放在这里」打成 JSON，供 `npm run test:datadir` 在真实进程里回读。
//!
//! 用法：
//!   datadir_probe --exe <程序目录> --os-default <每用户目录> [--cli <路径>] [--env <路径>]
//!   datadir_probe --parse <若干参数，含 --data-dir>
//!
//! 本探针**不改任何全局状态**，只调用 `datadir::resolve` / `datadir::parse_cli_args`。

use std::path::Path;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();

    if let Some(pos) = args.iter().position(|a| a == "--parse") {
        let parsed = renomio_core::datadir::parse_cli_args(args.iter().skip(pos + 1));
        let out = serde_json::json!({ "parsed": parsed });
        println!("{}", serde_json::to_string_pretty(&out).unwrap());
        return;
    }

    let mut exe: Option<String> = None;
    let mut os_default: Option<String> = None;
    let mut cli: Option<String> = None;
    let mut env_value: Option<String> = None;

    let mut it = args.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--exe" => exe = it.next().cloned(),
            "--os-default" => os_default = it.next().cloned(),
            "--cli" => cli = it.next().cloned(),
            "--env" => env_value = it.next().cloned(),
            _ => {}
        }
    }

    let (Some(exe), Some(os_default)) = (exe, os_default) else {
        eprintln!("用法：datadir_probe --exe <程序目录> --os-default <每用户目录> [--cli <路径>] [--env <路径>]");
        std::process::exit(2);
    };

    let root = renomio_core::datadir::resolve(
        Path::new(&exe),
        Path::new(&os_default),
        cli.as_deref(),
        env_value.as_deref(),
    );
    let payload = serde_json::json!({
        "root": root,
        "description": renomio_core::datadir::describe(&root),
    });
    println!("{}", serde_json::to_string_pretty(&payload).unwrap());
}

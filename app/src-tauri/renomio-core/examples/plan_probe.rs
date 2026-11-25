//! 改名探针：把「规则引擎算好的改名计划」交给真实的 core 两阶段改名执行，
//! 供跨语言契约测试（Node 侧真实规则引擎 + Rust 侧真实改名）使用。
//!
//! 用法：
//!   plan_probe apply <plan.json> <out.json>
//!   plan_probe undo  <dataDir> <batchId> <out.json>
//!
//! plan.json 形状（与前端 apply_plan 入参一致）：
//! {
//!   "dataDir": "...",
//!   "items": [{"id": "...", "source": "...", "targetName": "...", "isDir": false}],
//!   "options": {"policy": "skip", "skipReadonly": false, "windowsSafe": true, "roots": ["..."]}
//! }
//!
//! 输出：apply 为 ApplyOutcome，undo 为 UndoOutcome（均为 core 的 camelCase JSON）。

use std::fs;
use std::path::PathBuf;
use std::process::exit;

use renomio_core::platform::native_path;
use renomio_core::rename::{ApplyItem, ApplyOptions};
use renomio_core::Core;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Plan {
    data_dir: String,
    #[serde(default)]
    items: Vec<ApplyItem>,
    #[serde(default)]
    options: ApplyOptions,
}

fn fail(message: impl Into<String>) -> ! {
    let payload = serde_json::json!({ "ok": false, "error": message.into() });
    println!("{}", payload);
    exit(2);
}

fn write_out(path: &str, value: &serde_json::Value) {
    fs::write(
        native_path(&PathBuf::from(path)),
        value.to_string().as_bytes(),
    )
    .unwrap_or_else(|e| fail(format!("写结果文件失败：{e}")));
    println!("{}", value);
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mode = args.first().map(|s| s.as_str()).unwrap_or("");
    match mode {
        "apply" => {
            if args.len() < 3 {
                fail("用法：plan_probe apply <plan.json> <out.json>");
            }
            let raw =
                fs::read_to_string(native_path(&PathBuf::from(&args[1]))).unwrap_or_else(|e| {
                    fail(format!("读计划失败：{e}"));
                });
            let plan: Plan = serde_json::from_str(&raw).unwrap_or_else(|e| {
                fail(format!("计划 JSON 解析失败：{e}"));
            });
            let core = Core::new(&plan.data_dir);
            let outcome = match core.apply(plan.items, &plan.options) {
                Ok(o) => o,
                Err(e) => fail(format!("改名失败：{e}")),
            };
            let value = serde_json::json!({ "ok": true, "outcome": outcome });
            write_out(&args[2], &value);
        }
        "undo" => {
            if args.len() < 4 {
                fail("用法：plan_probe undo <dataDir> <batchId> <out.json>");
            }
            let core = Core::new(&args[1]);
            let outcome = match core.undo(&args[2]) {
                Ok(o) => o,
                Err(e) => fail(format!("撤销失败：{e}")),
            };
            let value = serde_json::json!({ "ok": true, "outcome": outcome });
            write_out(&args[3], &value);
        }
        _ => fail("未知模式：apply | undo"),
    }
}

//! 打印当前平台的能力快照（JSON），供 `npm run test:platform` 与 CI 三平台矩阵断言。
//!
//! 用法：`cargo run -q -p renomio-core --example platform_probe`

fn main() {
    let report = renomio_core::platform::report();
    println!(
        "{}",
        serde_json::to_string_pretty(&report).expect("PlatformReport 必须可序列化")
    );
}

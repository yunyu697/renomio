// 发布构建时隐藏控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // 版本查询：与 Cargo.toml 的包版本一致（构建前由 VERSION 注入），故与发布 tag 一致。
    if std::env::args().any(|a| a == "--version" || a == "-V") {
        println!("renomio {}", env!("CARGO_PKG_VERSION"));
        return;
    }

    // 进程起点时间戳：GUI 子系统下 stdout 不可靠，直接落盘到 startup.log
    rename_studio_lib::mark_process_start();
    rename_studio_lib::run()
}

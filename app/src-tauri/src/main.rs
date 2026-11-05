// 发布构建时隐藏控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // 进程起点时间戳：GUI 子系统下 stdout 不可靠，直接落盘到 startup.log
    rename_studio_lib::mark_process_start();
    rename_studio_lib::run()
}

// Windows 发布版不弹控制台窗口，保留 main 作为入口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    todo_workbench_lib::run()
}

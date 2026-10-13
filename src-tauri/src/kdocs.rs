//! 金山文档（WPS 在线表格）的「选表窗口」。
//!
//! 为什么要单开一个窗口，而不是让前端去 fetch：
//!
//!  1. 网页端与桌面端的边界。**跨站请求在浏览器里要过 CORS**，而金山文档的
//!     接口只对"自己人"（带着登录态的页面）敞开。网页端无论如何都做不成，
//!     这条路天生就是桌面端的。
//!  2. 登录态根本不该被我们碰。用户的登录票多半是 HttpOnly，脚本读不出来；
//!     就算读出来了，它什么时候过期、要不要配 CSRF 头，全是我们不该操心的事。
//!     于是做法是**让已登录的那个页面自己发请求**，我们只要结果 ——
//!     这一层在 `src/lib/kdocsBrowser.ts` 里，本文件只负责"给个窗口、能说话"。
//!
//! 三条硬约束：
//!  · `eval` 在 Tauri v2 里**没有 JS 侧入口**（只有 Rust 有），而且它**不返回值**。
//!    所以结果回传走另一条道：脚本把结果写进 `document.title`，由 `kdocs_title`
//!    读回来。糙，但零新依赖、不碰页面里的任何对象，也不会被页面的 CSP 拦
//!    （ExecuteScript 是容器发起的，不是页面自己 eval）。
//!  · 只能对这个窗口 eval —— 命令里写死 label，不给"对任意窗口执行任意脚本"的口子。
//!  · 不新增任何 crate（与 toolpkg.rs 同一个规矩）：`reqwest` 那套已经在了，
//!    这里连它都用不上。

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// 选表窗口的 label。写死，别从参数传 —— 传进来就等于允许操作任意窗口。
const WINDOW_LABEL: &str = "kdocs-picker";

const WINDOW_TITLE: &str = "WPS 表格 — 登录后打开要联动的那张表";

/// 打开选表窗口。已经开着就复用并导航到新地址（用户可能换了张表）。
#[tauri::command]
pub async fn kdocs_open_picker(app: AppHandle, url: String) -> Result<String, String> {
    if let Some(win) = app.get_webview_window(WINDOW_LABEL) {
        if !url.is_empty() {
            let target: tauri::Url = url.parse().map_err(|_| format!("地址不合法：{url}"))?;
            win.navigate(target).map_err(|e| format!("跳转失败：{e}"))?;
        }
        let _ = win.set_focus();
        return Ok("reused".to_string());
    }

    let start: tauri::Url = if url.is_empty() {
        "https://www.kdocs.cn/".parse().map_err(|_| "默认地址解析失败".to_string())?
    } else {
        url.parse().map_err(|_| format!("地址不合法：{url}"))?
    };

    WebviewWindowBuilder::new(&app, WINDOW_LABEL, WebviewUrl::External(start))
        .title(WINDOW_TITLE)
        .inner_size(1180.0, 800.0)
        .build()
        .map_err(|e| format!("窗口没起来：{e}"))?;
    Ok("created".to_string())
}

/// 在选表窗口里跑一段脚本。**不返回值** —— 想拿结果就让脚本写进 `document.title`，
/// 再用 `kdocs_title` 读。
#[tauri::command]
pub async fn kdocs_eval(app: AppHandle, script: String) -> Result<(), String> {
    let win = app
        .get_webview_window(WINDOW_LABEL)
        .ok_or_else(|| "选表窗口还没打开".to_string())?;
    win.eval(&script).map_err(|e| format!("脚本没跑起来：{e}"))
}

/// 读窗口标题 —— 这是页面把结果递出来的通道。
#[tauri::command]
pub async fn kdocs_title(app: AppHandle) -> Result<String, String> {
    let win = app
        .get_webview_window(WINDOW_LABEL)
        .ok_or_else(|| "选表窗口还没打开".to_string())?;
    win.title().map_err(|e| format!("读不到窗口标题：{e}"))
}

/// 关掉选表窗口。用户选完表就该把它收起来，别一直挂在任务栏上。
#[tauri::command]
pub async fn kdocs_close_picker(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(WINDOW_LABEL) {
        win.close().map_err(|e| format!("关不掉：{e}"))?;
    }
    Ok(())
}

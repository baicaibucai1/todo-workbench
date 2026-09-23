//! 应用入口。
//!
//! 启动流程：
//!   1. 准备用户数据区的 tools/ 目录，并把安装包内置的工具复制过去
//!      —— 这样新增工具不需要重新发版，用户自己丢文件夹即可
//!   2. 注册 SQLite / 文件系统 / 更新器等插件
//!   3. 打开主窗口

use std::fs;
use std::path::{Path, PathBuf};

use tauri::Manager;

mod attachments;
mod db_tx;
mod webdav;

/// 把打包进安装包的内置工具同步到用户数据目录。
///
/// 策略：只补齐缺失的文件，**内置工具的新版本则按版本号覆盖**。
///
/// 「不覆盖」这条原本是无条件的，本意是"别把用户按自己需求改过的工具冲掉"。
/// 但它有个没被想到的后果：**内置工具的升级永远落不到已安装的机器上**。
/// 实测踩到过 —— image-crop 在源码里已经换到新一代界面，装好的机器上
/// 打开的还是几个月前那份，而两边看起来都"正常"，只是行为不一样，
/// 是最难查的那类问题。
///
/// 所以现在按 manifest.version 判断：
///   安装包版本 > 本地版本  → 覆盖（这是升级，用户要的就是新版）
///   相等或更低            → 保持不动（可能在本地改过，也可能就是同一份）
///   本地读不到 manifest   → 保持不动（不敢确认是什么，宁可不动）
/// 这个判据只在**内置工具**上生效；用户自己丢进 <appData>/tools 的工具
/// 不在安装包里，根本走不到这个函数。
///
/// 第三件事：**尊重用户的卸载**。设置页卸载一个内置工具时会往
/// <appData>/tools/.uninstalled 写一笔（一行一个 id），这里要跳过它们 ——
/// 否则用户第二天打开应用会发现卸载掉的工具又回来了，
/// 而界面上完全看不出是"启动时被同步回来的"。
fn sync_builtin_tools(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let user_tools = app.path().app_data_dir()?.join("tools");
    fs::create_dir_all(&user_tools)?;

    let uninstalled = read_uninstalled(&user_tools);

    // 定位安装包内置工具目录。
    //
    // tauri.conf.json 的 resources 写的是 "../tools/**/*"（在 src-tauri 之外），
    // Tauri 会把这类资源放进 resource_dir()/_up_/ 下并保留相对结构，
    // 因此实际路径是 _up_/tools，而不是 tools。两种位置都探测一次，
    // 免得日后把工具挪进 src-tauri 时又要改这里。
    let resource_dir = app.path().resource_dir().ok();
    let candidates: Vec<PathBuf> = resource_dir
        .as_ref()
        .map(|p| vec![p.join("_up_").join("tools"), p.join("tools")])
        .unwrap_or_default();

    // 开发模式下 resource_dir() 指向 target/debug，工具其实在项目源码目录里，
    // 由 CARGO_MANIFEST_DIR 往上找到 tools/，否则 dev 时看不到内置工具。
    let mut candidates = candidates;
    if let Some(manifest) = option_env!("CARGO_MANIFEST_DIR") {
        candidates.push(Path::new(manifest).join("..").join("tools"));
    }

    let Some(bundled) = candidates.into_iter().find(|p| p.exists()) else {
        return Ok(());
    };

    for entry in fs::read_dir(&bundled)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        if uninstalled.contains(&entry.file_name().to_string_lossy().to_string()) {
            continue;
        }
        let src = entry.path();
        let target = user_tools.join(entry.file_name());
        let upgrade = match (tool_version(&src), tool_version(&target)) {
            (Some(newer), Some(installed)) => newer > installed,
            _ => false,
        };
        copy_tool(&src, &target, upgrade)?;
    }

    Ok(())
}

/// 读「用户主动卸载过的内置工具」清单。
///
/// 文件不存在、读不出来、内容里有空行或非法字符，一律按"没有卸载记录"处理 ——
/// 这个文件只做加法（跳过同步），读坏了最多是把工具同步回来，
/// 不能让应用起不来。
fn read_uninstalled(user_tools: &Path) -> std::collections::HashSet<String> {
    let mut out = std::collections::HashSet::new();
    let Ok(text) = fs::read_to_string(user_tools.join(".uninstalled")) else {
        return out;
    };
    for line in text.lines() {
        let id = line.trim();
        if !id.is_empty() {
            out.insert(id.to_string());
        }
    }
    out
}

/// 读工具目录 manifest.json 里的 version，解析成可比较的三段数字。
///
/// 解析不出来就返回 None —— 调用方按「不敢覆盖」处理。
/// 故意不对版本格式宽容：manifest 是我们自己发出去的，格式畸形时
/// 保持不动比猜一个更安全。
fn tool_version(dir: &Path) -> Option<(u32, u32, u32)> {
    let text = fs::read_to_string(dir.join("manifest.json")).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    let raw = json.get("version")?.as_str()?;

    let mut parts = raw.split('.');
    let major: u32 = parts.next()?.trim().parse().ok()?;
    let minor: u32 = parts.next().unwrap_or("0").trim().parse().ok()?;
    // 可能带 "1" 之外的尾巴（如 1.2.3-beta），只取数字前缀
    let patch_raw = parts.next().unwrap_or("0");
    let patch_digits: String = patch_raw.chars().take_while(|c| c.is_ascii_digit()).collect();
    let patch: u32 = patch_digits.parse().unwrap_or(0);

    Some((major, minor, patch))
}

/// 递归复制一个工具目录。
/// `force` 为真时覆盖同名文件（版本升级），否则只补缺失的。
fn copy_tool(src: &Path, dst: &Path, force: bool) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let target = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tool(&entry.path(), &target, force)?;
        } else if force || !target.exists() {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init());

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .invoke_handler(tauri::generate_handler![
            // 真原子事务：插件的 execute 每次现取现还一条连接，
            // 用它拼 BEGIN/COMMIT 会跨连接，必须由这条命令接管。
            db_tx::db_transaction,
            attachments::attachment_dir,
            attachments::attachment_import,
            attachments::attachment_put,
            attachments::attachment_download,
            attachments::attachment_remove,
            attachments::attachment_exists,
            attachments::attachment_usage,
            attachments::open_external,
            // 坚果云同步的传输层。前端自己发不出去 ——
            // 浏览器只允许标准 HTTP 方法，WebDAV 用的 PROPFIND / MKCOL
            // 连预检都过不了（见 webdav.rs 顶部）。
            webdav::webdav_check,
            webdav::webdav_get,
            webdav::webdav_put,
            webdav::webdav_stat,
        ])
        .setup(|app| {
            if let Err(e) = sync_builtin_tools(app.handle()) {
                // 工具同步失败不应阻止应用启动，待办功能仍然可用
                eprintln!("[warn] 同步内置工具失败: {e}");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("待办工作台启动失败");
}

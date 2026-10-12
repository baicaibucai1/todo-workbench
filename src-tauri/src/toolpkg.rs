//! 工具包的下载。
//!
//! 为什么这件事不能在前端做：webview 里的 `fetch` 受 **CORS** 约束，而
//! 工具包通常挂在 GitHub Release 上 —— 对方给不给 `Access-Control-Allow-Origin`
//! 不由我们决定。让前端去 fetch，失败信息还是一句笼统的 "Failed to fetch"，
//! 用户根本分不清是"地址错了"还是"对方不允许"。
//!
//! Rust 这边没有 CORS，也没有预检，于是：
//!   · 地址写错   → 明确报 404 / DNS 失败
//!   · 不是 zip   → 前端解包时报"不像一个 zip"
//!   · 太大       → 边下边数，超上限立刻停手
//!
//! 依赖上**不新增任何 crate**：reqwest / rustls / ring 都已在依赖树里
//! （updater 插件带的），feature 对齐着写就不会整树重编 —— 见 Cargo.toml 里那段说明。

use std::fs;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

/// 单次下载的上限。工具包里可能有 50MB 的抠图模型，给足余量；
/// 但也不能无限，否则一个"声明 1KB 实际 10GB"的地址就能把磁盘写满。
const HARD_MAX_BYTES: u64 = 512 * 1024 * 1024;
const FETCH_TIMEOUT_SECS: u64 = 300;
const USER_AGENT: &str = concat!("todo-workbench/", env!("CARGO_PKG_VERSION"));

/// 抓子资源用的浏览器 UA。不少站点的 CDN 拿 UA 当门禁
/// （tool.lu 实测连 Referer 都要），`todo-workbench/x.y.z` 一亮相就 403。
const BROWSER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/// 下载到一个临时目录，返回**落盘路径**。
///
/// 不把字节直接回给前端：几十兆的内容走 IPC 会变成一个大数组，
/// 在 JS 堆里翻好几倍。落在磁盘上再让前端按文件读，内存是平的。
///
/// 返回的路径在 `<appData>/tools/.incoming/` 下 —— 它在 fs 插件的
/// `$APPDATA/**` 作用域内，前端读得到；用完由前端自己删掉。
#[tauri::command]
pub async fn tool_download(
    app: AppHandle,
    url: String,
    max_bytes: Option<u64>,
) -> Result<String, String> {
    let (path, _) = fetch_to_incoming(&app, &url, None, USER_AGENT, max_bytes).await?;
    Ok(path)
}

/**
 * 抓一个**子资源**（脚本 / 样式 / 图片），给「安装时内联外部资源」用。
 *
 * 与 tool_download 的两点不同：
 *   · 要带 **Referer**（热链保护看的就是它 —— tool.lu 的 CDN 对空 Referer
 *     直接 403 `X-Error-Info: EmptyReferer`； referer 传页面自己的地址）；
 *   · 用**浏览器 UA**（理由同上，有些门禁两个都看）；
 *   · 额外返回 Content-Type —— 前端内联图片时要拼 `data:` URI 的 MIME。
 *
 * 返回 `(落盘路径, content_type)`；路径用完由前端删，与 tool_download 相同。
 */
#[tauri::command]
pub async fn tool_fetch(
    app: AppHandle,
    url: String,
    referer: Option<String>,
    max_bytes: Option<u64>,
) -> Result<(String, String), String> {
    fetch_to_incoming(&app, &url, referer.as_deref(), BROWSER_UA, max_bytes).await
}

async fn fetch_to_incoming(
    app: &AppHandle,
    url: &str,
    referer: Option<&str>,
    user_agent: &str,
    max_bytes: Option<u64>,
) -> Result<(String, String), String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("网址不合法: {e}"))?;
    match parsed.scheme() {
        "http" | "https" => {}
        other => return Err(format!("只支持 http/https，收到的是 {other}")),
    }

    let limit = max_bytes.unwrap_or(HARD_MAX_BYTES).min(HARD_MAX_BYTES);

    // rustls 必须有一个已安装的 crypto provider 才能握手。
    // updater 启动时通常已经装好了，但命令不该依赖"别的插件先跑过"。
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }

    let client = reqwest::Client::builder()
        .user_agent(user_agent)
        .timeout(std::time::Duration::from_secs(FETCH_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;

    let mut req = client.get(parsed.clone());
    if let Some(r) = referer {
        req = req.header(reqwest::header::REFERER, r);
    }
    let mut resp = req.send().await.map_err(|e| format!("下载失败: {e}"))?;

    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    let status = resp.status();
    if !status.is_success() {
        return Err(format!("对方返回 {status}"));
    }

    // 先用 Content-Length 挡一道，省得真的去下 10GB 才发现超限
    if let Some(len) = resp.content_length() {
        if len > limit {
            return Err(format!(
                "这个包 {:.1} MB，超过 {:.0} MB 上限",
                len as f64 / 1_048_576.0,
                limit as f64 / 1_048_576.0
            ));
        }
    }

    // 边下边数。Content-Length 可能是假的、也可能压根没有（chunked），
    // 只信它就会被人用一个"声明 1KB 实际 1GB"的地址把磁盘写满。
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("下载中断: {e}"))? {
        if buf.len() as u64 + chunk.len() as u64 > limit {
            return Err(format!(
                "超过 {:.0} MB 上限，已中止",
                limit as f64 / 1_048_576.0
            ));
        }
        buf.extend_from_slice(&chunk);
    }
    if buf.is_empty() {
        return Err("对方返回的是空的".to_string());
    }

    let dir = incoming_dir(app)?;
    // 名字用时间戳 + 地址哈希：同一地址短时间内下两次不会互相覆盖，
    // 而哈希保证名字里只有 ASCII（URL 里的中文会变成可用的文件名）
    let digest = format!("{:x}", md5ish(url));
    let name = format!("{}-{digest}.bin", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0));
    let path = dir.join(name);
    fs::write(&path, &buf).map_err(|e| format!("写入临时文件失败: {e}"))?;

    Ok((path.to_string_lossy().to_string(), content_type))
}

/** `<appData>/tools/.incoming/`，不存在就建 */
fn incoming_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("取不到应用数据目录: {e}"))?
        .join("tools")
        .join(".incoming");
    fs::create_dir_all(&dir).map_err(|e| format!("创建临时目录失败: {e}"))?;
    Ok(dir)
}

/**
 * 给 URL 算一个短哈希，只用来生成文件名。
 *
 * 刻意不引 md5 / sha2 那些 crate —— 这里要的不是密码学强度，
 * 只是"同一个地址得到同一个名字"。FNV-1a 足够，且零依赖。
 */
fn md5ish(s: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

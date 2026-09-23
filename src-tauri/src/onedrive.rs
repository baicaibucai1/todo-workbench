//! OneDrive 同步的传输层（Microsoft Graph API）。
//!
//! 为什么不复用 `webdav.rs`：**OneDrive 个人版没有 WebDAV**。那套
//! `d.docs.live.net` 的映射靠「应用密码 + 网络驱动器」，微软早已废弃，
//! 且在需要频繁改写的内容上本来就不稳。微软的正路是 Graph API + OAuth 2.0，
//! 所以这是**另一套协议**，不是把地址换个字符串就能用。
//!
//! 三个决定了实现形态的事实：
//!
//! 1. **登录只能在 Rust 做**。授权码流程要开一个本地 loopback 端口收回调，
//!    浏览器里的 JS 开不了监听端口，授权页 302 到 `http://localhost:<port>`
//!    也不是 webview 能拦的。
//! 2. **公共客户端必须用 PKCE**，不能有 client_secret —— 桌面应用里带 secret
//!    等于把密码复制到每一台装了这个应用的机器上。code_verifier / challenge
//!    因此要在这里算。
//! 3. **重定向地址只登记 `http://localhost` 就够了**：RFC 8252 §7.3 要求授权
//!    服务器必须放行任意 loopback 端口，所以端口可以**随机取**，
//!    不必去占一个固定端口（也就不会跟别的程序撞）。
//!
//! 依赖上刻意**不新增任何 crate**：HTTP 复用 reqwest、SHA256 用 ring、
//! base64url 自己写（编解码一共三十来行，为它引一个 crate 不划算）。
//!
//! 与数据库的分工：这里只知道"把一段文本放上去 / 取下来"，
//! **不知道那些文本是什么意思**——分片怎么切、怎么合并全在 TS 侧（lib/sync.ts）。

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::attachments::open_url;
use crate::webdav::build_client;

/// 官方登录端点。`common` 同时支持工作/学校账号与个人 Microsoft 账号 ——
/// 写死 `consumers` 就登不进企业账号，写死租户 id 就登不进个人账号。
const DEFAULT_LOGIN_BASE: &str = "https://login.microsoftonline.com/common/oauth2/v2.0";

/// 官方 Graph 端点。
const DEFAULT_GRAPH_BASE: &str = "https://graph.microsoft.com/v1.0";

/// 申请的权限。
///
/// - `Files.ReadWrite.AppFolder` —— **权限最小的那个**：应用只能碰
///   `OneDrive/Apps/<应用名>/`，连用户其他文件的名字都看不到。
/// - `offline_access` —— 不给它就拿不到 refresh_token，每过一小时要重新登录一次。
/// - `openid profile` —— 只为从 id_token 里读出"已连接为 xxx"。
///   有了它就不必再要 `User.Read`（那要多一次 /me 请求，也多一条授权页上的权限）。
const SCOPE: &str = "Files.ReadWrite.AppFolder offline_access openid profile";

/// 等浏览器回调的上限。用户要在浏览器里登录 + 点同意，5 分钟很宽裕；
/// 不设上限的话，用户中途关掉授权页就会留下一个永远在等的命令。
const AUTH_TIMEOUT_SECS: u64 = 300;

/// 建连与探活。
const CHECK_TIMEOUT_SECS: u64 = 15;

/// 取/存分片。分片是纯文本、几十 KB，60 秒足够。
const IO_TIMEOUT_SECS: u64 = 60;

/// 单个分片的字节上限。挡的是"云端被别的东西塞进来一个巨大文件"，
/// 而不是我们自己的数据 —— 待办全量导出也就几百 KB。
const MAX_SHARD_BYTES: usize = 16 * 1024 * 1024;

/// URL 里要保留的字符集 —— **路径段、查询参数、表单键值共用这一个**。
///
/// 直接用 `NON_ALPHANUMERIC` 会把 `tasks.json` 里的点编码成 `%2E`、
/// 把 `refresh_token` 里的下划线编码成 `%5F`、把 `client-abc` 里的短横线
/// 编码成 `%2D`。合规（服务端解回来是一样的），但没必要，
/// 而且路径与参数里**过度编码**在各类服务上都出现过解析差异 ——
/// PKCE 的 `code_challenge` 本身就是 base64url（含 `-` 与 `_`），
/// 最不该在这个环节上冒险。
///
/// 这里按 RFC 3986 的 unreserved 集合保留 `-._~`，其余（含中文的每个字节）照常编码。
const URL_ESCAPE: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'~');

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

/// OneDrive 的同步配置。
///
/// `login_base` / `graph_base` 做成可注入只是为了**让测试能把它们指向本地桩**：
/// 生产路径上前端从不传这两个字段，取上面的官方地址。这样一个模块里
/// 既能测真流程，也不用真去连微软。
#[derive(Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct OneDriveConfig {
    /// Azure 应用的客户端 ID。公共客户端的 client_id **不是密钥**，
    /// 内置进应用、明文存在设置里都无妨。
    pub client_id: String,
    /// 长期令牌。空串 = 还没登录过。
    #[serde(default)]
    pub refresh_token: String,
    /// 短期令牌。由前端在每轮同步开始时刷新一次、然后带在每个请求上 ——
    /// Rust 侧因此**不持有任何状态**，不需要跨命令的缓存与失效逻辑。
    #[serde(default)]
    pub access_token: String,
    #[serde(default)]
    pub login_base: String,
    #[serde(default)]
    pub graph_base: String,
}

impl OneDriveConfig {
    fn login_base(&self) -> &str {
        let s = self.login_base.trim();
        if s.is_empty() {
            DEFAULT_LOGIN_BASE
        } else {
            s
        }
    }

    fn graph_base(&self) -> &str {
        let s = self.graph_base.trim();
        if s.is_empty() {
            DEFAULT_GRAPH_BASE
        } else {
            s
        }
    }
}

/* ------------------------------------------------------------------ */
/* 出参                                                                */
/* ------------------------------------------------------------------ */

/// 登录成功后交回前端的东西。refresh_token 由前端落库（`core_settings`）。
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OneDriveSession {
    pub refresh_token: String,
    /// 账号标识（邮箱）。取不到时是空串，界面按空串处理
    pub account: String,
    pub message: String,
}

/// 刷新出来的短期令牌。
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OneDriveToken {
    pub access_token: String,
    /// ⚠️ 微软的 refresh_token 是**会滚动**的：每次刷新可能发一个新的，
    /// 且旧的随后失效。前端必须把它写回设置，否则下一次刷新就失败。
    pub refresh_token: String,
    pub expires_in: u64,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OneDriveCheck {
    /// 应用专属文件夹是不是可用了。首次调用会**自动创建**它，
    /// 所以正常路径下这里总是 true —— false 只出现在拿不到元数据时
    pub folder_exists: bool,
    /// 云端目录名（等于 Azure 里那个应用名）
    pub folder_path: String,
    pub message: String,
}

/// 云端一个文件的信息。字段与 `webdav::DavEntry` 对齐，前端不必区分来源。
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DriveEntry {
    pub size: u64,
    /// `lastModifiedDateTime` 原文。只用于展示，不参与判断
    pub modified: String,
}

/* ------------------------------------------------------------------ */
/* base64url                                                           */
/* ------------------------------------------------------------------ */

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// base64url 编码，**不带填充**（PKCE 与 JWT 段都是这个形态）。
fn b64url(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        if chunk.len() > 1 {
            out.push(B64[(n >> 6) as usize & 63] as char);
        }
        if chunk.len() > 2 {
            out.push(B64[n as usize & 63] as char);
        }
    }
    out
}

/// base64url 解码。容忍填充符与空白 —— JWT 段两种写法都出现过。
fn b64url_decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'-' | b'+' => 62,
            b'_' | b'/' => 63,
            b'=' | b'\n' | b'\r' => continue,
            _ => return None,
        };
        acc = (acc << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}

fn sha256(data: &[u8]) -> Vec<u8> {
    ring::digest::digest(&ring::digest::SHA256, data)
        .as_ref()
        .to_vec()
}

fn random_b64(bytes: usize) -> Result<String, String> {
    use ring::rand::SecureRandom;
    let rng = ring::rand::SystemRandom::new();
    let mut buf = vec![0u8; bytes];
    rng.fill(&mut buf)
        .map_err(|_| "生成随机数失败".to_string())?;
    Ok(b64url(&buf))
}

/// 按 RFC 7636 算 code_challenge：`base64url(SHA256(ASCII(code_verifier)))`。
fn code_challenge(verifier: &str) -> String {
    b64url(&sha256(verifier.as_bytes()))
}

/* ------------------------------------------------------------------ */
/* URL 与表单                                                          */
/* ------------------------------------------------------------------ */

/// 查询参数与表单值的编码。用的是和路径同一套 escape 集合 ——
/// 见 `URL_ESCAPE` 上那段：`-._~` 要留着，别把一个 PKCE 的
/// `code_challenge` 编成带 `%2D`／`%5F` 的样子去冒险。
fn enc(s: &str) -> String {
    percent_encoding::utf8_percent_encode(s, URL_ESCAPE).to_string()
}

fn encode_path(path: &str) -> String {
    path.split('/')
        .filter(|s| !s.is_empty())
        .map(|s| percent_encoding::utf8_percent_encode(s, URL_ESCAPE).to_string())
        .collect::<Vec<_>>()
        .join("/")
}

/// 拼授权页地址。用户要在浏览器里看到它，所以顺序与官方示例保持一致。
fn authorize_url(
    login_base: &str,
    client_id: &str,
    redirect_uri: &str,
    state: &str,
    challenge: &str,
) -> String {
    format!(
        "{}/authorize?client_id={}&response_type=code&redirect_uri={}&response_mode=query\
         &scope={}&state={}&code_challenge={}&code_challenge_method=S256",
        login_base.trim_end_matches('/'),
        enc(client_id),
        enc(redirect_uri),
        enc(SCOPE),
        enc(state),
        enc(challenge),
    )
}

/// 拼应用专属文件夹里某个文件的地址。
///
/// `:/…:` 是 Graph 的「按路径寻址」语法（`specialFolder` 命名空间），
/// `approot` 这个词**大小写敏感**。取内容要在末尾加 `/content`；
/// 取元数据（size / lastModified）则不加。
fn approot_url(graph_base: &str, path: &str, content: bool) -> Result<reqwest::Url, String> {
    let url = format!(
        "{}/me/drive/special/approot:/{}:{}",
        graph_base.trim_end_matches('/'),
        encode_path(path),
        if content { "/content" } else { "" }
    );
    reqwest::Url::parse(&url).map_err(|e| format!("Graph 地址不合法: {e}"))
}

/// 解析 `a=1&b=2` 这样的查询串。回调里带的是 `code` / `state` / `error`。
fn parse_query(q: &str) -> Vec<(String, String)> {
    q.split('&')
        .filter(|s| !s.is_empty())
        .map(|pair| {
            let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
            let dec = |s: &str| percent_encoding::percent_decode_str(s).decode_utf8_lossy().to_string();
            (dec(k), dec(v))
        })
        .collect()
}

fn form_body(form: &[(String, String)]) -> String {
    form.iter()
        .map(|(k, v)| format!("{}={}", enc(k), enc(v)))
        .collect::<Vec<_>>()
        .join("&")
}

/* ------------------------------------------------------------------ */
/* 错误话术                                                            */
/* ------------------------------------------------------------------ */

/// 把 OAuth 的错误码翻成能照着做的中文。
///
/// 这一步值得单独写：微软返回的 `error_description` 是英文长句，
/// 直接甩给用户等于没说；而这里每个分支都对应一个**具体的下一步动作**。
fn describe_token_error(code: &str, desc: &str) -> String {
    let hint = match code {
        "invalid_grant" => {
            "授权已经失效（改过密码、撤销过授权、或者太久没用）。点「连接 OneDrive」重新登录一次。"
        }
        "invalid_client" => {
            "Azure 那边的客户端 ID 不对。回设置里核对一下复制过来的 client_id，注意别带空格。"
        }
        "unauthorized_client" => {
            "这个应用没被允许用这种登录方式。到 Azure 的「身份验证」页把「允许公共客户端流」打开。"
        }
        "invalid_request" => {
            "请求被拒。多半是 Azure 里没登记重定向地址 http://localhost —— \
             在「身份验证 → 添加平台 → 移动和桌面应用程序」里加上它。"
        }
        "interaction_required" | "consent_required" => "还需要你确认一次授权，重开一次登录即可。",
        "" => "登录服务拒绝了这次请求。",
        _ => "登录服务报了个错。",
    };
    if desc.is_empty() {
        format!("{hint}（{code}）")
    } else {
        format!("{hint}（{code}：{desc}）")
    }
}

/// Graph 的非 2xx 响应 → 中文提示。带上原始 message，便于对照微软文档。
fn describe_graph_error(status: u16, body: &str) -> String {
    let detail = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| {
            v.get("error")
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| body.chars().take(200).collect());

    let hint = match status {
        401 => "令牌没被接受。多半是同步超时太久失效了，点「连接 OneDrive」重新登录。",
        403 => {
            "OneDrive 拒绝访问。确认 Azure 里加了 Files.ReadWrite.AppFolder 这个权限，\
             并且授权时点了同意。"
        }
        404 => "云端找不到这个文件。",
        429 => "请求太频繁被限流了。等一会儿再同步。",
        507 => "OneDrive 空间不够了。",
        _ => "OneDrive 返回了错误。",
    };
    format!("{hint}（HTTP {status}：{detail}）")
}

/// 从 id_token 里读出账号标识。
///
/// 不调 `/me` 是为了**少要一个权限**：`openid profile` 本来就随登录一起来，
/// 而 `User.Read` 要多一条授权页上的条目、多一次请求。
fn id_token_account(token_json: &serde_json::Value) -> String {
    let id_token = match token_json.get("id_token").and_then(|v| v.as_str()) {
        Some(t) => t,
        None => return String::new(),
    };
    let payload = match id_token.split('.').nth(1).and_then(b64url_decode) {
        Some(p) => p,
        None => return String::new(),
    };
    let v: serde_json::Value = match serde_json::from_slice(&payload) {
        Ok(v) => v,
        Err(_) => return String::new(),
    };
    for key in ["preferred_username", "upn", "email", "name"] {
        if let Some(s) = v.get(key).and_then(|x| x.as_str()) {
            if !s.is_empty() {
                return s.to_string();
            }
        }
    }
    String::new()
}

/* ------------------------------------------------------------------ */
/* loopback 回调                                                       */
/* ------------------------------------------------------------------ */

/// 给浏览器看的收尾页。用户看到"可以关掉这个窗口"就够了，
/// 不需要跳回应用 —— 授权页跳的是这个本地地址，应用正等在这里。
const DONE_HTML: &str = "<!doctype html><meta charset=\"utf-8\">\
<title>授权完成</title>\
<body style=\"font-family:system-ui;padding:48px;text-align:center\">\
<h2>授权完成</h2><p>可以关闭这个窗口，回到「待办工作台」继续。</p>";

const FAIL_HTML: &str = "<!doctype html><meta charset=\"utf-8\">\
<title>授权未完成</title>\
<body style=\"font-family:system-ui;padding:48px;text-align:center\">\
<h2>授权未完成</h2><p>回到「待办工作台」看具体的提示。</p>";

fn respond(mut stream: TcpStream, status: u16, reason: &str, html: &str) {
    let body = html.as_bytes();
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: text/html; charset=utf-8\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body);
    let _ = stream.flush();
}

/// 处理一次回调请求。
///
/// 返回 `Ok(None)` = 这次请求跟我们无关（浏览器顺手要的 favicon 之类），继续等；
/// 返回 `Ok(Some(code))` = 拿到了授权码；返回 `Err` = 明确的失败，不必再等。
fn handle_callback(stream: TcpStream, state: &str) -> Result<Option<String>, String> {
    let mut reader = match stream.try_clone() {
        Ok(s) => BufReader::new(s),
        Err(_) => return Ok(None),
    };
    let mut line = String::new();
    if reader.read_line(&mut line).is_err() {
        return Ok(None);
    }
    // 请求行之后的头要读完，否则浏览器可能把响应当成断连
    loop {
        let mut h = String::new();
        match reader.read_line(&mut h) {
            Ok(0) => break,
            Ok(_) if h == "\r\n" || h == "\n" => break,
            Ok(_) => {}
            Err(_) => break,
        }
    }

    let target = line.split_whitespace().nth(1).unwrap_or("").to_string();
    if !target.starts_with("/callback") {
        respond(stream, 404, "Not Found", FAIL_HTML);
        return Ok(None);
    }

    let query = target.split_once('?').map(|(_, q)| q).unwrap_or("");
    let params = parse_query(query);
    let get = |k: &str| {
        params
            .iter()
            .find(|(key, _)| key == k)
            .map(|(_, v)| v.clone())
            .unwrap_or_default()
    };

    let error = get("error");
    if !error.is_empty() {
        let desc = get("error_description");
        respond(stream, 200, "OK", FAIL_HTML);
        let hint = if error == "access_denied" {
            "你在授权页点了拒绝。想同步的话需要允许这个应用访问它的专属文件夹。"
        } else {
            "授权没能完成。"
        };
        return Err(format!("{hint}（{error}：{desc}）"));
    }

    let code = get("code");
    if code.is_empty() {
        respond(stream, 200, "OK", FAIL_HTML);
        return Err("授权回调里没有 code，登录没有完成。".to_string());
    }

    // state 必须对得上：不对的话，这个回调不是我们这次发起的登录
    let got_state = get("state");
    if got_state != state {
        respond(stream, 200, "OK", FAIL_HTML);
        return Err("授权回调的 state 对不上，这次登录已被放弃（可能同时点了两次登录）。".to_string());
    }

    respond(stream, 200, "OK", DONE_HTML);
    Ok(Some(code))
}

/// 等浏览器把授权码带回来。阻塞式 —— 由 `spawn_blocking` 包着跑，
/// 不会占住异步运行时的工作线程。
fn wait_for_code(listener: TcpListener, state: &str, timeout: Duration) -> Result<String, String> {
    let deadline = Instant::now() + timeout;
    loop {
        if Instant::now() >= deadline {
            return Err(
                "等了 5 分钟没等到浏览器的授权回调。再点一次「连接 OneDrive」，\
                 这次留意浏览器里有没有弹出微软的登录页。"
                    .to_string(),
            );
        }
        match listener.accept() {
            Ok((stream, _)) => match handle_callback(stream, state)? {
                Some(code) => return Ok(code),
                None => continue,
            },
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(120));
            }
            Err(e) => return Err(format!("接收授权回调失败: {e}")),
        }
    }
}

/* ------------------------------------------------------------------ */
/* 网络                                                                */
/* ------------------------------------------------------------------ */

async fn post_token(
    login_base: &str,
    form: Vec<(String, String)>,
) -> Result<serde_json::Value, String> {
    let client = build_client(IO_TIMEOUT_SECS)?;
    let url = format!("{}/token", login_base.trim_end_matches('/'));
    let resp = client
        .post(&url)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(form_body(&form))
        .send()
        .await
        .map_err(|e| format!("连不上微软登录服务: {e}"))?;

    let status = resp.status().as_u16();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取登录响应失败: {e}"))?;
    let json: serde_json::Value = serde_json::from_str(&text)
        .map_err(|_| format!("登录服务返回的内容看不懂（HTTP {status}）: {}", text.chars().take(200).collect::<String>()))?;

    if !(200..300).contains(&status) {
        let code = json.get("error").and_then(|v| v.as_str()).unwrap_or("");
        let desc = json
            .get("error_description")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        return Err(describe_token_error(code, desc));
    }
    Ok(json)
}

async fn read_graph_error(resp: reqwest::Response) -> String {
    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    describe_graph_error(status, &body)
}

/* ------------------------------------------------------------------ */
/* 命令                                                                */
/* ------------------------------------------------------------------ */

/// 走一遍授权码 + PKCE 登录，拿回 refresh_token。
///
/// **这是个会阻塞几分钟的命令**：它会打开浏览器、然后一直等到用户完成授权。
/// 前端必须在等待期间给一个明确的"正在等浏览器"状态，否则界面看起来像卡死了。
#[tauri::command]
pub async fn onedrive_sign_in(cfg: OneDriveConfig) -> Result<OneDriveSession, String> {
    let client_id = cfg.client_id.trim().to_string();
    if client_id.is_empty() {
        return Err("先填 Azure 应用的客户端 ID（client_id）".to_string());
    }
    let login_base = cfg.login_base().trim_end_matches('/').to_string();

    // 端口交给系统随机分配：RFC 8252 §7.3 要求授权服务器对 loopback 地址
    // 放行任意端口，所以 Azure 那边只登记 http://localhost 就行
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("打不开本地回调端口: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("拿不到回调端口: {e}"))?
        .port();
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("设置回调端口失败: {e}"))?;

    let verifier = random_b64(32)?;
    let challenge = code_challenge(&verifier);
    let state = random_b64(16)?;
    let redirect_uri = format!("http://localhost:{port}/callback");

    let url = authorize_url(&login_base, &client_id, &redirect_uri, &state, &challenge);
    open_url(&url)?;

    let wait_state = state.clone();
    let code = tauri::async_runtime::spawn_blocking(move || {
        wait_for_code(listener, &wait_state, Duration::from_secs(AUTH_TIMEOUT_SECS))
    })
    .await
    .map_err(|e| format!("等待授权失败: {e}"))??;

    let json = post_token(
        &login_base,
        vec![
            ("client_id".into(), client_id),
            ("grant_type".into(), "authorization_code".into()),
            ("code".into(), code),
            ("redirect_uri".into(), redirect_uri),
            ("code_verifier".into(), verifier),
            ("scope".into(), SCOPE.into()),
        ],
    )
    .await?;

    let refresh_token = json
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if refresh_token.is_empty() {
        return Err(
            "登录成功但没拿到长期令牌。多半是 Azure 里少加了 offline_access 权限，\
             加上它再重新登录一次。"
                .to_string(),
        );
    }
    let account = id_token_account(&json);

    Ok(OneDriveSession {
        message: if account.is_empty() {
            "已连接 OneDrive".to_string()
        } else {
            format!("已连接 OneDrive：{account}")
        },
        refresh_token,
        account,
    })
}

/// 用 refresh_token 换一个短期 access_token。
#[tauri::command]
pub async fn onedrive_refresh(cfg: OneDriveConfig) -> Result<OneDriveToken, String> {
    let client_id = cfg.client_id.trim().to_string();
    if client_id.is_empty() {
        return Err("先填 Azure 应用的客户端 ID（client_id）".to_string());
    }
    if cfg.refresh_token.trim().is_empty() {
        return Err("还没连接 OneDrive，先点「连接 OneDrive」".to_string());
    }
    let login_base = cfg.login_base().trim_end_matches('/').to_string();

    let json = post_token(
        &login_base,
        vec![
            ("client_id".into(), client_id),
            ("grant_type".into(), "refresh_token".into()),
            ("refresh_token".into(), cfg.refresh_token.trim().to_string()),
            ("scope".into(), SCOPE.into()),
        ],
    )
    .await?;

    let access_token = json
        .get("access_token")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if access_token.is_empty() {
        return Err("刷新令牌时没拿到访问令牌，请重新登录一次。".to_string());
    }
    // 微软不一定每次都发新的 refresh_token，那就沿用旧的
    let refresh_token = json
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| cfg.refresh_token.trim().to_string());

    Ok(OneDriveToken {
        access_token,
        refresh_token,
        expires_in: json.get("expires_in").and_then(|v| v.as_u64()).unwrap_or(3600),
    })
}

/// 验证令牌并确保应用专属文件夹可用。
///
/// 首次调用会**顺手创建** `OneDrive/Apps/<应用名>/` —— 这是 Graph 的设计：
/// 第一次访问 `special/approot` 就把它建出来。所以这个命令既是"测试连接"，
/// 也是"把云端目录准备好"。
#[tauri::command]
pub async fn onedrive_check(cfg: OneDriveConfig) -> Result<OneDriveCheck, String> {
    if cfg.access_token.trim().is_empty() {
        return Err("还没有访问令牌，先连接一次 OneDrive".to_string());
    }
    let client = build_client(CHECK_TIMEOUT_SECS)?;
    let mut url = reqwest::Url::parse(&format!(
        "{}/me/drive/special/approot",
        cfg.graph_base().trim_end_matches('/')
    ))
    .map_err(|e| format!("Graph 地址不合法: {e}"))?;
    url.query_pairs_mut()
        .append_pair("$select", "name,webUrl");

    let resp = client
        .get(url)
        .bearer_auth(cfg.access_token.trim())
        .send()
        .await
        .map_err(|e| format!("连不上 OneDrive: {e}"))?;

    if !resp.status().is_success() {
        return Err(read_graph_error(resp).await);
    }
    let body = resp.text().await.unwrap_or_default();
    let json: serde_json::Value = serde_json::from_str(&body).unwrap_or(serde_json::Value::Null);
    let name = json
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    Ok(OneDriveCheck {
        folder_exists: true,
        folder_path: name.clone(),
        message: if name.is_empty() {
            "已连上 OneDrive，应用专属文件夹可用".to_string()
        } else {
            format!("已连上 OneDrive，同步目录是「{name}」（在 OneDrive 的「应用」文件夹里，网页版默认不显示）")
        },
    })
}

/// 取一个分片。云端没有时返回 `None`（首次同步本来就没有，不是错误）。
#[tauri::command]
pub async fn onedrive_get(cfg: OneDriveConfig, name: String) -> Result<Option<String>, String> {
    if cfg.access_token.trim().is_empty() {
        return Err("还没有访问令牌，先连接一次 OneDrive".to_string());
    }
    let client = build_client(IO_TIMEOUT_SECS)?;
    let url = approot_url(cfg.graph_base(), &name, true)?;

    let resp = client
        .get(url)
        .bearer_auth(cfg.access_token.trim())
        .send()
        .await
        .map_err(|e| format!("下载 {name} 失败: {e}"))?;

    if resp.status().as_u16() == 404 {
        return Ok(None);
    }
    if !resp.status().is_success() {
        return Err(read_graph_error(resp).await);
    }

    let mut body: Vec<u8> = Vec::new();
    let mut resp = resp;
    // ⚠️ 这一层依赖 `build_client` **没有关掉重定向**：Graph 的 `:/…:/content`
    // 不直接吐文件，而是 302 到一个预先签名的下载地址（那上面不能再带我们的
    // Bearer 头）。reqwest 默认跟随重定向，并且在跨主机跳转时自动摘掉
    // Authorization —— 正好是这里需要的行为。所以给 WebDAV 调 redirect policy
    // 时要留神：关掉它，OneDrive 的下载会立刻变成 302 报错。
    //
    // 边收边数：云端万一是别人塞进来的巨大文件，不该把内存吃满。
    // 不用 `text()` 是因为它会把整个响应先读进内存再判断 —— 那时候已经晚了。
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| format!("读取 {name} 失败: {e}"))?
    {
        if body.len() + chunk.len() > MAX_SHARD_BYTES {
            return Err(format!(
                "云端的 {name} 太大了（超过 {} MB），已停止读取 —— 多半是别的东西塞进来的",
                MAX_SHARD_BYTES / 1024 / 1024
            ));
        }
        body.extend_from_slice(&chunk);
    }
    String::from_utf8(body).map_err(|_| format!("云端的 {name} 不是合法的 UTF-8 文本")).map(Some)
}

/// 上传一个分片，返回云端记录的字节数。
#[tauri::command]
pub async fn onedrive_put(cfg: OneDriveConfig, name: String, text: String) -> Result<u64, String> {
    if cfg.access_token.trim().is_empty() {
        return Err("还没有访问令牌，先连接一次 OneDrive".to_string());
    }
    if text.len() > MAX_SHARD_BYTES {
        return Err(format!("要上传的 {name} 过大，已拒绝"));
    }
    let client = build_client(IO_TIMEOUT_SECS)?;
    let url = approot_url(cfg.graph_base(), &name, true)?;
    let sent = text.len() as u64;

    let resp = client
        .put(url)
        .bearer_auth(cfg.access_token.trim())
        // 官方示例用 text/plain，但这里存的是 JSON 文件：
        // Content-Type 会被 Graph 记成文件自身的 MIME，写对了在网页版里预览才正常
        .header("Content-Type", "application/json")
        .body(text)
        .send()
        .await
        .map_err(|e| format!("上传 {name} 失败: {e}"))?;

    if !resp.status().is_success() {
        return Err(read_graph_error(resp).await);
    }
    let body = resp.text().await.unwrap_or_default();
    let size = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| v.get("size").and_then(|x| x.as_u64()))
        .unwrap_or(sent);
    Ok(size)
}

/// 云端一个分片的元数据。没有时返回 `None`。
#[tauri::command]
pub async fn onedrive_stat(cfg: OneDriveConfig, name: String) -> Result<Option<DriveEntry>, String> {
    if cfg.access_token.trim().is_empty() {
        return Err("还没有访问令牌，先连接一次 OneDrive".to_string());
    }
    let client = build_client(CHECK_TIMEOUT_SECS)?;
    let mut url = approot_url(cfg.graph_base(), &name, false)?;
    url.query_pairs_mut()
        .append_pair("$select", "size,lastModifiedDateTime");

    let resp = client
        .get(url)
        .bearer_auth(cfg.access_token.trim())
        .send()
        .await
        .map_err(|e| format!("查询 {name} 失败: {e}"))?;

    if resp.status().as_u16() == 404 {
        return Ok(None);
    }
    if !resp.status().is_success() {
        return Err(read_graph_error(resp).await);
    }
    let body = resp.text().await.unwrap_or_default();
    let json: serde_json::Value = serde_json::from_str(&body).unwrap_or(serde_json::Value::Null);

    Ok(Some(DriveEntry {
        size: json.get("size").and_then(|v| v.as_u64()).unwrap_or(0),
        modified: json
            .get("lastModifiedDateTime")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
    }))
}

/* ------------------------------------------------------------------ */
/* 测试                                                                */
/* ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn b64url_matches_known_vectors() {
        // RFC 4648 的测试向量，去掉了填充
        assert_eq!(b64url(b""), "");
        assert_eq!(b64url(b"f"), "Zg");
        assert_eq!(b64url(b"fo"), "Zm8");
        assert_eq!(b64url(b"foo"), "Zm9v");
        assert_eq!(b64url(b"foob"), "Zm9vYg");
        assert_eq!(b64url(b"foobar"), "Zm9vYmFy");
        // URL 安全字母表：62/63 是 - 和 _（不是 + 和 /）
        assert_eq!(b64url(&[0xfb, 0xff]), "-_8");
    }

    #[test]
    fn b64url_round_trips_arbitrary_bytes() {
        for len in 0..40usize {
            let raw: Vec<u8> = (0..len).map(|i| (i * 37 + 11) as u8).collect();
            let decoded = b64url_decode(&b64url(&raw)).expect("应能解回来");
            assert_eq!(decoded, raw, "长度 {len} 没能往返");
        }
    }

    #[test]
    fn b64url_decode_rejects_garbage() {
        assert!(b64url_decode("****").is_none());
        // 填充与换行要容忍：JWT 两种写法都出现过
        assert_eq!(b64url_decode("Zm9vYg==").unwrap(), b"foob");
        assert_eq!(b64url_decode("Zm9v\nYg").unwrap(), b"foob");
    }

    #[test]
    fn code_challenge_matches_rfc7636_example() {
        // RFC 7636 附录 B 的样例，直接钉住实现
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assert_eq!(
            code_challenge(verifier),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn random_b64_is_long_enough_and_unique() {
        // PKCE 要求 verifier 至少 43 个字符
        let a = random_b64(32).unwrap();
        let b = random_b64(32).unwrap();
        assert_eq!(a.len(), 43);
        assert_ne!(a, b, "两次生成的随机串不该一样");
    }

    #[test]
    fn authorize_url_carries_every_required_parameter() {
        let url = authorize_url(
            "https://login.microsoftonline.com/common/oauth2/v2.0",
            "abc-123",
            "http://localhost:51234/callback",
            "st4te",
            "ch4llenge",
        );
        assert!(url.starts_with("https://login.microsoftonline.com/common/oauth2/v2.0/authorize?"));
        assert!(url.contains("client_id=abc-123"));
        assert!(url.contains("response_type=code"));
        // 重定向地址必须被编码，否则参数会被冒号与斜杠截断
        assert!(url.contains("redirect_uri=http%3A%2F%2Flocalhost%3A51234%2Fcallback"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("state=st4te"));
        // scope 里的空格要编码成一个值，不能被拆成多个参数
        assert!(url.contains("scope=Files.ReadWrite.AppFolder%20offline_access%20openid%20profile"));
    }

    #[test]
    fn loopback_base_keeps_no_trailing_slash() {
        let url = authorize_url(
            "https://example.com/x/",
            "c",
            "http://localhost:1/callback",
            "s",
            "ch",
        );
        assert!(url.contains("/x/authorize?"), "不该拼出双斜杠：{url}");
    }

    #[test]
    fn approot_url_uses_path_addressing_and_escapes() {
        let u = approot_url("https://graph.microsoft.com/v1.0", "tasks.json", true).unwrap();
        assert_eq!(
            u.as_str(),
            "https://graph.microsoft.com/v1.0/me/drive/special/approot:/tasks.json:/content"
        );

        // 元数据不加 /content
        let u = approot_url("https://graph.microsoft.com/v1.0", "tasks.json", false).unwrap();
        assert!(u.as_str().ends_with("approot:/tasks.json:"));

        // 保留 unreserved 字符，中文照常编码
        let u = approot_url("https://graph.microsoft.com/v1.0", "子目录/x-y_z.1.json", false).unwrap();
        assert!(u.as_str().contains("x-y_z.1.json"), "unreserved 字符不该被编码");
        assert!(u.as_str().contains("%E5%AD%90"), "中文该被编码成 UTF-8 百分号形式");
    }

    #[test]
    fn approot_url_tolerates_trailing_slash_on_base() {
        let u = approot_url("https://graph.microsoft.com/v1.0/", "a.json", false).unwrap();
        assert!(u.as_str().contains("/v1.0/me/drive/"), "不该出现双斜杠：{u}");
    }

    #[test]
    fn parse_query_decodes_percent_encoding() {
        let p = parse_query("code=1%2F2&state=ab-c&empty=");
        assert_eq!(p[0], ("code".to_string(), "1/2".to_string()));
        assert_eq!(p[1], ("state".to_string(), "ab-c".to_string()));
        assert_eq!(p[2], ("empty".to_string(), String::new()));
    }

    #[test]
    fn token_error_messages_name_the_next_action() {
        // 每种错误都要给出"接下来做什么"，而不是只回一个错误码
        for code in [
            "invalid_grant",
            "invalid_client",
            "unauthorized_client",
            "invalid_request",
            "interaction_required",
            "consent_required",
        ] {
            let msg = describe_token_error(code, "some english description");
            assert!(msg.contains(code), "{code} 的提示里该带上错误码");
            assert!(msg.contains("（"), "{code} 的提示里该带上服务端原文");
            assert!(
                msg.contains("Azure") || msg.contains("连接 OneDrive") || msg.contains("授权"),
                "{code} 的提示没告诉用户下一步：{msg}"
            );
        }
        // 空码也要能出一句人话
        assert!(describe_token_error("", "").contains("拒绝"));
    }

    #[test]
    fn graph_error_extracts_the_service_message() {
        let body = r#"{"error":{"code":"accessDenied","message":"The caller does not have permission"}}"#;
        let msg = describe_graph_error(403, body);
        assert!(msg.contains("Files.ReadWrite.AppFolder"), "403 该指向权限配置：{msg}");
        assert!(msg.contains("The caller does not have permission"), "该带上服务端原文");
        assert!(msg.contains("HTTP 403"));

        // body 不是 JSON 时也不能崩，要退化成截断的原文
        let msg = describe_graph_error(500, "<html>boom</html>");
        assert!(msg.contains("boom"));
        assert!(describe_graph_error(429, "").contains("限流"));
    }

    #[test]
    fn id_token_account_reads_the_email_from_the_payload() {
        // 手工拼一个 id_token：header.payload.signature，payload 是 base64url 的 JSON
        let payload = b64url(br#"{"preferred_username":"someone@outlook.com","name":"Someone"}"#);
        let token = format!("aaa.{payload}.ccc");
        let json = serde_json::json!({ "id_token": token, "access_token": "x" });
        assert_eq!(id_token_account(&json), "someone@outlook.com");

        // 取不到就回落到 name
        let payload = b64url(br#"{"name":"Someone"}"#);
        let token = format!("aaa.{payload}.ccc");
        let json = serde_json::json!({ "id_token": token });
        assert_eq!(id_token_account(&json), "Someone");

        // 这几种情况都必须安静地返回空串，而不是 panic
        assert_eq!(id_token_account(&serde_json::json!({})), "");
        assert_eq!(id_token_account(&serde_json::json!({ "id_token": "not-a-jwt" })), "");
        assert_eq!(
            id_token_account(&serde_json::json!({ "id_token": "aaa.!!!.ccc" })),
            ""
        );
    }

    #[test]
    fn config_falls_back_to_official_endpoints() {
        let cfg = OneDriveConfig::default();
        assert_eq!(cfg.login_base(), DEFAULT_LOGIN_BASE);
        assert_eq!(cfg.graph_base(), DEFAULT_GRAPH_BASE);
        // 全是空格也算没填
        let cfg = OneDriveConfig {
            login_base: "   ".into(),
            graph_base: "\t".into(),
            ..Default::default()
        };
        assert_eq!(cfg.login_base(), DEFAULT_LOGIN_BASE);
        assert_eq!(cfg.graph_base(), DEFAULT_GRAPH_BASE);
        // 测试要能把它指到本地桩
        let cfg = OneDriveConfig {
            login_base: "http://127.0.0.1:9/login".into(),
            graph_base: "http://127.0.0.1:9/graph".into(),
            ..Default::default()
        };
        assert_eq!(cfg.login_base(), "http://127.0.0.1:9/login");
        assert_eq!(cfg.graph_base(), "http://127.0.0.1:9/graph");
    }

    #[test]
    fn form_body_encodes_scope_spaces() {
        let body = form_body(&[
            ("grant_type".into(), "refresh_token".into()),
            ("scope".into(), SCOPE.into()),
        ]);
        assert!(body.starts_with("grant_type=refresh_token&"));
        assert!(body.contains("scope=Files.ReadWrite.AppFolder%20offline_access%20openid%20profile"));
        assert!(!body.contains(' '), "表单里不该出现未编码的空格");
    }

    /* ------------------------------------------------------------------ */
    /* 本地桩：只有真发一次请求才验得到的那些事                              */
    /* ------------------------------------------------------------------ */

    /**
     * OneDrive 这一侧真正容易写错的不是算 PKCE（那是纯函数，已经钉住了），
     * 而是**请求本身**：URL 走的是 `:/路径:` 这种寻址（少一个冒号就 404）、
     * 有没有带 Authorization、404 该不该化成"云端还没有这个文件"、
     * PUT 上去的 GET 回来是不是同一份、登录失败时给的是不是那句能救人的提示。
     *
     * 对着真微软跑测试不现实（要租户、要人点授权、还会污染用户的网盘），
     * 所以这里起一个只实现我们用到的语义的本地桩：`/token` 与
     * `/me/drive/special/approot`。随机端口，不会跟别的东西撞；
     * 只解析请求行与几个头，够用且不引依赖。
     */
    mod mock {
        use std::collections::HashMap;
        use std::io::{BufRead, BufReader, Read, Write};
        use std::net::{TcpListener, TcpStream};
        use std::sync::{Arc, Mutex};

        const NOT_FOUND: &str =
            r#"{"error":{"code":"itemNotFound","message":"The resource could not be found."}}"#;
        const EXPIRED: &str = r#"{"error":{"code":"InvalidAuthenticationToken","message":"Access token has expired."}}"#;

        #[derive(Clone)]
        pub struct Seen {
            pub method: String,
            /// 含查询串 —— 用来验 `$select` 与 `:/路径:/content`
            pub path: String,
            pub auth: String,
            pub content_type: String,
            pub body: String,
        }

        pub struct State {
            /// 云端"已有"的文件
            pub files: HashMap<String, String>,
            /// `/token` 要回的状态码与正文
            pub token_reply: (u16, String),
            /// 一律 401 —— 验"令牌过期时提示的是什么"
            pub reject_graph: bool,
        }

        impl Default for State {
            fn default() -> Self {
                State {
                    files: HashMap::new(),
                    token_reply: (200, r#"{"access_token":"at","expires_in":3600}"#.to_string()),
                    reject_graph: false,
                }
            }
        }

        pub struct Stub {
            pub base: String,
            pub state: Arc<Mutex<State>>,
            pub seen: Arc<Mutex<Vec<Seen>>>,
        }

        impl Stub {
            pub fn start() -> Stub {
                let listener = TcpListener::bind("127.0.0.1:0").expect("绑定随机端口");
                let port = listener.local_addr().unwrap().port();
                let state = Arc::new(Mutex::new(State::default()));
                let seen = Arc::new(Mutex::new(Vec::new()));

                let s2 = state.clone();
                let n2 = seen.clone();
                std::thread::spawn(move || {
                    for stream in listener.incoming().flatten() {
                        let _ = serve(stream, &s2, &n2);
                    }
                });

                Stub {
                    base: format!("http://127.0.0.1:{port}"),
                    state,
                    seen,
                }
            }

            pub fn set_token_reply(&self, status: u16, body: &str) {
                self.state.lock().unwrap().token_reply = (status, body.to_string());
            }

            pub fn reject_graph(&self, on: bool) {
                self.state.lock().unwrap().reject_graph = on;
            }

            pub fn seen(&self) -> Vec<Seen> {
                self.seen.lock().unwrap().clone()
            }

            pub fn paths(&self) -> Vec<String> {
                self.seen().into_iter().map(|s| s.path).collect()
            }
        }

        fn reason(code: u16) -> &'static str {
            match code {
                200 => "OK",
                400 => "Bad Request",
                401 => "Unauthorized",
                404 => "Not Found",
                405 => "Method Not Allowed",
                _ => "Status",
            }
        }

        fn reply(stream: &mut TcpStream, code: u16, body: &str) {
            let head = format!(
                "HTTP/1.1 {code} {}\r\n\
                 Content-Type: application/json; charset=utf-8\r\n\
                 Content-Length: {}\r\n\
                 Connection: close\r\n\r\n",
                reason(code),
                body.len()
            );
            let _ = stream.write_all(head.as_bytes());
            let _ = stream.write_all(body.as_bytes());
            let _ = stream.flush();
        }

        /// 从 `.../approot:/名字.json:/content` 里取出名字，并判断要的是内容还是元数据。
        ///
        /// 取不到就说明**路径拼错了** —— 这正是要验的东西，所以返回 None 让桩回 404
        /// （真 Graph 也会这么回），而不是宽容地兜底。
        fn approot_target(path: &str) -> Option<(&str, bool)> {
            let after = path.split("approot:/").nth(1)?;
            let want_content = after.contains(":/content");
            let name = after.split(':').next()?;
            if name.is_empty() {
                None
            } else {
                Some((name, want_content))
            }
        }

        fn serve(
            mut stream: TcpStream,
            state: &Mutex<State>,
            seen: &Mutex<Vec<Seen>>,
        ) -> std::io::Result<()> {
            let mut reader = BufReader::new(stream.try_clone()?);

            let mut line = String::new();
            if reader.read_line(&mut line)? == 0 {
                return Ok(());
            }
            let mut parts = line.split_whitespace();
            let method = parts.next().unwrap_or("").to_ascii_uppercase();
            let path = parts.next().unwrap_or("").to_string();

            let mut len = 0usize;
            let mut auth = String::new();
            let mut content_type = String::new();
            loop {
                let mut h = String::new();
                if reader.read_line(&mut h)? == 0 {
                    break;
                }
                let t = h.trim_end();
                if t.is_empty() {
                    break;
                }
                let lower = t.to_ascii_lowercase();
                if let Some(v) = lower.strip_prefix("content-length:") {
                    len = v.trim().parse().unwrap_or(0);
                } else if lower.starts_with("authorization:") {
                    auth = t["authorization:".len()..].trim().to_string();
                } else if lower.starts_with("content-type:") {
                    content_type = t["content-type:".len()..].trim().to_string();
                }
            }

            let mut raw = vec![0u8; len];
            if len > 0 {
                reader.read_exact(&mut raw)?;
            }
            let body = String::from_utf8_lossy(&raw).to_string();

            seen.lock().unwrap().push(Seen {
                method: method.clone(),
                path: path.clone(),
                auth,
                content_type,
                body: body.clone(),
            });

            let mut st = state.lock().unwrap();

            // 登录端点（post_token 会在 base 后面补 /token）
            if path.contains("/token") {
                let (code, text) = st.token_reply.clone();
                drop(st);
                reply(&mut stream, code, &text);
                return Ok(());
            }

            if st.reject_graph {
                drop(st);
                reply(&mut stream, 401, EXPIRED);
                return Ok(());
            }

            // 应用专属文件夹本身（onedrive_check）：没有 `:/` 寻址段
            if path.contains("/special/approot") && !path.contains("approot:/") {
                drop(st);
                reply(
                    &mut stream,
                    200,
                    r#"{"name":"待办工作台","webUrl":"https://example.invalid/x"}"#,
                );
                return Ok(());
            }

            let (name, want_content) = match approot_target(&path) {
                Some(v) => v,
                None => {
                    drop(st);
                    reply(&mut stream, 404, NOT_FOUND);
                    return Ok(());
                }
            };

            match method.as_str() {
                "PUT" => {
                    st.files.insert(name.to_string(), body.clone());
                    let n = body.len();
                    drop(st);
                    reply(&mut stream, 200, &format!(r#"{{"size":{n}}}"#));
                }
                "GET" if want_content => {
                    let found = st.files.get(name).cloned();
                    drop(st);
                    match found {
                        Some(text) => reply(&mut stream, 200, &text),
                        None => reply(&mut stream, 404, NOT_FOUND),
                    }
                }
                "GET" => {
                    let found = st.files.get(name).cloned();
                    drop(st);
                    match found {
                        Some(text) => reply(
                            &mut stream,
                            200,
                            &format!(
                                r#"{{"size":{},"lastModifiedDateTime":"2026-09-23T07:00:00Z"}}"#,
                                text.len()
                            ),
                        ),
                        None => reply(&mut stream, 404, NOT_FOUND),
                    }
                }
                _ => {
                    drop(st);
                    reply(&mut stream, 405, "{}");
                }
            }
            Ok(())
        }
    }

    /// 把配置指到本地桩。`login_base` 要给到 `/oauth2` 那一层 ——
    /// `post_token` 会在后面自己补 `/token`。
    fn cfg_to(stub: &mock::Stub, token: &str) -> OneDriveConfig {
        OneDriveConfig {
            client_id: "client-abc".into(),
            refresh_token: "rt-1".into(),
            access_token: token.into(),
            login_base: format!("{}/oauth2/v2.0", stub.base),
            graph_base: format!("{}/v1.0", stub.base),
        }
    }

    fn bind_callback() -> (TcpListener, u16) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("绑定回调端口");
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).expect("设为非阻塞");
        (listener, port)
    }

    /// 模拟浏览器来敲一次门。写完不等回话 —— 真实浏览器会读，这里不关心。
    fn knock(port: u16, request: &str) {
        let req = request.to_string();
        std::thread::spawn(move || {
            if let Ok(mut s) = TcpStream::connect(("127.0.0.1", port)) {
                let _ = s.write_all(req.as_bytes());
                let _ = s.flush();
            }
        });
    }

    #[test]
    fn sign_in_refuses_without_a_client_id_before_opening_anything() {
        // 这一步在 bind 端口与 open_url 之前就返回 —— 测试绝不能真的弹出浏览器
        let err = tauri::async_runtime::block_on(onedrive_sign_in(OneDriveConfig::default()))
            .unwrap_err();
        assert!(err.contains("客户端 ID"), "{err}");
    }

    #[test]
    fn refresh_failure_is_translated_into_the_next_action() {
        let stub = mock::Stub::start();
        stub.set_token_reply(
            400,
            r#"{"error":"invalid_grant","error_description":"AADSTS70000: refresh token expired"}"#,
        );
        let err =
            tauri::async_runtime::block_on(onedrive_refresh(cfg_to(&stub, ""))).unwrap_err();
        assert!(err.contains("连接 OneDrive"), "要告诉用户去重新登录：{err}");
        assert!(err.contains("invalid_grant"), "{err}");
    }

    #[test]
    fn refresh_posts_the_right_grant_and_keeps_the_old_token_when_none_is_returned() {
        let stub = mock::Stub::start();
        // 关键：服务端这次**没发**新的 refresh_token
        stub.set_token_reply(200, r#"{"access_token":"at-new","expires_in":1800}"#);

        let t = tauri::async_runtime::block_on(onedrive_refresh(cfg_to(&stub, ""))).unwrap();
        assert_eq!(t.access_token, "at-new");
        assert_eq!(t.expires_in, 1800);
        assert_eq!(
            t.refresh_token, "rt-1",
            "服务端没发新的就得沿用旧的 —— 回一个空串等于把登录弄丢"
        );

        let seen = stub.seen();
        assert_eq!(seen.len(), 1, "刷新应当是且只是一次 POST");
        assert!(seen[0].path.ends_with("/oauth2/v2.0/token"), "{}", seen[0].path);
        assert_eq!(seen[0].method, "POST");
        assert!(seen[0].body.contains("grant_type=refresh_token"), "{}", seen[0].body);
        assert!(seen[0].body.contains("client_id=client-abc"));
        assert!(seen[0].body.contains("refresh_token=rt-1"));
        assert!(!seen[0].body.contains(' '), "表单里不该有未编码的空格");
        assert!(
            seen[0].auth.is_empty(),
            "换令牌靠的是 client_id + PKCE，不该带 Bearer 头"
        );
    }

    #[test]
    fn refresh_rotates_the_token_when_the_server_sends_a_new_one() {
        let stub = mock::Stub::start();
        stub.set_token_reply(
            200,
            r#"{"access_token":"at2","refresh_token":"rt2","expires_in":3600}"#,
        );
        let t = tauri::async_runtime::block_on(onedrive_refresh(cfg_to(&stub, ""))).unwrap();
        assert_eq!(t.refresh_token, "rt2");
        assert_eq!(t.expires_in, 3600);
    }

    #[test]
    fn missing_credentials_are_rejected_before_any_request() {
        let stub = mock::Stub::start();

        let no_client = OneDriveConfig {
            client_id: "  ".into(),
            refresh_token: "rt-1".into(),
            login_base: format!("{}/oauth2/v2.0", stub.base),
            ..Default::default()
        };
        let err = tauri::async_runtime::block_on(onedrive_refresh(no_client)).unwrap_err();
        assert!(err.contains("客户端 ID"), "{err}");

        let not_signed_in = OneDriveConfig {
            client_id: "client-abc".into(),
            login_base: format!("{}/oauth2/v2.0", stub.base),
            ..Default::default()
        };
        let err = tauri::async_runtime::block_on(onedrive_refresh(not_signed_in)).unwrap_err();
        assert!(err.contains("连接 OneDrive"), "{err}");

        assert!(stub.seen().is_empty(), "本地就该拦住，不该白跑一趟网络");
    }

    #[test]
    fn every_graph_command_refuses_without_an_access_token() {
        let stub = mock::Stub::start();
        let n = || "tasks.json".to_string();

        let err = tauri::async_runtime::block_on(onedrive_check(cfg_to(&stub, ""))).unwrap_err();
        assert!(err.contains("先连接一次 OneDrive"), "{err}");
        let err = tauri::async_runtime::block_on(onedrive_get(cfg_to(&stub, ""), n())).unwrap_err();
        assert!(err.contains("先连接一次 OneDrive"), "{err}");
        let err =
            tauri::async_runtime::block_on(onedrive_put(cfg_to(&stub, ""), n(), "x".into()))
                .unwrap_err();
        assert!(err.contains("先连接一次 OneDrive"), "{err}");
        let err = tauri::async_runtime::block_on(onedrive_stat(cfg_to(&stub, ""), n())).unwrap_err();
        assert!(err.contains("先连接一次 OneDrive"), "{err}");

        assert!(stub.seen().is_empty(), "没有令牌就不该发出任何请求");
    }

    #[test]
    fn check_reports_the_app_folder_name() {
        let stub = mock::Stub::start();
        let r = tauri::async_runtime::block_on(onedrive_check(cfg_to(&stub, "at-1"))).unwrap();
        assert!(r.folder_exists, "首次访问会自动建出来，正常路径下总是 true");
        assert_eq!(r.folder_path, "待办工作台");
        assert!(r.message.contains("待办工作台"), "{}", r.message);
        assert!(r.message.contains("应用"), "该告诉用户它在哪：{}", r.message);

        let seen = stub.seen();
        assert_eq!(seen.len(), 1);
        assert!(
            seen[0].path.starts_with("/v1.0/me/drive/special/approot"),
            "{}",
            seen[0].path
        );
        assert!(
            !seen[0].path.contains("approot:/"),
            "查文件夹本身不该用 `:/路径:` 寻址：{}",
            seen[0].path
        );
        assert!(seen[0].path.contains("select"), "该只要 name/webUrl：{}", seen[0].path);
        assert_eq!(seen[0].auth, "Bearer at-1");
    }

    #[test]
    fn put_then_get_round_trips_through_path_addressing() {
        let stub = mock::Stub::start();
        let text = r#"{"app":"todo-workbench","shard":"tasks","payload":{}}"#;

        let n =
            tauri::async_runtime::block_on(onedrive_put(cfg_to(&stub, "at-1"), "tasks.json".into(), text.into()))
                .unwrap();
        assert_eq!(n, text.len() as u64, "交回的是服务端记的字节数");

        let back =
            tauri::async_runtime::block_on(onedrive_get(cfg_to(&stub, "at-1"), "tasks.json".into()))
                .unwrap();
        assert_eq!(back.as_deref(), Some(text), "PUT 上去的应能原样 GET 回来");

        let seen = stub.seen();
        assert!(
            seen[0].path.contains("/me/drive/special/approot:/tasks.json:/content"),
            "路径寻址要拼对（少一个冒号真 Graph 就 404）：{}",
            seen[0].path
        );
        assert_eq!(seen[0].method, "PUT");
        assert!(
            seen[0].content_type.contains("application/json"),
            "存的是 JSON 文件，Content-Type 写对了网页版预览才正常：{}",
            seen[0].content_type
        );
        assert!(seen.iter().all(|s| s.auth == "Bearer at-1"), "每个请求都要带令牌");
    }

    #[test]
    fn missing_file_is_none_not_an_error() {
        let stub = mock::Stub::start();
        let got =
            tauri::async_runtime::block_on(onedrive_get(cfg_to(&stub, "at"), "nope.json".into()))
                .unwrap();
        assert!(got.is_none(), "首次同步时云端本来就没有这个分片，这不是错误");
        assert!(stub.paths()[0].contains("approot:/nope.json:/content"));
    }

    #[test]
    fn stat_asks_for_metadata_without_the_content_segment() {
        let stub = mock::Stub::start();
        tauri::async_runtime::block_on(onedrive_put(cfg_to(&stub, "at"), "orders.json".into(), "abc".into()))
            .unwrap();

        let e = tauri::async_runtime::block_on(onedrive_stat(cfg_to(&stub, "at"), "orders.json".into()))
            .unwrap()
            .expect("刚传上去的应当存在");
        assert_eq!(e.size, 3);
        assert_eq!(e.modified, "2026-09-23T07:00:00Z");

        let last = stub.paths().last().unwrap().clone();
        assert!(
            !last.contains("/content"),
            "取元数据不能带 /content（那会真把文件拉下来）：{last}"
        );
        assert!(last.contains("approot:/orders.json:"), "{last}");

        assert!(
            tauri::async_runtime::block_on(onedrive_stat(cfg_to(&stub, "at"), "none.json".into()))
                .unwrap()
                .is_none(),
            "云端没有这个文件时给 None，而不是报错"
        );
    }

    #[test]
    fn oversized_upload_is_refused_before_leaving_the_machine() {
        let stub = mock::Stub::start();
        let huge = "x".repeat(MAX_SHARD_BYTES + 1);
        let err = tauri::async_runtime::block_on(onedrive_put(
            cfg_to(&stub, "at"),
            "tasks.json".into(),
            huge,
        ))
        .unwrap_err();
        assert!(err.contains("过大"), "{err}");
        assert!(stub.seen().is_empty(), "本地就该拦住，不该白传 16 MB");
    }

    #[test]
    fn expired_token_points_back_to_signing_in_again() {
        let stub = mock::Stub::start();
        stub.reject_graph(true);

        let err =
            tauri::async_runtime::block_on(onedrive_check(cfg_to(&stub, "at-old"))).unwrap_err();
        assert!(err.contains("连接 OneDrive"), "得告诉用户下一步：{err}");
        assert!(err.contains("HTTP 401"), "{err}");

        let err =
            tauri::async_runtime::block_on(onedrive_get(cfg_to(&stub, "at-old"), "tasks.json".into()))
                .unwrap_err();
        assert!(err.contains("HTTP 401"), "{err}");
        assert!(err.contains("Access token has expired"), "该带上服务端原文：{err}");
    }

    #[test]
    fn callback_captures_the_code_and_skips_unrelated_requests() {
        let (listener, port) = bind_callback();
        // 浏览器会顺手来要 favicon —— 那不是我们的回调，必须跳过而不是当成失败
        knock(port, "GET /favicon.ico HTTP/1.1\r\nHost: localhost\r\n\r\n");
        std::thread::sleep(Duration::from_millis(250));
        // code 里的百分号编码要解开（真实授权码里带 / 与 + 是常事）
        knock(
            port,
            "GET /callback?code=CODE%2F1%2Ba&state=ST-1 HTTP/1.1\r\nHost: localhost\r\n\r\n",
        );

        let code = wait_for_code(listener, "ST-1", Duration::from_secs(5)).expect("应拿到授权码");
        assert_eq!(code, "CODE/1+a");
    }

    #[test]
    fn callback_rejects_a_mismatched_state() {
        let (listener, port) = bind_callback();
        knock(port, "GET /callback?code=C&state=别的登录 HTTP/1.1\r\n\r\n");
        let err = wait_for_code(listener, "ST-1", Duration::from_secs(5)).unwrap_err();
        assert!(err.contains("state"), "{err}");
        assert!(err.contains("放弃"), "得说清这次登录没成：{err}");
    }

    #[test]
    fn callback_reports_a_user_refusal_in_plain_words() {
        let (listener, port) = bind_callback();
        knock(
            port,
            "GET /callback?error=access_denied&error_description=user%20said%20no HTTP/1.1\r\n\r\n",
        );
        let err = wait_for_code(listener, "ST-1", Duration::from_secs(5)).unwrap_err();
        assert!(err.contains("拒绝"), "点了拒绝要说人话：{err}");
        assert!(err.contains("access_denied"), "{err}");
    }

    #[test]
    fn callback_without_a_code_says_so_instead_of_waiting_forever() {
        let (listener, port) = bind_callback();
        knock(port, "GET /callback?state=ST-1 HTTP/1.1\r\n\r\n");
        let err = wait_for_code(listener, "ST-1", Duration::from_secs(5)).unwrap_err();
        assert!(err.contains("没有 code"), "{err}");
    }

    #[test]
    fn callback_timeout_tells_the_user_what_to_do() {
        let (listener, _port) = bind_callback();
        let err = wait_for_code(listener, "ST-1", Duration::from_millis(300)).unwrap_err();
        assert!(err.contains("5 分钟"), "{err}");
        assert!(err.contains("连接 OneDrive"), "{err}");
    }
}

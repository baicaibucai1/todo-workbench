//! WPS SkillHub MCP —— 「我的云文档」直连。
//!
//! 与 `wps.rs` 的 kwiki 那条路是**两套授权，别混**：
//!
//!   · kwiki（`wps.rs`）→ `zhishi.wps.cn/kwiki`，令牌只能碰知识库里的文件；
//!   · MCP（这里）    → `mcp-center.wps.cn/skill_hub/mcp`，令牌能碰**全部云文档**
//!     （625 个工具：sheet.* / dbsheet.* / wps.* / wpp.* …）。
//!
//! 两者都是设备码授权，但码不通用：kwiki 的码由服务端生成、换令牌时打
//! `/access_token/exchange`；MCP 的码是**本地随机生成**的，用户拿它去
//! 授权页确认，程序再拿同一个码去 `api.wps.cn/office/v5/ai/skill_hub/wps_auth/exchange` 换令牌。
//!
//! 为什么令牌与 client id 必须成对：服务端把两者绑在一起校验，少一个就
//! 报「Token 无效」（code=400006）。client id 是本地生成的 16 位 hex，
//! 换不换无所谓，但每次请求都得带。
//!
//! 这一版**只做连接**：授权 → 换令牌 → 握手 → 报工具数与云文档数。
//! 具体的读表/写表留给后续，先把「能不能连上、连上之后看见什么」
//! 在设置页里摆明白 —— 连接没打通之前，写再多读写代码都是盲写。

use std::time::Duration;

use ring::rand::{SecureRandom, SystemRandom};
use serde::Serialize;
use serde_json::{json, Map as JsonMap, Value as Json};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::wps::WpsPull;
use crate::wps_cloud_plan::{plan_cloud_write, COLUMNS};

const MCP_URL: &str = "https://mcp-center.wps.cn/skill_hub/mcp";
const AUTH_GUIDE: &str = "https://mcp-center.wps.cn/kdocs-auth/auth-guide?auth_code=";
const EXCHANGE_URL: &str = "https://api.wps.cn/office/v5/ai/skill_hub/wps_auth/exchange";
/// **参与鉴权**：服务端拿它判客户端版本，改错直接「Token 无效」。
/// 服务端升版后这里要跟着改（skill 里记的是 1.6.14）。
const SKILL_VER: &str = "1.6.14";
/// 只是渠道标签，实测任意值都给全量工具；带上是与官方 CLI 一致。
const SOURCE: &str = "todo-workbench";
const TIMEOUT: Duration = Duration::from_secs(45);

/* ------------------------------------------------------------------ */
/* 出入参                                                              */
/* ------------------------------------------------------------------ */

#[derive(Debug, Serialize)]
pub struct WpsMcpBegin {
    /// 本地生成的授权码（带连字符的小写 UUID，与 `str(uuid4())` 同形）。
    /// auth-guide 页面按这个形状校验，裸 hex 过不去 —— 见 `new_auth_code`。
    pub auth_code: String,
    /// 用户要用**已登录 WPS 的浏览器**打开的授权页。
    pub auth_url: String,
    /// 与服务端令牌成对使用的客户端标识（16 位 hex）。
    pub client_id: String,
}

#[derive(Debug, Serialize)]
pub struct WpsMcpPoll {
    /// `waiting` 还没点同意 / `ok` 拿到令牌 / `cancelled` 用户取消 /
    /// `enterprise` 企业账号（这条路只给个人号）。
    pub status: String,
    pub token: String,
    /// 令牌剩余秒数。服务端不给就是 0（界面别显示成"已过期"）。
    pub expires_in: i64,
    /// 等待态时带服务端原话，出问题时不抓瞎。
    pub message: String,
}

/// 推送结果。字段与前端 `wpsMcp.ts` 的 `McpPush` 逐字对应。
#[derive(Debug, Serialize)]
pub struct WpsMcpPush {
    /// 推了几条
    pub count: usize,
    /// 写了几列（含补在末尾的新列）
    pub columns: usize,
    /// 末尾补了几列（表里原来没有的台账列）
    pub appended: usize,
    /// 推到哪个文件（就是绑定的 file_id）
    pub file_kuid: String,
}

#[derive(Debug, Serialize)]
pub struct WpsMcpProbe {
    /// tools/list 返回的工具数。625 是当前服务端的全量。
    pub tools: usize,
    /// 根目录云文档数。-1 = 没读到（工具清单拿到了，但这次调用失败）。
    pub files: i64,
    /// 前三个文件名，给人看的"确实读到东西了"。
    pub sample: Vec<String>,
    /// 授权账号的昵称。MCP 没有专门的"我是谁"接口，从列文件返回的
    /// `created_by.name` 里取（文件都是这个账号的，创建者就是它）。
    /// 拿不到就留空 —— 界面上显示「未读到」，别编。
    pub user: String,
    pub server: String,
    pub version: String,
    /// 非致命提示（比如「工具清单通了，但列文件失败」）。
    pub note: String,
}

/* ------------------------------------------------------------------ */
/* 基础件                                                              */
/* ------------------------------------------------------------------ */

fn http() -> Result<reqwest::Client, String> {
    // 与 wps.rs 同一个理由：rustls 必须有已安装的 crypto provider 才能握手，
    // 不能依赖"别的插件先跑过"。
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    reqwest::Client::builder()
        .timeout(TIMEOUT)
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))
}

/// 系统随机数转小写 hex。用 ring 而不是引 uuid/rand 新依赖：
/// ring 已经在树里（附件与 TLS 都要它），加两个 crate 反而会触发整树重编。
fn rand_hex(bytes: usize) -> Result<String, String> {
    let mut buf = vec![0u8; bytes];
    SystemRandom::new()
        .fill(&mut buf)
        .map_err(|_| "取系统随机数失败".to_string())?;
    let mut out = String::with_capacity(bytes * 2);
    for b in buf {
        out.push_str(&format!("{b:02x}"));
    }
    Ok(out)
}

fn clip(s: &str, n: usize) -> String {
    // 按字符截断，别把 UTF-8 切断（服务端提示可能是中文）
    s.chars().take(n).collect()
}

/* ------------------------------------------------------------------ */
/* 授权                                                                */
/* ------------------------------------------------------------------ */

/// 生成授权码：**必须带连字符的 UUID**。
///
/// auth-guide 页面用 `/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/` 校验
/// query 里的 auth_code，裸 hex（`uuid4().hex` 那种 32 连号）会被判无效，
/// 页面显示「缺少有效的登录链接」且「前往授权登录」不可用（2026-10-19 实测踩中）。
/// skill 里写的 `code = uuid4()` 是 `str(uuid4())`，天生带连字符 —— 按它来。
fn new_auth_code() -> Result<String, String> {
    let h = rand_hex(16)?;
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    ))
}

/// 生成授权码与 client id。
///
/// **码在本地生成**是这个协议的特点（不像 OAuth 设备流那样由服务端发）：
/// 服务端只认"这个码被某个登录用户在授权页确认过"，所以码必须足够随机，
/// 且同一个码只用来换一次令牌。
#[tauri::command]
pub async fn wps_mcp_begin() -> Result<WpsMcpBegin, String> {
    let auth_code = new_auth_code()?;
    let client_id = rand_hex(8)?;
    Ok(WpsMcpBegin {
        auth_url: format!("{AUTH_GUIDE}{auth_code}"),
        auth_code,
        client_id,
    })
}

/// 授权窗口的标签。固定一个 —— 重复点「授权」时先关旧的，别叠出一排窗口。
const AUTH_WIN: &str = "wps-mcp-auth";

/// 允许授权窗口加载的域名。
///
/// 这个命令会把网址交给**内嵌浏览器**，等于一个「能打开任意页面」的口子。
/// 只放行金山授权链路上的几个域名，别的连同 `file:`、`javascript:` 一起拒 ——
/// 前端传什么进来，都不该有能力让程序去加载任意网址。
fn auth_host_ok(host: Option<&str>) -> bool {
    matches!(
        host,
        Some("mcp-center.wps.cn")
            | Some("account.wps.cn")
            | Some("api.wps.cn")
            | Some("kdocs.cn")
            | Some("www.kdocs.cn")
    )
}

/// 在程序里弹出授权页。
///
/// 为什么不能在前端 `window.open`：Tauri 的 webview 默认不允许新开窗口，
/// 点下去**什么都不发生也不报错**（`attachments.rs` 的 `open_external`
/// 也是为同一个坑存在的）。授权这一步必须真的把页面摆到用户眼前，
/// 否则按钮看起来就是坏的。
///
/// ⚠️ 必须是 **async 命令**，而且 `build()` 要丢进 `spawn_blocking` ——
/// Windows 上 WebView2 把"建窗口"作为消息派给主事件循环并阻塞等回复，
/// 而同步命令就跑在主线程上，等于自己等自己：卡死的表现是**窗口壳和标题
/// 都在、webview 永远不初始化、客户区整块白屏**（实测踩中，tauri#13092
/// 与 WebviewWindowBuilder 文档都写了这条）。async 命令不在主线程上跑，
/// `build()` 阻塞等主线程回复才等得到。
#[tauri::command]
pub async fn wps_mcp_open_auth(app: AppHandle, url: String) -> Result<(), String> {
    let parsed: tauri::Url = url
        .trim()
        .parse()
        .map_err(|_| "授权页网址不合法".to_string())?;
    if parsed.scheme() != "https" {
        return Err(format!("授权页只走 https（收到 {}）", parsed.scheme()));
    }
    if !auth_host_ok(parsed.host_str()) {
        return Err(format!(
            "不在放行名单里的域名：{}",
            parsed.host_str().unwrap_or("-")
        ));
    }

    tauri::async_runtime::spawn_blocking(move || {
        // 重开时先关旧窗口：否则用户点两次就有两个窗口，两个都在等同一个码
        if let Some(old) = app.get_webview_window(AUTH_WIN) {
            let _ = old.close();
        }
        WebviewWindowBuilder::new(&app, AUTH_WIN, WebviewUrl::External(parsed))
            .title("WPS 授权 —— 登录后点「同意」")
            .inner_size(520.0, 760.0)
            .min_inner_size(420.0, 560.0)
            .center()
            .build()
            .map_err(|e| format!("打开授权窗口失败：{e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("调度窗口创建失败：{e}"))?
}

/// 收掉授权窗口。授权成功、取消、超时、离开设置页都要调 ——
/// 留着一个已经没用的窗口，用户会以为流程还卡在那里。
#[tauri::command]
pub fn wps_mcp_close_auth(app: AppHandle) {
    if let Some(w) = app.get_webview_window(AUTH_WIN) {
        let _ = w.close();
    }
}

/// 授权窗口还开着吗。
///
/// 轮询那边用它判断「用户是不是已经把窗口叉掉了」：叉掉之后码不会再有
/// 人确认，继续每 2 秒问 5 分钟只是白等，得当场告诉他。
#[tauri::command]
pub fn wps_mcp_auth_alive(app: AppHandle) -> bool {
    app.get_webview_window(AUTH_WIN).is_some()
}

/// 用授权码换令牌。
///
/// ⚠️ 这个接口的失败**不靠 HTTP 状态码表达**：全部是 200，
/// 成败看信封里的 `code`。实测：未授权 `{"code":202,"message":"waiting for login"}`，
/// 成功 `{"code":200,"data":{"token":"…","expires_in":…},"message":"success"}`。
/// 所以这里不能按 `status.is_success()` 判，必须解析 body。
#[tauri::command]
pub async fn wps_mcp_poll(auth_code: String) -> Result<WpsMcpPoll, String> {
    let code = auth_code.trim();
    if code.is_empty() {
        return Err("授权码是空的".into());
    }
    let resp = http()?
        .post(EXCHANGE_URL)
        .header("Content-Type", "application/json")
        .body(json!({ "code": code }).to_string())
        .send()
        .await
        .map_err(|e| format!("请求授权服务失败：{e}"))?;

    let http_status = resp.status();
    let text = resp.text().await.map_err(|e| format!("读授权返回失败：{e}"))?;
    let v: Json = serde_json::from_str(&text)
        .map_err(|e| format!("授权服务返回的不是 JSON（{e}）：{}", clip(&text, 200)))?;

    let code_num = v.get("code").and_then(Json::as_i64).unwrap_or(-1);
    let message = v
        .get("message")
        .or_else(|| v.get("msg"))
        .and_then(Json::as_str)
        .unwrap_or("")
        .to_string();

    let waiting = |msg: String| WpsMcpPoll {
        status: "waiting".into(),
        token: String::new(),
        expires_in: 0,
        message: msg,
    };

    match code_num {
        // 成功：实测信封码是 **200**（不是 0！）—— 2026-10-19 真实授权抓到的形状：
        // `{"code":200,"data":{"token":"…","expires_in":31535980},"message":"success"}`。
        // 按 0 写的话成功会被落进下面的未知错误分支，前端再一吞，
        // 表现就是「用户明明点完同意，这边永远显示等着」（踩中）。
        // 顺手认一下 0：防服务端哪天改回常规信封。
        200 | 0 => {
            let data = v.get("data").cloned().unwrap_or(Json::Null);
            let token = pick_str(&data, &["token", "access_token"])
                .or_else(|| pick_str(&v, &["token", "access_token"]))
                .unwrap_or_default();
            if token.is_empty() {
                return Err("授权服务说成功，但没给令牌 —— 再试一次".into());
            }
            let expires_in = data
                .get("expires_in")
                .or_else(|| data.get("expire_in"))
                .and_then(Json::as_i64)
                .unwrap_or(0);
            Ok(WpsMcpPoll {
                status: "ok".into(),
                token,
                expires_in,
                message: String::new(),
            })
        }
        // 还没在浏览器里点同意。这是正常状态，不是错误
        202 => Ok(waiting(if message.is_empty() {
            "waiting for login".into()
        } else {
            message
        })),
        403 => Ok(WpsMcpPoll {
            status: "enterprise".into(),
            token: String::new(),
            expires_in: 0,
            message: if message.is_empty() {
                "企业账号用不了这条路".into()
            } else {
                message
            },
        }),
        409 => Ok(WpsMcpPoll {
            status: "cancelled".into(),
            token: String::new(),
            expires_in: 0,
            message: if message.is_empty() {
                "授权被取消了".into()
            } else {
                message
            },
        }),
        _ => Err(format!(
            "授权服务返回 {http_status}（code {code_num}）：{}",
            if message.is_empty() {
                clip(&text, 200)
            } else {
                message
            }
        )),
    }
}

fn pick_str(v: &Json, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|k| v.get(*k).and_then(Json::as_str))
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/* ------------------------------------------------------------------ */
/* MCP 会话                                                            */
/* ------------------------------------------------------------------ */

struct Rpc {
    /// None = 服务端回了空体。`notifications/initialized` 的 202 就是这种，
    /// 它是正常应答，别当错误。
    body: Option<Json>,
    session: Option<String>,
}

async fn rpc(
    client: &reqwest::Client,
    token: &str,
    client_id: &str,
    session: Option<&str>,
    payload: Json,
) -> Result<Rpc, String> {
    let mut req = client
        .post(MCP_URL)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .header("Authorization", format!("Bearer {token}"))
        .header("X-Request-Source", SOURCE)
        .header("X-Skill-Version", SKILL_VER)
        .header("X-Client-Id", client_id);
    if let Some(s) = session {
        req = req.header("Mcp-Session-Id", s);
    }
    let resp = req
        .body(payload.to_string())
        .send()
        .await
        .map_err(|e| format!("连不上 MCP 服务器：{e}"))?;

    let status = resp.status();
    let session = resp
        .headers()
        .get("mcp-session-id")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let text = resp.text().await.map_err(|e| format!("读 MCP 返回失败：{e}"))?;

    if !status.is_success() {
        return Err(format!("MCP 返回 {status}：{}", clip(&text, 300)));
    }
    if text.trim().is_empty() {
        return Ok(Rpc { body: None, session });
    }
    Ok(Rpc {
        body: Some(parse_body(&text)?),
        session,
    })
}

/// 响应可能是裸 JSON，也可能是 SSE（`event: message\ndata: {...}`）。
/// SSE 里可能有多条 `data:`，**取最后一条** —— 前面可能是 ping/进度。
fn parse_body(text: &str) -> Result<Json, String> {
    let t = text.trim_start();
    if t.starts_with('{') || t.starts_with('[') {
        return serde_json::from_str(t).map_err(|e| format!("MCP 返回不是 JSON（{e}）：{}", clip(t, 200)));
    }
    let mut last: Option<Json> = None;
    for line in t.lines() {
        let line = line.trim_start();
        if let Some(rest) = line.strip_prefix("data:") {
            let rest = rest.trim();
            if rest.is_empty() || rest == "[DONE]" {
                continue;
            }
            if let Ok(v) = serde_json::from_str::<Json>(rest) {
                last = Some(v);
            }
        }
    }
    last.ok_or_else(|| format!("MCP 返回无法解析：{}", clip(t, 200)))
}

/// 从 `result.content[].text` 里取出业务信封（`{code,message,data}`）。
///
/// 三层皮：JSON-RPC（result/error）→ content 数组 → 业务 code。
/// 业务 code != 0 才是真失败；不是信封（纯文本）也当成功返回原文。
fn content_text(body: &Json) -> Result<String, String> {
    if let Some(err) = body.get("error") {
        return Err(format!(
            "MCP 报错：{}",
            err.get("message")
                .and_then(Json::as_str)
                .unwrap_or("未知错误")
        ));
    }
    let content = body
        .get("result")
        .and_then(|r| r.get("content"))
        .and_then(Json::as_array)
        .cloned()
        .unwrap_or_default();
    Ok(content
        .iter()
        .filter_map(|c| c.get("text").and_then(Json::as_str))
        .collect::<Vec<_>>()
        .join(""))
}

/// 握手 + 清点。失败就报错（连不上要让人看见原因，不能假装连上了）。
#[tauri::command]
pub async fn wps_mcp_probe(token: String, client_id: String) -> Result<WpsMcpProbe, String> {
    let token = token.trim().to_string();
    let client_id = client_id.trim().to_string();
    if token.is_empty() {
        return Err("还没有令牌 —— 先点「授权并连接」".into());
    }
    if client_id.is_empty() {
        return Err("缺少 client id —— 重新授权一次（它和令牌必须成对）".into());
    }
    let client = http()?;

    // ① initialize。会话 id 只在这一步的响应头里给
    let init = rpc(
        &client,
        &token,
        &client_id,
        None,
        json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": { "name": SOURCE, "version": env!("CARGO_PKG_VERSION") }
            }
        }),
    )
    .await?;
    let session = init
        .session
        .ok_or("MCP 没给会话 id —— 令牌可能已失效，重新授权")?;
    let init_body = init.body.ok_or("initialize 返回了空体")?;
    if let Some(err) = init_body.get("error") {
        return Err(format!(
            "握手失败：{}",
            err.get("message").and_then(Json::as_str).unwrap_or("未知错误")
        ));
    }
    let info = init_body
        .get("result")
        .and_then(|r| r.get("serverInfo"))
        .cloned()
        .unwrap_or(Json::Null);
    let server = pick_str(&info, &["name"]).unwrap_or_default();
    let version = pick_str(&info, &["version"]).unwrap_or_default();

    // ② notifications/initialized。**少了它 tools/call 会静默无反应**
    rpc(
        &client,
        &token,
        &client_id,
        Some(&session),
        json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
    )
    .await?;

    // ③ tools/list
    let listed = rpc(
        &client,
        &token,
        &client_id,
        Some(&session),
        json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
    )
    .await?;
    let listed = listed.body.ok_or("tools/list 返回了空体")?;
    if let Some(err) = listed.get("error") {
        return Err(format!(
            "拿工具清单失败：{}",
            err.get("message").and_then(Json::as_str).unwrap_or("未知错误")
        ));
    }
    let tools = listed
        .get("result")
        .and_then(|r| r.get("tools"))
        .and_then(Json::as_array)
        .map(|a| a.len())
        .unwrap_or(0);
    if tools == 0 {
        return Err("工具清单是空的 —— 令牌可能没有云文档权限".into());
    }

    // ④ 真调一次只读工具：光有清单不代表能干活。
    //    这一步失败**不否认证书**（清单都拿到了），只降级成提示。
    let mut files: i64 = -1;
    let mut sample: Vec<String> = Vec::new();
    let mut user = String::new();
    let mut note = String::new();
    let called = rpc(
        &client,
        &token,
        &client_id,
        Some(&session),
        json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": { "name": "list_my_files", "arguments": { "page_size": 50 } }
        }),
    )
    .await;

    match called {
        Ok(r) => match r.body {
            None => note = "工具清单通了，但列文件没有返回内容".into(),
            Some(body) => match content_text(&body) {
                Err(e) => note = format!("工具清单通了，但列文件失败：{e}"),
                Ok(text) => {
                    // 业务信封：code==0 才算成功；不是信封（纯文本）就当没读到
                    let parsed: Option<Json> = serde_json::from_str(&text).ok();
                    let ok = parsed
                        .as_ref()
                        .and_then(|v| v.get("code"))
                        .and_then(Json::as_i64)
                        .map(|c| c == 0)
                        .unwrap_or(false);
                    if ok {
                        let items = parsed
                            .as_ref()
                            .and_then(|v| v.get("data"))
                            .and_then(|d| d.get("items"))
                            .and_then(Json::as_array)
                            .cloned()
                            .unwrap_or_default();
                        files = items.len() as i64;
                        sample = items
                            .iter()
                            .filter_map(|it| {
                                it.get("name").and_then(Json::as_str).map(str::to_string)
                            })
                            .take(3)
                            .collect();
                        // 授权用户：MCP 没有"我是谁"接口，拿第一个文件的创建者。
                        // 文件都是授权账号的，创建者就是它
                        user = items
                            .first()
                            .and_then(|it| it.get("created_by"))
                            .and_then(|u| u.get("name"))
                            .and_then(Json::as_str)
                            .unwrap_or("")
                            .to_string();
                    } else {
                        let code = parsed
                            .as_ref()
                            .and_then(|v| v.get("code"))
                            .and_then(Json::as_i64)
                            .unwrap_or(-1);
                        note = format!("工具清单通了，但列文件被拒（业务码 {code}）");
                    }
                }
            },
        },
        Err(e) => note = format!("工具清单通了，但列文件失败：{e}"),
    }

    Ok(WpsMcpProbe {
        tools,
        files,
        sample,
        user,
        server,
        version,
        note,
    })
}

/* ------------------------------------------------------------------ */
/* 工具桥                                                              */
/* ------------------------------------------------------------------ */

/// 桥接白名单：工具 iframe 能通过桥触达的 MCP 工具就这五个。
///
/// 这条命令**不该变成"625 个工具随便调"的口子** —— 工具桥的另一头是
/// 任意第三方代码，白名单写在 Rust 侧（而不是只在前端判断），要加
/// 工具就得改这里、编译时会被看见。
const BRIDGE_TOOLS: &[&str] = &[
    "list_my_files",
    "read_file",
    "sheet.get_sheets_info",
    "sheet.get_range_data",
    // 写表：整块选区按格写（清空用空串，长号要特殊处理 —— 见 toolBridge）
    "sheet.update_range_data",
    "otl.insert_content",
];

/// 桥接调用：握手一次 → 调白名单里的一个工具 → 返回**业务信封原文**。
///
/// 解包（code==0 判定、取 data.detail.*）放在前端做 —— 信封形状每个工具
/// 都不一样，TS 里好写测试；Rust 只负责把三层皮（JSON-RPC → content → 信封）
/// 剥到最后一层。每次调用都重新握手：三条请求换一次业务结果，对用户
/// 手点按钮的节奏来说足够快，也省去会话过期的状态管理。
#[tauri::command]
pub async fn wps_mcp_bridge(
    token: String,
    client_id: String,
    tool: String,
    args: Json,
) -> Result<String, String> {
    let token = token.trim().to_string();
    let client_id = client_id.trim().to_string();
    if token.is_empty() || client_id.is_empty() {
        return Err("WPS MCP 还没连接（缺令牌或 client id）".into());
    }
    if !BRIDGE_TOOLS.contains(&tool.as_str()) {
        return Err(format!("不在桥接白名单里的工具：{tool}"));
    }
    if !tool
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_')
    {
        return Err("工具名不合法".into());
    }

    let client = http()?;
    let init = rpc(
        &client,
        &token,
        &client_id,
        None,
        json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": { "name": SOURCE, "version": env!("CARGO_PKG_VERSION") }
            }
        }),
    )
    .await?;
    let session = init
        .session
        .ok_or("MCP 没给会话 id —— 令牌可能已失效，重新授权")?;
    if let Some(body) = init.body {
        if let Some(err) = body.get("error") {
            return Err(format!(
                "握手失败：{}",
                err.get("message").and_then(Json::as_str).unwrap_or("未知错误")
            ));
        }
    }
    rpc(
        &client,
        &token,
        &client_id,
        Some(&session),
        json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
    )
    .await?;

    let called = rpc(
        &client,
        &token,
        &client_id,
        Some(&session),
        json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": { "name": tool, "arguments": args }
        }),
    )
    .await?;
    let body = called.body.ok_or("MCP 返回了空体")?;
    content_text(&body)
}

/* ------------------------------------------------------------------ */
/* 台账同步（原 AirScript 那条路，2026-10-19 迁到 MCP）                  */
/* ------------------------------------------------------------------ */

/// MCP 的 `rangeData` 是**非空格 + 坐标**的列表，先拼成等宽网格。
///
/// 空格服务端不给，所以拿不到"这一行到底有没有内容" —— 拼的时候按
/// 已用范围（sheetsInfo 给的 rowTo/colTo）铺满空串。合并单元格的值在左上角，
/// 右下角留空，跟表格里的观感一致。
fn grid_of(cells: &[Json], row_to: usize, col_to: usize) -> Vec<Vec<String>> {
    let mut grid = vec![vec![String::new(); col_to + 1]; row_to + 1];
    for c in cells {
        let r = c.get("rowFrom").and_then(Json::as_i64).unwrap_or(-1);
        let col = c.get("colFrom").and_then(Json::as_i64).unwrap_or(-1);
        if r < 0 || col < 0 || r as usize > row_to || col as usize > col_to {
            continue;
        }
        let text = c
            .get("cellText")
            .or_else(|| c.get("originalCellValue"))
            .and_then(Json::as_str)
            .unwrap_or("")
            .to_string();
        grid[r as usize][col as usize] = text;
    }
    grid
}

/// 长数字必须**当文本写**：服务端按 double 存，19 位订单号末尾直接丢了。
///
/// 实测（2026-10-19）：直写 `6931234567890123456` → 读回 `6.93123E+18`；
/// 前导单引号之后读回一字不差。前导零同理（"007" 当数字写就变 7）。
fn formula_of(v: &str) -> String {
    let digits = !v.is_empty() && v.chars().all(|c| c.is_ascii_digit());
    if digits && (v.len() >= 15 || (v.len() > 1 && v.starts_with('0'))) {
        return format!("'{v}");
    }
    v.to_string()
}

/// 一次批量写的格数上限。一次几万格会让请求变大，失败就得整批重来
const WRITE_BATCH: usize = 5000;

/// 找到要用的工作表：绑定里存的是表名，worksheet_id 得现查。
/// 没指定或找不到就用第一张 —— 与工具桥那边的取舍一致。
fn pick_sheet(sheets: &[Json], want: &str) -> Result<(i64, usize, usize), String> {
    let want = want.trim();
    let hit = sheets
        .iter()
        .find(|s| want.is_empty() || s.get("sheetName").and_then(Json::as_str) == Some(want))
        .or_else(|| sheets.first())
        .ok_or("这份表格没有可见的工作表")?;
    Ok((
        hit.get("sheetId").and_then(Json::as_i64).unwrap_or(0),
        hit.get("rowTo").and_then(Json::as_i64).unwrap_or(0) as usize,
        hit.get("colTo").and_then(Json::as_i64).unwrap_or(0) as usize,
    ))
}

/// 读一张表的当前内容（表头 + 已用范围），台账推送前要用它算对账。
async fn read_sheet_grid(
    client: &reqwest::Client,
    token: &str,
    client_id: &str,
    session: &str,
    file_id: &str,
    sheet: &str,
) -> Result<(i64, String, Vec<Vec<String>>), String> {
    let info = mcp_biz(
        &rpc(
            client,
            token,
            client_id,
            Some(session),
            json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"sheet.get_sheets_info","arguments":{"file_id":file_id}}}),
        )
        .await?
        .body
        .ok_or("探表返回了空体")?,
    )?;
    let sheets = info
        .get("detail")
        .and_then(|d| d.get("sheetsInfo"))
        .and_then(Json::as_array)
        .cloned()
        .unwrap_or_default();
    let (sheet_id, row_to, col_to) = pick_sheet(&sheets, sheet)?;
    let name = sheets
        .iter()
        .find(|s| s.get("sheetId").and_then(Json::as_i64) == Some(sheet_id))
        .and_then(|s| s.get("sheetName"))
        .and_then(Json::as_str)
        .unwrap_or("")
        .to_string();
    let data = mcp_biz(
        &rpc(
            client,
            token,
            client_id,
            Some(session),
            json!({
                "jsonrpc":"2.0","id":4,"method":"tools/call",
                "params":{"name":"sheet.get_range_data","arguments":{
                    "file_id":file_id,
                    "worksheet_id":sheet_id,
                    "range":{"rowFrom":0,"rowTo":row_to,"colFrom":0,"colTo":col_to}
                }}
            }),
        )
        .await?
        .body
        .ok_or("读表返回了空体")?,
    )?;
    let cells = data
        .get("detail")
        .and_then(|d| d.get("rangeData"))
        .and_then(Json::as_array)
        .cloned()
        .unwrap_or_default();
    Ok((sheet_id, name, grid_of(&cells, row_to, col_to)))
}

/// 取业务信封的 `data`，非 0 直接报错（服务端把失败装在 200 的 body 里）。
fn mcp_biz(body: &Json) -> Result<Json, String> {
    if let Some(err) = body.get("error") {
        return Err(format!(
            "MCP 报错：{}",
            err.get("message").and_then(Json::as_str).unwrap_or("未知错误")
        ));
    }
    let text = content_text(body)?;
    let env: Json = serde_json::from_str(&text)
        .map_err(|e| format!("MCP 业务信封不是 JSON（{e}）：{}", clip(&text, 200)))?;
    let code = env.get("code").and_then(Json::as_i64).unwrap_or(-1);
    if code != 0 {
        return Err(format!(
            "MCP 业务码 {code}：{}",
            env.get("message")
                .and_then(Json::as_str)
                .unwrap_or("服务端没说原因")
        ));
    }
    Ok(env.get("data").cloned().unwrap_or(Json::Null))
}

/// 建一次会话：initialize → notifications/initialized → 返回 session。
/// 一次同步里的几次调用共用同一个会话，省掉重复握手。
async fn open_session(
    client: &reqwest::Client,
    token: &str,
    client_id: &str,
) -> Result<String, String> {
    let init = rpc(
        client,
        token,
        client_id,
        None,
        json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": { "name": SOURCE, "version": env!("CARGO_PKG_VERSION") }
            }
        }),
    )
    .await?;
    let session = init
        .session
        .ok_or("MCP 没给会话 id —— 令牌可能已失效，重新授权")?;
    if let Some(body) = init.body {
        if let Some(err) = body.get("error") {
            return Err(format!(
                "握手失败：{}",
                err.get("message").and_then(Json::as_str).unwrap_or("未知错误")
            ));
        }
    }
    rpc(
        client,
        token,
        client_id,
        Some(&session),
        json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
    )
    .await?;
    Ok(session)
}

/// 拉取在线表格：读回来按**台账列名**映射成本地行（`WpsPull`）。
///
/// 与原来的 `wps_cloud_pull` 语义完全一致：整行全空的跳掉，
/// 只认 COLUMNS 里那 14 个中文表头，别的列忽略。
#[tauri::command]
pub async fn wps_mcp_sheet_pull(
    token: String,
    client_id: String,
    file_id: String,
    sheet: Option<String>,
) -> Result<WpsPull, String> {
    let (token, client_id) = (token.trim(), client_id.trim());
    if token.is_empty() || client_id.is_empty() {
        return Err("WPS MCP 还没连接（缺令牌或 client id）".into());
    }
    let file_id = file_id.trim();
    if file_id.is_empty() {
        return Err("还没选表格 —— 先在下面挑一张".into());
    }
    let client = http()?;
    let session = open_session(&client, token, &client_id).await?;
    let (_, _, grid) = read_sheet_grid(
        &client,
        token,
        &client_id,
        &session,
        file_id,
        &sheet.unwrap_or_default(),
    )
    .await?;

    if grid.is_empty() {
        return Ok(WpsPull {
            file_kuid: file_id.to_string(),
            header: Vec::new(),
            rows: Vec::new(),
        });
    }
    let header = grid[0].clone();
    let colmap: std::collections::HashMap<&str, &str> =
        COLUMNS.iter().map(|(c, h)| (*h, *c)).collect();
    let mut rows = Vec::with_capacity(grid.len().saturating_sub(1));
    for line in grid.iter().skip(1) {
        // 整行全空的行跳掉：表格底部常有一堆"看着空、其实有格式"的行
        if line.iter().all(|c| c.trim().is_empty()) {
            continue;
        }
        let mut m = JsonMap::new();
        for (j, h) in header.iter().enumerate() {
            if let Some(col) = colmap.get(h.trim()) {
                m.insert(
                    (*col).to_string(),
                    Json::String(line.get(j).cloned().unwrap_or_default()),
                );
            }
        }
        rows.push(m);
    }
    Ok(WpsPull {
        file_kuid: file_id.to_string(),
        header,
        rows,
    })
}

/// 推送台账：**只写台账那 14 列**，表里其它列（用户自己的备注/公式）不动。
///
/// 对账逻辑直接复用 `plan_cloud_write`（就是原来 AirScript 那条路用的那份，
/// 带 6 条断言），只是把"写"从 webhook 换成 `sheet.update_range_data`：
/// 找列 → 缺的列补在末尾 → 按列写值 → 多出来的旧行写空串。
#[tauri::command]
pub async fn wps_mcp_sheet_push(
    token: String,
    client_id: String,
    file_id: String,
    sheet: Option<String>,
    rows: Vec<JsonMap<String, Json>>,
) -> Result<WpsMcpPush, String> {
    let (token, client_id) = (token.trim(), client_id.trim());
    if token.is_empty() || client_id.is_empty() {
        return Err("WPS MCP 还没连接（缺令牌或 client id）".into());
    }
    let file_id = file_id.trim();
    if file_id.is_empty() {
        return Err("还没选表格 —— 先在下面挑一张".into());
    }
    if rows.is_empty() {
        return Err("本地没有任何条目 —— 先登记几例再推".into());
    }
    let client = http()?;
    let session = open_session(&client, token, &client_id).await?;
    let sheet = sheet.unwrap_or_default();
    let (sheet_id, _, grid) =
        read_sheet_grid(&client, token, &client_id, &session, file_id, &sheet).await?;

    let header: Vec<String> = grid.first().cloned().unwrap_or_default();
    let old_rows = if grid.len() > 1 { grid.len() - 1 } else { 0 };
    let (cols, clear, appended) = plan_cloud_write(&header, old_rows, &rows)?;

    // 一个格一条 op：MCP 这边的形状是 (rowFrom..rowTo, colFrom..colTo, formula)，
    // 而 plan 给的是"按列 + 1-based 行号"，这里做一次翻译
    let mut ops: Vec<Json> = Vec::new();
    for col in &cols {
        let c0 = col.get("col").and_then(Json::as_i64).unwrap_or(1) - 1;
        let values = col.get("values").and_then(Json::as_array).cloned().unwrap_or_default();
        for (i, v) in values.iter().enumerate() {
            let s = v.as_str().unwrap_or("");
            ops.push(json!({
                "opType": "formula",
                "rowFrom": i, "rowTo": i,
                "colFrom": c0, "colTo": c0,
                "formula": if s.is_empty() { String::new() } else { formula_of(s) },
            }));
        }
    }
    for c in &clear {
        let c0 = c.get("col").and_then(Json::as_i64).unwrap_or(1) - 1;
        let from = c.get("from").and_then(Json::as_i64).unwrap_or(2) - 1;
        let to = c.get("to").and_then(Json::as_i64).unwrap_or(1) - 1;
        for r in from..=to {
            ops.push(json!({
                "opType": "formula",
                "rowFrom": r, "rowTo": r,
                "colFrom": c0, "colTo": c0,
                "formula": "",
            }));
        }
    }

    for chunk in ops.chunks(WRITE_BATCH) {
        mcp_biz(
            &rpc(
                &client,
                token,
                &client_id,
                Some(&session),
                json!({
                    "jsonrpc":"2.0","id":5,"method":"tools/call",
                    "params":{"name":"sheet.update_range_data","arguments":{
                        "file_id":file_id,
                        "worksheet_id":sheet_id,
                        "rangeData":chunk
                    }}
                }),
            )
            .await?
            .body
            .ok_or("写表返回了空体")?,
        )?;
    }

    Ok(WpsMcpPush {
        count: rows.len(),
        columns: COLUMNS.len(),
        appended,
        file_kuid: file_id.to_string(),
    })
}

/* ------------------------------------------------------------------ */
/* 测试：只覆盖纯逻辑                                                  */
/* ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_plain_json() {
        let v = parse_body(r#"{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}"#).unwrap();
        assert_eq!(v.get("id").and_then(Json::as_i64), Some(1));
    }

    /// SSE 里可能先来 ping/进度，**必须取最后一条** data ——
    /// 取第一条会拿到 `{}` 之类的占位，表现为"服务端什么都没说"
    #[test]
    fn parse_sse_takes_last_data_frame() {
        let raw = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"result\":{\"a\":1}}\n\ndata: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"a\":2}}\n\n";
        let v = parse_body(raw).unwrap();
        assert_eq!(
            v.get("result").and_then(|r| r.get("a")).and_then(Json::as_i64),
            Some(2)
        );
    }

    #[test]
    fn parse_rejects_garbage() {
        assert!(parse_body("not json at all").is_err());
        assert!(parse_body("").is_err());
    }

    /// 授权码与 client id 的形状是协议的硬要求：
    /// 授权码必须是**带连字符的小写 UUID**（auth-guide 页面的正则就这么校验，
    /// 裸 hex 会被判「缺少有效的登录链接」），client id 是 16 位小写 hex
    #[test]
    fn code_shapes() {
        let a = new_auth_code().unwrap();
        let parts: Vec<&str> = a.split('-').collect();
        assert_eq!(
            parts.iter().map(|p| p.len()).collect::<Vec<_>>(),
            vec![8, 4, 4, 4, 12],
            "授权码必须是 8-4-4-4-12 的 UUID 形状：{a}"
        );
        assert!(a
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase() || c == '-'));
        assert_ne!(new_auth_code().unwrap(), new_auth_code().unwrap());

        let b = rand_hex(8).unwrap();
        assert_eq!(b.len(), 16);
        assert!(b.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_ne!(rand_hex(8).unwrap(), rand_hex(8).unwrap());
    }
}

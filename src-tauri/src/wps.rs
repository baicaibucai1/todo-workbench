//! WPS 知识库（kwiki）在线表格联动 —— 传输层 + 整表推/拉。
//!
//! ## 为什么是这条路
//!
//! 金山文档**开放平台**（developer.kdocs.cn）那套要企业资质，个人认证不开放
//! （2026-10-13 查证：FAQ 明说只对企业角色开放，要营业执照 + 人工评估）。
//! 而 WPS 自家的 `kwiki-cli` 走**设备码登录**，个人账号就能用 —— 本文件就是把
//! 那条路搬进程序里：同样的接口、同样的令牌，只是调用方从命令行变成应用自己。
//! 用户在设置页点一下，剩下的（找表、下载、拼表、上传、删旧、改名）全自动。
//!
//! ## 接口形状（全部实测得来，与 kwiki-cli 2.0.1 同源）
//!
//!  · 根地址 `https://zhishi.wps.cn`，前缀 `/kwiki/api/v1/skills_hub`
//!  · 鉴权头 `X-Kwiki-Auth: <token>`，另带 `X-Kwiki-Cli-Ver` 供服务端统计
//!  · 信封恒为 `{code, msg, data}`，**code==0 才是成功** —— HTTP 200 照样可能
//!    是业务错（"用户未登录"就是 200），只看状态码会把原话吞掉
//!  · 登录：`POST access_token/code/generate` 拿设备码 → 用户在**已登录的
//!    浏览器**里打开 `<根>/callback?code=<设备码>` → 轮询
//!    `POST access_token/exchange`，成功时 data 里出 access_token
//!  · `GET skill/knowledge_view/list` 知识库列表；`GET skill/file/list?kuid=`
//!    文件列表；`POST skill/file/download`（response_type=file_base64）下载；
//!    `POST skill/file/upload`（multipart）上传；`POST skill/file/delete`
//!    删除（进回收站，7 天可恢复）；`POST skill/file/rename` 改名
//!
//! ## 三条硬约束（踩过的坑，别改）
//!
//!  1. **上传是新建不是覆盖** —— 同名会被服务端自动改成「xxx(1)」。所以"写回"
//!     必须三步：传新 → 删旧 → 改名。删除只是进回收站，7 天内可恢复。
//!  2. **kuid 每次推送都会变**（上传新建 + 删旧 + 改名，节点是新的）。
//!     所以每次推送前都按标题重新找一遍表，**不能把 kuid 写死** ——
//!     写死的话第二次推送就会删到回收站里的旧文件上去。
//!  3. **xlsx 复用在线那份表的包结构**（只替换 sheetData），不从零拼 ——
//!     自己拼的包缺 Content_Types / rels / customXml 时 WPS 打不开（实测）。
//!
//! ## 依赖
//!
//! 不新增 crate：`reqwest` / `rustls` / `ring` / `percent-encoding` 都已在树里
//! （见 Cargo.toml 里"对齐 updater 依赖树"那段）；`zip` 与 `regex` 虽是新加的
//! 直接依赖，但早已在依赖树中编译过（updater → zip、tauri 工具链 → regex），
//! 且 zip 只开 `deflate-flate2`（纯 Rust 后端，不碰 zlib-rs/zopfli 那些要 C 的）。
//! base64 解码复用 attachments.rs 里那个手写的（见那里的注释：为它引一个 crate
//! 可能触发整树重编）。

use std::io::{Cursor, Read, Write};
use std::sync::OnceLock;
use std::time::Duration;

use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use regex::Regex;
use serde::Serialize;
use serde_json::{json, Map as JsonMap, Value as Json};
use zip::write::FileOptions;
use zip::{ZipArchive, ZipWriter};

use crate::attachments::b64_decode;
use crate::wps_cloud_plan::{cell_text, COLUMNS};

const BASE_URL: &str = "https://zhishi.wps.cn";
const API_PREFIX: &str = "/kwiki/api/v1/skills_hub";
/// 服务端用它统计渠道，没有实际功能；不带也能用，带了与官方 CLI 一致。
const CLI_VER: &str = "2.0.1";
const TIMEOUT: Duration = Duration::from_secs(120);


/* ------------------------------------------------------------------ */
/* 命令的出入参                                                        */
/* ------------------------------------------------------------------ */

#[derive(Debug, Serialize)]
pub struct WpsLogin {
    /// 设备码。轮询 exchange 时原样带回。
    pub device_code: String,
    /// 用户要去打开的授权网址（已登录的浏览器里）。
    pub login_url: String,
}

#[derive(Debug, Serialize)]
pub struct WpsLoginState {
    /// `waiting` = 用户还没授权；`ok` = 拿到了令牌。
    pub status: String,
    pub token: String,
    /// 等待态时带上服务端的原话（"waiting for login"），出问题时不抓瞎。
    pub message: String,
}

#[derive(Debug, Serialize)]
pub struct WpsAccount {
    pub token: String,
    /// 令牌剩余秒数。约一年，到期只能重新登录（没有刷新接口）。
    pub expires_in: i64,
    pub is_personal: bool,
}

#[derive(Debug, Serialize)]
pub struct WpsSpace {
    pub kuid: String,
    pub drive_id: String,
    pub name: String,
}

#[derive(Debug, Serialize)]
pub struct WpsFile {
    pub kuid: String,
    pub title: String,
    /// s=表格 et、w=文档、o=智能文档……只有 s 才是能整表推拉的那张。
    pub doc_type: String,
    pub size: i64,
}

#[derive(Debug, Serialize)]
pub struct WpsPushResult {
    pub count: usize,
    /// 新表的 kuid。**下次推送又会变**，所以它只用于展示，不参与任何判断。
    pub file_kuid: String,
}

#[derive(Debug, Serialize)]
pub struct WpsPull {
    pub file_kuid: String,
    /// 在线表格的原表头（按列序）。
    pub header: Vec<String>,
    /// 数据行，键已换成 SQLite 列名（表头认不出的列直接丢）。
    pub rows: Vec<JsonMap<String, Json>>,
}

/* ------------------------------------------------------------------ */
/* HTTP 层                                                             */
/* ------------------------------------------------------------------ */

/// 完整信封。单独留一层是因为**成功也可能带 msg** —— 登录轮询的
/// "waiting for login" 就是 code=0，调用方需要看到这句话。
struct Envelope {
    code: i64,
    msg: String,
    data: Json,
}

fn http() -> Result<reqwest::Client, String> {
    // rustls 必须有一个已安装的 crypto provider 才能握手。updater 启动时
    // 通常已经装好了，但命令不该依赖"别的插件先跑过"（同 toolpkg.rs）。
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    reqwest::Client::builder()
        .timeout(TIMEOUT)
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))
}

async fn send(req: reqwest::RequestBuilder) -> Result<Envelope, String> {
    let resp = req.send().await.map_err(|e| format!("请求失败：{e}"))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| format!("读返回失败：{e}"))?;
    if !status.is_success() {
        return Err(format!("服务端返回 {status}：{}", clip(&text, 200)));
    }
    let v: Json = serde_json::from_str(&text)
        .map_err(|e| format!("返回不是 JSON（{e}）：{}", clip(&text, 200)))?;
    Ok(Envelope {
        code: v.get("code").and_then(Json::as_i64).unwrap_or(-1),
        msg: v.get("msg").and_then(Json::as_str).unwrap_or("").to_string(),
        data: v.get("data").cloned().unwrap_or(Json::Null),
    })
}

/// 业务错误统一在这里抛。**HTTP 200 也可能是业务错**，"用户未登录"
/// （callback 未带登录态时）就是 200 + code 401000002。
fn data_of(env: Envelope) -> Result<Json, String> {
    if env.code != 0 {
        return Err(format!("服务端说：{}（code {}）", env.msg, env.code));
    }
    Ok(env.data)
}

async fn get(token: &str, path: &str, query: &[(&str, &str)]) -> Result<Json, String> {
    let mut url = format!("{BASE_URL}{API_PREFIX}{path}");
    if !query.is_empty() {
        // 关键字可能是中文，必须编码（percent-encoding 已在依赖树里）
        let q: Vec<String> = query
            .iter()
            .map(|(k, v)| format!("{k}={}", utf8_percent_encode(v, NON_ALPHANUMERIC)))
            .collect();
        url.push('?');
        url.push_str(&q.join("&"));
    }
    let req = http()?
        .get(&url)
        .header("X-Kwiki-Auth", token)
        .header("X-Kwiki-Cli-Ver", CLI_VER);
    data_of(send(req).await?)
}

/// POST JSON。不带 reqwest 的 json feature（没开，为它开会扰动整棵 reqwest 的
/// 编译）：自己序列化、自己设 Content-Type，与 onedrive.rs 同一套写法。
async fn post_json(token: Option<&str>, path: &str, body: Json) -> Result<Json, String> {
    let mut req = http()?
        .post(format!("{BASE_URL}{API_PREFIX}{path}"))
        .header("X-Kwiki-Cli-Ver", CLI_VER)
        .header("Content-Type", "application/json")
        .body(serde_json::to_string(&body).map_err(|e| format!("请求体序列化失败：{e}"))?);
    if let Some(t) = token {
        req = req.header("X-Kwiki-Auth", t);
    }
    data_of(send(req).await?)
}

/// 上传（multipart）。两个坑：
///  · 文件字段名叫 **files** —— 叫 file 服务端直接回"至少需要上传一个文件"；
///  · 报文**手写**而不用 reqwest 的 multipart：那个 feature 没开。
async fn upload(token: &str, drive_id: &str, filename: &str, bytes: &[u8]) -> Result<String, String> {
    const BOUNDARY: &str = "----wb-kwiki-9f2a7c";
    const MIME: &str = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    let mut body: Vec<u8> = Vec::with_capacity(bytes.len() + 512);
    body.extend_from_slice(
        format!("--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"drive_id\"\r\n\r\n{drive_id}\r\n")
            .as_bytes(),
    );
    body.extend_from_slice(
        format!(
            "--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"files\"; filename=\"{filename}\"\r\nContent-Type: {MIME}\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{BOUNDARY}--\r\n").as_bytes());

    let req = http()?
        .post(format!("{BASE_URL}{API_PREFIX}/skill/file/upload"))
        .header("X-Kwiki-Auth", token)
        .header("X-Kwiki-Cli-Ver", CLI_VER)
        .header("Content-Type", format!("multipart/form-data; boundary={BOUNDARY}"))
        .body(body);
    let data = data_of(send(req).await?)?;
    let item = data.as_array().and_then(|a| a.first()).unwrap_or(&data);
    let url = item.get("url").and_then(Json::as_str).unwrap_or("");
    // 上传返回里**没有 kuid 字段**，只有 url（形如 /wiki/l/0lXXXX），
    // 节点 id 得自己从 url 里抠。抠不出来就不敢删旧的 —— 删错了救不回来。
    let m = kuid_re()
        .captures(url)
        .ok_or_else(|| format!("上传成功但返回里没有节点 id：{}", clip(url, 200)))?;
    Ok(m.get(1).map(|m| m.as_str().to_string()).unwrap_or_default())
}

fn clip(s: &str, n: usize) -> String {
    // 按字符截断，别把 UTF-8 切断（服务端错误提示可能是中文）
    s.chars().take(n).collect()
}

fn str_field(v: &Json, key: &str) -> Option<String> {
    v.get(key).and_then(Json::as_str).map(|s| s.to_string())
}

/* ------------------------------------------------------------------ */
/* 登录                                                                */
/* ------------------------------------------------------------------ */

/// 生成设备码，返回用户要打开的授权网址。
#[tauri::command]
pub async fn wps_login_start() -> Result<WpsLogin, String> {
    let data = post_json(None, "/access_token/code/generate", json!({})).await?;
    let code = data
        .get("code")
        .and_then(Json::as_str)
        .filter(|s| !s.is_empty())
        .ok_or("登录服务没给设备码")?;
    Ok(WpsLogin {
        device_code: code.to_string(),
        login_url: format!("{BASE_URL}{API_PREFIX}/callback?code={code}"),
    })
}

/// 轮询设备码换令牌。用户没授权时服务端返回 code=0 + "waiting for login"，
/// 这不是错误，是"还没好"—— 所以这里不能走 data_of 的抛错路径。
#[tauri::command]
pub async fn wps_login_poll(device_code: String) -> Result<WpsLoginState, String> {
    let env = send(
        http()?
            .post(format!("{BASE_URL}{API_PREFIX}/access_token/exchange"))
            .header("X-Kwiki-Cli-Ver", CLI_VER)
            .header("Content-Type", "application/json")
            .body(serde_json::to_string(&json!({ "code": device_code })).unwrap_or_default()),
    )
    .await?;
    if env.code != 0 {
        return Err(format!("服务端说：{}（code {}）", env.msg, env.code));
    }
    // 成功形状只能容错解析：官方 CLI 的 auth status 打的就是
    // {access_token, expires_in, is_personal}，exchange 成功时 data 里出 token。
    // 认 access_token 也认 token（兜底），都没有就当还没授权。
    let token = env
        .data
        .get("access_token")
        .or_else(|| env.data.get("token"))
        .and_then(Json::as_str)
        .unwrap_or("");
    if token.is_empty() {
        return Ok(WpsLoginState {
            status: "waiting".into(),
            token: String::new(),
            message: env.msg,
        });
    }
    Ok(WpsLoginState {
        status: "ok".into(),
        token: token.to_string(),
        message: String::new(),
    })
}

/// 查令牌状态（剩余有效期、是不是个人账号）。
#[tauri::command]
pub async fn wps_account(token: String) -> Result<WpsAccount, String> {
    let data = get(&token, "/access_token/info", &[]).await?;
    Ok(WpsAccount {
        token: str_field(&data, "access_token").unwrap_or(token),
        expires_in: data.get("expires_in").and_then(Json::as_i64).unwrap_or(0),
        is_personal: data.get("is_personal").and_then(Json::as_bool).unwrap_or(false),
    })
}

/* ------------------------------------------------------------------ */
/* 列表                                                                */
/* ------------------------------------------------------------------ */

/// 知识库列表。个人知识库的 kuid 形如 `0s_<drive_id>`，drive_id 从后缀推不出来
/// 的（企业库）以这里返回的为准 —— 上传要用它。
#[tauri::command]
pub async fn wps_spaces(token: String) -> Result<Vec<WpsSpace>, String> {
    let data = get(&token, "/skill/knowledge_view/list", &[("page_size", "50")]).await?;
    let list = data.get("list").and_then(Json::as_array).cloned().unwrap_or_default();
    Ok(list
        .iter()
        .filter_map(|it| {
            Some(WpsSpace {
                kuid: str_field(it, "kuid")?,
                drive_id: str_field(it, "drive_id")?,
                name: str_field(it, "space_name")?,
            })
        })
        .collect())
}

/// 某个知识库（或文件夹）下的文件列表。
#[tauri::command]
pub async fn wps_files(token: String, kuid: String) -> Result<Vec<WpsFile>, String> {
    let data = get(&token, "/skill/file/list", &[("kuid", kuid.as_str())]).await?;
    let list = data.get("list").and_then(Json::as_array).cloned().unwrap_or_default();
    Ok(list
        .iter()
        .filter_map(|it| {
            Some(WpsFile {
                kuid: str_field(it, "kuid")?,
                title: str_field(it, "title")?,
                doc_type: str_field(it, "doc_type")?,
                size: it.get("size").and_then(Json::as_i64).unwrap_or(0),
            })
        })
        .collect())
}

async fn files_inner(token: &str, space_kuid: &str) -> Result<Vec<WpsFile>, String> {
    let data = get(token, "/skill/file/list", &[("kuid", space_kuid)]).await?;
    let list = data.get("list").and_then(Json::as_array).cloned().unwrap_or_default();
    Ok(list
        .iter()
        .filter_map(|it| {
            Some(WpsFile {
                kuid: str_field(it, "kuid")?,
                title: str_field(it, "title")?,
                doc_type: str_field(it, "doc_type")?,
                size: it.get("size").and_then(Json::as_i64).unwrap_or(0),
            })
        })
        .collect())
}

/// 按标题找表。**不能把 kuid 写死**：每次推送后表的 kuid 都会变（上传是
/// 新建 + 删旧 + 改名，节点是新的），写死的话第二次推送就会删到回收站里的
/// 旧文件上去。2026-10-13 用命令行同步时就是这么设计的。
async fn find_file(token: &str, space_kuid: &str, title: &str) -> Result<WpsFile, String> {
    let files = files_inner(token, space_kuid).await?;
    files
        .into_iter()
        .find(|f| f.title == title)
        .ok_or_else(|| format!("知识库里找不到标题为「{title}」的表 —— 标题要和知识库里的文件名一模一样"))
}

async fn download(token: &str, kuid: &str) -> Result<Vec<u8>, String> {
    let data = post_json(
        Some(token),
        "/skill/file/download",
        json!({ "kuid": kuid, "response_type": "file_base64" }),
    )
    .await?;
    let b64 = data
        .get("file_base64")
        .and_then(Json::as_str)
        .ok_or("下载返回里没有文件内容")?;
    b64_decode(b64)
}

async fn delete(token: &str, kuid: &str) -> Result<String, String> {
    let data = post_json(Some(token), "/skill/file/delete", json!({ "kuid": kuid })).await?;
    Ok(data.get("message").and_then(Json::as_str).unwrap_or("已删除").to_string())
}

async fn rename(token: &str, kuid: &str, title: &str) -> Result<(), String> {
    post_json(
        Some(token),
        "/skill/file/rename",
        json!({ "kuid": kuid, "title": title }),
    )
    .await?;
    Ok(())
}

/// 改名，失败时重试几次。
///
/// 为什么要重试：**删除只是进回收站，名字的释放有延迟**。实测「上传同名 →
/// 删旧 → 立刻改回原名」偶尔会回 `400408003 文件名冲突`（2026-10-17 用户现场），
/// 隔一秒再改就成功了。重试比"先 sleep 固定时间"稳：多数情况第一次就过。
async fn rename_retry(token: &str, kuid: &str, title: &str, tries: usize) -> Result<(), String> {
    let mut last = String::new();
    for i in 0..tries.max(1) {
        if i > 0 {
            let _ = tauri::async_runtime::spawn_blocking(|| {
                std::thread::sleep(Duration::from_millis(600))
            })
            .await;
        }
        match rename(token, kuid, title).await {
            Ok(()) => return Ok(()),
            Err(e) => last = e,
        }
    }
    Err(last)
}

/// 给"编辑保存"用的唯一后缀：上传不能覆盖，也不该跟线上那份同名
/// （同名会被服务端改成 `xxx(1)`，后面改名就多一层不确定性）。
fn edit_stamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{ms:x}")
}

/* ------------------------------------------------------------------ */
/* 推送：工作台 → 在线表格                                             */
/* ------------------------------------------------------------------ */

/// 整表推送。rows 是**已经算好派生列**的台账行（键为 SQLite 列名）。
///
/// 顺序不能换：先下载模板（拿包结构）→ 拼新表 → 上传 → 删旧 → 改名。
/// 删旧和改名失败时**各自报清楚现场**——那时候知识库里是什么状态，
/// 用户得知道，否则下次同步会对不上。
#[tauri::command]
pub async fn wps_push(
    token: String,
    space_kuid: String,
    drive_id: String,
    title: String,
    rows: Vec<JsonMap<String, Json>>,
) -> Result<WpsPushResult, String> {
    let old = find_file(&token, &space_kuid, &title).await?;
    let template = download(&token, &old.kuid).await?;
    let xlsx = build_xlsx(&template, &rows)?;
    let new_kuid = upload(&token, &drive_id, &format!("{title}.xlsx"), &xlsx).await?;

    if let Err(e) = delete(&token, &old.kuid).await {
        return Err(format!(
            "新表已上传，但旧表没能删掉（{e}）—— 知识库里现在有两份表，请手动删掉旧的那份「{title}」"
        ));
    }
    if let Err(e) = rename_retry(&token, &new_kuid, &title, 3).await {
        return Err(format!(
            "新表已上传、旧表已删，但改名没成（{e}）—— 它在知识库里叫「{title}.xlsx」，手动改回来即可"
        ));
    }
    Ok(WpsPushResult {
        count: rows.len(),
        file_kuid: new_kuid,
    })
}

/* ------------------------------------------------------------------ */
/* 拉取：在线表格 → 行数据（写库由前端做，走应用自己的事务）              */
/* ------------------------------------------------------------------ */

#[tauri::command]
pub async fn wps_pull(token: String, space_kuid: String, title: String) -> Result<WpsPull, String> {
    let file = find_file(&token, &space_kuid, &title).await?;
    let raw = download(&token, &file.kuid).await?;
    let (header, body) = parse_sheet(&raw)?;

    // 表头中文名 → SQLite 列名。认不出的列直接丢（用户自己在表里加的备注列
    // 不该被硬塞进台账）。注意**当前状态**是派生列：推上去给人看，
    // 拉回来时不写库（见 lib/kwiki.ts 的 planPull）。
    let colmap: std::collections::HashMap<&str, &str> =
        COLUMNS.iter().map(|(c, h)| (*h, *c)).collect();
    let mut rows = Vec::with_capacity(body.len());
    for r in &body {
        let mut m = JsonMap::new();
        for (j, h) in header.iter().enumerate() {
            if let Some(col) = colmap.get(h.as_str()) {
                m.insert(
                    (*col).to_string(),
                    Json::String(r.get(j).cloned().unwrap_or_default()),
                );
            }
        }
        rows.push(m);
    }
    Ok(WpsPull {
        file_kuid: file.kuid,
        header,
        rows,
    })
}

/* ------------------------------------------------------------------ */
/* xlsx：构建（复用模板包结构）                                         */
/* ------------------------------------------------------------------ */

/// 把行数据塞进模板的 sheetData（inlineStr，不依赖 sharedStrings）。
///
/// ⚠️ **一整行要一个 `<row>` 包住这一行所有 `<c>`**。第一版命令行脚本就是
/// 给每个单元格各开一行写的，表被拉成对角线（A1 在 row1、B2 在 row2……）。
fn build_xlsx(template: &[u8], rows: &[JsonMap<String, Json>]) -> Result<Vec<u8>, String> {
    // 台账的表头就是 COLUMNS 的中文名 —— 转成"通用表格"的形状后走同一条重写逻辑
    let header: Vec<String> = COLUMNS.iter().map(|(_, h)| (*h).to_string()).collect();
    let grid: Vec<Vec<String>> = rows
        .iter()
        .map(|r| {
            COLUMNS
                .iter()
                .map(|(c, _)| r.get(*c).map(cell_text).unwrap_or_default())
                .collect()
        })
        .collect();
    rewrite_sheet(template, &header, &grid)
}

/// 把任意表头 + 数据行写进模板的 sheetData（inlineStr，不依赖 sharedStrings）。
///
/// 这是 `wpslink` 用的那条：表头来自用户绑定的那张表本身，不是台账的 COLUMNS。
/// 包结构仍然复用模板 —— 理由与 `build_xlsx` 相同（自己拼的包 WPS 打不开）。
fn build_sheet(
    template: &[u8],
    header: &[String],
    rows: &[Vec<String>],
) -> Result<Vec<u8>, String> {
    rewrite_sheet(template, header, rows)
}

fn rewrite_sheet(
    template: &[u8],
    header: &[String],
    rows: &[Vec<String>],
) -> Result<Vec<u8>, String> {
    let mut zin = ZipArchive::new(Cursor::new(template))
        .map_err(|e| format!("模板不是合格的 xlsx（{e}）"))?;
    let target = (0..zin.len())
        .filter_map(|i| zin.name_for_index(i).map(|n| n.to_string()))
        .find(|n| sheet_file_re().is_match(n))
        .ok_or("模板里找不到工作表")?;
    let mut sheet = String::new();
    zin.by_name(&target)
        .map_err(|e| format!("读不到模板的工作表（{e}）"))?
        .read_to_string(&mut sheet)
        .map_err(|e| format!("工作表读不出来（{e}）"))?;

    // 自闭合的空 sheetData（<sheetData ... />）先归一成开闭一对，
    // 否则下面的整段替换匹配不到，会走到"插在 </worksheet> 前"那条路 ——
    // 那会造出两个 sheetData，WPS 直接报文件损坏。
    let sheet = sheet_data_self_re().replace_all(&sheet, "<sheetData></sheetData>");

    let mut body = String::new();
    // ⚠️ 单元格引用是**列字母 + 行号**（A1、B2……），只给列字母的话
    // r_attr_re（要求字母后跟数字）一个都匹配不上，整张表会被解析成空的。
    let head: String = header
        .iter()
        .enumerate()
        .map(|(j, h)| cell(&format!("{}1", col_name(j)), h))
        .collect();
    body.push_str(&format!("<row r=\"1\">{head}</row>"));
    for (i, row) in rows.iter().enumerate() {
        let r = i + 2;
        let cells: String = header
            .iter()
            .enumerate()
            .map(|(j, _)| {
                let v = row.get(j).map(String::as_str).unwrap_or("");
                cell(&format!("{}{}", col_name(j), r), v)
            })
            .collect();
        body.push_str(&format!("<row r=\"{r}\">{cells}</row>"));
    }

    // 整段替换 sheetData。⚠️ 替换串里**开标签也要写全**（<sheetData>…</sheetData>）——
    // 只写闭标签的话开标签被吃掉，WPS 打开直接报文件损坏。
    let new_sheet = match sheet_data_re().find(&sheet) {
        Some(m) => format!(
            "{}<sheetData>{}</sheetData>{}",
            &sheet[..m.start()],
            body,
            &sheet[m.end()..]
        ),
        None => sheet
            .replacen("</worksheet>", &format!("<sheetData>{body}</sheetData></worksheet>"), 1)
            .to_string(),
    };

    // 整包重写：除 sheetData 外**原样拷贝每个条目**（含目录项）。
    // 这就是"复用包结构"——[Content_Types].xml、rels、customXml 一个不少。
    let mut buf: Vec<u8> = Vec::new();
    {
        let mut zout = ZipWriter::new(Cursor::new(&mut buf));
        for i in 0..zin.len() {
            let name = zin
                .name_for_index(i)
                .map(|n| n.to_string())
                .unwrap_or_default();
            let mut entry = zin.by_index(i).map_err(|e| format!("模板条目读不出来（{e}）"))?;
            let mut bytes = Vec::new();
            entry
                .read_to_end(&mut bytes)
                .map_err(|e| format!("模板条目读一半断了（{e}）"))?;
            let replace = name == target;
            zout.start_file(name, FileOptions::<()>::default())
                .map_err(|e| format!("写新包失败（{e}）"))?;
            zout.write_all(if replace { new_sheet.as_bytes() } else { &bytes })
                .map_err(|e| format!("写新包失败（{e}）"))?;
        }
        zout.finish().map_err(|e| format!("封包失败（{e}）"))?;
    }
    Ok(buf)
}

fn cell(reference: &str, value: &str) -> String {
    if value.is_empty() {
        // 空格子直接不写 <c>：xlsx 里"没有这个单元格"和"空单元格"等价，
        // 而少写一个节点，文件能小一圈。
        return String::new();
    }
    format!(
        "<c r=\"{reference}\" t=\"inlineStr\"><is><t xml:space=\"preserve\">{}</t></is></c>",
        xml_escape(value)
    )
}


/// 0 → "A"，25 → "Z"，26 → "AA"（与 Python 脚本的 col_name 同一套）。
fn col_name(mut i: usize) -> String {
    let mut s = String::new();
    i += 1;
    while i > 0 {
        let r = (i - 1) % 26;
        s.insert(0, (b'A' + r as u8) as char);
        i = (i - 1) / 26;
    }
    s
}

/* ------------------------------------------------------------------ */
/* xlsx：解析（读回在线表格）                                           */
/* ------------------------------------------------------------------ */

/// 读出第一个工作表的 (表头, 数据行)。同时认 inlineStr 与 sharedStrings ——
/// 我们从推上去的那份是 inlineStr，但用户可能先在 WPS 里编辑过，
/// 那时候字符串会进 sharedStrings.xml。
fn parse_sheet(raw: &[u8]) -> Result<(Vec<String>, Vec<Vec<String>>), String> {
    let mut z =
        ZipArchive::new(Cursor::new(raw)).map_err(|e| format!("下载下来的不是合格 xlsx（{e}）"))?;

    let mut shared: Vec<String> = Vec::new();
    if let Ok(mut f) = z.by_name("xl/sharedStrings.xml") {
        let mut s = String::new();
        f.read_to_string(&mut s)
            .map_err(|e| format!("sharedStrings 读不出来（{e}）"))?;
        for si in si_re().captures_iter(&s) {
            // 富文本一段里可能有多个 <t>，全拼上（只取第一个会把
            // "加粗前缀 + 普通内容"这种单元格截断）。
            let mut t = String::new();
            for tm in t_re().captures_iter(&si[1]) {
                t.push_str(&xml_unescape(&tm[1]));
            }
            shared.push(t);
        }
    }

    let target = (0..z.len())
        .filter_map(|i| z.name_for_index(i).map(|n| n.to_string()))
        .find(|n| sheet_file_re().is_match(n))
        .ok_or("表格里找不到工作表")?;
    let mut sheet = String::new();
    z.by_name(&target)
        .map_err(|e| format!("读不到工作表（{e}）"))?
        .read_to_string(&mut sheet)
        .map_err(|e| format!("工作表读不出来（{e}）"))?;

    // 自闭合标签先归一成开闭一对，后面才好统一匹配。
    // （不归一的话 <c r="C1"/> 会被整个漏掉 —— 第一版就是这么漏的。）
    let sheet = row_self_re().replace_all(&sheet, |c: &regex::Captures| {
        format!("{}</row>", &c[0][..c[0].len() - 2])
    });
    let sheet = cell_self_re().replace_all(&sheet, |c: &regex::Captures| {
        format!("<c{}></c>", &c[1])
    });

    let mut rows: Vec<Vec<String>> = Vec::new();
    for rm in row_re().captures_iter(&sheet) {
        let mut cells: Vec<(usize, String)> = Vec::new();
        for cm in cell_re().captures_iter(&rm[1]) {
            let attrs = &cm[1];
            let Some(col) = r_attr_re()
                .captures(attrs)
                .and_then(|m| m.get(1))
                .map(|m| m.as_str())
            else {
                continue;
            };
            let typ = t_attr_re()
                .captures(attrs)
                .and_then(|m| m.get(1))
                .map(|m| m.as_str().to_string())
                .unwrap_or_default();
            let inner = &cm[2];
            let val = match typ.as_str() {
                "inlineStr" => t_re()
                    .captures(inner)
                    .map(|m| xml_unescape(&m[1]))
                    .unwrap_or_default(),
                "s" => {
                    let idx = v_re()
                        .captures(inner)
                        .and_then(|m| m.get(1))
                        .map(|m| m.as_str().trim().parse::<usize>().unwrap_or(usize::MAX))
                        .unwrap_or(usize::MAX);
                    shared.get(idx).cloned().unwrap_or_default()
                }
                _ => v_re()
                    .captures(inner)
                    .map(|m| xml_unescape(&m[1]))
                    .unwrap_or_default(),
            };
            cells.push((col_idx(col), val));
        }
        if cells.is_empty() {
            continue;
        }
        let width = cells.iter().map(|(i, _)| *i).max().unwrap() + 1;
        let mut row = vec![String::new(); width];
        for (i, v) in cells {
            row[i] = v;
        }
        rows.push(row);
    }
    if rows.is_empty() {
        return Err("表格里一行数据都没有（连表头都没有）".into());
    }
    Ok((rows.remove(0), rows))
}

fn col_idx(letters: &str) -> usize {
    let mut n: usize = 0;
    for ch in letters.bytes() {
        if !ch.is_ascii_uppercase() {
            break;
        }
        n = n * 26 + (ch - b'A' + 1) as usize;
    }
    n.saturating_sub(1)
}

/* ------------------------------------------------------------------ */
/* XML 转义                                                             */
/* ------------------------------------------------------------------ */

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// XML 反转义。单遍扫描：实体（含 `&#dd;` / `&#xhh;` 数字引用）整段替换，
/// 其余按字符推进 —— 先 replace 再 replace 的做法会把 `&amp;lt;`
/// 错解成 `<`（`&` 被解了两遍）。
fn xml_unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'&' {
            if let Some(end) = s[i..].find(';') {
                let ent = &s[i + 1..i + end];
                let ch = match ent {
                    "lt" => Some('<'),
                    "gt" => Some('>'),
                    "quot" => Some('"'),
                    "apos" => Some('\''),
                    "amp" => Some('&'),
                    _ => {
                        if let Some(hex) = ent.strip_prefix("#x") {
                            u32::from_str_radix(hex, 16).ok().and_then(char::from_u32)
                        } else if let Some(dec) = ent.strip_prefix('#') {
                            dec.parse::<u32>().ok().and_then(char::from_u32)
                        } else {
                            None
                        }
                    }
                };
                if let Some(c) = ch {
                    out.push(c);
                    i += end + 1;
                    continue;
                }
            }
        }
        let len = utf8_len(bytes[i]);
        out.push_str(&s[i..i + len]);
        i += len;
    }
    out
}

fn utf8_len(b: u8) -> usize {
    if b < 0x80 {
        1
    } else if b >> 5 == 0b110 {
        2
    } else if b >> 4 == 0b1110 {
        3
    } else if b >> 3 == 0b11110 {
        4
    } else {
        1
    }
}

/* ------------------------------------------------------------------ */
/* 正则（编译一次，到处用）                                              */
/* ------------------------------------------------------------------ */

fn kuid_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(0l[A-Za-z0-9]+)").unwrap())
}

fn sheet_file_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^xl/worksheets/sheet\d+\.xml$").unwrap())
}

fn sheet_data_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?s)<sheetData\b[^>]*>.*?</sheetData>").unwrap())
}

fn sheet_data_self_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"<sheetData\b[^>]*/>").unwrap())
}

fn row_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?s)<row\b[^>]*>(.*?)</row>").unwrap())
}

fn row_self_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"<row\b[^>]*?/>").unwrap())
}

fn cell_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?s)<c\b([^>]*?)>(.*?)</c>").unwrap())
}

fn cell_self_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"<c\b([^>]*?)/>").unwrap())
}

fn si_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?s)<si>(.*?)</si>").unwrap())
}

fn t_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?s)<t\b[^>]*>(.*?)</t>").unwrap())
}

fn v_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?s)<v\b[^>]*>(.*?)</v>").unwrap())
}

fn r_attr_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"\br="([A-Z]+)\d+""#).unwrap())
}

fn t_attr_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"\bt="([^"]+)""#).unwrap())
}

/* ------------------------------------------------------------------ */
/* 共享链接：kdocs 链接 → 文件 → 内容（只读）                            */
/* ------------------------------------------------------------------ */

/**
 * 这个分区的由来（2026-10-17）：用户丢来一条 `https://www.kdocs.cn/l/xxx`
 * 的共享链接，问「能不能接进程序」。
 *
 * 摸出来的两条路，各走一半，拼起来才通：
 *   1. **按链接取元数据**：`GET /api/v3/office/file/<link_id>` 匿名可读
 *      （要带浏览器 UA，否则 403 userNotLogin）。返回 id / 名字 / 分享者 /
 *      权限，**不是** skills_hub 那套 `{code,msg,data}` 信封，别拿 send() 解。
 *   2. **取内容**：kdocs 的 `/download` 要 `wps_sid` 会话（浏览器登录态），
 *      kwiki 令牌打不通；但 skills_hub 的 `file/import` 支持把**云文档
 *      （含 sharefile）复制进知识库**，之后 download / content 都能用。
 *
 * 所以读取 = 复制进知识库 → 读 → 删临时副本。三步都不能省：
 *   · 不复制就没法读（没有第二条不借浏览器的路）；
 *   · 不删就在用户的知识库里堆垃圾（删除是进回收站，7 天可恢复）。
 */

/// kdocs 的「按 id 取文件信息」接口。`<id>` 既认分享 id 也认文件 id。
const KDOCS_FILE_URL: &str = "https://www.kdocs.cn/api/v3/office/file";
/// 匿名访问必须像浏览器。少了 UA 服务端当爬虫，直接回 403 userNotLogin
/// （同一个链接带 UA 就 200 —— 这不是鉴权，是风控）。
const BROWSER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
#[derive(Debug, Serialize)]
pub struct WpsLink {
    /// 分享链接末尾那一段（`crkFlwR2In6z`）
    pub link_id: String,
    /// 文件 id（`574645831599`）。导入知识库时用它
    pub file_id: String,
    pub name: String,
    /// sheet = 表格 / doc = 文档 / other = 认不出（不预览）
    pub kind: String,
    pub size: i64,
    /// 分享者昵称
    pub owner: String,
    /// 链接给来访者的权限（read / write），服务端原话
    pub permission: String,
    /// 归属空间名（「我的云文档」这类）—— 让用户确认拿到的是哪一份
    pub group_name: String,
}

/// 从链接（或裸 id）里抠出分享 id。
///
/// 只认 ASCII 字母数字：kdocs 的分享 id 长这样；把 `/wiki/l/0s_320...`
/// 这种知识库 kuid 混进来的话，宁可在这里报错，也别拿去请求后拿到
/// 一句看不懂的 "参数不支持"。
fn link_id_of(input: &str) -> Result<String, String> {
    let raw = input.trim();
    if raw.is_empty() {
        return Err("先粘贴一个金山文档的分享链接（形如 https://www.kdocs.cn/l/xxxx）".into());
    }
    let path = raw.split(['?', '#']).next().unwrap_or(raw);
    let seg = path
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("")
        .trim();
    let ok = seg.len() >= 6 && seg.chars().all(|c| c.is_ascii_alphanumeric());
    if !ok {
        return Err(format!(
            "从链接里看不出分享 id：「{}」—— 应该是 https://www.kdocs.cn/l/xxxx 这种",
            clip(seg, 40)
        ));
    }
    Ok(seg.to_string())
}

/// 按扩展名判定能不能预览。WPS 云文档的 "ksheet" / "otl" 是它自家的
/// 后缀，xlsx / docx 是导出后的常见形态 —— 三种都认。
fn kind_of(name: &str) -> &'static str {
    let n = name.to_ascii_lowercase();
    const SHEET: [&str; 5] = [".ksheet", ".xlsx", ".xls", ".et", ".ett"];
    const DOC: [&str; 6] = [".otl", ".docx", ".doc", ".wps", ".wpt", ".md"];
    if SHEET.iter().any(|e| n.ends_with(e)) {
        "sheet"
    } else if DOC.iter().any(|e| n.ends_with(e)) {
        "doc"
    } else {
        "other"
    }
}

/// 匿名取 kdocs 的 JSON。**没有信封**，HTTP 200 就是成功。
async fn kdocs_file_json(link_id: &str) -> Result<Json, String> {
    let url = format!("{KDOCS_FILE_URL}/{link_id}");
    let resp = http()?
        .get(&url)
        .header("User-Agent", BROWSER_UA)
        .header("Referer", format!("https://www.kdocs.cn/l/{link_id}"))
        .send()
        .await
        .map_err(|e| format!("连不上金山文档：{e}"))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| format!("读返回失败：{e}"))?;
    if !status.is_success() {
        return Err(format!(
            "金山文档返回 {status}：{} —— 确认链接还在有效期内、没被取消分享",
            clip(&text, 200)
        ));
    }
    serde_json::from_str(&text).map_err(|e| format!("返回不是 JSON（{e}）：{}", clip(&text, 200)))
}

/// 解析共享链接。**不需要登录** —— 这一步只读元数据（文件名 / 大小 / 分享者）。
///
/// 两处用得上：
///   · `wps_link_import`（知识库绑定）；
///   · **工具的「粘分享链接认表」** —— 每一张 WPS 表格都有一条分享链接，
///     工具拿它当"这是哪张表"的凭据（2026-10-19 起，异常单号登记走这条）。
///     解析出的 `file_id` 直接喂给 MCP 就能读写那张表（实测：UUID 般的分享 id
///     与数字 file id，MCP 都认，读出来的内容一致）。
#[tauri::command]
pub async fn wps_link_info(link: String) -> Result<WpsLink, String> {
    let link_id = link_id_of(&link)?;
    let v = kdocs_file_json(&link_id).await?;
    let file = v
        .get("file")
        .ok_or("这个链接没解析出文件 —— 确认它还有效（没被取消分享）")?;
    let name = str_field(file, "name").unwrap_or_else(|| "（没有名字）".into());
    Ok(WpsLink {
        link_id,
        file_id: str_field(file, "id").unwrap_or_default(),
        kind: kind_of(&name).to_string(),
        name,
        size: file.get("size").and_then(Json::as_i64).unwrap_or(0),
        owner: file
            .get("creator")
            .and_then(|c| c.get("name"))
            .and_then(Json::as_str)
            .unwrap_or("")
            .to_string(),
        permission: v
            .get("user")
            .and_then(|u| u.get("permission"))
            .and_then(Json::as_str)
            .unwrap_or("")
            .to_string(),
        group_name: file
            .get("attrs")
            .and_then(|a| a.get("group_name"))
            .and_then(Json::as_str)
            .unwrap_or("")
            .to_string(),
    })
}

fn has_zip_entry(raw: &[u8], name: &str) -> bool {
    ZipArchive::new(Cursor::new(raw))
        .map(|z| z.file_names().any(|n| n == name))
        .unwrap_or(false)
}

/// docx → 纯文本。只认 `<w:p>` 段落 + `<w:t>` 文本段，够「看内容」用。
///
/// 不解析表格/图片：设置页只是个预览窗口，正式编辑在 WPS 里做。
fn docx_text(raw: &[u8]) -> Result<String, String> {
    let mut z = ZipArchive::new(Cursor::new(raw)).map_err(|e| format!("docx 包坏了（{e}）"))?;
    let mut xml = String::new();
    z.by_name("word/document.xml")
        .map_err(|e| format!("docx 里没有正文（{e}）"))?
        .read_to_string(&mut xml)
        .map_err(|e| format!("正文读不出来（{e}）"))?;

    let mut out = String::new();
    for para in xml.split("</w:p>") {
        let mut line = String::new();
        let mut rest = para;
        while let Some(start) = rest.find("<w:t") {
            let after = &rest[start..];
            let Some(gt) = after.find('>') else { break };
            let body = &after[gt + 1..];
            if body.starts_with("/>") {
                rest = &body[2..];
                continue;
            }
            let Some(end) = body.find("</w:t>") else { break };
            line.push_str(&xml_unescape(&body[..end]));
            rest = &body[end + 6..];
        }
        let line = line.trim_end();
        if !line.trim().is_empty() {
            out.push_str(line);
            out.push('\n');
        }
        if out.len() > 200_000 {
            out.push_str("…（正文太长，只取前 20 万字）\n");
            break;
        }
    }
    if out.trim().is_empty() {
        return Err("docx 里没抽到文字（可能是空文档，或正文都在图片里）".into());
    }
    Ok(out)
}

/* ------------------------------------------------------------------ */
/* 绑定文件：读、改、存回知识库                                          */
/* ------------------------------------------------------------------ */

/**
 * 复制一份云文档（含分享文件）进知识库，返回**新节点**。
 *
 * 导入接口只回知识库地址、不回 kuid，所以只能靠"导入前后 `file/list` 差集"
 * 认人；列表有索引延迟，认不出来时重试几次。重试失败会留下没人认领的副本
 * —— 错误文案里必须让用户去知识库看一眼。
 */
async fn import_copy(token: &str, space_kuid: &str, file_id: &str) -> Result<WpsFile, String> {
    let before: Vec<String> = files_inner(token, space_kuid)
        .await?
        .into_iter()
        .map(|f| f.kuid)
        .collect();

    post_json(
        Some(token),
        "/skill/file/import",
        json!({
            "kuid": space_kuid,
            "action": "copy",
            "file_ids": [file_id],
        }),
    )
    .await
    .map_err(|e| format!("复制到知识库失败：{e} —— 链接给的是只读权限时也要能复制，失败多为空间不对"))?;

    let mut temp = files_inner(token, space_kuid)
        .await?
        .into_iter()
        .find(|f| !before.contains(&f.kuid));
    for _ in 0..5 {
        if temp.is_some() {
            break;
        }
        let _ = tauri::async_runtime::spawn_blocking(|| {
            std::thread::sleep(std::time::Duration::from_millis(400))
        })
        .await;
        temp = files_inner(token, space_kuid)
            .await?
            .into_iter()
            .find(|f| !before.contains(&f.kuid));
    }
    temp.ok_or_else(|| {
        "复制进知识库后没找到那份副本 —— 去知识库里看看是不是同名文件堆了一层".to_string()
    })
}

#[derive(Debug, Serialize)]
pub struct WpsBinding {
    pub kuid: String,
    pub title: String,
    /// 原始 doc_type（s / ksheet / w / o …）。保存时要靠它决定怎么写回
    pub doc_type: String,
    /// sheet / doc
    pub kind: String,
    /// 给界面看的说明（"这是副本，原文件不会变"）
    pub note: String,
}

/// 把一条分享链接**导入知识库并返回可编辑的节点**（与只读预览不同：不删副本）。
#[tauri::command]
pub async fn wps_link_import(
    token: String,
    space_kuid: String,
    link: String,
) -> Result<WpsBinding, String> {
    let info = wps_link_info(link).await?;
    if info.file_id.is_empty() {
        return Err("链接没解析出文件 id —— 这份分享可能只给了「查看网页」的权限".into());
    }
    if info.kind == "other" {
        return Err(format!("「{}」既不是表格也不是文档，绑定不了", info.name));
    }
    let f = import_copy(&token, &space_kuid, &info.file_id).await?;
    Ok(WpsBinding {
        kind: kind_of_doc_type(&f.doc_type, &f.title).to_string(),
        kuid: f.kuid,
        title: f.title,
        doc_type: f.doc_type,
        note: format!(
            "已把「{}」复制进知识库，之后编辑的是这份副本；原文件不会跟着变",
            info.name
        ),
    })
}

/// 清单里的 doc_type 比扩展名可靠（`ksheet` / `otl` 这些没有扩展名）。
fn kind_of_doc_type(doc_type: &str, title: &str) -> &'static str {
    match doc_type {
        "s" | "ksheet" | "xlsx" | "et" => "sheet",
        "w" | "o" | "docx" | "otl" => "doc",
        _ => kind_of(title),
    }
}

#[derive(Debug, Serialize)]
pub struct WpsFileDoc {
    pub kuid: String,
    pub title: String,
    pub kind: String,
    pub doc_type: String,
    /// 表格：表头 + 数据行
    pub header: Vec<String>,
    pub rows: Vec<Vec<String>>,
    /// 文档：正文纯文本
    pub text: String,
}

/// 读一份知识库文件（表格给表头 + 行，文档给正文）。
#[tauri::command]
pub async fn wps_file_read(
    token: String,
    kuid: String,
    title: String,
    doc_type: String,
) -> Result<WpsFileDoc, String> {
    let kind = kind_of_doc_type(&doc_type, &title);
    if kind == "sheet" {
        let raw = download(&token, &kuid).await?;
        let (header, rows) = parse_sheet(&raw)?;
        Ok(WpsFileDoc {
            kuid,
            title,
            kind: kind.to_string(),
            doc_type,
            header,
            rows,
            text: String::new(),
        })
    } else {
        let text = read_doc_text(&token, &kuid).await?;
        Ok(WpsFileDoc {
            kuid,
            title,
            kind: kind.to_string(),
            doc_type,
            header: Vec::new(),
            rows: Vec::new(),
            text,
        })
    }
}

/// 文档正文：优先 `file/content`（.otl 只能这么读），拿不到再按 docx 抽。
async fn read_doc_text(token: &str, kuid: &str) -> Result<String, String> {
    if let Ok(data) = get(token, "/skill/file/content", &[("kuid", kuid)]).await {
        let text = data.get("content").and_then(Json::as_str).unwrap_or("");
        if !text.trim().is_empty() {
            return Ok(text.to_string());
        }
    }
    let raw = download(token, kuid).await.map_err(|e| {
        format!("{e} —— 智能文档（.otl）只能抽正文，正文还没同步好时请过一会儿再试")
    })?;
    if raw.starts_with(b"PK") && has_zip_entry(&raw, "word/document.xml") {
        return docx_text(&raw);
    }
    Err("这份文档既不是 .docx 也不是 .otl，暂不支持编辑".into())
}

#[derive(Debug, Serialize)]
pub struct WpsWriteResult {
    /// 保存后节点 id **一定变了**（上传/转换都是新建），界面要拿它更新绑定
    pub kuid: String,
    pub title: String,
    pub note: String,
}

/// 把编辑后的内容写回知识库：**新建 → 删旧 → 改名**（与推送同一套顺序）。
///
/// 三种文件三条路：
///   · 表格：下载原表当模板，重写 sheetData（保留包结构），上传 .xlsx
///   · docx：按纯文本拼一个最小 docx 包上传
///   · .otl：`file/convert`（md → otl）新建，再删旧改名 —— 智能文档不能下载，
///     也就没法原地改，只能用"重新生成一份"的方式替换
#[tauri::command]
pub async fn wps_file_write(
    token: String,
    space_kuid: String,
    drive_id: String,
    kuid: String,
    title: String,
    doc_type: String,
    header: Vec<String>,
    rows: Vec<Vec<String>>,
    text: String,
) -> Result<WpsWriteResult, String> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("这份文件没有标题 —— 保存会把名字弄丢，先去 WPS 里改个名".into());
    }
    let kind = kind_of_doc_type(&doc_type, &title);

    // 临时名：上传不能覆盖，同名还会被服务端加 (1)；用它避开这两层不确定性。
    // 删旧 → 改名之间可能有个短暂的名字释放延迟（见 rename_retry 的注释）。
    let tmp_title = format!("{title}__wbedit_{}", edit_stamp());

    let (new_kuid, kind_note) = if kind == "sheet" {
        let template = download(&token, &kuid).await?;
        let xlsx = build_sheet(&template, &header, &rows)?;
        let new = upload(&token, &drive_id, &format!("{tmp_title}.xlsx"), &xlsx).await?;
        (new, String::new())
    } else if doc_type == "o" || doc_type == "otl" {
        let data = post_json(
            Some(&token),
            "/skill/file/convert",
            json!({
                "kuid": space_kuid,
                "title": tmp_title.clone(),
                "content": text,
                "from": "md",
                "to": "otl",
            }),
        )
        .await?;
        let new = data
            .get("file_kuid")
            .and_then(Json::as_str)
            .unwrap_or("")
            .to_string();
        if new.is_empty() {
            return Err(format!(
                "转换接口没回新的节点 id：{}",
                clip(&data.to_string(), 200)
            ));
        }
        (new, "智能文档的正文要 1–2 分钟才同步完，WPS 里看到空白别急着再存一次".to_string())
    } else {
        let bytes = build_docx(&text)?;
        let new = upload(&token, &drive_id, &format!("{tmp_title}.docx"), &bytes).await?;
        (new, String::new())
    };

    // ★ 从这里开始**不再抛错**：内容已经在新节点上了，报错只会让界面
    // 继续用旧 kuid（那份已经在回收站里）—— 越报越难收拾。失败降级成 note。
    let mut notes: Vec<String> = Vec::new();
    if let Err(e) = delete(&token, &kuid).await {
        notes.push(format!(
            "旧文件没删掉（{e}）—— 知识库里有新旧两份，请手动删旧的那份"
        ));
    }

    let mut final_title = tmp_title.clone();
    match rename_retry(&token, &new_kuid, &title, 5).await {
        Ok(()) => final_title = title.clone(),
        Err(e) => notes.push(format!(
            "名字没能改回「{title}」（{e}）—— 它现在叫「{tmp_title}」，在 WPS 里手动改一下即可"
        )),
    }
    if !kind_note.is_empty() {
        notes.push(kind_note);
    }
    Ok(WpsWriteResult {
        kuid: new_kuid,
        title: final_title,
        note: notes.join("；"),
    })
}

/// 纯文本 → 最小 docx 包。只写正文段落，够"把文字存回去"用。
fn build_docx(text: &str) -> Result<Vec<u8>, String> {
    const CONTENT_TYPES: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"#;
    const RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>"#;

    let mut body = String::new();
    for line in text.split('\n') {
        body.push_str(&format!(
            r#"<w:p><w:r><w:t xml:space="preserve">{}</w:t></w:r></w:p>"#,
            xml_escape(line)
        ));
    }
    let doc = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>{body}</w:body></w:document>"#
    );

    let mut buf: Vec<u8> = Vec::new();
    {
        let mut z = ZipWriter::new(Cursor::new(&mut buf));
        for (name, content) in [
            ("[Content_Types].xml", CONTENT_TYPES),
            ("_rels/.rels", RELS),
            ("word/document.xml", doc.as_str()),
        ] {
            z.start_file(name, FileOptions::<()>::default())
                .map_err(|e| format!("拼 docx 失败（{e}）"))?;
            z.write_all(content.as_bytes())
                .map_err(|e| format!("拼 docx 失败（{e}）"))?;
        }
        z.finish().map_err(|e| format!("封 docx 包失败（{e}）"))?;
    }
    Ok(buf)
}

/* ------------------------------------------------------------------ */
/* 测试                                                                 */
/* ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;

    /// 真实模板：WPS 侧导出的那份在线表（只有表头行）。
    /// 用它当模版是为了让"复用包结构"这条路对着**真东西**测 ——
    /// 手拼的最小包缺 customXml / theme 这些条目，复现不出
    /// "自己拼的包 WPS 打不开"那个坑。
    const TEMPLATE: &[u8] = include_bytes!("../fixtures/kwiki-template.xlsx");

    fn row(pairs: &[(&str, &str)]) -> JsonMap<String, Json> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), Json::String((*v).to_string())))
            .collect()
    }

    fn sample_rows() -> Vec<JsonMap<String, Json>> {
        vec![
            row(&[
                ("order_sn", "310-8421-9930"),
                ("tracking_no", "SF7392016458"),
                ("courier", "顺丰"),
                ("shipped_at", "2026-10-09 14:22"),
                ("store", "5店"),
                ("category", "破损"),
                // 尖括号、引号、& 都得活着出来
                ("title", "外包装变形 <内件裂> & 少发 \"赠品\""),
                ("handling", "已联系快递"),
                ("result", ""),
                ("settled", "1"),
                ("_status", "已联系快递"),
                ("note", "等对方回电"),
                ("created_at", "2026-10-09T06:22:11Z"),
                ("updated_at", "2026-10-12T09:00:00Z"),
            ]),
            row(&[
                ("order_sn", ""),
                ("tracking_no", "YT8820934571"),
                ("courier", "圆通"),
                ("shipped_at", ""),
                ("store", "6店"),
                ("category", "丢件"),
                ("title", ""),
                ("handling", ""),
                ("result", ""),
                ("settled", ""),
                ("_status", "待处理"),
                ("note", ""),
                ("created_at", "2026-10-10T02:10:00Z"),
                ("updated_at", "2026-10-10T02:10:00Z"),
            ]),
        ]
    }

    #[test]
    fn build_then_parse_roundtrip() {
        let rows = sample_rows();
        let built = build_xlsx(TEMPLATE, &rows).expect("构建失败");
        let (header, body) = parse_sheet(&built).expect("解析失败");

        let expect_head: Vec<String> = COLUMNS.iter().map(|(_, h)| (*h).to_string()).collect();
        assert_eq!(header, expect_head);
        assert_eq!(body.len(), 2, "两行数据都得在");

        // 第一行逐格对回去（含转义那格）
        let first: Vec<&str> = COLUMNS.iter().map(|(c, _)| *c).collect::<Vec<_>>();
        let vals = sample_rows();
        for (j, col) in first.iter().enumerate() {
            let want = vals[0].get(*col).map(cell_text).unwrap_or_default();
            assert_eq!(body[0][j], want, "第 {} 列（{}）对不上", j + 1, col);
        }
        // 第二行的空值要读成空串，不能把后面几列挤位
        assert_eq!(body[1][0], "");
        assert_eq!(body[1][1], "YT8820934571");
        assert_eq!(body[1][13], "2026-10-10T02:10:00Z");
    }

    #[test]
    fn build_keeps_package_entries() {
        let built = build_xlsx(TEMPLATE, &sample_rows()).unwrap();
        let z = ZipArchive::new(Cursor::new(&built)).unwrap();
        let names: Vec<String> = (0..z.len())
            .filter_map(|i| z.name_for_index(i).map(|n| n.to_string()))
            .collect();
        // 模板里的条目一个不能少 —— customXml / theme / styles 正是
        // "从零拼的包 WPS 打不开"缺的那几样
        for must in [
            "[Content_Types].xml",
            "_rels/.rels",
            "xl/workbook.xml",
            "xl/sharedStrings.xml",
            "xl/styles.xml",
            "xl/theme/theme1.xml",
            "customXml/item1.xml",
            "xl/worksheets/sheet1.xml",
        ] {
            assert!(names.iter().any(|n| n == must), "少了条目 {must}");
        }
    }

    #[test]
    fn build_replaces_old_rows() {
        // 推两次，第二次不能把第一次的行留在表里（sheetData 是整段替换）
        let first = build_xlsx(TEMPLATE, &sample_rows()).unwrap();
        let second = build_xlsx(&first, &[row(&[("order_sn", "ONLY-1")])]).unwrap();
        let (_, body) = parse_sheet(&second).unwrap();
        assert_eq!(body.len(), 1);
        assert_eq!(body[0][0], "ONLY-1");
    }

    #[test]
    fn parse_handles_shared_strings_and_self_closing_cells() {
        // 手拼一个最小 xlsx：sharedStrings + 自闭合空单元格 + 空行自闭合
        let sheet = concat!(
            r#"<?xml version="1.0" encoding="UTF-8"?>"#,
            r#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">"#,
            r#"<sheetData>"#,
            r#"<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1"/></row>"#,
            r#"<row r="2"/>"#,
            r#"<row r="3"><c r="A3" t="inlineStr"><is><t>订单A</t></is></c><c r="B3"><v>12.5</v></c></row>"#,
            r#"</sheetData></worksheet>"#,
        );
        let shared = concat!(
            r#"<?xml version="1.0" encoding="UTF-8"?>"#,
            r#"<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2">"#,
            r#"<si><t>订单号</t></si><si><r><t>加粗的</t></r><r><t>快递单号</t></r></si>"#,
            r#"</sst>"#,
        );
        let mut buf = Vec::new();
        {
            let mut z = ZipWriter::new(Cursor::new(&mut buf));
            z.start_file("[Content_Types].xml", FileOptions::<()>::default()).unwrap();
            z.write_all(b"<Types/>").unwrap();
            z.start_file("xl/sharedStrings.xml", FileOptions::<()>::default()).unwrap();
            z.write_all(shared.as_bytes()).unwrap();
            z.start_file("xl/worksheets/sheet1.xml", FileOptions::<()>::default()).unwrap();
            z.write_all(sheet.as_bytes()).unwrap();
            z.finish().unwrap();
        }
        let (header, body) = parse_sheet(&buf).unwrap();
        assert_eq!(header, vec!["订单号", "加粗的快递单号", ""]);
        assert_eq!(body.len(), 1, "空行（row 2）要被跳过");
        // 第三行只有 A、B 两格（C3 压根没写），行宽就到 B 为止 ——
        // 与线上脚本一致：缺失的列不补位，由读的那一侧按列序取
        assert_eq!(body[0], vec!["订单A", "12.5"]);
    }

    #[test]
    fn xml_unescape_does_not_double_decode() {
        assert_eq!(xml_unescape("&amp;lt;"), "&lt;");
        assert_eq!(xml_unescape("a &lt; b &gt; c &amp; d &quot;e&quot;"), "a < b > c & d \"e\"");
        assert_eq!(xml_unescape("&#20320;&#x597D;"), "你好");
        assert_eq!(xml_unescape("普通文本"), "普通文本");
        assert_eq!(xml_unescape("&"), "&");
    }

    #[test]
    fn col_name_covers_double_letters() {
        assert_eq!(col_name(0), "A");
        assert_eq!(col_name(25), "Z");
        assert_eq!(col_name(26), "AA");
        assert_eq!(col_name(27), "AB");
        assert_eq!(col_name(13), "N"); // 台账最后一列
        assert_eq!(col_idx("A"), 0);
        assert_eq!(col_idx("N"), 13);
        assert_eq!(col_idx("AA"), 26);
    }

    #[test]
    fn cell_skips_empty_values() {
        assert_eq!(cell("A1", ""), "");
        assert!(cell("A1", "x").contains("t=\"inlineStr\""));
    }

    /* ---------------- 共享链接 ---------------- */

    #[test]
    fn link_id_accepts_common_forms() {
        let want = "crkFlwR2In6z";
        for input in [
            "https://www.kdocs.cn/l/crkFlwR2In6z",
            "https://www.kdocs.cn/l/crkFlwR2In6z/",
            "https://www.kdocs.cn/l/crkFlwR2In6z?f=1",
            "https://www.kdocs.cn/l/crkFlwR2In6z#anchor",
            "  crkFlwR2In6z  ",
        ] {
            assert_eq!(link_id_of(input).unwrap(), want, "输入 {input}");
        }
    }

    #[test]
    fn link_id_rejects_junk() {
        // 空、纯域名、中文 id 都要在本地拦下 —— 拿去做请求只会换回
        // 一句看不懂的服务端错误
        assert!(link_id_of("").is_err());
        assert!(link_id_of("   ").is_err());
        assert!(link_id_of("https://www.kdocs.cn/l/").is_err());
        assert!(link_id_of("https://www.kdocs.cn/l/中文链接").is_err());
        // 知识库 kuid（0s_3205413880）不是分享 id：带下划线，且长度不合法
        assert!(link_id_of("https://www.kdocs.cn/wiki/l/0s_3205413880").is_err());
    }

    #[test]
    fn kind_follows_extension() {
        assert_eq!(kind_of("测试表格.ksheet"), "sheet");
        assert_eq!(kind_of("台账.XLSX"), "sheet");
        assert_eq!(kind_of("方案.otl"), "doc");
        assert_eq!(kind_of("说明.docx"), "doc");
        assert_eq!(kind_of("压缩包.zip"), "other");
        assert_eq!(kind_of("没有扩展名"), "other");
    }

    /// 造一个只有正文的最小 docx（与真实包同构：word/document.xml + 文本段）
    fn tiny_docx(paras: &[&str]) -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let mut z = ZipWriter::new(Cursor::new(&mut buf));
            z.start_file("word/document.xml", FileOptions::<()>::default()).unwrap();
            let body: String = paras
                .iter()
                .map(|t| format!("<w:p><w:r><w:t>{t}</w:t></w:r></w:p>"))
                .collect();
            z.write_all(
                format!(
                    r#"<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>{body}</w:body></w:document>"#
                )
                .as_bytes(),
            )
            .unwrap();
            z.finish().unwrap();
        }
        buf
    }

    #[test]
    fn docx_text_reads_paragraphs_and_entities() {
        // 段落之间要换行；实体要解回原样（&amp; → &）
        let raw = tiny_docx(&["第一段 &amp; 实体", "第二段"]);
        assert!(has_zip_entry(&raw, "word/document.xml"));
        let text = docx_text(&raw).unwrap();
        assert_eq!(text, "第一段 & 实体\n第二段\n");
    }

    #[test]
    fn docx_text_rejects_packages_without_body() {
        // xlsx 也是 zip：不能把表格包当文档读，得报清楚
        assert!(docx_text(TEMPLATE).is_err());
    }

    /* ---------------- 绑定文件：读改写 ---------------- */

    #[test]
    fn build_sheet_roundtrips_arbitrary_header() {
        // 表头来自绑定文件本身，不是台账的 COLUMNS —— 用它自带的列名写回去
        let header = ["订单号".to_string(), "备注".to_string()];
        let rows = vec![vec!["A-1".to_string(), "x & y".to_string()]];
        let built = build_sheet(TEMPLATE, &header, &rows).unwrap();
        let (h, body) = parse_sheet(&built).unwrap();
        assert_eq!(h, vec!["订单号", "备注"]);
        assert_eq!(body[0][0], "A-1");
        assert_eq!(body[0][1], "x & y");
    }

    #[test]
    fn build_docx_roundtrips_text_and_entities() {
        let raw = build_docx("第一段 & <x>\n第二段").unwrap();
        assert!(has_zip_entry(&raw, "word/document.xml"));
        assert_eq!(docx_text(&raw).unwrap(), "第一段 & <x>\n第二段\n");
    }
}

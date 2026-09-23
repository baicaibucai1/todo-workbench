//! 坚果云（WebDAV）同步的传输层。
//!
//! 为什么放在 Rust 而不是前端：
//!
//! 1. **跨域**（和附件仓库同一个原因）。坚果云不给 CORS 头，webview 里
//!    `fetch('https://dav.jianguoyun.com/dav/…')` 会被同源策略拦掉，
//!    而且报错只有一个语焉不详的 TypeError。Rust 侧直连没有这回事。
//! 2. **自定义 HTTP 方法**。WebDAV 用的是 PROPFIND / MKCOL，浏览器 fetch
//!    根本发不出去（PROPFIND 连预检都过不了）。
//! 3. **凭据不出进程**。应用密码交给 Rust 发请求，比放前端 JS 里干净。
//!
//! 依赖上刻意**不新增任何 crate**：reqwest / rustls / ring 都已在依赖树里
//! （附件仓库在用），feature 也完全对齐 —— 动一次 reqwest 的 feature 就可能
//! 连带重编 rustls / aws-lc-rs 那种要 cmake 的大家伙（见 attachments.rs 顶部）。
//!
//! 与数据库的分工：这里只管"把一段文本放上去 / 取下来"，
//! **不知道那些文本是什么意思**。分片怎么切、怎么合并全在 TS 侧（lib/sync.ts）。

use std::time::Duration;

use serde::{Deserialize, Serialize};

/// 建连失败通常很快；给足 15 秒是留给"网络确实慢"的情况。
const CHECK_TIMEOUT_SECS: u64 = 15;

/// 取/存分片的超时。分片是纯文本、几十 KB，60 秒非常宽裕。
const IO_TIMEOUT_SECS: u64 = 60;

/// 单个分片的字节上限。挡的是"云端有个被别的东西塞进来的巨大文件"，
/// 而不是我们自己的数据 —— 待办全量导出也就几百 KB。
const MAX_SHARD_BYTES: usize = 16 * 1024 * 1024;

const USER_AGENT: &str = concat!("todo-workbench/", env!("CARGO_PKG_VERSION"));

/// 坚果云的 WebDAV 配置。
///
/// 用户名是**注册邮箱**，密码是**应用密码**（在「账户信息 → 安全选项 →
/// 添加应用密码」生成），不是登录密码 —— 用登录密码会稳定失败，
/// 而且坚果云的报错只有 401，所以这条要写在界面提示里。
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DavConfig {
    /// 服务根地址，默认 `https://dav.jianguoyun.com/dav`
    pub base_url: String,
    pub username: String,
    pub password: String,
    /// 远程目录，相对 base_url。空串表示直接用根目录
    pub dir: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DavCheck {
    /// 远程目录是否已存在。不存在**不算失败** —— 同步时会自动创建
    pub dir_exists: bool,
    pub message: String,
}

/// 远端一个文件的信息
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DavEntry {
    pub size: u64,
    /// 服务端给的 Last-Modified 原文（RFC 1123）。只用于展示，不参与判断
    pub modified: String,
}

/* ------------------------------------------------------------------ */
/* 基础设施                                                              */
/* ------------------------------------------------------------------ */

/// 建一个同步用的 HTTP 客户端。
///
/// `pub(crate)` 是因为 **OneDrive 那边也用它**（`onedrive.rs`）：两个后端要的
/// 是同一套东西 —— 同一个 UA、同一个 crypto provider 兜底、同样不走系统代理。
/// 各建一份的话，"代理那条坑"就得在两个地方各修一次。
pub(crate) fn build_client(timeout_secs: u64) -> Result<reqwest::Client, String> {
    // rustls 必须有一个已安装的 crypto provider 才能握手。
    // updater 插件启动时通常已经装好了，但命令不该依赖"别的插件先跑过"。
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }

    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(timeout_secs))
        // **不走系统代理**。本机环境里 HTTP_PROXY 常年指向一个已经关掉的
        // 本地代理（这台机器就是这个状态：git 走代理报 Empty reply），
        // 而 reqwest 默认会读这些环境变量 —— 结果是所有同步请求都发往一个
        // 没人监听的端口，报错只是一句泛泛的连接失败，用户完全无从排查。
        // 坚果云是境内服务，直连是正常路径；真要支持代理再加设置项。
        .no_proxy()
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))
}

/// 拼出目标 URL。目录可以写多级（`a/b`），中文会自动百分号编码。
fn join_url(base: &str, dir: &str, name: Option<&str>) -> Result<reqwest::Url, String> {
    let mut url = reqwest::Url::parse(base).map_err(|e| format!("服务地址不合法: {e}"))?;
    match url.scheme() {
        "http" | "https" => {}
        other => return Err(format!("服务地址只支持 http/https，收到的是 {other}")),
    }

    {
        let mut segs = url
            .path_segments_mut()
            .map_err(|_| "服务地址不能作为目录使用（少了斜杠？）".to_string())?;
        segs.pop_if_empty();
        for part in dir.split('/') {
            let p = part.trim();
            if !p.is_empty() {
                segs.push(p);
            }
        }
        if let Some(n) = name {
            segs.push(n);
        }
    }
    Ok(url)
}

fn dav_method(name: &str) -> Result<reqwest::Method, String> {
    reqwest::Method::from_bytes(name.as_bytes())
        .map_err(|e| format!("HTTP 方法 {name} 不合法: {e}"))
}

fn request(
    client: &reqwest::Client,
    method: reqwest::Method,
    url: reqwest::Url,
    cfg: &DavConfig,
) -> reqwest::RequestBuilder {
    client
        .request(method, url)
        .basic_auth(cfg.username.as_str(), Some(cfg.password.as_str()))
}

/// 把 HTTP 状态码翻译成"人话"，尤其是 401 —— 那个几乎总是"用了登录密码"。
fn explain_status(status: reqwest::StatusCode, what: &str) -> String {
    match status.as_u16() {
        401 => "认证失败：请检查账号（坚果云注册邮箱）与应用密码。\
                注意坚果云要用「账户信息 → 安全选项 → 添加应用密码」生成的专用密码，\
                不能用登录密码。"
            .to_string(),
        403 => format!("没有权限访问{what}（403）"),
        404 => format!("{what}不存在（404）"),
        507 => "坚果云空间不足（507）".to_string(),
        429 => "请求过于频繁，被坚果云限流了（429），过一会儿再试".to_string(),
        _ => format!("{what}失败：HTTP {status}"),
    }
}

/// 取第一个形如 `<任意前缀:local>值</…>` 的文本。
///
/// 手写扫描而不是引 XML 库：PROPFIND 的响应体长什么样是标准且固定的，
/// 我只需要三个字段，而引一个 XML crate 意味着新增依赖 —— 那有可能
/// 连带改动 feature 解析、触发整树重编（本项目最贵的一种返工）。
fn first_value(xml: &str, local: &str) -> Option<String> {
    let lower = xml.to_ascii_lowercase();
    let mut from = 0usize;
    while let Some(rel) = lower[from..].find('<') {
        let open = from + rel;
        let gt = lower[open..].find('>')? + open;
        let raw = lower[open + 1..gt].trim();

        // 闭合标签 / 声明 / 注释 / 自闭合，一律不是我们要的开始标签
        if raw.starts_with('/')
            || raw.starts_with('?')
            || raw.starts_with('!')
            || raw.ends_with('/')
        {
            from = gt + 1;
            continue;
        }

        let name = raw.split_whitespace().next().unwrap_or("");
        let localname = name.rsplit(':').next().unwrap_or("");
        if localname == local {
            let start = gt + 1;
            let end = lower[start..]
                .find('<')
                .map(|p| p + start)
                .unwrap_or(lower.len());
            return Some(xml[start..end].trim().to_string());
        }
        from = gt + 1;
    }
    None
}

/* ------------------------------------------------------------------ */
/* 命令                                                                */
/* ------------------------------------------------------------------ */

/// 验证账号能连上，并把远程目录建好（多级会逐级创建）。
///
/// 目录已存在时 MKCOL 返回 405（Method Not Allowed），那是**正常的**，
/// 不是错误 —— 判定"存在"而不是"失败"。
#[tauri::command]
pub async fn webdav_check(cfg: DavConfig) -> Result<DavCheck, String> {
    let client = build_client(CHECK_TIMEOUT_SECS)?;

    // 先 PROPFIND 根目录：这一步只验认证，不碰用户目录。
    // 挑根目录是因为它一定存在 —— 拿一个可能还没建的目录去验认证，
    // "目录不存在"和"密码不对"会混成同一个 404/401，分不清。
    let root = join_url(&cfg.base_url, "", None)?;
    let resp = request(&client, dav_method("PROPFIND")?, root, &cfg)
        .header("Depth", "0")
        .send()
        .await
        .map_err(|e| format!("连不上坚果云：{e}"))?;

    let status = resp.status();
    // 207 Multi-Status 是 WebDAV 正常应答；个别服务会给 200
    if !(status.is_success() || status.as_u16() == 207) {
        return Err(explain_status(status, "访问坚果云"));
    }

    // 再建目录。逐级来：MKCOL 不能一次建两层。
    let mut acc: Vec<String> = Vec::new();
    let mut created_any = false;
    for part in cfg.dir.split('/') {
        let p = part.trim();
        if p.is_empty() {
            continue;
        }
        acc.push(p.to_string());
        let url = join_url(&cfg.base_url, &acc.join("/"), None)?;
        let r = request(&client, dav_method("MKCOL")?, url, &cfg)
            .send()
            .await
            .map_err(|e| format!("创建目录失败：{e}"))?;
        let st = r.status();
        // 201 = 刚建好；405 / 301 / 200 = 已经在那儿了
        if st.as_u16() == 201 {
            created_any = true;
        } else if !(st.as_u16() == 405 || st.is_success() || st.as_u16() == 301) {
            return Err(explain_status(st, "创建远程目录"));
        }
    }

    let dir_label = if cfg.dir.trim().is_empty() {
        "服务根目录".to_string()
    } else {
        cfg.dir.trim().to_string()
    };
    Ok(DavCheck {
        dir_exists: !created_any,
        message: if created_any {
            format!("账号可用，已创建目录「{dir_label}」")
        } else {
            format!("账号可用，目录「{dir_label}」已就绪")
        },
    })
}

/// 读一个远端文件。**不存在返回 None 而不是报错** ——
/// 首次同步时云端本来就什么都没有，那是正常状态。
#[tauri::command]
pub async fn webdav_get(cfg: DavConfig, name: String) -> Result<Option<String>, String> {
    let client = build_client(IO_TIMEOUT_SECS)?;
    let url = join_url(&cfg.base_url, &cfg.dir, Some(&name))?;

    let resp = request(&client, reqwest::Method::GET, url, &cfg)
        .send()
        .await
        .map_err(|e| format!("下载失败：{e}"))?;

    let status = resp.status();
    if status.as_u16() == 404 {
        return Ok(None);
    }
    if !status.is_success() {
        return Err(explain_status(status, &format!("下载 {name}")));
    }

    // 先看 Content-Length 再收：省得真的收下一个 2GB 的文件才发现超限
    if let Some(len) = resp.content_length() {
        if len > MAX_SHARD_BYTES as u64 {
            return Err(format!(
                "云端文件 {name} 有 {:.1} MB，超出上限，拒绝读取",
                len as f64 / 1_048_576.0
            ));
        }
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("读取响应失败：{e}"))?;
    if bytes.len() > MAX_SHARD_BYTES {
        return Err(format!("云端文件 {name} 过大，拒绝读取"));
    }

    String::from_utf8(bytes.to_vec())
        .map(Some)
        .map_err(|_| format!("云端文件 {name} 不是 UTF-8 文本，可能被别的程序占用了"))
}

/// 上传一个文本文件，覆盖同名文件。返回写入的字节数。
#[tauri::command]
pub async fn webdav_put(cfg: DavConfig, name: String, text: String) -> Result<u64, String> {
    if text.len() > MAX_SHARD_BYTES {
        return Err(format!("要上传的 {name} 过大，已拒绝"));
    }

    let client = build_client(IO_TIMEOUT_SECS)?;
    let url = join_url(&cfg.base_url, &cfg.dir, Some(&name))?;
    let len = text.len() as u64;

    let resp = request(&client, reqwest::Method::PUT, url, &cfg)
        .header(reqwest::header::CONTENT_TYPE, "application/json; charset=utf-8")
        .body(text)
        .send()
        .await
        .map_err(|e| format!("上传失败：{e}"))?;

    let status = resp.status();
    // 201 Created / 204 No Content 都是成功；200 也认
    if !status.is_success() {
        return Err(explain_status(status, &format!("上传 {name}")));
    }
    Ok(len)
}

/// 查一个远端文件的大小与修改时间。不存在返回 None。
#[tauri::command]
pub async fn webdav_stat(cfg: DavConfig, name: String) -> Result<Option<DavEntry>, String> {
    let client = build_client(CHECK_TIMEOUT_SECS)?;
    let url = join_url(&cfg.base_url, &cfg.dir, Some(&name))?;

    let resp = request(&client, dav_method("PROPFIND")?, url, &cfg)
        .header("Depth", "0")
        .send()
        .await
        .map_err(|e| format!("查询失败：{e}"))?;

    let status = resp.status();
    if status.as_u16() == 404 {
        return Ok(None);
    }
    if !(status.is_success() || status.as_u16() == 207) {
        return Err(explain_status(status, &format!("查询 {name}")));
    }

    let body = resp.text().await.map_err(|e| format!("读取响应失败：{e}"))?;
    let size = first_value(&body, "getcontentlength")
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);
    let modified = first_value(&body, "getlastmodified").unwrap_or_default();

    Ok(Some(DavEntry { size, modified }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_joins_dir_and_name() {
        let u = join_url("https://dav.jianguoyun.com/dav", "todo-workbench", Some("tasks.json"))
            .unwrap();
        assert_eq!(u.as_str(), "https://dav.jianguoyun.com/dav/todo-workbench/tasks.json");
    }

    #[test]
    fn url_percent_encodes_cjk_dir() {
        // 中文目录名必须被编码，否则请求行里出现非 ASCII 字节，服务端会拒
        let u = join_url("https://dav.jianguoyun.com/dav/", "待办工作台", None).unwrap();
        assert!(!u.as_str().contains("待办"));
        assert!(u.as_str().starts_with("https://dav.jianguoyun.com/dav/%E5%BE%85"));
    }

    #[test]
    fn url_tolerates_trailing_and_multi_level() {
        let u = join_url("https://x.test/dav/", "/a/b/", None).unwrap();
        assert_eq!(u.as_str(), "https://x.test/dav/a/b");
    }

    #[test]
    fn url_rejects_non_http_scheme() {
        assert!(join_url("ftp://x.test/dav", "d", None).is_err());
    }

    #[test]
    fn first_value_reads_prefixed_tag() {
        let xml = r#"<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">
          <D:response><D:propstat><D:prop>
            <D:getcontentlength>1234</D:getcontentlength>
            <D:getlastmodified>Wed, 23 Sep 2026 07:00:00 GMT</D:getlastmodified>
          </D:prop></D:propstat></D:response></D:multistatus>"#;
        assert_eq!(first_value(xml, "getcontentlength").as_deref(), Some("1234"));
        assert_eq!(
            first_value(xml, "getlastmodified").as_deref(),
            Some("Wed, 23 Sep 2026 07:00:00 GMT")
        );
    }

    #[test]
    fn first_value_handles_no_prefix() {
        let xml = "<multistatus><getcontentlength>42</getcontentlength></multistatus>";
        assert_eq!(first_value(xml, "getcontentlength").as_deref(), Some("42"));
    }

    #[test]
    fn first_value_returns_none_when_absent() {
        let xml = "<D:multistatus><D:response/></D:multistatus>";
        assert!(first_value(xml, "getcontentlength").is_none());
    }

    #[test]
    fn status_401_points_at_app_password() {
        // 这条文案是有用的：401 在坚果云上 99% 是"用了登录密码"
        let msg = explain_status(reqwest::StatusCode::UNAUTHORIZED, "访问坚果云");
        assert!(msg.contains("应用密码"));
    }

    /* ------------------------------------------------------------------ */
    /* 对着本地桩真发一遍请求                                                */
    /* ------------------------------------------------------------------ */

    /**
     * 上面的测试全是纯函数（拼 URL、手撕 XML）。但这一段里最容易错的其实不是它们：
     * 认证头有没有带上、PROPFIND 的 Depth、404 与 405 该走哪个分支、
     * PUT 上去的东西 GET 回来是不是同一份 —— 这些只有**真的发一次请求**才验得到。
     *
     * 对着真坚果云跑测试不现实（要凭据、要网络、还会污染用户目录），
     * 所以这里起一个只实现我们用到的语义的本地桩。随机端口，不会跟别的东西撞。
     * 桩只解析请求行与 Content-Length，够用且不会有依赖。
     */
    mod mock {
        use std::collections::HashMap;
        use std::io::{BufRead, BufReader, Read, Write};
        use std::net::{TcpListener, TcpStream};
        use std::sync::{Arc, Mutex};

        pub struct Seen {
            pub method: String,
            pub path: String,
            /// 这次请求带没带 Authorization。同步的凭据全靠它。
            pub auth: bool,
            pub body: String,
        }

        #[derive(Default)]
        pub struct State {
            /// MKCOL 过的目录（只用来让第二次 MKCOL 返回 405）
            pub dirs: Vec<String>,
            pub files: HashMap<String, String>,
            /// 一律 401。用来验"密码不对时给的是不是那句能救人的提示"
            pub reject_all: bool,
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
                    // 服务根也带一段路径，和坚果云的 /dav 一样 —— 免得测试里
                    // 碰巧绕过了"base_url 自带路径"这个真实情况
                    base: format!("http://127.0.0.1:{port}/dav"),
                    state,
                    seen,
                }
            }

            pub fn requests(&self) -> Vec<(String, String)> {
                self.seen
                    .lock()
                    .unwrap()
                    .iter()
                    .map(|s| (s.method.clone(), s.path.clone()))
                    .collect()
            }

            pub fn all_authed(&self) -> bool {
                self.seen.lock().unwrap().iter().all(|s| s.auth)
            }
        }

        fn reason(code: u16) -> &'static str {
            match code {
                200 => "OK",
                201 => "Created",
                207 => "Multi-Status",
                401 => "Unauthorized",
                404 => "Not Found",
                405 => "Method Not Allowed",
                _ => "Status",
            }
        }

        fn propfind_body(len: Option<usize>) -> String {
            let prop = match len {
                Some(n) => format!(
                    "<D:getcontentlength>{n}</D:getcontentlength>\
                     <D:getlastmodified>Wed, 23 Sep 2026 07:00:00 GMT</D:getlastmodified>"
                ),
                None => String::new(),
            };
            format!(
                "<?xml version=\"1.0\"?><D:multistatus xmlns:D=\"DAV:\">\
                 <D:response><D:propstat><D:prop>{prop}</D:prop></D:propstat></D:response>\
                 </D:multistatus>"
            )
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
            let mut auth = false;
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
                }
                if lower.starts_with("authorization:") {
                    auth = true;
                }
            }
            let mut buf = vec![0u8; len];
            if len > 0 {
                reader.read_exact(&mut buf)?;
            }
            let body = String::from_utf8_lossy(&buf).to_string();

            seen.lock().unwrap().push(Seen {
                method: method.clone(),
                path: path.clone(),
                auth,
                body: body.clone(),
            });

            let mut st = state.lock().unwrap();
            let (code, text) = if st.reject_all || !auth {
                (401u16, String::new())
            } else if method == "PROPFIND" {
                match st.files.get(&path) {
                    Some(c) => (207, propfind_body(Some(c.len()))),
                    // 只有"看起来是文件"的路径才 404；目录与根一律 207，
                    // 因为桩不打算复刻一个完整 WebDAV 服务器的目录语义
                    None if path.ends_with(".json") => (404, String::new()),
                    None => (207, propfind_body(None)),
                }
            } else if method == "MKCOL" {
                if st.dirs.iter().any(|d| d == &path) {
                    (405, String::new())
                } else {
                    st.dirs.push(path.clone());
                    (201, String::new())
                }
            } else if method == "PUT" {
                st.files.insert(path.clone(), body);
                (201, String::new())
            } else if method == "GET" {
                match st.files.get(&path) {
                    Some(c) => (200, c.clone()),
                    None => (404, String::new()),
                }
            } else {
                (405, String::new())
            };
            drop(st);

            let head = format!(
                "HTTP/1.1 {code} {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                reason(code),
                text.len()
            );
            stream.write_all(head.as_bytes())?;
            stream.write_all(text.as_bytes())?;
            stream.flush()
        }
    }

    use self::mock::Stub;

    fn cfg_of(stub: &Stub, dir: &str) -> DavConfig {
        DavConfig {
            base_url: stub.base.clone(),
            username: "someone@example.com".to_string(),
            password: "app-password".to_string(),
            dir: dir.to_string(),
        }
    }

    #[test]
    fn check_props_auth_then_creates_dir_level_by_level() {
        let stub = Stub::start();
        let cfg = cfg_of(&stub, "待办工作台/备份");

        let r = tauri::async_runtime::block_on(webdav_check(cfg.clone())).expect("首次应成功");
        assert!(r.message.contains("已创建目录"), "{}", r.message);
        assert!(!r.dir_exists);

        let reqs = stub.requests();
        let methods: Vec<&str> = reqs.iter().map(|(m, _)| m.as_str()).collect();
        assert_eq!(methods[0], "PROPFIND", "第一步必须先用根目录验认证");
        assert_eq!(methods.len(), 3, "PROPFIND + 两级 MKCOL，实际 {reqs:?}");
        assert!(methods[1..].iter().all(|m| *m == "MKCOL"));
        assert!(
            reqs.iter().all(|(_, p)| !p.contains('待') && !p.contains('备')),
            "中文目录名必须被百分号编码，实际 {reqs:?}"
        );
        assert!(stub.all_authed(), "每个请求都要带上凭据");

        // 第二次：MKCOL 会拿到 405 —— 那是"已经在那儿了"，不是错误
        let r2 = tauri::async_runtime::block_on(webdav_check(cfg)).expect("目录已存在也应成功");
        assert!(r2.message.contains("已就绪"), "{}", r2.message);
        assert!(r2.dir_exists);
    }

    #[test]
    fn check_maps_401_to_a_message_that_actually_helps() {
        let stub = Stub::start();
        stub.state.lock().unwrap().reject_all = true;
        let err = tauri::async_runtime::block_on(webdav_check(cfg_of(&stub, "x")))
            .err()
            .expect("401 必须报错");
        // 401 在坚果云上几乎只有一个原因，报错里必须点名"应用密码"，
        // 否则用户会一直在试自己的登录密码
        assert!(err.contains("应用密码"), "{err}");
        assert!(err.contains("401") || err.contains("认证失败"), "{err}");
    }

    #[test]
    fn get_returns_none_when_the_file_is_not_there_yet() {
        let stub = Stub::start();
        let out = tauri::async_runtime::block_on(webdav_get(cfg_of(&stub, "d"), "tasks.json".into()))
            .expect("404 不该是错误");
        // 首次同步时云端本来就是空的，这是正常状态而不是失败
        assert!(out.is_none());
    }

    #[test]
    fn put_then_get_round_trips_the_same_text() {
        let stub = Stub::start();
        let cfg = cfg_of(&stub, "待办工作台");
        let text = "{\"app\":\"todo-workbench\",\"任务\":\"写周报\"}";

        let n = tauri::async_runtime::block_on(webdav_put(cfg.clone(), "tasks.json".into(), text.into()))
            .expect("上传应成功");
        assert_eq!(n as usize, text.len(), "返回的字节数应与文本一致");

        let back = tauri::async_runtime::block_on(webdav_get(cfg, "tasks.json".into()))
            .expect("下载应成功")
            .expect("文件应该在了");
        assert_eq!(back, text, "取回来的必须和放上去的一模一样");

        let reqs = stub.requests();
        assert_eq!(reqs[0].0, "PUT");
        assert!(reqs[0].1.ends_with("/tasks.json"), "{}", reqs[0].1);
        assert!(stub.all_authed());

        // 钉住**真正发出去的请求体**：上面那句 get 读的是桩存下来的副本，
        // 而"请求里到底写了什么字节"只有这里看得到（编码、截断都藏在这一步）
        let sent = stub.seen.lock().unwrap()[0].body.clone();
        assert_eq!(sent, text);
    }

    #[test]
    fn stat_reads_size_and_last_modified() {
        let stub = Stub::start();
        let cfg = cfg_of(&stub, "d");
        let text = "{\"a\":1}";
        tauri::async_runtime::block_on(webdav_put(cfg.clone(), "orders.json".into(), text.into()))
            .unwrap();

        let e = tauri::async_runtime::block_on(webdav_stat(cfg.clone(), "orders.json".into()))
            .unwrap()
            .expect("文件在");
        assert_eq!(e.size as usize, text.len());
        assert_eq!(e.modified, "Wed, 23 Sep 2026 07:00:00 GMT");

        let none = tauri::async_runtime::block_on(webdav_stat(cfg, "missing.json".into())).unwrap();
        assert!(none.is_none());
    }

    #[test]
    fn put_refuses_oversized_text_without_sending_anything() {
        // 端口 1 上没有任何东西在听 —— 如果它真去发请求了，报的会是连接失败
        let cfg = DavConfig {
            base_url: "http://127.0.0.1:1/dav".to_string(),
            username: "u".to_string(),
            password: "p".to_string(),
            dir: "d".to_string(),
        };
        let huge = "a".repeat(MAX_SHARD_BYTES + 1);
        let err = tauri::async_runtime::block_on(webdav_put(cfg, "x.json".into(), huge))
            .expect_err("超限必须拒绝");
        assert!(err.contains("过大"), "{err}");
    }

    #[test]
    fn join_url_rejects_a_base_that_cannot_hold_a_path() {
        // 少了斜杠的地址在 reqwest 里是"不能当目录用"，必须给出能看懂的提示
        let err = join_url("data:text/plain,x", "d", None).unwrap_err();
        assert!(err.contains("http"), "{err}");
    }
}

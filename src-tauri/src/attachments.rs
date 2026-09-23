//! 工单附件的本地仓库。
//!
//! 为什么文件操作放在 Rust 而不是前端：
//!
//! 1. **跨域**。这是最主要的原因。图片站里绝大多数不给 CORS 头，
//!    webview 里 `fetch` 一个第三方图片地址会被同源策略拦掉，而且报错信息
//!    含糊（一个 TypeError 就完事）。Rust 侧用 reqwest 直连没有这回事。
//!    —— 试过让前端直连，真实站点上一半的图下不来。
//! 2. **路径**。仓库位置要从 app_data_dir 推导，前端拿不到这个路径，
//!    也不该让前端拼路径（拼错就是往别处写文件）。
//! 3. **原子性**。先写临时文件再改名，中途失败不会留下一个看起来正常、
//!    其实截断了的附件。这种事前端做不干净。
//!
//! 与数据库的分工：**文件在 Rust 手里，元数据在 SQLite 里**。
//! 这里只管字节和路径，不知道"这张图属于哪张工单"——
//! 归属关系是数据库的事，Rust 不参与，也就不会出现两边不一致。

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use ring::digest::{digest, SHA256};

/// 仓库根目录名（位于应用数据目录下）
const REPO_DIR: &str = "attachments";

/// 硬上限，前端传的 max_bytes 只会比它更小。
/// 存在的意义是即使前端被改坏（或将来有工具调这个命令），也不会把磁盘写满。
const HARD_MAX_BYTES: u64 = 512 * 1024 * 1024;

/// 单个文件名的最大字符数。Windows 路径总长上限 260，
/// 仓库前缀本身就要 90 左右，留给文件名的余量必须自己卡住。
const MAX_NAME_CHARS: usize = 80;

const FETCH_TIMEOUT_SECS: u64 = 120;

/// 有些图床会挡掉非浏览器 UA，直接返 403。
/// 带上一个常规浏览器 UA 再附上自己的标识——既能下到，也留了身份。
const USER_AGENT: &str = concat!(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ",
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 todo-workbench/",
    env!("CARGO_PKG_VERSION")
);

/// 落进仓库的一个文件。
///
/// 前端拿到 `rel_path` 存进数据库、`abs_path` 转成 asset URL 显示。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StoredFile {
    /// 仓库内相对路径，形如 `2026-09/a1b2c3d4-产品图.jpg`。**这个才是存库的值**
    pub rel_path: String,
    /// 绝对路径。只用于前端转 asset URL，不要存库
    /// —— 换了机器或改了用户名，绝对路径就失效了，相对路径不会。
    pub abs_path: String,
    pub size: u64,
    /// SHA-256 十六进制小写。前端 demo 用 crypto.subtle 算的是同一个值，
    /// 两边对得上才能跨环境一致地去重。
    pub hash: String,
    pub mime: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoUsage {
    pub files: usize,
    pub bytes: u64,
}

/* ------------------------------------------------------------------ */
/* 路径                                                                */
/* ------------------------------------------------------------------ */

fn repo_root(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("取不到应用数据目录: {e}"))?
        .join(REPO_DIR);
    fs::create_dir_all(&root).map_err(|e| format!("创建附件仓库失败: {e}"))?;
    Ok(root)
}

/// 把仓库内的相对路径安全地拼成绝对路径。
///
/// 这是**安全边界**：rel 是从数据库读出来的字符串，一旦里面有 `..`
/// 或绝对路径，就能读写仓库之外的任意文件。
/// 所以这里逐段过滤，只接受普通的目录名/文件名。
fn safe_join(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let mut out = root.to_path_buf();
    let mut depth = 0usize;

    for seg in rel.split(['/', '\\']) {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            return Err("路径里不允许出现 ..".into());
        }
        // 盘符（C:）或 UNC 前缀会被这里挡下
        if seg.contains(':') {
            return Err("路径里不允许出现盘符".into());
        }
        out.push(seg);
        depth += 1;
    }

    if depth == 0 {
        return Err("路径为空".into());
    }
    Ok(out)
}

/// 校验前端传来的月份分桶名，必须是 `YYYY-MM`。
/// 非法就退回 misc —— 分桶只是给人看的，没必要为此让整个操作失败。
fn sanitize_month(month: Option<&str>) -> String {
    let Some(m) = month else { return "misc".into() };
    let bytes = m.as_bytes();
    let shaped = bytes.len() == 7
        && bytes[0..4].iter().all(|b| b.is_ascii_digit())
        && bytes[4] == b'-'
        && bytes[5..7].iter().all(|b| b.is_ascii_digit());
    if !shaped {
        return "misc".into();
    }
    // 月份要真的落在 01..=12。只判第一位是 0/1 是不够的 ——
    // 「2026-19」第一位就是 1，会一路骗过校验，在仓库里建出一个「19 月」的目录。
    let mm = (bytes[5] - b'0') * 10 + (bytes[6] - b'0');
    if (1..=12).contains(&mm) {
        m.to_string()
    } else {
        "misc".into()
    }
}

/* ------------------------------------------------------------------ */
/* 内容识别与命名                                                      */
/* ------------------------------------------------------------------ */

fn sha256_hex(bytes: &[u8]) -> String {
    let d = digest(&SHA256, bytes);
    let mut s = String::with_capacity(64);
    for b in d.as_ref() {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn ext_of(name: &str) -> String {
    Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn ext_for_mime(mime: &str) -> &'static str {
    match mime {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/avif" => "avif",
        "image/bmp" => "bmp",
        "image/svg+xml" => "svg",
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        "video/quicktime" => "mov",
        "video/x-matroska" => "mkv",
        "video/x-msvideo" => "avi",
        "application/pdf" => "pdf",
        _ => "bin",
    }
}

fn mime_for_ext(ext: &str) -> &'static str {
    match ext {
        "jpg" | "jpeg" | "jfif" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "avi" => "video/x-msvideo",
        "pdf" => "application/pdf",
        "txt" | "md" | "log" => "text/plain",
        "csv" => "text/csv",
        "json" => "application/json",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

/// 判定 MIME。**以真实内容为准**，不信 HTTP 响应头。
///
/// 顺序：magic bytes → 响应头 → 扩展名 → 兜底。
/// 实测有些图床把 .jpg 返成 `application/octet-stream`，
/// 而本地截图工具产出的文件又常没扩展名 —— 两头都不可靠，
/// 只有文件头是诚实的。
fn sniff_mime(name: &str, header_ct: Option<&str>, bytes: &[u8]) -> String {
    if let Some(t) = infer::get(bytes) {
        let m = t.mime_type();
        if !m.is_empty() && m != "application/octet-stream" {
            return m.to_string();
        }
    }
    if let Some(ct) = header_ct {
        let ct = ct.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
        if !ct.is_empty() && ct != "application/octet-stream" && ct != "binary/octet-stream" {
            return ct;
        }
    }
    let ext = ext_of(name);
    mime_for_ext(&ext).to_string()
}

/// 文件名净化。
///
/// 刻意**保留中文**：附件名多半是中文，转拼音或直接换成哈希会让人认不出是哪个文件。
/// 只做三件事：剔除控制字符、替换 Windows 非法字符、超长时保留扩展名截断。
fn safe_name(raw: &str) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or(raw);

    let mut out = String::with_capacity(base.len());
    for ch in base.chars() {
        if ch.is_control() {
            continue;
        }
        if matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
            out.push('_');
        } else {
            out.push(ch);
        }
    }

    // 结尾的点和空格在 Windows 上会被静默吃掉，导致"写进去了但找不到"
    let trimmed = out.trim().trim_end_matches('.').trim();
    if trimmed.is_empty() {
        return "file".into();
    }

    if trimmed.chars().count() > MAX_NAME_CHARS {
        let ext = Path::new(trimmed)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| format!(".{e}"))
            .unwrap_or_default();
        let keep = MAX_NAME_CHARS.saturating_sub(ext.chars().count() + 1);
        let stem: String = trimmed.chars().take(keep).collect();
        return format!("{stem}~{ext}");
    }

    trimmed.to_string()
}

/* ------------------------------------------------------------------ */
/* 落盘                                                                */
/* ------------------------------------------------------------------ */

/// 把字节写进仓库。
///
/// **内容寻址**：文件名前缀是内容哈希，所以同一张图被加进两张工单、
/// 或者同一张图被重复粘贴，磁盘上都只有一份。
/// 元数据那层仍会有两条记录 —— 这是对的，它们确实是两次不同的添加行为。
fn store_bytes(
    app: &AppHandle,
    bytes: &[u8],
    given_name: &str,
    month: Option<&str>,
    header_ct: Option<&str>,
) -> Result<StoredFile, String> {
    let root = repo_root(app)?;
    let hash = sha256_hex(bytes);

    let mime = sniff_mime(given_name, header_ct, bytes);

    // 没有扩展名的（本地截图、无后缀的图床地址）按真实类型补一个，
    // 否则在资源管理器里双击打不开
    let mut name = safe_name(given_name);
    if ext_of(&name).is_empty() {
        name = format!("{name}.{}", ext_for_mime(&mime));
    }

    // 按年月分桶：一眼看得出文件什么时候进来的，
    // 也不会几年后把上万个文件全堆在同一层目录里
    let bucket = sanitize_month(month);
    let dir = root.join(&bucket);
    fs::create_dir_all(&dir).map_err(|e| format!("创建仓库子目录失败: {e}"))?;

    let file_name = format!("{}-{}", &hash[..8], name);
    let abs = dir.join(&file_name);

    if !abs.exists() {
        // 先写临时文件再改名：中途断电/失败不会留下一个半截的、看起来正常的附件
        let tmp = dir.join(format!(".{}.tmp", &hash[..16]));
        fs::write(&tmp, bytes).map_err(|e| format!("写入仓库失败: {e}"))?;
        fs::rename(&tmp, &abs).map_err(|e| format!("落盘失败: {e}"))?;
    }

    Ok(StoredFile {
        rel_path: format!("{bucket}/{file_name}"),
        abs_path: abs.to_string_lossy().to_string(),
        size: bytes.len() as u64,
        hash,
        mime,
    })
}

/* ------------------------------------------------------------------ */
/* base64 解码                                                         */
/* ------------------------------------------------------------------ */

/// 手写一个 base64 解码，**故意不加 base64 crate**。
///
/// 理由与 Cargo.toml 里那段"对齐 updater 依赖树"的注释是同一条：
/// 新增一个 crate 会给 `Cargo.lock` 增加节点，而这个工程的依赖树里
/// 有 ring / rustls 这类需要 cmake 的大家伙，任何扰动都可能触发整树重编
/// （首次全树编译实测 28 分钟）。base64 解码只有二十来行，不值得为此冒险。
///
/// 接受标准字母表并容忍：
///   · 省略 padding（data URL 里偶尔没有）
///   · URL-safe 的 `-` `_`
///   · 空白与换行（有些接口把长 base64 折行返回）
fn b64_decode(input: &str) -> Result<Vec<u8>, String> {
    #[inline]
    fn val(c: u8) -> Option<u8> {
        match c {
            b'A'..=b'Z' => Some(c - b'A'),
            b'a'..=b'z' => Some(c - b'a' + 26),
            b'0'..=b'9' => Some(c - b'0' + 52),
            b'+' | b'-' => Some(62),
            b'/' | b'_' => Some(63),
            _ => None,
        }
    }

    // 先过滤掉空白并去掉 padding，剩下的按 4 个一组还原
    let mut buf: Vec<u8> = Vec::with_capacity(input.len());
    for &c in input.as_bytes() {
        if c == b'=' || c.is_ascii_whitespace() {
            continue;
        }
        buf.push(c);
    }

    let mut out = Vec::with_capacity(buf.len() / 4 * 3);
    for chunk in buf.chunks(4) {
        // 长度 1 的尾巴不可能是合法的 base64（至少要有 2 个字符才凑得出 1 个字节）
        if chunk.len() == 1 {
            return Err("base64 数据不完整".into());
        }
        let mut acc: u32 = 0;
        let mut n = 0usize;
        for &c in chunk {
            let v = val(c).ok_or_else(|| format!("base64 里出现了非法字符: {:?}", c as char))?;
            acc = (acc << 6) | v as u32;
            n += 1;
        }
        // 补足到 4 个字符的位宽，再按有效字符数吐出 1~3 个字节
        acc <<= 6 * (4 - n);
        out.push((acc >> 16) as u8);
        if n >= 3 {
            out.push((acc >> 8) as u8);
        }
        if n == 4 {
            out.push(acc as u8);
        }
    }
    Ok(out)
}

/// 拆开 data URL，返回 (MIME, base64 主体)。
///
/// 不是 data URL（没有 `data:` 前缀）时 MIME 返回 None，
/// 整个字符串按裸 base64 处理 —— AI 接口的 `b64_json` 字段就是这样。
fn split_data_url(raw: &str) -> (Option<&str>, &str) {
    let Some(rest) = raw.strip_prefix("data:") else {
        return (None, raw);
    };
    let Some((meta, body)) = rest.split_once(',') else {
        return (None, rest);
    };
    // meta 形如 `image/png;charset=utf-8;base64`，MIME 是第一段
    let mime = meta.split(';').next().filter(|s| !s.is_empty());
    (mime, body)
}

/* ------------------------------------------------------------------ */
/* 命令                                                                */
/* ------------------------------------------------------------------ */

/// 仓库根目录的绝对路径。
/// 前端缓存它，用来把 rel_path 转成 asset URL。
#[tauri::command]
pub fn attachment_dir(app: AppHandle) -> Result<String, String> {
    Ok(repo_root(&app)?.to_string_lossy().to_string())
}
/// 把本机的一个文件复制进仓库。
///
/// 路径直接读，**不走 IPC 传字节** —— 传 200MB 的 `Vec<u8>` 过 IPC
/// 会把内存和序列化开销都顶上去，而文件本来就在同一台机器上。
#[tauri::command]
pub fn attachment_import(
    app: AppHandle,
    src: String,
    name: Option<String>,
    month: Option<String>,
) -> Result<StoredFile, String> {
    let path = PathBuf::from(&src);
    let meta = fs::metadata(&path).map_err(|e| format!("读不到这个文件: {e}"))?;
    if !meta.is_file() {
        return Err("选中的不是文件".into());
    }
    if meta.len() > HARD_MAX_BYTES {
        return Err(format!(
            "文件 {:.1} MB，超过 {} MB 上限",
            meta.len() as f64 / 1_048_576.0,
            HARD_MAX_BYTES / 1_048_576
        ));
    }

    let bytes = fs::read(&path).map_err(|e| format!("读取文件失败: {e}"))?;
    let given = name
        .filter(|n| !n.trim().is_empty())
        .or_else(|| path.file_name().map(|s| s.to_string_lossy().to_string()))
        .unwrap_or_else(|| "file".into());

    store_bytes(&app, &bytes, &given, month.as_deref(), None)
}

/// 把**内存里的一串字节**写进仓库。
///
/// 这是与 attachment_import / attachment_download 并列的第三条入口，
/// 存在的理由是前两条都覆盖不到的一类东西：**在界面上当场产生、从未落过盘、
/// 也不在任何网址上**的图片。具体就是两件事：
///   · 图片裁剪导出（canvas → data URL）
///   · AI 生成的图（接口回报 base64，或回报一个 24 小时后就失效的临时 URL）
/// 这类内容只能从内存里交出来。走 base64 而不是 `Vec<u8>`：
/// IPC 给 `Vec<u8>` 会序列化成 JSON 数字数组，一个 2 MB 的 PNG 要变成
/// 近 700 万个字符的 `[137,80,78,71,...]`，开销比 base64 的 +33% 大得多。
/// 真实二进制走 `tauri::ipc::Request` 更好，但那要改前端的调用形态，
/// 而这里的体积（单图 ≤ 20 MB）用 base64 完全够用。
#[tauri::command]
pub fn attachment_put(
    app: AppHandle,
    data: String,
    name: Option<String>,
    month: Option<String>,
) -> Result<StoredFile, String> {
    // 先按字符串长度挡一道再解码：base64 每 4 个字符出 3 个字节，
    // 所以长度上限是 4/3 倍再加一点 padding 余量。
    // 不先挡的话，一个恶意的巨大字符串会先被完整解码进内存再报错。
    let ceiling = HARD_MAX_BYTES / 3 * 4 + 16;
    if data.len() as u64 > ceiling {
        return Err(format!(
            "内容约 {:.1} MB，超过 {} MB 上限",
            data.len() as f64 * 3.0 / 4.0 / 1_048_576.0,
            HARD_MAX_BYTES / 1_048_576
        ));
    }

    let (mime_hint, body) = split_data_url(&data);
    let bytes = b64_decode(body)?;
    if bytes.is_empty() {
        return Err("内容是空的".into());
    }
    if bytes.len() as u64 > HARD_MAX_BYTES {
        return Err(format!(
            "文件 {:.1} MB，超过 {} MB 上限",
            bytes.len() as f64 / 1_048_576.0,
            HARD_MAX_BYTES / 1_048_576
        ));
    }

    let given = name
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| "image".into());

    // data URL 里的 MIME 只是**第三顺位**的线索：sniff_mime 仍然先看 magic bytes，
    // 所以一个谎报成 image/png 的 webp 不会被写错扩展名。
    store_bytes(&app, &bytes, &given, month.as_deref(), mime_hint)
}

/// 下载一个网址到仓库。
///
/// 只有图片/视频会走到这里 —— 普通文件按产品约定只存链接，不在本地留副本。
#[tauri::command]
pub async fn attachment_download(
    app: AppHandle,
    url: String,
    name: Option<String>,
    month: Option<String>,
    max_bytes: Option<u64>,
) -> Result<StoredFile, String> {
    let parsed = reqwest::Url::parse(&url).map_err(|e| format!("网址不合法: {e}"))?;
    match parsed.scheme() {
        "http" | "https" => {}
        other => return Err(format!("只支持 http/https，收到的是 {other}")),
    }

    let limit = max_bytes.unwrap_or(HARD_MAX_BYTES).min(HARD_MAX_BYTES);

    // rustls 必须有一个已安装的 crypto provider 才能握手。
    // updater 插件启动时通常已经装好了，但命令不该依赖"别的插件先跑过"——
    // 这里自己确认一次（install_default 重复调用只会返 Err，忽略即可）。
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }

    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(FETCH_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;

    let mut resp = client
        .get(parsed.clone())
        .send()
        .await
        .map_err(|e| format!("下载失败: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        return Err(format!("对方返回 {status}"));
    }

    let header_ct = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    // 先用 Content-Length 挡一道，省得真的去下 2GB 才发现超限
    if let Some(len) = resp.content_length() {
        if len > limit {
            return Err(format!(
                "文件 {:.1} MB，超过 {:.0} MB 上限",
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
        return Err("对方返回了空内容".into());
    }

    // 取名字：调用方给的名字 > URL 最后一段 > 按类型兜底
    let from_url = parsed
        .path_segments()
        .and_then(|s| s.last())
        .unwrap_or("")
        .to_string();
    let from_url = percent_encoding::percent_decode_str(&from_url)
        .decode_utf8_lossy()
        .to_string();

    let given = name
        .filter(|n| !n.trim().is_empty())
        .or_else(|| {
            if from_url.trim().is_empty() {
                None
            } else {
                Some(from_url)
            }
        })
        .unwrap_or_else(|| "附件".into());

    store_bytes(&app, &buf, &given, month.as_deref(), header_ct.as_deref())
}

/// 从仓库里删掉一个文件。返回是否真的删到了。
///
/// 调用方必须先确认**没有别的记录还在引用同一个哈希** ——
/// 文件是内容寻址的，两张工单可能共用一份物理文件。
/// 这个判断在数据层做（那里才知道引用关系），Rust 只负责删。
#[tauri::command]
pub fn attachment_remove(app: AppHandle, rel: String) -> Result<bool, String> {
    let root = repo_root(&app)?;
    let path = safe_join(&root, &rel)?;
    if path.is_file() {
        fs::remove_file(&path).map_err(|e| format!("删除失败: {e}"))?;
        return Ok(true);
    }
    Ok(false)
}

/// 仓库里的文件还在不在。
///
/// 用户可能手动清理过磁盘、或者用同步盘把目录搞丢，
/// 界面需要能区分"链接失效了"和"文件被删了"。
#[tauri::command]
pub fn attachment_exists(app: AppHandle, rel: String) -> Result<bool, String> {
    let root = repo_root(&app)?;
    Ok(safe_join(&root, &rel)?.is_file())
}

/// 仓库占用统计，给设置页显示。
#[tauri::command]
pub fn attachment_usage(app: AppHandle) -> Result<RepoUsage, String> {
    let root = repo_root(&app)?;
    let mut files = 0usize;
    let mut bytes = 0u64;
    collect_usage(&root, &mut files, &mut bytes);
    Ok(RepoUsage { files, bytes })
}

/// 用系统默认程序打开一个外部链接。
///
/// 实现上刻意绕开 cmd：
/// `cmd /C start "" <url>` 是最常见的写法，但 cmd 会解析 `&`、`|`、`^` 这些
/// 元字符，而 `&` 在查询串里到处都是 —— 等于把用户贴的网址当命令执行。
/// `url.dll,FileProtocolHandler` 没有 shell 参与，参数按 argv 原样传过去。
///
/// 与 `open_external` 命令**分开成两个函数**，是因为 OneDrive 登录也要打开
/// 浏览器（授权页必须由用户自己在真浏览器里过一遍，webview 里做不了）。
/// 那边直接在 Rust 内部调这个函数，不必绕回前端再 invoke 一次。
pub(crate) fn open_url(url: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("网址不合法: {e}"))?;
    match parsed.scheme() {
        "http" | "https" => {}
        other => return Err(format!("拒绝打开 {other} 协议的链接")),
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("rundll32")
            .arg("url.dll,FileProtocolHandler")
            .arg(parsed.as_str())
            .spawn()
            .map_err(|e| format!("打开失败: {e}"))?;
        return Ok(());
    }

    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new("xdg-open")
            .arg(parsed.as_str())
            .spawn()
            .map_err(|e| format!("打开失败: {e}"))?;
        Ok(())
    }
}

/// 界面里点开一个链接。
///
/// 为什么不直接在界面里 `window.open`：Tauri 的 webview 默认不允许新开窗口，
/// 点下去会**什么都不发生**（也不报错），表现得像按钮坏了。
/// 附件里的链接类条目，点开就是它唯一的作用，这里必须真的打开。
#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    open_url(&url)
}

fn collect_usage(dir: &Path, files: &mut usize, bytes: &mut u64) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        match entry.file_type() {
            Ok(t) if t.is_dir() => collect_usage(&path, files, bytes),
            Ok(t) if t.is_file() => {
                // 落盘中途的临时文件不计入
                let is_tmp = path
                    .file_name()
                    .map(|n| n.to_string_lossy().ends_with(".tmp"))
                    .unwrap_or(false);
                if is_tmp {
                    continue;
                }
                if let Ok(m) = entry.metadata() {
                    *files += 1;
                    *bytes += m.len();
                }
            }
            _ => {}
        }
    }
}

/* ------------------------------------------------------------------ */
/* 测试                                                                */
/* ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_join_rejects_traversal() {
        let root = PathBuf::from("C:\\repo");
        assert!(safe_join(&root, "../secrets.txt").is_err());
        assert!(safe_join(&root, "2026-09/../../x").is_err());
        assert!(safe_join(&root, "C:/Windows/system32").is_err());
        assert!(safe_join(&root, "").is_err());
        assert!(safe_join(&root, "2026-09/ok.jpg").is_ok());
    }

    #[test]
    fn safe_name_keeps_cjk_and_strips_illegal() {
        assert_eq!(safe_name("产品图.jpg"), "产品图.jpg");
        assert_eq!(safe_name("a/b/c.png"), "c.png");
        assert_eq!(safe_name("a:b?c*.png"), "a_b_c_.png");
        assert_eq!(safe_name("trailing..."), "trailing");
        assert_eq!(safe_name("   "), "file");
    }

    #[test]
    fn safe_name_truncates_but_keeps_extension() {
        let long = format!("{}.jpg", "中".repeat(200));
        let out = safe_name(&long);
        assert!(out.chars().count() <= MAX_NAME_CHARS);
        assert!(out.ends_with(".jpg"));
    }

    #[test]
    fn month_bucket_is_validated() {
        assert_eq!(sanitize_month(Some("2026-09")), "2026-09");
        assert_eq!(sanitize_month(Some("2026-19")), "misc");
        assert_eq!(sanitize_month(Some("../evil")), "misc");
        assert_eq!(sanitize_month(None), "misc");
    }

    #[test]
    fn mime_prefers_content_over_header() {
        // 真实 PNG 头 + 撒谎的响应头 → 应该以内容为准
        let png = [0x89u8, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        assert_eq!(sniff_mime("x.jpg", Some("image/jpeg"), &png), "image/png");
        // 认不出内容时退回头
        assert_eq!(
            sniff_mime("x", Some("image/webp"), b"not an image at all"),
            "image/webp"
        );
        // 头和内容都不行 → 扩展名
        assert_eq!(sniff_mime("x.png", None, b"nope"), "image/png");
    }

    #[test]
    fn b64_decodes_standard_and_tolerates_variants() {
        // 手写解码器最容易错的就是"补位"那一段：
        // 长度模 4 余 2 只出 1 个字节、余 3 出 2 个字节，多吐或少吐都不会报错，
        // 只会悄悄产生一个截断的文件 —— 所以三种余数都要钉住。
        assert_eq!(b64_decode("QUJD").unwrap(), b"ABC"); // 余 0
        assert_eq!(b64_decode("QUI=").unwrap(), b"AB"); // 余 3 -> 2 字节
        assert_eq!(b64_decode("QQ==").unwrap(), b"A"); // 余 2 -> 1 字节
        assert_eq!(b64_decode("QUI").unwrap(), b"AB"); // 无 padding
        assert_eq!(b64_decode("QU\nJD\t").unwrap(), b"ABC"); // 折行与空白
        assert_eq!(b64_decode("-_8=").unwrap(), b"\xfb\xff"); // URL-safe 字母表
        assert_eq!(b64_decode("").unwrap(), b"");

        let png_head = [0x89u8, b'P', b'N', b'G'];
        assert_eq!(b64_decode("iVBORw==").unwrap(), png_head);
    }

    #[test]
    fn b64_rejects_garbage() {
        assert!(b64_decode("QQ$Q").is_err()); // 非法字符
        assert!(b64_decode("Q").is_err()); // 长度 1 的尾巴凑不出字节
    }

    #[test]
    fn data_url_is_split_into_mime_and_body() {
        assert_eq!(
            split_data_url("data:image/png;base64,iVBORw=="),
            (Some("image/png"), "iVBORw==")
        );
        // 带 charset 也要能取到 MIME 那一段
        assert_eq!(
            split_data_url("data:image/webp;charset=utf-8;base64,AAAA"),
            (Some("image/webp"), "AAAA")
        );
        // 裸 base64（AI 接口的 b64_json 就是这种）没有 MIME 线索
        assert_eq!(split_data_url("iVBORw=="), (None, "iVBORw=="));
        // 只有前缀没有逗号时不能把整个串当 MIME 吃掉
        assert_eq!(split_data_url("data:image/png"), (None, "image/png"));
    }
}

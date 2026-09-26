/** 一次性脚本：webdav.rs 补本地 WebDAV 桩的集成测试 */
import fs from "node:fs";

const FILE = "src-tauri/src/webdav.rs";
const raw = fs.readFileSync(FILE, "utf8");
const crlf = raw.includes("\r\n");
let s = raw.replace(/\r\n/g, "\n");

const anchor = `    #[test]
    fn status_401_points_at_app_password() {
        // 这条文案是有用的：401 在坚果云上 99% 是"用了登录密码"
        let msg = explain_status(reqwest::StatusCode::UNAUTHORIZED, "访问坚果云");
        assert!(msg.contains("应用密码"));
    }
}`;

if (!s.includes(anchor)) throw new Error("没找到锚点（测试模块末尾）");

const ADD = `    #[test]
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
                    "<D:getcontentlength>{n}</D:getcontentlength>\\
                     <D:getlastmodified>Wed, 23 Sep 2026 07:00:00 GMT</D:getlastmodified>"
                ),
                None => String::new(),
            };
            format!(
                "<?xml version=\\"1.0\\"?><D:multistatus xmlns:D=\\"DAV:\\">\\
                 <D:response><D:propstat><D:prop>{prop}</D:prop></D:propstat></D:response>\\
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
                "HTTP/1.1 {code} {}\\r\\nContent-Length: {}\\r\\nConnection: close\\r\\n\\r\\n",
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
        let text = "{\\"app\\":\\"todo-workbench\\",\\"任务\\":\\"写周报\\"}";

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
    }

    #[test]
    fn stat_reads_size_and_last_modified() {
        let stub = Stub::start();
        let cfg = cfg_of(&stub, "d");
        let text = "{\\"a\\":1}";
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
}`;

s = s.replace(anchor, ADD);
fs.writeFileSync(FILE, crlf ? s.replace(/\n/g, "\r\n") : s);
console.log(`已写入 ${FILE}`);

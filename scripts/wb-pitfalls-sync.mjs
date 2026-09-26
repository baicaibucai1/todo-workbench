/** 一次性脚本：往 PITFALLS.md 追加「同步」这一轮的坑 */
import fs from "node:fs";

const FILE = "C:/AI_Production/Tools/.workbuddy/memory/PITFALLS.md";

const TEXT = `
---

## 四十七、做同步功能带出的四个「不报错」的坑（2026-09-23 坚果云同步）

同步把"数据要离开本机"这件事引进来，于是平时不显眼的假设全都露出来了。
四条里有三条是**浏览器里才复现、桌面端一切正常**，是最难查的那一类。

### 47.1 MemoryDb 是 schemaless 的：INSERT 没写的列 = 行里没有这个键

**症状**：v14 给 \`core_task_links\` 加了 \`deleted\`（取消关联改成软删），同时给
\`fetchLinkedTasks\` 加了 \`WHERE ... AND deleted = 0\`。之后在浏览器演示模式里
**新建的关联一建出来就是隐形的**（\`fetchLinkedTasks\` 返回空），桌面版一切正常。

**根因**：真 SQLite 上 \`deleted INTEGER NOT NULL DEFAULT 0\` 有默认值，INSERT 不写它
也会是 0；而 MemoryDb 的 INSERT 只写语句里出现过的列 —— 没写的列就是**没有这个键**，
于是 \`WHERE deleted = 0\` 对这些行永远不成立。

**修法**：\`linkTasks\` 的 INSERT 显式写 \`deleted\`；读侧再加一个
\`(deleted = 0 OR deleted IS NULL)\` 兜住 v14 之前写下的老行
（真 SQLite 上这个分支永远不成立，留着不影响）。

**判据**：**给表加新列时，所有 INSERT 都要显式带上它**，哪怕真 SQLite 有 DEFAULT。
改完 \`grep "INSERT INTO <表名>"\` 逐条确认。

### 47.2 条件数组可能整个为空 → 拼出 \`WHERE  ORDER BY\`

**症状**：同步导出的待办是 **0 条**。

**根因**：\`fetchTasks\` / \`fetchWorkOrders\` 用 \`where: string[]\` 拼条件。
同步路径传 \`includeDeleted: true\`（不推 \`deleted = 0\`）、\`view: "all"\`（本身不加条件），
于是 where 是空数组，拼出 \`SELECT * FROM core_tasks WHERE  ORDER BY ...\`。
真 SQLite 直接抛语法错误；**MemoryDb 的 SELECT 正则匹配不上，静默返回空数组** ——
所以它表现为"取不到数据"而不是"报错"。

**修法**：\`const clause = where.length ? \`WHERE \${where.join(" AND ")}\` : "";\`

**判据**：任何"把条件数组 join 成子句"的地方，都必须有长度为 0 的分支。
新增一个查询路径时，问一句"这个新路径下 where 会不会是空的"。

### 47.3 冲突提示不能把**同步自己的元数据**算进"内容是否相同"

**症状**：把同一处改动在两端各做一次，之后每次同步都报一堆冲突。

**根因**：判断"两边内容是否一样"时用了全字段序列化，而 \`updatedAt\` 必然不同 ——
于是"内容其实一样"被算成冲突。

**修法**：比较前剔掉 \`updatedAt\` / \`createdAt\`（\`sameContent()\`），
只比**用户可见的字段**（\`completedAt\`、\`dueAt\`、\`deleted\` 这些要留着比）。

**为什么这条重要**：冲突提示是"我这边有什么改动被对方覆盖了"的唯一出口。
一旦它变成噪音，用户就会整体无视它 —— 那时真正被覆盖掉的那一条也就再没人看见。

### 47.4 等"某个状态就绪"，别等时间（补充 PITFALLS 二十八）

**症状**：\`tests/todo-extras.mjs\` 的「搜索能找到候选任务 — count=0」
**单跑全绿、连跑就红**（这次连着跑挂了，单独跑 40/0）。

**根因**：关联候选池是**聚焦搜索框时才异步去取**的，而用例填完输入框只固定
\`waitForTimeout(400)\`，机器一忙就不够。不是断言错，也不是端口串了。

**修法**：\`waitForFunction\` 等 \`[data-link-pool]\` 从 \`"loading"\` 变成数字，
再 \`locator().first().waitFor()\`。**不猜时长**。

**判据**：「单跑绿、连着跑红」有两个方向要查 ——
① 存储桶串了（PITFALLS 三十九／CONVENTIONS 第 4 节）；
② 固定 sleep 不够（这条）。**先看用例里有没有 sleep**，比怀疑断言快得多。

### 47.5 顺带：给 Rust 传输层做本地桩，比对着真服务测划算得多

\`webdav.rs\` 原本只有 8 个纯函数测试（拼 URL、手撕 XML），
而真正容易错的是**认证头有没有带上、\`Depth: 0\`、404 与 405 走哪个分支、
PUT 上去的东西 GET 回来是不是同一份** —— 这些只有真发一次请求才验得到。

做法：\`std::net::TcpListener\` 绑 \`127.0.0.1:0\`（随机端口，不会撞），
一个线程里手写请求行 / \`Content-Length\` 的解析与响应，
测试里用 \`tauri::async_runtime::block_on\` 直接调 \`#[tauri::command]\` 函数。
**不引任何新 crate**（HTTP server 与 tokio 直接依赖都不必）。

配套注意：\`#[tauri::command]\` 函数在原地仍是可调用的普通函数，所以测试可以直接调；
\`expect_err()\` 需要 Ok 类型实现 Debug，DTO 没派生 Debug 时换成 \`.err().expect(...)\`
才不会被迫给 DTO 加派生。

### 47.6 另一个环境坑：跑 e2e 时别同时编译 Rust

\`wallpapers.mjs\` 有一条会去**读已打包的 exe**、比对 \`dist\` 的 mtime，
判断"资源键有没有真的嵌进去"。并发跑 \`cargo test/build\` 会让那个 exe 处于
"正在被重链"的状态，检查结果失去意义（这次 18 套件里那 2 项就是这样红的）。
**要跑 e2e 就先等编译停下来。**
`;

fs.writeFileSync(FILE, fs.readFileSync(FILE, "utf8") + TEXT);
console.log(`已追加到 ${FILE}`);

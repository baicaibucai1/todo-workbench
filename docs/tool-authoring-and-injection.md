# 工具编写与注入 · 详细说明

> 这份文档是给**写工具的人**看的：无论是你自己手写一份 HTML，还是让内置的 AI 助手代写，
> 最终产物都落在同一套契约上。契约的物理实现在 `src/lib/toolBridge.ts`（通道）与
> `src/lib/toolSchema.ts` / `src/lib/toolStore.ts`（清单与安装），
> 注入的挂载在 `src/components/InjectedTools.tsx`。文档里每个数字都取自那份代码，
> 改代码请同步改这里。

---

## 目录

1. [两种形态：整页工具与注入组件](#一两种形态)
2. [交付物：一个目录，两个文件](#二交付物)
3. [manifest.json 逐字段](#三manifestjson-逐字段)
4. [通信协议：postMessage](#四通信协议postmessage)
5. [op 全表](#五op-全表)
6. [能力门：为什么 gallery 会用不了](#六能力门)
7. [注入组件专章](#七注入组件专章)
8. [界面规范](#八界面规范)
9. [让 AI 助手代写：沙箱与通行证](#九让-ai-助手代写)
10. [改表结构、卸载与数据](#十改表结构卸载与数据)
11. [自检清单](#十一自检清单)
12. [报错对照表](#十二报错对照表)
13. [样本索引](#十三样本索引)

---

## 一、两种形态

工作台里的"工具"有两种落点，一个工具可以同时是两种：

| | 整页工具 | 注入组件 |
| --- | --- | --- |
| 占哪里 | 工具区那一大片（侧边栏点开） | 待办详情面板底部 / 详情头部按钮 / 列表行内按钮 |
| 绑定关系 | 不绑定某条待办 | **挂在某一条待办上** |
| 上下文 | `ctx.inject` 不存在 | `ctx.inject = { kind, taskId }` |
| 能读当前待办吗 | 不能（`task.get` 会被拒） | 能，且**只能读挂着的那一条** |
| 高度 | 整片区域 | 分区 80–600px（默认 180）；按钮面板 320px |
| 实例数 | 一个 | 每条待办一个 iframe 实例 |

刻意只开放三个注入位置（`detailSection` / `rowAction` / `detailAction`），
它们都局限在**某一条待办**上，一个组件即使写得糟糕，影响面也就是一个面板；
而 `nav`（侧栏项）和 `view`（整页视图）是全局的，不该由一段运行时装进来的 HTML 占掉。

---

## 二、交付物

```
tools/<id>/
  index.html        ← 界面（唯一入口，必须自包含）
  manifest.json     ← 清单
  <其他附属资源>     ← 可选；目录型工具才有
```

### 自包含是硬要求

单文件导入（`设置 → 工具 → 导入 HTML 单文件`）**只写这两个文件**。
所以：

- CSS 写在 `<style>` 里、JS 写在 `<script>` 里，**不要** `src="helper.js"`；
- **不要引 CDN**、不要引图标字体（工作台可以长期离线，装了打不开等于坏的）；
- 图标用内联 SVG 或 Unicode 字符；
- 单文件上限 **8 MB**（`HTML_MAX_BYTES`）。

桌面端另有一个坑：工具经 asset 协议加载时，Tauri 把整条路径编码成一个路径段
（`http://asset.localhost/C%3A%5C…%5Cindex.html`），整条 URL 里只有开头一个 `/`，
所以 `src="ai/ort.js"` 这类相对引用会被解析到**站点根**。目录型工具要拼绝对 URL，
单文件工具则干脆把东西内联。

### 装入方式有两种，效果不同

| 方式 | manifest 从哪来 | 结果 |
| --- | --- | --- |
| 整个目录复制到工具目录 | 目录里的 `manifest.json` | **完整**：schema / capabilities / injects 全生效 |
| 设置 → 工具 → 导入 HTML 单文件 | 界面上填的 id / 名称 / 图标 | **只有 index.html** 被写入，schema / capabilities / injects 都没有 |

第二种不是 bug，是设计取舍：**导入界面不该让用户手填表结构**。
代价是"导入进来的工具没有私有表、没有注入位置"。要完整能力就走第一种
（AI 助手走的正是这条路 —— 它用 `install_tool` 直接把 manifest 写全）。

工具目录在：

```
%APPDATA%\com.sogapopo.todo-workbench\tools\<id>\
```

---

## 三、manifest.json 逐字段

```json
{
  "id": "kitchen-sink",
  "name": "能力演示",
  "version": "1.0.0",
  "description": "一句话说明它替用户做什么",
  "icon": "sparkles",
  "entry": "index.html",
  "dbVersion": 1,
  "author": "示例",
  "source": "user",
  "capabilities": ["gallery", "task"],
  "schema": { "tables": [ /* 见下 */ ] },
  "injects": [
    { "kind": "detailSection", "label": "能力演示", "height": 240 },
    { "kind": "detailAction", "label": "演示" },
    { "kind": "rowAction", "label": "演示" }
  ]
}
```

| 字段 | 必填 | 规则 |
| --- | --- | --- |
| `id` | ✅ | `^[a-z][a-z0-9-]{1,31}$`（小写字母开头，2–32 位）。**它同时是私有表前缀**：`tool_<id 里的连字符换成下划线>_`。这是安全边界，不是命名偏好 |
| `name` | ✅ | 侧边栏显示的中文名，要短 |
| `version` | ✅ | 默认 `1.0.0` |
| `entry` | ✅ | 入口 HTML，默认 `index.html` |
| `dbVersion` | ✅ | 表结构版本号，≥1。改了 `schema` 就 +1（见 [第十节](#十改表结构卸载与数据)） |
| `description` | | 显示在设置页的工具列表里 |
| `icon` | | 图标名，**白名单**见下 |
| `author` | | 默认「导入」；AI 助手造的记「AI 助手」，出处要能查 |
| `source` | | `builtin` / `user` —— **由宿主盖戳**，工具自报的 `builtin` 不算（否则卸载按钮就没了） |
| `schema` | | 私有表声明。校验不过会**整份丢掉**，等于这个工具没有表 |
| `capabilities` | | 要申请的宿主能力。认不出来的名字当场丢弃 |
| `injects` | | 注入位置。认不出来的 kind 当场丢弃 |

### 图标白名单（`src/lib/icons.ts`）

```
sun  star  calendar  inbox  home  package  crop  receipt  image
calculator  file  list  settings  boxes  sparkles  video  hash  notebook-pen
```

写错会静默退回 `package`（包裹图标），不报错。

### schema 声明

```json
"schema": {
  "tables": [{
    "name": "notes",
    "columns": [
      { "name": "id",   "type": "text", "pk": true },
      { "name": "title","type": "text" },
      { "name": "tag",  "type": "text" },
      { "name": "done", "type": "integer", "default": 0 },
      { "name": "created_at", "type": "text" }
    ],
    "indexes": [{ "columns": ["created_at"] }]
  }]
}
```

| 约束 | 值 |
| --- | --- |
| 表数上限 | 12 |
| 单表列数上限 | 40 |
| 单表索引数上限 | 8；单个索引最多 4 列 |
| 表名 / 列名 | `^[a-z][a-z0-9_]{0,47}$`（首字符必须是字母） |
| 列类型 | 只有 `text` / `integer` / `real` 三种 |
| 主键 | 每张表**恰好一个** `pk: true` |
| `default` | 必须匹配类型（integer/real 给数字，text 给字符串） |
| 索引列 | 必须是本表已声明过的列 |

表里填的是**裸表名**（`notes`）；宿主执行时拼成 `tool_<id>_notes`。
你写的名字只是索引键 —— 没声明过的表走不通，也就碰不到 `core_tasks` 或别的工具的表。

---

## 四、通信协议：postMessage

工具跑在 iframe 里，与宿主之间**只有 postMessage 一条通道**，没有 SQL、没有 import、没有 fetch 宿主接口。

### 两个 source 常量

```js
var TOOL_SOURCE = "workbench-tool";   // 工具发出去时带这个
var HOST_SOURCE = "workbench-host";   // 只认带回这个的消息
```

### 工具 → 宿主

```js
parent.postMessage(
  { source: "workbench-tool", type: "tool:request", id: "r1", op: "kv.get", payload: { key: "a" } },
  "*"
);
```

### 宿主 → 工具

| type | 时机 | 载荷 |
| --- | --- | --- |
| `tool:response` | 回应一次请求 | `{ id, ok, data }` 或 `{ id, ok:false, error }` —— **`id` 原样带回** |
| `tool:context` | iframe 加载完成时、宿主切换深浅色时 | `data` = 运行上下文（见下） |
| `tool:intent` | 被别的工具 `tools.open` 拉起时 | `{ data, from }` |
| `tool:event` | 别的工具 `tools.send` 过来时 | `{ event, data, from }` |

### 运行上下文（`info` 的返回值，也是 `tool:context` 的 `data`）

```js
{
  toolId: "kitchen-sink",
  tablePrefix: "tool_kitchen_sink_",
  driver: "sqlite",              // 或 "memory"（浏览器演示库）
  schemaVersion: 18,
  theme: "light",                // 或 "dark"
  runtime: "desktop",            // 或 "browser"
  gallery: true,                 // 宿主此刻是否为**这个工具**开放图库
  data: true,                    // 是否有 row.* 通道
  link: true,                    // 是否有 tools.* 通道
  inject: { kind: "detailSection", taskId: "t-abc" }   // 整页工具没有这个字段
}
```

### 一段可以直接抄的骨架

```html
<script>
(function () {
  "use strict";
  var TOOL_SOURCE = "workbench-tool";
  var HOST_SOURCE = "workbench-host";
  var seq = 0, waiting = new Map(), ctx = null;

  function call(op, payload) {
    var id = "r" + ++seq;
    return new Promise(function (resolve, reject) {
      waiting.set(id, { resolve: resolve, reject: reject });
      parent.postMessage(
        { source: TOOL_SOURCE, type: "tool:request", id: id, op: op, payload: payload || {} },
        "*"
      );
      setTimeout(function () {
        if (waiting.delete(id)) reject(new Error("宿主没有回应（" + op + "）"));
      }, 10000);
    }).then(function (res) {
      if (!res.ok) throw new Error(String(res.error || "宿主拒绝了这次请求"));
      return res.data;
    });
  }

  window.addEventListener("message", function (e) {
    var m = e.data;
    if (!m || m.source !== HOST_SOURCE) return;

    if (m.type === "tool:response") {
      var w = waiting.get(m.id);
      if (w) { waiting.delete(m.id); w.resolve({ ok: m.ok, data: m.data, error: m.error }); }
      return;
    }
    if (m.type === "tool:context") {
      ctx = m.data;
      // 主题：收到就切，别写死白底黑字
      document.documentElement.dataset.theme = ctx.theme || "light";
      if (ctx.inject) { /* 注入组件：知道自己在替谁干活了 */ }
      return;
    }
    if (m.type === "tool:intent") { /* 被别的工具拉起，m.data 是它交过来的东西 */ }
    if (m.type === "tool:event")  { /* 别的工具发来的事件：m.event / m.data / m.from */ }
  });

  // ★ 不要假设 tool:context 一定比第一个请求先到：先渲染骨架，再自己取一次
  call("info", {}).then(function (c) { ctx = c; /* 填充界面 */ });
})();
</script>
```

> 宿主那侧也有一个对称的坑：本地文件 / asset 协议加载极快，`onLoad` 常常早于建桥，
> 那时推下去的 `tool:context` 会投进虚空（不报错，也没人收到），症状是组件永远停在"等上下文"。
> 所以 `InjectedTools.tsx` 在 `loaded` 之后**又补推了一次**。工具侧的自保方式就是上面那句
> —— 自己再 `call("info")` 一次。

---

## 五、op 全表

白名单之外的 op 一律被拒。参数与返回如下。

### 上下文

| op | 参数 | 返回 |
| --- | --- | --- |
| `info` | — | 运行上下文（见上） |
| `schema.info` | — | `{ tables: [{ name, fullName, pk, columns: [{ name, type, pk, notNull }] }] }` |

### 当前待办（注入组件专用）

| op | 参数 | 返回 |
| --- | --- | --- |
| `task.get` | — | `{ id, title, note, done, important, myDay, dueDate, remindAt, listId, createdAt }` |

**两道门**：① manifest 里申请过 `task` 能力；② 此刻确实挂在某条待办上。
只有注入组件能过第二道 —— 整页工具调它会拿到：

> 这个组件没有挂在任何一条待办上，task.get 只有在注入到详情/行内/详情头部时才有意义

这是刻意的："给我 id X 的待办"这种接口**不存在**，组件不该有能力翻别人的待办。
返回的是**只读快照**：改待办只能走宿主的界面或助手的日程动作。

### 键值配置（`kv.*`）

| op | 参数 | 返回 |
| --- | --- | --- |
| `kv.get` | `{ key }` | `{ key, value }`，没配过时 `value` 是 **null**（不是报错） |
| `kv.set` | `{ key, value }` | `{ key, ok, bytes }` |
| `kv.all` | — | `{ entries: { <key>: <value> } }` |
| `kv.del` | `{ key }` | `{ key, ok }` |

- key：`/^[A-Za-z0-9_.:-]{1,64}$/`
- value：**必须是字符串**，≤ 512 KB。要存对象自己 `JSON.stringify`

**kv 是给"配置"准备的**（上次选的模型、一个开关），
**表是给"记录"准备的**（会有很多条、要查询排序）。别混用。

### 私有表（`row.*`）

| op | 参数 | 返回 |
| --- | --- | --- |
| `row.count` | `{ table, where }` | `{ table, count }` |
| `row.select` | `{ table, where, orderBy, orderDir, limit, offset }` | `{ table, rows, total, limit, offset }` |
| `row.insert` | `{ table, row }` | `{ table, id, row }` |
| `row.update` | `{ table, id, patch }` | `{ table, id, row }` |
| `row.delete` | `{ table, id }` | `{ table, id, deleted }` |
| `count` | `{ table }` | `{ table, count }`（早期遗留的裸表计数，新工具用 `row.count`） |

```js
await call("row.insert", {
  table: "notes",                                  // 裸表名，别写前缀
  row: {
    id: "n-" + Date.now().toString(36),            // ★ 主键必须自己给
    title: "8/12 加班",
    done: 0,                                       // integer 必须是真整数
    created_at: new Date().toISOString()
  }
});

var page = await call("row.select", {
  table: "notes",
  where: { done: 0 },                              // 值为 null 表示 IS NULL
  orderBy: "created_at", orderDir: "desc",
  limit: 50, offset: 0                             // limit 最大 200，默认 50
});
// → { rows: [...], total: 128, limit: 50, offset: 0 }   total 是**不限分页**的总数

await call("row.update", { table: "notes", id: "n-abc", patch: { done: 1 } });
await call("row.delete", { table: "notes", id: "n-abc" });
```

三条必须知道的限制：

1. **没有 JOIN、没有子查询、没有多表聚合**。浏览器演示模式用的是一套简易内存库，
   这类语句它会**静默返回空数组**（不报错），只在装了 SQLite 的桌面版上正常 ——
   也就是说写错的地方在开发机上永远看不出来。需要关联就拆成两次单表查询，在 JS 里合并。
2. **值按列类型强校验**。SQLite 有类型亲和性会默默把字符串转成数字，内存库不会；
   不校验就会出现"网页里好使、装上就错位"。写错会明确报
   `列「done」是 integer，收到的是 string`。
3. **多出来的列会被拒绝**（不是忽略）：`表「notes」里没有「xxx」这一列`。
   单列值 ≤ 512 KB。

### 图库（`gallery.*`）

| op | 参数 | 返回 |
| --- | --- | --- |
| `gallery.list` | `{ kind: "image"\|"video"\|"all", search, limit }` | `{ items: [{ id, title, kind, origin, width, height, size, createdAt, prompt, thumb, dup }], limit, count }` |
| `gallery.get` | `{ id }` | `{ id, title, kind, dataUrl, mime, width, height }` |
| `gallery.put` | `{ dataUrl \| url, title, note, prompt, dedupe }` | 新条目 |

- `limit`：最大 200，默认 60。`thumb` 是 320px 缩略图 dataURL，列表可以直接显示。
- `gallery.get` 读原图有 **10 MB** 字节上限。
- `gallery.put` 可以只给 `url`，由宿主去下载 —— 生图接口回报的常常是临时链接且不给 CORS 头，
  工具自己 fetch 会被浏览器拦掉，而宿主这边有现成的下载链路。
- **来源由宿主按 tool_id 盖章**，工具自报的 `origin` 一律忽略。
- `dedupe: true` 只应在"自动存档"时传（同一份内容不重复占条目）；手动保存不传。

### 工具联动（`tools.*`）

| op | 参数 | 返回 |
| --- | --- | --- |
| `tools.list` | — | `{ tools: [{ id, name, icon, version, description, running, active }] }` |
| `tools.open` | `{ tool, data }` | `{ tool, opened }` |
| `tools.send` | `{ tool, event, data }` | `{ tool, delivered }` |

- `tools.open` 会**先把对方拉起来**，加载完再投 `tool:intent`。不能拉起自己。
- `tools.send` **只投已经在运行的工具**，对方没在跑会明确报错：
  `「xxx」此刻没有在运行，消息没送到。请先用 tools.open 把它拉起来`。

为什么不设计成事件总线：订阅方没在运行时，一次发送是**静默丢失**的，
用户点了"发给 XX"却什么都没发生 —— 那是最难查的一类故障。
显式调用会先把对方拉起来，失败也能报出"它没装 / 被停用了"。

---

## 六、能力门

`gallery` 与 `task` 是**申请来的**服务，不是装上了就自动有的。三态：

| 状态 | 含义 | 宿主的原话 |
| --- | --- | --- |
| `on` | 放行 | — |
| `not-granted` | manifest 里没写这个能力 | `这个扩展没有申请 gallery 能力` |
| `unavailable` | 写了，但提供它的模块没启用 | `gallery 能力当前不可用（提供它的模块没有启用）` |

**图库是选装模块，默认是关的** —— 所以 `ctx.gallery` 现在是会变的（以前恒为 true）。

正确的写法是**据此降级**，而不是弹一个"失败"了事：

```js
var info = await call("info", {});
if (!info.gallery) {
  // 把"存进图库"按钮换成"下载到本地"，并在界面上说明原因
}
```

三态而不是布尔，是因为工具作者需要知道该去**改自己**（没申请）还是去**开模块**（没启用）。

---

## 七、注入组件专章

### 声明

```json
"capabilities": ["task"],
"injects": [
  { "kind": "detailSection", "label": "配图", "height": 180 },
  { "kind": "detailAction",  "label": "配图" },
  { "kind": "rowAction",     "label": "配图" }
]
```

| kind | 落在哪 | 尺寸 |
| --- | --- | --- |
| `detailSection` | 待办详情面板底部，**常驻** | `height` 默认 180，区间 **80–600**（超出会被夹回） |
| `detailAction` | 详情面板头部的按钮，点开浮层 | 面板高 320 |
| `rowAction` | 列表每一行的悬停操作区，点开浮层 | 同上 |

- `label` 省略时用工具名，最长 20 字符（超出截断）。
- 同一个 kind 声明两次只认第一次（`normalizeInjects` 去重）。
- 停用工具 = 它在每条待办上的入口一起收起。

### 拿到"我在替谁干活"

```js
if (m.type === "tool:context") {
  ctx = m.data;
  document.documentElement.dataset.theme = ctx.theme || "light";
  if (ctx.inject) {
    // ctx.inject.kind    —— 这次挂在哪个位置
    // ctx.inject.taskId  —— 挂着的那条待办的 id
    var t = await call("task.get", {});   // 读那一条（只读）
    render(t);
  }
}
```

### 四条容易踩的

1. **两个 iframe 实例**。同一个组件挂在两条待办上是**两份上下文、两个沙箱**，
   不要用全局变量记住"上一条"。
2. **只读**。注入组件没有任何写待办的接口。要存东西用它自己的 `row.*` / `kv.*`。
3. **按钮型只有 320px**。注入组件是配角，别把详情面板顶满；需要更高就用 `detailSection`。
4. **它挂着的那条可能刚被删了**。`task.get` 会报
   `它挂着的那条待办已经不存在了（可能刚被删除）` —— 两种拒绝都要在界面上显示出来，不要静默。

### 一份最小的注入组件（可直接抄）

```html
<!doctype html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="utf-8">
<style>
  :root { color-scheme: light; --fg:#2c2a26; --dim:#8a8578; --card:#fff; }
  html[data-theme="dark"] { color-scheme: dark; --fg:#e6e2d8; --card:#23211d; }
  body { margin:0; padding:10px; font:13px/1.6 system-ui,sans-serif; color:var(--fg); background:var(--card); }
</style>
</head>
<body data-bind-state="booting">
  <div id="out">（等上下文）</div>
  <div id="err" style="color:#c0392b"></div>
<script>
(function () {
  "use strict";
  var seq = 0, waiting = new Map();
  function call(op, payload) {
    var id = "r" + ++seq;
    return new Promise(function (resolve, reject) {
      waiting.set(id, { resolve: resolve, reject: reject });
      parent.postMessage({ source:"workbench-tool", type:"tool:request", id:id, op:op, payload:payload||{} }, "*");
      setTimeout(function () { if (waiting.delete(id)) reject(new Error("宿主没有回应（"+op+"）")); }, 10000);
    }).then(function (r) { if (!r.ok) throw new Error(String(r.error || "宿主拒绝了这次请求")); return r.data; });
  }
  function fail(msg) {
    document.getElementById("err").textContent = msg;
    document.body.dataset.bindState = "error";
  }
  window.addEventListener("message", function (e) {
    var m = e.data;
    if (!m || m.source !== "workbench-host") return;
    if (m.type === "tool:response") {
      var w = waiting.get(m.id);
      if (w) { waiting.delete(m.id); w.resolve({ ok:m.ok, data:m.data, error:m.error }); }
      return;
    }
    if (m.type === "tool:context") {
      var ctx = m.data;
      document.documentElement.dataset.theme = ctx.theme || "light";
      if (!ctx.inject) return;
      call("task.get", {})
        .then(function (t) {
          document.getElementById("out").textContent =
            t.title + "（截止 " + (t.dueDate || "未设") + "）";
          document.body.dataset.bindState = "bound";
        })
        .catch(function (err) { fail(err.message); });
    }
  });
})();
</script>
</body>
</html>
```

---

## 八、界面规范

这些不是风格偏好，是让工具"装上去像个正经功能"的底线：

- **响应深浅色**。自己定义一套 CSS 变量，用 `html[data-theme="dark"]` 覆盖，
  收到 context 后切属性。不要写死白底黑字 —— 宿主切深色后工具还是一块白，很割裂。
- **关键状态挂 DOM**。这个项目每一个功能的 e2e 都靠 `data-*` 断言：

  ```js
  document.body.dataset.bindState = "bound";   // booting / bound / error
  button.dataset.act = "save";
  li.dataset.id = row.id;
  ```

- **不写假按钮**。点了没反应的按钮、永远走不到的空状态、写死的假数据，
  都会让人以为工具坏了。功能没做就不放那个入口。
- **错误要显示在界面上**，不要只在 console 里 log，并且**把宿主的原话显示出来** ——
  "存不进去：列「金额」是 real，收到的是 string" 这种能直接照着改的话，比"保存失败"有用得多。
- **破坏性操作要二次确认**。示例工具用的是行内二次确认（点一次变成"再点一次确认"），
  比 `confirm()` 弹窗更不容易阻塞自动化。
- **文案说人话**，简体中文。

---

## 九、让 AI 助手代写

助手写工具走的是一条**有门禁的路**，不是"生成一段 HTML 就完事"：

```
read_skill（取 tool-authoring / data-binding / component-inject 的全文）
   ↓
write_file（源码很长时分段写进工作区：第一段正常写，后续段带 append:true）
   ↓
sandbox_run（隔离 iframe 里真跑一遍 → 抓报错、看有没有渲染出东西、核对你声明的能力）
   ↓ 通过才发 ticket（通行证）
install_tool（先验票，无票直接回绝）
```

关于通行证（ticket）：

- 票绑的是 `(id, html, schema, capabilities, injects)` 的**指纹**，改一个字符就作废，TTL 30 分钟。
  指纹比较前会 `normalizeHtml`（BOM / CRLF / 首尾空白不算改动）。
- `install_tool` 的 **html 是可选的**：省略时装的正是 `sandbox_run` 验过的那一份
  —— 推荐这么做，省得把源码再抄一遍（抄一遍极容易对不上票）。
- 票对不上时宿主会**主动重验一次**，但只在沙箱能真跑起来（`report.ran`）时才放行；
  跑不起来就回绝，并给出两条路：重跑 `sandbox_run`，或省略 html。
- 门禁在**宿主代码**里，不在提示词里 —— 提示词只是概率，而"装上一个跑不起来的工具"是实打实的坏结果。

关于长度：

- 一次回复有长度上限（`max_tokens` 已显式设为 8192，但一份几百行的 HTML 仍可能写不完）。
  写到一半被掐断时代码块不闭合，宿主什么也收不到。
- 正确做法是**直接分段**：`write_file` 第一段正常写，之后每段带 `append: true` 接着写，
  然后 `sandbox_run` 只给 `html_file` 指过去。
- 收到"被输出长度上限掐断"时，**换成分段那条路，不要从头再写一遍** —— 从头写还是会断在同一个地方。

---

## 十、改表结构、卸载与数据

建表用 `CREATE TABLE IF NOT EXISTS` + 一份版本台账：

- 表不存在 → 按声明建（含索引）
- 表已存在且 `dbVersion` 与台账一致 → 什么都不做
- `dbVersion` 变了 → 重新发一遍 CREATE，但**已存在的表不会被改**

所以**"给已有表加一列"不会自动生效**。真要做到：把 `dbVersion` +1、改好 schema，
然后请用户在「设置 → 数据库」里对该工具点「清理数据」—— 那会删掉旧表，下次打开时按新声明重建。
**这会丢数据**，所以要提前跟用户说清楚。

卸载工具**不删数据**：工具表、它的 kv 配置都留着，重装回来数据还在。
真正的清理只有一处入口：设置 → 数据库 → 该工具的「清理数据」。

---

## 十一、自检清单

- [ ] **已 `sandbox_run` 通过并拿到 ticket**（没票装不上，这不是可选项）
- [ ] 单个 HTML，CSS/JS 全内联，无外部引用、无 CDN
- [ ] id 合法（`^[a-z][a-z0-9-]{1,31}$`）、name 是中文短名、icon 在白名单里
- [ ] 需要存数据 → `schema` 已声明，且 `dbVersion` 与声明对应
- [ ] 用了 `gallery.*` → `capabilities` 里有 `gallery`；用了 `task.get` → 有 `task`
- [ ] 能力不可用时有降级路径，而不是一句"失败"
- [ ] 会写数据的地方都有失败提示，且显示的是宿主的原话
- [ ] 深浅色都试过（把 `<html data-theme>` 手动改成 `dark` 看一眼）
- [ ] 关键状态挂了 `data-*`，按钮有 `data-act`
- [ ] 没有假按钮、没有写死的假数据
- [ ] 注入组件：不假设 `tool:context` 先到；不用全局变量记上一条；按钮型能在 320px 里用

---

## 十二、报错对照表

| 宿主的原话 | 真正的原因 | 怎么改 |
| --- | --- | --- |
| `这个扩展没有申请 gallery 能力` | manifest 的 `capabilities` 里没写 | 加上 `gallery`，重装 |
| `gallery 能力当前不可用（提供它的模块没有启用）` | 图库是选装模块，没开 | 设置 → 行为 → 选装模块 → 开图库；或让工具降级 |
| `这个组件没有挂在任何一条待办上…` | 整页工具调了 `task.get` | 注入组件才能用；整页模式下这是预期行为 |
| `它挂着的那条待办已经不存在了` | 那条刚被删了 | 界面上显示出来，不要静默 |
| `没有声明过「xxx」这张表。可用的是：…` | `schema.tables` 里没有这个裸表名 | 补声明，或改掉调用里的表名 |
| `这个工具没有声明任何数据表（manifest 里缺 schema）` | 单文件导入进来的工具有表需求 | 用整个目录 + manifest.json 的方式装 |
| `表「notes」里没有「xxx」这一列` | 写了没声明的列 | 多出来的列是**拒绝**不是忽略 |
| `列「done」是 integer，收到的是 string` | 类型不对 | 按类型给值（SQLite 会静默转，内存库不会） |
| `非法的 key（只允许字母数字与 _ . : -，长度 1-64）` | kv 的键名不合法 | key 只允许 `[A-Za-z0-9_.:-]` |
| `value 必须是字符串` / `value 超过 512 KB 上限` | kv 的值 | 自己 `JSON.stringify` |
| `「xxx」此刻没有在运行，消息没送到` | `tools.send` 投给了没在跑的工具 | 先用 `tools.open` 把它拉起来 |
| `不能拉起自己` | `tools.open` 的目标是自己 | 换一个目标 |
| `宿主没有回应（xxx）` | 超时（10s） | 检查 `source` 是不是写成了别的；检查 op 拼写 |
| 组件永远停在"等上下文" | 没收到 `tool:context` | 自己再 `call("info")` 取一次，不要只等推送 |

---

## 十三、样本索引

| 样本 | 在哪 | 看什么 |
| --- | --- | --- |
| **能力演示** | `examples/kitchen-sink/` | **全功能**：五种通道 + 三个注入位置，每块都真跑一遍 |
| 注入夹具 | `tests/fixtures/tools/panel-demo/` | 最小注入组件：只做"我在哪、我替谁干活" |
| 任务截止 | `tests/fixtures/tools/task-due-panel/` | 真实注入组件：读当前待办的截止日，算剩余 / 逾期 |
| 番茄钟 | `tests/fixtures/tools/pomodoro/` | 私有表（schema + row.*）的整页工具 |

`examples/` 与 `tools/`、`tests/fixtures/tools/` 的分工：

| 目录 | 进安装包 | 出现在用户设置页 |
| --- | --- | --- |
| `tools/` | 会 | 会 |
| `tests/fixtures/tools/` | 不会 | 不会（`?fixtureTools=` 时装载） |
| `examples/` | 不会 | 不会 |

**新增样本一律放 `examples/`**：多一个目录既不会让用户的侧边栏变长，也不会让安装包变大。

样本不是"写完就放着"：`node scripts/verify-example.mjs` 会用宿主的真代码把它装一遍、
建表、并用真的 `toolBridge` 把每个 op 跑一遍（含反面用例）。**改了契约就跑它** ——
文档、样本、代码三处一起动，才不会出现"文档说能这么写、代码其实不认"。

---

## 相关文档

- `docs/architecture-and-extensions.md` —— 注册表、注入点、能力门的设计来由（第 3、6 节）
- `src/lib/agent/skills.ts` —— 同一批规则的**另一份投影**（给模型的）：`tool-authoring` /
  `data-binding` / `component-inject` / `tool-integration`。改契约时三处都要动。

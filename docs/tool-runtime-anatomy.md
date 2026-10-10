# 工具系统现状解剖

> 目的：开发「工具间数据互通」之前，先把**现在到底是怎么跑的**钉死。
> 本文所有结论都标注了**文件 + 行号**，可逐条核验。
> 核验日期：2026-10-04 · 对应版本 v0.2.7 · schema v20

---

## 目录

- [一、工作流程：从磁盘目录到跑起来的 iframe](#一工作流程从磁盘目录到跑起来的-iframe)
- [二、如何内联：三个注入点](#二如何内联三个注入点)
- [三、如何工作：postMessage 协议](#三如何工作postmessage-协议)
- [四、数据库状态：四张相关表](#四数据库状态四张相关表)
- [五、附：数据互通的现状与断点](#五附数据互通的现状与断点)

---

## 一、工作流程：从磁盘目录到跑起来的 iframe

### 1.1 一句话链路

```
磁盘目录 → 扫描+校验 → 内存注册表 → 灌进扩展注册表 → 侧栏/注入点可见
   → 用户点击 → ToolArea 挂 iframe → ToolHost 解析 URL + 建表
   → ToolBridge 建立 postMessage 通道
```

工具**全程是运行时装进来的 iframe**，宿主与工具之间只有 postMessage 一条路。

### 1.2 三种正交状态（务必分清）

| 状态 | 含义 | 存在哪 |
|---|---|---|
| **安装** | 磁盘上有目录 | `%APPDATA%\com.sogapopo.todo-workbench\tools\<id>\` |
| **启用** | 设置里允许 | `core_settings` 的 `tools.disabled`（逗号分隔 id，settings.ts:105） |
| **挂载** | 此刻在 DOM 里 | 内存 store 的 `aliveToolIds`（store.ts:156，**不落盘**） |

被停用的工具**仍留在注册表**，只是不进侧栏（tools.ts:532-534 `filterEnabled`）。

### 1.3 发现与校验

**入口守门**：`validateManifest()`（tools.ts:161-227）是唯一入口。要点：

- `id` 必须 `/^[a-z][a-z0-9-]{1,31}$/`（会拼进表名，非法则整份丢弃，tools.ts:170）
- `entry` 禁 `..`、禁 `/` 开头、禁 `xxx:` 协议（tools.ts:173）
- `schema` 校验不过 → **整份丢掉**，不做部分采纳（tools.ts:187-190）
- `headless` **仅 `=== true` 才生效**（tools.ts:219）
- `source` 字段**完全不读**，由宿主扫描时盖戳（types.ts:642-647）

**扫描**：`scanTauriTools()`（tools.ts:429-463）两级来源：

1. `resourceDir()/_up_/tools` → 空则试 `resourceDir()/tools`
2. `appDataDir()/tools`，且 id 不在 bundledIds 里

**来源判定**：`bundled` = 出现在安装包资源里；`user` = 不在安装包里的用户区工具（tools.ts:444-460）。
⚠️ 不能按目录位置分类 —— Rust 启动时会把内置工具同步到用户区，两边都有副本。

**⚠️ 关键事实：安装包现在不带任何工具**

`src-tauri/tauri.conf.json` 的 `bundle.resources` = `["WebView2Loader.dll"]`（2026-10-04 实测）。
所以 release 包里 `resourceDir()/_up_/tools` 不存在，合并后 `bundled` **恒为空数组**。
工具靠 Release 上的独立 zip（`scripts/pack-tools.mjs`）分发。

> 这条已与 `docs/tool-authoring-and-injection.md:796-802` 不符（那份文档还写着"进安装包：会"）。

### 1.4 桌面端 Rust 同步

`src-tauri/src/lib.rs` `sync_builtin_tools()`（40-109），在 `run()` 的 setup 里调用（213-219）：

1. 建 `app_data_dir()/tools`
2. 读 `.uninstalled` 清单
3. 候选路径：`resource_dir()/_up_/tools`、`resource_dir()/tools`
4. **源码树候选仅 debug**（77-85）：
   ```rust
   #[cfg(debug_assertions)]
   let mut candidates = candidates;
   #[cfg(not(debug_assertions))]
   let candidates = candidates;

   #[cfg(debug_assertions)]
   if let Some(manifest) = option_env!("CARGO_MANIFEST_DIR") {
       candidates.push(Path::new(manifest).join("..").join("tools"));
   }
   ```
   这是 v0.2.7 修掉的缺陷：原先无条件追加，release 包在开发者机器上会把源码树工具拷进用户区。
5. 取第一个存在的候选，逐子目录：`upgrade = src.version > target.version` 才覆盖（101-105）
6. 跳过 `.uninstalled` 里的 id（96-98）

> ⚠️ lib.rs:48 的注释仍写着 resources 是 `../tools/**/*`，与当前配置不符（不影响行为，会误导）。

### 1.5 卸载的语义（`.uninstalled`）

`uninstallTool()`（toolStore.ts:390-413）：

- 删 `<appData>/tools/<id>` 目录
- `bundled` → **写进 `.uninstalled`**（否则 Rust 同步会把它拷回来），提示"还能装回来"
- `user` → **反向从清单里删掉**该 id，提示"删了就真没了"

两种文案都明确说了"数据会留在库里"。

### 1.6 运行时形态

| 项 | 事实 | 位置 |
|---|---|---|
| 挂载组件 | `ToolHost.tsx` 的 `ToolFrame`（48-270），由 `ToolArea.tsx` 渲染 | — |
| iframe src | 浏览器 `${BASE_URL}/tools/<id>/<entry>`；桌面 `convertFileSrc()` → **asset 协议** | tools.ts:685-716 |
| 切工具 | 不卸载，非活动帧 `className="hidden"` —— 这就是"保持状态"的全部实现 | ToolHost.tsx:222 |
| `keepState` 关 | `aliveAfterOpen`（store.ts:78-92）返回 `[id]`，切走即卸载 | — |
| 重建 | 头部「重置」→ `toolReloads[id]++` → iframe `key={url#reload}` | ToolHost.tsx:50,246 |

**asset 协议的两个坑**（ToolHost.tsx:347-368，写新功能必记）：

1. URL 里只有开头一个 `/`，所以 `src="ai/ort.js"` 这类**相对引用会被解析到站点根**，必须拼绝对 URL
2. 工具 origin 与宿主**不同源**，postMessage 的 targetOrigin 要处理（toolBridge.ts:595-617）

**headless**（manifest 字段，默认 false）：允许宿主在工具没打开时起隐藏 iframe 执行动作。
`runHeadless`（toolHeadless.ts:66-126）：挪到视口外而非 `display:none`（后者在部分 WebView 里会被节流）、
自己 `ensureToolSchema`、**不给 `getInject`**、用完即 `detach + remove`（一次性）。

---

## 二、如何内联：三个注入点

### 2.1 契约

`ToolInjectKind`（types.ts:190）= **`detailSection` | `rowAction` | `detailAction`** —— 只有这三个。

为什么只开放三个（types.ts:181-189）：这三个都局限在某一条待办上；
`nav` / `view` 是全局的，不该由运行时装进来的 HTML 占掉。

`ToolInjectSpec` = `{ kind, label?, height? }`；`INJECT_HEIGHT = { min:80, max:600, default:180 }`（types.ts:207）。
`normalizeInjects`（types.ts:222-240）：kind 不在白名单就丢、**按 kind 去重**、label 裁到 20 字符。

### 2.2 各注入点落在界面的哪里

| 注入点 | 组件 | 界面位置 | 尺寸 |
|---|---|---|---|
| `detailSection` | `InjectedDetailSections`（161-186） | 详情面板**可滚动区底部**，排在内置分区之后（TaskDetail.tsx:647） | `spec.height ?? 180` |
| `detailAction` | `InjectedDetailActions`（262-264） | 详情**头部行**内，标题之后、关闭按钮之前（TaskDetail.tsx:606） | 浮层 320（InjectedTools.tsx:198） |
| `rowAction` | `InjectedRowActions`（266-268） | 行的**悬停操作区最左侧**，compact（TaskRow.tsx:334） | 同上 |

全部在 `src/components/InjectedTools.tsx`。

### 2.3 挂载规则

- **每条待办一个 iframe 实例**（`InjectedFrame`，38-155）
- **不需要工具先打开** —— 三个组件都只读 `enabledTools`（162 / 209），"启用就行，不必运行"
- 桥 effect 依赖 `[url, tool.id, spec.kind, taskId]`（115），**换待办 → 桥重建**
- 上下文推两次：`onLoad`（147-150）**和** `useEffect([loaded, …])`（125-127）
  —— 因为 asset 协议加载极快，`load` 常早于建桥 effect，那一次 postMessage 会投进虚空

### 2.4 ⚠️ 注入组件是"二等公民"（对数据互通极其关键）

`InjectedTools.tsx:94-99` 建桥时**只传了三个参数**：

```ts
const bridge = createToolBridge(tool.id, () => frameRef.current, {
  getTables: () => tablesRef.current,
  getSettings: () => useStore.getState().settings,
  getInject: () => ({ kind: spec.kind, taskId }),
});
```

**没有 `openTool`，也没有 `peers`**（对比 ToolHost.tsx 的整页桥有）。后果，已实测确认：

| 调用 | 结果 | 位置 |
|---|---|---|
| `tools.list` | 返回 `{ tools: [] }` —— **静默空，不报错** | toolBridge.ts:889-891 |
| `tools.open` | 报 `这个宿主没有提供工具联动` | toolBridge.ts:902-904 |
| `tools.send` | **可用**（走 toolLink，与实例注册表无关） | toolBridge.ts:915-942 |

`toolHeadless.ts:108-111` 同样不传这两个 → headless 实例也是二等公民。

---

## 三、如何工作：postMessage 协议

### 3.1 协议骨架

- 标记：`TOOL_SOURCE = "workbench-tool"` / `HOST_SOURCE = "workbench-host"`（toolBridge.ts:105-106）
- 安全：回消息前校验 `event.source` 必须是当前 iframe 的 contentWindow（防止同页面其他 iframe 冒充）
- 通道性质：**受限通道，不是通用 SQL 代理**。工具只发裸表名（如 `records`），
  宿主用 `toolTable()` 拼成 `tool_<id>_<table>` —— 是安全边界，不是约定

### 3.2 op 全集（20 个）

| 组 | op | 用途 |
|---|---|---|
| 基础 | `info` | 通道能力自述 |
| 遗留 | `count` | 裸表计数（Legacy，新工具用 `row.count`） |
| 配置 | `kv.get` / `kv.set` / `kv.all` / `kv.del` | 工具自己的配置（走 `core_tool_kv`） |
| 私有表 | `schema.info` / `row.count` / `row.select` / `row.insert` / `row.update` / `row.delete` | 结构化 CRUD，**不是 SQL** |
| 任务 | `task.get` | 读当前待办（需 `task` 能力 + 注入上下文） |
| 联动 | `tools.list` / `tools.open` / `tools.send` | 工具互通（详见第五节） |
| 图床 | `gallery.list` / `gallery.get` / `gallery.put` | 共享媒体（需 `gallery` 能力） |
| 配置 | `config.image` | — |

设计要点（toolBridge.ts 文件头）：

- **值按列类型强校验**（integer 列传字符串直接拒）—— 不为防攻击，
  是为了让 SQLite（有类型亲和性会默默转）与浏览器内存库行为一致
- `gallery.*` 是**一次有意识的边界放宽**：图床是全局资源，不是某工具私有数据。
  理由见 toolBridge.ts:36-52。仍守住三条：工具传 id 不传路径、
  `origin` 不接受工具传值（由 tool_id 映射，provenance 可信）、单条读取有字节上限

### 3.3 消息类型（工具侧收到什么）

| type | 时机 | 载荷 |
|---|---|---|
| `tool:context` | 加载完 / 换主题 | 运行上下文 |
| `tool:response` | 请求回应 | `{ id, ok, data \| error }` |
| `tool:intent` | 被 `tools.open` 拉起 | `{ data, from }` |
| `tool:event` | `tools.send` 过来 | `{ event, data, from }`（from = 发起方 id） |

### 3.4 能力门

`CAPABILITY_NAMES`（registry.ts:50）= `["gallery", "attachments", "row", "kv", "task"]`

- **没有 `link`** → `tools.*` **完全没有能力门**，任何工具都能调，`ctx.link` 恒为 `true`（toolBridge.ts:438）
- `gallery.*` 有门（952-957），三态：`not-granted` / `unavailable` / `on`
- `task.get` 有门（660-665）
- **每次判断都现取设置**（ToolHost.tsx:159）—— 用户在设置里打开图床后，已挂着的工具应立刻能用

开关键 `ext.<id>.enabled`；`isEnabled` 缺键/空串按 `enabledByDefault`（registry.ts:252-258）。

### 3.5 headless 决策顺序

`toolRuntime.ts` `callTool`（95-144）：

1. `live` 里有实例 → **优先发给正在跑的那个**
2. 没有 → 校验 actions/commands 声明
3. `opts.headless !== true || tool.headless !== true` → 拒绝，提示"先 open_tool"
4. 否则 `runHeadless`

一次性实例，**内存状态不保留**，只有写进 `row.*` / `kv.*` 的改动留得下。

---

## 四、数据库状态：四张相关表

当前 `CURRENT_SCHEMA_VERSION = 20`（migrations.ts:787）。

### 4.1 `tool_<id>_<table>` —— 工具私有表

- **命名**：`tool_` + id（连字符→下划线）+ `_` + 表名（tools.ts:725-741）
- **声明**：manifest 的 `schema.tables[]`，宿主拼全名
- **约束**（toolSchema.ts）：表名 `/^[a-z][a-z0-9_]{0,47}$/`；最多 12 表 / 40 列 / 8 索引，单索引最多 4 列；
  **每表恰好一个主键**（因为 update/delete 只能按主键定位一行）
- **`dbVersion` 的作用**：宿主"上一次为这个工具建到哪个版本"的对端记账值。
  `ensureToolSchema`（toolSchema.ts:208-241）：台账版本 == manifest.dbVersion → **直接返回，连 DDL 都不发**
- **建表时机三处**（都是挂载时才建）：
  1. 整页工具挂载（ToolHost.tsx:89）
  2. 注入组件挂载（InjectedTools.tsx:73-90）
  3. headless 隐藏实例（toolHeadless.ts:89-93）
- ⚠️ `CREATE TABLE IF NOT EXISTS` 意味着**已存在的表不会被改列** —— 加列必须靠清库
- `dropToolNamespace(toolId)`（286-322）：删该工具所有表 + kv 行 + 台账行，**只在用户点"清理"时调用**

### 4.2 `core_tool_kv` —— 工具配置（v5，migrations.ts:140-152）

```sql
CREATE TABLE IF NOT EXISTS core_tool_kv (
  tool_id    TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tool_id, key)
);
```

- **所有工具共用一张表**（API Key、上次选的模型、生成历史…）
- 隔离靠宿主强制：请求里**没有 `tool_id`**，由宿主从"这条消息是哪个 iframe 发来的"推导
  → 工具物理上读写不到别的工具的键
- 为什么一张而不是每工具一张（130-139）：工具表要跟着核心迁移走，
  每加一个要存配置的工具就得加一次迁移；而配置形态是工具自己的事
- 上限：`kv.set` key `/^[A-Za-z0-9_.:-]{1,64}$/`、value 512 KB（toolBridge.ts:151）

### 4.3 `core_tool_schema` —— 建表台账（v10，migrations.ts:427-435）

```sql
CREATE TABLE IF NOT EXISTS core_tool_schema (
  tool_id    TEXT PRIMARY KEY,
  version    INTEGER NOT NULL DEFAULT 0,
  applied_at TEXT NOT NULL
);
```

`dbInspect.ts:190-191` 用它列出"已卸载但仍占着表"的工具。

### 4.4 `core_imagebed_items` —— 图床（v9，migrations.ts:385-414）

`gallery` 能力的物理落点，**跨工具共享**，是数据互通目前唯一跑通的公共介质。
字段里有 `origin`（toolBridge.ts:509，记录写入方工具 id）。

### 4.5 迁移里工具相关的全部版本

| 版本 | name | 内容 |
|---|---|---|
| v4 | `add_special_orders_tool_schema` | `tool_special_orders_records`（**历史遗留占位**，不对应真实工具） |
| v5 | `add_tool_kv_store` | `core_tool_kv` |
| v9 | `add_gallery` | `core_imagebed_items` |
| v10 | `add_tool_schema_ledger` | `core_tool_schema` |
| v17 | `modules_opt_in` | `special.enabled` → `ext.special.enabled`，按"有没有用过"回填 |
| v18 | `agent_skills` | `core_agent_skills`（工具的 `skill` 走另一套 `tool-use-<id>` 投影） |

---

## 五、附：数据互通的现状与断点

> 这是下一步要动的地方，先把家底摸清。

### 5.1 现有能力（`tools.*` 三件套）

| op | 能力 | 限制 |
|---|---|---|
| `tools.list` | 列出同伴**元信息**（id/name/icon/version/description/running/active） | **拿不到入口地址**；只返回启用中的；注入场景返回空 |
| `tools.open` | 拉起同伴 + 塞一份任意数据 | 禁拉自己；注入场景不可用 |
| `tools.send` | 给**已运行**的同伴发事件 | 收不到会明确报错；注入场景可用 |

设计取向（toolBridge.ts:81-87、toolLink.ts:17-22）：
**刻意不做通用事件总线** —— 订阅方没在运行时消息**静默丢失**。
所以只做定向投递，收不到就明确返回 false。

### 5.2 实际用起来的样子：几乎没有

| 工具 | 发 `tools.*` | 收 `tool:intent` | 收 `tool:event` |
|---|---|---|---|
| scratchpad（模板） | ✅（`tools.list` / `tools.open`） | ✅ | ✅（含 `schema:reset`） |
| ai-gen | ❌ | ❌ | ❌ |
| image-crop | ❌ | ❌ | ❌ |
| size-chart | ❌ | ❌ | ❌ |

**实测确认**：三个图像类工具 grep `tool:intent|tool:event` 命中 **0 处**。

- scratchpad 的 manifest 描述"能把内容交给别的工具"**属实**：
  每条记录右侧有「交给…」下拉（index.html:217-220），选中后 `tools.open` 传 `{title, body, tag}`，
  并明确提示"对方需要自己实现接收"（322）
- **跨工具实际用例：一个都没有。** 测试自己承认（tests/tool-database.mjs:291-292）
- kitchen-sink 是唯一全链路样本（收+发都有），但**不进安装包、不出现在设置页**

### 5.3 图床中转：能用，但是"拉模型"

- A：`gallery.put` → 拿到 `id`
- B：`gallery.list`（带 320px thumb）→ `gallery.get(id)` 拿 dataUrl
- **需要双方** manifest 都有 `"capabilities": ["gallery"]`，且 `ext.imagebed.enabled` 开着
- 单侧动作完全通，已被 e2e 保护（tests/tool-browser.mjs:187-266）
- **但作为中转缺三样**：
  1. B 不知道 A 刚放了哪条（`gallery.list` 只支持 kind/search/limit，**没有 origin/时间筛选**）
  2. 没有把 A 写出的 id 交给 B 的机制
  3. 没有"只拿某工具产物"的过滤（`origin` 字段存在，但 list 不支持按它过滤，只能在 JS 里筛）

### 5.4 断点清单（按严重度）

**① `opened: true` 是乐观返回，可能永远送不到**（高）
只等 `openToolWithIntent` 的 `set` 完成就回成功（toolBridge.ts:912）。
若目标工具入口解析失败 → 渲染 `ToolContractDemo`，不建桥、`ready` 永不为真 →
intent **永久滞留**在 `toolIntents[id]`。没有超时、没有回执、没有清理。
且 `closeTool`（store.ts:716-725）**不清 `toolIntents`** → 下次打开会把很久以前排的 intent 投给新实例。

**② `tools.send` 的 `delivered: true` 可能是假成功**（高）
`registerToolPoster` 在 `createToolBridge` 内**同步**执行（toolBridge.ts:623），早于 iframe `load`。
此时 `postToTool` 返回 true，消息 post 进一个还没挂监听的 window → **不报错也没人收到**，
而宿主回报成功。正是文件头说要避免的那类静默丢失。

**③ `running` 与"能否投到"用两套判据**（中）
`tools.list` 的 `running` 用 `aliveToolIds`（set 后立即为真）；
`tools.send` 用 poster 是否注册（要等 url 异步解析完才建桥）。刚 `open` 完立刻 `send` 会误报。

**④ `postToTool` 实际是广播，不是定向**（中）
toolLink.ts:57 遍历整个 Set。同一 id 的**所有**实例都会收到：整页 + 每个注入组件 + headless 隐藏实例。
kitchen-sink 声明了 3 个注入位置，一条 `tools.send` 会打到 4 个 iframe。

**⑤ 注入/headless 是二等公民**（中）—— 见 2.4

**⑥ `tools.*` 通道没有大小上限**（中）
对比：`gallery.get` 卡 10 MB（toolBridge.ts:162，理由见 154-161 注释），
`gallery.put` image 20 MB / video 200 MB，`kv.set` 512 KB。
**唯独 `tools.open/send` 的 `data` 无任何校验**（906、927-933）。同样的理由对它完全成立却没落地。

**⑦ `postEvent` 是死代码**（低）
toolBridge.ts:289 / 1059-1060 定义，**全仓无调用点**；且拼的消息**没有 `from` 字段**，与 `tools.send` 不一致。

**⑧ `ctx.link` 恒 `true` 与实况不符**（低）—— 注入/headless 下 `tools.open` 实际不可用

**⑨ 单向、无回执、无数据格式约定**（设计缺口）
- `tools.open/send` 都是 fire-and-forget，A 拿不到 B 的处理结果
  （对比 `tool:command` 有 `tool:command:result`）
- `data` 形状完全靠两个工具私下约定，宿主只透传
- `tools.list` 只给 name/description，A 无从知道 B 接受什么格式

**⑩ 宿主主动带数据拉起工具这条路不存在**（低）
store.ts:132 注释说 `from = null` 表示宿主自己（比如"图床里用某工具打开"），
但全局 `openToolWithIntent` 只在 ToolHost.tsx:154 被调用，`ImagebedView.tsx` 里没有任何相关代码。
助手侧 `open_tool`（agent/actions.ts:1210-1224）也**只能开、不能带数据**。

### 5.5 改动时不能弄坏的测试

| 测试 | 保护什么 |
|---|---|
| `tests/tool-database.mjs` 第 7、8 节（259-300） | 唯一的真实联动 e2e：`tools.list` 列出同伴、`tools.open` 成功、两个 iframe 同时活着、拉不存在的返回 false |
| `tests/smoke.mjs:2188-2192` | **静态源码守卫**：`tools.send` 必须含"此刻没有在运行，消息没送到"、`openToolWithIntent: async (id, data`、`已被停用，请先在设置 → 工具里启用它`（改文案就红） |
| `scripts/verify-example.core.mjs:226-231` | `tools.list` 返回数组、send 给没跑的返回 false、open 自己被拒 |
| `tests/tool-browser.mjs:357-397` | 6b 节"两个工具同时活着"依赖 `aliveToolIds` 语义 |

注意：`askInTool`（tool-database.mjs:108-132）必须 `frame.evaluate` 在 iframe 上下文里发，
因为桥有 `e.source !== frame.contentWindow` 硬校验（toolBridge.ts:633）。

### 5.6 文档与代码不一致（改文档时一并修）

| # | 文档位置 | 文档说 | 代码实际 |
|---|---|---|---|
| 1 | :125 manifest 字段表 | `source` = `builtin`/`user` | 工具是 `bundled`/`user`；`builtin` 是另一条轴线上 `ResolvedExtension.source` 的取值 |
| 2 | :104 示例 | manifest 写 `"source": "user"` | `validateManifest` 不读，会被丢弃 |
| 3 | :119 | `version` 必填，默认 `1.0.0` | 扫描路径默认 `"0.0.0"`，导入路径默认 `"1.0.0"`，且不强制 |
| 4 | :120 | `entry` 必填，默认 `index.html` | 扫描路径缺 entry 直接返回 null，无默认值 |
| 5 | :142-145 | "三个提示词副本里写了 `bot` 而真身没有" | 已修（icons.ts:54 有 `bot`） |
| 6 | :217 | `schemaVersion: 18` | 现在 20 |
| 7 | :796-802 | `tools/` 进安装包：**会** | **不带**（bundle.resources 只有 WebView2Loader.dll） |
| 8 | —（缺失） | 未提及注入组件的联动限制 | 注入调 `tools.list` 返回空、`tools.open` 报错 |

---

*本文是开发「工具间数据互通」的事实基线。动代码前先对着第五节确认要碰哪些断点。*

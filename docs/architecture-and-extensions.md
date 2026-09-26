# 架构与扩展开发指南

这份文档回答一个问题：**往这个程序里加东西时，边界在哪、要动哪些地方。**

它写给下一次要加模块 / 加工具 / 改数据通道的人（包括 AI 助手）。读完应当不需要去猜"这个开关为什么在这里还判了一次"。

---

## 1. 内核：待办

工作台的内核是**待办**。这几样永远编译进主程序，没有开关：

| 组成 | 落点 |
|---|---|
| 任务 / 清单 / 子任务 | `core_tasks` / `core_lists` / `core_steps` |
| 三个筛选视图 | 我的一天 / 重要 / 全部（`lib/rows.ts` 分组） |
| 详情面板 | `components/TaskDetail.tsx` + `lib/detailSections.ts` |
| 提醒与紧急区 | `lib/urgent.ts` + `components/UrgentPanel.tsx` |
| 设置 | `core_settings`（键值对，见 `lib/settings.ts`） |

判据很简单：**拿掉它之后这个程序还叫不叫"待办工作台"**。不叫的，就是内核。

其余一切都是模块，理论上都可以不开：

| 模块 | id | 默认 | 说明 |
|---|---|---|---|
| 流程任务 | `orders` | 开 | 与待办分表、只在展示层混排 |
| 特殊单号 | `special` | **关（选装）** | 带处理时效的流程任务真子集 |
| 图库 | `gallery` | **关（选装）** | 所有工具产物的共同落点，同时提供 `gallery` 能力 |
| AI 助手 | `agent` | 开（看有没有配 Key） | 入口只有悬浮球，刻意不占侧栏 |
| 工具 | 工具 id | 装上就开 | 用户自己装，见第 5 节 |

---

## 2. 注册表：一个模块 = 一条登记

所有模块登记在 `src/lib/extensions/registry.ts` 的 `BUILTIN` 里。宿主组件**不再认识任何具体模块**——它只问注册表：

```ts
isEnabled(settings, id)            // 这个模块开着吗
navItems(settings, "tasks")        // 侧栏该列哪几项
isViewAvailable(settings, view)    // 能落在这个视图上吗
capabilityState(settings, ext, c)  // 这个扩展能用这项能力吗
```

### 以前的样子（以及为什么要改）

加一个模块要同时动五六处，而且**漏掉任何一处都不报错**，只是界面有一半不对：

- 侧栏 `SMART_ITEMS` 数组里加一行，再跟一句 `specialOn &&`
- `App.tsx` 里往 `view === "gallery" ? <GalleryView/> : <TaskList/>` 上再套一层
- `store.setView` 里拦一道（否则提醒卡片的「查看」会落到空列表上）
- 提醒循环里提前 `return`
- 紧急区过滤一次
- `rows.ts` 的分组再传一次开关

现在这些都归一处。加一个模块的代价 = 在 `BUILTIN` 里登记一条 + 在 `views.ts` 里给渲染体（如果需要整页视图）。

### 开关存在哪

`ext.<id>.enabled`，就是 `core_settings` 里的一行，和"要不要开提醒"在物理上没有区别。没有单独的表、没有单独的配置文件。

三个层次的判据，缺一不可：

1. **默认值**（`enabledByDefault`）只管**新建的库**；
2. **迁移回填**管**老库**——按"有没有用过"写值（见第 4 节）；
3. **`isEnabled` 里缺键按开**——给前两者都没跑到时留的最后一道兜底。

第三条看起来和第 1 条矛盾（默认关，缺键却按开），这是故意的：宁可让模块**多**显示一次，也不能让一个跟了两个月单子的人打开应用发现那批记录不见了。

---

## 3. 注入点

一个模块通过 `injects` 声明它要占哪些位置：

| kind | 含义 | 状态 |
|---|---|---|
| `nav` | 侧栏导航项（带 `group` 与 `icon`） | 已实现 |
| `view` | 整页视图，占主区 | 已实现 |
| `tool` | 整页工具（iframe 装载） | 已实现 |
| `detailSection` | 详情面板里的分区 | 已实现 |
| `rowAction` | 列表行上的按钮 | 已实现 |
| `detailAction` | 详情面板头部的按钮 | 已实现 |

后三项为什么先写进契约：它们的目的从一开始就是"别再往宿主里塞新的写死枚举"。`detailSections.ts` 里那六个**内置**分区现在还是写死的，但**新增**分区时应当走注册表，而不是再往数组里加一个。

### 组件注入：宿主挂载点在哪

三个挂载点共用一份答案 —— `registry.injectsFor(tools, kind)`（传进去的是**已经启用**的工具），渲染体在 `components/InjectedTools.tsx`：

| kind | 宿主位置 | 形态 |
|---|---|---|
| `detailSection` | `TaskDetail.tsx` 内置分区之后 | 直接展开，高度取 manifest 的 `height`（80–600，默认 180） |
| `detailAction` | 详情面板头部，关闭按钮之前 | 按钮 + 320px 浮层 |
| `rowAction` | `TaskRow.tsx` 悬停操作区最前 | 按钮 + 320px 浮层 |

### 注入组件能拿到什么

注入组件**不是**整页工具，它天生跟某一条任务绑定，所以：

- manifest 要申请 `capabilities: ["task"]`（`task` 由内核提供，`CAPABILITY_OWNER.task = core`）；
- 宿主经 `tool:context` 下发 `ctx.inject = { kind, taskId }`，组件据此知道"我现在嵌在哪条任务上"；
- 桥上多一个 `task.get`，返回**当前这一条**的只读快照（标题、说明、清单、到期、提醒、完成态……），拿不到别的任务，也没有写通道。

两道门缺一不可：`task` 能力没申请 → 回绝；没有 inject 上下文（比如整页打开时）→ 也回绝。所以它只能在挂载点上用，这是设计目的，不是限制。

> ⚠️ 浏览器里装不了工具（要写文件系统），注入组件怎么 e2e？`lib/tools.ts` 有一个三重门禁的夹具装载器：`import.meta.env.DEV` + `?fixtureTools=1` + 浏览器模式，三个都满足才把 `tests/fixtures/tools/` 里的工具挂进来。`tests/agent-sandbox.mjs` 就是靠它在浏览器里验完整条 `tool:context → task.get → 渲染`。

### 视图的两件事分开

「能不能落在这个视图上」和「它渲染什么」是两步，分别问不同的人：

- 合法性 → `registry.isViewAvailable`（模块关着的视图不能停在上面，那看上去像数据丢了）
- 渲染体 → `lib/extensions/views.ts` 的 `resolveViewComponent`

`views.ts` 为什么单独一个文件：注册表**不能 import 组件**。`store` 要问注册表问题，而组件 import `store`，一旦注册表反过来 import 组件就成了环——ESM 循环依赖不报错，但初始化顺序一变，某个东西在某一刻就是 `undefined`，症状是"有时首屏空白"。

---

## 4. 选装模块与迁移

把"内置就有"改成"想要再开"时，**默认值只管新建的库**。已经用了一段时间的库里躺着用户的数据，默认值一改，那些人的入口、提醒、紧急区会在升级后一起消失——而他们什么都没做。

所以改默认值的同一版必须配一条迁移，按「有没有用过」回填。当前的两条：

```sql
-- v17 modules_opt_in（同时把老的 special.enabled 搬到 ext.special.enabled）
INSERT INTO core_settings (key, value)
  SELECT 'ext.special.enabled', '1'
  WHERE NOT EXISTS (SELECT 1 FROM core_settings WHERE key = 'ext.special.enabled')
    AND EXISTS (SELECT 1 FROM core_work_orders WHERE kind = 'special' AND deleted = 0);

INSERT INTO core_settings (key, value)
  SELECT 'ext.gallery.enabled', '1'
  WHERE NOT EXISTS (SELECT 1 FROM core_settings WHERE key = 'ext.gallery.enabled')
    AND EXISTS (SELECT 1 FROM core_gallery_items);
```

两个 `WHERE` 缺一不可：

- **键已存在** → 用户自己按过那个开关（开过或关过），迁移不能替他改主意；
- **没有对应数据** → 他从没用过，按新的默认（关）就对了。

⚠️ 别写成聚合 SELECT（`SELECT MAX(...) FROM ...`）：不带 GROUP BY 的聚合**恒返回一行**，空表也会插入一条，撞上 `NOT NULL` 就是启动即崩，而且每次启动重演（v16 踩过，见 PITFALLS 七十三）。`EXISTS` 没有这个毛病。

**改动前必须做的事**：拿 python 的 sqlite3 把每条路径跑一遍（空表 / 有数据 / 数据已删 / 键已存在 / 重复执行），确认迁移幂等。这类 bug 只在"用户的库长什么样"上显形，开发机上往往全绿。

---

## 5. 工具：能装进来的那一类扩展

工具是一个目录 + 一份 `manifest.json`（`tools/<id>/`），装到 `%APPDATA%/…/tools/<id>/`。它跑在 iframe 里，与宿主之间只走 `postMessage`。

> 安装包从 v0.2.0 起**不带任何工具**：`tools/` 里有一份 50 MB 的抠图模型，为大多数人用不上的能力让每个用户每次更新都多下载几十兆，不划算。工具单独打成 zip 挂在同一份 Release 上（`scripts/pack-tools.mjs`），想要就下载解压，或者让内置助手现写一个。

### manifest 字段

```json
{
  "id": "image-crop",
  "name": "图片裁剪",
  "version": "2.0.0",
  "description": "……",
  "icon": "crop",
  "entry": "index.html",
  "dbVersion": 1,
  "author": "内置",
  "capabilities": ["gallery"],
  "injects": [
    { "kind": "detailSection", "label": "裁剪记录", "height": 200 }
  ],
  "schema": {
    "tables": [
      { "name": "records",
        "columns": [ { "name": "id", "type": "text", "pk": true } ],
        "indexes": [{ "columns": ["created_at"] }] }
    ]
  }
}
```

- `schema` → 私有表声明（宿主建表，见第 7 节）
- `capabilities` → 要碰**不属于自己**的共享资源时申请（`gallery` / `task`）
- `injects` → 要嵌进宿主界面时声明（三种 kind，见第 3 节；只有白名单里的三个 kind 会被认，重复的按 kind 去重）

### 加一个工具要动哪些地方

`tools/<id>/` + `lib/tools.ts` 的 `BUILTIN_TOOLS`（浏览器 demo 的清单）+ `tests/placeholder-tools.mjs` 的工具数 + `tests/tool-browser.mjs` 里「设置里列出了全部工具」的写死数字 + `tests/_run-all-e2e.mjs` 登记。有外部同源副本才加 `sync-tools.mjs` 的 `SOURCES`。

---

## 6. 工具箱：写 → 沙箱试跑 → 拿通行证 → 提交

内置助手能写整页工具，也能写注入组件（第 3 节）。两者走同一道门，而**这道门在宿主代码里，不在提示词里**——提示词只是概率，「我检查过了」不构成验证。

### 四步

| 步 | 动作 | 谁判 |
|---|---|---|
| 1 写 | 助手产出单文件 HTML，外加 id / name / schema / capabilities / injects | — |
| 2 试跑 | `sandbox_run`（不挂权限门、不需要桌面端） | `lib/agent/sandbox.ts` **真跑** |
| 3 拿票 | 通过才回一张 `ticket` | `lib/agent/verifier.ts` 签发 |
| 4 提交 | `install_tool` 带上票，`installFromHtml` 才落盘 | `lib/agent/actions.ts` 先验票 |

票是 **(id + html + schema + capabilities + injects) 的指纹**，TTL 30 分钟。源码改一个字符指纹就变，票当场作废。没有票、票不认识、票过期、票对不上，`install_tool` 一律直接回绝，根本进不到写盘那一步。

**提交时可以不带源码**：`install_tool` 的 `html` 是可选的，省略时装的正是第 2 步验过的那一份（`resolveTicket` 把票换成当时那份候选，schema / capabilities / injects 也一并跟着票走）。这不是图省事——模型很难两次输出一字不差的同一份 HTML，重抄一遍总会有个换行不一样，于是票永远对不上、助手卡在原地反复重跑（2026-09-24 真跑时就是这个原因没装上）。让"装的就是验过的那份"成为物理事实，既省掉一次重抄，也堵死了"验 A 装 B"。

指纹比对前会把源码**弄齐整**（去 BOM、CRLF 统一、去首尾空白）：这些差异不可能承载语义，不该让票作废。身体里任何一处内容改动照旧作废。

### 沙箱是真跑，不是静态扫描

iframe 的 `sandbox` 属性 = `allow-scripts allow-downloads allow-forms allow-modals`，**故意不给 `allow-same-origin`**：里面的代码碰不到宿主的 DOM、storage、cookie。

- **影子桥**：`row.*` / `kv.*` / `gallery.*` / `task.get` 全在内存里应答，记一笔"调过什么"，不落库、不真写图库。能力门与生产是**同一份判断**——图库关着时沙箱里照样回绝，免得出现"沙箱能过、装上去就废"。
- **探针**：注入一段脚本收集 `error` / `unhandledrejection` / `console.error` / `console.warn`，300 ms 后回报渲染节点数与文本长度，2 s 兜底收工。
- **报告**：跑了没有、有没有可见内容、报错清单、调过哪些桥操作、被回绝过哪些。

判定分两级：**空白页、JS 异常、桥被回绝**算 error，挡住出票；**网络类报错**只算 warn——沙箱里本来就没有网络，不能拿它当判据把好工具毙掉。

### 静态体检（真跑之前先过一遍）

`verifier.staticProblems` 拦的是"装上去注定不对"的那几类：

- **外链资源**：`script` / `link` / `img` / `iframe` 的 src，CSS 的 `url()` 与 `@import`。单文件工具不该依赖网络；`data:` / `blob:` / `#` 算内联，不拦；`<a href>` 也不拦（那是给人点的，不是加载资源）。
- **逃逸 iframe**：`parent.document` / `top.*` / `opener` / `localStorage` / `history` / `frameElement`。但 `parent.postMessage` 允许——那是它唯一合法的出口。
- **声明对不上**：用了 `row.*` 却没给 schema、用了 `gallery.*` 却没申请 `capabilities`、用了 `task.get` 却既不申请 `task` 也不声明 `injects`。
- **schema / id 本身不合法**：类型不在白名单、id 不合 `checkToolId`。

报告的判定和静态体检的结果合并成一份 `Verdict`：**只有 error 级的才挡**。warn 会回给助手看，但不影响出票——否则"没写 try/catch"这种也能卡住，助手就会为了让检查通过而删功能。

### 为什么票由宿主发

把「验证通过才准提交」写成一句提示词，等于把门禁交给概率。助手完全可能说"我验过了"然后直接调 `install_tool`。票是宿主算出来的、绑定源码指纹的一段字符串，助手只能转交、不能编造——伪造的票对不上指纹，当场回绝。

---

## 7. 数据：能碰什么，碰不到什么

### 两条边界

1. **工具永远碰不到 `core_*`**。它只发裸表名（`"records"`），宿主拼出 `tool_<id>_records`。是安全边界，不是约定。
2. **没有 SQL 通道**。只有结构化 CRUD：`row.select / insert / update / delete / count` 与 `kv.*`。理由写在 `toolBridge.ts` 文件头——一旦开了口子，"以后方便"就会变成"现在说不清它碰过什么"。

### 私有表的生命周期

| 环节 | 谁做 | 说明 |
|---|---|---|
| 声明 | 工具（manifest） | 表 / 列 / 索引，宿主校验后才建 |
| 建表 | 宿主 | `lib/toolSchema.ts`，列名类型全走白名单 |
| 版本 | 宿主 | `core_tool_schema` 记录上次建到哪个版本；改结构请 `dbVersion` +1 |
| 上限 | 宿主 | 一个工具 ≤12 张表、一表 ≤40 列、≤8 个索引 |
| 读写的列 | 宿主 | 只认 **schema 声明过**的列，传别的列名一律拒绝 |
| 卸载 | 用户 | **默认保留数据**（卸载是"我不用了"，不是"把历史抹掉"）；设置 → 数据库里可以手动清理 |
| 备份 | — | 私有表不进同步（那是本机私有的东西）。需要跨机就走 `kv` + 自己的导出 |

### 能力：跨扩展共享的东西要申请

判断标准：**这个东西是不是多个扩展都要用、又不属于任何一个扩展自己的**。图库符合（三个工具的产物都往里落、谁都能取），所以它是能力；便签本自己的表不符合，那是私有数据，走 `row`。

目前两项：`gallery`（图库模块提供）与 `task`（内核提供，只读当前任务，且只在注入上下文里给）。`CAPABILITY_OWNER` 记着谁提供它——能力的作用域来自**提供方**，不是申请方。

```
工具 manifest: capabilities: ["gallery"]
        ↓
宿主: capabilityState(settings, extId, "gallery")
        ↓
  "on"          放行
  "not-granted" 回绝：这个扩展没申请（去改 manifest）
  "unavailable" 回绝：提供它的模块没启用（去设置里开）
```

回绝是**结构化的返回，不是抛异常**——调用方要能据此降级，而不是弹一个"失败"了事。

图库关掉时，工具不要指望宿主替它想办法：拿不到 `gallery` 就把产物改成下载到本地，并在界面上说一句。**宿主不替扩展做决定**，这是整套能力的第三条边界。

---

## 8. 加一个模块：清单

1. `src/lib/extensions/registry.ts` 的 `BUILTIN` 里登记一条（id、名称、说明、`injects`、`capabilities`、`enabledByDefault`）。
2. 需要整页视图 → `views.ts` 的 `VIEW_COMPONENTS` 里加一行（键必须与 `injects` 里的 view id 一致，否则拿不到合法性判断）。
3. 默认关（选装）→ 同版加迁移回填（第 4 节），并跑 python 验证各路径。
4. 侧栏、设置页的选装列表、视图拦截**都不用改**——它们读注册表。
5. 测试：`special-orders.mjs` 第 0 节（先启用再验）是这类模块的模板；依赖它的套件用 `tests/_enable-module.mjs`。

## 9. 取舍记录

| 决定 | 为什么 |
|---|---|
| 不让扩展碰 `core_*`，不给 SQL 通道 | 边界写进物理实现，而不是靠约定；开一次口子就再也说不清它碰过什么 |
| 图库是能力而不是某个模块的私产 | 三个工具都要读写它，做成私有的话双向联动无从谈起 |
| 卸载工具默认保留数据 | 卸载是"我不用了"，装回来还要能接着看 |
| 注册表不 import 组件 | 避免 `store → registry → 组件 → store` 的环 |
| 迁移回填按"有没有用过" | 默认值管新库、迁移管老库、缺键按开兜底，三层合起来才不会让人丢东西 |
| 注入点先写进契约（哪怕还没挂载点） | 目的是阻止新的写死枚举；契约先立，实现后补 |
| 沙箱**真跑**而不是静态扫描 | 只看源码判断不了"它到底能不能起来"；真跑才知道有没有渲染、有没有报错 |
| 沙箱不给 `allow-same-origin` | 试跑的代码不该碰到宿主的 DOM / storage / cookie |
| 影子桥的能力门与生产同一份判断 | 否则会出现"沙箱能过、装上去就废" |
| 网络类报错只算警告 | 沙箱里没网络是沙箱的属性，不是工具的缺陷 |
| 通行证由宿主签发、绑定源码指纹 | 「验证通过才准提交」写进提示词只是概率；票只能转交，不能编造 |
| 只有 error 级挡住出票 | warn 也挡的话，助手会为了让检查通过而删功能 |

## 10. 这套东西怎么验

| 层 | 命令 |
|---|---|
| 类型检查 | `npm run typecheck` |
| 逻辑单测 | `npm run smoke` |
| 同步 / 助手 / 工具契约 | `npm run sync:test` / `agent:test` / `gomoku:test` |
| 浏览器 e2e | `node tests/_run-all-e2e.mjs` |
| 助手真写工具（Node 替身 Tauri） | `node scripts/agent-author.mjs --selftest --tools-root <临时目录>` |

工具箱那道门怎么验：

- `agent-unit.mjs` 第 10 节：静态体检的正反例、声明对账、报告判定、票的语义（稳定 / 改一个字符作废 / 伪造 / 过期）。
- `agent-sandbox.mjs`：浏览器里真跑一遍（干净源码出票、空白页不出票、无票提交被点名 `sandbox_run`、注入组件真的绑定上任务）。
- `agent-author.mjs --selftest`：Node 替身 Tauri，走完 `sandbox_run → ticket → install_tool`，确认工具目录里**真的多了一个**。

三条硬要求：

- **"默认没有入口"本身要有断言**（`gallery.mjs` 第 0 节、`placeholder-tools.mjs` 里特殊单号那条）。只验"开了之后对不对"，等于把选装这件事在测试里关掉了。
- **门禁要有"没有票就是不行"的断言**，而且断言的是**被拒的原因里点名了 `sandbox_run`**——只验"提交成功"的话，哪天把验票那行删了测试照样全绿。
- ⚠️ 沙箱里 `spawnSync` 会报 `EBUSY`，`_run-all-e2e.mjs` 会给出一批 `exit=null / 0.0s` 的**假红**（PITFALLS 七十五）。出现就改前台逐个跑套件，别去查套件代码。

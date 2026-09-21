# 云端总站可行性分析

> 针对「通过服务器判断用户、分发工单、同步数据」三项能力，基于当前 schema **v9** 的体检结论。
> 只做分析与方案，**未改动任何代码**。
> 体检时间：2026-09-20

---

## 0. 结论速览

| 能力 | 可行性 | 改造量 | 主要阻塞 |
|---|---|---|---|
| 服务器判断用户 | ✅ 可行 | 小（纯新增） | 数据层**零身份维度**；桌面端无任何登录入口；token 存放有坑 |
| 分发工单 | ✅ 可行 | 中 | 依赖身份；`core_work_orders` 无责任人字段；但状态机与留痕**已经齐了** |
| 数据同步 | ⚠️ 有条件可行 | 大 | `deleted` 无时间戳（墓碑不可排序）＋ 4 张表无 `updated_at` ＋ 附件在库外 ＋ 无 HTTP 通道 |

**一句话结论：能做，但云端不是"加个服务器"的事。数据层要先补三个维度 —— 身份、变更时间、墓碑时间。**
现在就硬上同步，结果一定是「多端互相覆盖、删掉的东西又活过来」。

---

## 1. 数据库体检（schema v9，13 张表）

`migrations.ts` 里 `CURRENT_SCHEMA_VERSION = 9`，v1→v9 全部追加。逐表看「能不能做增量同步」：

| 表 | 记录内容 | `updated_at` | `deleted` | 同步就绪度 |
|---|---|---|---|---|
| `core_lists` | 清单 | ✅ | ✅ | 好 |
| `core_tasks` | 待办 | ✅ | ✅ | 好 |
| `core_steps` | 子任务 | ❌ **无** | ❌（随任务删） | **差** |
| `core_settings` | 配置（key/value） | ❌ 无时间戳 | — | **差**（且混了本机偏好） |
| `core_task_links` | 待办关联（无向） | ❌ 无 | ❌ 无 | **差** |
| `core_tool_kv` | 工具私有 KV | ✅ | — | 中（本就不该上云） |
| `core_wo_flows` | 工单流程模板 | ✅ | ✅ | 好 |
| `core_wo_stages` | 流程的过程态 | ❌ 无 | ❌（随流程删） | 中（模板类，低频变） |
| `core_work_orders` | 工单（含特殊单号） | ✅ | ✅ | 好 |
| `core_wo_logs` | 流转留痕 | ❌ **无** | ❌（只追加） | 中（只追加，可用 created_at 当游标） |
| `core_wo_fields` | 工单自定义字段 | ✅ | ✅ | 好 |
| `core_wo_attachments` | 工单附件 | ❌ **无** | ✅ | **差** |
| `core_gallery_items` | 图库 | ❌ **无** | ✅ | **差** |

（`core_plan_items` 已下线，表保留；`tool_special_orders_records` 已在 v8 删除。）

### 四个硬伤

**① 全库没有身份维度。**
对 `repo.ts`（2522 行，全部写路径）grep `user|owner|assignee|member|userId|deviceId` → **零命中**。
`types.ts` 里 `Task` / `WorkOrder` / `GalleryItem` 也没有任何一个归属字段。
这不是"少个字段"，是**整个数据模型没有"这份数据是谁的"这个概念**。多用户/多端是**新增维度**，不是补丁。

**② `deleted` 是没有时间戳的裸标志（最硬的一条）。**
所有表都是 `deleted INTEGER NOT NULL DEFAULT 0`。删一条记录只把 0 改成 1，
**没有任何一行记录"它是什么时候被删的"**。
增量同步靠「给我 updated_at > 上次游标的所有变更」来拉增量 —— 删除操作改了 `deleted` 但**不一定改 `updated_at`**，
就算改了，客户端拉到之后也只知道"现在是已删"，**不知道该把这条墓碑放在游标的哪个位置**。
后果：A 端删了，B 端永远拉不到这条删除，或者拉到了却已经越过游标 → **删掉的东西又活过来**。
必须补 `deleted_at`（墓碑时间戳），这是同步的地基。

**③ 4 张表压根没有 `updated_at`。**
`core_steps` / `core_wo_attachments` / `core_gallery_items` 三张表的写入模式是「只追加 + 改 deleted」，
改了什么都不留痕；`core_wo_logs` 只追加（可以用 `created_at` 当游标，勉强可用）。
没有 `updated_at` 就没有增量游标 → 这几张表只能全量比对，数据一大就废。

**④ 所有 ID 由客户端生成。**
`repo.ts` 用 `crypto.randomUUID()`，`gallery.ts` 用**时间有序 ID**（同毫秒靠 `id DESC` 定序）。
- 好处：离线可写、UUID 天然全局唯一，跨端合并不会撞主键 → **这个设计其实很适合同步，别改**。
- 坏处：`sort_order` 是**纯本地语义**。两端同时拖排序，合并后顺序必然互相踩。
  排序冲突只能靠「整组重排 + 服务端定序」解决，或者接受 last-write-wins。

### 次要问题

**⑤ `core_settings` 不能整体同步。**
它是裸 key/value，里面既有账号级偏好（`urgent.thresholdMinutes`），
又有设备级偏好（面板宽度这类"可调的量"）。
整表同步会把一台机器的面板宽度推到所有机器上。同步前**必须先给 key 做一次归属分类**。
它也没有时间戳，同样要补。

**⑥ 附件与图库的文件在 SQLite 之外。**
`$APPDATA/attachments/<月>/<hash8>-<标题>.ext`，内容寻址，图库与工单附件**共用同一个池**，
`refCountByHash` 跨两张表数引用。
只同步元数据不同步文件 = 客户端拿到一堆打不开的坏引用。文件必须走**独立的二进制通道**。
好消息：`hash` 天然就是同步键（同内容跳过，与图库 dedupe 同一套思路）。
⚠️ 别拿 `rel_path` 当同步键 —— 它带标题，同内容不同标题本来就是两个路径。

**⑦ 现有 `importBackup` 是"覆盖"不是"合并"。**
`importBackup()` 先 DELETE 掉所有核心表再全量插入。
它的语义和"同步"完全不同，**不能拿来当同步的底座**；真要做合并得另写一套冲突规则。

---

## 2. 三项能力逐个分析

### 2.1 服务器判断用户 —— ✅ 可行，改造量最小

现状：零登录代码、零 token 存储、零身份字段。全部是新增，没有历史包袱要推翻。

**要做的：**

1. **传输通道**：`capabilities/default.json` 里**没有 http 权限**（只有 core/default、window、sql、fs、dialog、process、updater）。
   但 `tauri.conf.json` 的 CSP `connect-src` 里**有 `https:`**，所以前端 `fetch` 不会被 CSP 拦。
   - 方案一：前端 fetch —— 受 CORS / 证书 / 混内容限制，且要放宽 CSP，不推荐。
   - 方案二（推荐）：**Rust 侧直接用 `reqwest`**。`Cargo.toml` 里已经有它（`attachments.rs` 正在用它下载附件），
     只需新增 `#[tauri::command]` 并在 `lib.rs` 的 `invoke_handler` 注册。
     **不用装插件、不用改 CSP、不受权限 scope 限制。**
2. **客户端登录入口**：现在 UI 上完全没有"账号"区，设置页要新增。
3. **token 存放 —— 有个坑**：
   `exportBackup()` 会把 `core_settings` **整表导出**。token 若存在 settings 里，用户导出一次备份，
   凭据就明文躺进备份文件了。
   → token **不能进 `core_settings`**，也不能进 `BackupPayload`。建议 OS 钥匙串（keyring 插件）或 `$APPDATA` 下的独立小文件。
4. **服务端**：账号体系 + 下发 `user_id` / `tenant_id`，客户端存下来，后续所有请求带上。

判断：**纯新增，风险最低，可以作为第一步单独上线。**

### 2.2 分发工单 —— ✅ 可行，模型其实很趁手

现状盘点：`core_work_orders` 已经有 —— 流程模板（flows/stages）、当前过程态（`stage_id`）、
时效（`stage_due_at`，特殊单号专用）、流转留痕（`core_wo_logs`，`moveOrderToStage` 是唯一出口且在事务内写日志）、
自定义字段（`core_wo_fields`）、终态（多终态，`closed` 派生）。

**派单需要的三件事里，前两件已经完整存在：**
- 状态机 ✅（流程 + 过程态 + 唯一改态出口 + 留痕）
- 留痕 ✅（`core_wo_logs` 记 from/to/时间/备注）
- 责任人 ❌ **缺**

所以"分发工单"的增量比我预想的小 —— 主要是**加两个字段 + 服务端派单逻辑**：

```sql
-- v10 草案（示意，迁移只追加）
ALTER TABLE core_work_orders ADD COLUMN owner_id    TEXT;  -- 归属：这是谁的单
ALTER TABLE core_work_orders ADD COLUMN assignee_id TEXT;  -- 当前处理人
```

**要注意的三处：**

1. **字段权威方要分区，否则两端打架。**
   建议：`stage_id` / `assignee_id` / `stage_due_at` → **服务端权威**；`note` / 附件 / 自定义字段 → **本地可写，走 outbox 提交**。
   两端都能改 stage 的话，必然出现来回覆盖。
2. **特殊单号的时效不能绕过 `moveOrderToStage`。**
   `stage_due_at` 是「绝对时刻 + 推进时按目标步 `default_minutes` 重设」。
   服务端派单/改态时**必须走同一套语义**，否则会漂移成"stage 变了但时效没重算"。
3. **"派给我的"视图**：`fetchWorkOrders` / `rows.ts` 的分支要加一条（历史教训：工单专属视图和 special 视图
   都要求 `fetchTasks` 分支显式 `return []` + `rows.ts` 的 `done` 置空，**两处漏一处就会串数据**）。

### 2.3 数据同步 —— ⚠️ 能做，但必须先补地基

先看三条路：

| 方案 | 做法 | 代价 | 结论 |
|---|---|---|---|
| A 全量覆盖 | 复用 `importBackup` 语义 | 零改造 | ❌ **多端必丢数据**，等于没有同步 |
| B 增量拉取 | `updated_at` 游标 + 墓碑 | 补 `deleted_at`、给 4 张表补 `updated_at`、全量回填 | ✅ **推荐起步** |
| C 操作日志 | 新建 `core_sync_outbox`，每个写路径插桩 | 给 `repo.ts` 2500 行里几十个写点全部插桩 | 最稳，成本最高；B 撑不住时局部升级 |

**推荐 B 起步**：同步最怕的不是慢，是"改了没记下来"。`updated_at` + `deleted_at` 两列就能覆盖 90% 场景。

**v10 需要补的地基（示意）：**

```sql
-- 1. 墓碑时间戳（同步的地基，没有它一切免谈）
ALTER TABLE core_tasks            ADD COLUMN deleted_at TEXT;
ALTER TABLE core_lists            ADD COLUMN deleted_at TEXT;
ALTER TABLE core_work_orders      ADD COLUMN deleted_at TEXT;
ALTER TABLE core_wo_fields        ADD COLUMN deleted_at TEXT;
ALTER TABLE core_wo_attachments   ADD COLUMN deleted_at TEXT;
ALTER TABLE core_gallery_items    ADD COLUMN deleted_at TEXT;

-- 2. 给"改了不留痕"的四张表补 updated_at
ALTER TABLE core_steps            ADD COLUMN updated_at TEXT;
ALTER TABLE core_wo_attachments   ADD COLUMN updated_at TEXT;
ALTER TABLE core_gallery_items    ADD COLUMN updated_at TEXT;
-- core_wo_logs 只追加，用 at / created_at 当游标即可，可不补

-- 3. 同步水位
CREATE TABLE IF NOT EXISTS core_sync_state (
  scope     TEXT PRIMARY KEY,   -- 'work_orders' / 'tasks' / 'gallery' ...
  cursor    TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
```

**回填策略**：NULL 的 `updated_at` 填成 `created_at`，`deleted_at` 填成一个"纪元前"值。
这样老数据会被当成"很久以前的变更"自然推一遍，安全且幂等。

**另外三件必须一起做：**

1. **`core_settings` 先做归属分类**（账号级 / 设备级），再决定哪些 key 参与同步。
2. **附件与图库走独立二进制通道**：按 `hash` 上传/下载，服务端存对象存储，同 hash 直接跳过。
   引用计数是**跨表**算的，同步时别只看单张表就判定"没人引用可以删文件"。
3. **首次接入要给明确选择**：现在库里已有本地数据，登录时必须让用户选
   **「以本地为准推上去 / 以云端为准拉下来 / 合并」**，不能自动合并。
   （`importBackup` 那种覆盖语义在多端场景下就是数据事故。）

---

## 3. 传输与部署

- **通道**：无 http 插件 → 用 Rust 侧已有的 `reqwest` 加命令即可，不用装插件、不用动 CSP。
- **定时同步**：前端 `setInterval` 或 Tauri 后台任务；离线期间写操作入 outbox，联网后再提交。
- **服务器**：`tauri.conf.json` 的 updater endpoint 目前还是占位符
  `https://your-host.example.com/todo-workbench/update.json` —— 正好可以同一台机器复用。
- **隐私**：原设计明确「数据仅本机」。上云必须**明示 + 默认关闭 + 用户主动开启**，
  否则与产品定位冲突。
- **合规**：一旦真有服务端用户数据，就涉及个人信息存储，域名/备案/隐私政策都要跟上。

---

## 4. 建议路线（每阶段可独立交付）

| 阶段 | 内容 | 依赖 | 风险 |
|---|---|---|---|
| **P0** | 身份：Rust 加 login/whoami 命令；设置页「账号」区；token 不入备份 | 无 | 低 |
| **P1** | 工单派发：v10 加 `owner_id`/`assignee_id`；服务端派单；客户端「派给我的」视图 | P0 | 低（**先只读，不碰同步**） |
| **P2** | 单向同步（仅工单域）：工单 + 日志 + 自定义字段，附件暂不同步 | P1 | 中 |
| **P3** | 补 `updated_at`/`deleted_at` + 全量同步 + 附件/图库文件通道 | P2 | 中高（要回填历史数据） |
| **P4** | 待办与图库同步（排序冲突最集中，放最后） | P3 | 高 |

**推荐从 P0 + P1 起步**：这两步就能拿到"服务器判断用户 + 分发工单"的完整价值，
却完全不用动同步这块硬骨头。等真的跑起来、确认派单流程顺手了，再决定要不要投入 P2~P4。

---

## 5. 如果只记三句话

1. **身份是新增维度，不是补丁** —— 全库零 user/owner/assignee，多用户要整体引入。
2. **`deleted_at` 是同步的地基** —— 现在的裸 `deleted` 标志让删除操作无法增量同步，不补就一定出"删了又活"。
3. **先做 P0+P1，别一上来做同步** —— 派单的价值能独立拿到，同步的成本可以后付。

# 云端总站技术方案（待审查）

> 承接 `cloud-station-feasibility.md`。这份是「假设要做」的具体做法：**改哪些文件、每个文件怎么改、按什么顺序做**。
> 现状基准：schema **v9**，桌面 Tauri 2 / 浏览器 demo 双驱动。
>
> ⚠️ 本文含一处对上一版报告的**修正**，见 §1.2。

---

## 1. 先说三件会影响你判断的事

### 1.1 范围：只同步工单域，待办不上云

| 域 | 上云? | 理由 |
|---|---|---|
| 工单（work_orders / wo_fields / wo_logs / wo_attachments） | ✅ | 分发的载体，多端协作的主战场 |
| 图库（gallery_items） | ✅（P3） | 内容寻址，hash 天然是同步键，同步成本最低 |
| 待办（tasks / lists / steps / links） | ❌ 暂不 | 纯私人、量最大、`sort_order` 冲突最集中，收益最低 |
| 配置（core_settings） | ❌ | 混了面板宽度这类设备级偏好，要先做归属分类 |

把同步域收窄到 3~4 张表，是这份方案能保持"低侵入"的前提。
真要把待办也搬上去，是 §6 的 P4，另开一轮评估。

### 1.2 修正：真正的阻塞是「改了不留痕」，不是「删了没墓碑」

上一版报告写「`deleted_at` 是同步的地基，不加就一定删了又活」——**这句话说过头了**。逐处核对后的事实是：

**软删除几乎都会顺手 bump `updated_at`**（`core_lists` / `core_tasks` / `core_wo_flows` / `core_work_orders` / `core_wo_fields` 全部如此，见 repo.ts:153、350、807、1459、1554）。
→ 这 5 张表的删除**本来就能**被增量同步到，不需要额外加 `deleted_at`。

**真正的盲区是「可修改但没有 `updated_at` 列」**，而且只集中在 3 张表：

| 表 | 有 updated_at | 可改吗 | 实际写路径 | 结论 |
|---|---|---|---|---|
| `core_steps` | ❌ | ✅ | `updateStep`（改 done/title） | 改了无痕；`deleteStep` 是**硬删除**（`DELETE FROM`），连墓碑都没有 |
| `core_wo_attachments` | ❌ | ✅ | `updateAttachment`（改标题/尺寸/探测值） | 改了无痕 |
| `core_gallery_items` | ❌ | ✅ | `updateGalleryItem`（改标题/备注/尺寸）；`deleteGalleryItem` 只做 `SET deleted = 1`，**连时间戳都不动** | 改与删都完全无痕 |
| `core_wo_logs` | ❌ | 只追加 | — | 用已有的 `at` 列当游标即可，**不是问题** |

所以 v10 必须补的是这三张表的 `updated_at`，并且**在写路径里真的写上它**。
`deleted_at` 降级为「可选加固」（见 §2.2 备注），不作为地基。

### 1.3 三个已有的、正好能借用的东西

- **`reqwest` 已经在依赖里**（Cargo.toml:31，`attachments.rs` 正在用它下载附件）→ 传输层不用装插件、不用改 CSP。
- **ID 全客户端生成**（`crypto.randomUUID()` / gallery 的时间有序 ID）→ 跨端合并不会撞主键，**这个设计天然适合同步，别动它**。
- **附件与图库共用同一个内容寻址仓库**，`hash` 是内容指纹 → 二进制同步直接拿 hash 当键，同内容自动跳过。

---

## 2. 数据层：v10 迁移

### 2.1 迁移 SQL（`src/lib/migrations.ts`，追加 version 10）

```sql
-- v10: 云端同步地基

-- 1) 三张「改了不留痕」的表补上 updated_at
ALTER TABLE core_steps          ADD COLUMN updated_at TEXT;
ALTER TABLE core_wo_attachments ADD COLUMN updated_at TEXT;
ALTER TABLE core_gallery_items  ADD COLUMN updated_at TEXT;

-- 2) 工单的责任人（分发的载体）
ALTER TABLE core_work_orders    ADD COLUMN owner_id    TEXT;
ALTER TABLE core_work_orders    ADD COLUMN assignee_id TEXT;

-- 3) 同步水位
CREATE TABLE IF NOT EXISTS core_sync_state (
  scope        TEXT PRIMARY KEY,   -- 'work_orders' | 'wo_fields' | 'wo_attachments' | 'gallery'
  cursor       TEXT NOT NULL DEFAULT '',
  last_sync_at TEXT,
  updated_at   TEXT NOT NULL
);
```

**约束**：迁移只追加，不删不改（项目铁律）。v10 全是 `ADD COLUMN` + `CREATE TABLE IF NOT EXISTS`，老客户端升级后新列被忽略也能正常跑。

### 2.2 ⚠️ 两个必须在写代码时记住的坑

**坑一：`ALTER TABLE` 在浏览器 demo 里是静默 no-op。**
`lib/db.ts` 的 `MemoryDb.run()`（db.ts:96-163）只认 CREATE TABLE / CREATE INDEX / PRAGMA / INSERT / UPDATE / DELETE，
**没有 ALTER 分支** → 直接落到 `return 0`，一声不响什么都不做。
后果：新加的列在 localStorage 版 demo 里读出来是 `undefined`。

处理办法照抄 v2 的先例 —— 当时 `ALTER TABLE core_tasks ADD COLUMN repeat` 就是这么过来的，
repo.ts:85 写的是 `repeat: (r.repeat as Repeat) ?? "none"`。
**所有读新列的地方一律 `?? `兜底**，具体见 §3.2 的表。

**坑二：不要给 `reqwest` 加 feature。**
Cargo.toml:25-35 有注释说明：reqwest / rustls / ring 的 feature 是**刻意与 updater 对齐**的，
为了复用已编译产物。一旦加 `features = ["json"]` 之类，feature 不一致会触发整条依赖树重编
（rustls 换 provider 还会连带编译需要 cmake/nasm 的 aws-lc-rs）。
→ **JSON 用 `serde_json::to_vec()` + 原始 body 手写**，不用 reqwest 的 `.json()`。

**备注（可选加固）**：`deleted_at` 仍建议加，但它解决的是另一个问题 ——
「删除必须顺手 bump `updated_at`」这条约定现在成立，却没有任何东西保证它一直成立
（今天图库的 `deleteGalleryItem` 就已经坏了这条约定）。加了它，"删除"就是一件独立可查的事实。
建议放在 P3 顺手加，不单独占一个版本。

---

## 3. 逐文件改动清单

### 3.1 新增文件

| 文件 | 作用 | 要点 |
|---|---|---|
| `src-tauri/src/cloud.rs` | Rust 侧 HTTP 客户端与全部云命令 | 见 §4 |
| `src/lib/cloud.ts` | 前端门面：一套接口两个实现 | 照 `lib/attachments.ts` 的套路（同文件顶部有对照表）。桌面走 `invoke("cloud_*")`；**浏览器 demo 一律返回 `{ available: false }`** —— 没有 Rust、库在 localStorage，demo 不做同步 |
| `src/lib/sync.ts` | 同步引擎：摘要交换、冲突规则、水位 | **冲突规则与摘要构造做成纯函数**，不碰 IO，这样能进 smoke 单测（见 §7） |
| `src/components/CloudSection.tsx` | 设置页「账号与同步」分区 | 复用 `Settings.tsx` 里现成的 `SectionTitle` / `Card` / `FieldRow` / `Switch` / `ActionButton`（都在文件尾部 945-1060 行） |
| `tests/cloud.mjs` | 浏览器 e2e | 只能测 UI 层（分区渲染、未登录态、demo 下禁用提示）。**真正的同步跑不进浏览器 e2e**，见 §7 |
| `scripts/check-sync-timestamps.mjs` | 门禁脚本 | 扫 `repo.ts` / `gallery.ts`，凡是 `UPDATE core_steps / core_wo_attachments / core_gallery_items ... SET` 里不含 `updated_at` 的语句直接报错。这才能防住"以后新写的更新路径又忘了留痕" |
| `server/` | 服务端（独立项目，不在 main 里） | 见 §5 |

### 3.2 修改文件

| 文件 | 改什么 | 具体位置与写法 |
|---|---|---|
| `src/lib/migrations.ts` | 追加 v10 | `migrations` 数组末尾，`version: 10, name: "add_sync_foundation"` |
| `src/lib/repo.ts` | ① 三处补留痕 | `updateStep`(551)、`updateAttachment`(1896)、`updateGalleryItem` 各自在 `sets` 里 push `updated_at = ?` 并补参数 |
| `src/lib/gallery.ts` | ② 删除补留痕 | `deleteGalleryItem`(397) 的 `UPDATE ... SET deleted = 1` 改成 `SET deleted = 1, updated_at = ?`。**这是当前唯一一处"删了连时间戳都不动"的地方** |
| `src/lib/repo.ts` | ③ 读新列兜底 | `toWorkOrder` 加 `ownerId: r.owner_id ?? null`、`assigneeId: r.assignee_id ?? null`（照 repo.ts:85 的 `?? `先例，防 MemoryDb 下 ALTER 失效） |
| `src/lib/gallery.ts` | ④ 同上 | `RawGallery` 加 `updated_at?: string`，`toGalleryItem` 用 `?? null` 兜底 |
| `src/types.ts` | 类型 | `WorkOrder` 加 `ownerId?: string \| null`、`assigneeId?: string \| null`；新增 `CloudAccount`、`SyncScope`、`SyncDigest` 类型 |
| `src/lib/settings.ts` | 配置键 | `SETTINGS` 加 `cloudEnabled: "cloud.enabled"`、`cloudBaseUrl: "cloud.baseUrl"`、`cloudUser: "cloud.user"`。**注意**：这些 key 会被 `exportBackup` 带走，可接受（不是凭据）；`cloud.user` 只存显示名 |
| `src/store.ts` | 状态与方法 | 新增 `cloud: CloudState`（`available / signedIn / user / syncing / lastError / lastSyncAt`）+ `syncNow()` + `cloudSignIn()` / `cloudSignOut()`。`init()`(335) 末尾 fire-and-forget 拉一次状态；`refresh()`(375) **不动** |
| `src/components/Settings.tsx` | 加分区 | ① `NAV`(57) 加 `{ key: "cloud", label: "账号与同步", icon: Cloud }`；② 渲染区(255-286) 加 `{section === "cloud" && <CloudSection ... />}` |
| `src/lib/rows.ts` | 「派给我的」 | **不加 SmartView 枚举值**（那要动 types / settings STARTUP_VIEWS / Sidebar / App 四处）。改为在 orders 视图上加一个筛选态：store 里存 `orderAssigneeFilter`，`groupRows` 里按它过滤 |
| `src/components/OrderDetail.tsx` | 责任人 | 加一行「责任人」（未接入云端时 `disabled` + 标「待接入」，项目规矩：不写假按钮）；已接入时下拉选人并调派发 |
| `src/components/OrderCreateDialog.tsx` | 建单指派 | 建单弹窗加可选「指派给」；`createWorkOrder` 入参带 `assigneeId` |
| `src-tauri/src/lib.rs` | 注册命令 | 加 `mod cloud;`(14 附近)；`invoke_handler`(127) 里追加入口 |
| `src-tauri/tauri.conf.json` | （可选） | updater endpoint 还是占位符 `https://your-host.example.com/...`(65)，可换成真域名复用同一台机器。**CSP 不用改** —— Rust 侧发请求不走 webview 的 CSP |
| `src-tauri/capabilities/default.json` | **不用改** | token 走 Rust `std::fs` 读写 `$APPDATA/cloud.json`，绕过权限系统（和 `attachments.rs` 写文件同一个路子）。这也是为什么**不把 token 放 `core_settings`** —— 见 §4.3 |
| `tests/_run-all-e2e.mjs` | 注册套件 | `SUITES`(9) 加 `["cloud.mjs", []]` |

---

## 4. Rust 侧：`src-tauri/src/cloud.rs`

### 4.1 命令清单

```rust
cloud_login(base_url, email, password) -> CloudSession   // 返回 token + user_id + device_id
cloud_status()                         -> Option<CloudAccount>
cloud_logout()                         -> ()
cloud_exchange(scope, digests)         -> ExchangeResult  // 摘要交换
cloud_push(scope, rows)                -> PushResult
cloud_pull(scope, ids)                 -> Vec<Row>
cloud_members()                        -> Vec<Member>     // 派单人选
cloud_dispatch(order_id, assignee_id)  -> Order
cloud_blob_head(hash)                  -> bool            // 服务端是否已有这个 blob
cloud_blob_put(hash, rel_path)         -> ()              // 从本地仓库读文件上传
cloud_blob_get(hash, title)            -> String          // 下载并写回本地仓库，返回 rel_path
```

### 4.2 三个必须照做的细节

1. **rustls provider 要先装一次**，否则握手失败。照抄 `attachments.rs:512-517`：
   ```rust
   if rustls::crypto::CryptoProvider::get_default().is_none() {
       let _ = rustls::crypto::ring::default_provider().install_default();
   }
   ```
2. **不要用 reqwest 的 `.json()`**（没开 json feature，也不该开）。用 `serde_json::to_vec(&body)` + `.body(bytes)` + 手动塞 `Content-Type: application/json`。
3. **`base_url` 必须校验 scheme 只允许 https**（或显式允许 http 用于本地调试），照 `attachment_download` 里那段 `match parsed.scheme()` 的写法。

### 4.3 token 存放

写 `$APPDATA/cloud.json`，Rust `std::fs` 直接读写，**不动 capabilities**。

**为什么不放 `core_settings`**：`repo.exportBackup()` 会把 `core_settings` 整表导出。
用户导出一次备份，凭据就明文躺进备份文件了。同理也不进 `BackupPayload`。

---

## 5. 服务端：`server/`（独立项目）

### 5.1 表结构（建议 PostgreSQL —— 服务端有多端并发写）

```sql
users(id, email, name, password_hash, created_at)
devices(id PK, user_id, name, last_seen_at, created_at)   -- device_id 由客户端生成并上报

work_orders(...)      -- 镜像 core_work_orders 全部列
                      -- + owner_id, assignee_id, deleted, deleted_at, updated_at
                      -- 索引 (owner_id, updated_at) / (assignee_id, updated_at)
wo_fields(...)        -- 镜像 + updated_at + deleted
wo_attachments(...)   -- 镜像 + updated_at + deleted
gallery_items(...)    -- 镜像 + updated_at + deleted
blobs(hash PK, size_bytes, mime, storage_path, created_at)  -- 内容寻址，与客户端同一套 hash
```

### 5.2 API

```
POST /v1/auth/login      {email, password}              -> {token, user_id, device_id}
POST /v1/auth/refresh    {token}                        -> {token}
GET  /v1/me                                             -> {user, device}
GET  /v1/members                                        -> [{id, name}]        派单人选

POST /v1/sync/exchange   {scope, digests:[{id,ua,del}]} -> {want:[id], give:[row], cursor}
POST /v1/sync/push       {scope, rows:[row]}            -> {applied}
POST /v1/sync/pull       {scope, ids:[id]}              -> {rows:[row]}

POST /v1/orders/dispatch {order_id, assignee_id}        -> order

PUT  /v1/blobs/:hash     二进制                          -> 201 / 200(已存在)
HEAD /v1/blobs/:hash                                    -> 200 / 404
GET  /v1/blobs/:hash                                    -> 二进制
```

登录方式建议**邮箱 + 密码**起步。桌面应用做 OAuth 回调很别扭（要开本地端口或走深链），
真需要无密码登录时再加「设备码」：客户端拿 code 轮询，用户在手机/浏览器上确认。

---

## 6. 同步协议

### 6.1 为什么不做 op-log

`repo.ts` 有 67 个导出函数，其中约 35 个是写路径。逐个插桩写 `core_sync_outbox` 成本高、漏一个就是静默丢数据。

但这个库是**个人工作台规模**（几百到几千条工单），全表扫一次 `SELECT id, updated_at, deleted`
只要几毫秒。所以采用**摘要交换**：

```
1. 客户端  SELECT id, updated_at, deleted FROM <同步域表>
2. →  POST /v1/sync/exchange {scope, digests:[{id, ua, del}]}
3. 服务端比对：
     - 服务端没有 / 服务端 ua < 客户端 ua  →  want[]（要客户端上传完整行）
     - 服务端 ua > 客户端 ua              →  give[]（直接下发完整行）
     - 一致                                →  跳过
4. ←  {want:[ids], give:[rows], cursor}
5. 客户端上传 want 的完整行；把 give 的行 upsert 到本地
6. 写 core_sync_state.cursor
```

**零插桩**，而且天然幂等。

### 6.2 冲突规则（写进 `sync.ts` 的纯函数，可单测）

1. `updated_at` **大者胜**（字符串比较，ISO 8601 UTC 单调）。
2. 完全相等 → **服务端胜**（保证两端收敛，不会来回抖）。
3. 删除优先：远端 `deleted=1` 且 `ua ≥ 本地 ua` → 本地置删除，**墓碑不复活**。
4. **回环防护（关键）**：拉下来的行 upsert 时**必须沿用远端的 `updated_at` 原值**，绝不能重新生成时间戳。
   否则每次同步都把本地 ua 推到更晚，下次 exchange 又被判定成"本地更新" → 两端无限互相推。
5. 游标：存 `max(updated_at)`，下次查询用 `>=` 而不是 `>`。
   最多重复拉一条（upsert 幂等，无害），但不会漏掉同一毫秒改的另一条。

### 6.3 二进制同步

只同步元数据会拿到一堆打不开的坏引用，所以文件要单独走一条通道：
上传前先 `HEAD /v1/blobs/:hash` 问一句，有了就跳过（内容寻址的好处）。
**别拿 `rel_path` 当同步键** —— 它是 `<月>/<hash8>-<标题>`，带标题，同内容不同标题本来就是两个路径。

### 6.4 首次接入必须让用户选

现在库里已有本地数据，登录时弹一次三选一：**以本地为准推上去 / 以云端为准拉下来 / 两边合并**。
绝不自动合并 —— 现有 `importBackup()` 的语义是"覆盖"（先 DELETE 全部再插），
在多端场景下自动跑它就是数据事故。

---

## 7. 测试策略（诚实版）

| 层 | 怎么测 | 能测到什么 |
|---|---|---|
| `sync.ts` 纯函数 | smoke 单测（现 396 项） | 冲突规则、墓碑不复活、游标边界、摘要构造 |
| `CloudSection` UI | `tests/cloud.mjs`（浏览器 e2e） | 分区渲染、未登录态、demo 下禁用提示、开关落库 |
| 真实同步 | **跑不进浏览器 e2e** | 浏览器 demo 是 MemoryDb + 无 Rust，同步在 demo 里本就不启用 |
| 真实同步 | 实机 `tests/desktop-app.mjs` + 一个 mock server | 端到端；或手工验收 |

→ 所以 `sync.ts` 必须做成"纯函数 + IO 分离"，否则这块逻辑没有任何自动化测试能覆盖。

门禁：`scripts/check-sync-timestamps.mjs` 建议并进 `build-desktop.mjs`
（现已有 `check-installer`(21) 与 `wallpapers`(44) 两道门禁，风格一致）。

---

## 8. 实施顺序

| 阶段 | 涉及文件 | 验收标准 |
|---|---|---|
| **P0 传输与身份** | 新增 `cloud.rs` / `cloud.ts`；改 `lib.rs`、`Settings.tsx`(NAV)、新增 `CloudSection.tsx`、`settings.ts`、`store.ts` | 桌面版能登录、`/v1/me` 返回用户、token 落 `$APPDATA/cloud.json`、**导出备份里搜不到 token**、demo 下分区提示"桌面版可用" |
| **P1 分发工单** | `migrations.ts`(v10 只加 owner/assignee 两列)、`repo.ts`(读+兜底)、`types.ts`、`rows.ts`、`OrderDetail.tsx`、`OrderCreateDialog.tsx` | 能派单、目标端 pull 后出现在「派给我的」、**不改 `stage_id` 的现有路径**、特殊单号的时效仍由 `moveOrderToStage` 重算 |
| **P2 工单域同步** | `migrations.ts`(补 updated_at + sync_state)、`repo.ts`+`gallery.ts`(补留痕)、`sync.ts`、门禁脚本 | 两端工单/字段/日志一致；A 删 B 也能删；断网可用、联网追平 |
| **P3 图库与附件** | blob 通道、按 hash 同步 | 图在另一台机器能打开；同内容不重复上传 |
| **P4 待办（另议）** | 需要给 `core_steps` 加 `deleted` 列（现在是硬删除） | 排序冲突方案先定 |

**P0 与 P1 完全不碰同步**，可以独立交付、独立回滚。建议先做这两步。

---

## 9. 请你拍板的 6 件事

1. **同步域**：接受"只同步工单 + 图库，待办不上云"吗？（§1.1）
2. **服务端栈**：PostgreSQL（推荐，多端并发写）还是先 SQLite 单进程起步？
3. **登录方式**：邮箱+密码起步（推荐，桌面端做 OAuth 很别扭），还是直接上设备码？
4. **冲突规则**：接受 LWW（时间戳大者胜）吗？工单有没有"绝不能被覆盖"的字段？（§6.2）
5. **文件上云**：图库与附件的图片/视频要不要真的传到服务器？（带宽与存储成本，也是合规敏感项）
6. **隐私**：原设计是「数据仅本机」。确认改成**默认关闭、用户主动开启**吗？

---

## 10. 已知风险与回滚

- **默认关闭**：`cloud.enabled` 默认 `"0"`，不登录时本地行为与今天完全一致。
- **服务端挂了不影响使用**：所有云操作失败都只提示，不阻断本地功能（沿用"存档失败不翻成导出失败"那条纪律）。
- **迁移可回滚**：v10 只有 `ADD COLUMN` 与 `CREATE TABLE`，迁移只追加，老客户端升级后新列被忽略也能跑。方案废弃时 v11 不动它即可。
- **最大的静默风险**：新写的更新路径忘了 bump `updated_at` → 数据悄悄不同步、没有任何报错。这道防线靠 `check-sync-timestamps.mjs` 守，建议 P2 同期就上。

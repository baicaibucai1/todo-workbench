# 待办工作台

以 Microsoft To Do 为原型的 Windows 桌面应用，但定位不止于待办——
它是一个**可扩展的工作台**：待办是核心模块，流程任务、特殊单号、图片工具等作为独立模块插入，
全部共用同一个本地数据库。

> 我们的生命都相当无序甚至是荒谬，也许这款应用能帮您从中构建部分的秩序。

作者：**Sogapopo**

> **当前版本：`v0.2.0`** —— [**下载安装包**](https://github.com/baicaibucai1/todo-workbench/releases/latest)
> （**7.3 MB**，Windows x64）。桌面版已打包成功、实机跑通，采用 GNU 工具链
> （MSYS2 + MinGW-w64），**全程不需要管理员权限，也不需要 2–4 GB 的 Visual Studio**。
>
> **安装包里不再附带任何工具。** 上一版是 62.9 MB，其中 50.8 MB 是图片工具那份本地
> AI 模型 —— 为一个多半用不上的能力，让每个用户、每次更新都多下几十兆。现在工具作为
> Release 上的一份**独立资产**（`todo-workbench-tools_0.2.0.zip`，29.6 MB）提供：
> 想要就下载解压，不想装就一个都不占。宿主本体因此回到 7 MB 量级。

---

## 界面速览

> 截图均为内置演示数据（浏览器演示库自动生成），非真实业务数据。

| 我的一天 · 紧急区 + 常驻详情面板 | 全部 · 待办与流程任务混排 |
| --- | --- |
| ![我的一天](docs/screenshots/my-day.png) | ![全部](docs/screenshots/all-tasks.png) |

| 流程任务视图 | 流程任务详情 · 过程态流转留痕 |
| --- | --- |
| ![流程任务](docs/screenshots/orders.png) | ![流程任务详情](docs/screenshots/order-detail.png) |

| 特殊单号 · 时效倒计时 | 图库 |
| --- | --- |
| ![特殊单号](docs/screenshots/special-orders.png) | ![图库](docs/screenshots/gallery.png) |

| 侧边栏紧急区（剩余时间不足自动聚合） | 左右面板宽度可拖拽 |
| --- | --- |
| ![紧急区](docs/screenshots/urgent.png) | ![面板拖宽](docs/screenshots/resizable-panels.png) |

| 设置 · 工具（启用停用 / 安装卸载 / 导入单文件） | 设置 · 关于 |
| --- | --- |
| ![设置 · 工具](docs/screenshots/settings-tools.png) | ![设置 · 关于](docs/screenshots/about.png) |

内置工具（都是完全自治的单页应用，共用同一个数据库；**本体不在安装包里**，
从 Release 上的工具包取得）：

| 图片裁剪 · Image Studio | 尺码表生成器 |
| --- | --- |
| ![图片裁剪](docs/screenshots/tool-image-crop.png) | ![尺码表](docs/screenshots/tool-size-chart.png) |

| 随手记 | AI 生成（多厂商可切） |
| --- | --- |
| ![随手记](docs/screenshots/tool-scratchpad.png) | ![AI 生成](docs/screenshots/tool-ai-gen.png) |

| 五子棋（人机 / 双人对战，战绩落本机库） |
| --- |
| ![五子棋](docs/screenshots/tool-gomoku.png) |

---

## 核心功能

### 待办

- **我的一天 / 重要 / 全部** 三个智能视图，外加自建清单
- **子任务**：可逐个勾选完成，可各自设到期时刻；任务被选中时行内展开，
  显示描述与前 3 条子任务（其余折成「……还有 N 项」）
- **重复规则**：每日任务的完成状态按**本地日期**记账（`repeat_done_on`），
  跨时区不会错位
- **截止日期与提醒**合成一张卡片；提醒到点弹系统通知
- **附件**：图片 / 文件拖进来即存，支持粘贴与灯箱预览
- **选中行整行浮起**（圆角 + 投影），不是左侧一条色带

### 流程任务与特殊单号

- 流程任务与待办**分表存储，只在展示层混排**——不会因为看到一条流程任务而把待办的数据模型污染
- 流程任务有**可定制流程**：过程态编辑走 `moveOrderToStage`，每次流转留痕
- 流程任务写的是**描述**（`description`）而不是单号 —— schema v13 起不再自动编号
  `WO-YYYYMMDD-NNN`。那个号用户手上没有对应的单据、对不上账，要写的是"这件事要办什么"；
  标题仍然保留（列表扫视用一行标题，展开说明放描述）。
  ⚠️ 老库里的 `WO-` 号**数据仍在**（没有做删除迁移），只是界面不再显示
- 两种流程任务都能绑**自定义键值**的「相关信息」（字段名由用户定，可一键复制单个值或全部）。
  搜索会跨标题、单号、描述与相关信息字段值
- **特殊单号**以快递单号起算，时效 =「距下一步骤的剩余时间」，流程可定制
- 逾期与临期各提醒一次，临近过期红色高亮
- ⚠️ **流程任务永不进「我的一天」**——那是待办的地盘

### 紧急区

三类来源统一聚合在侧边栏底部，怎么算集中在一个文件里（`src/lib/urgent.ts`）：

| 来源 | 取什么时间 |
|---|---|
| 待办 | 提醒时刻 / 到期日 |
| 流程任务 | 步骤时效 / 交付日 |
| 子任务 | 自己的 `due_at`（只认显式设了时刻的） |

阈值（提前多久算「紧急」）在设置里调，不是写死的。

### 工具是可配置的模块

**这些工具不随安装包分发。** v0.2.0 起把它们拆出去了 —— 图片工具那份本地 AI 模型
（`migan.js` + `ort-wasm.js`）就有近 50 MB，为它让每一个用户、每一次增量更新都多下载
几十兆，划不来。工具本来就是可插拔的：**一个目录一个工具**，放哪都行，宿主只认目录里
那份 manifest，从来不要求它躺在安装包里。

所以现在是两份东西：

| 想要工具 | 怎么做 |
|---|---|
| 一次把五个都装上 | 到 Release 页面下载 `todo-workbench-tools_<版本>.zip`（约 30 MB），解压后把里面的 `tools/` 整个放进 `%APPDATA%\com.sogapopo.todo-workbench\` —— 也就是设置页里那行「工具目录」，重启应用即生效 |
| 只要其中一个 | 从解压出来的 `tools/` 里只挑那一个目录放进去，一样能用 —— 工具之间互不依赖 |
| 干脆自己造 | 让 AI 助手写一个（悬浮球 →「给我做一个…」），它直接装进同一个目录并打开 |

新装的桌面版第一次打开，**工具区是空的**，这是设计好的样子：设置 → 工具 会写明下一步。
浏览器演示模式不受影响 —— `tools/` 就在工程根目录下，dev server 直接把它当静态资源服务。

设置 → 工具里每个工具一行。四件事刻意分开，别混为一谈：

| 维度 | 动的是什么 | 说明 |
|---|---|---|
| 启用 / 停用 | 配置 `tools.disabled` | 只是不在侧边栏出现，工具文件还在 |
| 安装 / 卸载 | `%APPDATA%/…/tools/<id>/` | 删掉就是真删了 —— 工具本体不在安装包里，卸载之后要再下载工具包解压、或重新导入一次 |
| 保持状态 | 配置 `tools.keepState` | 默认开：切走再切回来还是你离开时的样子 |
| 关闭运行 | 本次会话的挂载集合 | 释放那个工具占用的内存与后台计算 |

工具的**数据表**与**互相调用**都走受控通道，不给 SQL 直连：每个工具有自己的
`tool_<id>_*` 前缀，跨工具调用走 `tools.list/open/send` 这类意图队列，
iframe 加载完成之后才投递（否则消息发给一个还不存在的窗口，静默丢掉）。

内置工具里有一份**标准的活样本**：五子棋（`tools/gomoku/`）是按《单 HTML 工具
编写标准》交付的 —— 单个自包含 HTML、只走 postMessage、战绩写自己的私有表、
深浅色跟随宿主。它不只是个小游戏：`npm run gomoku:test` 里有一段会把那份标准的
硬规则**逐条当成断言**跑一遍（自包含 / 无外部引用 / data-* 齐备 / 响应宿主主题 /
破坏性操作要二次确认）。标准写在文档里会漂，钉在测试上才不会 —— 以后写新工具，
把那几个路径换掉就能直接复用那一段。

### AI 助手（内置 Agent）

它不是"聊天框"，是一个**能动手**的助手。

**入口只有一颗悬浮球**（默认在右下角，可以拖到顺手的位置 —— **松手会吸附到最近的边**，
所以它永远停在边上，不会浮在屏幕中间挡住你正要看的内容）。落点会记住。
点它展开窗口；Esc、再点球、窗口右上角的 × 都能收起来。

窗口**不铺满、也不加全屏遮罩**：助手干的是慢活（写一份 30 KB 的工具源码、装进去、
再回来报告结果），那段时间你还得能翻待办、看紧急区 —— 所以它刻意没做成铺满整屏的模态
对话框。**位置是有记忆的**：默认回到上次关掉时那一处，第一次打开才落在左下方；
窗口头部是一条拖动把手，抓着它能把整个窗口挪走，落点会存下来。
侧边栏里**没有**助手入口：两个入口做同一件事的时候，用户先得猜哪个是"真的"。
球在它干活时会转圈，**收起窗口不会打断那一轮**（状态在模块里，不在界面里）。

**右侧那一栏是历史对话**。「新对话」是**新开一段**而不是清空 —— 旧的留在
右边那一栏里，点一下就切回去；每段按第一句话自动起标题。真删在
设置 → AI 助手 里，那里仍然是两段式确认。

在 设置 → AI 助手 里选一家服务商（Agnes / 阿里云百炼 / DeepSeek / 自定义 OpenAI 兼容）
并填上 Key，它就能：

| 能力 | 它到底做了什么 | 权限开关 |
|---|---|---|
| 按标准写工具 | 照内嵌的《单 HTML 工具编写标准》写一个单文件工具，直接装进工具目录并打开 | 写工具 |
| 建日程 / 改 / 删 | 往待办里写条目与子任务、改标题日期提醒清单、删条目（含子任务） | 建日程 |
| 改子任务 | 给某条待办追加 / 改 / 删 / 勾选子任务 | 建日程 |
| 绑数据表 | 给**自己导入的**工具写私有表声明（不碰内置工具：升级会覆盖） | 绑数据表 |
| 查 | 读已装工具清单与源码、读清单与待办、查今天有什么安排 | 不需要（只读） |
| 问你一句 | 摆几个做法让你挑（`ask_user_choice`），或者动手前来拿许可（`confirm_action`） | 不需要（不写数据） |

三个权限默认全开。关掉之后它会**如实说"这一项被关了，去 设置 → AI 助手 → 权限 打开"**，
而不是假装做过。

**它会什么、按什么标准干活，是能被看见的**：助手右上角的「技能」抽屉里是它的全部本事
（四份技能：写工具 / 绑数据表 / 算日期 / 接工具），硬规则与全文都在那儿 ——
不存在"界面上一份、喂给模型另一份"。注入给模型的是**每条一句话的硬规则**，
全文按需用 `read_skill` 取，避免一上来就把上下文塞满。

两件事值得单独说：

- **动作有两条通道**。除了原生 function calling，模型也可以把动作写成 `workbench`
  代码块 —— 因为有些网关会静默忽略 `tools` 参数，有些模型只会写纯文本。两条通道
  都过同一套校验与同一个权限门。
- **参数坏了也能救**。模型把整份 HTML 塞进参数时，字符串里的换行常常没转义
  （人看不出来，JSON 解析器看得出）。宿主会先把这种**无歧义**的坏法修好再执行；
  修不动的就如实报错，并且**绝不把坏 JSON 回灌**给服务端 —— 那会让整次请求 400，
  而用户只会看到一句看不懂的接口错误。
- **它会停下来问你**。有几种做法都说得通时，它把选项摆成一张卡让你点；也可以自己
  打字，或者点「跳过」让它自己定（它会说明替你定了什么）。问过一次就按你的回答做，
  不会拿同一个问题来回问。
- **删除与覆盖必须过你这一关，而且拦它的不是它自己**。提示词写得再狠也只是概率，
  而删除不可逆 —— 所以确认门做在**宿主这一侧**：它直接调 `delete_schedules`
  也会被拦下，卡片上写明要删哪几条（列标题，不是 uuid，否则等于让你盲签）。
  你点取消，回给它的不是"没回音"，而是一句**明确的"不要重试"** ——
  否则它最常见的反应就是再调一次，变成每轮弹一张卡让你连点取消。
  确认的许可只在**这一轮**有效，下一轮重新问。

### 同步（坚果云 WebDAV / OneDrive）

两台机器之间对齐数据。**可以选同步到哪：**

| 后端 | 怎么配 | 数据放哪 |
|---|---|---|
| **坚果云 WebDAV** | 账号 + 一个**应用密码**（不是登录密码）。不用自建服务器，也不依赖任何第三方账号体系 | 坚果云里你自己建的目录 |
| **OneDrive** | 先在 Azure 注册一个免费应用拿 client_id，再点「连接 OneDrive」 | 你 OneDrive 的「应用」文件夹（`Apps/<应用名>`），**只申请了访问这一个文件夹的权限** |

两者是**两套协议**，不是同一套的两种填法：OneDrive 个人版没有 WebDAV
（那套 `d.docs.live.net` 的映射靠应用密码 + 网络驱动器，微软早已废弃，在频繁改写的内容上也不可靠）。
但除了"传输"这一层，分片、合并、墓碑的规则完全是同一套，云端文件格式两边一模一样。

⚠️ 不过**两台机器必须连到同一份云端存储**才能看到彼此（同一个 OneDrive 账号，
或者同一个坚果云目录）。换后端不会动本地数据，但换完之后两边就各同步各的了 ——
已经传上去的那份还在原处，切成新后端后要重新上传一次。

#### 注册 Azure 应用（只在使用 OneDrive 时需要，约 5 分钟，免费）

1. 打开 <https://portal.azure.com>，用**要同步的那个微软账号**登录 →
   搜「Microsoft Entra ID」→ 左侧「应用注册」→「新注册」
2. **名称**填 `待办工作台`。⚠️ 这个名字会变成 OneDrive 里那个文件夹的名字，
   且**改注册名不会重命名已经建出来的文件夹** —— 所以一开始就起好
3. **「支持的帐户类型」**选「任何组织目录中的帐户和个人 Microsoft 帐户」。
   选成「仅此组织目录」的话，个人 outlook.com 账号会登不进去
4. **「重定向 URI」**平台选「**移动和桌面应用程序**」，然后勾选 `http://localhost`
   （列表里有现成的这一项）→「注册」
   - 只填 `http://localhost` 就够了：RFC 8252 §7.3 要求授权服务器对 loopback 地址
     放行**任意端口**，所以应用每次用随机端口，不必回来重新登记
   - ⚠️ 平台**别选「Web」** —— Web 平台按机密客户端处理（要 client_secret），
     而桌面应用把 secret 分发到每台机器上等于公开它
5. 注册完，在「概述」页复制 **「应用程序(客户端) ID」**，粘到设置页的「Azure 客户端 ID」
6. 左侧「API 权限」→「添加权限」→ **Microsoft Graph** →「**委托的权限**」，勾选这四项：
   - `Files.ReadWrite.AppFolder` —— **权限最小的那个**：只能读写应用自己那个文件夹
   - `offline_access` —— 没有它就拿不到长期令牌，每小时要重新登录一次
   - `openid`、`profile` —— 用来显示"已连接为 xxx@outlook.com"
   然后「添加权限」。个人账号**不需要**点「授予管理员同意」
7. 左侧「身份验证」→ 拉到最下面 → **「允许公共客户端流」改成「是」→ 保存**
   - ⚠️ 漏了这一步，登录会在换令牌时报 `unauthorized_client`
8. 回设置页点「连接 OneDrive」→ 浏览器打开微软登录页 → 登录并同意 →
   浏览器显示"授权完成，可以关闭这个窗口" → 应用这边自动变成"已连接：xxx@outlook.com"

**常见卡点：**

| 现象 | 原因 |
|---|---|
| `unauthorized_client` | 第 7 步没开「允许公共客户端流」 |
| `invalid_request` | 第 4 步没勾 `http://localhost`，或平台选成了「Web」 |
| `invalid_client` | client_id 复制错了（多带了空格） |
| `invalid_grant` | 授权被撤销或过期（改过密码、太久没用），重新点一次「连接 OneDrive」 |
| 浏览器过了、应用一直等 | 授权页的回调被浏览器插件或代理拦了，换个干净窗口重试 |

⚠️ 数据放在 OneDrive 的 `Apps/<应用名>` 里，而**网页版 OneDrive 默认不显示这个文件夹**。
在网页上找不到不等于没同步成功 —— 看设置页的「上次同步」和「本次结果」。
那个文件夹**不需要你手动建**：第一次「测试连接」或「立即同步」时会自动建出来。


**双向合并，不是覆盖。** 两边各留一份完整记录，按记录上的 `updatedAt` 比新旧，
谁后改听谁的（Last-Write-Wins）。删除走**软删除**（墓碑），所以"我这边删了"
也能同步过去，而不是下一次同步又把它从对面拉回来。

**可以选同步什么，默认只同步待办。**

| 分片 | 装的是什么 |
|---|---|
| 待办 | 列表、待办、子任务，以及待办之间的关联 |
| 流程任务 | 流程模板、流程任务、自定义字段、流转记录 |
| 图库 | 图库**记录** |
| 附件 | 流程任务附件的**记录** |

三条刻意定下的规则，写在设置页上也写在代码里：

- ⚠️ **文件本体永远不上传。** 图片、视频的原文件只留在本地仓库，同步的只有记录。
  两边都要看到图，自己按目录同步即可（坚果云本来就是个网盘）
- ⚠️ **设置项完全不进同步。** 主题、工具开关、设备名这些是"本机的事"，
  两台机器对着改只会互相覆盖，而且没有哪一方算"对的"
- ⚠️ **同步只在桌面版可用。** 浏览器演示模式的数据存在 `localStorage`，
  跟桌面版的 SQLite 是两套；而且 WebDAV 要用的 `PROPFIND` / `MKCOL` 浏览器发不出去，
  OneDrive 登录要开本地端口收回调，浏览器里同样做不了
- ⚠️ **凭据只留在本机。** 坚果云的应用密码与 OneDrive 的长期令牌都是明文存在本机 SQLite 里
  （与数据库文件同级，理由见下面的「数据隔离」），且**同步设置本身不参与同步** ——
  它们不会被带到任何一台别的机器上

子任务和流程的过程态**跟着父记录整体走**：它们是硬删除、没有墓碑，
"哪一条被删掉了"只能靠"整组替换"表达，逐个按 id 取并集是同步不过去的。

触发是手动的，界面会显示上次同步时间与本次结果（取回 / 更新 / 上传 / 冲突各多少条）。

**传输层在 Rust 侧，两个后端各一个文件：**

| 文件 | 后端 | 说明 |
|---|---|---|
| `src-tauri/src/webdav.rs` | 坚果云等 | PROPFIND / MKCOL / PUT / GET + Basic Auth |
| `src-tauri/src/onedrive.rs` | OneDrive | 授权码 + PKCE 的 loopback 登录、Graph 的 get / put / stat |

两者共用同一个 HTTP 客户端（`reqwest` + `rustls`，**刻意关掉代理** ——
本机一个挂掉的代理会让所有请求原地失败）。OneDrive 那边不引任何新依赖：
SHA256 用已在依赖树里的 `ring`，base64url 自己写。

共同的上层是 `src/lib/syncClient.ts` 里的 `RemoteTarget` 句柄
（`check` / `get` / `put` / `stat` 四个方法），按 `provider` 分派 ——
**换后端不碰合并层一个字节**。合并算法是纯 TS 函数（`src/lib/sync.ts`），
不碰网络，所以能被完整单测覆盖。

---

## 技术选型（已定稿）

| 层 | 选型 | 说明 |
|---|---|---|
| 桌面外壳 | Tauri 2.x | 复用系统 WebView2，宿主本体很轻 |
| 前端 | React 19 + TypeScript + Vite | |
| 样式 | Tailwind CSS v4 | 颜色/阴影一律走 `@theme` 语义令牌，禁裸 hex |
| 状态 | Zustand | 单 store，任务数据以数据库为准 |
| 数据库 | SQLite（tauri-plugin-sql） | 开 WAL，单文件可备份 |
| 打包 | NSIS | Windows 上不用 MSI |
| 更新 | tauri-plugin-updater | 静态 update.json + 签名 |

### 为什么不用 Electron

Electron 换来的是 Node 原生模块能力，而本项目的工具全部是浏览器端就能完成的事
（canvas 裁剪、表格导出、剪贴板）。为此付出约 180 MB 安装包和约 300 MB 内存不划算。
若将来需要 OCR、批量转码等重活，Tauri 2 可挂 Rust 库或 Python sidecar，无需更换外壳。

---

## 架构

### 双驱动数据库层

`src/lib/db.ts` 抽象出 `Db` 接口，有两个实现：

- `SqliteDb` —— Tauri 环境下的真实 SQLite
- `MemoryDb` —— 浏览器下的内存库，快照持久化到 localStorage

上层业务代码（`src/lib/repo.ts`）只依赖接口，不关心底层是哪种。
**这样"先在浏览器里跑 demo 验证产品形态"和"打包成桌面应用"用的是同一份业务代码。**

启动时通过 `__TAURI_INTERNALS__` 自动判定环境，无需手工切换。

> ⚠️ **MemoryDb 有硬限制，踩过一次**：它不支持 JOIN / 子查询 / 多聚合，
> 遇到这类 SQL 会**静默返回空**（不是报错）。所以取数一律"拆成单表查询 + 在 JS 里合并"。
> 桌面端的事务也**必须**走 Rust 侧的 `db_transaction` 命令，不能自己拼 BEGIN/COMMIT。

### 迁移规范（不可破坏）

数据库迁移从第一天就版本化（`PRAGMA user_version` + `src/lib/migrations.ts`），
**当前 schema = v13**：

| 版本 | 名称 | 内容 |
|---|---|---|
| 1 | `init_core_schema` | 清单 / 任务 / 子任务 / 设置 |
| 2 | `add_task_repeat` | 重复规则 |
| 3 | `add_task_links` | 任务间关联 |
| 4 | `add_special_orders_tool_schema` | 特殊单号（早期以工具形式承载） |
| 5 | `add_tool_kv_store` | 工具私有 KV |
| 6 | `add_work_orders` | 流程任务 |
| 7 | `add_wo_attachments` | 流程任务附件 |
| 8 | `add_special_orders_as_work_orders` | 特殊单号升格为流程任务的一类 |
| 9 | `add_gallery` | 图库 |
| 10 | `add_tool_schema_ledger` | 工具 schema 台账 |
| 11 | `add_wo_courier` | 流程任务的快递字段 |
| 12 | `add_step_due_at` | 子任务的到期时刻 |
| 13 | `add_wo_description` | 流程任务的描述（普通流程任务取消自动编号） |

四条铁律：

1. 只追加，已发布的迁移脚本**永不修改**——用户库里可能已经跑过它
2. 每个迁移是一个原子事务，失败整批回滚，绝不留半截 schema
3. 核心表用 `core_` 前缀，工具表用 `tool_<id>_` 前缀，两套迁移互不干扰
4. SQLite 的 `ALTER TABLE` 能力有限，涉及重建表时用
   "建新表 → 拷数据 → 删旧表 → 改名"四步法

### 工具装载子系统

工具契约：

```
tools/<id>/
  manifest.json    清单
  index.html       工具界面，完全自治的单页应用
```

`manifest.json`：

```json
{
  "id": "image-crop",
  "name": "图片裁剪",
  "version": "2.0.0",
  "icon": "crop",
  "entry": "index.html",
  "dbVersion": 1
}
```

**扫描只看磁盘上真实存在的目录**（两条路径各走一遍同一套逻辑）：

1. 用户数据区 `%APPDATA%/com.sogapopo.todo-workbench/tools/` —— 下载解压的、助手写的、自己丢进去的
2. 安装包内 `<resources>/tools/` —— **现在默认是空的**（v0.2.0 起不再随包）

见到 `manifest.json` 才认这是一个工具；单个目录读坏了只跳过它，不拖累别人。
同 id 时用户数据区优先 —— 想替换某个内置工具，往这里丢一个同名的即可。

**工具目录放用户数据区而非安装包，是"可更新"设计的一部分**：
新增工具只需往该目录丢一个文件夹，不必重新打包发版。

⚠️ 桌面端**不会**拿那份硬编码的内置清单去兜底。兜底是"资源目录扫不出来"时的退路，
而现在「安装包里没有工具」是**正常状态**而不是故障 —— 再照清单列出来，侧边栏就成了
五个点开只显示「找不到入口文件」的入口。列得出来必须等价于打得开，所以宁可显示
空列表（并在设置页写清怎么补），也不摆一半假的东西出来。
浏览器模式反过来：`tools/` 在工程根目录，那份清单正是它唯一且真实可用的来源。

**卸载就是删目录**：一个工具的一切都在它那个 `<id>/` 里，清掉就消失了。
`<appData>/tools/.uninstalled` 那笔记录还与 Rust 侧的启动同步配套着 ——
它是给「安装包里确实带了工具」的场合准备的（那种场合下删目录不管用，下次启动会
被同步回来）。现在那条路径不再发生，但机制留着：哪天把工具放回安装包，不用重写。

**「保持工具状态」是怎么做到的**：打开过的工具不卸载，只是隐藏 ——
iframe 的文档一直活着，里面的变量、DOM、滚动位置都还在。两个实现上的硬约束：

- **帧的 DOM 顺序必须稳定**。iframe 在 DOM 里挪一下（哪怕只是换了个兄弟顺序），
  浏览器就会重新加载它，状态照样丢。所以按打开顺序渲染，用 CSS 切换可见性，
  绝不按"当前是否活跃"重排。
- **同一时刻只能有一个工具头部**。头部画在每个帧里面的话，隐藏的帧会各留一个
  `<header>`，自动化里 `locator("header").last()` 就会抓到隐藏的那个。

想回到初始态，按工具头部的「重置」；关掉这个开关则退回"切走即卸载"。

**单文件导入**：设置 → 工具 → 选择 HTML 文件 → 确认名称与 id 即可。
CSS/JS 必须内联，相对引用不会跟着进来（原因见 `ToolHost` 里那段 asset 协议说明）。

**内置工具一览**（表里的五个都不在安装包里，从 Release 上的工具包取得）：

| 工具 | 版本 | 做什么 |
|---|---|---|
| 图片裁剪 | 2.0.0 | 裁剪 / 尺寸与比例 / 镜像 / 选区填充 / 批量导出；可存进工作台图库、可从图库自取；本地 AI 补全（**模型在工具包的 `ai/` 目录里**，没带它时自动退回纯 JS 算法 —— 差一档质量，不是坏了） |
| 尺码表生成器 | 1.1.0 | 粘贴 Excel 尺码数据生成尺码表；导出的图能存进工作台图库 |
| 随手记 | 1.0.0 | 跑在工具表数据库上的便签本，也是"工具怎么用自己的数据表"的样例 |
| AI 生成 | 0.5.0 | 文生图 / 图生图 / 生视频与对话；已接入阿里云百炼（万相、千问图像、Z-Image 共 21 档，按族走不同接口）与 Agnes；出图可自动存图库 |

> 加一家服务商 = 往 `PROVIDERS` 里加一个对象，UI 不用改。描述符里的可选键就是扩展点：
> 生图用 `async`，生视频用 `headers` + `pollPathFor`
> （**有它就按 task_id 轮询，没有才走 Agnes 的 video_id 查询串**）。

### 数据隔离

所有表在同一数据库文件中，但命名空间严格分开：

- `core_*` —— 宿主核心（`core_lists` / `core_tasks` / `core_steps` / `core_settings` 等）
- `tool_<id>_*` —— 各工具私有表，由 `toolTable()` 强制生成前缀

卸载或回滚某个工具，不影响待办数据。

同步也按同样的边界切：**一个分片只碰它自己那几张表**。只勾「待办」时，
流程任务、图库、附件在本机一行都不会被动到；反过来，只勾「流程任务」时
附件记录也不会被连带清掉（`core_wo_attachments` 挂在流程任务下且是级联删除，
所以写回一律走 upsert 而不是"清空重插"）。

### 更新机制（两层）

**第一层，应用本体升级。** `tauri-plugin-updater` + Minisign 签名 + 静态 `update.json`。

安装包与 `update.json` 一起挂在 **GitHub Releases**，客户端拉的是固定转发地址：

```
https://github.com/baicaibucai1/todo-workbench/releases/latest/download/update.json
```

`latest/download` 永远指向最新正式版，所以**发新版只需新建 Release，不用动客户端地址**。
清单里带安装包的签名与下载地址，客户端验签通过才安装；`installMode = passive`
即静默下载 + 提示重启，不做强制更新。

⚠️ **签名私钥必须离线备份**（本机 `.tauri-key`）——私钥丢失后，
再也发不出能被老版本接受的更新，用户只能手动重装。

**第二层，工具与数据结构独立演进。** 工具目录放用户数据区（见上），
数据库迁移版本化（见「迁移规范」）。
一旦用户已有数据再补迁移机制，就只能手工修库了。

---

## 目录结构

```
main/
  src/
    lib/
      db.ts            数据库抽象层（双驱动）+ 迁移执行
      migrations.ts    版本化迁移定义（当前 v16）
      repo.ts          业务数据仓库
      rows.ts          列表分组与排序（"默认展开第一条"同源）
      urgent.ts        紧急区取数（待办 / 流程任务 / 子任务三类来源）
      tools.ts         工具扫描与校验
      toolBridge.ts    工具与宿主的受控通道
      toolStore.ts     工具私有表读写
      settings.ts      设置键与默认值（禁裸字符串键）
      detailSections.ts 详情面板分区顺序
      rowStyle.ts      列表行表面样式（选中浮起等共用规则）
      datetime.ts      时间转换与格式化
      couriers.ts      快递公司表
      special.ts       特殊单号业务规则
      gallery.ts       图库
      attachments.ts   附件
      notify.ts        系统通知
      wallpapers.ts    壁纸
      icons.ts         图标名映射
      sync.ts          合并算法（纯函数：LWW / 墓碑 / 分片信封）
      syncRepo.ts      同步与数据库之间的搬运（导出快照 / 写回）
      syncClient.ts    同步编排（读配置、跑分片、出报告）
        agent/           内置 AI 助手
          runtime.ts       模块级状态（多会话 + 工具循环；收起窗口不中断）
          actions.ts       十四个动作的执行、**唯一**权限门与**强制确认门**
          protocol.ts      动作协议（原生 tool_calls + workbench 代码块）
          providers.ts     对话服务商注册表（OpenAI 兼容，加一家只动数据）
          skills.ts        技能包（硬规则常驻注入，全文按需取）
          client.ts        一次对话请求与 SSE 流式读回
          ball.ts          悬浮球的落点几何（默认位置 / 夹回视口 / 松手吸附到最近的边）
          windowGeom.ts    助手窗口的落点几何（上次位置 / 首开左下 / 夹回视口）
          types.ts         类型
    components/
      Sidebar.tsx      侧边栏（智能视图 + 工具区 + 清单 + 紧急区）
      TaskList.tsx     任务列表主体
      TaskRow.tsx      单条待办（含展开子任务）
      OrderRow.tsx     单条流程任务
      TaskDetail.tsx   右侧常驻详情面板
      OrderDetail.tsx  流程任务详情
      SpecialOrdersView.tsx  特殊单号专用视图
      GalleryView.tsx  图库
      AgentBall.tsx    悬浮球（唯一入口：可拖动、松手贴边、落点记住、忙碌时转圈）
      AgentWindow.tsx  助手窗口（可拖动、位置记住）+ 右侧历史对话栏
      AgentView.tsx    AI 助手对话主体（消息流 / 动作卡 / 技能抽屉）
      Settings.tsx     设置（九个分区）
      UrgentPanel.tsx  紧急区
      ToolHost.tsx / ToolArea.tsx  工具容器与标签条
      FlowEditor.tsx   流程模板编辑器
      ...
    store.ts           Zustand 全局状态
    types.ts          数据模型
  tools/              内置工具（**不随安装包**：打成工具包单独发布）
    image-crop/  size-chart/  scratchpad/  ai-gen/  gomoku/
  release-assets/     发版资产（工具包 zip；生成物，不进 git）
  tests/              单测与 e2e
  src-tauri/          Rust 端：插件注册、内置工具同步（只在开发时同步源码里的 tools/）、打包配置
    src/webdav.rs     WebDAV 传输层（坚果云等；独立于「工具同步」）
    src/onedrive.rs   OneDrive 传输层（Graph API + PKCE loopback 登录）
```

---

## 怎么启动

### 只是想用：直接下载安装包

到 [**Releases**](https://github.com/baicaibucai1/todo-workbench/releases/latest) 下载
`todo-workbench_x.y.z_x64-setup.exe`，双击安装 —— **不装 Node、不装 Rust、
不需要管理员权限**（`installMode = currentUser`，装进用户目录），
装完就是上面截图里的样子。之后应用会自己去 Releases 拉 `update.json` 检查新版本。

同一个 Release 上还有一份 **`todo-workbench-tools_x.y.z.zip`（约 30 MB，可选）** ——
那是五个内置工具的本体。安装包故意不打包它们：工具里的本地 AI 模型有近 50 MB，
不该让每个用户都为了一个可能用不上的功能下载它。想要工具的话，下载后把里面的
`tools/` 整个文件夹放进 `%APPDATA%\com.sogapopo.todo-workbench\` 重启即可，
具体见「工具是可配置的模块」。

### 想改代码：双击脚本

| 脚本 | 用途 | 前置条件 |
|---|---|---|
| **`启动开发版.bat`** | 浏览器里跑，秒开，改代码即时生效 | 只需 Node.js |
| **`启动桌面版.bat`** | 真正的桌面窗口（Tauri 原生窗口） | 还需 Rust 工具链 |
| **`打包桌面版.bat`** | 打成 NSIS 安装包 + 更新清单 | 同上 |
| **`安装Rust环境.bat`** | 装 Rust（可选 GNU 或 MSVC 路线） | 需手动点 UAC |
| **`安装MinGW环境.bat`** | GNU 路线所需的 MinGW 安装指引 | 需手动操作 |
| **`安装C++生成工具.bat`** | MSVC 路线所需的 VS 生成工具 | 需手动点 UAC |

所有脚本都会自己检查环境、缺依赖时自动安装、并给出明确提示。
**推荐先用「启动开发版」**——它不需要 Rust，能立刻看到完整界面。

### 三条路线怎么选

编译 Rust 需要一个链接器，有两个来源，选一个即可：

| 路线 | 需要装什么 | 体积 | 说明 |
|---|---|---|---|
| **GNU（推荐）** | MSYS2 + MinGW-w64 | 约 100 MB | 自带链接器，不用装 Visual Studio |
| MSVC | Visual Studio C++ 生成工具 | 2–4 GB | Tauri 官方推荐，兼容性最好 |

**GNU 路线**的完整步骤：

1. 双击 `安装MinGW环境.bat`，按里面的指引装好 MSYS2
2. 双击 `安装Rust环境.bat`，选 `1`（GNU）
3. 运行 `npm run setup:gnu` 让脚本自动探测路径并生成 Cargo 配置

GNU 路线有一个 Windows PE 格式的固有限制：DLL 导出符号序号不能超过 65535，
而 Tauri 依赖的 `windows` crate 符号数远超此限。`setup:gnu` 生成的配置里带了
`-Wl,-exclude-all-symbols` 参数来解决它 —— GNU `ld` 2.4x **原生支持**该参数，
所以**不需要装 lld**（省掉约 1 GB 的 LLVM）。

想改回 MSVC：`npm run setup:gnu -- --off` 会禁用该配置。

### `.bat` 必须保持「纯 ASCII + CRLF」

**这是本项目最容易踩、也最隐蔽的一个坑。** 三条规则各有原因：

| 规则 | 违反后的症状 |
|---|---|
| **纯 ASCII** | 中文 `echo` 行被拆成乱码命令，报一堆「不是内部或外部命令」 |
| **CRLF 换行** | 多行块 `if (...) (` 被拆散 |
| **不带 BOM** | BOM 被当成第一个命令的一部分 |

最关键的是第一条。原因：**cmd.exe 按字节偏移定位批处理文件里的行**，
多字节字符会让偏移逐渐错位，迟早有一行被切在半个字符中间。
实测数据（同一份内容，`CMD /D /C` 直接跑）：

| 编码 | 大小 | 结果 |
|---|---|---|
| **纯 ASCII + CRLF** | 5733 B | ✅ 69/69 行正常，stderr 全空 |
| UTF-8 无 BOM + CRLF | 8318 B | ❌ 只有 19/69 行，大量乱码命令 |
| GBK + CRLF | 5845 B | 能跑，但会和 Node 的 UTF-8 输出冲突 |
| UTF-8 带 BOM | — | ❌ BOM 被当成命令名 |
| ASCII 外层先 `chcp 65001` 再 `call` 内层 | — | ❌ 仍然 19/69，无效 |

注意第二行：**UTF-8 中文的 .bat 在小文件时碰巧能跑**，
所以这个问题很容易被漏掉 —— 但「碰巧能跑」不是可以依赖的性质。

**所以本项目的架构是：`.bat` 只做薄启动器（纯 ASCII），
所有中文提示与业务逻辑由 Node 脚本负责**
（Node 写 UTF-8 字节，配合 `.bat` 里的 `chcp 65001` 正常显示）。

```
打包桌面版.bat        ->  node scripts\pack.mjs          （完整打包流程）
启动开发版.bat        ->  node scripts\launchers.mjs dev
启动桌面版.bat        ->  node scripts\launchers.mjs desktop
安装Rust环境.bat      ->  node scripts\launchers.mjs install-rust
安装MinGW环境.bat     ->  node scripts\launchers.mjs guide-mingw
安装C++生成工具.bat   ->  node scripts\launchers.mjs guide-msvc
```

加新的 `.bat` 时照抄这个形状即可：

```bat
@echo off
chcp 65001 >nul
cd /d "%~dp0"
node scripts\你的脚本.mjs
pause
```

检查与修复：

```bash
npm run bat:check   # 检查全部，不合格退出码 1
npm run bat:fix     # 自动修 CRLF 与 BOM（非 ASCII 只能人工处理）
```

`npm run env:check` 也会把它列为阻断项。
详细推导见 `scripts/bat-lint.mjs` 与 `scripts/pack.mjs` 顶部的注释。

### `.bat` 会自己补齐 PATH

`启动桌面版.bat` / `打包桌面版.bat` 不依赖你的系统 PATH，开跑前会调用
`scripts/toolchain-path.mjs` 把需要的目录加进去，原因有两个：

- `%USERPROFILE%\.cargo\bin` —— rustup 会写进持久 PATH，但**装完不重开窗口就取不到**
- MinGW 的 `bin` —— **一定不在 PATH 里**（我们是解压在用户目录的）。
  而 GNU 目标下 `embed-resource` 是用裸命令名 `windres` 去调它的，
  找不到就直接编译失败

所以装完 Rust 后**不需要重开命令行窗口**，直接重新运行脚本即可。
MinGW 的路径从 `src-tauri/.cargo/config.toml` 里的 `linker` 读，那是单一数据源。

### 签名密码不能在 `.bat` 里设

cmd 里 `set "TAURI_SIGNING_PRIVATE_KEY_PASSWORD="` 是**删除变量**，
不是「设为空字符串」。少了密码，Tauri 会转成交互式索要 ——
实测变量缺失时挂起 12 秒仍未返回，双击运行时表现为**打包完成后无限期卡住**。

```bash
# 实测（tauri signer sign）
变量缺失      -> 挂起 12s 未返回
空字符串 ""   -> 244ms 签名成功
```

所以签名必须由 Node 来设（`process.env.X = ""` 才是真正的空字符串）。
`scripts/build-desktop.mjs` 已经处理好这件事。

### 手动命令

```bash
npm install          # 首次运行，装依赖（约 30 秒）
npm run dev          # 浏览器模式 → http://localhost:1420
npm run tauri dev    # 桌面模式（需 Rust）
npm run tauri build  # 打包成 NSIS 安装包
```

> 手动跑 `npm run tauri build` 时会提示输入密码 —— **直接回车**即可
> （当前签名密钥的密码是空字符串）。
> 更省事的做法是用 `npm run build:desktop`，它会把 PATH、签名密码、
> WebView2Loader.dll 都处理好，不会弹提示。

浏览器模式下用内存库（数据存在 localStorage）；桌面模式下自动切换为
SQLite 文件数据库。**两个模式共用同一份业务代码**，所以浏览器里验证过的功能，
打包后行为一致。

装完 Rust 后**必须重新打开命令行窗口**（环境变量需要刷新），否则会提示找不到 cargo。

首次 `npm run tauri dev` 要编译 Rust 依赖，约 3–10 分钟；之后增量编译只需几秒。

### 发版：把安装包发成 Release

```bash
node scripts/build-desktop.mjs          # 1. 打包（产出 *-setup.exe 与配对 .sig）
node scripts/publish-release.mjs        # 2. 发布：改名 → 生成 update.json → 建 Release → 上传 → 匿名验证
node scripts/publish-release.mjs --dry  # 只看计划，不发
```

发布脚本负责三件最容易漏的事：

| 事 | 为什么必须由脚本做 |
|---|---|
| **资产名改 ASCII** | GitHub 会**丢掉** assets 上传 URL 里 `?name=` 的非 ASCII 字符：「待办工作台_0.1.0_x64-setup.exe」被存成「_0.1.0_x64-setup.exe」，于是 update.json 里的下载地址 404，而客户端是**静默**失败 |
| **四样一起换** | 安装包 / `.sig` 签名 / `update.json` / **工具包 zip** —— 漏签名老版本拒绝安装，漏换清单客户端就一直以为已是最新，漏了工具包则新用户装完就是一个没有任何工具的程序（v0.2.0 起工具不随包，那份 zip 是他唯一能拿到它们的途径） |
| **匿名验证** | 只看带凭据的 API 返回不算数；脚本会以匿名身份拉一次 `latest/download/update.json`，安装包要确实是 PE 文件（前两字节 `MZ`），工具包要确实是 zip（前两字节 `PK`） |

发一个新版本需要三步：把 `src-tauri/tauri.conf.json` 与 `src-tauri/Cargo.toml` 的
`version` 一起改高（两处必须一致，否则 exe 的资源信息与更新清单对不上）→
重新打包 → 再跑一次发布脚本。客户端地址是 `releases/latest/download/update.json`
（固定转发），**任何配置都不用改**。

打包流程本身也会顺手把工具包生成出来（`build-desktop.mjs` 调 `pack-tools.mjs`），
并在最后核对安装包里**没有**工具、工具包里**有**全部五个 —— 这条校验的方向跟着
`bundle.resources` 走：哪天把 `../tools/**/*` 加回去，它会自动翻回
「每个工具文件都必须出现在安装清单里」，不用记得改脚本。

---

## 项目自检

**不确定环境缺什么？先跑这个：**

```bash
npm run env:check    # 环境自检，逐项报告缺什么、怎么补
```

它只读不写，不会安装或修改任何东西，最后给出一份纯文本报告。

改完代码想确认没弄坏东西，按这个顺序跑：

```bash
npm run typecheck      # TypeScript 类型检查，应 0 错误
npm run smoke          # 逻辑单测，无浏览器（数据库层 / 仓库层 / 设置 / 分区排序 …）
npm run sync:test      # 同步的合并算法与写回（无浏览器；含"另一台机器"的合并场景）
npm run agent:test     # AI 助手（动作协议 / 权限门 / 流式解析 / 对话持久化；无浏览器）
npm run icons:check    # 图标格式校验（PNG 结构 + ICO 各帧）
npm run webview2:check # 校验 WebView2Loader.dll 与 Rust 依赖版本一致
npm run bat:check      # .bat 规范检查（纯 ASCII + CRLF + 无 BOM）

# 浏览器 e2e（另开一个窗口跑 dev server，然后）
node tests/_run-all-e2e.mjs      # 全量，21 个套件一次跑完
node tests/task-detail.mjs       # 也可以单跑某一个套件
```

### 测试现状

| 层 | 规模 | 命令 |
|---|---|---|
| 类型检查 | 0 错误 | `npm run typecheck` |
| 逻辑单测（smoke） | **522 项** | `npm run smoke` |
| 同步单测（sync） | **232 项** | `npm run sync:test` |
| AI 助手单测（agent） | **551 项** | `npm run agent:test` |
| 五子棋工具单测（gomoku） | **59 项** | `npm run gomoku:test` |
| 浏览器 e2e | **21 套件 / 1305 项** | `node tests/_run-all-e2e.mjs` |

e2e 用本机 Edge（与 Tauri 的 WebView2 同源），覆盖 21 个面：

```
task-detail    选中浮起 / 详情与列表同源 / 分区排序
todo-extras    行内展开子任务 / 子任务时间
daily-settings 我的一天分组 / 重复 / 设置持久化 / 关于页
sync-panel     同步分区（默认只勾待办 / 勾选落库 / 演示模式下的禁用态）
background     壁纸与主题
tool-browser   工具装载 / 状态保持 / 单文件导入
tool-database  工具私有表与跨工具调用
gomoku         五子棋（iframe 装载 / 连五落库 / 清空二次确认）
image-crop-ai  图片工具与本地 AI
placeholder-tools  占位工具
ai-gen         AI 生成（多厂商切换 / 异步轮询 / 真实连通性）
cross-origin-bridge  跨源工具桥（只在装出来的应用里能复现的那类断链）
gallery / wallpapers / attachments  图库 / 壁纸 / 附件
orders-view    流程任务视图
special-orders 特殊单号
urgent         紧急区三类来源
panel-resize   面板拖拽
agent          AI 助手（整条工具循环 / 权限拒绝 / 坏参数不回灌）
agent-ball     助手入口与容器（球：拖动 / 松手贴边 / 落点持久化；窗口：拖动 / 位置记住 /
               首开左下 / 不铺满）；侧栏没有第二个入口；多会话
```

> 大规模改动（加工具、动取数层、改数据模型）跑**全量**。
> 只改一处 UI 时可以单跑受影响的套件，省时间。

### 重拍 README 截图

界面改了之后，README 里的图要跟着更新：

```bash
node tests/gen-readme-shots.mjs   # 清演示库 → 逐视图截图 → 写 docs/screenshots/
node tests/gen-about-shot.mjs     # 单拍「设置 → 关于」
```

### 图标

应用图标由 `npm run icons` 生成，**不依赖任何第三方库**——
PNG 与 ICO 的编码是 `scripts/gen-icons.mjs` 里用内置 `zlib` 手写的。

```bash
npm run icons        # 重新生成 src-tauri/icons/ 下全部 14 个文件
npm run icons:check  # 校验生成的 PNG 结构、ICO 各帧、以及配置引用是否齐全
```

想换设计：改 `gen-icons.mjs` 里的 `renderIcon()`（大尺寸）与 `renderSmallIcon()`
（小尺寸，勾线更粗、不加装饰细节）两个函数即可。

---

## 待办事项

- [x] 生成 updater 签名密钥并填入 `tauri.conf.json` 的 `pubkey`
- [x] 补齐应用图标（14 个文件，含多尺寸 ICO）
- [x] 环境自检脚本 `npm run env:check`
- [x] GNU 工具链配置脚本 `npm run setup:gnu`
- [x] **跑通首次桌面打包**（无提权）
- [x] **修复「装得上但启动报找不到 WebView2Loader.dll」**（DLL 未被打进安装包）
- [x] **修复 6 个 `.bat` 在 cmd 下被解析成乱码**（改为纯 ASCII 启动器 + Node 实现）
- [x] **修复打包完成后因签名密码提示而卡死**（cmd 的 `set "VAR="` 会删除变量）
- [x] **实机安装并跑通**：应用正常启动 + 工具目录同步 + SQLite 落盘
- [x] 任务详情面板（子任务、备注、截止日期与提醒）
- [x] 系统通知提醒（`notify.ts`；拿不到权限时用应用内提醒卡片兜底）
- [x] 流程任务与特殊单号（可定制流程、过程态留痕、时效倒计时）
- [x] 图库与附件
- [x] 工具的数据表、互相调用、设置里的数据库浏览
- [x] 侧边栏紧急区（三类来源统一聚合）
- [x] **坚果云同步**（WebDAV 双向合并，默认只同步待办；只同步记录不传文件，设置不进同步）
- [x] **OneDrive 同步**（微软 Graph API + PKCE 登录，只申请访问应用专属文件夹的最小权限）
- [x] **发布首个 Release（v0.1.0）**：安装包 + `.sig` 签名 + `update.json` 一起挂在 Releases，
      `releases/latest/download/update.json` 作为固定的更新源（发新版不用改客户端）
- [ ] 列表内拖拽排序（当前排序规则固定：重要 / 到期 / 创建）

---

## 环境搭建（无需管理员权限）

本项目已跑通**全程不需要提权**的打包流程，工具链全部落在用户目录：

| 组件 | 位置 | 说明 |
|---|---|---|
| Rust 1.98.1 | `%USERPROFILE%\.cargo` | rustup 默认就装用户目录，不需要管理员 |
| MSYS2 | `%USERPROFILE%\msys64` | 用免安装的 `tar.xz` 解压，不用官方安装程序 |
| MinGW-w64 (gcc 16.2) | `%USERPROFILE%\msys64\mingw64` | 直接解压软件包，绕开 pacman |

换机器或重装时，按顺序跑：

```bash
npm run setup:rust      # 装 Rust（GNU 目标）
npm run fix-rust-shims  # 修复 0 字节 shim（见下方第 1 条）
npm run setup:msys2     # 下载并解压 MSYS2
npm run setup:mingw     # 装 MinGW-w64 工具链
npm run setup:gnu       # 生成 Cargo 配置
```

### 三个真实踩过的坑

1. **`.cargo/bin` 下 13 个 shim 是 0 字节。**
   rustup 正常用 hardlink 创建它们，某些文件系统上会失败，
   于是 `cargo` / `rustc` 报 `EFTYPE`。
   修法是把 `rustup.exe` 复制成那些名字——rustup 靠 `argv[0]` 判断自己要扮演哪个工具。

2. **pacman 的 GnuPG 密钥环初始化会卡死。**
   所以不走 pacman，改成直接解压 MSYS2 软件包（`.pkg.tar.zst`，
   本机 `bsdtar` 内置 zstd 支持），依赖从包内 `.PKGINFO` 的 `depend =` 字段递归解析。

3. **GNU 工具链的产物路径带 target triple。**
   安装包在 `src-tauri/target/x86_64-pc-windows-gnu/release/bundle/nsis/`，
   不是 `src-tauri/target/release/bundle/nsis/`。
   用 `npm run build:status` 自动定位，不要手写路径。

### 不需要 LLD

MinGW 构建 DLL 时默认导出全部符号，而 Windows PE 限制导出序号 ≤ 65535，
Tauri 依赖较多会触发 `export ordinal too large`。
GNU `ld` **原生支持 `--exclude-all-symbols`**（`setup:gnu` 已写入配置），
所以不需要安装 LLD / LLVM，省掉约 1 GB。

### GNU 路线特有的坑：WebView2Loader.dll 必须随安装包装上

**症状**：安装包能正常装完，双击图标却弹窗「找不到 WebView2Loader.dll」。

**原因**：`webview2-com-sys` 在 `-gnu` 目标下是**动态**链接这个 DLL 的
（`todo-workbench.exe` 的 PE 导入表里它是第一个静态导入项），
应用启动时必须在 **exe 同级目录**找到它。

`tauri-build` 其实知道这件事——它的 build.rs 里有一段 `gnu` 分支，
会把 DLL 从依赖的 out 目录拷到 `target/<triple>/release/`。
但它**只拷到 target 目录，没有把 DLL 加进 `bundle.resources`**，
于是 NSIS 打包器完全不知道要装它：生成的 `installer.nsi` 里连一个 `.dll` 都没有。
这是 Tauri 对 GNU 目标的遗漏，不是本项目的配置错误。

**解法**（已落地，无需手工干预）：

1. DLL 的源文件放在 `src-tauri/WebView2Loader.dll`
2. 在 `tauri.conf.json` 的 `bundle.resources` 里声明 `"WebView2Loader.dll"`
   —— List 形式下资源目标路径 = 源路径，所以它会正好装到 `$INSTDIR\WebView2Loader.dll`
3. `scripts/sync-webview2-loader.mjs` 负责让这份源文件与 `Cargo.lock` 锁定的
   `webview2-com-sys` 版本保持一致，避免手工拷贝导致版本漂移

```bash
npm run webview2:sync    # 同步（缺失或哈希不符时自动拷贝）
npm run webview2:check   # 只校验，不一致则退出码 1
```

`setup:gnu`、`打包桌面版.bat`、`build:desktop` 三处都会自动跑同步，
`env:check` 还会额外校验「文件在 + 配置里声明了」两件事，缺任何一件都算阻断项。

> 顺带排除过的隐患：Rust 的 GNU 目标会**静态**链接 `libgcc_s_seh-1.dll` /
> `libwinpthread-1.dll` / `libstdc++-6.dll`（exe 里搜不到这些名字），
> 所以 `WebView2Loader.dll` 是唯一的非系统库依赖，补上它就不会再有后续缺 DLL 的问题。

### 编译很慢是正常的

`Cargo.toml` 的发布配置用了 `lto = true` + `codegen-units = 1`，
这是「把可执行文件做到最小」的极限设置，首次全量编译约 **25–30 分钟**。
想快可以改成 `lto = "thin"` + `codegen-units = 16`。

期间没有输出是正常的，用这个看进度：

```bash
npm run build:status
```

---

## 许可与致谢

- 作者：Sogapopo
- 应用图标与壁纸的生成 / 抓取脚本均在本仓库内，**不依赖第三方图标库**
- 图片工具的本地 AI 推理基于 ONNX Runtime Web 与开源去背景模型，
  许可证文件随模型一同分发（`tools/image-crop/ai/LICENSE.txt`）
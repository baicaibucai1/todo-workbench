# 待办工作台

以 Microsoft To Do 为原型的 Windows 桌面应用，但定位不止于待办——
它是一个**可扩展的工作台**：待办是核心模块，图片工具、订单记录等作为独立工具随时插入，
全部共用同一个本地数据库。

> **当前状态：桌面版已打包成功。** 产出 2.48 MB 的 NSIS 安装包，
> 采用 GNU 工具链（MSYS2 + MinGW-w64），**全程不需要管理员权限，
> 也不需要 2–4 GB 的 Visual Studio**。

---

## 界面速览

> 截图均为内置演示数据（浏览器演示库自动生成），非真实业务数据。

| 我的一天 | 全部 · 常驻详情面板 |
| --- | --- |
| ![我的一天](docs/screenshots/my-day.png) | ![全部](docs/screenshots/all-tasks.png) |

| 工单 | 工单详情 · 过程态流转留痕 |
| --- | --- |
| ![工单](docs/screenshots/orders.png) | ![工单详情](docs/screenshots/order-detail.png) |

| 特殊单号 | 图库 |
| --- | --- |
| ![特殊单号](docs/screenshots/special-orders.png) | ![图库](docs/screenshots/gallery.png) |

| 工具：尺码表生成器（多工具标签条 + 头部重置） | 工具：AI 生成（阿里云百炼） |
| --- | --- |
| ![尺码表](docs/screenshots/tool-size-chart.png) | ![AI 生成](docs/screenshots/tool-ai-gen.png) |

| 设置 · 工具（启用停用 / 安装卸载 / 导入单文件） |
| --- |
| ![设置 · 工具](docs/screenshots/settings-tools.png) |

| 侧边栏紧急区（剩余时间不足自动聚合） | 左右面板宽度可拖拽 |
| --- | --- |
| ![紧急区](docs/screenshots/urgent.png) | ![面板拖宽](docs/screenshots/resizable-panels.png) |

---

## 技术选型（已定稿）

| 层 | 选型 | 说明 |
|---|---|---|
| 桌面外壳 | Tauri 2.x | 复用系统 WebView2，安装包约 10 MB |
| 前端 | React 19 + TypeScript + Vite | |
| 样式 | Tailwind CSS v4 | |
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
  "version": "1.0.0",
  "icon": "crop",
  "entry": "index.html",
  "dbVersion": 1
}
```

扫描顺序（后者覆盖前者，便于用户替换内置工具）：

1. 安装包内 `<resources>/tools/`
2. 用户数据区 `%APPDATA%/com.sogapopo.todo-workbench/tools/`

**工具目录放用户数据区而非安装包，是"可更新"设计的一部分**：
新增工具只需往该目录丢一个文件夹，不必重新打包发版。

### 工具是可配置的模块

设置 → 工具里每个工具一行。四件事刻意分开，别混为一谈：

| 维度 | 动的是什么 | 说明 |
|---|---|---|
| 启用 / 停用 | 配置 `tools.disabled` | 只是不在侧边栏出现，工具文件还在 |
| 安装 / 卸载 | `%APPDATA%/…/tools/<id>/` | 自己导入的工具删了就没了；内置工具删了能从安装包再装回来 |
| 保持状态 | 配置 `tools.keepState` | 默认开：切走再切回来还是你离开时的样子 |
| 关闭运行 | 本次会话的挂载集合 | 释放那个工具占用的内存与后台计算 |

**「保持工具状态」是怎么做到的**：打开过的工具不卸载，只是隐藏 ——
iframe 的文档一直活着，里面的变量、DOM、滚动位置都还在。两个实现上的硬约束：

- **帧的 DOM 顺序必须稳定**。iframe 在 DOM 里挪一下（哪怕只是换了个兄弟顺序），
  浏览器就会重新加载它，状态照样丢。所以按打开顺序渲染，用 CSS 切换可见性，
  绝不按"当前是否活跃"重排。
- **同一时刻只能有一个工具头部**。头部画在每个帧里面的话，隐藏的帧会各留一个
  `<header>`，自动化里 `locator("header").last()` 就会抓到隐藏的那个。

想回到初始态，按工具头部的「重置」；关掉这个开关则退回"切走即卸载"。

**内置工具的卸载为什么要多一个清单文件**：启动时 Rust 会把安装包里内置工具
同步到用户数据区（这正是"新增工具不必重新发版"的前提），所以只删目录的话，
下次开机会自己回来。因此卸载内置工具要同时往 `<appData>/tools/.uninstalled`
记一笔，Rust 侧同步时跳过清单里的 id。

**单文件导入**：设置 → 工具 → 选择 HTML 文件 → 确认名称与 id 即可。
CSS/JS 必须内联，相对引用不会跟着进来（原因见 `ToolHost` 里那段 asset 协议说明）。

### 数据隔离

所有表在同一数据库文件中，但命名空间严格分开：

- `core_*` —— 宿主核心（`core_lists` / `core_tasks` / `core_steps` / `core_settings`）
- `tool_<id>_*` —— 各工具私有表，由 `toolTable()` 强制生成前缀

卸载或回滚某个工具，不影响待办数据。

### 更新机制（两层）

**第一层，应用本体升级。** `tauri-plugin-updater` + 签名 + 静态 `update.json`。
⚠️ **签名密钥必须先生成并离线备份**——私钥丢失后，再也发不出能被老版本接受的更新。
建议做成"后台静默下载 + 提示重启"，不做强制更新。

**第二层，工具与数据结构独立演进。** 工具目录放用户数据区（见上），
数据库迁移从第一天就版本化（`PRAGMA user_version` + `src/lib/migrations.ts`）。
一旦用户已有数据再补迁移机制，就只能手工修库了。

---

## 目录结构

```
main/
  src/
    core/            待办核心逻辑（规划中，当前在 lib/repo.ts 内）
    lib/
      db.ts          数据库抽象层（双驱动）
      migrations.ts  版本化迁移定义
      repo.ts        业务数据仓库
      tools.ts       工具扫描与校验
      toolDemo.ts    工具数据隔离演示
      icons.ts       图标名映射
    components/
      Sidebar.tsx    侧边栏（智能视图 + 工具区 + 清单）
      TaskList.tsx   任务列表主体
      TaskRow.tsx    单条任务
      ToolHost.tsx   工具容器
    store.ts         Zustand 全局状态
    types.ts        数据模型
  tools/             内置工具（随安装包分发）
    image-crop/
  src-tauri/         Rust 端：插件注册、工具同步、打包配置
```

---

## 怎么启动

### 最省事的方式：双击脚本

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

浏览器模式下顶栏显示「内存库」状态标（数据存在 localStorage）；
桌面模式下自动切换为 SQLite 文件数据库，顶栏变为「SQLite」。

> 两个模式共用同一份业务代码，所以浏览器里验证过的功能，打包后行为一致。

装完 Rust 后**必须重新打开命令行窗口**（环境变量需要刷新），否则会提示找不到 cargo。

首次 `npm run tauri dev` 要编译 Rust 依赖，约 3–10 分钟；之后增量编译只需几秒。

---

## 项目自检

**不确定环境缺什么？先跑这个：**

```bash
npm run env:check    # 环境自检，逐项报告缺什么、怎么补
```

它只读不写，不会安装或修改任何东西，最后给出一份纯文本报告。

改完代码想确认没弄坏东西，跑这三个：

```bash
npm run typecheck      # TypeScript 类型检查，应 0 错误
npm run smoke          # 逻辑单测 58 项（数据库层 / 仓库层 / 工具隔离）
npm run icons:check    # 图标格式校验（PNG 结构 + ICO 各帧）
npm run webview2:check # 校验 WebView2Loader.dll 与 Rust 依赖版本一致
npm run bat:check      # .bat 规范检查（纯 ASCII + CRLF + 无 BOM）
npm run dev            # 另开一个窗口跑，然后：
node tests/browser.mjs   # 真实浏览器端到端 55 项（自动用本机 Edge）
```

`tests/browser.mjs` 会启动 Edge 走完整交互流程：新建任务、完成、切换各视图、搜索、
新建列表、打开工具、建工具表、刷新验证持久化，最后报告通过数。

> 注：`npm run smoke` 内部用 esbuild 先打包再运行——Node 的 ESM 解析不认
> 无扩展名的 TS 导入，这一步不能省。

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

## 迁移规范（不可破坏）

1. 只追加，已发布的迁移脚本**永不修改**——用户库里可能已经跑过它
2. 每个迁移是一个原子事务，失败整批回滚，绝不留半截 schema
3. 核心表用 `core_` 前缀，工具表用 `tool_<id>_` 前缀，两套迁移互不干扰
4. SQLite 的 `ALTER TABLE` 能力有限，涉及重建表时用
   "建新表 → 拷数据 → 删旧表 → 改名"四步法

---

## 待办事项

- [x] 生成 updater 签名密钥并填入 `tauri.conf.json` 的 `pubkey`
- [x] 补齐应用图标（14 个文件，含多尺寸 ICO）
- [x] 环境自检脚本 `npm run env:check`
- [x] GNU 工具链配置脚本 `npm run setup:gnu`
- [x] **跑通首次桌面打包**（产出 2.55 MB NSIS 安装包，无提权）
- [x] **修复「装得上但启动报找不到 WebView2Loader.dll」**（DLL 未被打进安装包）
- [x] **修复 6 个 `.bat` 在 cmd 下被解析成乱码**（改为纯 ASCII 启动器 + Node 实现）
- [x] **修复打包完成后因签名密码提示而卡死**（cmd 的 `set "VAR="` 会删除变量）
- [ ] 实机安装一次，确认应用能正常启动 + 工具目录同步 + SQLite 落盘
- [ ] 部署 `update.json` 到可达的静态地址
- [ ] 任务详情面板（步骤、备注、提醒时间）
- [ ] 拖拽排序
- [ ] 系统通知提醒
- [ ] 订单记录工具

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
这是「把安装包做到最小」的极限设置，首次全量编译约 **25–30 分钟**。
想快可以改成 `lto = "thin"` + `codegen-units = 16`，代价是安装包大约 2–5 MB。

期间没有输出是正常的，用这个看进度：

```bash
npm run build:status
```

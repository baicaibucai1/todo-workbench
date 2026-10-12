# 工具注入 · 标准流程（SOP）

这份文档回答的是**"往这个工作台里加一个工具，具体要做哪几步"**。

`docs/tool-authoring-and-injection.md` 讲**契约**（工具能调什么 op、manifest 每个字段什么意思）；
这份讲**流程**（加一个工具要动哪些文件、按什么顺序、漏了会怎样）。两者不重复。

--------------------------------------------------------------------------
## 零、四条入口，先分清是哪一条

| 入口 | 谁在用 | 产物落在哪 | 要不要改宿主代码 |
|---|---|---|---|
| **内置工具** | 这个项目自己 | 仓库 `tools/<id>/` | 要，七处登记点（见 §一） |
| **用户导入** | 设置 → 工具 | `<appData>/tools/<id>/` | 不要 |
| **网址安装** | 设置 → 工具 → 从网址安装 | 同上 | 不要 |
| **AI 助手代写** | 悬浮球里的助手 | 同上 | 不要（走 `install_tool`） |

四条入口**最终是同一件事**：`<工具目录>/manifest.json` + 入口 HTML。
区别只在"这份目录是谁写进去的"。

--------------------------------------------------------------------------
## 一、新增内置工具

### 第 1 步：一条命令建骨架

```bash
npm run tool:new <id> --name "工具名" --icon crop
```

它会：

1. 从 **`tools/scratchpad`** 派生一份界面（正牌模板就是它，见 §五）
2. 生成 `tools/<id>/manifest.json`
3. 自动同步其余登记点（下面那张表里的 2–6）

常用参数：

| 参数 | 作用 |
|---|---|
| `--blank` | 不用 scratchpad，用 `scripts/tool-skeleton.html` 那个最小骨架 |
| `--from <id>` | 从另一个已有工具派生 |
| `--template` | 打上 `tags:["template"]`（样板工具：设置页挂徽章、默认停用） |
| `--dry-run` | 只看会改什么，不落盘 |
| `--no-patch` | 只建目录，不动别的文件 |

### 第 2 步：跑审计

```bash
npm run tool:audit
```

不一致就退出码 1。它把下面这七处跟 `tools/<id>/manifest.json` 逐项对账：

| # | 登记点 | 漏了会怎样 |
|---|---|---|
| 1 | `tools/<id>/` + `manifest.json` | **唯一真源** |
| 2 | `src/lib/tools.ts` 的 `BUILTIN_TOOLS` | 手抄 manifest。漏了 → 浏览器 demo 里根本没有这个工具；抄错版本号 → demo 与桌面端跑着两份不同的工具 |
| 3 | `tests/tool-registry.mjs` 的 `ALL_TOOL_IDS` | 设置页条数那条断言会红 |
| 4 | 同文件的 `ENABLED_TOOL_IDS` | 侧边栏条数那条断言会红 |
| 5 | 同文件的 `THEME_TOOLS` | 漏一个 = 那个工具的深浅色**没人测** |
| 6 | `README.md` 工具表（含那句「表里的 N 个」） | 文档对不上 |
| 7 | `scripts/sync-tools.mjs` 的 `SOURCES` | 只针对镜像工具，见 §四 |

> **那些写死的数字为什么不改成自动推导**
> 写死是为了让"多出一个陌生工具"能被立刻发现，而不是悄无声息地出现在用户
> 的侧边栏里。自动推导出来就永远相等，那道防盗门等于拆了。
> 所以做法是：数字集中到 `tests/tool-registry.mjs` 一处（由 `tool:new` 维护），
> 再由 `tool:audit` 拿它与 `tools/` 对账。

### 第 3 步：只有人能做的三件事

1. 把 `index.html` 里那句 TODO 换成真说明（"它不是什么"最好懂）
2. 拍一张 README 截图（`scripts/gen-readme-shots.mjs`）
3. 勾了 `--template` 的话，去 `src/lib/settings.ts` 的 `DEFAULT_SETTINGS` 把它加进默认停用清单

--------------------------------------------------------------------------
## 二、导入（用户侧）

设置 → 工具，有四个入口：

| 入口 | 认什么 | 说明 |
|---|---|---|
| **把文件拖到工具页任意位置** | `.html` / `.zip` | 松手弹确认框（与下面按钮同一个框） |
| 选择 HTML / ZIP | `.html` / `.htm` / `.zip` | 单文件要求 CSS/JS 内联；zip 按 `manifest.json` 定位工具 |
| 从网址安装 | `http(s)://…` | **先下载、后确认**：zip 显示包内容清单，HTML 先过自包含体检 |
| 某个工具行的 ↻ | `.zip` | 就地更新那一个工具（见 §三） |

### 单文件 HTML：先抓取打包，再体检兜底（2026-10-12 定稿，两轮迭代）

单文件工具运行在**离线 iframe**（asset 协议）里，页面引用的外部资源活不成：
防盗链（tool.lu 实测 `403 X-Error-Info: EmptyReferer`）、Chromium 的 ORB（`ERR_BLOCKED_BY_ORB`）、
整站导航挤进工具区。所以安装前的处理分两层（`src/lib/toolInline.ts` + `toolHtmlScan.ts`）：

**第一层：抓取打包（`inlineExternalResources`，能救的都救）**

- `<script src>` → 内容内联（转义 `</script` 与 `<!--`；剥 src/integrity/crossorigin/defer/async，
  留 type=module）
- `<link rel=stylesheet>` → `<style>`，内容里的 `url(...)` / `@import` **递归**抓成 data: URI
  （图片/字体按魔术字节猜 MIME，Content-Type 瞎写的站点靠 sniff 兜底）
- `<img src>` → data: URI，**丢掉 srcset/sizes**（留着就会去抓外链）
- favicon → 抓得到就内联，抓不到静默删掉
- 抓取走 Rust `tool_fetch`：**浏览器 UA + 页面地址当 Referer** —— 防盗链看的就是这两样
  （tool.lu 的 CDN 对空 Referer 直接 403）。下载器由调用方注入（`toolSubresourceFetcher()`），
  本模块在 Node 里用本地 http 服务器做真实端到端测试（`npm run inline:test`，25 项断言）
- **静态扫描防欺骗**：内联 JS 里的 `document.write("<script src='"+x+"'>")` 模板会被正则
  当成真标签 —— `plausibleRef()` 挡掉（含引号/加号/美元符拼接痕迹、无路径无扩展名的一律不抓不报）
- ⚠️ 属性剥离的正则必须**循环剥到稳定**：全局替换一遍时前一个匹配吃掉属性间空格，
  下一个属性就不满足 `\s+` 前缀而幸存（实测 crossorigin 就是这么漏的）

**第二层：体检兜底（抓不齐的才亮警告）**

- 抓取失败的进 `failed`，导入框红色警告 + 必须勾「我明白外部资源加载不到，仍要安装」
- 打包完再扫一遍（`scanExternalRefs`），剩下的外部引用照样报
- 超过单文件上限（8MB）整体放弃

**打包救不了的要说明白（`detectServerCalls`）**：页面代码里 fetch/XHR/$.ajax/axios/外域 form
action → 确认框里黄条提醒「界面离线能显示，但依赖服务器的功能（如 tool.lu 的服务端渲染条码）
用不了 —— 这不是安装出了问题」。

从网址装 HTML：**先下载到内存 → 分流 zip/HTML → 抓取打包 → 体检 → 再弹确认框**。
zip 从网址来同样先看到包里有什么再确认。

拖放入口的实现要点（`ToolsSection.tsx` + `tauri.conf.json`）：

- **`dragDropEnabled: false` 是前提**。Tauri 的原生拖放处理器（默认开启）会吃掉
  OS 级拖放事件，DOM 收不到 HTML5 拖放 —— tauri-utils 源码原话：
  *"Disabling it is required to use HTML5 drag and drop on the frontend on Windows"*。
  改成 false 后，AgentView 拖图、工具拖入才真正可用（2026-10-12 之前它们在桌面版里是哑的）。
- 关掉处理器后，**没接手 drop 的区域松手 = 整页被导航到那个文件**，所以 `App.tsx`
  在 window 级拦掉所有带文件的 dragover/drop 默认行为（已接手的区域自己会 preventDefault，互不影响）。
- dragenter/dragleave 在子元素间成对触发，提示层的显隐用**深度计数**，不然拖过边界就闪。
  dragover 是连续触发（跟 mousemove 一样），里面**只 preventDefault、不 setState**。

### zip 包可以是两种形状

```
一个工具：                     一整包：
  manifest.json                 tools/
  index.html                      image-crop/manifest.json
  ai/ort.js                       image-crop/index.html
                                  notes/manifest.json
                                  …
```

识别办法是**找 `manifest.json`**：它所在的那层目录就是一个工具的根。
所以同一个包既能新装一个，也能一次更新六个 —— Release 上那份工具包正是后一种形状。

### 三条安全边界（`src/lib/toolZip.ts` 里钉着）

- **路径穿越**：`..`、反斜杠、盘符、绝对路径一律拒绝，被跳过的条目会在确认框里报出来
- **长度说谎**：本地头里的长度可能是 0，一律以中央目录为准，解压后再对一遍
- **CRC 校验**：解压完算一遍 CRC32，对不上就报错（抓的是传输中损坏的包）

只支持 `store` 与 `deflate` 两种压缩方式，其余一律报"不认识"而不是猜。
23 项断言钉在 `npm run zip:test`。

--------------------------------------------------------------------------
## 三、更新一个工具

两种办法，结果一样：

1. **点某个工具行的 ↻** → 选 zip → 包里那个工具会被强制装到这个 id
   （包里 manifest 写的 id 跟它不一致时也能更新，否则会变成"装了个新的、旧的还在"）
2. **选择 .zip 工具包** → 确认框里会逐条列出「新装 / 更新 v1.0.0 → v2.0.0」，
   只要包里有已存在的 id，就必须勾「覆盖已有工具」

覆盖的写法是**先写新的、再删多余的**（旧包里有、新包里没有的文件会被删掉）。
不先删是因为：中途失败时前者留下"新旧混合"，后者留下"工具没了"。

**工具存的数据不动** —— 表还在，只是 `dbVersion` 可能 +1（schema 变了才加）。

--------------------------------------------------------------------------
## 四、镜像工具（源文件在仓库外）

`size-chart` 与 `image-crop` 是外部 HTML 的**逐字节镜像**，源文件不在 git 里：

```js
// scripts/sync-tools.mjs
const SOURCES = {
  "size-chart": "../图片裁剪/尺码生成器/size-chart.html",
  "image-crop": "../图片裁剪/图片裁剪工具/index.html",
};
```

**只改 `tools/<id>/index.html` 会被 `npm run tools:sync` 冲掉**（方向是 源 → 工具）。
所以改完之后必须**回灌**：

```bash
cp tools/<id>/index.html <源路径>
npm run tools:check      # 复检
```

动手前先把源文件 `cp` 一份 `.bak-<时间戳>`。
`npm run tool:audit` 的第 5 节也会盯这件事，镜像不一致它会直接报错。

--------------------------------------------------------------------------
## 五、模板：改的是 `tools/scratchpad`

这个项目里**唯一的正牌模板**是 `tools/scratchpad`（设置页挂「参考模板」徽章、默认停用）。

- 要改模板 → 改 `tools/scratchpad` 本身
- 要新写工具 → 照它派生（`npm run tool:new` 默认就是这么做的）
- **别的 AI / 会话来读这个项目时，也以它为参考** —— 宿主状态机、主题跟随、
  数据层门面、独立运行兜底那四段的写法都在它里面，不要另起一套

它演示的正是这四段：

| 段落 | 关键约定 |
|---|---|
| 宿主状态机 | `body.dataset.bindState`：`booting → bound`；1200 ms 没等到就按 `parent === window` 分成 `standalone` / `error` |
| 主题跟随 | 连着宿主时跟 `ctx.theme`；独立打开时跟系统 `prefers-color-scheme`。`color-scheme` 那条声明不能省 |
| 数据层门面 | 连着宿主走 `row.*`，独立走 `localStorage`（键必须带工具 id：`wbtool:<id>:t:<table>`） |
| 独立运行兜底 | 宿主专属控件标 `data-host-only`，**靠 CSS 藏**（`[hidden]` 打不过作者样式里的 `display:flex`） |

--------------------------------------------------------------------------
## 六、注入组件（工具嵌进宿主界面）

工具除了占一个整页，还能嵌进待办界面。manifest 里声明：

```json
"injects": [
  { "kind": "detailSection", "label": "库存", "height": 200 },
  { "kind": "rowAction",     "label": "查库存" },
  { "kind": "detailAction",  "label": "同步" }
]
```

只开放这三个位置（`detailSection` / `rowAction` / `detailAction`）——
它们都局限在某一条待办上，一个组件写得再糟，影响面也就是一个面板。
`nav` 与 `view` 是全局的，不由运行时装进来的 HTML 占。

**外部输入按白名单过滤**（`normalizeInjects`）：认不出来的 kind 直接丢掉，
同一 kind 只认第一条。宿主侧由 `injectsFor()` 统一分发，三个挂载点都问它 ——
"哪些工具声明了注入"只有一处答案。

改注入声明不需要 `tool:new`，但要重跑 `tool:audit`（`BUILTIN_TOOLS` 是手抄的）。

--------------------------------------------------------------------------
## 七、自检清单

改完任何一个工具，按顺序过一遍：

```bash
npm run tool:audit    # 七处登记点对账（必过）
npm run zip:test      # 改过 toolZip 才需要
npm run tools:check   # 镜像工具一致性
npm run typecheck     # 类型
```

手工确认：

- [ ] 桌面端（不是 demo）里打开过一次
- [ ] 单独打开 `tools/<id>/index.html` 也能用，界面上明说了"独立运行"
- [ ] 切深色后工具内部跟着变（不是只有外壳变）
- [ ] 工具存的数据落在 `tool_<id>_*` 表里，没碰 `core_*`

--------------------------------------------------------------------------
## 八、报错对照

| 报错 | 意思 | 怎么办 |
|---|---|---|
| `已经存在 id 为「x」的工具目录` | 撞 id 了 | 换个 id，或勾「覆盖已有工具」 |
| `这个压缩包里没找到可以装的工具` | 包里没有 `manifest.json`，也没有 HTML | 确认打包的是工具目录本身，不是它的父目录 |
| `不支持的压缩方式（N）` | 用了 bzip2/lzma/zstd 或加密 | 用普通 zip（store 或 deflate）重新打 |
| `条目「…」校验失败（CRC 对不上）` | 包在传输中损坏 | 重新下载 |
| `对方返回 404` / `下载失败` | 网址不对或没网 | 网址走 Rust 下载，没有 CORS 问题；404 就是地址真不对 |
| `这个包里有 N 个工具，没法整体更新到「x」` | 点了某个工具的 ↻，但包里有多个 | 改用「选择 .zip 工具包」 |
| `has no column named X` | 表加了列但库里还是旧表 | 唯一的路：`dbVersion` +1，然后让用户到 设置 → 数据库 清理这个工具的数据（会丢数据，必须提前说） |

--------------------------------------------------------------------------
## 相关文档

- `docs/tool-authoring-and-injection.md` —— 契约全文（op 表、manifest 逐字段、注入组件专章）
- `docs/tool-runtime-anatomy.md` —— 装载与桥的实现解剖
- `docs/architecture-and-extensions.md` —— 扩展注册表

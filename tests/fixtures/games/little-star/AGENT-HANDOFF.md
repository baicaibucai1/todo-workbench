# 交接提示词（给别的 agent）：Little Star 项目

本文件有两段：**第一段是可直接复制粘贴给新 agent 的开场白**，第二段是给人类/你自己看的
隔离与协作说明。需求来自一句原话：「我觉得你一个人似乎忙不过来，给一个提示词，用于别的
agent 定位到当前项目，以及介绍大致情况，创建 worktree 以避免相互干扰」。

---

## 一、可直接粘贴的开场提示词

```text
你在做一个 three.js 单星系沙盘项目 Little Star（零依赖 / 零框架 / 零打包，浏览器只加载一个 game.js）。

【坐标】
- 活目录：C:\AI_Production\Tools\main\tests\fixtures\games\little-star\
- 它所在的 git 仓库是 C:\AI_Production\Tools\main（分支 main，远端 baicaibucai1/todo-workbench）。
  little-star 已在 commit e2f9f9b 入库，并用 .gitattributes 把该文件树锁成 LF 行尾（理由见下）。
- ★ 唯一必读入口：该目录下的 README.md（跑法 / 文件职责 / 约定 / SOP / __game 调试 API /
  测试大纲 / 截图索引 / 踩坑 / 版本沿革都在里面）。动手前先完整读一遍。

【当前状态】版本 v0.11.0，源码是 src/ 下 18 个片段 + 拼装产物 game.js（4863 行），
浏览器回归 verify.mjs 共 23 节 / 196 项，当前全绿。最近一版做的是「地形生成器」：
固态行星的表面由一条环境无关的高程场管线算出来（3D 噪声 → 上采样 → 陨击坑 / 河网 →
高度分带 + hillshade → 导出颜色图与凹凸图），聚焦时从 768px 升级到 2048px。

【先做隔离，再动手】别直接在 C:\AI_Production\Tools\main\... 里改，那是主负责人的活目录。
用 git worktree 给自己开一份独立工作区（源码已入库，拉下来是齐的）：

  cd C:/AI_Production/Tools/main
  git worktree add C:/AI_Production/_wt/ls-<你的角色名> -b ls/<你的角色名> main

进去先验环境是好的 —— 这两条必须一条不红，且不需要任何手工修正：
  cd C:/AI_Production/_wt/ls-<你的角色名>/tests/fixtures/games/little-star
  <node> scripts/build.mjs --check     # ✓ game.js 与 src/ 一致（18 个片段 · 4863 行）
  <node> scripts/roll-check.mjs        # ✓ 0.374455 / 命中 M
干完活在**该 worktree 里**提交（它自带 git 指向），由主负责人 merge 回 main；
收尾 `git worktree remove C:/AI_Production/_wt/ls-<你的角色名>`。
★ worktree 必须建在 C:\AI_Production\Tools\main **外面**（推荐 C:\AI_Production\_wt\）。

【本机硬约束（踩了会卡很久）】
- 一律用受管 node 绝对路径：C:/Users/Sogap/.workbuddy/binaries/node/versions/22.22.2-6/node.exe
- 本机 Node 不能 spawn 子进程（spawnSync 一律 EBUSY），所以没有「一键跑全部」的 runner，三条命令逐个跑：
    node scripts/build.mjs      # 把 src/ 拼成 game.js（改完源码必跑）
    node scripts/roll-check.mjs # 确定性守恒静态复算（秒级）
    node verify.mjs             # 浏览器全量回归（约 1 分半，自带 4322 端口）
- 端口：4321 = 常驻预览（serve.mjs，支持传参换端口：`node serve.mjs 4399`）；
  4322 = verify.mjs 自带且写死。**同一时刻只能有一个 verify 在跑**，多人并行请串行排队。
- 不要把工作目录建在 C:\AI_Production\Tools\main 里面：那里有常驻的 vite dev server
  递归 watch 整个工程，会把新目录锁住（改名 / 删除报 Permission denied）。

【★ 不可破坏的约定（一眼先看这五条）】
1. 确定性守恒：世界生成与贴图共用主 RNG —— 只要改动「消费主 rng 的函数」的顺序 / 数量，
   或增删场景对象，整个星系布局就会错位。改完必跑 roll-check
   （锚点：884 抽 / f = 0.374455 / 命中 M 型）。唯一豁免：地形管线 42-terrain.js 是零 RNG 的
   （随机走「种子 × 坐标」哈希），所以可以放心改地貌。
2. 别手改 game.js：它是 src/ 的拼装产物。改 src/ 后跑 build.mjs。
3. 片段顺序不许重排：18 个片段同处一个 IIFE、裸标识符互引，顺序 = 顶层执行顺序。
   加 / 改片段要同步 scripts/build.mjs 的 ORDER 与 verify [0] 的写死数字。
4. 视觉偏好：主角感 = 干净球体，花活越少越好（历史上冕流尖刺 / 日冕壳 / 日珥弧都被否过）。
   UI = 黑白灰 + 2px 中灰外框 + 圆角两档（8/4px）+ 无阴影无渐变；白只给线与字，不给面。
5. 仓库里有别人的 WIP（README.md / src/lib/tools.ts / tests/fixtures/tools/index.json /
   tests/tool-registry.mjs 当前都有未提交修改，不是你改的）：`git add` 只列自己的路径，
   绝不用 -A / .。

【交付纪律】先交付边界清晰的小检查点，并在结尾明确列出「这次没做什么」，别一口气全做完。
【验收标准】三条命令全过，且 verify 输出「196/196 通过」，四个确定性锚点一格未动。
【别动别人的 WIP】仓库根的 README.md / src/lib/tools.ts / tests/fixtures/tools/index.json /
tests/tool-registry.mjs 有别人的未提交改动（不是你改的，也不是我们的任务范围）。
```

> 复制前可按实际情况微调两处：`<你的角色名>`（如 terrain / ui / guide）和预览端口号。

---

## 二、项目速览（给人类看的背景）

| 项 | 值 |
| --- | --- |
| 名称 | Little Star —— three.js 单星系沙盘（恒星 15 型 + 行星 16 型 + 小行星带） |
| 位置 | `C:\AI_Production\Tools\main\tests\fixtures\games\little-star\` |
| 载体仓库 | `C:\AI_Production\Tools\main`（`main`，origin `baicaibucai1/todo-workbench`） |
| git 状态 | **已入库**：commit `e2f9f9b`（28 个文件）+ `a79d61a`（`.gitattributes`）。两个 `-archive/` 兄弟目录仍未入库 |
| 体积 | 47 个文件，4.8 MB（含 three.min.js 与 screenshots）；入库的 28 个约 1.1 MB |
| 版本 | v0.11.0（地形生成器），`src/` 18 片段，`game.js` 4863 行 |
| 回归 | `verify.mjs` 23 节 / **196 项**，当前全绿；截图每次跑会清空重建 |
| 入口文档 | 同目录 `README.md`（唯一必读） |

一句话讲清它在干什么：**所有贴图与所有数值都由物理量算出来**，没有手绘贴图、没有硬编码的
天文数字。玩家点击天体看科学数据；v0.8 长出文明选址、v0.9 长出资源账、v0.10 长出聚焦镜头、
v0.11 长出固态行星的真实地表。

---

## 三、隔离方案（已就绪：直接用 worktree）

### 已经做完的两步（2026-10-15）

1. **入库**：`e2f9f9b` 提交了 28 个文件（`src/` 18 片段 + `game.js` + `three.min.js` +
   `index.html` / `style.css` + 三个脚本 + `README.md` + 本文档）。只 `git add` 了
   `tests/fixtures/games/little-star` 这一条路径 —— 别人的 WIP 一个没动。
   同级的两个只读归档（`little-star-v02-archive/` / `little-star-v061-archive/`）**没入库**。
2. **锁行尾**：`a79d61a` 加 `.gitattributes`（该目录整棵 `text=auto eol=lf`）。
   这一步不是洁癖，是被逼的 —— 见下面那条踩坑。

### ★ 踩过的坑：为什么必须锁 LF

本仓库全局 `core.autocrlf = true`。worktree / clone 一检出，文件行尾全变 CRLF；
而 `verify [0]` 是 `game.js` 与 `src/` 拼装结果的**逐字节**比对 —— 实测第一次开 worktree
时它直接报「不一致」。事后跑 `build.mjs` 重拼虽能压下去，但那样每换一份副本都要重拼，
而且 `git diff` 会满屏行尾改动。锁成 LF 之后，**新 worktree 检出即可用**（已实测：
`build.mjs --check` 直接绿，无需任何手工修正）。

> 由此也得到一条通用教训：**给要做「产物 vs 源码」逐字节比对的项目建 worktree 之前，
> 先确认仓库的 autocrlf 设置**，必要时用 `.gitattributes` 把那棵子树钉死。

### 默认方案：真 worktree

```bash
cd C:/AI_Production/Tools/main
git worktree add C:/AI_Production/_wt/ls-<角色名> -b ls/<角色名> main
cd C:/AI_Production/_wt/ls-<角色名>/tests/fixtures/games/little-star
<node> scripts/build.mjs --check      # 应当直接绿

# 干完活在**该 worktree 内**提交（分支 ls/<角色名>），由主负责人 merge 回 main
# 收尾清理：
cd C:/AI_Production/Tools/main && git worktree remove C:/AI_Production/_wt/ls-<角色名>
```

- ★ **必须建在 `C:\AI_Production\Tools\main` 外面**（推荐 `C:\AI_Production\_wt\`）：
  建在里面会被常驻 vite dev server 的递归 watch 锁住目录，删除时 Permission denied。
- ★ 当前 worktree 列表：`git worktree list` 只有本体（`main @ a79d61a`）。验证用的临时
  worktree 已清理；下次要验就再建一个，走完记得 remove。

### 备选：物理副本（完全不想碰 git 时）

```bash
ROLE=<角色名>
mkdir -p C:/AI_Production/_ls-work/$ROLE
cp -r C:/AI_Production/Tools/main/tests/fixtures/games/little-star/. C:/AI_Production/_ls-work/$ROLE/
```

没有版本历史，合并靠人工：`diff -rq <副本> <活目录>` 列差异后逐文件 cp 回来，
**严禁整目录覆盖**（会抹掉别人同时做的改动）。

### 不推荐：同一个目录分工

只在必须共用 4321 预览的短任务里做，严格划分「谁改哪些文件」，碰别人的文件前先打招呼。

---

## 四、协作规矩（多人同时干活怎么不打架）

1. **一个 agent 一个目录**，绝不两拨人同时写同一个 `little-star/`。
2. **端口分配**：主负责人占 4321（预览）+ 4322（verify）。其他 agent 的预览一律换端口：
   `node serve.mjs 4391`。**verify.mjs 的 4322 是写死常量**（`verify.mjs:74`），所以
   **同时只用一个人跑 verify**，其余排队；真要并发就先把副本里的 4322 改成别的号。
3. **改动粒度**：一个检查点 = 一个边界清晰的主题（例如「只做气态行星地形」或「只做 focussed HUD
   上的比例尺」），做完立刻交付并列出「没做什么」。
4. **共享事实**：这四条锚点是全项目的红灯 sulfonamide：`884 抽 / f = 0.374455 / 命中 M /
   星系名「薄曙」` —— 任何人跑完都得是这四个值。
5. **别碰别人的 WIP**：仓库根目录下 `README.md`、`src/lib/tools.ts`、`tests/fixtures/tools/index.json`、
   `tests/tool-registry.mjs` 有别人的未提交改动（`README.md` 指的是**仓库根**那份，不是 little-star 这份）。

---

## 五、建议的分工边界（按「一个人改哪几个片段」划）

| 角色 | 主要动哪些文件 | 说明 |
| --- | --- | --- |
| 地形 / 地貌 | `src/42-terrain.js`、`src/40-textures.js` | 零 RNG 区，最安全；气态行星地形还没做 |
| 镜头 / 交互 | `src/72-focus.js`、`src/70-camera-input.js`、`src/25-fsm.js` | 动状态机要同步 `[21]` 断言 |
| 面板 / UI | `src/80-panel.js`、`index.html`、`style.css` | 受 2px 黑白灰规范约束 |
| 指导书 / 科普 | `src/90-guide.js` | 13 栏，改栏目要同步 `[14]` 的写死数字 |
| 物资 / 文明 | `src/28-materials.js`、`src/27-species.js`、`src/35-civ.js` | 评分路径零 RNG，是铁律 |

**撞车预警**：`src/50-scene.js`（场景组装 + 每帧）和 `src/99-boot.js`（调试 API + 启动）
几乎是所有人的交汇点 —— 两个人同时改一定冲突，建议由主负责人独占。

---

## 六、验收与交付

```bash
NODE="C:/Users/Sogap/.workbuddy/binaries/node/versions/22.22.2-6/node.exe"
cd <你的工作目录>
"$NODE" scripts/build.mjs        # 或 --check 只比对不写盘
"$NODE" scripts/roll-check.mjs
"$NODE" verify.mjs               # 期望结尾：196/196 通过
```

交付三件套：改动清单（动了哪几个片段）+ 三条命令的输出尾行 + 明确写出的「这次没做什么」。

当前「没做什么」清单（下一个检查点的候选）：气态行星地形、真正的连续距离 LOD、
聚焦时其他天体变暗 / 隐藏、地表专业视图（坐标网格 / 剖面 / 比例尺）、
聚焦下的昼夜时间流速控制、触屏双指精细缩放系数。

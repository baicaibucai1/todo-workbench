/**
 * 工具装载子系统。
 *
 * 契约：每个工具是一个目录，内含 manifest.json + 入口 HTML。
 *
 *   tools/image-crop/
 *     manifest.json
 *     index.html
 *
 * manifest.json 结构见 types.ts 的 ToolManifest。
 *
 * 装载永远是**两次扫描**：只认磁盘上真实存在的工具目录
 *
 *   1. 用户数据区 <appDataDir>/tools/  —— 用户解压进去的、或自己丢进去的工具
 *   2. 安装包内 <resources>/tools/     —— 随安装包分发的内置工具
 *      （0.2.0 起**默认一个都没有**：安装包不再携带工具，见文末。）
 *
 * 关键设计：工具目录放在用户数据区而不是安装包内，
 * 这样新增工具不需要重新打包发版 —— 这正是"可更新"的一部分。
 *
 * ------------------------------------------------------------------
 * 安装包为什么不带工具了
 * ------------------------------------------------------------------
 * tools/ 里有 50 MB 的抠图模型（image-crop/ai，base64 分片塞在 .js 里）。
 * 把它写进 bundle.resources，每一个用户的每一次增量更新，都要为他可能根本
 * 用不到的那个工具下载几十兆 —— 而"工具可插拔"这件事本来就要求宿主不关心
 * 工具是从哪来的，放不进安装包从来不影响它能不能用。
 *
 * 所以 0.2.0 起：安装包本体不含任何工具文件，工具单独打成 zip 挂在同一份
 * Release 上（scripts/pack-tools.mjs），想要就下载解压；或者让内置助手现写一个。
 *
 * 由此带来一条硬约束，见 loadTools：**桌面端绝不能拿 BUILTIN_TOOLS 兜底**。
 * 否则新装的桌面版会列出四个点开就是"找不到入口"的工具 —— 侧边栏里看着有，
 * 实际打不开，比直接显示一个空列表糟糕得多。
 */

import { isTauri } from "./db";
import { validateToolSchema } from "./toolSchema";
import { CAPABILITY_NAMES } from "./extensions/registry";
import { normalizeInjects } from "./extensions/types";
import type {
  ToolActionParam,
  ToolActionSpec,
  ToolManifest,
  ToolSkillSpec,
} from "../types";

/**
 * 工具标签白名单。**外部输入，认不出来的一律丢掉** ——
 * 和 capabilities 一个道理：标签会出现在设置页的徽章上，
 * 不能让一个工具自己往那块地方贴任何它想写的字。
 *
 * `template` = 它是给写工具的人照着抄的样板，不是给用户日常用的功能。
 */
export const TOOL_TAG_NAMES = ["template"] as const;

/* ------------------------------------------------------------------ */
/* 内置工具清单（浏览器 demo 用；打包时由构建脚本生成真实的 tools/ 目录）  */
/* ------------------------------------------------------------------ */

/**
 * 内置工具在打包环境下由 Tauri 端读取 `tools/` 目录得到。
 * 浏览器 demo 没有文件系统，这里给出一份等价的静态清单。
 * 两者的 schema 完全一致，因此上层代码无需分支。
 *
 * 注意：浏览器模式下工具的 HTML 由 Vite dev server 直接服务
 * （`tools/` 在工程根目录下，见 resolveToolUrl），
 * 所以新增工具时除了往 tools/ 丢目录，也要同步在这里登记一条。
 */
const BUILTIN_TOOLS: ToolManifest[] = [
  {
    // 图片编辑器 Image Studio：与隔壁 图片裁剪/图片裁剪工具/index.html 是同一份文件，
    // 由 scripts/sync-tools.mjs 守着 SHA-256 一致性，改一边记得同步另一边。
    //
    // 它带一个可选资源目录 ai/（约 50MB 的抠图模型 + ORT wasm，base64 分片，
    // 用 <script src> 加载）。**整目录缺失不影响使用**，只是智能填充退回纯 JS ——
    // 所以打包时没有带上那 50MB，工具仍然完整可用。
    id: "image-crop",
    name: "图片裁剪",
    version: "2.0.0",
    description:
      "图片编辑器 Image Studio：裁剪 / 尺寸与比例 / 镜像 / 选区填充 / 批量导出；可从工作台图床直接取图，导出的图默认自动存回图床（开关可关）",
    icon: "crop",
    entry: "index.html",
    dbVersion: 1,
    author: "内置",
    // 它要把裁好的图存进图床 —— 那是**不属于自己**的共享资源，
    // 所以必须申请；宿主据此决定放不放行（见 extensions/registry 的能力门）
    capabilities: ["gallery"],
  },
  {
    id: "size-chart",
    name: "尺码表生成器",
    version: "1.1.0",
    description: "粘贴 Excel 尺码数据，套用主题生成可直接发布的尺码表图片；导出的图默认在工作台图床留一份（开关可关），同一份内容不重复占条目",
    icon: "list",
    entry: "index.html",
    dbVersion: 1,
    author: "内置",
    capabilities: ["gallery"],
  },
  {
    // 它是「一个网页工具怎么用宿主的数据表」的样板：manifest 里声明 schema，
    // 用结构化 CRUD 读写自己的 tool_scratchpad_notes，并能把一条内容交给别的工具。
    // 存在它，是为了让这套机制**有一个端到端跑起来的实例** —— 否则它只是文档。
    id: "scratchpad",
    // 名字就叫「模板」，不叫「随手记」也不叫「便签本」：
    // 它的用途是给人照着抄，不是给人日常记东西 —— 叫成便签本只会和旁边的
    // 「便签」打架，让人以为是两个重复的东西。id 仍是 scratchpad（改名会换
    // 表名，已经落在用户库里的 tool_scratchpad_notes 就找不着了）。
    name: "模板",
    version: "1.0.0",
    description:
      "写工具时照着抄的样板：演示一个工具怎么在工作台里建自己的表、用结构化 CRUD 读写它，以及把一条内容交给别的工具。默认停用，不是日常用的便签本",
    icon: "notebook-pen",
    // 打上样板标签，设置页会挂一枚「参考模板」徽章。
    // 注意它**只管显示**：让这个工具默认不出现的是 settings 里的停用清单。
    tags: ["template"],
    entry: "index.html",
    dbVersion: 1,
    author: "内置",
    schema: {
      tables: [
        {
          name: "notes",
          columns: [
            { name: "id", type: "text", pk: true },
            { name: "title", type: "text" },
            { name: "body", type: "text" },
            { name: "tag", type: "text" },
            { name: "created_at", type: "text" },
          ],
          indexes: [{ columns: ["created_at"] }],
        },
      ],
    },
  },
  {
    // 卡片式便签。与上面「模板」的区别要说清楚，否则会被当成重复造轮子：
    //
    //   · 模板是**列表**，且它的定位是"工具怎么用自己的数据表"的教学样板
    //     （manifest 里明写了），不该为了好看往里塞 UI；
    //   · 便签是**给用户用的**：卡片网格、六色、附图、输入即存。
    //
    // 两者共用同一套能力（私有表 + 图床），互不干扰 —— 表名按 id 隔离成
    // tool_notes_notes / tool_scratchpad_notes。
    //
    // 附图走图床（gallery.put 拿 id 存进 images 列），不自己存文件：
    // 图床已经是工作台里图的唯一落点，有缩略图、有界面、别处也能取用；
    // 便签只记 id，删便签也不会顺手删掉用户的图。
    id: "notes",
    name: "便签",
    version: "1.0.0",
    description:
      "卡片式便签：随手记一条、贴几张图，按颜色与标签分类。图床开着时图进图床（别处也能取用），没开就直接随签保存",
    icon: "sticky-note",
    entry: "index.html",
    dbVersion: 1,
    author: "内置",
    capabilities: ["gallery"],
    schema: {
      tables: [
        {
          name: "notes",
          columns: [
            { name: "id", type: "text", pk: true },
            { name: "title", type: "text" },
            { name: "body", type: "text" },
            { name: "tag", type: "text" },
            { name: "color", type: "text" },
            // 图条目的 JSON 数组。列类型只有 text/integer/real，多条图只能序列化成一列。
            // 条目两种形态混存：图床开着时是图床 id（宿主盖 origin 章），
            // 没开时是内联 dataURL（工具自己降级直存，不让选装模块挡住附图）。
            { name: "images", type: "text" },
            { name: "created_at", type: "text" },
            { name: "updated_at", type: "text" },
          ],
          indexes: [{ columns: ["created_at"] }],
        },
      ],
    },
  },
  {
    // 已接入 Agnes AI（生图 / 生视频 / 对话，OpenAI 风格接口）。
    // 服务商与能力都以「描述符」形式写在工具内部的 PROVIDERS 里，
    // 加一家新 API 只动工具，不用动宿主。
    id: "ai-gen",
    name: "AI 生成",
    version: "0.5.0",
    description:
      "文生图 / 图生图、文生视频与对话。已接入阿里云百炼（万相、千问图像、Z-Image 共 21 档，按族走各自接口）与 Agnes AI，出图默认自动存进图床（开关可关）、参考图可从图床挑，生成结果可一键放回参考图继续编辑",
    icon: "sparkles",
    entry: "index.html",
    dbVersion: 1,
    author: "内置",
    capabilities: ["gallery"],
  },
  {
    // 异常单号登记：登记 → 看 → 推进状态 → 删 的闭环，数据落在自己的私有表里
    // （tool_abnormal_ticket_tickets），与 core_tasks 和别的工具物理隔开。
    //
    // 与上面「模板」的区别要说清楚，否则容易被当成两个重复的东西：
    //   · 模板（scratchpad）是**教学样板**，定位是"工具怎么写"，默认停用；
    //   · 这个是**给用户用的功能**，为某个具体业务（异常单）量身做的。
    // 两者都用自己的私有表，表名按 id 隔离，互不干扰。
    id: "abnormal-ticket",
    name: "异常单号登记",
    version: "1.1.3",
    description:
      "登记页最上面是一条订单号大横条（整条 ERP 链接直接粘，订单号和店铺一起认出来），下面是快递单号 / 快递公司 / 登记时间，再往下是**胶囊状的店铺、情况选项**（点一下选中、再点一下取消），项和标题都带小图标。「查看」页里那条单子**随时能补全、能改**：订单号、快递单号、快递公司、登记时间、店铺、情况、详细描述、处理情况都开着，改完点「保存修改」一改就落库。其余：同一订单号重复登记会当场提示，还能跳到那条（再点一次才真录）；订单号形状不像拼多多单号时**只提示、照样能登记**。每条有订单号的单子都能一键呼起拼多多客户端打开那张订单（按店铺各自的客服 ID）；ERP 给的整条链接直接粘进订单号框，订单号和店铺一起认出来。状态不用手点：由「流程」最后一步或「处理」派生；流程记上「完结」就封口。提醒是流程的看门狗，**登记一条就自动订上 N 小时后的跟进提醒（出厂 24）**，之后每记一步流程自动顺延、流程很久没更新到点就提醒（列表挂「逾期 X 小时」、详情流程区亮警示），记到「完结」自动撤掉；间隔能在设置里改，单个单子也能改时刻或点名不用提醒。到点后工作台待办里多一条带来源标记的待办并弹提醒卡。「表格」页把整本台账一屏铺开（只读，点一行看详情，显示哪些列、列的顺序自己配）。「设置」页粘一条在线表格的分享链接就能绑定那张表（绑定后显示表名和创建人），之后在本工具里直接推送 / 拉取（推送按钮钉在页面右上角，「表格」页也有一份；**推送是增量的** —— 按单号比对，只写本地新增的行和值变了的那些格，表上已有的行不重写、表上有而本地没有的行留着不动；只写台账那 14 列，你自己加的列不动；推送前先摆出「新增几行、改几个格」，确认了才写；拉取先看差异、确认才写库；单号一律当文本写，不会变成科学计数法；授权在「设置 → WPS 授权」做一次）。五个下拉的选项、店铺表都能在设置里改。数据存在工具自己的表里，与待办数据互不干扰。界面加了些中性灰的小装饰：页头小标、页签图标、卡片标题竖条、分区标题延伸线、空态插画（虚线单据 + 放大镜），无阴影无渐变。色彩按页签分套点缀：登记蓝 / 查看青 / 表格紫 / 设置灰，用在页头四段色条、卡片标题竖条、大横条左缘、表头细线和空态插画的镜片上；列表行左缘还有状态色条（待处理黄 / 处理中蓝 / 已关闭绿），颜色带语义",
    // receipt（单据）已在 icons.ts 白名单里；写错会静默退回包裹图标
    icon: "receipt",
    entry: "index.html",
    // task 能力 = task.remind（订提醒落待办）。task.get 用不上：整页工具没有注入上下文
    // wps 能力 = wps.mcpLink / mcpPush / mcpPull / mcpApply：在线表格那张设置卡。
    //   比 task 重得多（能改用户云文档里的表），所以单独声明、单独受「确认启用」约束
    capabilities: ["task", "wps"],
    dbVersion: 6,
    author: "内置",
    schema: {
      tables: [
        {
          name: "tickets",
          columns: [
            { name: "id", type: "text", pk: true },
            { name: "order_sn", type: "text" },
            { name: "tracking_no", type: "text" },
            { name: "courier", type: "text" },
            { name: "shipped_at", type: "text" },
            { name: "store", type: "text" },
            { name: "title", type: "text" },
            { name: "category", type: "text" },
            { name: "handling", type: "text" },
            { name: "result", type: "text" },
            { name: "settled", type: "text" },
            { name: "note", type: "text" },
            // 0.8.0：flow = 流程轨迹（JSON 数组 [{n: 名称, t: ISO}]），
            // remind_at = 设的提醒时刻，remind_task = 宿主里代订的那条待办 id
            { name: "flow", type: "text" },
            { name: "remind_at", type: "text" },
            { name: "remind_task", type: "text" },
            { name: "created_at", type: "text" },
            { name: "updated_at", type: "text" },
          ],
          indexes: [{ columns: ["created_at"] }],
        },
      ],
    },
  },
  // 这里**没有五子棋**，是故意的。
  //
  // 它是《单 HTML 工具编写标准》的活样本，当初为了验证「AI 能不能自己写出
  // 合格的工具」而生成，从来不是要发给用户的功能。tools/ 下每多一个目录，
  // 工具包 zip 就多一份、设置页就多一行 —— 一份开发样本摆在那儿，等于让
  // 每个用户都收到一个他没要过的东西。
  //
  // 所以它搬去了 tests/fixtures/gomoku/（2026-09-24）：不进工具包、不进设置页，
  // 但契约测试照跑（npm run gomoku:test，59 项断言把标准逐条钉死）。
  // 标准写在文档里会漂，钉在测试上才不会 —— 只是那份测试现在明确指向夹具目录。
  {
    // 读、改、存回 WPS 里的一份表格 / 文档。与「异常单号登记」那套台账同步
    // 是两条路：那边是固定台账按列写回，这边是任意绑定文件按格编辑。
    id: "wpslink",
    name: "WPS 绑定文件",
    version: "0.5.0",
    description:
      "直接读写一份云文档：在「设置 → WPS 授权」里授权一次，点「读取我的文件」列出云文档根目录，点哪份绑哪份 —— 读的就是那份原文件，不复制、不经过知识库。表格按格编辑（可加行加列、删行），Ctrl+S 写回原表（长订单号当文本存，不会丢位）；智能文档改完直接存回。也能绑定知识库里的表格或文档（那条路要账号登录态，保存走「新建 → 删旧 → 改名」）—— MCP 只列得出根目录，知识库里的东西只有那条路进得去。",
    icon: "file",
    entry: "index.html",
    dbVersion: 1,
    author: "内置",
    // 读写都会借用户的账号动知识库，所以必须声明（见 toolBridge 的 wps.* 一族）
    capabilities: ["wps"],
  },
];

/** 内存中的已注册工具 */
let registry: ToolManifest[] = [];
let registryLocation = "内置清单（浏览器模式）";

/* ------------------------------------------------------------------ */
/* manifest 校验                                                       */
/* ------------------------------------------------------------------ */

/**
 * 校验 manifest。工具是外部输入，必须当作不可信数据处理 ——
 * 一个坏掉的 manifest 不应该让整个应用起不来。
 */
export function validateManifest(raw: unknown): ToolManifest | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;

  const id = typeof m.id === "string" ? m.id.trim() : "";
  const name = typeof m.name === "string" ? m.name.trim() : "";
  const entry = typeof m.entry === "string" ? m.entry.trim() : "";

  // id 会参与表名拼接，必须严格限制字符集，否则有 SQL 注入风险
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(id)) return null;
  if (!name || !entry) return null;
  // 禁止通过 ../ 逃逸出工具目录
  if (entry.includes("..") || entry.startsWith("/") || /^[a-z]+:/i.test(entry)) return null;

  return {
    id,
    name,
    version: typeof m.version === "string" ? m.version : "0.0.0",
    description: typeof m.description === "string" ? m.description : undefined,
    icon: typeof m.icon === "string" ? m.icon : "package",
    entry,
    dbVersion: Number.isInteger(m.dbVersion) ? (m.dbVersion as number) : 1,
    author: typeof m.author === "string" ? m.author : undefined,
    // 展示用标签。外部输入，按白名单过滤；一个都不认识就当没写。
    // 它只影响界面徽章，不参与行为判断（见 types.ts 的 tags）。
    ...(() => {
      const tags = (Array.isArray(m.tags) ? m.tags : []).filter((t): t is string =>
        typeof t === "string" && (TOOL_TAG_NAMES as readonly string[]).includes(t),
      );
      return tags.length ? { tags: [...new Set(tags)] } : {};
    })(),
    // schema 单独走一套校验（见 toolSchema.validateToolSchema）：它会被拼进 DDL，
    // 要求比普通字段严得多。**校验不通过就整个丢掉**，而不是留一半 ——
    // 工具因此只是"没有私有表"，row.* 会明确报出来，不会变成半残的可写状态。
    ...(() => {
      const schema = validateToolSchema(id, m.schema);
      return schema ? { schema } : {};
    })(),
    // 能力申请：要碰**不属于自己**的共享资源（目前只有图床）就得在这里写明。
    // 按白名单过滤，写什么奇奇怪怪的名字都会被丢掉；没写就是没有。
    ...(() => {
      const caps = (Array.isArray(m.capabilities) ? m.capabilities : []).filter((c): c is string =>
        typeof c === "string" && (CAPABILITY_NAMES as string[]).includes(c),
      );
      return caps.length ? { capabilities: caps } : {};
    })(),
    // 注入组件的挂载声明。同样是外部输入：只认白名单里的三个位置，
    // 认不出来的一律丢掉（见 extensions/types.ts 的 normalizeInjects）。
    ...(() => {
      const injects = normalizeInjects(m.injects);
      return injects.length ? { injects } : {};
    })(),
    // 命令声明（老式）：只认小写字母数字与连字符。保留它是为了让
    // 2026-09 之前写的 manifest 不用改 —— 新工具请写 actions。
    ...(() => {
      const cmds = normalizeCommands(m.commands);
      return cmds.length ? { commands: cmds } : {};
    })(),
    // 动作注册（新式）：助手驱动它干活用的完整声明。外部输入，
    // 名字/参数一律过白名单；老式 commands 里没被覆盖的会并进来。
    ...(() => {
      const acts = normalizeActions(m.actions, m.commands);
      return acts.length ? { actions: acts } : {};
    })(),
    // 是否允许宿主为它起隐藏实例。只有显式 true 才算开 ——
    // 写什么都好，默认一律关（理由写在 types.ts 的 headless 上）。
    ...(m.headless === true ? { headless: true } : {}),
    // 自带的使用说明。外部输入，字段长度一律收口；一份不合格就整个丢掉
    // （半截的技能比没有更糟：模型会照着半截的说明去调动作）。
    ...(() => {
      const skill = normalizeSkill(m.skill, name);
      return skill ? { skill } : {};
    })(),
  };
}

/** 命令名白名单。与 injects 同样的道理：认不出来的一律丢掉 */
export function normalizeCommands(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const c of raw) {
    if (typeof c !== "string") continue;
    const v = c.trim();
    if (!/^[a-z][a-z0-9-]{0,23}$/.test(v)) continue;
    if (!out.includes(v)) out.push(v);
  }
  return out.slice(0, 12);
}

/* ------------------------------------------------------------------ */
/* 动作注册                                                            */
/* ------------------------------------------------------------------ */

/** 一个工具最多注册多少个动作。与 commands 的上限一致 */
const ACTION_MAX = 12;
/** 一个动作最多几个参数 */
const PARAM_MAX = 8;
/** 动作名 / 参数名 / 说明的长度上限（说明会被拼进 system prompt，不能无限长） */
const DESC_MAX = 300;

/** 动作名白名单。和工具 id 同一套字符集，因为它要拼进模型看到的函数名 */
const ACTION_NAME_RE = /^[a-z][a-z0-9-]{0,23}$/;
/** 参数名：允许驼峰（很多工具作者这么写），但仍然是限死字符集 */
const PARAM_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,23}$/;

function clip(v: string, max: number): string {
  return v.length > max ? `${v.slice(0, max - 1)}…` : v;
}

/**
 * 把 manifest 里的 `actions` 洗成可信的 ToolActionSpec[]，
 * 并把老式 `commands` 里没被覆盖的那些并进来。
 *
 * ------------------------------------------------------------------
 * 为什么"并进来"而不是二选一
 * ------------------------------------------------------------------
 * commands 是 2026-09 之前的写法，已经有工具在用它（虽然目前一个都没有）。
 * 它只比 actions 少了说明与参数，**语义完全一样**：都是"助手可以让我干这个"。
 * 让老 manifest 继续可用不需要任何代价 —— 合成一句说明就够了。
 *
 * ------------------------------------------------------------------
 * 哪些会被丢掉
 * ------------------------------------------------------------------
 *   · 名字不合白名单的（拼进函数名会出事）
 *   · 拼出来的函数名超过 64 字符的（OpenAI / Anthropic 的硬上限）
 *   · 超过 12 个动作的（后面的一律丢 —— 一个工具给助手注册十几个动作，
 *     说明它该拆成几个工具，或者该只暴露真正会被用到的那几个）
 *
 * 说明缺失**不丢**：合成一句"执行「xx」"。丢掉的后果是工具作者看到
 * "我声明了但它没出现"却没有任何提示，那比一句干巴巴的说明糟得多。
 */
export function normalizeActions(raw: unknown, legacy?: unknown): ToolActionSpec[] {
  const out: ToolActionSpec[] = [];
  const seen = new Set<string>();

  const push = (a: ToolActionSpec) => {
    if (seen.has(a.name)) return;
    if (out.length >= ACTION_MAX) return;
    // 函数名 = tool_ + id + _ + action，宿主侧拼的时候才知道 id；这里只能守住
    // 最坏情况（id 取满 32 字符）：5 + 32 + 1 + 24 = 62，仍在 64 以内，
    // 所以这一条实际上永远不会触发 —— 留着是为了让上限这件事有据可查。
    if (`tool_${"a".repeat(32)}_${a.name}`.length > 64) return;
    seen.add(a.name);
    out.push(a);
  };

  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const a = item as Record<string, unknown>;
      const name = typeof a.name === "string" ? a.name.trim() : "";
      if (!ACTION_NAME_RE.test(name)) continue;
      const desc = typeof a.description === "string" ? clip(a.description.trim(), DESC_MAX) : "";
      const params = normalizeParams(a.params);
      push({
        name,
        description: desc || `执行「${name}」`,
        ...(params.length ? { params } : {}),
        ...(a.destructive === true ? { destructive: true } : {}),
      });
    }
  }

  // 老式 commands：只把 actions 里没有的补进来，补的时候说清它是老写法
  for (const c of normalizeCommands(legacy)) {
    if (seen.has(c)) continue;
    push({
      name: c,
      description: `「${c}」（这个工具用的是老式 commands 声明，没有给出说明与参数）`,
    });
  }

  return out;
}

/** 动作参数。同样是外部输入：只认三种类型，名字限死字符集 */
function normalizeParams(raw: unknown): ToolActionParam[] {
  if (!Array.isArray(raw)) return [];
  const out: ToolActionParam[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const p = item as Record<string, unknown>;
    const name = typeof p.name === "string" ? p.name.trim() : "";
    if (!PARAM_NAME_RE.test(name) || seen.has(name)) continue;
    if (out.length >= PARAM_MAX) break;
    const type = p.type === "number" || p.type === "boolean" ? p.type : "string";
    seen.add(name);
    out.push({
      name,
      ...(typeof p.description === "string" && p.description.trim()
        ? { description: clip(p.description.trim(), 160) }
        : {}),
      type,
      ...(p.required === true ? { required: true } : {}),
    });
  }
  return out;
}

/**
 * 工具自带的那份使用说明。
 *
 * 不合格就返回 null（整份丢掉）—— 半截的说明比没有更危险：
 * 模型会照着它去调动作，而它可能连"失败了该怎么办"都没写。
 *
 * `fallbackTitle` 是工具名：title 没写时用它拼一个，
 * 因为技能索引里显示的是 title，空的 title 会让那一栏看起来像坏了。
 */
export function normalizeSkill(raw: unknown, fallbackTitle: string): ToolSkillSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  const title = typeof s.title === "string" && s.title.trim() ? clip(s.title.trim(), 40) : "";
  const summary = typeof s.summary === "string" ? clip(s.summary.trim(), 200) : "";
  const body = typeof s.body === "string" ? clip(s.body.trim(), 6000) : "";
  const rules = (Array.isArray(s.rules) ? s.rules : [])
    .filter((r): r is string => typeof r === "string")
    .map((r) => clip(r.trim(), 200))
    .filter(Boolean)
    .slice(0, 8);

  // 三样都没有 = 这份 skill 是空壳，不要
  if (!summary && !body && !rules.length) return null;
  if (!title && !fallbackTitle) return null;

  return {
    title: title || `《${fallbackTitle}》怎么用`,
    summary: summary || `《${fallbackTitle}》注册给助手的那些动作该怎么用`,
    rules,
    body,
  };
}

/* ------------------------------------------------------------------ */
/* 扫描                                                                */
/* ------------------------------------------------------------------ */

/**
 * 扫描一个工具目录，返回其中合法的工具。
 * 单个工具读坏了只跳过它 —— 工具是外部输入，不该拖垮整个应用。
 */
async function scanToolsDir(dir: string): Promise<ToolManifest[]> {
  const fs = await import("@tauri-apps/plugin-fs");
  const { join } = await import("@tauri-apps/api/path");

  if (!(await fs.exists(dir))) return [];
  const out: ToolManifest[] = [];
  for (const e of await fs.readDir(dir)) {
    if (!e.isDirectory) continue;
    try {
      const manifestPath = await join(dir, e.name, "manifest.json");
      if (!(await fs.exists(manifestPath))) continue;
      const manifest = validateManifest(JSON.parse(await fs.readTextFile(manifestPath)));
      if (manifest) out.push(manifest);
    } catch {
      // 单个工具读取失败不影响其他工具
    }
  }
  return out;
}

/**
 * 桌面端工具的两个来源，都要扫。
 *
 * 这个函数以前只扫用户数据区 —— 注释里写着「应用包内 resources」是第 1 级来源，
 * 但那一级从来没实现过。后果是：安装包把工具老老实实装进了安装目录，
 * 应用却从不往那儿看，于是**桌面版所有工具都打不开**（浏览器 demo 走 Vite 静态服务，
 * 一直正常，把这个问题掩盖了很久）。
 *
 * 注意 `user` 的含义：**不是"在用户目录里的"**，而是"不在安装包里的"。
 * Rust 侧启动时会把内置工具复制到用户数据区（见 src-tauri/src/lib.rs 的
 * sync_builtin_tools），所以桌面端每个内置工具都同时存在于两处 ——
 * 若按目录位置分类，内置工具的 source 会全变成 user，卸载按钮就会出现，
 * 而用户点下去删掉的其实是内置工具的本地副本，升级时又会被装回来。
 * 判定依据只能是**安装包里有没有这个 id**。
 */
async function scanTauriTools(): Promise<{ bundled: ToolManifest[]; user: ToolManifest[] }> {
  const bundled: ToolManifest[] = [];
  const user: ToolManifest[] = [];

  try {
    const { resourceDir, join } = await import("@tauri-apps/api/path");
    const rd = await resourceDir();
    // 资源路径里的 `..` 被 Tauri 编码成 `_up_`，所以工具在 _up_/tools 下。
    // 也试一下不带 _up_ 的位置，万一以后 resources 配置改成不含 `..` 的形式。
    bundled.push(...(await scanToolsDir(await join(rd, "_up_", "tools"))));
    if (bundled.length === 0) bundled.push(...(await scanToolsDir(await join(rd, "tools"))));
  } catch {
    // 取不到资源目录就当作没有内置工具，由 BUILTIN_TOOLS 兜底
  }

  const bundledIds = new Set(bundled.map((t) => t.id));
  try {
    const { appDataDir, join } = await import("@tauri-apps/api/path");
    const dir = await join(await appDataDir(), "tools");
    // 用户数据区里那些**不在安装包中**的，才是用户自己的工具
    user.push(...(await scanToolsDir(dir)).filter((t) => !bundledIds.has(t.id)));
    // 工具目录的位置**无条件记下来**：哪怕现在一个工具都没有。
    // 它只在"某个工具的入口文件找不到"时显示给用户，那种场合说成
    // 「浏览器模式的清单」纯属指错方向 —— 他会去源码里找，而该看的是这个目录。
    registryLocation = dir;
  } catch {
    // appData 取不到就算了，不影响内置工具
  }

  // 来源戳在这里盖：凡出现在安装包资源里的都算 bundled
  for (const t of bundled) t.source = "bundled";
  for (const t of user) t.source = "user";

  return { bundled, user };
}

/**
 * 扫描并注册全部工具。
 *
 * 桌面端**只认磁盘上真实存在的工具** —— 这里刻意不再用 BUILTIN_TOOLS 兜底。
 * 那一手兜底原先是给"资源目录扫不出来"留的退路，但 0.2.0 起「扫不出 Tools 的
 * 内置工具」是**正常状态**而不是故障，再拿清单补上去，就成了给用户看四个
 * 打不开的入口（详见文件头）。
 *
 * 浏览器模式反过来：那份清单是它唯一的来源，而且它是真能用的 —— tools/ 就在
 * 工程根目录，dev server 直接把它当静态资源服务。
 */
export async function loadTools(): Promise<ToolManifest[]> {
  if (!isTauri()) {
    registry = BUILTIN_TOOLS.map((t) => ({ ...t, source: "bundled" as const }));
    // 夹具工具排在后面（见本文件 loadFixtureTools 的说明）：
    // 它只在 dev + 带参数时出现，正式流程里这一行是空数组
    registry.push(...(await loadFixtureTools()));
    registryLocation = "内置清单（浏览器模式）";
    return registry;
  }

  const merged = new Map<string, ToolManifest>();

  // 1. 安装包内的工具（现在通常是空的一组）
  const { bundled, user } = await scanTauriTools();
  for (const t of bundled) merged.set(t.id, t);

  // 2. 用户数据区的工具（优先级最高，可覆盖同 id 的内置工具）
  for (const t of user) merged.set(t.id, t);

  registry = [...merged.values()];
  return registry;
}

export function listTools(): ToolManifest[] {
  return registry;
}

/**
 * 安装包里有哪些工具 —— 不管它们有没有被装到用户数据区。
 *
 * 存在的理由只有一个：内置工具被卸载之后就从注册表消失了，设置页也就
 * 再也列不出它，用户没有入口把它装回来。所以"可重装清单"必须另取一份。
 *
 * 桌面端**照实返回**，扫不到就是空数组：安装包现在已经不带工具，「安装包里
 * 有什么」这个问题常常的答案就是「没有」。以前在这里补 BUILTIN_TOOLS，会让设置页
 * 摆出四个「重新安装」按钮，而点下去必然是 reinstallBundledTool 的一句
 * 「安装包里找不到这个工具的文件」—— 一个注定报错的按钮比没有按钮更糟。
 *
 * 浏览器模式没有安装包，退化成内置清单（那份就是这里的"安装包"）。
 */
export async function loadBundledTools(): Promise<ToolManifest[]> {
  if (!isTauri()) return BUILTIN_TOOLS.map((t) => ({ ...t, source: "bundled" as const }));
  const { bundled } = await scanTauriTools();
  return bundled;
}

export function getTool(id: string): ToolManifest | undefined {
  return registry.find((t) => t.id === id);
}

/**
 * 过滤出当前启用的工具。
 *
 * 被停用的工具**仍然留在注册表里**（设置页要列出它们、要能重新启用），
 * 只是不进侧边栏、不参与工具区的挂载。
 */
export function filterEnabled(tools: ToolManifest[], disabled: Set<string>): ToolManifest[] {
  return tools.filter((t) => !disabled.has(t.id));
}

/**
 * 取"当前真正该显示的那个工具"。
 *
 * 单独抽出来是因为 App 与工具区都要做同一个判断：`activeToolId` 指向的
 * 工具可能已经被停用或卸载了，那时两边必须同时认为"没有工具在显示"——
 * 各写一遍 `tools.find(...)` 迟早会漂移成一边显示空白、一边显示待办。
 */
export function pickActiveTool(
  tools: ToolManifest[],
  activeToolId: string | null,
): ToolManifest | null {
  if (!activeToolId) return null;
  return tools.find((t) => t.id === activeToolId) ?? null;
}

export function toolLocation(): string {
  return registryLocation;
}

/** 最近一次解析尝试过的候选路径（工具打不开时显示它，省得靠猜） */
let lastCandidates: string[] = [];

export function lastToolCandidates(): string[] {
  return lastCandidates;
}

/**
 * 桌面端工具文件的候选位置，按优先级排列。
 *
 * 为什么是多候选而不是写死一个：工具落在哪由 `bundle.resources` 决定，
 * 而资源路径里的 `..` 会被 Tauri 编码成 `_up_`
 * （`../tools/x` → `$RESOURCE/_up_/tools/x`）。这是 Tauri 的资源路径规则，
 * 不由我们决定。硬编码单一路径的话，改一次 resources 配置就全挂 ——
 * 而且是在「装完双击打开」那一刻才挂，浏览器里根本测不出来。
 */
async function desktopToolCandidates(tool: ToolManifest): Promise<string[]> {
  const out: string[] = [];
  const { appDataDir, resourceDir, join } = await import("@tauri-apps/api/path");

  const add = async (...parts: string[]) => {
    try {
      out.push(await join(...parts));
    } catch {
      // 某个基准目录取不到就跳过这个候选
    }
  };

  try {
    const rd = await resourceDir();
    await add(rd, "_up_", "tools", tool.id, tool.entry); // 当前实际位置
    await add(rd, "tools", tool.id, tool.entry); // 若将来改成不带 `..` 的 resources
  } catch {
    // 非桌面构建下取不到资源目录
  }
  try {
    await add(await appDataDir(), "tools", tool.id, tool.entry); // 用户自己丢的工具
  } catch {
    // 同上
  }
  return out;
}

/**
 * 解析工具的入口 URL。
 *
 * 桌面端：先按候选路径逐个探测文件是否存在，再用 asset 协议指向它。
 * 浏览器端：`tools/` 就在工程根目录下，dev server 会把它当静态资源直接服务，
 *   所以返回同源的 /tools/<id>/<entry> 即可 —— 开发时工具就真的嵌进来了，
 *   不必等到打包才能看到效果。
 *   生产构建由 vite.config.ts 的 workbenchTools 插件把 tools/ 复制到 dist/。
 */
/* ------------------------------------------------------------------ */
/* 测试夹具（仅开发模式）                                              */
/* ------------------------------------------------------------------ */

/**
 * 夹具工具的入口地址覆盖表。
 *
 * 存在的理由：浏览器演示模式**装不了工具**（没有可写的文件系统），
 * 于是"工具注入到宿主界面"这件事在浏览器里根本没有可注入的对象 ——
 * 而 20 个 e2e 套件全跑在浏览器里。
 *
 * 做法：`?fixtureTools=1` 时把 tests/fixtures/tools/ 下的夹具灌进注册表，
 * 入口地址直接指向夹具目录（`tools/<id>/` 下并没有它的文件）。
 *
 * 三重闸门，少一道都不行：
 *   · `import.meta.env.DEV` —— 打包后这段整段不成立
 *   · 必须显式带 `?fixtureTools=1` —— 开发时默认也不出现
 *   · 只在浏览器模式（桌面端走真实目录）
 * 所以用户永远看不到它，设置页也不会列出它。
 */
const fixtureUrls = new Map<string, string>();

function registerFixtureUrl(id: string, url: string): void {
  fixtureUrls.set(id, url);
}

/**
 * 解析 `?fixtureTools=` 的值：
 *   `undefined` —— 根本没带这个参数，一个夹具都不加载
 *   `null`      —— `1` / `all`，全部加载
 *   `Set`       —— 逗号分隔的 id 白名单
 *
 * 为什么要有白名单这一档：有的断言是"详情面板底部出现了 **1 个**注入分区"
 * （agent-sandbox.mjs），夹具一多就变成 2 个、测试假红。让套件点名要哪几个，
 * 比让所有夹具一起上、再回去改断言里的数字要好。
 */
function fixtureFilter(): Set<string> | null | undefined {
  if (typeof location === "undefined") return undefined;
  const m = /[?&]fixtureTools=([^&]*)/.exec(location.search);
  if (!m) return undefined;
  const v = decodeURIComponent(m[1]).trim();
  if (!v || v === "1" || v === "all") return null;
  return new Set(
    v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

async function loadFixtureTools(): Promise<ToolManifest[]> {
  // 不能写 `import.meta.env.DEV`：单测把源码用 esbuild 打成 Node bundle 跑，
  // 那里的 import.meta 上没有 env —— 直接取会 TypeError，整个套件当场崩。
  // 所以取成"可选"：取不到就是非开发环境，正是我们要的默认。
  const env = (import.meta as unknown as { env?: { DEV?: boolean } }).env;
  if (!env?.DEV) return [];
  const filter = fixtureFilter();
  if (filter === undefined) return [];
  try {
    const res = await fetch("/tests/fixtures/tools/index.json");
    if (!res.ok) return [];
    const raw = (await res.json()) as unknown;
    if (!Array.isArray(raw)) return [];
    const out: ToolManifest[] = [];
    for (const item of raw) {
      const m = validateManifest(item);
      if (!m) continue;
      if (filter && !filter.has(m.id)) continue;
      registerFixtureUrl(m.id, `/tests/fixtures/tools/${m.id}/${m.entry}`);
      out.push(m);
    }
    return out;
  } catch {
    // 夹具读不到就当作没有 —— 正式开发流程里这才是常态
    return [];
  }
}

export async function resolveToolUrl(tool: ToolManifest): Promise<string | null> {
  const fixture = fixtureUrls.get(tool.id);
  if (fixture) return fixture;
  if (!isTauri()) {
    // BASE_URL 保证部署在子路径下时也拼得对
    const base = import.meta.env.BASE_URL || "/";
    return `${base.replace(/\/$/, "")}/tools/${tool.id}/${tool.entry}`;
  }
  try {
    const { convertFileSrc } = await import("@tauri-apps/api/core");
    const fs = await import("@tauri-apps/plugin-fs");

    const candidates = await desktopToolCandidates(tool);
    lastCandidates = candidates;
    if (candidates.length === 0) return null;

    for (const p of candidates) {
      try {
        if (await fs.exists(p)) return convertFileSrc(p);
      } catch {
        // 探测失败当作不存在，继续看下一个候选
      }
    }

    // 一个都不存在：返回 null，而不是「指向空气的 URL」。
    // 指向不存在的文件只会得到一个白屏 iframe，而白屏是最没有信息量的反馈；
    // 返回 null 后上层能把「找过哪些位置」显示出来。
    return null;
  } catch {
    return null;
  }
}

/**
 * 工具私有表的**前缀**，如 `tool_image_crop_`。
 *
 * 单独抽成一个函数，是因为"前缀怎么拼"这件事有四个地方要知道
 * （建表、清理、数据库分区枚举、推给工具的上下文），而它们各写一遍
 * 迟早会漂移成两套规则 —— 那正是本项目最常犯的那类错。
 */
export function toolPrefix(toolId: string): string {
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(toolId)) {
    throw new Error(`非法的工具 id: ${toolId}`);
  }
  return `tool_${toolId.replace(/-/g, "_")}_`;
}

/**
 * 生成工具私有表名。
 * 强制加前缀，让工具表在同一个库里天然分区，卸载工具时便于清理。
 */
export function toolTable(toolId: string, table: string): string {
  if (!/^[a-z][a-z0-9_]{0,47}$/.test(table)) {
    throw new Error(`非法的表名: ${table}`);
  }
  return toolPrefix(toolId) + table;
}

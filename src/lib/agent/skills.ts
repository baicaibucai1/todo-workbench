/**
 * 内置 AI 助手的**技能包**（skill）。
 *
 * ------------------------------------------------------------------
 * 什么是这里的 skill，为什么它不是"一段提示词"
 * ------------------------------------------------------------------
 * 助手要能写出「能装进这个工作台、装进去就能跑」的单 HTML 工具，
 * 而那件事的成败几乎全在**一批硬约束**上：CSS/JS 必须内联（导入只搬两个文件）、
 * 相对引用会被解析到站点根（桌面端 asset 协议的坑）、私有表必须声明式地写在
 * manifest 里、值要按类型给（两个驱动的类型处理不一样）……
 *
 * 这些约束散布在 tools.ts / toolBridge.ts / toolSchema.ts / ToolHost.tsx 的注释里，
 * 每一处都在讲"为什么必须这样"。把它们**抄一份给模型**是最不可靠的做法 ——
 * 抄本会漂移。所以这里不是提示词的堆砌，而是**同一批规则的第三份投影**，
 * 由两件事兜住它不漂移：
 *   1. 每条规则都写清"违反了会怎样"，所以它能被测试证伪（见 tests/agent-unit.mjs）；
 *   2. 凡是与代码强耦合的数字（体积上限、表名正则、主键约束）都从
 *      toolStore / toolSchema / tools 里**算出来或直接引用**，而不是手写一遍。
 *
 * ------------------------------------------------------------------
 * 为什么分「常驻规则」和「全文」
 * ------------------------------------------------------------------
 * 全文加起来几千字，每一轮对话都塞进去既贵又会让模型忽略重点
 * （长上下文里最容易被忽略的就是中间那段）。所以：
 *   · 常驻注入的只有每个技能的 title + summary + rules（硬规则，每条一句话）
 *   · 全文由 read_skill 工具按需取 —— 模型真要动手写工具时，会自己去把
 *     tool-authoring 拉下来逐条照做
 * 这不是省事的妥协：让"具体怎么做"只在需要时出现，模型对它的注意力反而更高。
 *
 * ------------------------------------------------------------------
 * 界面上的「技能」按钮读的就是这份数据
 * ------------------------------------------------------------------
 * 助手"会什么"必须能被用户看见 —— 一个看不见能力边界的东西，
 * 用户没法判断该不该信它。所以 SKILLS 同时是 UI 的数据源，
 * 不存在"界面上一份、注入给模型另一份"。
 */

import { HTML_MAX_BYTES } from "../toolStore";
import { toolPrefix } from "../tools";
import * as repo from "../repo";

/** 代码块围栏。抽成常量是为了让下面的正文能直接写，不必到处转义反引号 */
const F = "```";

export interface AgentSkill {
  id: string;
  title: string;
  /** 一句话说明它管什么（进索引，也显示在技能面板上） */
  summary: string;
  /** 常驻注入的硬规则。每条都要能被"违反了会怎样"证伪 */
  rules: string[];
  /** 全文。由 read_skill 按需取 */
  body: string;
  /** 谁写的：内置（代码）还是助手自己存的（库）。内置删不掉 */
  source?: "builtin" | "agent";
}

const MB = Math.round(HTML_MAX_BYTES / 1024 / 1024);

export const SKILLS: AgentSkill[] = [
  /* ------------------------------------------------------------------ */
  {
    id: "tool-authoring",
    title: "单 HTML 工具编写标准",
    summary: "写一个能装进工作台的单文件工具：自包含、能接宿主的主题与数据、按 manifest 契约交付",
    rules: [
      "必须是**单个自包含 HTML**：CSS 与 JS 全部内联，禁止引用任何外部文件、CDN 或字体（工作台是离线应用，装了就打不开的东西等于坏的）",
      "文件名与 id 只用小写字母、数字、连字符，id 必须以字母开头、长度 2–32（它会成为这个工具私有表的表名前缀，是安全边界）",
      "必须含 <html> 或 <body> 标签，整份不超过 " + MB + " MB（导入时会校验这两条）",
      "绝对路径引用自己附带的资源也要避免：单文件导入只会搬 index.html 与 manifest.json 两个文件",
      "界面文案用简体中文；颜色自己定一套，但必须**响应宿主的深浅色**（收到 tool:context 后把 ctx.theme 写到 <html data-theme>）",
      "关键状态写 data-* 属性、按钮写 data-act —— 这个项目靠它做自动化验证，没有它新功能就没法被回归测试覆盖",
      "交付大段 HTML 时**不要把它塞进工具参数**：JSON 字符串里的换行与引号极易转义坏（接口会直接 400 拒收，用户只看到一句看不懂的报错）。动作里只给 id / name，整份源码另起一个 html 代码块（写法见动作协议）",
      "**一次回复有长度上限**：一份几百行以上的 HTML 一次写不完，写到一半会被掐断 —— 那时代码块不闭合，宿主什么也收不到，你只会看到「没有拿到源码」。**别试着一次写完，直接分段**：`write_file` 第一段正常写（path 用工作区相对路径，如 tools/pomodoro.html），之后每段带 `append: true` 接着上一段的最后一行写（每段几百行以内，不要重复、不要另起开头），写完之后 `sandbox_run` 只给 `html_file` 指过去，源码不要再贴一遍",
      "收到「被输出长度上限掐断」或「代码块没有闭合」时，**换成分段 write_file 那条路**，不要从头再写一遍 —— 从头写还是会断在同一个地方（2026-09-26 真机：卡了 6 轮才装上，根因就是这个循环）",
      "不许写假按钮、假开关、假进度条：点了没反应的东西，比没有它更伤",
      "**装之前必须 sandbox_run**：它在隔离 iframe 里真跑一遍（抓报错、看是不是白屏、核对你声明的能力），通过了才发通行证；install_tool **只认票**，没票会被直接拒绝",
      "install_tool 里**可以不写 html**：省略时装的正是 sandbox_run 验过的那一份（推荐，省得把源码再抄一遍）；要写就必须与试跑那份**一字不差** —— 通行证绑的是源码指纹，抄歪一个字节票就作废，想改就改完再跑一次，别拿旧票去装新源码",
    ],
    body: [
      "# 单 HTML 工具编写标准",
      "",
      "你要交付的是一个**能直接装进「待办工作台」并跑起来**的 HTML 文件。",
      "工作台的工具区用 iframe 承载它，它和宿主之间只通过 postMessage 通信。",
      "",
      "## 一、交付物契约",
      "",
      "装进工作台时，宿主只写两个文件：",
      "",
      F + "text",
      "tools/<id>/",
      "  index.html        ← 你写的那份（唯一入口）",
      "  manifest.json     ← 由 install_tool 的参数生成，不用你手写",
      F,
      "",
      "推论（这几条踩过坑，务必照做）：",
      "",
      "1. **CSS / JS 必须内联**。`<style>` 和 `<script>` 直接写在 HTML 里。",
      "   `src=\"helper.js\"` 这类相对引用**不会被一起搬过去**，装完之后是 404。",
      "2. **不要引 CDN**。工作台的数据全在本机，用户可能长期断网；",
      "   而且桌面端工具经 asset 协议加载，任何相对路径都会被解析到站点根。",
      "3. **图标用内联 SVG 或 Unicode 字符**，不要引图标字体。",
      "4. 单文件上限 " + MB + " MB。真需要几十 MB 的模型或数据集，",
      "   那属于「目录型工具」，应该让人做成 `tools/<id>/` 整个目录丢进来，不是单文件导入能覆盖的场景。",
      "",
      "## 二、id 与 manifest 的硬约束",
      "",
      "- id 正则：`^[a-z][a-z0-9-]{1,31}$`（小写字母开头，2–32 位）",
      "- id 会成为私有表前缀：`tool_<id 里的连字符换成下划线>_`，",
      "  例如 id = `overtime-log` → 表 `tool_overtime_log_records`。",
      "  这是**安全边界**（见下），不是命名偏好。",
      "- name 是侧边栏里显示的中文名，要短（能一行放下）。",
      "- icon 只能从这个清单里选（写错会退回默认的包裹图标）：",
      "  `sun` `star` `calendar` `inbox` `home` `package` `crop` `receipt`",
      "  `image` `calculator` `file` `list` `settings` `boxes` `sparkles`",
      "  `video` `hash` `notebook-pen` `bot`",
      "- description 一句话说清它替用户做什么，会显示在设置页的工具列表里。",
      "",
      "## 三、和宿主通信（唯一的通道）",
      "",
      "工具拿不到宿主的数据库、拿不到别的工具的数据，也**不允许自己开 SQL 通道**。",
      "要数据就 postMessage 请求宿主代查。下面这段直接抄：",
      "",
      F + "html",
      "<script>",
      '(function () {',
      '  "use strict";',
      '  var TOOL_SOURCE = "workbench-tool";',
      '  var HOST_SOURCE = "workbench-host";',
      "  var seq = 0, waiting = new Map(), ctx = null;",
      "",
      "  function call(op, payload) {",
      '    var id = "r" + ++seq;',
      "    return new Promise(function (resolve, reject) {",
      "      waiting.set(id, { resolve: resolve, reject: reject });",
      "      parent.postMessage(",
      '        { source: TOOL_SOURCE, type: "tool:request", id: id, op: op, payload: payload || {} },',
      '        "*"',
      "      );",
      "      setTimeout(function () {",
      '        if (waiting.delete(id)) reject(new Error("宿主没有回应（" + op + "）"));',
      "      }, 10000);",
      "    }).then(function (res) {",
      '      if (!res.ok) throw new Error(String(res.error || "宿主拒绝了这次请求"));',
      "      return res.data;",
      "    });",
      "  }",
      "",
      '  window.addEventListener("message", function (e) {',
      "    var m = e.data;",
      "    if (!m || m.source !== HOST_SOURCE) return;",
      "",
      '    if (m.type === "tool:response") {',
      "      var w = waiting.get(m.id);",
      "      if (w) { waiting.delete(m.id); w.resolve({ ok: m.ok, data: m.data, error: m.error }); }",
      "      return;",
      "    }",
      '    if (m.type === "tool:context") {',
      "      // 宿主下发的运行上下文：theme / driver / tablePrefix / runtime",
      "      ctx = m.data;",
      '      if (ctx) document.documentElement.dataset.theme = ctx.theme || "light";',
      "      return;",
      "    }",
      '    if (m.type === "tool:intent") { /* 被别的工具拉起时交过来的数据 */ }',
      '    if (m.type === "tool:event")  { /* 别的工具发来的事件 */ }',
      "  });",
      "})();",
      "</script>",
      F,
      "",
      "宿主收到 `tool:context` 的时机：iframe 加载完成时、以及宿主切换深浅色时。",
      "**不要假设它一定在你发第一个请求之前到** —— 先渲染，收到再套主题。",
      "",
      "## 四、可用的 op（白名单，其余一律被拒）",
      "",
      "| op | 用途 |",
      "| --- | --- |",
      "| `info` | 拿运行上下文（等价于重取一次 tool:context） |",
      "| `kv.get` / `kv.set` / `kv.all` / `kv.del` | 存本工具的配置（API Key、上次选的选项）。值必须是字符串，单条 ≤ 512 KB |",
      "| `schema.info` | 拿到宿主为你建好的表结构（表名、列、主键） |",
      "| `row.count` / `row.select` / `row.insert` / `row.update` / `row.delete` | 读写自己的私有表。见 data-binding 技能 |",
      "| `gallery.list` / `gallery.get` / `gallery.put` | 用工作台图库（跨工具共享的素材库） |",
      "| `tools.list` / `tools.open` / `tools.send` | 与其它工具联动。见 tool-integration 技能 |",
      "",
      "## 五、界面规范",
      "",
      "- 简体中文文案，句子说人话（\"存不进去：列「金额」是 real，收到的是 string\"",
      "  这种能直接照着改的话，比\"保存失败\"有用得多）。",
      "- 深浅色：自己定义一套 CSS 变量，用 `html[data-theme=\"dark\"]` 覆盖，",
      "  收到 context 后切属性即可。**不要写死白底黑字** —— 宿主切深色后工具还是一块白，很割裂。",
      "- 关闭/清空这类破坏性操作要二次确认；写失败要在界面上明确报出来，",
      "  不要只在 console 里 log。",
      "- **不要写假按钮**：点了没反应的按钮、永远走不到的空状态、写死的假数据，",
      "  都会让人以为工具坏了。功能没做就不放那个入口。",
      "- 关键状态挂到 DOM 上供自动化断言，例如：",
      "  `document.body.dataset.bindState = \"bound\"`、按钮写 `data-act=\"save\"`、",
      "  列表项写 `data-id`。项目里每一个功能的 e2e 都依赖这个习惯。",
      "",
      "## 六、交付前自检",
      "",
      "- [ ] **已经 sandbox_run 通过并拿到 ticket**（没票装不上，这不是可选项）",
      "- [ ] 单个 HTML，CSS/JS 全内联，无外部引用",
      "- [ ] id 合法、name 是中文短名、icon 在清单里",
      "- [ ] 需要存数据 → schema 已按 data-binding 技能声明",
      "- [ ] 会写数据的地方都有失败提示（try/catch + 界面显示）",
      "- [ ] 深浅色都试过（把 <html data-theme> 手动改成 dark 看一眼）",
      "- [ ] 没有假按钮、没有写死的假数据",
    ].join("\n"),
  },

  /* ------------------------------------------------------------------ */
  {
    id: "data-binding",
    title: "数据表绑定标准",
    summary: "给工具声明私有数据表并读写它：声明式 schema、类型强校验、没有 SQL 通道",
    rules: [
      "工具**永远拿不到 SQL**：只能声明表结构，再用 row.* 做结构化 CRUD。不要试图拼 SQL",
      "表名与列名只允许小写字母、数字、下划线，且首字符必须是字母（会直接拼进 DDL）",
      "每张表**必须有且只有一个主键列**（update / delete 靠它定位一行），且 row.insert 必须显式给出主键值",
      "列类型只有三种：text / integer / real。给 integer 列传字符串会被拒绝 —— 这是为了让两个驱动行为一致，不是刁难",
      "工具的表永远落在自己的命名空间里（前缀 tool_<id>_），碰不到 core_tasks 或别的工具的表",
      "改了表结构要把 dbVersion +1；⚠️ 已存在的表**不会自动加列**，要真生效得在「设置 → 数据库」里清理该工具的命名空间让表重建",
      "卸载工具默认**保留数据**，重装回来还在；要抹掉数据只能用户在设置里手动清理",
    ],
    body: [
      "# 数据表绑定标准",
      "",
      "工具要存自己的记录时，**声明**表结构，宿主替你建表、替你校验、替你执行。",
      "你写的是 `row.*` 这种结构化调用，不是 SQL —— 这条边界是刻意的：",
      "让宿主能逐项校验列名与类型，而不是去解析一段字符串里有没有偷偷写 `core_tasks`。",
      "",
      "## 一、在 manifest 里声明（install_tool / bind_database 的 schema 参数）",
      "",
      F + "json",
      "{",
      '  "tables": [',
      "    {",
      '      "name": "records",',
      '      "columns": [',
      '        { "name": "id",      "type": "text", "pk": true },',
      '        { "name": "title",   "type": "text" },',
      '        { "name": "minutes", "type": "integer", "default": 0 },',
      '        { "name": "amount",  "type": "real", "default": 0 },',
      '        { "name": "done",    "type": "integer", "default": 0 },',
      '        { "name": "created_at", "type": "text" }',
      "      ],",
      '      "indexes": [{ "columns": ["created_at"] }]',
      "    }",
      "  ]",
      "}",
      F,
      "",
      "约束（超了会被整份拒绝，而不是部分采纳 —— 半残的表最难排查）：",
      "",
      "- 最多 12 张表、一张表最多 40 列、一张表最多 8 个索引，索引最多 4 列",
      "- 表名 / 列名：`^[a-z][a-z0-9_]{0,47}$`",
      "- 每张表恰好一个 `pk: true`。类型只有 `text` / `integer` / `real`",
      "- `default` 要匹配类型：integer / real 给数字，text 给字符串",
      "- 索引列必须是本表已声明过的列",
      "",
      "**schema 校验不过 = 这个工具没有表**，那时 row.* 会明确报\"没有声明任何数据表\"。",
      "所以宁可少声明一张表，也不要写一个不合法的列名。",
      "",
      "## 二、在界面上怎么读写",
      "",
      F + "js",
      '// 插入：主键值必须自己给（宿主不替你生成 id，这样你才能靠业务键做幂等）',
      'await call("row.insert", {',
      '  table: "records",                       // 裸表名，不要写前缀',
      '  row: {',
      '    id: "r-" + Date.now().toString(36),',
      '    title: "8/12 加班",',
      '    minutes: 95,                          // integer 必须真的是整数',
      '    amount: 0,',
      '    done: 0,',
      '    created_at: new Date().toISOString()  // 时间统一存 ISO 8601 字符串',
      "  }",
      "});",
      "",
      "// 查询：等值筛选 + 单列排序 + 分页。返回 { rows, total, limit, offset }",
      'await call("row.select", {',
      '  table: "records",',
      '  where: { done: 0 },          // 值为 null 表示 IS NULL',
      '  orderBy: "created_at", orderDir: "desc", limit: 50, offset: 0',
      "});",
      "",
      "// 计数：只想显示\"还有几条没做\"时用它，别 select 回来自己数",
      'await call("row.count", { table: "records", where: { done: 0 } });',
      "",
      "// 更新：patch 只写要改的列，id 是主键值",
      'await call("row.update", { table: "records", id: "r-abc", patch: { done: 1 } });',
      "",
      "// 删除",
      'await call("row.delete", { table: "records", id: "r-abc" });',
      F,
      "",
      "## 三、三条必须知道的限制",
      "",
      "1. **没有 JOIN、没有子查询、没有多表聚合**。浏览器演示模式用的是一套简易内存库，",
      "   这类语句它会**静默返回空数组**（不报错），只在装了 SQLite 的桌面版上正常 ——",
      "   也就是说写错的地方在开发机上永远看不出来。需要关联就拆成两次单表查询，在 JS 里合并。",
      "2. **值按列类型强校验**。同一个原因：SQLite 有类型亲和性会默默把字符串转成数字，",
      "   内存库不会。不校验就会出现\"网页里好使、装上就错位\"。",
      "3. **多出来的列会被拒绝**（不是忽略）。写了没声明的列名，会明确报\"表里没有这一列\"，",
      "   这样你一眼就知道该改哪里，而不是\"我写了但没存进去\"。",
      "",
      "## 四、改表结构",
      "",
      "宿主建表用的是 `CREATE TABLE IF NOT EXISTS` + 一份版本台账：",
      "",
      "- 表不存在 → 按声明建（含索引）",
      "- 表已存在且 dbVersion 与台账一致 → 什么都不做",
      "- dbVersion 变了 → 重新发一遍 CREATE，但**已存在的表不会被改**",
      "",
      "所以「给已有表加一列」不会自动生效。真要做到：把 dbVersion +1、改好 schema，",
      "然后请用户在【设置 → 数据库】里对该工具点「清理数据」—— 那会删掉旧表，",
      "下次打开工具时按新声明重建。**这会丢数据**，所以要提前跟用户说清楚，",
      "不要自己擅自建议清理。",
      "",
      "## 五、卸载与数据",
      "",
      "卸载工具**不删数据**：工具表、它的 kv 配置都留着，重装回来数据还在。",
      "真正的清理只有一处入口：设置 → 数据库 → 该工具的「清理数据」。",
    ].join("\n"),
  },

  /* ------------------------------------------------------------------ */
  {
    id: "schedule",
    title: "日程与时间的写法",
    summary: "把用户的\"明天下午三点\"变成工作台里能提醒的待办：本地日期、到点提醒、子任务时刻",
    rules: [
      "日期一律用**本地时区**的 `YYYY-MM-DD`，时刻用本地 `YYYY-MM-DDTHH:mm`。绝不要用 UTC 或 toISOString() 去算\"哪一天\"",
      "「今天/明天/后天/下周一」要先按**当前本地时间**换算成具体日期再写入，不要让工具去猜",
      "用户说了**时刻**（\"下午三点\"）才设提醒 remindAt；只说\"明天\"就只给 dueDate，不硬造一个提醒",
      "需要几步才能做完的事，用子任务拆开；子任务的 dueAt **要带时刻**（只给日期它进不了紧急区，也就不会提醒）",
      "每天重复的习惯用 repeat=daily（今天做完明天自动回来），一次性的事不要设成 daily",
      "只创建用户明确要求的条目，不要顺手替他安排别的事；清单不存在时可以新建，但要在结果里说明",
      "工作台里的「流程任务」（带单号、过程态、处理时效的那种）属于另一个领域，助手不创建它 —— 用户要建请用界面上的入口",
    ],
    body: [
      "# 日程与时间的写法",
      "",
      "工作台里的\"日程\"就是**待办（Task）**：一条标题 + 可选的到期日、提醒时刻、子任务。",
      "没有独立的日历表，也不应该有 —— 用户看到的就是一个列表。",
      "",
      "## 一、字段与语义",
      "",
      "| 字段 | 含义 | 格式 |",
      "| --- | --- | --- |",
      "| `title` | 一行标题，列表扫视靠它 | 短句，别把细节塞进来 |",
      "| `note` | 展开写的细节 | 自由文本 |",
      "| `dueDate` | 计划日期（哪一天做） | 本地 `YYYY-MM-DD` |",
      "| `remindAt` | 到点提醒的**时刻** | 本地 `YYYY-MM-DDTHH:mm` |",
      "| `important` | 标记重要（侧边栏「重要」视图） | 布尔 |",
      "| `myDay` | 加进「我的一天」 | 布尔 |",
      "| `repeat` | `none` 或 `daily` | daily = 每天重来一次 |",
      "| `steps[]` | 子任务。`dueAt` 精确到时刻 | 见下 |",
      "",
      "「我的一天」的构成 = 手动加进来的 ∪ 今天到期的 ∪ 每天重复的。",
      "所以一条\"今天到期\"的待办**自动**会出现在我的一天里，不用额外设 myDay。",
      "",
      "## 二、时间怎么算",
      "",
      "- 先把\"今天几号、现在几点\"算出来，再谈\"明天\"。",
      "  **不要用 `new Date().toISOString().slice(0,10)` 取日期** —— 那是 UTC，",
      "  在东八区晚上 8 点之后会得到\"昨天\"。要按本地年月日拼。",
      "- \"明天下午三点\" → `dueDate = <明天>`, `dueTime = \"15:00\"`",
      "  → 等于 `dueDate = <明天>`, `remindAt = <明天>T15:00`",
      "- \"下周三之前交\" → 只给 `dueDate`，不要造提醒",
      "- \"每天早上 9 点提醒我吃药\" → `repeat = \"daily\"`, `dueDate = 今天`, `remindAt = 今天T09:00`",
      "  （提醒引擎到点弹一次，第二天这条会自动变回未完成）",
      "- \"周五上午之前把报价发出去\" 这类是**某条待办里的一步** → 做成子任务：",
      "  `steps: [{ title: \"发报价给客户\", dueAt: \"<周五>T10:00\" }]`",
      "",
      "## 三、子任务为什么要精确到时刻",
      "",
      "侧边栏底部的「紧急区」按\"还剩多久\"排序，子任务是它的输入之一。",
      "而**只给了日期的子任务在时间上是隐形的**（算不出还剩多久），",
      "于是\"三点前把图发出去\"到点了却没有任何提醒。所以子任务给时刻，",
      "父任务给日期 —— 这也符合它们的性格：待办是\"哪一天的事\"，",
      "子任务是\"几点前的那一步\"。",
      "",
      "## 四、提醒的行为（写文案时别承诺过头）",
      "",
      "- 提醒是**应用内**的：打开工作台时到期才会弹卡片。桌面版可选开启系统通知（设置里）。",
      "  所以不要说\"我到点会通知你\" —— 说\"到点会在工作台里提醒你\"。",
      "- 同一条待办的提醒只弹一次；子任务与流程任务的时效提醒同理。",
      "- 已完成、已删除的不会提醒。",
      "",
      "## 五、一次要建多条时",
      "",
      "`create_schedules` 支持一次给多条（items 数组）。用户说\"把这三件事排进去\"时",
      "一次建完，不要来回问。返回值里会列出每条的真 id、最终日期、落在哪个清单 ——",
      "把它如实转述给用户（尤其是你替他做了决定的地方，比如新建了清单、把时刻补成了 15:00）。",
    ].join("\n"),
  },

  /* ------------------------------------------------------------------ */
  {
    id: "component-inject",
    title: "注入组件（把工具嵌进宿主界面）",
    summary: "写一个挂在某条待办上的组件：详情分区 / 详情头部按钮 / 行内按钮，只读当前那条",
    rules: [
      "注入组件**只读**：能调 task.get 读它挂着的那一条，没有任何写接口 —— 改待办只能走宿主的界面或你的日程动作",
      "要先知道自己在哪条待办上：从 tool:context 里读 ctx.inject.taskId；不读它就成了每条待办上都一样的死面板",
      "manifest 里必须申请 capabilities: [\"task\"] 才能调 task.get，没申请会被宿主拒绝（沙箱里当场就会报出来）",
      "注入位置只有三种：detailSection（详情面板底部的常驻分区）、detailAction（详情头部按钮）、rowAction（列表行内按钮）",
      "同一个组件挂在两条待办上是两个 iframe 实例、两份上下文，**不要**用全局变量记住「上一条」",
      "按钮型的面板高度只有 320px 上下：注入组件是配角，别把详情面板顶满；需要更高就用 detailSection",
    ],
    body: [
      "# 注入组件（把工具嵌进宿主界面）",
      "",
      "整页工具占工具区那一大片，和「在看哪条待办」没关系。",
      "**注入组件**相反：它挂在**某一条待办**上，替那一條干活。",
      "比如「给这条待办配一张参考图」、「这条待办要几步、画成甘特条」。",
      "",
      "## 一、声明挂在哪",
      "",
      "install_tool 时给 `injects`（一个工具可以同时声明多个位置）：",
      "",
      F + "json",
      "injects: [",
      '  { "kind": "detailSection", "label": "配图", "height": 180 },',
      '  { "kind": "detailAction", "label": "配图" },',
      '  { "kind": "rowAction", "label": "配图" }',
      "]",
      F,
      "",
      "| kind | 落在哪 | 备注 |",
      "| --- | --- | --- |",
      "| `detailSection` | 待办详情面板底部，常驻 | `height` 默认 180，区间 80–600 |",
      "| `detailAction` | 详情面板头部的按钮 | 点开是一个约 320px 的面板 |",
      "| `rowAction` | 列表每一行的悬停操作区 | 同上，点开是浮层 |",
      "",
      "## 二、拿到「我在替谁干活」",
      "",
      "宿主把上下文投进 `tool:context`，关键字段是 `ctx.inject`：",
      "",
      F + "js",
      'if (m.type === "tool:context") {',
      "  ctx = m.data;",
      '  document.documentElement.dataset.theme = ctx.theme || "light";',
      "  if (ctx.inject) {",
      "    // ctx.inject.kind    —— 这次挂在哪个位置",
      "    // ctx.inject.taskId  —— 挂着的那条待办的 id",
      '    var t = await call("task.get", {});   // 读那一条（只读）',
      "    render(t);",
      "  }",
      "}",
      F,
      "",
      "⚠️ **不要假设 tool:context 一定在你发第一个请求之前到** —— 先渲染骨架，收到再填充。",
      "",
      "## 三、task.get 返回什么",
      "",
      "`{ id, title, note, done, important, myDay, dueDate, remindAt, listId, createdAt }`",
      "",
      "它**只返回挂载的那一条**，没有「给我某个 id 的待办」这种接口 ——",
      "这是刻意的：注入组件不该有能力翻别人的待办。",
      "两条被拒绝的常见原因：没申请 `task` 能力；或者它挂的那条刚被删了。",
      "两种都要在界面上显示出来，不要静默。",
      "",
      "## 四、写法要点",
      "",
      "- 仍然是**单个自包含的 HTML**：CSS/JS 内联，不引 CDN（规则同 tool-authoring）。",
      "- 深浅色照样要响应 `ctx.theme`。",
      "- 关键状态写 `data-*`（这个项目的 e2e 靠它断言），比如",
      "  `document.body.dataset.bindState = \"bound\"`。",
      "- 自己要存东西照样用 `row.*`（私有表）或 `kv.*`（配置），与整页工具一致。",
      "- **不许写假按钮**：面板里放一个点了没反应的按钮，比不放更糟。",
      "",
      "## 五、提交前",
      "",
      "和整页工具一样走 sandbox_run → 拿 ticket → install_tool。",
      "沙箱会把它当作**挂在一示例待办上**来试跑：它会收到 `ctx.inject`，",
      "`task.get` 会返回一条合成的待办 —— 所以「收到上下文之后怎么渲染」这段",
      "在沙箱里是真被跑过的，不是纸上谈兵。",
    ].join("\n"),
  },

  /* ------------------------------------------------------------------ */
  {
    id: "tool-integration",
    title: "工具联动与图库",
    summary: "工具之间怎么传数据、怎么用工作台图库、怎么存自己的配置",
    rules: [
      "工具之间**不能直接通信**：拉起对方用 tools.open（会顺带把数据交过去），给正在跑的对方发事件用 tools.send",
      "tools.send 只投给**已经在运行**的工具，对方没在跑会明确报错 —— 不要靠它做\"总会送到\"的假设",
      "图库是全局素材库（图片/视频），任何工具都能 list / get / put；但工具只能拿到 id，拿不到仓库路径",
      "gallery.put 的产物出处由宿主按工具 id 盖章，工具自报的来源会被忽略",
      "工具自己的配置（API Key、上次选的模型）用 kv.* 存，不要塞进私有表 —— kv 是给\"配置\"准备的，表是给\"记录\"准备的",
    ],
    body: [
      "# 工具联动与图库",
      "",
      "## 一、与别的工具联动",
      "",
      F + "js",
      '// 1) 看看这台机器上还有什么工具（只给元信息，拿不到入口地址）',
      'var list = await call("tools.list", {});',
      "// → { tools: [{ id, name, icon, version, description, running, active }] }",
      "",
      "// 2) 拉起一个工具，并把一份数据交给它",
      'await call("tools.open", { tool: "image-crop", data: { url: "data:image/png;base64,..." } });',
      "// 对方没在跑会先被挂上，加载完再收到 tool:intent 消息",
      "",
      "// 3) 给**已经在运行**的工具发一条事件",
      'await call("tools.send", { tool: "size-chart", event: "rows", data: [...] });',
      "// 对方没在跑 → 明确报错，不会静默丢弃",
      F,
      "",
      "接收侧：",
      "",
      F + "js",
      'window.addEventListener("message", function (e) {',
      "  var m = e.data;",
      '  if (!m || m.source !== "workbench-host") return;',
      '  if (m.type === "tool:intent") use(m.data);              // 被拉起时交过来的数据',
      '  if (m.type === "tool:event") on(m.event, m.data);       // 别人发来的事件',
      "});",
      F,
      "",
      "设计理由（决定了你该怎么用它）：不想做一套通用事件总线。",
      "事件总线听着松耦合，但订阅方没在运行时这次发送是**静默丢失**的，",
      "用户点了\"发给 XX\"却什么都没发生 —— 那是最难查的一类故障。",
      "显式调用会先把对方拉起来，失败也能报出\"它没装 / 被停用了\"。",
      "",
      "## 二、图库",
      "",
      "图库是工作台里所有图片/视频的共同落点：图片裁剪的产物、尺码表的成品、",
      "AI 生成的结果都落在这里，工具也能从里面挑素材当输入。",
      "",
      F + "js",
      'var page = await call("gallery.list", { kind: "image", search: "包装", limit: 60 });',
      "// → { items: [{ id, title, kind, origin, width, height, size, createdAt, prompt, thumb, dup }] }",
      "//   thumb 是 320px 的缩略图 dataURL，列表直接能显示",
      "",
      'var one = await call("gallery.get", { id: "g-123" });',
      "// → { id, title, kind, dataUrl, mime, width, height }   ← 拿原图，有字节上限",
      "",
      'await call("gallery.put", {',
      '  dataUrl: "data:image/png;base64,...",   // 或者给 url，由宿主去下载',
      '  title: "成品图",',
      '  note: "8 月批次",',
      '  dedupe: true                            // 自动存档时传 true，同一份内容不重复占条目',
      "});",
      F,
      "",
      "**为什么 gallery.* 允许跨工具访问**（这是整套机制里唯一一次有意的边界放宽）：",
      "图库本来就是\"谁都能往里放、谁都能取\"的地方，需求如此；",
      "而且工具是用户自己装进来的 HTML，本来就能跑任意脚本，",
      "把图库挡在外面不会让恶意工具变安全，只会让正常工具写不出东西。",
      "仍然守住的：工具只能传 id（拿不到路径），写入大小有上限，",
      "来源由宿主盖章。",
      "",
      "## 三、自己的配置存哪里",
      "",
      F + "js",
      'await call("kv.set", { key: "config.model", value: "xxx" });',
      'var v = await call("kv.get", { key: "config.model" });  // → { key, value }（没配过是 null）',
      'var all = await call("kv.all", {});                      // → { entries: { ... } }',
      'await call("kv.del", { key: "config.model" });',
      F,
      "",
      "- 值必须是**字符串**，单条 ≤ 512 KB。要存对象就自己 JSON.stringify。",
      "- key 只允许字母数字与 `_ . : -`，1–64 位。",
      "- 配置和记录要分开：配置走 kv（\"上次选的模型\"这种，一条就够），",
      "  记录走私有表（\"我存的那些订单\"，会有很多条、要查询排序）。",
    ].join("\n"),
  },
];

/* ------------------------------------------------------------------ */
/* 助手自己写的技能（存在库里，v18 的 core_agent_skills）              */
/* ------------------------------------------------------------------ */

/**
 * 从库里读来的那几份。
 *
 * 为什么它是一份模块级缓存而不是每次读库：技能索引**每一轮对话都要拼进
 * system prompt**，而库在浏览器 demo 下是 localStorage、在桌面下是 SQLite —
 * 让每一轮都多一次往返不值得。反正写入方只有一个（add_skill / delete_skill
 * 动作），写完调一次 refresh 就行。
 */
let CUSTOM: AgentSkill[] = [];

/** 重新读库。失败就保留上一份 —— 少一条技能不至于让助手失忆 */
export async function refreshSkills(): Promise<void> {
  try {
    const rows = await repo.fetchAgentSkills();
    CUSTOM = rows
      .filter((r) => r.source === "agent")
      .map((r) => ({
        id: r.id,
        title: r.title,
        summary: r.summary,
        rules: r.rules,
        body: r.body,
        source: "agent" as const,
      }));
  } catch {
    // 库没起来（浏览器 demo 的第一帧）时保持现状
  }
}

/** 内置 + 助手自己写的。界面、提示词、read_skill 都看这一份 */
export function allSkills(): Array<AgentSkill & { source?: "builtin" | "agent" }> {
  return [...SKILLS.map((s) => ({ ...s, source: "builtin" as const })), ...CUSTOM];
}

/** 按 id 取技能（内置优先，再查助手自己写的） */
export function skillById(id: string): AgentSkill | undefined {
  return SKILLS.find((s) => s.id === id) ?? CUSTOM.find((s) => s.id === id);
}

/**
 * 常驻注入的那一段（索引 + 每个技能的硬规则）。
 *
 * 只给 rules 不给全文：全文由 read_skill 按需取。原因写在文件头，
 * 一句话是\"让具体怎么做只在需要时出现，模型对它的注意力反而更高\"。
 */
export function skillPromptBlock(): string {
  const parts = allSkills().map((s) => {
    const rules = s.rules.map((r) => `- ${r}`).join("\n");
    // 标出来源：助手得知道哪几条是自己存的（也就知道哪几条可以被自己改掉）
    const tag = s.source === "agent" ? "（你自己记的）" : "";
    return `### ${s.id} · ${s.title}${tag}\n${s.summary}\n${rules}`;
  });
  return [
    "## 你掌握的技能（硬规则常驻，全文用 read_skill 取）",
    "",
    ...parts,
    "",
    "要动手写工具或绑数据表之前，**先 read_skill 把对应的全文拉下来**再照做；",
    "规则里有\"违反了会怎样\"的说明，照着它自检一遍。",
  ].join("\n");
}

/** 技能清单（给界面展示用；与注入给模型的是同一份数据） */
export function skillsDigest(): Array<{
  id: string;
  title: string;
  summary: string;
  rules: number;
  source: "builtin" | "agent";
}> {
  return allSkills().map((s) => ({
    id: s.id,
    title: s.title,
    summary: s.summary,
    rules: s.rules.length,
    source: s.source ?? "builtin",
  }));
}

/** 私有表前缀示例（给技能面板与提示用，同时也是 toolPrefix 的一次真实调用） */
export function prefixExample(id = "overtime-log"): string {
  try {
    return toolPrefix(id);
  } catch {
    return "tool_<id>_";
  }
}

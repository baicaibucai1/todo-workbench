/**
 * 助手和模型之间的**动作协议**。
 *
 * ------------------------------------------------------------------
 * 为什么要有两条通道
 * ------------------------------------------------------------------
 * 模型要"替你干活"，就得有办法表达"我要执行 install_tool，参数是这些"。
 * 主流做法是原生 function calling（`tools` 参数 + `tool_calls` 响应），
 * 这里也发它 —— 但**不能只靠它**：
 *
 *   · 有些网关会静默忽略 `tools` 参数（返回 200，就是不调用工具）；
 *   · 有些中转会改写 tool_calls 的形状（把 name 塞进 arguments、丢掉 id）；
 *   · 推理型模型偶尔把工具调用写成一段普通 JSON 文本。
 *
 * 这三种情况的表现全都是"它说它做了，但什么都没发生"—— 最难查的一类。
 * 所以第二条通道是：**模型在回复里写一个约定格式的代码块**，
 *
 *   ```workbench
 *   { "tool": "create_schedules", "args": { ... } }
 *   ```
 *
 * 一次多个动作就写成一个数组。这条通道在任何只支持纯文本的模型上都能用，
 * 也是"换一家便宜模型"时不会突然变哑巴的保险。
 *
 * 两条通道都会走同一套校验与执行（actions.ts），所以能力上没有差别；
 * 差别只在"谁先说出口"。解析优先级：原生 tool_calls > 代码块。
 * 同一轮里两者都有时**只认原生** —— 那种情况说明模型在文本里又复述了一遍，
 * 两份执行会真的建出双份日程。
 *
 * ------------------------------------------------------------------
 * 为什么动作名和 JSON Schema 写在这里，而不是各写一份
 * ------------------------------------------------------------------
 * 这四个地方要知道"助手能做哪些事"：模型看到的 tools 定义、解析器认哪些名字、
 * executor 的分发、以及界面上的权限说明。各写一份的结果必然是
 * "加了个动作但模型不知道"，或者"模型调了一个没人实现的动作"。
 * 所以 AGENT_TOOLS 是唯一的一份，另外三处都从它读。
 */

import type { AgentPermissions } from "./types";
import { SKILLS } from "./skills";
import type { RawToolCall } from "./providers";

export interface AgentToolSpec {
  name: string;
  /** 中文短名，动作卡上显示它（用户不该看到 install_tool 这种词） */
  label: string;
  /** 给模型看的说明：什么时候该用它、什么时候不该用 */
  description: string;
  /** OpenAI function calling 的参数 JSON Schema */
  parameters: Record<string, unknown>;
  /** 需要哪一项权限。没有表示只读，永远允许 */
  permission?: keyof AgentPermissions;
  /** 需要桌面端（浏览器演示模式给诚实提示，而不是假装成功） */
  needsDesktop?: boolean;
}

const S = (o: Record<string, unknown>) => o;

export const AGENT_TOOLS: AgentToolSpec[] = [
  /* --------------------------- 和人打交道 --------------------------- */
  /*
   * 这两个是**对话层的控制流**，不是"我替你干了件事"：调用它们会真的
   * 停下来等用户点一下（见 runtime 的 ask）。所以它们的 Handler 不在
   * actions.ts 里 —— 那一层是纯逻辑（Node 里给个假 host 就能测），
   * 而"等人"必须有界面。
   */
  {
    name: "ask_user_choice",
    label: "询问你的选择",
    description:
      "把一个问题摆给用户点选，你会**在这一步停下来等他**，他点完你立刻拿到结果继续。" +
      "什么时候该用：做法有好几种都说得通、他给的指令缺一个关键信息（给谁做、放哪个清单、要哪种风格）、" +
      "或者你连问两个问题都问不出答案时让他直接挑一个。" +
      "⚠️ 别滥用：能从上下文推断的就自己定，一轮对话最多问一两次；" +
      "也不要拿它确认\"要不要动手\"（那是 confirm_action 的事）。" +
      "选项要给 2~6 个**互斥**的，label 说人话、value 给短值。",
    parameters: S({
      type: "object",
      properties: {
        question: S({ type: "string", description: "一句话问题，会显示成卡片标题" }),
        detail: S({
          type: "string",
          description: "补充说明：为什么问、各选项的差别。可省略",
        }),
        options: S({
          type: "array",
          description: "2~6 个选项",
          items: S({
            type: "object",
            properties: {
              label: S({ type: "string", description: "用户看到的文字" }),
              value: S({ type: "string", description: "回给你的值，几个词就够" }),
              note: S({ type: "string", description: "一行小字，说清这个选项的后果。可省略" }),
            },
            required: ["label"],
          }),
        }),
        allow_text: S({
          type: "boolean",
          description:
            "允不允许他自己打字回答（默认 true）。只有在选项真的穷尽、写\"其他\"没意义时才给 false",
        }),
      },
      required: ["question", "options"],
    }),
  },
  {
    name: "confirm_action",
    label: "请你确认",
    description:
      "**要动不可逆或影响面大的东西之前先拿许可。** 典型场景：删待办、一次改三条以上、" +
      "覆盖用户已有的工具、替换已有的一批子任务。你会停下来等他点「确认」或「取消」；" +
      "他说取消就**不要做**，也不要换个方式偷偷做 —— 可以问他要怎么改。" +
      "⚠️ 宿主对这类动作本身还有一道强制确认（比如 delete_schedules），所以你直接调它们也行；" +
      "但先问一句能让用户在动手之前就知道你要干什么。" +
      "affects 里写下你拿到许可后要执行的动作名（如 [\"delete_schedules\"]），" +
      "这样宿主不会再问第二遍。",
    parameters: S({
      type: "object",
      properties: {
        question: S({ type: "string", description: "一句话：你要做什么、会影响到什么" }),
        detail: S({ type: "string", description: "具体到条数与名字，让他能判断。可省略" }),
        affects: S({
          type: "array",
          description: '拿到许可后要执行的动作名，如 ["delete_schedules"]。省略表示只是问一句',
          items: S({ type: "string" }),
        }),
        danger: S({
          type: "boolean",
          description: "破坏性（删除、覆盖）给 true，确认按钮会用醒目色。默认 true",
        }),
      },
      required: ["question"],
    }),
  },

  /* ------------------------------- 技能 ------------------------------- */
  {
    name: "read_skill",
    label: "查阅技能",
    description:
      "取一份技能全文。写工具、绑数据表、算日期之前必须先取对应的那一份再照做。" +
      `可用的 id：${SKILLS.map((s) => s.id).join(" / ")}`,
    parameters: S({
      type: "object",
      properties: {
        id: S({
          type: "string",
          description: "技能 id，如 tool-authoring",
          enum: SKILLS.map((s) => s.id),
        }),
      },
      required: ["id"],
    }),
  },

  /* ------------------------------- 工具 ------------------------------- */
  {
    name: "list_tools",
    label: "查看已装工具",
    description:
      "列出这台工作台上已安装的工具（id / 名称 / 版本 / 来源 / 有没有自己的数据表）。" +
      "要改或要参考某个已有工具时先用它，不要凭空猜 id。",
    parameters: S({ type: "object", properties: {} }),
  },
  {
    name: "read_tool",
    label: "读取工具",
    description:
      "读一个已装工具的 manifest，必要时连同它的 HTML 源码一起读回来。" +
      "改一个已有工具之前必须先读，否则你会覆盖掉用户自己改过的部分。",
    parameters: S({
      type: "object",
      properties: {
        id: S({ type: "string", description: "工具 id" }),
        include_html: S({
          type: "boolean",
          description: "是否把 HTML 源码也读回来（默认 false，只在要改它时给 true）",
        }),
      },
      required: ["id"],
    }),
  },
  {
    name: "install_tool",
    label: "安装工具",
    description:
      "把一个单 HTML 工具装进工作台（写进工具目录，装完就出现在侧边栏）。" +
      "html 必须是完整、自包含的 HTML 文档；需要存数据时同时给 schema。" +
      "⚠️ 源码很长时**不要把它塞进这个参数**（JSON 里的换行/引号极易转义坏，" +
      "接口会直接拒收）：参数里只给 id 与 name，整份源码另起一个 ```html 代码块写在正文里。" +
      "写之前先 read_skill 取 tool-authoring 的全文。",
    parameters: S({
      type: "object",
      properties: {
        id: S({
          type: "string",
          description: "工具 id：小写字母/数字/连字符，字母开头，2-32 位。会成为私有表前缀",
        }),
        name: S({ type: "string", description: "侧边栏显示的中文名（短）" }),
        description: S({ type: "string", description: "一句话说明它做什么" }),
        icon: S({
          type: "string",
          description:
            "图标名，从这个清单里选：sun star calendar inbox home package crop receipt image calculator file list settings boxes sparkles video hash notebook-pen bot",
        }),
        html: S({ type: "string", description: "完整 HTML 文档源码（自包含，CSS/JS 内联）" }),
        schema: S({
          type: "object",
          description:
            "私有数据表声明，形状为 { tables: [{ name, columns: [{name,type,pk?,notNull?,default?}], indexes? }] }。" +
            "不需要存数据就省略。列的规则见 read_skill 的 data-binding",
        }),
        overwrite: S({
          type: "boolean",
          description:
            "已存在同名工具时是否覆盖。默认 false。用户明确要求更新那个工具时才给 true",
        }),
      },
      required: ["id", "name", "html"],
    }),
    permission: "writeTools",
    needsDesktop: true,
  },
  {
    name: "open_tool",
    label: "打开工具",
    description: "把某个已装工具在工作台里打开给用户看。刚装完一个工具时用它。",
    parameters: S({
      type: "object",
      properties: { id: S({ type: "string", description: "工具 id" }) },
      required: ["id"],
    }),
  },

  /* ----------------------------- 数据表绑定 ----------------------------- */
  {
    name: "bind_database",
    label: "绑定数据表",
    description:
      "把一个工具的数据表声明写进它的 manifest（这就是'给工具绑定数据库'）。" +
      "工具本来没有表、或者要改表结构时用它。写之前先 read_skill 取 data-binding 的全文。" +
      "⚠️ 内置工具不能这么改（升级会覆盖），这种情况要复制成一个新 id 的自有工具。",
    parameters: S({
      type: "object",
      properties: {
        tool_id: S({ type: "string", description: "要绑定的工具 id" }),
        schema: S({
          type: "object",
          description: "同 install_tool 的 schema",
        }),
        reason: S({
          type: "string",
          description: "一句话说明为什么要绑这些列，会显示给用户看",
        }),
      },
      required: ["tool_id", "schema"],
    }),
    permission: "database",
    needsDesktop: true,
  },

  /* ------------------------------- 日程 ------------------------------- */
  {
    name: "list_lists",
    label: "查看清单",
    description: "列出工作台里已有的待办清单及各自未完成条数。建日程前想确认落点时用它。",
    parameters: S({ type: "object", properties: {} }),
  },
  {
    name: "list_schedules",
    label: "查看日程",
    description:
      "读工作台里的待办（= 日程）。range=today 只看今天、week 看未来七天、" +
      "overdue 看已逾期、all 看全部未完成。用户问'我今天有什么安排'时用它，不要凭空编。",
    parameters: S({
      type: "object",
      properties: {
        range: S({
          type: "string",
          enum: ["today", "week", "overdue", "all"],
          description: "默认 today",
        }),
        limit: S({ type: "number", description: "最多返回多少条，默认 30" }),
      },
    }),
  },
  {
    name: "create_schedules",
    label: "创建日程",
    description:
      "在工作台里建待办（= 日程），一次可以建多条。日期与时刻一律按**本地时间**给：" +
      "due_date 用 YYYY-MM-DD，remind_at 用 YYYY-MM-DDTHH:mm。" +
      "用户说了时刻才设 remind_at；需要几步才能做完的事用 steps 拆子任务，" +
      "子任务的 due_at 要带时刻。先 read_skill 取 schedule 全文再算日期。",
    parameters: S({
      type: "object",
      properties: {
        items: S({
          type: "array",
          description: "要建的日程，可以一次给多条",
          items: S({
            type: "object",
            properties: {
              title: S({ type: "string", description: "一行标题" }),
              note: S({ type: "string", description: "细节，可省略" }),
              list: S({
                type: "string",
                description: "放进哪个清单（按名字匹配）。省略则放进第一个清单；不存在时会新建",
              }),
              due_date: S({ type: "string", description: "计划日期，本地 YYYY-MM-DD" }),
              due_time: S({
                type: "string",
                description: "HH:mm。给了它就等于同时设了那天的到点提醒",
              }),
              remind_at: S({
                type: "string",
                description: "到点提醒，本地 YYYY-MM-DDTHH:mm。与 due_time 二选一，给了 due_time 就不用给",
              }),
              important: S({ type: "boolean" }),
              my_day: S({ type: "boolean", description: "是否加进「我的一天」" }),
              repeat: S({ type: "string", enum: ["none", "daily"] }),
              steps: S({
                type: "array",
                description: "子任务",
                items: S({
                  type: "object",
                  properties: {
                    title: S({ type: "string" }),
                    due_at: S({
                      type: "string",
                      description: "本地 YYYY-MM-DDTHH:mm。要带时刻，否则它进不了紧急区",
                    }),
                  },
                  required: ["title"],
                }),
              }),
            },
            required: ["title"],
          }),
        }),
      },
      required: ["items"],
    }),
    permission: "schedules",
  },
  {
    name: "update_schedules",
    label: "修改日程",
    description:
      "改已有的待办：标题、备注、计划日期、提醒时刻、重要、我的一天、所属清单、完成状态。" +
      "先用 list_schedules 拿到 id（**不要猜 id**）。只给要改的字段，没给的字段保持原样。" +
      "想**清空**某个字段就给空串（\"\"）—— 比如把到期日去掉。" +
      "一次改 4 条以上宿主会先弹一次确认（改错了要一条条找回来），直接给全就行。",
    parameters: S({
      type: "object",
      properties: {
        items: S({
          type: "array",
          description: "要改的待办，每条按 id 定位",
          items: S({
            type: "object",
            properties: {
              id: S({ type: "string", description: "待办 id（从 list_schedules 得到）" }),
              title: S({ type: "string" }),
              note: S({ type: "string" }),
              list: S({ type: "string", description: "改到哪个清单（按名字匹配，不存在会新建）" }),
              due_date: S({
                type: "string",
                description: "本地 YYYY-MM-DD。给空串表示去掉日期",
              }),
              due_time: S({
                type: "string",
                description: "HH:mm。给了它就等于同时设了那天的到点提醒（需要 due_date）",
              }),
              remind_at: S({
                type: "string",
                description: "本地 YYYY-MM-DDTHH:mm。给空串表示去掉提醒",
              }),
              important: S({ type: "boolean" }),
              my_day: S({ type: "boolean" }),
              done: S({ type: "boolean", description: "true 勾完成，false 取消完成" }),
              repeat: S({ type: "string", enum: ["none", "daily"] }),
            },
            required: ["id"],
          }),
        }),
      },
      required: ["items"],
    }),
    permission: "schedules",
  },
  {
    name: "delete_schedules",
    label: "删除日程",
    description:
      "删掉待办（连同它的子任务）。**这是不可逆的**，所以宿主会在执行前弹一次确认让用户点头 —— " +
      "你直接调它就行，不需要先 confirm_action。删之前先 list_schedules 拿到准确 id；" +
      "要清掉一整批就一次给全 ids，别一条条调。",
    parameters: S({
      type: "object",
      properties: {
        ids: S({
          type: "array",
          description: "要删的待办 id",
          items: S({ type: "string" }),
        }),
        reason: S({ type: "string", description: "一句话说明为什么删，会显示在确认卡上" }),
      },
      required: ["ids"],
    }),
    permission: "schedules",
  },
  {
    name: "update_steps",
    label: "改子任务",
    description:
      "给一个待办**追加 / 修改 / 删除 / 勾选**子任务。op 决定做什么：" +
      "add（给 task_id + title）、update（给 step_id + 要改的字段）、" +
      "delete（给 step_id，宿主会弹一次确认）、done（给 step_id + done）。" +
      "step_id 从 list_schedules 返回的 steps 里拿（那里带了 id）。",
    parameters: S({
      type: "object",
      properties: {
        items: S({
          type: "array",
          description: "要做的改动，一次可以给多条",
          items: S({
            type: "object",
            properties: {
              op: S({ type: "string", enum: ["add", "update", "delete", "done"] }),
              task_id: S({ type: "string", description: "op=add 时必给" }),
              step_id: S({ type: "string", description: "op=update/delete/done 时必给" }),
              title: S({ type: "string" }),
              due_at: S({
                type: "string",
                description: "本地 YYYY-MM-DDTHH:mm（要带时刻，否则进不了紧急区）。空串表示清掉",
              }),
              done: S({ type: "boolean" }),
            },
            required: ["op"],
          }),
        }),
      },
      required: ["items"],
    }),
    permission: "schedules",
  },
];

export function toolSpec(name: string): AgentToolSpec | undefined {
  return AGENT_TOOLS.find((t) => t.name === name);
}

/**
 * "停下来问用户"的两个动作。
 *
 * 它们和别的动作**走的路不一样**：别的动作在 actions.ts 里有一个纯函数式的
 * handler（Node 里给个假 host 就能单测），而这两个必须 await 一个真人 ——
 * 所以由 runtime 直接处理，不进 HANDLERS。
 *
 * 抽成常量而不是在两处各写一遍名字：漏改一处的症状是"动作卡显示成功、
 * 但用户根本没被问过"，而那是最难发现的一类。
 */
export const ASK_TOOLS = ["ask_user_choice", "confirm_action"] as const;

export function isAskTool(name: string): boolean {
  return (ASK_TOOLS as readonly string[]).includes(name);
}

/** 发给模型的原生工具定义（OpenAI 形状） */
export function toolsForModel(
  allow: (spec: AgentToolSpec) => boolean = () => true,
): Array<Record<string, unknown>> {
  return AGENT_TOOLS.filter(allow).map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/* ------------------------------------------------------------------ */
/* 文本通道                                                            */
/* ------------------------------------------------------------------ */

/**
 * 代码块围栏。接受三种语言标记：
 *   workbench  —— 约定的正牌标记
 *   json       —— 模型很喜欢写这个，见到里面是 {tool, args} 就认
 *   （无标记）  —— 同上，靠内容形状判断
 */
const FENCE_RE = /```([a-zA-Z-]*)\s*\n([\s\S]*?)```/g;

const ACTION_LANGS = new Set(["", "workbench", "workbench-action", "json", "actions"]);

export interface ParsedAction {
  name: string;
  args: Record<string, unknown>;
  /**
   * 参数原本不是合法 JSON，是**修好之后**才解析出来的。
   * 保持原样的调用不带这个标记。带它的调用在执行结果里会被提醒一句 ——
   * 不提醒的话，模型会一直用同一种坏写法（它看不到自己发的字符串长什么样）。
   */
  repaired?: boolean;
}

export interface ParseResult {
  actions: ParsedAction[];
  /** 认出来是动作、但用不了的原因（未知动作名、JSON 坏了）。会回给模型让它改 */
  errors: string[];
  /** 去掉动作代码块之后的正文 —— 那段 JSON 是给机器看的，不该展示给用户 */
  cleanText: string;
}

/**
 * 从一段文本里抠出动作。
 *
 * 判定条件刻意收紧到三条同时成立：语言标记在白名单里、能 JSON 解析、
 * 形状是 `{tool: <已知动作名>, args}`（或这种对象的数组）。
 * 只凭"里面有 tool 这个词"就认的话，模型在解释自己做了什么时随手写的示例
 * 也会被当成真动作执行 —— 那会真的建出双份数据。
 */
export function extractActions(text: string): ParseResult {
  const actions: ParsedAction[] = [];
  const errors: string[] = [];
  let clean = "";
  let last = 0;

  FENCE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FENCE_RE.exec(text))) {
    const lang = (m[1] ?? "").toLowerCase();
    const body = (m[2] ?? "").trim();
    const hit = ACTION_LANGS.has(lang) ? readActionBlock(body, errors) : null;
    if (!hit) continue;

    actions.push(...hit);
    // 命中：把这一段整体从正文里去掉（连同前面的换行，免得留一堆空行）
    clean += text.slice(last, m.index).replace(/\n+$/, "\n");
    last = m.index + m[0].length;
  }
  clean += text.slice(last);

  return { actions, errors, cleanText: clean.trim() };
}

function readActionBlock(body: string, errors: string[]): ParsedAction[] | null {
  if (!body) return null;
  const hit = parseWithRepair(body);
  if (!hit) {
    // 不是合法 JSON：只在它明显想当动作时报错（避免把普通 JSON 示例也报一遍）
    if (/"tool"\s*:/.test(body)) {
      errors.push("动作代码块不是合法的 JSON，无法执行。请只给一个 JSON 对象，字符串里的换行要写成 \\n");
    }
    return null;
  }
  const parsed = hit.value;

  const list = Array.isArray(parsed) ? parsed : [parsed];
  const out: ParsedAction[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") return null;
    const o = item as { tool?: unknown; args?: unknown; name?: unknown; arguments?: unknown };
    const name = typeof o.tool === "string" ? o.tool : typeof o.name === "string" ? o.name : "";
    if (!name) return null;
    if (!toolSpec(name)) {
      errors.push(`不认识的动作「${name}」。可用的动作：${AGENT_TOOLS.map((t) => t.name).join("、")}`);
      // 记一笔错就够，不重复报同一个（下面 buildSystem 里也只有一份动作清单）
      continue;
    }
    const rawArgs = o.args ?? o.arguments ?? {};
    out.push({
      name,
      args: rawArgs && typeof rawArgs === "object" ? (rawArgs as Record<string, unknown>) : {},
      repaired: hit.repaired,
    });
  }
  return out.length ? out : null;
}

/**
 * 「HTML 写在旁边那个代码块里」的兜底。
 *
 * 现实里模型很爱这么干：动作块里只写 `{tool:"install_tool", args:{id, name}}`，
 * 然后另起一个 ```html 块放整份源码。硬要求它把 HTML 塞进 JSON 字符串
 * 也能work（原生 tool_calls 那条路必须这样），但两种写法都收到、
 * 都认，比让用户看到一句"参数不合法"好得多。
 *
 * 只在 args.html 空着时才启用（显式给了就以显式为准）。
 */
export function htmlFromBlocks(text: string): string {
  const re = /```(?:html|htm)\s*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const body = m[1] ?? "";
    if (/<html[\s>]/i.test(body) || /<body[\s>]/i.test(body)) return body.trimEnd();
  }
  return "";
}

/** 填充 install_tool 的 html 参数（原生 tool_calls 那条路也会用到） */
export function withHtmlFallback(
  name: string,
  args: Record<string, unknown>,
  text: string,
): Record<string, unknown> {
  if (name !== "install_tool") return args;
  const has = typeof args.html === "string" && args.html.trim().length > 0;
  if (has) return args;
  const fromBlock = htmlFromBlocks(text);
  return fromBlock ? { ...args, html: fromBlock } : args;
}

/* ------------------------------------------------------------------ */
/* 模型给的参数                                                         */
/* ------------------------------------------------------------------ */

export type ToolArgsResult =
  | { ok: true; args: Record<string, unknown>; repaired: boolean }
  | { ok: false; reason: "not-object" | "bad-json" };

/**
 * 把模型给的参数串解析成对象，**坏 JSON 先试着修**。
 *
 * 为什么不直接报错：install_tool 的参数里要塞一整份 HTML，而模型经常会在
 * JSON 字符串里写出**裸换行**（而不是 `\n`）。这种串在它那边完全"看起来是对的"，
 * 在 JSON.parse 眼里却是坏的 —— 结果"给我做个五子棋"就卡在一句参数报错上，
 * 而用户完全无从下手（他看不到那个字符串）。
 *
 * 只修三种**无歧义**的：字符串内部的裸控制字符、多余的尾逗号、外面套了一层
 * 代码围栏。三种之外一律不猜 —— 把参数猜错（比如少一截 HTML）比报错更坏：
 * 那会装上一个坏掉的文件。
 */
export function parseToolArgs(raw: string): ToolArgsResult {
  const text = stripFence(raw.trim());
  if (!text) return { ok: true, args: {}, repaired: false };

  const hit = parseWithRepair(text);
  if (!hit) return { ok: false, reason: "bad-json" };
  const obj = asObject(hit.value);
  return obj ? { ok: true, args: obj, repaired: hit.repaired } : { ok: false, reason: "not-object" };
}

/**
 * 先原样解析，失败再试**无歧义**的几种修法，返回第一个成功的值。
 *
 * 抽出来是因为**两条通道都需要它**：原生 tool_calls 的 arguments 会带裸换行，
 * 写在 workbench 代码块里的那段 JSON 一样会 —— 都是同一个模型写的。
 * 只修一处的结果是"换条通道就又不认了"，那种 bug 最难解释给用户听。
 *
 * 候选顺序有讲究：**先整串修、再抠花括号**。反过来的话，一个
 * `[{"tool":…},]` 这种带尾逗号的数组会被抠成对象，形状就错了。
 */
function parseWithRepair(text: string): { value: unknown; repaired: boolean } | null {
  const direct = safeParse(text);
  if (direct !== undefined) return { value: direct, repaired: false };

  const escaped = escapeBareControlChars(text);
  const candidates: string[] = [];
  for (const base of [escaped, sliceOuterBraces(escaped)]) {
    if (!base || candidates.includes(base)) continue;
    candidates.push(base, dropTrailingCommas(base));
  }
  for (const cand of candidates) {
    const v = safeParse(cand);
    if (v !== undefined) return { value: v, repaired: true };
  }
  return null;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** 去掉外面套的代码围栏（模型偶尔把参数整个包进 ``` 里） */
function stripFence(s: string): string {
  const m = /^```[a-zA-Z-]*\s*\n([\s\S]*?)\n?```$/.exec(s);
  return m ? (m[1] ?? "").trim() : s;
}

/**
 * 把**字符串内部**的裸控制字符转义掉。
 *
 * 这是最常见的一种坏 JSON：模型写 `"html": "<html>\n<body>"` 时给的是真的
 * 换行字节，而不是 `\n` 这两个字符。JSON 规范不允许字符串里有裸换行，
 * 但人（和模型）写起来毫无感觉 —— 一整份 HTML 里这种地方有几十处。
 *
 * 只在"直接解析失败"之后才跑，所以不会去动本来就合法的转义。
 */
function escapeBareControlChars(s: string): string {
  let out = "";
  let inStr = false;
  let escaped = false;
  for (const ch of s) {
    if (!inStr) {
      if (ch === '"') inStr = true;
      out += ch;
      continue;
    }
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inStr = false;
      out += ch;
      continue;
    }
    const code = ch.charCodeAt(0);
    if (code < 0x20) {
      out +=
        code === 10 ? "\\n" : code === 13 ? "\\r" : code === 9 ? "\\t" : `\\u${code.toString(16).padStart(4, "0")}`;
      continue;
    }
    out += ch;
  }
  return out;
}

/** 去掉 `[1,2,]` / `{"a":1,}` 这种尾逗号 */
function dropTrailingCommas(s: string): string {
  return s.replace(/,(\s*[}\]])/g, "$1");
}

/** 前面带了「好的，参数是：」之类前言时，抠出最外层那一对花括号 */
function sliceOuterBraces(s: string): string {
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  return a >= 0 && b > a ? s.slice(a, b + 1) : "";
}

/* ------------------------------------------------------------------ */
/* 原生 tool_calls                                                     */
/* ------------------------------------------------------------------ */

/**
 * 把原生 tool_calls 转成动作。
 *
 * arguments 是**字符串**（模型给的 JSON 文本），可能是坏的 —— 比如把一个
 * 没转义的换行塞进了 HTML 里。先用 parseToolArgs 试着修（见它的注释），
 * 修不动才记一条错，让模型下一轮自己改（它看得到回灌进去的结果）。
 */
export function actionsFromToolCalls(calls: RawToolCall[]): {
  actions: Array<ParsedAction & { id: string }>;
  errors: string[];
} {
  const actions: Array<ParsedAction & { id: string }> = [];
  const errors: string[] = [];
  for (const c of calls) {
    if (!c.name) {
      errors.push("收到一个没有函数名的工具调用，已忽略");
      continue;
    }
    if (!toolSpec(c.name)) {
      errors.push(`不认识的动作「${c.name}」`);
      continue;
    }
    const r = parseToolArgs(c.args ?? "");
    if (!r.ok) {
      if (r.reason === "not-object") {
        errors.push(`${c.name} 的参数不是对象，已按空参数处理`);
        actions.push({ id: c.id, name: c.name, args: {} });
      } else {
        errors.push(`${c.name} 的参数不是合法 JSON，已忽略这次调用（${argHint(c.name)}）`);
      }
      continue;
    }
    actions.push({ id: c.id, name: c.name, args: r.args, repaired: r.repaired });
  }
  return { actions, errors };
}

/** 参数坏掉时给模型一句"具体怎么改"，而不是只说"不合法" */
function argHint(name: string): string {
  return name === "install_tool"
    ? "常见原因有两个：HTML 里的换行/引号没转义，或者内容太长被截断了。" +
        "改成：参数里只给 id 与 name，整份源码另起一个 ```html 代码块"
    : "请只给一个 JSON 对象，字符串里的换行要写成 \\n";
}

/**
 * 回灌历史时用的 tool_calls。
 *
 * ⚠️ 这里最要紧的一条：**绝不把原始 arguments 字符串原样发回去**。
 * 服务端会校验我们带回去的这条 assistant 消息（它就是上一轮"收到"的东西），
 * 一个坏 JSON 会让**整次请求** 400：
 *
 *   Assistant tool call xxx.arguments must be valid JSON.
 *
 * 症状极难查：用户看到的是"助手突然报了一句接口错误"，而真正的原因是
 * 上一轮模型少转义了一个换行。所以 ——
 *
 *   · 解析成功的：用 JSON.stringify(args) 重新序列化，一定合法；
 *   · 没解析成功的：**整个调用不回灌**（它本来也没执行，没有 tool 结果要配对）。
 */
export function toolCallsForEcho(
  calls: RawToolCall[],
  actions: Array<ParsedAction & { id: string }>,
): Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> {
  const byId = new Map(actions.map((a) => [a.id, a]));
  const out: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = [];
  for (const c of calls) {
    const a = byId.get(c.id);
    if (!a) continue;
    out.push({
      id: c.id,
      type: "function",
      function: { name: a.name, arguments: JSON.stringify(a.args) },
    });
  }
  return out;
}

/**
 * 注入 system prompt 的动作协议说明。
 *
 * 有了原生 tools 为什么还要写这段：第一条通道不一定通（见文件头），
 * 而且模型在"要不要动手"这件事上的判断**几乎完全来自这段描述** ——
 * tools 定义里只有参数长相，没有"什么时候该用"。
 */
export function actionProtocolBlock(): string {
  const lines = AGENT_TOOLS.map((t) => `- \`${t.name}\` · ${t.label}：${t.description}`);
  return [
    "## 你能执行的动作",
    "",
    ...lines,
    "",
    "调用方式：优先用工具调用（tool calls）。如果这次请求没有带上工具定义、",
    "或者你无法发起工具调用，就把动作写成下面这种代码块放在回复最后：",
    "",
    "```workbench",
    '{ "tool": "create_schedules", "args": { "items": [ { "title": "..." } ] } }',
    "```",
    "",
    "一次多个动作就写成一个数组。**不要**在正文里解释这个 JSON 的字段含义",
    "（用户不需要看），正文里只说人话：你做了什么、结果如何、需要用户确认什么。",
    "",
    "⚠️ 参数里有**大段文本**（最典型的是 install_tool 的 HTML）时，别塞进动作块的 JSON 里：",
    "字符串里的换行与引号很容易转义坏，接口会直接拒收，用户只看到一句看不懂的报错。",
    "改成动作块只给短字段、源码另起一个代码块：",
    "",
    "```workbench",
    '{ "tool": "install_tool", "args": { "id": "my-tool", "name": "我的工具" } }',
    "```",
    "```html",
    "<!doctype html>…（整份源码放这里，不要塞进上面那行 args）",
    "```",
  ].join("\n");
}

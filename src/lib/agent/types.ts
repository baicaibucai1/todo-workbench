/**
 * 内置 AI 助手的数据形状。
 *
 * 单独一个文件而不是塞进 src/types.ts：types.ts 装的是**业务数据模型**
 * （待办、流程任务、图库…），它们对应真实的表；而这里装的是"助手这一侧"
 * 的东西 —— 配置、权限、它做过的一件事。唯一落库的是 AgentMessage
 * （见 migrations 的 v15），其余都是运行时的形状。
 */

/** 一次对话里，助手**真做过的一件事**（而不是它说自己做了） */
export interface AgentAction {
  /** 动作名，与 actions.ts 里的注册表同名 */
  tool: string;
  /** 传给它的参数（原文保留，供界面展开查看与复制） */
  args: Record<string, unknown>;
  ok: boolean;
  /** 一句话结论，直接显示在卡片上 */
  summary: string;
  /** 展开后看的细节：路径、生成的 HTML、表结构、失败原因… */
  detail?: string;
  /** ok=false 时的原因。也会回给模型，让它能改 */
  error?: string;
}

/** 一条对话消息（落库的形状见 repo.AgentMessageRow） */
export interface AgentMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  actions: AgentAction[];
  error: string;
  seq: number;
  createdAt: string;
}

/**
 * 一个选项（挂起的问题上的按钮）。
 *
 * 分成 label 与 value 两个字段，是因为它们服务两个不同的读者：
 * 用户读 label（人话），模型读 value（能塞进 JSON 的短值）。合成一个的话，
 * 要么用户看到 `add_column` 这种词，要么模型收到一句带标点的长句子
 * —— 后者会让它下一轮的动作参数里出现奇怪的东西。
 */
export interface AgentAskOption {
  /** 回给模型的值，短、稳定 */
  value: string;
  /** 用户看到的文字 */
  label: string;
  /** 选项下面一行小字，说清后果（可省） */
  note?: string;
}

/**
 * 一个**挂起的问题**：助手停下来等用户拍板。
 *
 * ------------------------------------------------------------------
 * 为什么它不是一个"动作"，而是运行时状态
 * ------------------------------------------------------------------
 * 动作是"我替你干了件事"，而它是"这件事得你说"。执行动作时用户不在场
 * 也照样能跑完（装工具、建日程），但这里**必须**有人点一下 ——
 * 所以它在 runtime 里是一个 await 住的 Promise，界面是这个 Promise 的
 * 一扇窗（见 runtime 的 ask / answerAsk）。
 *
 * 它**不落库**：挂起态只活在内存里，重启就没了。落库的是这个问题的
 * **结果**（一条"询问你的选择 → 你选了 X"的动作卡，见 runtime.execute）。
 * 记结果而不记挂起态，是因为重启之后那个问题已经不再有人能回答了。
 *
 * 两种 kind 的差别只在**语气**，机制完全一样：
 *   · choice  —— "你要哪一种？"（用户在几个做法里挑）
 *   · confirm —— "我要这么干，行吗？"（不可逆或影响面大的事）
 * 分开是为了让界面能给出不同的重量（确认卡更显眼、危险时用醒目色），
 * 而不是因为底层要分两条路。
 */
export interface AgentAsk {
  id: string;
  kind: "choice" | "confirm";
  /**
   * 谁发起的问题：
   *   · model —— 模型主动问（它调了 ask_user_choice / confirm_action）
   *   · host  —— 宿主在动手之前拦下来问（强制确认门，见 actions.describeConfirm）
   *
   * 界面靠它换一句话：前者是"助手想问你"，后者是"这一步得你先点头"。
   * 用户对这两种情况的感受不一样 —— 前者可以懒得答，后者是刹车。
   */
  source: "model" | "host";
  question: string;
  /** 补充说明：为什么问、要动什么、影响几条 */
  detail: string;
  options: AgentAskOption[];
  /**
   * 允不允许用户自己打字回答。
   *
   * 默认允许 —— 选项是模型想的，而用户想说的经常不在里面（"都不是，我要…"）。
   * 只能在选项真的穷尽时才关掉它。
   */
  allowText: boolean;
  /** 破坏性操作：确认按钮走醒目色，别让用户顺手点过去 */
  danger: boolean;
}

/**
 * 助手的权限。
 *
 * 三项都是**用户可关**的，而且关掉之后要给出"谁关的、怎么开"这种能自己解决的话，
 * 而不是一句含糊的"没有权限" —— 模型拿到的错误信息就是界面能说的全部，
 * 它写得含糊，用户就只能猜。
 *
 * 默认全开：内置的助手如果不能干活，那它就只是一个更贵的输入框。
 * 但**默认开不等于不能关** —— 一个能改你文件系统的东西，必须有一个明确的刹车。
 */
export interface AgentPermissions {
  /** 写工具：在工具目录里安装 / 覆盖一个单 HTML 工具 */
  writeTools: boolean;
  /** 建日程：往 core_tasks 里写待办与子任务 */
  schedules: boolean;
  /** 绑数据表：改写一个工具 manifest 里的 schema 声明 */
  database: boolean;
}

/** 助手使用的模型配置。键名见 lib/settings.ts 的 SETTINGS.agent* */
export interface AgentConfig {
  /** 服务商 id（见 providers.ts 的 AGENT_PROVIDERS） */
  provider: string;
  /** 接口根地址，如 https://apihub.agnes-ai.com/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
}

/**
 * 一段对话在界面上的样子（历史列表的一项）。
 *
 * 真身是 repo 的 `AgentChatRow`，这里是它被界面用到的那部分 —— 分成两个类型
 * 不是重复定义，而是让 runtime 不必依赖 repo 的取数细节：列表里显示的
 * 条数与摘要都是**读的时候现算**的（见 AgentChatRow 的注释）。
 */
export interface AgentChatSummary {
  id: string;
  title: string;
  createdAt: string;
  /** 最后一次有动静的时间（ISO）。列表按它倒序排 */
  updatedAt: string;
  /** 里面有几句对话 */
  messageCount: number;
  /** 最后一句的摘要，用来分辨两段都还没起名字的对话 */
  preview: string;
}

/** 运行时的对话状态。UI 订阅它渲染，runtime 负责改 */
export interface AgentState {
  /** **当前这一段**对话的消息（不是所有会话的） */
  messages: AgentMessage[];
  /** 历史会话列表，最近动过的在最前 */
  chats: AgentChatSummary[];
  /** 当前在看哪一段。空串 = 还没载入 */
  currentChatId: string;
  /** 正在等模型 / 正在执行动作 / **正在等用户回答** */
  busy: boolean;
  /** 正在流式输出的那段文本（只用于渲染，落库的是它拼完的结果） */
  streaming: string;
  /** 这一轮正在做什么（"正在调用模型…" / "正在安装工具…"） */
  phase: string;
  /**
   * 挂起的问题（助手在等用户点一下）。见 AgentAsk。
   *
   * 它在 busy=true 的同时出现 —— 这不是矛盾：这一轮确实还没结束，
   * 卡住的原因是"缺用户一句话"。界面据此把输入框换成选项。
   */
  ask: AgentAsk | null;
  /** 整轮级别的失败（网络、密钥）。逐动作的失败在动作卡上 */
  error: string;
  /** 从数据库载入完毕 */
  loaded: boolean;
}

/**
 * 内置 AI 助手使用的对话服务商注册表。
 *
 * ------------------------------------------------------------------
 * 与 tools/ai-gen 的关系：同一个概念，两处实现，**刻意不共享代码**
 * ------------------------------------------------------------------
 * ai-gen 是 iframe 工具，它的 PROVIDERS 写在工具自己的 HTML 里，由工具直接
 * 拿 Key 去 fetch；助手是原生视图，跑在宿主进程里。两者运行环境不同
 * （一个在 sandbox iframe 里，一个在主文档里），共享一份描述符意味着
 * 要么把工具的 HTML 拆开、要么给工具加一层模块系统 —— 都是大手术，
 * 而收益只是"少写一遍表"。
 *
 * 所以这里**独立一份**，但遵守同样的三条约定，让用户的认知不需要切换：
 *
 *   1. id / name / 默认地址与 ai-gen 保持一致（agnes、aliyun 两边同名同源）
 *   2. 加一家新服务商 = 往 AGENT_PROVIDERS 里加一个对象，UI 一行都不用改
 *   3. 描述符函数（buildBody / pickText / pickDelta）把"各家的接口形状差异"
 *      收在一处，界面代码里不出现 `if (provider === ...)`
 *
 * 覆盖面刻意大于 ai-gen：助手是**要替我干活**的角色，能选便宜/强的模型
 * 直接影响它能不能把工具写对，所以除了内置的 Agnes 与百炼，这里还补了
 * DeepSeek（官方 OpenAI 兼容接口）和一条 custom 通道（自建网关、硅基流动、
 * OpenAI 官方这些都能用 custom 接）。
 *
 * 模型名会随官方更新。每个 provider 都可以手填模型名（见 editableModel），
 * 所以过时的不是"用不了"，而是"下拉里的推荐项不再是最新的"。
 */

/**
 * 一家的"看图"能力。
 *
 * ------------------------------------------------------------------
 * 为什么是**模型级**而不是服务商级
 * ------------------------------------------------------------------
 * "这一家支不支持图片"是个问错了的问题 —— 同一家上面能看图和不能看图的
 * 型号是混在一起的：
 *
 *   · DeepSeek 官方说得最硬：**只有视觉模型收图**，别的型号一律
 *     400 `This model does not support image`；
 *   · 百炼那边 `qwen-plus` / `qwen-flash` 是纯文本，`qwen3-vl-plus`
 *     才是视觉型号；
 *   · 反过来 Agnes 全系文案都写了 "image URL input"。
 *
 * 所以能力挂在**具体型号**上，而不是挂在那家的招牌上。
 *
 * ------------------------------------------------------------------
 * base64 是另一个独立维度
 * ------------------------------------------------------------------
 * 工作台里的图片是**本机文件**，它没有公网 URL，只能靠 base64 Data URI
 * （`data:image/jpeg;base64,...`）塞进 `image_url.url` 里。
 * 于是"支持图片"还不够 —— **必须支持 base64 这一条路**，否则这项功能
 * 在那家就是残的（只能认公网链接，而用户手里没有链接，只有一张截图）。
 */
export interface ProviderVision {
  /** 已知能收图的型号。下拉里的 label 会据此标上「视觉」 */
  models: string[];
  /**
   * 它收不收 base64 Data URI。
   *
   * 为 true 的依据是官方文档明写了可以这么传；**没有官方依据的一律留 false，
   * 并在 note 里说明** —— 宁可让界面说"不确定"，也不要替用户赌一家网关。
   */
  base64: boolean;
  /** 一句备注，写给后来人：这个判断的依据是什么、什么时候要回来复核 */
  note?: string;
}

/** 一家服务商的对话能力描述 */
export interface AgentProvider {
  id: string;
  name: string;
  desc: string;
  /** 申请 Key / 看文档的地方，界面上给一个链接 */
  docs: string;
  /**
   * 注册 / 申请 Key 的地方。**只有"会推荐新用户去的那一家"需要填**。
   *
   * 填了它，界面就能在「用户还没接任何 API」时给出一条能走的路
   * （注册 → 建 Key → 粘回来），而不是一句"去设置里配"。
   * 链接会过期，所以它与 docs 一样，全站只有这一份来源。
   */
  signup?: string;
  defaultBase: string;
  /** 常见站点，做成下拉方便切换（如百炼的国内/新加坡） */
  basePresets: Array<{ label: string; value: string }>;
  /** 对话接口路径，相对 base */
  chatPath: string;
  models: Array<{ id: string; label: string }>;
  defaultModel: string;
  /**
   * 看图能力。**只有真能看图的型号才需要填**，不能看图就不填这一项。
   *
   * 它的存在与否本身有意义：没填 = 这一家我们不认识任何能看图的型号
   * （比如 custom 那条通道，网关是用户自己搭的，我们什么都不该假设）。
   */
  vision?: ProviderVision;
  /** 允许手填模型名。自建网关必须能填，官方站也留着 —— 新模型发布总比我们改代码快 */
  editableModel: boolean;
  /** 鉴权头 */
  auth: (key: string) => Record<string, string>;
  /** 额外的固定请求头（少数网关要求） */
  headers?: Record<string, string>;
  /**
   * 是否发原生 tools（function calling）定义。
   *
   * 关掉它不代表助手不能干活：动作还有**第二条通道**（让模型在回复里写一个
   * 约定格式的代码块，见 protocol.ts，模型完全无视 tools 参数，
   * 把工具调用当成一段普通 JSON 文本吐出来。两条通道都在，
   * 所以这里为 false 时只是少一条，不是少一条腿。
   */
  nativeTools: boolean;
  /**
   * 单次回复的 token 上限。
   *
   * **必须显式给**：不给就用服务端的默认值，而多数 OpenAI 兼容接口的默认
   * 是 4096 —— 写一份 15K 字符的 HTML 要 6~8K token，正好卡在中间被截断。
   * 症状很难认：模型"写了"、界面上也能看到半份源码，但代码块没有闭合，
   * 于是提取不到 html，最后报一句「文件是空的」，谁也想不到是长度问题。
   *
   * 各家上限不同（DeepSeek 输出上限 8192、百炼 qwen 系列多是 8192），
   * 所以这里取一个各家都接得住的值，而不是越大越好 ——
   * 超过上限是 400，那是"整轮失败"，比截断还糟。
   */
  maxTokens?: number;
  /** 请求体定制。给的是标准 OpenAI 形状，需要改的地方自己加 */
  buildBody?: (o: {
    model: string;
    messages: unknown[];
    stream: boolean;
    tools: unknown[] | null;
  }) => Record<string, unknown>;
}

/** 各家通用的响应解析（都是 OpenAI 形状，所以默认实现够用） */
function pickText(j: unknown): string {
  const c = (j as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0];
  const content = c?.message?.content;
  return typeof content === "string" ? content : "";
}

function pickDelta(j: unknown): string {
  const c = (j as { choices?: Array<{ delta?: { content?: unknown } }> })?.choices?.[0];
  const content = c?.delta?.content;
  return typeof content === "string" ? content : "";
}

/** 原生 tool_calls（非流式响应里的完整形态；流式分片的拼接在 client.ts） */
function pickToolCalls(j: unknown): RawToolCall[] {
  const c = (j as { choices?: Array<{ message?: { tool_calls?: unknown } }> })?.choices?.[0];
  const raw = c?.message?.tool_calls;
  if (!Array.isArray(raw)) return [];
  return raw.map((t, i) => {
    const o = t as {
      id?: unknown;
      function?: { name?: unknown; arguments?: unknown };
    };
    return {
      id: typeof o.id === "string" && o.id ? o.id : `call_${i}`,
      name: typeof o.function?.name === "string" ? o.function.name : "",
      args: typeof o.function?.arguments === "string" ? o.function.arguments : "",
    };
  });
}

export interface RawToolCall {
  id: string;
  name: string;
  /** 原始 JSON 字符串（由 protocol.ts 解析 —— 模型偶尔会给出坏 JSON） */
  args: string;
}

export const AGENT_PROVIDERS: AgentProvider[] = [
  {
    id: "agnes",
    name: "Agnes AI",
    desc: "全模态，OpenAI 风格接口。agnes-3.0-flash 是 Agent / 编程向的型号",
    docs: "https://wiki.agnes-ai.com/",
    // 引导新用户去的那一个入口：填它不是广告，而是回答"没 Key 的人第一步点哪儿"。
    // 平台域名与 help 文档不同 —— 注册在 platform.，文档在 wiki.。
    signup: "https://platform.agnes-ai.com",
    defaultBase: "https://apihub.agnes-ai.com/v1",
    basePresets: [
      { label: "国际站", value: "https://apihub.agnes-ai.com/v1" },
      { label: "国内站", value: "https://apihub.agnes-ai.cn/v1" },
    ],
    chatPath: "/chat/completions",
    models: [
      { id: "agnes-3.0-flash", label: "agnes-3.0-flash（Agent / 编程 · 推荐）" },
      { id: "agnes-2.5-flash", label: "agnes-2.5-flash（通用对话）" },
      { id: "agnes-2.5-pro", label: "agnes-2.5-pro（高级推理 · 付费）" },
      { id: "agnes-2.0-flash", label: "agnes-2.0-flash（旧版兼容）" },
    ],
    defaultModel: "agnes-3.0-flash",
    /*
     * 看图能力。
     *
     * 官方模型的介绍页对 2.0 / 2.5-flash / 3.0-flash 都写了 "image URL input"
     * 或 "image understanding" —— 但示例里的 url 清一色是**公网 URL**
     * （`https://example.com/image.jpg`）。
     *
     * ⚠️ 所以 base64 这里留 false：官方文档从没写过data URI 能用。
     * 社区的 OpenAI Vision 兼容层确实传成功了（本地图片会自动转 base64），
     * 但那是别人的实测，不是厂家的承诺 —— 这类"据说可以"最经不起网关改版。
     *
     * base64=false 的后果**不是禁用**：界面会说"这家对本地图片的支持不确定，
     * 发送时才知道"，并且照发不误。真发了能用，用户在设置里勾一下那个
     * 手动开关就永久亮绿。这比我们替他断定"能"要安全。
     *
     * agnes-2.5-pro 没进名单：它的介绍页只讲推理能力，没提图片。
     * 不写进去的理由同上 —— 没依据就不标。
     */
    vision: {
      models: ["agnes-3.0-flash", "agnes-2.5-flash", "agnes-2.0-flash"],
      base64: false,
      note: "官方只写了公网 URL；base64 未经官方承诺，建议实测一次再长期依赖",
    },
    editableModel: true,
    maxTokens: 8192,
    auth: (key) => ({ Authorization: `Bearer ${key}` }),
    nativeTools: true,
  },

  {
    /*
     * 阿里云百炼。
     *
     * 走的是 compatible-mode 那套 —— ai-gen 里的百炼条目 chat 是 null
     * （它只生图，而且生图用的是异步任务接口），但百炼**确实**提供
     * OpenAI 兼容的对话端点，所以助手这边正常接上：
     * 用户在 ai-gen 里申请的那把百炼 Key 可以直接复用。
     */
    id: "aliyun",
    name: "阿里云百炼",
    desc: "通义千问系列，OpenAI 兼容端点。Key 与「AI 生成」工具里用的是同一把",
    docs: "https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope",
    defaultBase: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    basePresets: [
      { label: "中国内地（北京）", value: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
      { label: "新加坡（国际）", value: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" },
    ],
    chatPath: "/chat/completions",
    models: [
      { id: "qwen-plus", label: "qwen-plus（性价比 · 推荐）" },
      { id: "qwen-flash", label: "qwen-flash（最快最省）" },
      { id: "qwen3-max", label: "qwen3-max（旗舰）" },
      { id: "qwen-long", label: "qwen-long（长上下文）" },
      { id: "qwen3-vl-plus", label: "qwen3-vl-plus（视觉 · 能看图）" },
      { id: "qwen3.7-plus", label: "qwen3.7-plus（视觉 · 原生多模态）" },
      { id: "deepseek-v3.2", label: "deepseek-v3.2（百炼上的第三方模型）" },
    ],
    defaultModel: "qwen-plus",
    /*
     * 看图能力：这几家里**文档写得最细**的一家，所以 base64 可以放心给 true。
     *
     * 官方把传入方式分成三种（公网 URL / 本地路径 / Base64 编码），并逐条给了
     * 限制编号 —— 我们按最窄的那条走：
     *
     *   · base64 编码前原图：Qwen3.x-VL 系 ≤ 20MB，其他 ≤ 10MB；
     *   · 编码后的 Data URI 字符串 ≤ 20MB；
     *   · 单请求最多 250 张（我们用不到这个量级）；
     *   · 宽高都要 ≥ 10px，宽高比不超过 200:1（异常细长的图会被拒）。
     *
     * 之所以这几条能一条条列出来，是因为它们写在公开的文档页面上；
     * 换成 custom 那条通道就什么都没有 —— 这也是那里不填 vision 的原因。
     *
     * 哪些型号能看图：官方文档的图像限制段里点了名的 Qwen3.7 / Qwen3.8 /
     * Qwen3.5 / Qwen3-VL 系列，以及 Qwen-VL 老型号。
     * **qwen-plus / qwen-flash / qwen-long / deepseek-v3.2 都不在里面** ——
     * 它们是纯文本型号，往它们发 content 块会被拒。
     */
    vision: {
      models: ["qwen3-vl-plus", "qwen3.7-plus", "qwen3.8-max", "qwen-vl-plus", "qwen-vl-max"],
      base64: true,
      note: "官方文档明确写了三种传入方式含 Base64；原图≤20MB、编码后 Data URI≤20MB、单请求≤250 张",
    },
    editableModel: true,
    maxTokens: 8192,
    auth: (key) => ({ Authorization: `Bearer ${key}` }),
    nativeTools: true,
  },

  {
    /*
     * DeepSeek 官方。
     *
     * base_url 官方推荐给 https://api.deepseek.com（不带 /v1），并且明确说
     * 带 /v1 也能用、那与模型版本无关 —— 所以这里填不带 /v1 的那个，
     * 免得用户以为 v1 是个要跟着升级的版本号。
     *
     * 模型名以官方文档为准：deepseek-v4-flash / deepseek-v4-pro。
     * 老的 deepseek-chat / deepseek-reasoner 在 2026-07-24 之后进入弃用期，
     * 但它们会一直映射到 v4-flash 的非思考/思考模式，所以下拉里也留着 ——
     * 用户从别处抄配置时抄到的往往是这两个名字。
     */
    id: "deepseek",
    name: "DeepSeek",
    desc: "直连官方接口，写代码/写工具这一档够用且便宜",
    docs: "https://api-docs.deepseek.com/zh-cn/",
    defaultBase: "https://api.deepseek.com",
    basePresets: [{ label: "官方", value: "https://api.deepseek.com" }],
    chatPath: "/chat/completions",
    models: [
      { id: "deepseek-v4-flash", label: "deepseek-v4-flash（推荐 · 快）" },
      { id: "deepseek-v4-pro", label: "deepseek-v4-pro（更强 · 更贵）" },
      { id: "deepseek-v4-flash-vision-exp", label: "deepseek-v4-flash-vision-exp（视觉 · 只有它能看图）" },
      { id: "deepseek-chat", label: "deepseek-chat（旧名，映射到 v4-flash）" },
      { id: "deepseek-reasoner", label: "deepseek-reasoner（旧名，思考模式）" },
    ],
    defaultModel: "deepseek-v4-flash",
    /*
     * 看图能力：这家**只有带 vision 后缀的那一个型号能收图**，别的通通不行。
     *
     * 官方写得很硬：非视觉模型收到带图请求会直接
     * 400 `This model does not support image`。注意这句话的含义 ——
     * 它不是"忽略图片"，而是**整次请求失败**。所以在这家我们必须认得准：
     * 判断成"能"而实际不能，用户的代价是整轮对话发不出去。
     *
     * 另一条必须在代码里兑现的限制：**图片只能出现在 user 消息里**。
     * system / assistant 带图同样返回 400。这条约束落在 runtime.buildWire
     * 那里（只有 user 消息会被塞 image_url 块），这里只是把原因记下来。
     *
     * 好消息是视觉型号支持 Tool Calls，价格与 flash 同档 ——
     * 传图多花的只是图片那几百个 token（单张图片按尺寸折算，**上限 384
     * token**，约等于一张 800×800），传原图和传 1280 宽的花一样多。
     */
    vision: {
      models: ["deepseek-v4-flash-vision-exp"],
      base64: true,
      note: "只有 vision 型号收图，其他型号会 400；图片仅限 user 消息；单图≤32MB、请求体≤48MB、单图最多 384 token",
    },
    editableModel: true,
    maxTokens: 8192,
    auth: (key) => ({ Authorization: `Bearer ${key}` }),
    nativeTools: true,
  },

  {
    /*
     * 自建 / 其它 OpenAI 兼容网关。
     *
     * 存在的意义：OpenAI 官方、硅基流动、vLLM / Ollama 起的本地服务、
     * 公司内网网关……它们**全都是** OpenAI 兼容的，区别只在地址与模型名。
     * 与其为每一家写一个条目（然后一起过期），不如留一条能填地址与模型名的
     * 通道 —— 这也是"加一家只动数据"这条约定留给用户的出口。
     *
     * 默认地址留空：填错地址比不填更危险（Key 会被发到一个不认识的主机），
     * 所以宁可让它在"还没配好"的状态里明确报出来。
     */
    id: "custom",
    name: "自定义（OpenAI 兼容）",
    desc: "自建网关、本地 Ollama / vLLM、OpenAI 官方 —— 填地址与模型名即可",
    docs: "https://platform.openai.com/docs/api-reference/chat",
    defaultBase: "",
    basePresets: [
      { label: "OpenAI 官方", value: "https://api.openai.com/v1" },
      { label: "本地 Ollama", value: "http://localhost:11434/v1" },
    ],
    chatPath: "/chat/completions",
    models: [],
    defaultModel: "",
    /*
     * **故意不填 vision**。
     *
     * 网关是用户自己搭的（OpenAI 官方、硅基流动、本地 Ollama / vLLM、
     * 公司内网），我们连它跑的是什么模型都不知道，更别说那个模型看不看得图。
     * 填上任何一条名单都是**替用户下结论**：猜中了没功劳，猜错了他在界面上
     * 看到"支持"然后整轮 400 —— 那是把我们的错算到用户头上。
     *
     * 所以这里的能力判定一律落到 "unknown"，由用户在设置里勾那个开关来说
     * "我这个网关能看图"。这也是那条开关必须存在的根本理由：
     * 它不是给已知名单打补丁，而是给**我们什么都不懂的那部分**留的出口。
     */
    editableModel: true,
    maxTokens: 8192,
    auth: (key) => ({ Authorization: `Bearer ${key}` }),
    nativeTools: true,
  },
];

/** 自定义那条通道。未知 id 一律落到它上面，**绝不默默换成别家** */
export function customProvider(): AgentProvider {
  return AGENT_PROVIDERS[AGENT_PROVIDERS.length - 1];
}

/**
 * 按 id 取服务商。
 *
 * 关键决定：**未知 id 回落到 custom，而不是回落到第一个（Agnes）**。
 * 回落错方向的后果是把用户的 Key 发到一个他根本没配过的主机 ——
 * 那是安全问题，不是显示问题。custom 的默认地址是空的，于是它会停在
 * "还没填地址"这个可解释的状态里。
 */
export function agentProvider(id: string | undefined): AgentProvider {
  return AGENT_PROVIDERS.find((p) => p.id === id) ?? customProvider();
}

/**
 * 一个型号的视觉能力判定结果。
 *
 * `support` 与 `base64` 是两个独立维度（见 ProviderVision 的说明）：
 * 前者说它看不看得懂图，后者说我们手里的图能不能送到它面前。
 * **两者都为真，图片上传才真的有用** —— 这也是为什么只答应一半的
 * 那份备注（Agnes）要写得比"不支持"还啰嗦。
 */
export interface VisionVerdict {
  support: "yes" | "no" | "unknown";
  /** 能不能用 base64 Data URI 传本机图片 */
  base64: boolean;
  /** 这家已知能看图的型号，供界面给出"换一个试试"的建议 */
  models: string[];
  /** 给用户看的一句解释（为什么不/能不能） */
  note: string;
}

/**
 * 这个型号看不看得图。
 *
 * **三态，不是布尔。** 中间的 unknown 必须单独存在：
 *
 * editableModel 允许用户手填模型名（那是给新模型和自建网关留的出口），
 * 对这类名字，答 yes 是赌运气、答 no 是替他做决定 —— 两者都会在
 * DeepSeek 这种"说不能就不能，直接 400"的服务商上变成一次整轮失败。
 * 所以正确答案是"我不知道"，并让用户用一个开关来回答。
 *
 * 判定的优先顺序：
 *   1. 在 vision.models 名单里         → yes
 *   2. 在 provider.models 下拉里（我们整理过，没标视觉就是不带视觉）→ no
 *   3. 两个都不在（手填的）              → unknown
 */
export function agentVisionSupport(providerId: string, model: string): VisionVerdict {
  const p = agentProvider(providerId);
  const id = model.trim().toLowerCase();
  const neither = { support: "unknown" as const, base64: false, models: [] as string[] };

  if (!id) return { ...neither, note: "还没选模型" };
  if (!p.vision) {
    return {
      ...neither,
      note: `${p.name}这条通道我们不认识里面的型号${p.models.length ? "（下拉里的都不带视觉能力）" : ""}。它能不能看图，只有你自己填的那个网关知道。`,
    };
  }

  const hit = p.vision.models.find((m) => m.toLowerCase() === id);
  if (hit) {
    return {
      support: "yes",
      base64: p.vision.base64,
      models: p.vision.models,
      note: p.vision.base64
        ? `这个型号能看图，也支持 base64 —— 本机图片可以直接传`
        : `这个型号能看图，但官方只演示了公网 URL 的传法；本机图片走的是 base64，${p.name} 没承诺过这条路`,
    };
  }

  // 下拉里我们自己列出来的型号：没被标成视觉，就是这一代的纯文本型号
  const known = p.models.find((m) => m.id.toLowerCase() === id);
  if (known) {
    return {
      support: "no",
      base64: false,
      models: p.vision.models,
      note: p.vision.models.length
        ? `这个型号是纯文本的，看不了图。同一家换个带「视觉」的：${p.vision.models.slice(0, 2).join(" / ")}`
        : `这个型号是纯文本的，看不了图`,
    };
  }

  return {
    ...neither,
    models: p.vision.models,
    note: `「${model.trim()}」不在${p.name}的推荐列表里，我们不知道它带不带视觉能力`,
  };
}

/**
 * 「还没接模型」时推荐的那一家。
 *
 * 它必须**自己填了 signup 才有资格** —— 推荐一个连注册地址都没登记的服务商，
 * 等于把用户丢到搜索引擎面前。所以这里用代码守住这个约束，而不是靠人记得同步。
 */
export const RECOMMENDED_PROVIDER_ID = "agnes";

export function recommendedProvider(): AgentProvider {
  const p = agentProvider(RECOMMENDED_PROVIDER_ID);
  return p.signup ? p : customProvider();
}

/** 计算真正要请求的地址。用户把完整端点粘进"接口地址"里也能用 */
export function chatEndpoint(cfg: { provider: string; baseUrl: string }): string {
  const p = agentProvider(cfg.provider);
  const raw = (cfg.baseUrl || p.defaultBase).trim().replace(/\/+$/, "");
  if (!raw) return "";
  // 已经带了路径就不再拼一遍 —— 用户从文档里复制的常是完整端点
  if (raw.endsWith(p.chatPath)) return raw;
  return raw + p.chatPath;
}

/** 请求头。**不含** Key 校验：那把判断交给 agentConfigProblems */
export function chatHeaders(cfg: { provider: string; apiKey: string }): Record<string, string> {
  const p = agentProvider(cfg.provider);
  const key = cfg.apiKey.trim();
  return {
    "Content-Type": "application/json",
    ...(key ? p.auth(key) : {}),
    ...(p.headers ?? {}),
  };
}

/**
 * 配置缺什么。
 *
 * 返回的是一个**清单**而不是布尔值：界面要能一次说全"地址和模型都还没填"，
 * 而不是让用户填一个、报一个。文案直接写"去哪里填"。
 */
export function agentConfigProblems(cfg: {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}): string[] {
  const p = agentProvider(cfg.provider);
  const out: string[] = [];
  if (!cfg.apiKey.trim()) out.push(`还没有填 ${p.name} 的 API Key`);
  if (!chatEndpoint(cfg)) out.push("还没有填接口地址（Base URL）");
  if (!cfg.model.trim()) out.push("还没有选模型");
  return out;
}

export function agentConfigured(cfg: {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}): boolean {
  return agentConfigProblems(cfg).length === 0;
}

/** 请求体。tools 为 null 表示这次不带工具定义 */
export function buildChatBody(
  cfg: { provider: string; model: string },
  o: { messages: unknown[]; stream: boolean; tools: unknown[] | null },
): Record<string, unknown> {
  const p = agentProvider(cfg.provider);
  if (p.buildBody) {
    return p.buildBody({ model: cfg.model, messages: o.messages, stream: o.stream, tools: o.tools });
  }
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: o.messages,
    stream: o.stream,
    // 显式给上限：不写就吃服务端默认（多数是 4096），写工具时会被悄悄截断
    ...(p.maxTokens ? { max_tokens: p.maxTokens } : {}),
  };
  if (o.tools && o.tools.length) {
    body.tools = o.tools;
    // auto：它自己决定要不要动手。强迫它必须调工具会让"你好"这种话都走一遍工具
    body.tool_choice = "auto";
  }
  return body;
}

/** 解析非流式响应 */
export function parseChatResponse(j: unknown): { text: string; toolCalls: RawToolCall[] } {
  return { text: pickText(j), toolCalls: pickToolCalls(j) };
}

/** 解析一个流式分片里的增量文本 */
export function parseDeltaText(j: unknown): string {
  return pickDelta(j);
}

/**
 * 解析一个流式分片里的 tool_calls 增量。
 *
 * 返回的是**分片本身**（可能只有半个 name、半截 arguments 字符串），
 * 由 client.ts 按 index 累积 —— 这里只负责把它从各家形状里取出来。
 * ID 上 OpenAI 只在第一个分片给，所以缺 id 时回空串，交给累积逻辑保留前值。
 */
export function parseDeltaToolCalls(
  j: unknown,
): Array<{ index: number; id: string; name: string; args: string }> {
  const c = (j as { choices?: Array<{ delta?: { tool_calls?: unknown } }> })?.choices?.[0];
  const raw = c?.delta?.tool_calls;
  if (!Array.isArray(raw)) return [];
  return raw.map((t, i) => {
    const o = t as {
      index?: unknown;
      id?: unknown;
      function?: { name?: unknown; arguments?: unknown };
    };
    return {
      index: Number.isInteger(o.index) ? (o.index as number) : i,
      id: typeof o.id === "string" ? o.id : "",
      name: typeof o.function?.name === "string" ? o.function.name : "",
      args: typeof o.function?.arguments === "string" ? o.function.arguments : "",
    };
  });
}

/** 从错误响应体里尽量抠出一句人能看懂的话 */
export function describeHttpError(status: number, body: string): string {
  let detail = "";
  try {
    const j = JSON.parse(body) as {
      error?: { message?: unknown } | string;
      message?: unknown;
      msg?: unknown;
    };
    const raw =
      (typeof j.error === "object" && j.error?.message) ||
      (typeof j.error === "string" && j.error) ||
      j.message ||
      j.msg;
    if (typeof raw === "string") detail = raw;
  } catch {
    detail = body.trim().slice(0, 200);
  }

  const head =
    status === 401 || status === 403
      ? "API Key 不对，或者这把 Key 没有这个模型/接口的权限"
      : status === 404
        ? "接口地址不对（404），检查 Base URL 是不是少了或多了路径"
        : status === 429
          ? "触发限流或余额不足，稍后再试或检查账户"
          : status >= 500
            ? "服务端出错（对方的问题），可以稍后重试"
            : `请求被拒绝（HTTP ${status}）`;

  return detail ? `${head}：${detail.slice(0, 300)}` : head;
}

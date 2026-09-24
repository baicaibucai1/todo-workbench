/**
 * 数据模型定义。
 *
 * 设计约定：
 * - 核心业务表统一以 core_ 前缀
 * - 工具私有表以 tool_<toolId>_ 前缀（见 src/lib/db.ts）
 * - 时间统一存 ISO 8601 字符串，便于排序与跨库迁移
 */

/** 智能视图，对应 To Do 左侧固定入口 */
/**
 * 智能视图。
 *
 * `orders` 是流程任务的**专属入口**：流程任务平时混在「全部」「我的一天」里，
 * 想要"只看手上的单子"就得有个专门的地方。它和待办共用一套视图语义，
 * 区别只在取数时把待办挡掉（见 repo.fetchTasks 的 orders 分支）。
 *
 * `special` 是流程任务里**带处理时效**的那一类（以快递单号为起点，见 WorkOrderKind）。
 * 它是流程任务的真子集，不是另一种东西 —— 所以它同时照旧出现在「流程任务」视图里；
 * 这个入口只是把"有时效、等不起"的那些单独摆出来，让人先处理快超时的。
 *
 * `gallery` 与前面几个**不同类**：它不是"待办的某种筛选"，而是一个独立的
 * 素材库（见 types.ts 的 GalleryItem）。放进这个枚举是因为侧边栏入口、
 * 启动视图、以及"当前该渲染哪个主区组件"都归它管，代价是取数层必须
 * **显式把它挡掉**（repo.fetchTasks / fetchWorkOrders 都有专门的 case），
 * 否则未知视图会落空条件、把全部待办捞回来。
 *
 * ⚠️ 曾经这里还有个 `planned`（「计划内」：有到期日的那些），2026-09-22 按用户
 * 要求整个删掉了 —— 入口、取数分支、按日期分桶的分组逻辑一起清。
 * 别只删侧边栏入口留个看不见的视图：那样既没有入口，又让一堆代码永远到不了。
 *
 * `agent` 是**内置 AI 助手**（2026-09-23 加）。它和 `gallery` 一样不是"待办的筛选"，
 * 区别在于它是唯一一个**会反过来改数据**的视图：它能建日程（写 core_tasks）、
 * 能往工具目录写一个新的单 HTML 工具、能给工具绑定数据表。
 * 正因为要碰 core_* 与文件系统，它**不能**做成 tools/ 下的 iframe 工具
 * （工具在物理上碰不到核心表，见 lib/toolBridge.ts），只能是原生视图。
 */
export type SmartView =
  | "myday"
  | "important"
  | "all"
  | "orders"
  | "special"
  | "gallery"
  | "agent";

/**
 * 任务重复规则。
 *
 * daily 的语义是"每天都会重新出现一次"：今天勾掉，明天自动变回未完成。
 * 它和普通任务共用 done 字段，区别只在跨天时会被重置。
 */
export type Repeat = "none" | "daily";

/** 待办清单（用户自建列表） */
export interface TaskList {
  id: string;
  name: string;
  /** 主题色，十六进制 */
  color: string;
  /** 侧边栏排序序号，越小越靠前 */
  sortOrder: number;
  /** 是否已删除（软删除，保留任务历史） */
  deleted: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 待办任务 */
export interface Task {
  id: string;
  listId: string;
  title: string;
  note: string;
  /** 是否已完成 */
  done: boolean;
  /** 是否标记为重要 */
  important: boolean;
  /** 是否加入「我的一天」 */
  myDay: boolean;
  /** 计划日期 YYYY-MM-DD，null 表示未安排 */
  dueDate: string | null;
  /** 提醒时间 ISO，null 表示无提醒 */
  remindAt: string | null;
  /** 完成时间 ISO */
  completedAt: string | null;
  /** 重复规则，daily 表示每日任务 */
  repeat: Repeat;
  /**
   * 每日任务最近一次完成的日期 YYYY-MM-DD。
   * 跨天时用它判断是否该把任务重置回未完成 —— 不用 completed_at 比较，
   * 因为那是 UTC 时间，和本地"哪一天"会差上半天。
   */
  repeatDoneOn: string | null;
  sortOrder: number;
  /** 软删除，支持撤销删除 */
  deleted: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * 子任务（界面上就叫「子任务」，数据库表名与字段名仍是 step）。
 *
 * 表名不改的理由：迁移只追加，改表名等于把用户已有的数据搬一次家，
 * 风险换不来任何好处 —— 用户看到的是界面上的词，不是列名。
 */
export interface Step {
  id: string;
  taskId: string;
  title: string;
  done: boolean;
  sortOrder: number;
  /**
   * 到期时刻 ISO（本地时区，形如 2026-09-22T14:30），null 表示没设。
   *
   * 为什么是"时刻"而不是"日期"：子任务通常是"下午三点前把图发出去"
   * 这种**具体到点**的事，只给日期的话紧急区算不出"还剩多久"，
   * 也就没法在侧边栏提醒 —— 那这个功能就白做了。
   */
  dueAt: string | null;
}

/** 视图筛选条件 */
export interface ViewFilter {
  view: SmartView | "list";
  listId?: string;
}

/* ------------------------------------------------------------------ */
/* 流程任务                                                                */
/* ------------------------------------------------------------------ */

/**
 * 流程任务与待办的区别（这是整个模块的设计前提）：
 *
 * - 待办是「一件事」，只有未完成/已完成两种状态，做完就没了。
 * - 流程任务是「一个流程」，有单号、有开始时间、会沿着一条**过程态序列**往前走，
 *   每走一步都留痕。过程态序列（流程）由用户自己定义，可以有多个模板。
 *
 * 所以流程任务不复用 core_tasks：把 stage_id / flow_id / 单号 塞进待办表，
 * 会让待办表里一半的列对另一半的行永远为空，后续每次加功能都要判断"这行是啥"。
 * 两者在界面上混排展示，在存储上各自独立。
 */

/** 流程模板：一套可复用的过程态序列 */
export interface WorkFlow {
  id: string;
  name: string;
  /** 是否为默认流程（新建流程任务时预选它）。全局只应有一个 */
  isDefault: boolean;
  sortOrder: number;
  deleted: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 过程态：流程任务在某一步的状态，如「处理中」 */
export interface WorkStage {
  id: string;
  flowId: string;
  name: string;
  /** 十六进制色值，用于流程任务行的色条与进度条 */
  color: string;
  sortOrder: number;
  /** 是否为终态。走到终态即视为流程任务完结，会记 completed_at */
  isTerminal: boolean;
  /**
   * 进入这个步骤后默认给多久（**分钟**，0 表示不预设）。
   *
   * 这是给「特殊单号」的时效用的：每一步都有"到下一步之前还剩多久"，
   * 推进时按它自动续上，省得每一步都手填。放在过程态上而不是写死在代码里，
   * 是因为"这一步该给多久"本身就是流程的一部分，只有用户知道。
   */
  defaultMinutes: number;
}

/**
 * 流程任务种类。
 *
 * - normal  普通流程任务：只有流转，没有时效
 * - special 特殊单号：以快递单号为起点，每一步带「到下一步之前还剩多久」
 *
 * 做成**类型标记而不是独立表**：两者共用过程态、流转记录、计划表、附件，
 * 唯一多出来的只是时效与若干自定义字段。另起一张表就意味着整套流程任务子系统
 * 要来第二遍。
 */
export type WorkOrderKind = "normal" | "special";

/** 流程任务 */
export interface WorkOrder {
  id: string;
  /**
   * 流程任务种类。special 是「特殊单号」——以快递单号为起点、每一步带处理时效的那类。
   * 它只是流程任务的一个子集，视图与流转逻辑完全共用。
   */
  kind: WorkOrderKind;
  /**
   * 单号。
   *
   * 只对特殊单号有值 —— 那里它放的是**快递单号**（这类单子的起点，要拿去查物流）。
   * 普通流程任务从 schema v13 起不再自动编号：`WO-YYYYMMDD-NNN` 那种号用户
   * 手上没有对应的纸质单据，对不上账，他要写的是下面的 description。
   * 老数据里的号仍在库里（不删），只是界面不再显示。
   */
  no: string;
  /**
   * 描述 —— "这件事到底要办什么"。
   *
   * 和 title 的分工：title 是**一行标题**，列表扫视靠它，所以要求短；
   * description 允许展开写，列表里以灰色小字跟在标题下面，详情里是可编辑的多行。
   * 两者不互相取代：标题退化成描述的开头会让人没法扫列表。
   */
  description: string;
  /**
   * 快递商代号（见 lib/couriers.ts 的 Courier.code）。
   *
   * **空串表示"没指定，按单号自动识别"** —— 不是"未知快递商"。
   * 两者差别很实际：识别规则以后会补会修，把猜测结果冻进库里，
   * 老数据就永远停在旧规则上；留空则每次都按当前规则重算。
   *
   * 只在用户手动指定过时才有值：自动识别只能靠单号形状猜，
   * 而形状撞车是常态（12 位纯数字顺丰/中通/圆通都可能），
   * 猜错了人改一次就该按他说的算 —— 见 courierCodeOf。
   */
  courier: string;
  title: string;
  flowId: string;
  /** 当前过程态 */
  stageId: string;
  note: string;
  important: boolean;
  /** 是否加入「我的一天」 */
  myDay: boolean;
  /** 开始日期 YYYY-MM-DD，决定它何时开始在待办里露面 */
  startDate: string | null;
  /** 交付日期 YYYY-MM-DD */
  dueDate: string | null;
  /**
   * 当前这一步的**处理时效截止时刻**（ISO），null 表示这一步没设时效。
   *
   * 语义是"到下一步之前还剩多久"，所以它是**当前过程态**的属性，
   * 每次推进都会被重设（见 repo.moveOrderToStage）。
   * 只存绝对时刻：存时长的话还得再记一个起点，跨重启就算不清了。
   */
  stageDueAt: string | null;
  /**
   * 内部用：这个时效已经提醒到哪一档（'' / soon / overdue）。
   *
   * 提醒队列是内存态、重启即空，光靠"队列里有没有"去重会让每次启动都重弹一遍。
   * 放到列上，重启后也知道该不该再提醒。
   */
  stageDueNotifiedAt: string;
  completedAt: string | null;
  sortOrder: number;
  deleted: boolean;
  createdAt: string;
  updatedAt: string;
  /**
   * 是否已完结 —— **派生字段，不是数据库列**。
   * 由当前过程态是否 is_terminal 决定，查询时 join 出来。
   * 放在这里是因为「按完成状态分组」是每个视图都要做的判断，
   * 让每个调用方各自去查阶段表既啰嗦又容易漏。
   */
  closed: boolean;
}

/** 过程态流转记录：流程任务「过程」的留痕 */
export interface WoLog {
  id: string;
  woId: string;
  fromStage: string | null;
  toStage: string;
  at: string;
  note: string;
}

/**
 * 流程任务绑定的相关信息（一条 key-value）。
 *
 * 这是「特殊单号」要绑的那批东西：另一个快递单号、用户名、收件人、手机号…
 * 字段名（label）由用户自己定，所以**不设唯一约束** ——
 * 同一张单上有两个「快递单号」是正常的，反而"同名字段只能有一个"
 * 才是错的假设。
 *
 * 为什么不复用 note：note 是一段自由文本，而这些东西要**逐条复制**
 * （value 要能单独一键复制走），还要能被搜到。塞进一段文本里两件事都做不到。
 */
export interface WoField {
  id: string;
  woId: string;
  /** 字段名，用户自定义 */
  label: string;
  value: string;
  sortOrder: number;
  deleted: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * 计划表条目。
 *
 * @deprecated 计划表已下线（取而代之的是侧边栏底部的「紧急区」，
 * 它按剩余时间自动算，不需要用户编排、也就不需要存）。
 *
 * 类型**保留**下来的唯一理由：老备份里带这个字段，删掉类型会让
 * 那些备份在导入时被当成结构不对而整份作废（见 repo.BackupPayload）。
 *
 * 当初为什么要单独存而不用「按日期查任务 + 查流程任务」算出来：
 * 「编排」的核心是**顺序**，而顺序是用户显式决定的，无法从数据里推导。
 */
export interface PlanItem {
  id: string;
  /** 归属日期 YYYY-MM-DD，当前只编排今天，留日期字段是为了以后能排未来 */
  date: string;
  /** 指的是哪一种 */
  kind: "task" | "order";
  refId: string;
  sortOrder: number;
  createdAt: string;
}

/* ------------------------------------------------------------------ */
/* 流程任务附件                                                            */
/* ------------------------------------------------------------------ */

/**
 * 附件类型。
 *
 * 这个三分法不是为了显示好看，而是对应**两条完全不同的存放策略**：
 * - image / video：二进制资源 → **下载进本地仓库**，之后只看本地文件
 * - link：文件与网址 → **只存链接**，不在本地留副本
 *
 * 为什么这么分：图片视频最容易被外链拔掉、图床限流、跨域拦。
 * 而且流程任务里回头要反复看的正是这些图，本地有一份才踏实；
 * 而一个几百 MB 的安装包、一个在线文档，留链接比留副本合理得多。
 */
export type AttachmentKind = "image" | "video" | "link";

/** 流程任务附件 */
export interface WoAttachment {
  id: string;
  woId: string;
  kind: AttachmentKind;
  /** 显示名。媒体是文件名，链接是标题 */
  title: string;
  /**
   * 仓库内**相对**路径，形如 `2026-09/a1b2c3d4-产品图.jpg`。
   * 存相对路径而不是绝对路径：换了机器或改了用户名，绝对路径就失效了。
   * kind 为 link 时是 null。
   */
  relPath: string | null;
  /** 媒体：当初的下载来源；链接：目标网址 */
  sourceUrl: string | null;
  mime: string;
  /** 字节数；链接为 null */
  size: number | null;
  /**
   * 内容指纹（SHA-256）。
   * 同一个文件被加进两张流程任务时，磁盘上只存一份 —— 靠它认出来。
   */
  hash: string | null;
  /** 尺寸。探测到之前为 null（图片靠 img.onload，视频靠 loadedmetadata） */
  width: number | null;
  height: number | null;
  /** 视频时长（毫秒）。图片与链接恒为 null */
  durationMs: number | null;
  note: string;
  sortOrder: number;
  deleted: boolean;
  createdAt: string;
  /**
   * 最后一次改动时间。同步据此判断同一条附件在两端谁更新。
   * 老行没有这个值，读出来时用 createdAt 兜底（Schema v14 起写入）。
   */
  updatedAt: string;
}

/* ------------------------------------------------------------------ */
/* 图库                                                                */
/* ------------------------------------------------------------------ */

/**
 * 图库条目类型。
 *
 * 只收图片和视频 —— 与附件的三分法不同（那里还有 link）。
 * 原因是图库的界面就是一片缩略图，一条"没有缩略图可画"的链接
 * 在里面没有位置；链接该留在流程任务附件的语境里。
 */
export type GalleryKind = "image" | "video";

/**
 * 条目是谁放进来的。
 *
 * 这不是为了分类浏览（那是 kind 的事），而是为了两件具体的事：
 *   1. AI 生成的结果要能按提示词回溯、换个模型重跑一次；
 *   2. 工具写入的内容出问题时，能一眼看出是从哪条路径进来的。
 * 所以它必须落在数据里，而不是只在界面上推导。
 */
export type GalleryOrigin = "manual" | "ai-gen" | "image-crop" | "size-chart";

/**
 * 图库条目。
 *
 * 与流程任务附件（WoAttachment）是**两张表、同一个文件仓库**：
 * rel_path / hash 都指向同一个内容寻址池，所以同一份字节
 * "既在流程任务里又在图库里"时磁盘上只有一份。
 * 代价是删除前必须跨两张表数引用（见 repo.refCountByHash）。
 */
export interface GalleryItem {
  id: string;
  title: string;
  kind: GalleryKind;
  /** 仓库内相对路径，形如 `2026-09/a1b2c3d4-产品图.png` */
  relPath: string | null;
  /** 原始来源：AI 生成时是接口给的临时 URL，导入时是原地址，手工新建时为 null */
  sourceUrl: string | null;
  mime: string;
  size: number | null;
  /** 内容指纹，跨条目/跨表去重用 */
  hash: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  origin: GalleryOrigin;
  /**
   * AI 生成时的提示词。
   * 单独一列而不是塞进 note：它是**可复用的输入**（换个模型再来一次），
   * note 是给人看的备注，两者生命周期不同。
   */
  prompt: string;
  note: string;
  createdAt: string;
  /**
   * 最后一次改动时间（改标题 / 备注 / 尺寸，或删除）。
   * 同步据此判断同一条目在两端谁更新。老行没有这个值，
   * 读出来时用 createdAt 兜底（Schema v14 起写入）。
   */
  updatedAt: string;
  /**
   * 非持久字段：只在 `addToGallery(…, { dedupe: true })` 命中已有内容时回填，
   * **不写进数据库**。true 表示"这一份图库里本来就有，没有新建记录"。
   *
   * 为什么不给它单独一个返回值：`addToGallery` 的调用方（图库视图、
   * 工具通道）要的都是"这条记录"，多返回一个布尔会让每处都得解构。
   * 挂在返回值上，现有调用点一行都不用改。
   */
  dup?: boolean;
}

/** 工具的来源：决定它能不能被"卸载" */
export type ToolSource =
  /** 随安装包分发（或浏览器 demo 的内置清单）。可以停用，可以卸载用户区副本，
   *  之后还能从安装包重新装回来 */
  | "bundled"
  /** 用户自己导进来 / 丢进用户数据区的。卸载就是真删，删了只能重新导入 */
  | "user";

/** 工具表的一列。类型只有三种 —— 够用，也让宿主有办法校验工具传来的值 */
export interface ToolColumn {
  name: string;
  type: "text" | "integer" | "real";
  /** 主键。有且只能有一列（复合主键在结构化 CRUD 下没有落脚点） */
  pk?: boolean;
  notNull?: boolean;
  /** 默认值。写进 DDL 前会按类型转义，不存在拼接注入的可能 */
  default?: string | number | null;
}

/** 工具表的一个索引 */
export interface ToolIndexDef {
  columns: string[];
  unique?: boolean;
}

/** 工具私有表的声明 */
export interface ToolTableDef {
  /** 裸表名（不带前缀）。宿主会拼成 tool_<id>_<name> */
  name: string;
  columns: ToolColumn[];
  indexes?: ToolIndexDef[];
}

/**
 * 工具的数据表声明。写在 manifest 里，由**宿主**执行 —— 工具自己发不出 DDL。
 *
 * 为什么是声明式而不是让工具传 CREATE TABLE：
 *   1. 宿主能把列名、类型、主键都校验一遍再拼 SQL（值永远是参数化的 `?`）；
 *   2. 设置页的「数据库」分区要列出每个工具有哪些表，数据必须可读；
 *   3. 宿主只用 schema 里**声明过的**列做 CRUD，工具传别的列名一律拒绝 ——
 *      这是第二道防线，拼 SQL 即使写错了也越不过这张表以外的地方。
 */
export interface ToolSchema {
  tables: ToolTableDef[];
}

/** 工具清单项（manifest.json 解析结果） */
export interface ToolManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  /** 侧边栏图标名，对应 lucide 图标 */
  icon?: string;
  /** 入口 HTML，相对工具目录 */
  entry: string;
  /**
   * 工具私有表的 schema 版本，用于独立迁移。
   *
   * **只有下面同时声明了 `schema` 它才有意义**：没表的工具恒为 1，
   * 宿主不会为它执行任何 DDL。改了表结构请把这个数字 +1，
   * 宿主据此重建新表（旧列不会自动迁移，见 toolSchema.ts）。
   */
  dbVersion: number;
  author?: string;
  /**
   * 私有数据表声明。**外部输入，一律按不可信数据处理**：
   * 名字、类型、默认值都要过 toolSchema.ts 的白名单才能进 SQL。
   * 没写就是"这个工具不需要自己的表"，宿主不会为它建任何东西。
   */
  schema?: ToolSchema;
  /**
   * 来源。**不是 manifest 里的字段**，由扫描器按"它是不是安装包里的"盖戳 ——
   * 和 gallery 的 origin 一样，来源必须由宿主判定，工具自报不算：
   * 一个工具若能把 source 写成 "bundled"，卸载按钮就会消失。
   */
  source?: ToolSource;
}

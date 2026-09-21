/**
 * 数据库迁移定义。
 *
 * 约定（关键，不可破坏）：
 * 1. 迁移只能追加，已发布的迁移脚本永不修改。用户库里可能已经跑过它。
 * 2. 用 PRAGMA user_version 记录已应用到第几版。
 * 3. 每个迁移是一个原子事务，失败整批回滚，绝不留半截 schema。
 * 4. 核心表用 core_ 前缀，工具表用 tool_<id>_ 前缀，两套迁移互不干扰。
 *
 * 注意：SQLite 的 ALTER TABLE 能力有限（不能改列类型、不能删列到老版本兼容），
 * 涉及重建表时用「建新表 -> 拷数据 -> 删旧表 -> 改名」四步法。
 */

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: "init_core_schema",
    sql: `
      CREATE TABLE IF NOT EXISTS core_lists (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        color       TEXT NOT NULL DEFAULT '#d4537e',
        sort_order  INTEGER NOT NULL DEFAULT 0,
        deleted     INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS core_tasks (
        id           TEXT PRIMARY KEY,
        list_id      TEXT NOT NULL REFERENCES core_lists(id) ON DELETE CASCADE,
        title        TEXT NOT NULL DEFAULT '',
        note         TEXT NOT NULL DEFAULT '',
        done         INTEGER NOT NULL DEFAULT 0,
        important    INTEGER NOT NULL DEFAULT 0,
        my_day       INTEGER NOT NULL DEFAULT 0,
        due_date     TEXT,
        remind_at    TEXT,
        completed_at TEXT,
        sort_order   INTEGER NOT NULL DEFAULT 0,
        deleted      INTEGER NOT NULL DEFAULT 0,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_core_tasks_list    ON core_tasks(list_id, deleted, sort_order);
      CREATE INDEX IF NOT EXISTS idx_core_tasks_myday   ON core_tasks(my_day, done, deleted);
      CREATE INDEX IF NOT EXISTS idx_core_tasks_due     ON core_tasks(due_date, deleted);

      CREATE TABLE IF NOT EXISTS core_steps (
        id         TEXT PRIMARY KEY,
        task_id    TEXT NOT NULL REFERENCES core_tasks(id) ON DELETE CASCADE,
        title      TEXT NOT NULL DEFAULT '',
        done       INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_core_steps_task ON core_steps(task_id, sort_order);

      CREATE TABLE IF NOT EXISTS core_settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: "add_task_repeat",
    sql: `
      ALTER TABLE core_tasks ADD COLUMN repeat TEXT NOT NULL DEFAULT 'none';
      ALTER TABLE core_tasks ADD COLUMN repeat_done_on TEXT;

      CREATE INDEX IF NOT EXISTS idx_core_tasks_repeat ON core_tasks(repeat, deleted);
    `,
  },
  {
    version: 3,
    name: "add_task_links",
    sql: `
      CREATE TABLE IF NOT EXISTS core_task_links (
        id         TEXT PRIMARY KEY,
        task_id    TEXT NOT NULL REFERENCES core_tasks(id) ON DELETE CASCADE,
        linked_id  TEXT NOT NULL REFERENCES core_tasks(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_core_task_links_a ON core_task_links(task_id);
      CREATE INDEX IF NOT EXISTS idx_core_task_links_b ON core_task_links(linked_id);
    `,
  },
  {
    // 「特殊单号记录」工具（tools/special-orders）的私有表。
    //
    // 为什么工具表由宿主建：工具是运行时可插拔的（丢个目录就装上、删个目录就卸载），
    // 让工具自己跑迁移会出现「迁移账本对不上」的问题 ——
    // 工具卸了但表还在、或者两个工具抢同一个版本号。
    // 所以工具只声明 manifest.dbVersion，真正的 schema 由宿主随核心迁移一起演进，
    // 表名走 toolTable() 的前缀约定，与 core_* 天然分区。
    //
    // 目前只是「占位」：表已建好、通道已打通，登记单号的界面逻辑以后再写。
    // 这里刻意不加 UNIQUE(order_no) 约束 —— 业务规则还没定，
    // 先留索引，等真做功能时再按需要补唯一约束（ALTER 加索引是安全的追加操作）。
    version: 4,
    name: "add_special_orders_tool_schema",
    sql: `
      CREATE TABLE IF NOT EXISTS tool_special_orders_records (
        id          TEXT PRIMARY KEY,
        order_no    TEXT NOT NULL,
        kind        TEXT NOT NULL DEFAULT '',
        note        TEXT NOT NULL DEFAULT '',
        recorded_at TEXT NOT NULL,
        deleted     INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tool_special_orders_no
        ON tool_special_orders_records(order_no, deleted);
      CREATE INDEX IF NOT EXISTS idx_tool_special_orders_time
        ON tool_special_orders_records(recorded_at);
    `,
  },
  {
    // 工具私有的键值存储 —— 所有工具共用的**一张**表，而不是每个工具一张。
    //
    // 为什么不按工具建表：工具表要跟着核心迁移走，每加一个需要存配置的工具
    // 就得加一次迁移；而工具的配置形态（API Key、上次选的模型、生成历史…）
    // 是工具自己的事，宿主不该为它改 schema。
    // 一张 kv 表 + (tool_id, key) 主键，就把这件事变成了纯数据。
    //
    // 隔离靠宿主强制：工具发过来的请求里**没有 tool_id**，
    // tool_id 由宿主从「这个请求是哪个 iframe 发来的」推导，
    // 所以工具在物理上读写不到别的工具的键。
    version: 5,
    name: "add_tool_kv_store",
    sql: `
      CREATE TABLE IF NOT EXISTS core_tool_kv (
        tool_id    TEXT NOT NULL,
        key        TEXT NOT NULL,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (tool_id, key)
      );

      CREATE INDEX IF NOT EXISTS idx_core_tool_kv_tool ON core_tool_kv(tool_id);
    `,
  },
  {
    // 工单模块。
    //
    // 为什么工单另起一张表而不是复用 core_tasks：
    // 待办是「一件事」（两种状态，做完就没了），工单是「一个流程」
    // （有单号、有开始时间、沿自定义的过程态序列前进、每步留痕）。
    // 硬塞进 core_tasks 会出现「一半的列对一半的行永远为空」，
    // 之后每加一个工单特性都要在待办代码里判断"这行是不是工单"。
    // 两者只在**展示层混排**，存储层各自独立。
    //
    // 五个表的分工：
    //   core_wo_flows   流程模板（多套，用户可增删改）
    //   core_wo_stages  流程里的过程态（可改名/调色/排序/标记终态）
    //   core_work_orders 工单本体，stage_id 指向当前过程态
    //   core_wo_logs    过程态流转留痕（"完整的过程"就落在这里）
    //   core_plan_items 计划表条目（工单与待办混编的顺序；功能已下线，表保留）
    //
    // is_terminal 放在阶段上而不是硬编码"最后一个就是终态"：
    // 用户可能把「已取消」摆在中间或最后，是否算完结只有他自己知道。
    //
    // core_wo_logs.seq 存在的理由：光靠 at 排序不够 ——
    // 时间戳只有毫秒精度，而我们自己就会在同一个 tick 里连写两条
    // （建单立刻推到第二步）。时间戳相等时 SQL 不保证顺序，时间线会看起来是乱的。
    // seq 是每张工单内自增的序号，排序以它为准，时间只用来显示。
    version: 6,
    name: "add_work_orders",
    sql: `
      CREATE TABLE IF NOT EXISTS core_wo_flows (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0,
        deleted    INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS core_wo_stages (
        id          TEXT PRIMARY KEY,
        flow_id     TEXT NOT NULL REFERENCES core_wo_flows(id) ON DELETE CASCADE,
        name        TEXT NOT NULL,
        color       TEXT NOT NULL DEFAULT '#378add',
        sort_order  INTEGER NOT NULL DEFAULT 0,
        is_terminal INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_core_wo_stages_flow
        ON core_wo_stages(flow_id, sort_order);

      CREATE TABLE IF NOT EXISTS core_work_orders (
        id           TEXT PRIMARY KEY,
        no           TEXT NOT NULL DEFAULT '',
        title        TEXT NOT NULL DEFAULT '',
        flow_id      TEXT NOT NULL,
        stage_id     TEXT NOT NULL,
        note         TEXT NOT NULL DEFAULT '',
        important    INTEGER NOT NULL DEFAULT 0,
        my_day       INTEGER NOT NULL DEFAULT 0,
        start_date   TEXT,
        due_date     TEXT,
        completed_at TEXT,
        sort_order   INTEGER NOT NULL DEFAULT 0,
        deleted      INTEGER NOT NULL DEFAULT 0,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_core_wo_stage  ON core_work_orders(stage_id, deleted);
      CREATE INDEX IF NOT EXISTS idx_core_wo_dates  ON core_work_orders(start_date, due_date, deleted);
      CREATE INDEX IF NOT EXISTS idx_core_wo_myday  ON core_work_orders(my_day, deleted);
      CREATE INDEX IF NOT EXISTS idx_core_wo_flow   ON core_work_orders(flow_id, deleted);

      CREATE TABLE IF NOT EXISTS core_wo_logs (
        id         TEXT PRIMARY KEY,
        wo_id      TEXT NOT NULL REFERENCES core_work_orders(id) ON DELETE CASCADE,
        from_stage TEXT,
        to_stage   TEXT NOT NULL,
        at         TEXT NOT NULL,
        note       TEXT NOT NULL DEFAULT '',
        seq        INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_core_wo_logs_wo ON core_wo_logs(wo_id, seq);

      -- 计划表用的表，功能已下线（紧急区是算出来的，不需要持久化），
      -- 但**表留着**：迁移只追加，已发布的库不该因为升级就少掉一张表。
      CREATE TABLE IF NOT EXISTS core_plan_items (
        id         TEXT PRIMARY KEY,
        date       TEXT NOT NULL,
        kind       TEXT NOT NULL,
        ref_id     TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_core_plan_date ON core_plan_items(date, sort_order);
      CREATE INDEX IF NOT EXISTS idx_core_plan_ref  ON core_plan_items(kind, ref_id);
    `,
  },
  {
    // 工单附件。
    //
    // 两条存放策略（对应 kind 字段）：
    //   image / video → 下载进本地仓库，rel_path 指向仓库内的文件
    //   link          → 只存 source_url，本地不留副本
    // 之所以把这两类塞进同一张表而不是拆两张：它们在界面上是同一条附件栏，
    // 要按用户排的顺序混在一起显示，拆表就得每次查询再合并、再排序。
    //
    // rel_path 存**相对**路径（形如 2026-09/a1b2c3d4-图.jpg），仓库根目录
    // 由宿主在运行时解析。存绝对路径的话，换机器/改用户名后整批附件全失效。
    //
    // hash 是内容指纹，用于跨工单去重：同一份文件只占一份磁盘。
    // 代价是删除时必须先查还有没有别的行引用同一个 hash，不能直接删文件
    // —— 这条约束在 repo.ts 的 deleteAttachment 里落实。
    //
    // width/height/duration_ms 允许为空：它们是**探测出来的**，不是添加时就知道的。
    // 图片要等 img 真的解码、视频要等 loadedmetadata。宁可先空着，
    // 也不要为了填这三个字段在添加时同步加载一遍媒体。
    version: 7,
    name: "add_wo_attachments",
    sql: `
      CREATE TABLE IF NOT EXISTS core_wo_attachments (
        id          TEXT PRIMARY KEY,
        wo_id       TEXT NOT NULL REFERENCES core_work_orders(id) ON DELETE CASCADE,
        kind        TEXT NOT NULL DEFAULT 'link',
        title       TEXT NOT NULL DEFAULT '',
        rel_path    TEXT,
        source_url  TEXT,
        mime        TEXT NOT NULL DEFAULT '',
        size_bytes  INTEGER,
        hash        TEXT,
        width       INTEGER,
        height      INTEGER,
        duration_ms INTEGER,
        note        TEXT NOT NULL DEFAULT '',
        sort_order  INTEGER NOT NULL DEFAULT 0,
        deleted     INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_core_wo_att_wo
        ON core_wo_attachments(wo_id, deleted, sort_order);
      CREATE INDEX IF NOT EXISTS idx_core_wo_att_hash
        ON core_wo_attachments(hash, deleted);
    `,
  },
  {
    // 「特殊单号」——有处理时效的工单。
    //
    // 它**不是**一个新模块，而是工单的一种：以快递单号为起点、要沿着自定义流程走、
    // 每走一步都有时效（到下一步之前还剩多久）、会绑定一批自定义的相关信息。
    //
    // 为什么不做成 tools/special-orders 那张工具私有表（v4 曾按那样建过）：
    // 「时效」是**随流转不断重设**的东西，而流转留痕（core_wo_logs）、
    // 流程模板（core_wo_flows/stages）全都围绕
    // core_work_orders 长出来。放到工具私有表里，等于把这三件事各重写一遍，
    // 而且它也就无法"以工单的形式出现在工作台中"。
    // 所以 v8 把它收进工单表，那张占位表一并删掉 —— 它从未被写入过
    // （只有测试往里塞过探针行），留着只会让人以为功能还没做完。
    //
    // kind 用列而不是新表：特殊单和普通单在工单视图里是**同一份列表**，
    // 只是特殊单多带时效与相关信息。分表的话每次查询都要合并再排序，
    // 且工单的每处改动都得问一句"特殊单那边要不要同步"。
    //
    // stage_due_at 只存**绝对时刻**。"到下一步之前给多久"（2 小时 / 明天 10 点）
    // 是输入方式，不是存储方式 —— 存时长还得再记一个起点，跨重启就算不清了。
    // 它是"当前这一步"的截止时刻，推进时由 moveOrderToStage 重设。
    //
    // stage_due_notified_at 记录"这个时效已经提醒到哪一档"（'' / soon / overdue）。
    // 提醒队列本身是内存态、重启即空，光靠"队列里有没有"去重会让每次启动都重弹一遍。
    //
    // core_wo_stages.default_minutes 让流程模板能带"这一步默认给多久"，
    // 推进时自动续上，省得每步都手填。0 表示不预设。
    version: 8,
    name: "add_special_orders_as_work_orders",
    sql: `
      ALTER TABLE core_work_orders ADD COLUMN kind TEXT NOT NULL DEFAULT 'normal';
      ALTER TABLE core_work_orders ADD COLUMN stage_due_at TEXT;
      ALTER TABLE core_work_orders ADD COLUMN stage_due_notified_at TEXT NOT NULL DEFAULT '';

      CREATE INDEX IF NOT EXISTS idx_core_wo_kind ON core_work_orders(kind, deleted);
      CREATE INDEX IF NOT EXISTS idx_core_wo_stage_due
        ON core_work_orders(stage_due_at, deleted);

      ALTER TABLE core_wo_stages ADD COLUMN default_minutes INTEGER NOT NULL DEFAULT 0;

      CREATE TABLE IF NOT EXISTS core_wo_fields (
        id         TEXT PRIMARY KEY,
        wo_id      TEXT NOT NULL REFERENCES core_work_orders(id) ON DELETE CASCADE,
        label      TEXT NOT NULL DEFAULT '',
        value      TEXT NOT NULL DEFAULT '',
        sort_order INTEGER NOT NULL DEFAULT 0,
        deleted    INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_core_wo_fields_wo
        ON core_wo_fields(wo_id, deleted, sort_order);
      CREATE INDEX IF NOT EXISTS idx_core_wo_fields_value
        ON core_wo_fields(value, deleted);

      DROP TABLE IF EXISTS tool_special_orders_records;
    `,
  },
  {
    // 图库 —— 工作台里所有图片/视频的**共同落点**。
    //
    // 为什么它是核心表而不是工具私有表：
    // 「图库」的用法就是"一个地方存所有素材，谁都能往里放、谁都能从里面取"。
    // 图片裁剪的产物、尺码表的成品、AI 生成的结果、以及用户自己导入的图，
    // 全都落到同一处；AI 生成的参考图又必须能直接从图库里挑。
    // 做成 tools/gallery 的话，它和其它工具之间只能走"工具间通道"，
    // 而工具在物理上拿不到别的工具的数据 —— 双向联动根本做不了。
    //
    // 文件仍然走附件那套**内容寻址仓库**（attachments/），只是这里不存路径前缀
    // 差异：rel_path 与 core_wo_attachments.rel_path 处在同一个池子里，
    // 所以同一张图"既在工单里又在图库里"时磁盘上只有一份。
    // 代价是删除时要**跨表**数引用（见 attachments 的引用计数约定），
    // 换来的是不重复占盘 —— 素材图动辄几 MB，这个取舍是值得的。
    //
    // origin 记录"谁放进来的"（manual / ai-gen / image-crop / size-chart）。
    // 它不是为了分类显示，而是为了两件具体的事：
    //   1. AI 生成的结果要能按提示词回溯，prompt 一栏才有意义；
    //   2. 工具写入的内容出问题时，能一眼看出是哪条路径进来的。
    //
    // prompt 单独一列而不是塞进 note：它是**可复用的输入**（换个模型再来一次），
    // note 是给人看的备注。两者的生命周期完全不同。
    //
    // width/height/duration_ms 与附件同理，允许为空 —— 它们是探测出来的，
    // 不是写入时就知道的。
    version: 9,
    name: "add_gallery",
    sql: `
      CREATE TABLE IF NOT EXISTS core_gallery_items (
        id          TEXT PRIMARY KEY,
        title       TEXT NOT NULL DEFAULT '',
        kind        TEXT NOT NULL DEFAULT 'image',
        rel_path    TEXT,
        source_url  TEXT,
        mime        TEXT NOT NULL DEFAULT '',
        size_bytes  INTEGER,
        hash        TEXT,
        width       INTEGER,
        height      INTEGER,
        duration_ms INTEGER,
        origin      TEXT NOT NULL DEFAULT 'manual',
        prompt      TEXT NOT NULL DEFAULT '',
        note        TEXT NOT NULL DEFAULT '',
        deleted     INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_core_gallery_time
        ON core_gallery_items(deleted, created_at);
      CREATE INDEX IF NOT EXISTS idx_core_gallery_hash
        ON core_gallery_items(hash, deleted);
      CREATE INDEX IF NOT EXISTS idx_core_gallery_origin
        ON core_gallery_items(origin, deleted);
    `,
  },
  {
    // 工具私有表的**版本台账**。
    //
    // 为什么要有它：工具 schema 的执行时机是"工具被挂载时"，而挂载每次
    // 启动都可能发生。没有台账就得每回都跑一遍 CREATE TABLE IF NOT EXISTS
    // （能跑，但没法知道"这次到底建过没有"），更关键的是**没法识别版本变化**
    // —— 工具作者把一列从一个表挪到另一个表时，旧表会被 IF NOT EXISTS
    // 原样留下，永远删不掉。
    //
    // 记在 core_ 而不是工具表里，是因为**这张台账属于宿主**：
    // 它描述的是"宿主为这个工具做过什么"，不是工具自己的业务数据。
    // 卸载工具时它会跟着被清掉（掉仍保留工具表，下次重装按 version 判断要不要重建）。
    version: 10,
    name: "add_tool_schema_ledger",
    sql: `
      CREATE TABLE IF NOT EXISTS core_tool_schema (
        tool_id    TEXT PRIMARY KEY,
        version    INTEGER NOT NULL DEFAULT 0,
        applied_at TEXT NOT NULL
      );
    `,
  },
  {
    // 工单记住"这张单是哪个快递商的"。
    //
    // 存快递商是为了认不出来时**人能指定一次就永久生效**：
    // 单号规则只能靠形状猜，而形状撞车是常态（12 位纯数字可能是顺丰、
    // 中通、圆通中的任何一家）。自动识别给的是"最可能"，用户手改一次
    // 之后就该按他说的算 —— 每次重开都弹回猜测值，等于不认人的修正。
    //
    // 空串表示"没指定，按单号自动识别"，而不是"未知快递商"：
    // 识别规则以后会补会修，把当年的猜测冻进库里，老数据就永远停在旧规则上了。
    //
    // 普通工单也有这一列（它不是 special 专属）：工单是同一张表，
    // 为 special 单开一张表意味着整套工单子系统要来第二遍。
    version: 11,
    name: "add_wo_courier",
    sql: `
      ALTER TABLE core_work_orders ADD COLUMN courier TEXT NOT NULL DEFAULT '';
    `,
  },
];

/** 当前代码期望的 schema 版本 */
export const CURRENT_SCHEMA_VERSION = migrations[migrations.length - 1].version;

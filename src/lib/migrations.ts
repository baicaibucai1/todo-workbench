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
    // 流程任务模块。
    //
    // 为什么流程任务另起一张表而不是复用 core_tasks：
    // 待办是「一件事」（两种状态，做完就没了），流程任务是「一个流程」
    // （有单号、有开始时间、沿自定义的过程态序列前进、每步留痕）。
    // 硬塞进 core_tasks 会出现「一半的列对一半的行永远为空」，
    // 之后每加一个流程任务特性都要在待办代码里判断"这行是不是流程任务"。
    // 两者只在**展示层混排**，存储层各自独立。
    //
    // 五个表的分工：
    //   core_wo_flows   流程模板（多套，用户可增删改）
    //   core_wo_stages  流程里的过程态（可改名/调色/排序/标记终态）
    //   core_work_orders 流程任务本体，stage_id 指向当前过程态
    //   core_wo_logs    过程态流转留痕（"完整的过程"就落在这里）
    //   core_plan_items 计划表条目（流程任务与待办混编的顺序；功能已下线，表保留）
    //
    // is_terminal 放在阶段上而不是硬编码"最后一个就是终态"：
    // 用户可能把「已取消」摆在中间或最后，是否算完结只有他自己知道。
    //
    // core_wo_logs.seq 存在的理由：光靠 at 排序不够 ——
    // 时间戳只有毫秒精度，而我们自己就会在同一个 tick 里连写两条
    // （建单立刻推到第二步）。时间戳相等时 SQL 不保证顺序，时间线会看起来是乱的。
    // seq 是每张流程任务内自增的序号，排序以它为准，时间只用来显示。
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
    // 流程任务附件。
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
    // hash 是内容指纹，用于跨流程任务去重：同一份文件只占一份磁盘。
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
    // 「特殊单号」——有处理时效的流程任务。
    //
    // 它**不是**一个新模块，而是流程任务的一种：以快递单号为起点、要沿着自定义流程走、
    // 每走一步都有时效（到下一步之前还剩多久）、会绑定一批自定义的相关信息。
    //
    // 为什么不做成 tools/special-orders 那张工具私有表（v4 曾按那样建过）：
    // 「时效」是**随流转不断重设**的东西，而流转留痕（core_wo_logs）、
    // 流程模板（core_wo_flows/stages）全都围绕
    // core_work_orders 长出来。放到工具私有表里，等于把这三件事各重写一遍，
    // 而且它也就无法"以流程任务的形式出现在工作台中"。
    // 所以 v8 把它收进流程任务表，那张占位表一并删掉 —— 它从未被写入过
    // （只有测试往里塞过探针行），留着只会让人以为功能还没做完。
    //
    // kind 用列而不是新表：特殊单和普通单在流程任务视图里是**同一份列表**，
    // 只是特殊单多带时效与相关信息。分表的话每次查询都要合并再排序，
    // 且流程任务的每处改动都得问一句"特殊单那边要不要同步"。
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
    // 所以同一张图"既在流程任务里又在图库里"时磁盘上只有一份。
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
    // 流程任务记住"这张单是哪个快递商的"。
    //
    // 存快递商是为了认不出来时**人能指定一次就永久生效**：
    // 单号规则只能靠形状猜，而形状撞车是常态（12 位纯数字可能是顺丰、
    // 中通、圆通中的任何一家）。自动识别给的是"最可能"，用户手改一次
    // 之后就该按他说的算 —— 每次重开都弹回猜测值，等于不认人的修正。
    //
    // 空串表示"没指定，按单号自动识别"，而不是"未知快递商"：
    // 识别规则以后会补会修，把当年的猜测冻进库里，老数据就永远停在旧规则上了。
    //
    // 普通流程任务也有这一列（它不是 special 专属）：流程任务是同一张表，
    // 为 special 单开一张表意味着整套流程任务子系统要来第二遍。
    version: 11,
    name: "add_wo_courier",
    sql: `
      ALTER TABLE core_work_orders ADD COLUMN courier TEXT NOT NULL DEFAULT '';
    `,
  },
  {
    // 子任务（core_steps，界面上叫「子任务」）带上自己的到期时刻。
    //
    // 之前子任务只有"做完没做完"，它**在时间上是隐形的**：一条待办挂着
    // 5 个子任务，其中"三点前把图发出去"到点了，紧急区里却只有那条待办
    // 自己的到期日 —— 真正要命的那一步没人提醒。有了 due_at，子任务就能
    // 和待办、流程任务一样按"还剩多久"排序进紧急区。
    //
    // 存**绝对时刻**而不是"提前多久"：跨重启后"提前 2 小时"要再记一次起点，
    // 起点一丢就算不清了（与 core_work_orders.stage_due_at 同一套取舍）。
    version: 12,
    name: "add_step_due_at",
    sql: `
      ALTER TABLE core_steps ADD COLUMN due_at TEXT;
    `,
  },
  {
    // 流程任务的「描述」。
    //
    // 起因：普通流程任务原来靠自动生成的单号（WO-YYYYMMDD-NNN）当标识，
    // 但那个号对用户没有任何意义 —— 他手上没有一张纸质单据对得上它，
    // 真正想写下来的是"这件事到底要办什么"。所以普通流程任务不再自动编号，
    // 改成一句自由填写的描述。
    //
    // 为什么**新加一列**而不是把 no 直接改语义：
    // no 目前是特殊单号的**快递单号**（那是这类单子的起点，要拿去查物流），
    // 蹭用同一列会让"这一列到底是编号还是人话"永远说不清；
    // 而且迁移只追加、永不改已发布的列，改语义等于对所有老库做不可逆的心智迁移。
    //
    // 老数据里那些 WO- 号**留在库里不动**（只是界面不再显示）：
    // 清空是不可逆的写操作，而它至少还是老单唯一的对账标识。
    version: 13,
    name: "add_wo_description",
    sql: `
      ALTER TABLE core_work_orders ADD COLUMN description TEXT NOT NULL DEFAULT '';
    `,
  },
  {
    // 「坚果云同步」（v14）的前置条件：双向合并要能回答"这条记录最后一次
    // 是什么时候改的"。这三张表原先只有 created_at —— 新建时间够用来排序，
    // 但**改动**在数据里看不见，于是 A 机器改了附件的标题、B 机器改了同一个
    // 附件的备注，两边都会认为"我没动过，你说了算"，合并结果取决于谁先同步。
    //
    // core_task_links 还多补一个 deleted：取消关联原本是硬删（DELETE），
    // 行没了就无从分辨"这是刚取消的关联"还是"对面还没同步过来"。
    // 软删之后，取消关联才是一条能被同步的明确变更。
    //
    // 老行的 updated_at 是 NULL，不是空串 —— 合并时按 `updated_at ?? created_at`
    // 兜底（见 lib/sync.ts 的 stampOf），绝不能把 NULL 当成"最小"，
    // 那会让所有老数据在新机器上永远赢不了。
    version: 14,
    name: "add_sync_timestamps",
    sql: `
      ALTER TABLE core_gallery_items ADD COLUMN updated_at TEXT;
      ALTER TABLE core_wo_attachments ADD COLUMN updated_at TEXT;
      ALTER TABLE core_task_links ADD COLUMN updated_at TEXT;
      ALTER TABLE core_task_links ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    // 内置 AI 助手的对话记录（v15）。
    //
    // 为什么要落库而不是只放内存：助手是"要替你干活"的那个角色，
    // 一次对话里交代的背景（"我们做电商，单号都以 SF 开头"、"这个工具的表要三列"）
    // 一旦重启就没了，下次得从头讲一遍 —— 那它就不像一个助手，像一个每次失忆的表单。
    //
    // 为什么存 core_ 而不是工具私有表：**助手是宿主的一部分**，它要碰 core_tasks
    // （建日程）和工具目录（写工具），这两件事在工具沙箱里都做不到
    // （工具在物理上碰不到 core_*，见 toolBridge 的文件头）。
    // 所以它不是 tools/ai-agent，而是和「特殊单号」同一种东西：一个原生视图。
    //
    // 为什么只有一个会话（没有 thread 表）：需求是"基本的对话"。
    // 多会话要配一套切换/重命名/删除的界面，而那些界面在没有搜索与分享之前
    // 只是把"我上次说了什么"变得更难找。一个会话 + 一颗「新对话」按钮足够，
    // 真想留下什么，用户自己会写进待办或工具里 —— 那才是这个应用里
    // 有长期价值的东西。
    //
    // ⚠️ 上面这段结论**已被 v16 推翻**（见文件末尾的 add_agent_chats）。
    // 留在这里是因为它记录了当时的判断依据，而推翻它的理由恰好是那句
    // 判断的前提不成立：会话不会一直少，而"新对话 = 删掉旧的"会让用户
    // 不敢开新对话 —— 一个让人不敢用的按钮，就不该存在。
    //
    // actions 存 JSON 数组：助手每一轮做过什么（装了哪个工具、建了哪几条日程）
    // 必须能回放。只存一段文本的话，"它说它建了"和"它真建了"就分不出来了，
    // 而那正是这类功能最该被检验的地方。
    //
    // seq 用**毫秒时间戳**而不是行号：排序要跨越"同一毫秒内连写两条"这种情形，
    // 而这段代码里确实会（一条助手消息 + 紧随其后的动作结果）。用 rowid 不可行 ——
    // 内存库没有这个概念。
    version: 15,
    name: "add_agent_messages",
    sql: `
      CREATE TABLE IF NOT EXISTS core_agent_messages (
        id         TEXT PRIMARY KEY,
        role       TEXT NOT NULL,
        content    TEXT NOT NULL DEFAULT '',
        actions    TEXT NOT NULL DEFAULT '[]',
        error      TEXT NOT NULL DEFAULT '',
        seq        INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_core_agent_seq ON core_agent_messages(seq);
    `,
  },
  {
    // 助手的多会话（v16）。
    //
    // v15 的注释里写过"一个会话 + 一颗新对话按钮足够"，理由是"多会话界面在
    // 没有搜索与分享之前，只是把'我上次说了什么'变得更难找"。用下来这句话
    // 只在**会话很少**时成立：天天用的人会自然按话题分开（今天在调工具、
    // 昨天在建流程），而旧的「新对话」是把上一段**删掉** —— 那等于让人在一块
    // 不断被擦掉的黑板上干活，想回头看一眼昨天那版工具的参数，已经没了。
    //
    // 所以 v16 把"清空"拆成两件事：
    //   · 「新对话」= 开一段新的，旧的留在历史里（对话界面右上角）
    //   · 「清空对话」= 显式删，仍然两段式确认（设置 → AI 助手）
    // 会话要有标题，否则历史列表里全是"3 天前"这种分辨不出内容的项。标题不额外
    // 占用户操作：第一次说话时取那句话的前几个字（见 runtime 的 autoTitle）。
    //
    // chat_id 用 ALTER 追加而不是重建表：core_agent_messages 里已经有真实对话，
    // 重建就得搬数据，而"搬数据"在内存库（浏览器 demo）上没有对应能力 ——
    // 那份实现只认 CREATE / ALTER / INSERT / UPDATE / DELETE 这几样。
    //
    // 老消息（chat_id 为空）归到一条「之前的对话」。不这么做的话，升级后
    // 用户打开助手会看到一份空的历史，而他那些记录明明还在库里 ——
    // 那是最糟的一种"数据没丢，但看起来丢了"。
    // 回填写成 INSERT ... SELECT 一体：迁移是纯 SQL，中间没有 JS 参与的余地；
    //
    // ⚠️ 过滤空表必须用 HAVING COUNT(*) > 0，**不能用 WHERE EXISTS**：
    // 不带 GROUP BY 的聚合 SELECT 无论 WHERE 是什么都返回一行
    // （全 NULL），空表时这一行照样插进去，撞上 created_at 的 NOT NULL ——
    // 迁移当场失败回滚，user_version 永远停在 15，应用每次启动都卡在
    // 初始化（2026-09-24 实机 0.2.0 白屏就是这个）。助手从没说过话的库，
    // 恰恰是最普遍的那一种。
    // 表本来就空时 SELECT 不产生行，正好什么都不做。
    //
    // ⚠️ 这条迁移让 memory 库第一次用上 ALTER：db.ts 的 MemoryDb 必须支持它，
    // 否则老快照里的行拿不到 chat_id，读会话时会被静默过滤掉（见 PITFALLS 五十七）。
    version: 16,
    name: "add_agent_chats",
    sql: `
      CREATE TABLE IF NOT EXISTS core_agent_chats (
        id         TEXT PRIMARY KEY,
        title      TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_core_agent_chats_updated ON core_agent_chats(updated_at);

      ALTER TABLE core_agent_messages ADD COLUMN chat_id TEXT NOT NULL DEFAULT '';

      CREATE INDEX IF NOT EXISTS idx_core_agent_msg_chat ON core_agent_messages(chat_id);

      INSERT INTO core_agent_chats (id, title, created_at, updated_at)
        SELECT 'chat-legacy', '之前的对话', MIN(created_at), MAX(created_at)
        FROM core_agent_messages
        HAVING COUNT(*) > 0;

      UPDATE core_agent_messages SET chat_id = 'chat-legacy' WHERE chat_id = '';
    `,
  },
  {
    // 「模块变选装」的回填（v17）：特殊单号与图库从"内置就有"改成"想要再开"。
    //
    // ⚠️ 本条**没有随任何 Release 发布过**（上一个发布的版本还停在 v16），
    // 所以它是在就地修正而不是追加一条 —— 已发布的迁移才永远不许改，
    // 没发布的就地改干净，好过让每个用户的库多跑一道无意义的搬家。
    //
    // ============================ 为什么要回填 ============================
    // 默认值只能管到"新建的库"。已经用了一段时间的库里可能躺着几十张单子、
    // 上百张图 —— 默认值一改，那些人的入口、提醒、紧急区会在升级后**一起
    // 消失**，而他们什么都没做。功能收起来是一句话的事，
    // 让用户以为数据丢了是另一回事。
    //
    // 两个 WHERE 条件缺一不可：
    //   · 键已存在 → 用户自己按过那个开关（开过或关过），迁移不能替他改主意；
    //   · 库里没有对应数据 → 他从没用过，按新的默认（关）就对了。
    //
    // ============================ 顺带把开关的键搬一次家 ============================
    // 以前每个模块各起一个键（`special.enabled`），现在统一成 `ext.<id>.enabled`
    // （见 lib/extensions/registry.ts）。用户的老值要跟着走 —— 他自己按过的
    // 那个开关，不能因为宿主改了内部命名就被当成"没按过"。
    //
    // ⚠️ 别把回填写成聚合 SELECT（`SELECT MAX(...) FROM ...`）：无 GROUP BY 的
    // 聚合**恒返回一行**，空表也会插入一条，撞上 NOT NULL 就是启动即崩
    // （v16 踩过一次，见 PITFALLS 七十三）。EXISTS 没有这个毛病。
    version: 17,
    name: "modules_opt_in",
    sql: `
      UPDATE core_settings SET key = 'ext.special.enabled'
        WHERE key = 'special.enabled'
          AND NOT EXISTS (
            SELECT 1 FROM core_settings WHERE key = 'ext.special.enabled'
          );
      DELETE FROM core_settings WHERE key = 'special.enabled';

      INSERT INTO core_settings (key, value)
        SELECT 'ext.special.enabled', '1'
        WHERE NOT EXISTS (SELECT 1 FROM core_settings WHERE key = 'ext.special.enabled')
          AND EXISTS (
            SELECT 1 FROM core_work_orders WHERE kind = 'special' AND deleted = 0
          );

      INSERT INTO core_settings (key, value)
        SELECT 'ext.gallery.enabled', '1'
        WHERE NOT EXISTS (SELECT 1 FROM core_settings WHERE key = 'ext.gallery.enabled')
          AND EXISTS (SELECT 1 FROM core_gallery_items);
    `,
  },

  {
    /*
     * v18：**助手自己写的技能**。
     *
     * ============================ 为什么它必须落库 ============================
     * 内置那几份技能是**代码**（skills.ts），改它们要重新发版。而助手在干活
     * 时会积累一批"这个项目/这个人特有的规矩"—— 比如"截图一律放工作区
     * 的 shots/ 下"、"写工具前先看 tests/fixtures/tools/panel-demo"。
     * 这些规矩只有它自己会总结出来说，也只有它自己每次都要用。
     *
     * 落在对话里等于没有：下一轮就没了。落库之后它能像内置技能一样被
     * read_skill 取回、被常驻注入一部分 —— 这才叫"学会"。
     *
     * ============================ 为什么不是写进 core_settings ============================
     * 技能是**一条记录**（有标题、有若干条规则、有全文），不是"一个值"。
     * 塞进 settings 只能存成一个大 JSON 字符串，于是列表、按 id 取、
     * 删掉某一条都要把整块读出来再拆 —— 那是拿键值表当表用。
     *
     * ============================ source 这一列 ============================
     * 内置（builtin）与助手新增（agent）分开放：界面要能说清"哪几条是它自己
     * 加的"，用户才谈得上删。混在一起的话，删错了就把写工具的标准删了，
     * 而那是最难排查的一类坏（助手开始写出装不上的工具，没人知道为什么）。
     */
    version: 18,
    name: "agent_skills",
    sql: `
      CREATE TABLE IF NOT EXISTS core_agent_skills (
        id         TEXT PRIMARY KEY,
        title      TEXT NOT NULL DEFAULT '',
        summary    TEXT NOT NULL DEFAULT '',
        rules      TEXT NOT NULL DEFAULT '[]',
        body       TEXT NOT NULL DEFAULT '',
        source     TEXT NOT NULL DEFAULT 'agent',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_core_agent_skills_source ON core_agent_skills(source);
    `,
  },
];

/** 当前代码期望的 schema 版本 */
export const CURRENT_SCHEMA_VERSION = migrations[migrations.length - 1].version;

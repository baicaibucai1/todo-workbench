import type { Task, WorkOrder } from "../types";

/**
 * 列表行的统一表示。
 *
 * 流程任务与待办在**展示层混排**：同一条链上按时间排，靠行内标记区分种类。
 * 存储层则各是各的表（见 lib/repo.ts 的说明）——
 * 混排是给人看的，不是给数据模型看的。
 */
export type Row = { kind: "task"; task: Task } | { kind: "order"; order: WorkOrder };

export type Section = {
  key: string;
  label: string;
  overdue: boolean;
  items: Row[];
  /**
   * 这一节是不是"自定义顺序"（按 `sort_order` 排的）。
   *
   * 只有这种节里的待办**可以拖动排序** —— 按日期排的节里拖一条没有任何意义
   * （松手后它又会被日期排回去），所以界面据此决定要不要给拖拽把手。
   */
  manual: boolean;
};

/** 一行参与排序的日期：待办看截止日，流程任务先看开始日再看交付日 */
export function rowDate(r: Row): string | null {
  return r.kind === "task" ? r.task.dueDate : (r.order.startDate ?? r.order.dueDate);
}

/** 按日期排（同日期保持原来的相对顺序，JS 的 sort 是稳定的） */
function byDate(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => {
    const da = rowDate(a) ?? "9999-99-99";
    const db = rowDate(b) ?? "9999-99-99";
    return da.localeCompare(db);
  });
}

// 原来这里还有一个 byDue（按处理时效排），它是「特殊单号」视图专用的
// 排序方式 —— 那个视图删掉后（2026-10-10）没有别的调用点了，一并拿掉。

/**
 * 把待办与流程任务分组、排序成界面要渲染的样子。
 *
 * **这份逻辑必须与「默认展开第一条」共用同一份实现**：
 * 右侧栏是常驻的，进来会自动选中一条；若选中规则和列表渲染规则各写一遍，
 * 就会出现「高亮的是第 3 行、详情却是第 1 行」这种没人能一眼看穿的错位。
 * 之前踩过：备注写进了 A 任务，界面上打开的却是 B。
 */
/**
 * 这一视图当前到底是"按日期"还是"自定义顺序"。
 *
 * 单独抽出来是因为**两个地方必须算出同一个答案**：
 * 列表渲染（`groupRows`）和"自动选中第一行"（`firstVisibleRow`）。
 * 各写一遍就会退化成"高亮的是第 3 行、详情却是第 1 行"—— 那个坑踩过一次。
 *
 * @param override 界面上那个排序开关；`null` = 用视图自己的默认
 */
export function resolveSortByDate(view: string, override?: boolean | null): boolean {
  return override ?? (view === "all" || view === "myday");
}

export function groupRows(
  tasks: Task[],
  orders: WorkOrder[],
  view: string,
  /**
   * 这一节要不要按日期排。
   *
   * 不传 = 用视图自己的默认（「全部」与「我的一天」按日期，清单与「重要」按
   * 自定义顺序）；传了就是界面上那个排序开关的状态。
   * 只有 `false`（自定义顺序）时待办才可以拖动排序。
   */
  sortByDate?: boolean,
): { sections: Section[]; done: Row[] } {
  const useDate = resolveSortByDate(view, sortByDate);
  const activeTasks = tasks.filter((t) => !t.done);
  const doneTasks = tasks.filter((t) => t.done);
  const openOrders = orders.filter((o) => !o.closed);
  const closedOrders = orders.filter((o) => o.closed);

  const done: Row[] = [
    ...doneTasks.map((task) => ({ kind: "task" as const, task })),
    ...closedOrders.map((order) => ({ kind: "order" as const, order })),
  ];

  // 「我的一天」里分成几类而不是一锅：
  //   今日任务 —— 手动加进来的、今天到期的
  //   每日任务 —— 每天都出现的习惯，今天勾掉明天自己回来
  // 混在一起时每日任务会天天赖在同一张列表里，很容易被误读成"昨天没做完"。
  //
  // 流程任务一条都不进这个视图。「特殊单号」在的时候，这里还会摆一组
  // 带处理时效的单子；功能删掉后（2026-10-10）数据层的 myday 分支也不再
  // 返回流程任务，这儿的 openOrders 理应是空的。
  if (view === "myday") {
    const daily = activeTasks.filter((t) => t.repeat === "daily");
    // 流程任务在这里被**显式**挡掉，不进「今日任务」：数据层已经不放行，
    // 这里是第二道闸 —— 直接传进来的 orders 若混着流程任务（比如调用方
    // 没走数据层），渲染出来就是"流程任务混进我的一天了"的回归。
    const once: Row[] = activeTasks
      .filter((t) => t.repeat !== "daily")
      .map((task) => ({ kind: "task" as const, task }));
    return {
      sections: [
        {
          key: "today",
          label: "今日任务",
          overdue: false,
          items: useDate ? byDate(once) : once,
          manual: !useDate,
        },
        {
          // 每日任务**永远**是自定义顺序：它们没有截止日，按日期排只会
          // 全部落在"9999-99-99"那一档里，退化成看不出规律的顺序。
          // 所以即使在按日期模式下，这一节也允许拖动。
          key: "daily",
          label: "每日任务",
          overdue: false,
          items: daily.map((task) => ({ kind: "task" as const, task })),
          manual: true,
        },
      ].filter((s) => s.items.length > 0),
      done,
    };
  }

  // 「流程任务」专属视图：只看流程任务，分「进行中 / 已完成」两组。
  //
  // 已完结的**不**塞进下面的折叠区：那块默认收起，而进这个视图的人多半就是想
  // 翻历史单子，藏起来等于没有。所以两组都当正式分组渲染。
  // done 必须是空数组 —— 默认那份 done 里混着已完成任务，流程任务视图里不该出现待办。
  if (view === "orders") {
    const asRows = (os: WorkOrder[]): Row[] =>
      os.map((order) => ({ kind: "order" as const, order }));
    return {
      sections: [
        { key: "open", label: "进行中", overdue: false, items: byDate(asRows(openOrders)), manual: false },
        { key: "closed", label: "已完成", overdue: false, items: byDate(asRows(closedOrders)), manual: false },
      ].filter((s) => s.items.length > 0),
      done: [],
    };
  }

  // 图床：它不是"待办的某种筛选"，一条待办/流程任务都不该出现在这里。
  //
  // 显式写出来而不是靠"取数层已经返回空了"：groupRows 的兜底分支会把
  // 传进来的东西原样渲染出去，所以只要有一处忘了挡（比如以后有人给
  // 图床视图加个"顺便显示相关流程任务"），待办就会立刻漏进来。
  // done 同样必须是空数组 —— 默认那份 done 里混着已完成任务。
  if (view === "imagebed") {
    return { sections: [], done: [] };
  }

  // AI 助手：同图床 —— 助手界面上一条待办都不该出现。
  // 少这一句不会报错，只会让助手视图旁边冒出一整屏任务，看着像串台了。
  if (view === "agent") {
    return { sections: [], done: [] };
  }

  const all: Row[] = [
    ...activeTasks.map((task) => ({ kind: "task" as const, task })),
    ...openOrders.map((order) => ({ kind: "order" as const, order })),
  ];
  return {
    sections: [
      {
        key: "active",
        label: "",
        overdue: false,
        items: useDate ? byDate(all) : all,
        manual: !useDate,
      },
    ],
    done,
  };
}

/**
 * 当前视图下**肉眼看到的第一行**（已完成折叠区不算，它默认是收起的）。
 *
 * 「右侧栏始终展开，默认展开第一个待办」靠它落地：
 * 自动选中必须是这一条，否则面板里显示的内容跟列表第一行对不上。
 */
export function firstVisibleRow(
  tasks: Task[],
  orders: WorkOrder[],
  view: string,
  sortOverride?: boolean | null,
): Row | null {
  const { sections } = groupRows(
    tasks,
    orders,
    view,
    resolveSortByDate(view, sortOverride),
  );
  for (const s of sections) {
    if (s.items.length) return s.items[0];
  }
  return null;
}

import type { Task, WorkOrder } from "../types";
import { addDays, today } from "./repo";
import { dueState } from "./due";

/**
 * 列表行的统一表示。
 *
 * 工单与待办在**展示层混排**：同一条链上按时间排，靠行内标记区分种类。
 * 存储层则各是各的表（见 lib/repo.ts 的说明）——
 * 混排是给人看的，不是给数据模型看的。
 */
export type Row = { kind: "task"; task: Task } | { kind: "order"; order: WorkOrder };

export type Section = {
  key: string;
  label: string;
  overdue: boolean;
  items: Row[];
};

/** 一行参与排序的日期：待办看截止日，工单先看开始日再看交付日 */
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

/**
 * 按时效排：越早到期越靠前。
 *
 * 逾期（时刻在过去）自然排在最前面，而且是**超得越久越靠前** ——
 * 这正是"先处理最等不起的"想要的效果。没设时效的排最后：
 * 它们不属于"等不起"那一类，塞在中间只会把真正紧急的挤下去。
 */
function byDue(rows: Row[]): Row[] {
  const key = (r: Row): number => {
    if (r.kind !== "order" || !r.order.stageDueAt) return Number.MAX_SAFE_INTEGER;
    const t = new Date(r.order.stageDueAt).getTime();
    return Number.isNaN(t) ? Number.MAX_SAFE_INTEGER : t;
  };
  return [...rows].sort((a, b) => key(a) - key(b));
}

/**
 * 把待办与工单分组、排序成界面要渲染的样子。
 *
 * **这份逻辑必须与「默认展开第一条」共用同一份实现**：
 * 右侧栏是常驻的，进来会自动选中一条；若选中规则和列表渲染规则各写一遍，
 * 就会出现「高亮的是第 3 行、详情却是第 1 行」这种没人能一眼看穿的错位。
 * 之前踩过：备注写进了 A 任务，界面上打开的却是 B。
 */
export function groupRows(
  tasks: Task[],
  orders: WorkOrder[],
  view: string,
): { sections: Section[]; done: Row[] } {
  const activeTasks = tasks.filter((t) => !t.done);
  const doneTasks = tasks.filter((t) => t.done);
  const openOrders = orders.filter((o) => !o.closed);
  const closedOrders = orders.filter((o) => o.closed);

  const done: Row[] = [
    ...doneTasks.map((task) => ({ kind: "task" as const, task })),
    ...closedOrders.map((order) => ({ kind: "order" as const, order })),
  ];

  if (view === "planned") {
    // 「计划内」按日期分组，工单按开始日（没有就看交付日）落桶
    const buckets = new Map<string, Row[]>();
    const push = (key: string, row: Row) => {
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(row);
    };
    for (const t of activeTasks) push(t.dueDate ?? "未安排", { kind: "task", task: t });
    for (const o of openOrders) {
      push(o.startDate ?? o.dueDate ?? "未安排", { kind: "order", order: o });
    }

    const todayStr = today();
    const tomorrow = addDays(todayStr, 1);
    const sorted = [...buckets.entries()].sort(([a], [b]) => {
      if (a === "未安排") return 1;
      if (b === "未安排") return -1;
      return a.localeCompare(b);
    });
    return {
      sections: sorted.map(([key, items]) => ({
        key,
        label:
          key === "未安排"
            ? "未安排"
            : key === todayStr
              ? "今天"
              : key === tomorrow
                ? "明天"
                : key < todayStr
                  ? `已过期 · ${key}`
                  : key,
        overdue: key !== "未安排" && key < todayStr,
        items,
      })),
      done,
    };
  }

  // 「我的一天」里分成几类而不是一锅：
  //   特殊单号 —— 今天在跟的、等不起的。单独一组、按时效排（逾期最前），
  //               放在最上面：这个视图是"提醒"的前线，越急越要先被看见
  //   今日任务 —— 手动加进来的、今天到期的
  //   每日任务 —— 每天都出现的习惯，今天勾掉明天自己回来
  // 混在一起时每日任务会天天赖在同一张列表里，很容易被误读成"昨天没做完"。
  if (view === "myday") {
    const specials = openOrders.filter((o) => o.kind === "special");
    // 组头只在这一组里**真的有逾期单**时才红 —— 无条件标红会让
    // "红"失去告警的意义，天天红等于没有红。
    const specialOverdue = specials.some((o) => dueState(o) === "overdue");
    const daily = activeTasks.filter((t) => t.repeat === "daily");
    // 普通工单在这里被**显式**挡掉，不进「今日任务」：数据层
    // （fetchWorkOrders 的 myday 分支）只放行 kind='special'，这里是第二道闸 ——
    // 和 orders/special 视图 "fetchTasks 返回空 + rows.done 置空" 两处不能漏一处
    // 是同一条纪律。直接传进来的 orders 若混有普通工单（比如调用方没走数据层），
    // 渲染出来就是"工单又混进我的一天了"的回归。
    const once: Row[] = activeTasks
      .filter((t) => t.repeat !== "daily")
      .map((task) => ({ kind: "task" as const, task }));
    return {
      sections: [
        { key: "special", label: "特殊单号", overdue: specialOverdue, items: byDue(specials.map((order) => ({ kind: "order" as const, order }))) },
        { key: "today", label: "今日任务", overdue: false, items: byDate(once) },
        {
          key: "daily",
          label: "每日任务",
          overdue: false,
          items: daily.map((task) => ({ kind: "task" as const, task })),
        },
      ].filter((s) => s.items.length > 0),
      done,
    };
  }

  // 「工单」专属视图：只看工单，分「进行中 / 已完成」两组。
  //
  // 已完结的**不**塞进下面的折叠区：那块默认收起，而进这个视图的人多半就是想
  // 翻历史单子，藏起来等于没有。所以两组都当正式分组渲染。
  // done 必须是空数组 —— 默认那份 done 里混着已完成任务，工单视图里不该出现待办。
  if (view === "orders") {
    const asRows = (os: WorkOrder[]): Row[] =>
      os.map((order) => ({ kind: "order" as const, order }));
    return {
      sections: [
        { key: "open", label: "进行中", overdue: false, items: byDate(asRows(openOrders)) },
        { key: "closed", label: "已完成", overdue: false, items: byDate(asRows(closedOrders)) },
      ].filter((s) => s.items.length > 0),
      done: [],
    };
  }

  // 「特殊单号」专属视图：只看带处理时效的那些工单（工单的真子集），
  // 同样分「进行中 / 已完成」两组。
  //
  // 进行中那组**按时效排，不按日期排** —— 进这个视图的人问的是
  // "哪一个先等不起"，而不是"哪个先开始的"。
  // 已完结的那组回到按日期排：都办完了，时效已经没有意义了。
  if (view === "special") {
    const asRows = (os: WorkOrder[]): Row[] =>
      os.map((order) => ({ kind: "order" as const, order }));
    const specials = orders.filter((o) => o.kind === "special");
    return {
      sections: [
        {
          key: "open",
          label: "进行中",
          overdue: false,
          items: byDue(asRows(specials.filter((o) => !o.closed))),
        },
        {
          key: "closed",
          label: "已完成",
          overdue: false,
          items: byDate(asRows(specials.filter((o) => o.closed))),
        },
      ].filter((s) => s.items.length > 0),
      done: [],
    };
  }

  // 图库：它不是"待办的某种筛选"，一条待办/工单都不该出现在这里。
  //
  // 显式写出来而不是靠"取数层已经返回空了"：groupRows 的兜底分支会把
  // 传进来的东西原样渲染出去，所以只要有一处忘了挡（比如以后有人给
  // 图库视图加个"顺便显示相关工单"），待办就会立刻漏进来。
  // done 同样必须是空数组 —— 默认那份 done 里混着已完成任务。
  if (view === "gallery") {
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
        items: view === "all" ? byDate(all) : all,
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
): Row | null {
  const { sections } = groupRows(tasks, orders, view);
  for (const s of sections) {
    if (s.items.length) return s.items[0];
  }
  return null;
}

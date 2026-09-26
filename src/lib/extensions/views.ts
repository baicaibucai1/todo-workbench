/**
 * 视图分发表 —— 「某个 view id 该渲染什么」的唯一答案。
 *
 * 它为什么单独一个文件、为什么不写进 registry：
 * registry 不能 import 组件（store 会问它问题，一旦它反过来依赖组件
 * 就成环，详见 registry.ts 的文件头）。所以数据在 registry、渲染体在这里，
 * 两个方向都是单向的。
 *
 * 以前这里是 App.tsx 里的三元表达式：
 *
 *     view === "gallery" ? <GalleryView /> : <TaskList />
 *
 * 每加一个整页视图就在那句上再套一层 —— 而且它**天然没有"这个视图现在
 * 还能不能用"的概念**：模块关掉之后界面会停在合法但空的一屏上。
 * 现在的查法把这两件事分开了：能不能落在 registry.isViewAvailable，
 * 落在哪儿渲染在这里。
 *
 * ⚠️ 这里的键必须是某个扩展在 injects 里声明过的 view id，
 * 否则 App 拿不到它的合法性判断（会退化成"永远可用"）。
 */

import type { ComponentType } from "react";
import TaskList from "../../components/TaskList";
import GalleryView from "../../components/GalleryView";
import WorkspaceView from "../../components/WorkspaceView";

/**
 * 注意多个 id 指向同一个 TaskList：待办的三个筛选、清单、流程任务、
 * 特殊单号都是同一套列表渲染器，靠 store 里的 view / activeListId 区分内容。
 * 这不是偷懒 —— 它们本来就是同一张列表的几种滤法。
 */
const VIEW_COMPONENTS: Record<string, ComponentType> = {
  myday: TaskList,
  important: TaskList,
  all: TaskList,
  list: TaskList,
  orders: TaskList,
  special: TaskList,
  gallery: GalleryView,
  workspace: WorkspaceView,
};

/**
 * 查一个 view 的渲染体。
 *
 * 查不到时退回 TaskList 而不是渲染空白：一个没登记过的 view id 通常是
 * 老数据里的脏值（刷新前的路由写在 URL 上），用户看到的是待办列表，
 * 比看到一块空白更容易明白发生了什么 —— 也更容易自己走回去。
 */
export function resolveViewComponent(view: string): ComponentType {
  return VIEW_COMPONENTS[view] ?? TaskList;
}

/** 这个 view 登记过吗（给测试与自己人看的：没登记的 id 会静默退回待办） */
export function hasView(view: string): boolean {
  return Object.prototype.hasOwnProperty.call(VIEW_COMPONENTS, view);
}

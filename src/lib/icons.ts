/**
 * 图标名到 lucide 组件的映射。
 *
 * 工具 manifest 里只写图标名字符串，不直接写组件名 ——
 * 这样第三方工具不可能引用到未导出的模块，也便于以后换图标库。
 */

import {
  Sun,
  Star,
  CalendarDays,
  Inbox,
  Home,
  Package,
  Crop,
  Receipt,
  Image,
  Calculator,
  FileText,
  ListChecks,
  Settings,
  Boxes,
  Sparkles,
  Video,
  Hash,
  NotebookPen,
  Bot,
  type LucideIcon,
} from "lucide-react";

export const ICONS: Record<string, LucideIcon> = {
  sun: Sun,
  star: Star,
  calendar: CalendarDays,
  inbox: Inbox,
  home: Home,
  package: Package,
  crop: Crop,
  receipt: Receipt,
  image: Image,
  calculator: Calculator,
  file: FileText,
  list: ListChecks,
  settings: Settings,
  boxes: Boxes,
  // 新增工具用的图标：AI 生成（sparkles/video）、单号类（hash）
  sparkles: Sparkles,
  video: Video,
  hash: Hash,
  // 记笔记类工具（随包自带的「随手记」用）
  "notebook-pen": NotebookPen,
  // 助手类工具（AI 写的工具常想用机器人图标；三处技能提示词都列了 bot，
  // 这里必须真的有映射，否则会静默退回默认包裹图标）
  bot: Bot,
};

export function resolveIcon(name?: string): LucideIcon {
  return ICONS[name ?? ""] ?? Package;
}

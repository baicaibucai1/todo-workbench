import {
  UserRound,
  Palette,
  Package,
  Database,
  SlidersHorizontal,
  Info,
  Save,
  Cloud,
  Bot,
} from "lucide-react";

export const NAV = [
  { key: "profile", label: "个人资料", icon: UserRound },
  { key: "appearance", label: "外观", icon: Palette },
  { key: "tools", label: "工具", icon: Package },
  // AI 助手紧挨着「工具」：它最主要的一件事就是写工具、给工具绑数据表，
  // 放在一起，用户找"怎么让它干活"时不用在两个分区之间来回跳
  { key: "ai", label: "AI 助手", icon: Bot },
  { key: "database", label: "数据库", icon: Database },
  { key: "data", label: "数据与备份", icon: Save },
  { key: "sync", label: "同步", icon: Cloud },
  { key: "behavior", label: "行为偏好", icon: SlidersHorizontal },
  { key: "about", label: "关于与更新", icon: Info },
] as const;

export type SectionKey = (typeof NAV)[number]["key"];

/** 深链过来的分区名要校验：store 里那一格是 string，不能直接当 key 用 */
export function isSectionKey(v: string | null | undefined): v is SectionKey {
  return !!v && NAV.some((n) => n.key === v);
}

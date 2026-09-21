/**
 * 系统通知。
 *
 * 网页端走标准 Notification API。桌面版（Tauri）用的是 WebView2，
 * 它同样暴露 Notification API，但权限由系统决定；拿不到权限时不报错，
 * 由应用内的提醒卡片兜底 —— 提醒本身不能因为通知被拒就消失。
 */

export function notifySupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function notifyPermission(): NotificationPermission | "unsupported" {
  if (!notifySupported()) return "unsupported";
  return Notification.permission;
}

/** 申请通知权限。已授权直接返回 granted，不支持返回 unsupported。 */
export async function requestNotifyPermission(): Promise<
  NotificationPermission | "unsupported"
> {
  if (!notifySupported()) return "unsupported";
  if (Notification.permission !== "default") return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

/** 发一条通知。任何异常都吞掉：通知只是锦上添花，不该影响主流程。 */
export function sendNotification(title: string, body?: string): void {
  if (!notifySupported() || Notification.permission !== "granted") return;
  try {
    new Notification(title, { body, tag: `todo-${title}`, silent: false });
  } catch {
    /* 某些环境（如无通知中心的 Windows 会话）构造即失败，忽略 */
  }
}

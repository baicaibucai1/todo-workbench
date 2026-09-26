/**
 * 自定义壁纸的存取。
 *
 * ⚠️ 为什么单独一个文件，不塞进 lib/wallpapers.ts：
 * 那个模块的纯函数（parseBackground / loadWallpapers）会被 Node 里的冒烟测试
 * 直接 import，而这里要拉 attachmentStore → db.ts → @tauri-apps/api/core，
 * 在 Node 里一 import 就炸。保持 wallpapers.ts 无副作用，测试才跑得动。
 *
 * 存在附件仓库里，不另起目录，理由写在 wallpapers.ts 的文件头。
 */

import { attachmentStore } from "./attachments";
import type { CustomWallpaper } from "./wallpapers";
import { WALLPAPER_IMAGE_ONLY, WALLPAPER_MAX_BYTES } from "./wallpapers";

/**
 * 把用户选的图放进仓库。
 *
 * @param source 桌面端是本机路径，浏览器端是 File 对象（两边都由 pickLocalMedia 给）
 * @param name   给人看的文件名
 */
export async function addCustomWallpaper(
  source: string | File,
  name: string,
): Promise<CustomWallpaper> {
  const store = attachmentStore();
  const stored = await store.importLocal(source, { maxBytes: WALLPAPER_MAX_BYTES });

  /*
   * 类型检查放在存完之后：仓库会按 magic bytes 判真实类型，
   * 而改名成 .jpg 的 .exe 也只有这一步才现形。
   * 已经被放进仓库了，所以这里的拒绝必须**顺手删掉那个文件** ——
   * 否则仓库里会留下一张永远列不出来的图。
   */
  if (stored.mime && !WALLPAPER_IMAGE_ONLY.test(stored.mime)) {
    await store.remove(stored.relPath).catch(() => undefined);
    throw new Error(`这不是图片（识别为 ${stored.mime}），壁纸只支持图片`);
  }

  return { path: stored.relPath, name: name || stored.relPath };
}

/** 相对路径 → 能喂给 <img src> 的地址 */
export async function customWallpaperUrl(path: string): Promise<string> {
  return attachmentStore().url(path);
}

/**
 * 删掉一张自定义壁纸。
 *
 * 删文件与删清单是**两件事**，这里只做前者，清单由调用方（store）改设置。
 * 顺序上必须先改设置再删文件：反过来的话，万一中途失败，
 * 设置里还指着一张已经不存在的文件，界面会一直显示加载失败。
 */
export async function removeCustomWallpaperFile(path: string): Promise<void> {
  await attachmentStore().remove(path);
}

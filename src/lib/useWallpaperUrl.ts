/**
 * 把「背景设置」解析成一个能直接喂给 <img src> 的地址。
 *
 * 抽成 hook 是因为**自定义的那一半是异步的**：内置壁纸拼个 URL 就行，
 * 而用户传的图要先向附件仓库要地址（桌面是 asset://，浏览器是 blob:）。
 * 把这段逻辑散在 TaskList 和设置页各写一遍，迟早有一处忘了处理异步那一半，
 * 表现是"选了自定义壁纸，但空白"。
 */

import { useEffect, useState } from "react";
import { customWallpaperUrl } from "./customWallpaper";
import { parseBackground, wallpaperUrl } from "./wallpapers";

/**
 * @param raw appearance.background 的原始值
 * @returns 图片地址；auto 或还在解析时为 null
 */
export function useWallpaperUrl(raw: string | undefined): string | null {
  const bg = parseBackground(raw);
  const key = bg.kind === "image" ? bg.file : bg.kind === "custom" ? bg.path : "";
  const [url, setUrl] = useState<string | null>(bg.kind === "image" ? wallpaperUrl(bg.file) : null);

  useEffect(() => {
    // 内置壁纸没有异步过程，直接算出来（连一次 loading 帧都省掉）
    if (bg.kind !== "custom") {
      setUrl(bg.kind === "image" ? wallpaperUrl(bg.file) : null);
      return;
    }
    let alive = true;
    setUrl(null);
    void customWallpaperUrl(bg.path)
      .then((u) => {
        if (alive) setUrl(u);
      })
      .catch(() => {
        // 文件被手动删了 / 仓库坏了：留 null，让调用方按"没图"处理
        if (alive) setUrl(null);
      });
    return () => {
      alive = false;
    };
    // key 是这条背景的唯一标识（文件名或仓库路径），bg 对象每次渲染都是新的，
    // 不能拿它当依赖，否则 effect 会无限重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bg.kind, key]);

  return url;
}

/**
 * 从一张图里取主题色。
 *
 * 用途只有一个：设置页那个「取这张图的主色」按钮 —— 换了一张壁纸，
 * 顺手让界面配色跟它协调。
 *
 * 算法刻意**简单**：缩到小图 → 按 4bit 分桶 → 按"占比 × 饱和度"挑前两簇。
 * 没上 k-means，因为：
 *   - 这里要的是"这张图给人的整体印象色"，不是精确的调色板；
 *     聚类数 k 还得让用户调，而 k 取多少都是拍脑袋。
 *   - 分桶是 O(像素数)，4096 个桶的哈希表在 96×96 的图上跑完不到 1ms，
 *     点了按钮要立刻出结果，不能让用户等一个迭代收敛的过程。
 *   - 结果可预测：同一张图每次算出来一定一样（k-means 的初始中心是随机的）。
 *
 * 分成纯函数（paletteFromPixels）与异步取像素两部分，是为了让冒烟测试
 * 能直接喂一个像素数组，不必在 Node 里造 canvas。
 */

import { fitForUi, hslToRgb, rgbToHex, rgbToHsl } from "./theme";

export interface ExtractedPalette {
  accent: string;
  primary: string;
}

/* ------------------------------------------------------------------ */
/* 纯函数：像素 → 两色                                                  */
/* ------------------------------------------------------------------ */

const BUCKET_BITS = 4; // 每通道 16 级
const BUCKET_SHIFT = 8 - BUCKET_BITS;

interface Bucket {
  r: number;
  g: number;
  b: number;
  n: number;
}

/**
 * @param data RGBA 像素（Uint8ClampedArray，来自 canvas 的 getImageData）
 * @param stride 每隔几个像素取一个。图片已被缩小，通常传 1 就够快
 */
export function paletteFromPixels(
  data: Uint8ClampedArray | Uint8Array | number[],
  stride = 1,
): ExtractedPalette | null {
  const buckets = new Map<number, Bucket>();
  const len = data.length;

  for (let i = 0; i + 3 < len; i += 4 * stride) {
    const a = data[i + 3];
    // 透明像素不参与：PNG 的透明区在 canvas 上是 (0,0,0,0)，
    // 算进去会得到一团黑
    if (a < 128) continue;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const key =
      ((r >> BUCKET_SHIFT) << (BUCKET_BITS * 2)) |
      ((g >> BUCKET_SHIFT) << BUCKET_BITS) |
      (b >> BUCKET_SHIFT);
    const hit = buckets.get(key);
    if (hit) {
      hit.r += r;
      hit.g += g;
      hit.b += b;
      hit.n += 1;
    } else {
      buckets.set(key, { r, g, b, n: 1 });
    }
  }

  if (buckets.size === 0) return null;

  const scored: Array<{ hex: string; hsl: ReturnType<typeof rgbToHsl>; score: number }> = [];
  for (const bk of buckets.values()) {
    const hex = rgbToHex({ r: bk.r / bk.n, g: bk.g / bk.n, b: bk.b / bk.n });
    const hsl = rgbToHsl({ r: bk.r / bk.n, g: bk.g / bk.n, b: bk.b / bk.n });
    /*
     * 打分 = 占比 × 饱和度加成 × 明暗惩罚。
     *
     * 饱和度加成：一片灰蒙蒙的天空占了一半像素，但它不是"这张图的颜色"；
     *            反过来一小片红花才是人眼记住的那抹色。给饱和的加权。
     * 明暗惩罚：接近纯黑/纯白的是阴影和高光，不是色。压下去，但别压死
     *           （夜景图的主色本来就该深）。
     */
    const satBoost = 0.3 + 0.7 * hsl.s;
    const dark = hsl.l < 0.12 ? hsl.l / 0.12 : 1;
    const light = hsl.l > 0.92 ? (1 - hsl.l) / 0.08 : 1;
    scored.push({ hex, hsl, score: bk.n * satBoost * Math.max(0.05, dark * light) });
  }

  scored.sort((x, y) => y.score - x.score);
  const first = scored[0];
  const accent = fitForUi(first.hex);

  /*
   * 第二个色要跟第一个**拉得开**，否则 accent 和 primary 同屏时看着像同一个色
   * —— 那就失去了"品牌色 / 主操作色"两个角色的意义。
   * 判据用色相差（> 32°）或明度差（> 0.18）任一满足即可：
   * 同色相不同明度（深蓝 + 浅蓝）也是清楚的搭配。
   */
  const accentHsl = rgbToHsl(
    // fitForUi 之后色相不变，直接用它的 h/s/l 判断更准
    (() => {
      const n = parseInt(accent.slice(1), 16);
      return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
    })(),
  );

  const second = scored.find((c) => {
    if (c === first) return false;
    const dh = Math.abs(c.hsl.h - accentHsl.h);
    const dist = Math.min(dh, 360 - dh);
    return dist > 32 || Math.abs(c.hsl.l - accentHsl.l) > 0.18;
  });

  const primary = second
    ? fitForUi(second.hex)
    : // 图里只有一簇色：把色相转 150° 造一个"对角色"。
      // 只转色相、不动明度与饱和度，是从图里来的那个色的近亲，不会突兀。
      rgbToHex(
        hslToRgb({
          h: accentHsl.h + 150,
          s: Math.max(accentHsl.s, 0.3),
          l: accentHsl.l,
        }),
      );

  return { accent, primary };
}

/* ------------------------------------------------------------------ */
/* 异步：图 → 像素                                                     */
/* ------------------------------------------------------------------ */

/** 缩略边长。96 已经足够 —— 再大只是让哈希多一点，取色结果几乎不变 */
const SAMPLE_EDGE = 96;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    /*
     * 不加 crossOrigin 的话，跨域图会把 canvas 污染，getImageData 抛 SecurityError。
     * 加了则要求服务端给出 CORS 头（必应壁纸是随包同源的，自定义壁纸走
     * asset:// 与 blob:，都在同源范围内）。两边都失败时会走进下面的 catch，
     * 由调用方提示"这张图取不了色"，不会静默给出个错色。
     */
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("图片加载失败"));
    img.src = src;
  });
}

/**
 * 从图片地址取主题色。
 * 失败返回 null，调用方负责提示 —— 取色是锦上添花，不能因为它失败就弹个红框。
 */
export async function extractPalette(src: string): Promise<ExtractedPalette | null> {
  if (!src) return null;
  try {
    const img = await loadImage(src);
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) return null;
    const scale = Math.min(1, SAMPLE_EDGE / Math.max(w, h));
    const cw = Math.max(1, Math.round(w * scale));
    const ch = Math.max(1, Math.round(h * scale));

    const canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, cw, ch);
    const { data } = ctx.getImageData(0, 0, cw, ch);
    return paletteFromPixels(data);
  } catch {
    // 跨域污染、图片坏了、canvas 被禁 —— 任何一种都当作"这张图取不了色"
    return null;
  }
}

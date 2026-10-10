// 生成 Tauri 应用图标：纯 Node 实现，零第三方依赖。
//
// 为什么要手写：本机 pip 源不可用（Pillow 装不上），npm 包装器在本环境里也坏了。
// PNG 与 ICO 的格式本身不复杂，用内置 zlib 就能编出来，比解决网络问题更可靠。
//
// 产物（写入 src-tauri/icons/）：
//   icon.png        1024x1024  母版
//   32x32.png       Tauri bundle 必需
//   128x128.png     Tauri bundle 必需
//   128x128@2x.png  256x256，Windows 高分屏
//   icon.ico        多尺寸 ICO，Tauri bundle 必需
//   Square*.png     Windows Store 资源（备用，不参与当前 nsis 打包）
// 另存一份 128x128 到 docs/screenshots/logo.png —— README 抬头引用的就是它
// （为什么不直接引用 src-tauri/ 下那份：见 main() 里那段注释）。
//
// 设计：橙黄底 + 一张白任务卡，卡里两行勾选任务，底下压一条分隔线。
//
// renderIcon / renderSmallIcon / encodePng 是 export 的：外部脚本（比如把各尺寸
// 拼成一张对照图自查）可以直接复用，不必再抄一遍编码器。
// ⚠️ 但 import 本文件会顺带跑一次 main() —— 它会重新生成 src-tauri/icons/ 下的图。

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, "..", "src-tauri", "icons");

// ---------------------------------------------------------------------------
// 像素缓冲：RGBA，非预乘 alpha
// ---------------------------------------------------------------------------

function createCanvas(size) {
  return { size, data: new Uint8ClampedArray(size * size * 4) };
}

function blendPixel(canvas, x, y, [r, g, b, a]) {
  if (x < 0 || y < 0 || x >= canvas.size || y >= canvas.size) return;
  if (a <= 0) return;
  const i = (y * canvas.size + x) * 4;
  const srcA = a / 255;
  const dstA = canvas.data[i + 3] / 255;
  const outA = srcA + dstA * (1 - srcA);
  if (outA <= 0) return;
  for (let c = 0; c < 3; c++) {
    const src = [r, g, b][c];
    const dst = canvas.data[i + c];
    canvas.data[i + c] = Math.round((src * srcA + dst * dstA * (1 - srcA)) / outA);
  }
  canvas.data[i + 3] = Math.round(outA * 255);
}

// 超采样抗锯齿：在每个像素内取 N×N 个子样本，交给 shape 判断是否在图形内。
// 这样圆角、圆环、勾线的边缘都不会有锯齿，且不依赖任何绘图床。
const SS = 4;

function fillShape(canvas, bbox, color, insideTest) {
  const [x0, y0, x1, y1] = bbox;
  const lo = (v) => Math.max(0, Math.floor(v));
  const hi = (v, max) => Math.min(max, Math.ceil(v));
  for (let y = lo(y0); y < hi(y1, canvas.size); y++) {
    for (let x = lo(x0); x < hi(x1, canvas.size); x++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          if (insideTest(px, py)) hits++;
        }
      }
      if (hits === 0) continue;
      const cov = hits / (SS * SS);
      blendPixel(canvas, x, y, [
        color[0],
        color[1],
        color[2],
        Math.round(color[3] * cov),
      ]);
    }
  }
}

function roundedRectTest(x0, y0, x1, y1, radius) {
  return (px, py) => {
    if (px < x0 || px > x1 || py < y0 || py > y1) return false;
    const cx = Math.min(Math.max(px, x0 + radius), x1 - radius);
    const cy = Math.min(Math.max(py, y0 + radius), y1 - radius);
    const dx = px - cx;
    const dy = py - cy;
    return dx * dx + dy * dy <= radius * radius + 1e-9;
  };
}

function circleTest(cx, cy, r) {
  return (px, py) => {
    const dx = px - cx;
    const dy = py - cy;
    return dx * dx + dy * dy <= r * r;
  };
}

// 线段用「点到线段距离 + 圆头端点」表达，避免另外实现一套笔帽逻辑。
function capsuleTest(ax, ay, bx, by, halfWidth) {
  const vx = bx - ax;
  const vy = by - ay;
  const len2 = vx * vx + vy * vy;
  return (px, py) => {
    let t = len2 === 0 ? 0 : ((px - ax) * vx + (py - ay) * vy) / len2;
    t = Math.min(1, Math.max(0, t));
    const dx = px - (ax + t * vx);
    const dy = py - (ay + t * vy);
    return dx * dx + dy * dy <= halfWidth * halfWidth;
  };
}

// ---------------------------------------------------------------------------
// PNG 编码
// ---------------------------------------------------------------------------

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

export function encodePng(canvas) {
  const { size, data } = canvas;
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // 每行前置一个 filter 字节（0 = None）
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
    Buffer.from(data.buffer, data.byteOffset + y * size * 4, size * 4).copy(
      raw,
      rowStart + 1,
    );
  }

  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// ICO 编码：把 PNG 直接嵌进 ICO（Vista 起支持 PNG 压缩帧）
// ---------------------------------------------------------------------------

function encodeIco(pngBuffers) {
  const count = pngBuffers.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(count, 4);

  const dir = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;

  pngBuffers.forEach(({ png, size }, i) => {
    const p = i * 16;
    dir[p] = size >= 256 ? 0 : size; // 0 表示 256
    dir[p + 1] = size >= 256 ? 0 : size;
    dir[p + 2] = 0; // palette
    dir[p + 3] = 0; // reserved
    dir.writeUInt16LE(1, p + 4); // color planes
    dir.writeUInt16LE(32, p + 6); // bits per pixel
    dir.writeUInt32BE(0, p + 8);
    dir.writeUInt32LE(png.length, p + 8);
    dir.writeUInt32LE(offset, p + 12);
    offset += png.length;
  });

  return Buffer.concat([header, dir, ...pngBuffers.map((b) => b.png)]);
}

// ---------------------------------------------------------------------------
// 图形设计
// ---------------------------------------------------------------------------

const ORANGE = [234, 88, 12, 255]; // #EA580C 渐变上端（橙）
const YELLOW = [250, 204, 21, 255]; // #FACC15 渐变下端（黄）
const WHITE = [255, 255, 255, 255];
const CHECK = [217, 72, 15, 255]; // #D9480F 勾
const BAR = [252, 211, 77, 255]; // #FCD34D 任务行条
const RULE = [253, 230, 138, 255]; // #FDE68A 卡内分隔线

// 圆角方块内的竖直渐变。图标语言里渐变很常见，这里手工做逐行插值。
function fillVerticalGradient(canvas, box, radius, top, bottom) {
  const test = roundedRectTest(box[0], box[1], box[2], box[3], radius);
  for (let y = Math.floor(box[1]); y < Math.ceil(box[3]); y++) {
    const t = (y - box[1]) / (box[3] - box[1]);
    const c = [0, 1, 2].map((i) => Math.round(top[i] + (bottom[i] - top[i]) * t));
    fillShape(canvas, [box[0], y, box[2], y + 1], [c[0], c[1], c[2], 255], test);
  }
}

function fillRoundedRect(canvas, x0, y0, x1, y1, radius, color) {
  fillShape(canvas, [x0, y0, x1, y1], color, roundedRectTest(x0, y0, x1, y1, radius));
}

// 线段用"点到线段距离 + 圆头端点"表达。bbox 收紧到线段外扩一个笔宽 ——
// 之前的写法是整张画布逐个像素判 insideTest，在 1024 尺寸上白扫一百万个点。
function fillCapsule(canvas, ax, ay, bx, by, stroke, color) {
  const r = stroke / 2;
  fillShape(
    canvas,
    [Math.min(ax, bx) - r, Math.min(ay, by) - r, Math.max(ax, bx) + r, Math.max(ay, by) + r],
    color,
    capsuleTest(ax, ay, bx, by, r),
  );
}

function fillCheck(canvas, p1, p2, p3, stroke, color) {
  fillCapsule(canvas, p1[0], p1[1], p2[0], p2[1], stroke, color);
  fillCapsule(canvas, p2[0], p2[1], p3[0], p3[1], stroke, color);
}

/**
 * 大尺寸：橙黄底 + 一张白卡，卡里两行勾选任务，底下压一条分隔线。
 *
 * 为什么不是"一个更大的勾"：这个应用的核心动作是**勾掉一件事**，
 * 而单独一个勾只画了动作，画不出"一叠待办"。卡片一上来，清单这层意思就有了。
 */
export function renderIcon(size) {
  const canvas = createCanvas(size);
  const S = size / 1024; // 统一按 1024 设计稿缩放
  const u = (v) => v * S;

  // 1) 圆角方块底：留 4% 内边距，符合 Windows 图标安全区
  fillVerticalGradient(canvas, [u(40), u(40), u(984), u(984)], u(224), ORANGE, YELLOW);

  // 2) 白卡
  fillRoundedRect(canvas, u(168), u(190), u(856), u(834), u(104), WHITE);

  // 3) 两行任务：左边一个勾，右边一条长条
  const stroke = u(52);
  const rows = [
    { cy: 390, check: [[234, 388], [288, 442], [384, 334]] },
    { cy: 630, check: [[234, 628], [288, 682], [384, 574]] },
  ];
  for (const { cy, check } of rows) {
    fillRoundedRect(canvas, u(438), u(cy - 46), u(796), u(cy + 46), u(46), BAR);
    fillCheck(canvas, ...check.map(([x, y]) => [u(x), u(y)]), stroke, CHECK);
  }

  // 4) 分隔线。卡底那段留白不是白留的 —— 它是"还能再写一条"的位置
  fillCapsule(canvas, u(234), u(758), u(796), u(758), u(24), RULE);

  return canvas;
}

// 小尺寸（< 64px，含 ICO 的 16/24/32/48 帧）单独简化：
//   - 圆角方块沿用小半径比例，让 16px 也保持"圆角方块"而不是变成圆形
//   - 两行任务在这个尺度上每行不到 5px 高，会糊成一道脏线，所以只留一个粗勾。
//     卡片留着 —— 于是它跟大图标仍然是同一张脸，不是另一个图标。
export function renderSmallIcon(size) {
  const canvas = createCanvas(size);
  const S = size / 1024;
  const u = (v) => v * S;

  fillVerticalGradient(canvas, [u(34), u(34), u(990), u(990)], u(210), ORANGE, YELLOW);
  fillRoundedRect(canvas, u(128), u(150), u(896), u(874), u(140), WHITE);
  fillCheck(canvas, [u(292), u(536)], [u(432), u(676)], [u(744), u(346)], u(132), CHECK);

  return canvas;
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const written = [];

  const write = (name, buf) => {
    const p = path.join(OUT_DIR, name);
    fs.writeFileSync(p, buf);
    written.push({ name, bytes: buf.length });
  };

  // 渲染档位：≥ 64px 用细节版，更小的尺寸退到单勾版。
  // 阈值压在 64 而不是 128 —— 128px 的白卡完全放得下两行任务，
  // 没必要让它退回单勾，那样任务栏里 128 和 256 会是两张不同的图。
  const renderAt = (size) => (size >= 64 ? renderIcon(size) : renderSmallIcon(size));

  // 母版与各尺寸 PNG
  const sizes = [
    { name: "icon.png", size: 1024 },
    { name: "128x128@2x.png", size: 256 },
    { name: "128x128.png", size: 128 },
    { name: "32x32.png", size: 32 },
  ];

  const pngCache = new Map();
  for (const s of sizes) {
    const png = encodePng(renderAt(s.size));
    pngCache.set(s.size, png);
    write(s.name, png);
  }

  // Windows Store 方形资源，尺寸必须是标准值
  for (const size of [30, 44, 71, 89, 107, 142, 150, 284, 310]) {
    write(`Square${size}x${size}Logo.png`, encodePng(renderAt(size)));
  }

  // ICO：嵌入 16/24/32/48/64/128/256，Windows 会按需挑选
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const frames = icoSizes.map((size) => {
    const png = pngCache.get(size) ?? encodePng(renderAt(size));
    return { size, png };
  });
  write("icon.ico", encodeIco(frames));

  // README 抬头那张 logo：跟 128x128.png **同一份字节**，另存到 docs/screenshots/。
  //
  // 为什么不在 README 里直接写 `src-tauri/icons/128x128.png`：
  //   · README 里所有本地图都在 docs/screenshots/ 下，logo 不想当唯一的例外；
  //   · 有些 markdown 预览器只认自己那套资源目录，跨到 src-tauri/ 就不出图 ——
  //     "README 里看不到 logo"正是这么来的。
  // 为什么由本脚本生成而不是手工放一份：手工那份迟早跟图标走散，
  // 而改图标的人只会来跑 npm run icons。放这儿，两边永远同源。
  const readmeLogoDir = path.resolve(OUT_DIR, "..", "..", "docs", "screenshots");
  fs.mkdirSync(readmeLogoDir, { recursive: true });
  const logoPng = pngCache.get(128);
  fs.writeFileSync(path.join(readmeLogoDir, "logo.png"), logoPng);
  written.push({ name: "docs/screenshots/logo.png", bytes: logoPng.length });

  console.log("图标已生成 ->", OUT_DIR);
  for (const w of written) {
    console.log(`  ${w.name.padEnd(24)} ${(w.bytes / 1024).toFixed(1)} KB`);
  }
  console.log(`共 ${written.length} 个文件`);
}

main();

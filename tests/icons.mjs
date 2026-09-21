// 校验生成的 PNG / ICO 结构是否合法。
// 光看"文件写出来了"不够 —— 编码器是自己写的，必须验回读能通。

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ICON_DIR = path.resolve(__dirname, "..", "src-tauri", "icons");

let failures = 0;
const ok = (cond, msg) => {
  if (!cond) failures++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}`);
};

// ---------------------------------------------------------------------------
// PNG 解码：读回 IHDR、逐 chunk 校验 CRC、解压 IDAT，确认扫描行长度正确
// ---------------------------------------------------------------------------

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function parsePng(buf) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== sig[i]) throw new Error("PNG 签名错误");
  }

  let off = 8;
  const chunks = [];
  let ihdr = null;
  const idat = [];

  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    const storedCrc = buf.readUInt32BE(off + 8 + len);
    const actualCrc = crc32(buf.subarray(off + 4, off + 8 + len));
    if (storedCrc !== actualCrc) throw new Error(`chunk ${type} CRC 校验失败`);
    chunks.push(type);

    if (type === "IHDR") {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    }
    if (type === "IDAT") idat.push(data);
    if (type === "IEND") break;

    off += 12 + len;
  }

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = ihdr.colorType === 6 ? 4 : 3;
  const expected = ihdr.height * (ihdr.width * bpp + 1);
  return { ihdr, chunks, rawLength: raw.length, expectedRawLength: expected };
}

// ---------------------------------------------------------------------------
// ICO 解码：校验目录项、偏移量、以及每个内嵌 PNG 是否自洽
// ---------------------------------------------------------------------------

function parseIco(buf) {
  const reserved = buf.readUInt16LE(0);
  const type = buf.readUInt16LE(2);
  const count = buf.readUInt16LE(4);
  const entries = [];

  for (let i = 0; i < count; i++) {
    const p = 6 + i * 16;
    entries.push({
      width: buf[p] === 0 ? 256 : buf[p],
      height: buf[p + 1] === 0 ? 256 : buf[p + 1],
      bpp: buf.readUInt16LE(p + 6),
      length: buf.readUInt32LE(p + 8),
      offset: buf.readUInt32LE(p + 12),
    });
  }
  return { reserved, type, count, entries };
}

// ---------------------------------------------------------------------------

console.log("=== PNG 校验 ===");
const pngFiles = fs
  .readdirSync(ICON_DIR)
  .filter((f) => f.endsWith(".png"))
  .sort();

for (const f of pngFiles) {
  const buf = fs.readFileSync(path.join(ICON_DIR, f));
  try {
    const { ihdr, chunks, rawLength, expectedRawLength } = parsePng(buf);
    const squareish = Math.abs(ihdr.width - ihdr.height) <= 0;
    const problems = [];
    if (!squareish) problems.push("非正方形");
    if (ihdr.colorType !== 6) problems.push(`色型 ${ihdr.colorType} != 6`);
    if (rawLength !== expectedRawLength) problems.push("扫描行长度不符");
    if (!chunks.includes("IEND")) problems.push("缺 IEND");

    const label = `${f.padEnd(22)} ${ihdr.width}x${ihdr.height} RGBA`;
    ok(problems.length === 0, `${label}${problems.length ? " -> " + problems.join(", ") : ""}`);
  } catch (e) {
    ok(false, `${f.padEnd(22)} 解析异常: ${e.message}`);
  }
}

console.log("");
console.log("=== ICO 校验 ===");
const icoBuf = fs.readFileSync(path.join(ICON_DIR, "icon.ico"));
const ico = parseIco(icoBuf);

ok(ico.reserved === 0, `保留字段为 0`);
ok(ico.type === 1, `类型为 1（图标）`);
ok(ico.count === 7, `包含 7 个尺寸帧（实际 ${ico.count}）`);

const sorted = [...ico.entries].sort((a, b) => a.offset - b.offset);
let cursor = 6 + ico.count * 16;
for (const e of sorted) {
  const fits = e.offset === cursor;
  const inBounds = e.offset + e.length <= icoBuf.length;
  ok(
    fits && inBounds,
    `帧 ${String(e.width).padStart(3)}px  offset=${e.offset} length=${e.length}`,
  );
  cursor = e.offset + e.length;

  // 内嵌帧必须是合法 PNG
  const frame = icoBuf.subarray(e.offset, e.offset + e.length);
  try {
    const inner = parsePng(frame);
    ok(
      inner.ihdr.width === e.width && inner.ihdr.height === e.height,
      `        └ 内嵌 PNG 尺寸一致 (${inner.ihdr.width}x${inner.ihdr.height})`,
    );
  } catch (err) {
    ok(false, `        └ 内嵌 PNG 非法: ${err.message}`);
  }
}

ok(cursor === icoBuf.length, `文件长度与目录声明一致（无冗余字节）`);

console.log("");
console.log("=== tauri.conf.json 引用校验 ===");
const conf = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "..", "src-tauri", "tauri.conf.json"), "utf8"),
);
for (const rel of conf.bundle.icon) {
  const p = path.resolve(__dirname, "..", "src-tauri", rel);
  ok(fs.existsSync(p), `配置引用存在: ${rel}`);
}

console.log("");
if (failures === 0) {
  console.log("全部通过");
} else {
  console.log(`${failures} 项失败`);
  process.exitCode = 1;
}

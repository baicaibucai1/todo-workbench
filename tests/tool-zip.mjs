/**
 * toolZip 的单元测试：`npm run zip:test`
 *
 * 为什么自己造包而不是拿现成的：**用被测代码自己打的包去验自己**等于没验。
 * 这里按 ZIP 规范手工拼字节（本地头 / 中央目录 / EOCD 三段都是手写的），
 * 所以格式理解错了会立刻在这里红，而不是等到用户在界面上导入失败。
 *
 * 压缩用 node:zlib 的 deflateRawSync（与浏览器的 deflate-raw 同一算法），
 * 解压走被测的 DecompressionStream 分支。
 *
 * 用法：node tests/tool-zip.mjs
 */

import zlib from "node:zlib";
import { listZip, readZipEntry, safeRelPath } from "../src/lib/toolZip.ts";

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    failures.push(name + (detail ? ` —— ${detail}` : ""));
    console.log(`  FAIL  ${name}${detail ? ` —— ${detail}` : ""}`);
  }
}

/* ------------------------------------------------------------------ */
/* 手工拼一个 zip                                                       */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** @param files [{name, data, method}] method: 0=store, 8=deflate */
function buildZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, "utf8");
    const raw = Buffer.from(f.data);
    const stored = f.method === 8 ? zlib.deflateRawSync(raw) : raw;
    const crc = crc32(raw);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6); // UTF-8 名字
    lh.writeUInt16LE(f.method, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(stored.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(f.method, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(stored.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);

    locals.push(lh, nameBuf, stored);
    centrals.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + stored.length;
  }

  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  const all = Buffer.concat([...locals, cd, eocd]);
  // 转成 ArrayBuffer（被测代码吃的是 ArrayBuffer，跟浏览器里 File 读到的一样）
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength);
}

const enc = (s) => new TextEncoder().encode(s);

/* ------------------------------------------------------------------ */
/* 用例                                                                */
/* ------------------------------------------------------------------ */

console.log("\n=== 1. 列出条目 ===");
{
  const zip = buildZip([
    { name: "index.html", data: enc("<html></html>"), method: 0 },
    { name: "manifest.json", data: enc('{"id":"a"}'), method: 0 },
    { name: "ai/ort.js", data: enc("console.log(1)"), method: 8 },
  ]);
  const es = listZip(zip);
  check("三个条目都列出来了", es.length === 3, String(es.length));
  check("名字原样保留", es.map((e) => e.name).join(",") === "index.html,manifest.json,ai/ort.js", es.map((e) => e.name).join(","));
  check("store 条目的大小对", es[0].size === 13, String(es[0].size));
  check("deflate 条目的解压后大小对", es[2].size === 14, String(es[2].size));
  check("压缩方式与写入的一致", es[0].method === 0 && es[2].method === 8, `${es[0].method}/${es[2].method}`);
}

console.log("\n=== 2. 解压：store 与 deflate ===");
{
  const body = "x".repeat(5000); // 长一点，deflate 才真的压得动
  const zip = buildZip([
    { name: "a.txt", data: enc(body), method: 0 },
    { name: "b.txt", data: enc(body), method: 8 },
  ]);
  const es = listZip(zip);
  const a = await readZipEntry(zip, es[0]);
  const b = await readZipEntry(zip, es[1]);
  check("store 解出来一致", new TextDecoder().decode(a) === body);
  check("deflate 解出来一致", new TextDecoder().decode(b) === body);
  check("deflate 确实压缩过（压缩后更小）", es[1].compressedSize < es[1].size, `${es[1].compressedSize} vs ${es[1].size}`);
}

console.log("\n=== 3. 二进制不损坏（高位字节）===");
{
  // 0x80~0xFF 这些字节最容易在编码转换里被吃掉
  const bin = new Uint8Array(256);
  for (let i = 0; i < 256; i++) bin[i] = i;
  const zip = buildZip([{ name: "b.bin", data: bin, method: 8 }]);
  const out = await readZipEntry(zip, listZip(zip)[0]);
  check("256 个字节逐一相同", out.length === 256 && out.every((v, i) => v === i), `${out.length}`);
}

console.log("\n=== 4. 坏包要报错，不能静默出坏数据 ===");
{
  // CRC 对不上：手工改一个字节
  const zip = buildZip([{ name: "a.txt", data: enc("hello world"), method: 0 }]);
  const bytes = new Uint8Array(zip);
  const es = listZip(zip);
  bytes[es[0].dataStart] = 0x00; // 改数据，不动 CRC
  let msg = "";
  try {
    await readZipEntry(bytes.buffer, es[0]);
  } catch (e) {
    msg = e.message;
  }
  check("CRC 对不上会报错", /校验失败/.test(msg), msg);
}
{
  // 声明的长度与实际不符
  const zip = buildZip([{ name: "a.txt", data: enc("hello"), method: 0 }]);
  const es = listZip(zip);
  const liar = { ...es[0], size: 999 };
  let msg = "";
  try {
    await readZipEntry(zip, liar);
  } catch (e) {
    msg = e.message;
  }
  check("长度对不上会报错", /包可能坏了/.test(msg), msg);
}
{
  // 截断的包
  const zip = buildZip([{ name: "a.txt", data: enc("hello world"), method: 0 }]);
  const cut = zip.slice(0, zip.byteLength - 30);
  let msg = "";
  try {
    listZip(cut);
  } catch (e) {
    msg = e.message;
  }
  check("截断的包读不出条目", msg.length > 0, msg);
}
{
  let msg = "";
  try {
    listZip(enc("这不是 zip，只是一段文字").buffer);
  } catch (e) {
    msg = e.message;
  }
  check("不是 zip 会明说", /不像一个 zip/.test(msg), msg);
}
{
  // 不支持的压缩方式
  const zip = buildZip([{ name: "a.txt", data: enc("hello"), method: 12 }]);
  const es = listZip(zip);
  let msg = "";
  try {
    await readZipEntry(zip, es[0]);
  } catch (e) {
    msg = e.message;
  }
  check("不认识的压缩方式会明说", /不支持的压缩方式/.test(msg), msg);
}

console.log("\n=== 5. 路径穿越一律挡掉 ===");
{
  check("../ 挡掉", safeRelPath("../../evil.txt") === null, String(safeRelPath("../../evil.txt")));
  check("中间夹 .. 也挡掉", safeRelPath("a/b/../../evil.txt") === null, String(safeRelPath("a/b/../../evil.txt")));
  check("绝对路径挡掉", safeRelPath("/etc/passwd") === "etc/passwd", String(safeRelPath("/etc/passwd")));
  check("盘符挡掉", safeRelPath("C:/Windows/x.txt") === null, String(safeRelPath("C:/Windows/x.txt")));
  check("反斜杠挡掉", safeRelPath("a\\..\\evil.txt") === null, String(safeRelPath("a\\..\\evil.txt")));
  check("正常路径放行", safeRelPath("ai/ort.js") === "ai/ort.js", String(safeRelPath("ai/ort.js")));
  check("单个文件名放行", safeRelPath("index.html") === "index.html", String(safeRelPath("index.html")));
}

console.log("\n=== 6. 目录项不算文件 ===");
{
  const zip = buildZip([
    { name: "tools/", data: enc(""), method: 0 },
    { name: "tools/index.html", data: enc("<html>"), method: 0 },
  ]);
  const es = listZip(zip);
  check("目录项被标出来", es[0].dir === true && es[1].dir === false, `${es[0].dir}/${es[1].dir}`);
  check("目录项解压得空内容", (await readZipEntry(zip, es[0])).length === 0);
}

/* ------------------------------------------------------------------ */

console.log(`\n  ${passed} 项通过, ${failed} 项失败`);
if (failed) {
  for (const f of failures) console.log(`    · ${f}`);
  process.exit(1);
}
console.log("");

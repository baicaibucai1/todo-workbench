#!/usr/bin/env node
/**
 * pack-tools.mjs —— 把 tools/ 单独打成一个可选下载的 zip
 *
 * 为什么要单独一份：
 *
 * 从 v0.2.0 起**安装包里不再带任何工具**。原因很直接 —— tools/ 里有 50 MB
 * 的抠图模型（image-crop/ai，ONNX Runtime + MI-GAN，base64 分片塞在 .js 里），
 * 它让安装包的体积和客户的下载时间都跟着这一个工具走。
 * 而工具本来就是可插拔的：宿主只按 manifest 契约读文件，装谁能用就是谁能用，
 * 并不要求它一定躺在安装包里。
 *
 * 于是切成两件东西：
 *   主安装包（几 MB）—— 程序本体，装完干干净净，一个工具都没有
 *   工具包 zip（几十 MB，Release 里的另一份资产）—— 想要再下，解压即用
 *
 * 代价要说清楚：新装的桌面版第一次打开，工具区是空的。
 * 这跟以前"装完就有五个工具"不一样，所以 Settings 与 README 都写了怎么补。
 *
 * 为什么自己写 zip 而不用 PowerShell / tar：
 *   · 本机不能保证有 zip.exe，tar.exe 的行为随 Windows 版本漂移；
 *   · 这里要精确控制**压缩包内的路径布局**（必须是 tools/<id>/…），
 *     否则用户解压后多一层目录，工具就认不出来。
 *   格式是自己拼的 ZIP（deflate），约 120 行，不引第三方依赖。
 *
 * 用法：
 *   node scripts/pack-tools.mjs                # 输出到 release-assets/
 *   node scripts/pack-tools.mjs --check        # 只校验清单完整，不产出 zip
 *   node scripts/pack-tools.mjs --quiet
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const TOOLS = path.join(ROOT, "tools");
const OUT_DIR = path.join(ROOT, "release-assets");

/**
 * 不随工具包分发的目录。
 *
 * gomoku 是《单 HTML 工具编写标准》的**仓库样本**——当时为了验证"AI 能不能
 * 自己写出合格的工具"而生成，tests/gomoku-unit.mjs 那 59 项契约断言拿它当
 * 夹具。它是给写工具的人看的参考物，不是交付给用户的产品，所以留仓库、
 * 不进 zip。哪天真想把它变成正式工具，从这行里删掉 id 就行。
 */
const EXCLUDE = new Set(["gomoku"]);

const argv = process.argv.slice(2);
const CHECK = argv.includes("--check");
const QUIET = argv.includes("--quiet");
const say = (...a) => {
  if (!QUIET) console.log(...a);
};

/* ------------------------------------------------------------------ */
/* CRC32 与 DOS 时间戳                                                  */
/* ------------------------------------------------------------------ */

/** ZIP 用的是标准的 CRC-32（IEEE 802.3 多项式，反射输入） */
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
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS 日期时间：DATE 高 16 位存年月日，TIME 存时分秒（秒的精度是 2 秒） */
function dosStamp(d) {
  return {
    time: ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | (Math.floor(d.getSeconds() / 2) & 31),
    date: (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31),
  };
}

/* ------------------------------------------------------------------ */
/* 收集要打包的文件                                                     */
/* ------------------------------------------------------------------ */

/** 目录 → 相对路径清单（zip 里的名字一律用 `/` 分隔，这是格式要求） */
function collect(dir, prefix) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...collect(full, rel));
    else out.push(rel);
  }
  return out;
}

function readVersion() {
  const conf = JSON.parse(fs.readFileSync(path.join(ROOT, "src-tauri", "tauri.conf.json"), "utf8"));
  return String(conf.version || "0.0.0");
}

/**
 * 逐个工具做一次「能不能真的当工具用」的检查。
 *
 * 只在新手情境下常被触发：往 tools/ 丢了个半成品，主包构建不会报错
 * （工具本来就不参与构建），zip 也不报错 —— 最后坏的是用户那边的体验到找到为止。
 */
function inspectTools() {
  const ids = fs
    .readdirSync(TOOLS, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .filter((e) => !EXCLUDE.has(e.name))
    .map((e) => e.name)
    .sort();

  const rows = [];
  const problems = [];

  for (const id of ids) {
    const dir = path.join(TOOLS, id);
    const files = collect(dir, "");
    const hasManifest = files.includes("manifest.json");
    const entry = (() => {
      if (!hasManifest) return "index.html";
      try {
        const m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
        return m.entry || "index.html";
      } catch {
        return "index.html";
      }
    })();

    if (!hasManifest) problems.push(`${id}：缺 manifest.json`);
    else if (!files.includes(entry)) problems.push(`${id}：manifest 声明的入口 ${entry} 不存在`);

    const bytes = files.reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0);
    const ai = files.some((f) => f.startsWith("ai/"));
    rows.push({ id, files: files.length, bytes, ai });
  }

  return { rows, problems };
}

/* ------------------------------------------------------------------ */
/* 写 zip                                                               */
/* ------------------------------------------------------------------ */

/**
 * 产出 zip。
 *
 * 关于压缩等级： ai/ 里的模型是 base64 的 .js，deflate 能压到一半左右，
 * 值得多花那几秒。等级 6 是默认值，也是体积/耗时的平衡点。
 */
function writeZip(outFile, entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const raw = fs.readFileSync(e.abs);
    const crc = crc32(raw);
    const comp = zlib.deflateRawSync(raw, { level: 6 });
    const { time, date } = dosStamp(fs.statSync(e.abs).mtime);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); // local file header signature
    lh.writeUInt16LE(20, 4); // version needed to extract
    lh.writeUInt16LE(0x0800, 6); // flags：bit 11 = 文件名是 UTF-8
    lh.writeUInt16LE(8, 8); // compression method = deflate
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28); // extra field length

    locals.push(lh, name, comp);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); // central file header signature
    ch.writeUInt16LE(20, 4); // version made by
    ch.writeUInt16LE(20, 6); // version needed
    ch.writeUInt16LE(0x0800, 8); // 同上的 UTF-8 标志
    ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30); // extra
    ch.writeUInt16LE(0, 32); // comment
    ch.writeUInt16LE(0, 34); // 起始磁盘号
    ch.writeUInt16LE(0, 36); // 内部属性
    ch.writeUInt32LE(0, 38); // 外部属性
    ch.writeUInt32LE(offset, 42); // 本地头偏移
    centrals.push(ch, name);

    offset += lh.length + name.length + comp.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, Buffer.concat([...locals, centralBuf, eocd]));
  return Buffer.concat([...locals, centralBuf, eocd]).length;
}

/** zip 里那张安装说明：下载完最先看到的就应该是它 */
function readmeText(version, rows) {
  const list = rows
    .map((r) => `  - ${r.id.padEnd(14)} ${(r.bytes / 1048576).toFixed(1)} MB${r.ai ? "（含 AI 模型）" : ""}`)
    .join("\n");

  return [
    `待办工作台 v${version} · 工具包`,
    "",
    "怎么用：把同目录下的 tools 整个文件夹放进",
    "",
    "    %APPDATA%\\com.sogapopo.todo-workbench\\",
    "",
    "也就是让它变成 %APPDATA%\\com.sogapopo.todo-workbench\\tools\\<工具 id>\\，",
    "重启工作台后，设置 → 工具 里就能看到它们。",
    "（也可以让内置的 AI 助手直接写一个工具，那样不必下载这个包。）",
    "",
    "这一包里有什么：",
    list,
    "",
    "每个工具一个目录，目录里有 manifest.json 和入口 HTML。",
    "删掉某个目录就是卸载它 —— 工具的数据留在工作台的数据库里，互不牵连。",
    "",
  ].join("\r\n");
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

const version = readVersion();
const outName = `todo-workbench-tools_${version}.zip`;
const outFile = path.join(OUT_DIR, outName);

say("[pack-tools] 工具包：把 tools/ 单独打成一个可选下载");

if (!fs.existsSync(TOOLS)) {
  console.error(`  [x] 找不到 ${TOOLS}`);
  process.exit(1);
}

const { rows, problems } = inspectTools();

if (rows.length === 0) {
  console.error("  [x] tools/ 下一个工具都没有 —— 没有可打包的内容。");
  process.exit(1);
}

const totalFiles = rows.reduce((n, r) => n + r.files, 0);
const totalBytes = rows.reduce((n, r) => n + r.bytes, 0);

say("");
say("  工具清单：");
for (const r of rows) {
  say(
    `    ${r.id.padEnd(14)} ${String(r.files).padStart(3)} 个文件  ${(r.bytes / 1048576).toFixed(2).padStart(6)} MB${r.ai ? "  （含 AI 模型）" : ""}`,
  );
}
say(`    ${"合计".padEnd(13)} ${String(totalFiles).padStart(3)} 个文件  ${(totalBytes / 1048576).toFixed(2).padStart(6)} MB`);

if (problems.length) {
  console.error("");
  for (const p of problems) console.error(`  [x] ${p}`);
  process.exit(1);
}

if (CHECK) {
  say("");
  say(`[pack-tools] 检查通过：${rows.length} 个工具，没有破损的入口。`);
  process.exit(0);
}

if (fs.existsSync(outFile)) fs.rmSync(outFile, { force: true });

const entries = [];
// 安装说明放在顶层：用户解压第一眼能看到怎么用
const readmeAbs = path.join(OUT_DIR, ".tools-readme.tmp");
try {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(readmeAbs, readmeText(version, rows), "utf8");
  entries.push({ name: "README.txt", abs: readmeAbs });
  for (const r of rows) {
    for (const rel of collect(path.join(TOOLS, r.id), "")) {
      entries.push({ name: `tools/${r.id}/${rel}`, abs: path.join(TOOLS, r.id, rel) });
    }
  }

  const t0 = Date.now();
  const size = writeZip(outFile, entries);
  const sec = ((Date.now() - t0) / 1000).toFixed(1);

  say("");
  say(`  输出    ${path.relative(ROOT, outFile)}`);
  say(`  压缩包  ${(size / 1048576).toFixed(2)} MB（源 ${(totalBytes / 1048576).toFixed(2)} MB，${((size / totalBytes) * 100).toFixed(0)}%）`);
  say(`  耗时    ${sec}s`);
  say(`[pack-tools] 完成，共 ${entries.length} 个条目。`);
} finally {
  fs.rmSync(readmeAbs, { force: true });
}

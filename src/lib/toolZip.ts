/**
 * 只读的 ZIP 解包 —— 给「导入 .zip 工具包」用。
 *
 * ============================ 为什么不引第三方库 ============================
 *
 * 整个前端目前零运行时依赖（只有 react / zustand / lucide / tauri 那几个），
 * 为一个 200 行的格式解析往里塞一个包不划算；而且工具包是**外部输入**，
 * 解析过程里那些边界（路径穿越、zip64、假的长度）本来就都得自己看一遍。
 *
 * 解压用的是浏览器内置的 `DecompressionStream("deflate-raw")` ——
 * 桌面端是 WebView2（Chromium 内核），自带，不需要 wasm。
 *
 * ------------------------------------------------------------------
 * 只支持两种压缩方式，这是有意的
 * ------------------------------------------------------------------
 * 工具包要么是 `store`（不压缩，常见于打包脚本直接塞），要么是 `deflate`。
 * 其余方式（bzip2 / lzma / zstd / 加密）一律报"不认识"而不是猜 ——
 * 猜错的后果是写进工具目录一堆打不开的文件，那比一句报错难查得多。
 *
 * ------------------------------------------------------------------
 * 三条安全边界
 * ------------------------------------------------------------------
 *   1. **路径穿越**：`../`、`\`、绝对路径、盘符，一律拒绝（不能写到工具目录之外）
 *   2. **长度说谎**：本地头里的长度可能为 0（flag bit 3），一律以中央目录为准；
 *      解压后的实际长度也对一遍（防"声明 1KB 实际 1GB"）
 *   3. **CRC 校验**：解压完算一遍 CRC32，跟中央目录里那个对不上就报错
 */

export interface ZipEntry {
  /** 包内的原始路径（已拒绝穿越，分隔符仍是 /） */
  name: string;
  /** 解压后的大小（来自中央目录） */
  size: number;
  /** 压缩方式：0 = store，8 = deflate */
  method: number;
  /** 是不是目录项（以 / 结尾） */
  dir: boolean;
  /** 中央目录里的 CRC32 */
  crc: number;
  /** 本地头里数据段的起始偏移（内部用） */
  dataStart: number;
  /** 压缩后的字节数（内部用） */
  compressedSize: number;
}

const EOCD_SIG = 0x06054b50;
const CDH_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

const MAX_EOCD_SCAN = 65557 + 22;

/** 包里可能有几个条目（不解压，只看中央目录） */
export function listZip(buf: ArrayBuffer): ZipEntry[] {
  const dv = new DataView(buf);
  const eocd = findEocd(dv, buf.byteLength);
  if (eocd < 0) throw new Error("这不像一个 zip 文件（找不到结尾的中央目录记录）");

  const total = dv.getUint16(eocd + 10, true);
  const cdSize = dv.getUint32(eocd + 12, true);
  let cdOff = dv.getUint32(eocd + 16, true);

  if (total === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) {
    throw new Error("这是 zip64 格式的包，目前读不了（请用普通 zip 重新打一次）");
  }
  if (cdOff + cdSize > buf.byteLength) {
    throw new Error("zip 的中央目录越界了，文件可能被截断");
  }

  const out: ZipEntry[] = [];
  let p = cdOff;
  for (let i = 0; i < total; i++) {
    if (p + 46 > buf.byteLength || dv.getUint32(p, true) !== CDH_SIG) {
      throw new Error(`zip 中央目录第 ${i + 1} 项的头坏了（文件可能被截断）`);
    }
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    let compSize = dv.getUint32(p + 20, true);
    let size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    let localOff = dv.getUint32(p + 42, true);

    const name = decodeName(buf, p + 46, nameLen);

    // zip64 扩展字段：真正的长度/偏移放在这里
    const extra = new Uint8Array(buf, p + 46 + nameLen, extraLen);
    const z64 = readZip64Extra(extra);
    if (z64) {
      if (size === 0xffffffff) size = z64.size;
      if (compSize === 0xffffffff) compSize = z64.compSize;
      if (localOff === 0xffffffff) localOff = z64.offset;
    }

    if (!name.endsWith("/")) {
      const dataStart = localDataStart(dv, buf.byteLength, localOff, name);
      out.push({
        name,
        size,
        method,
        dir: false,
        crc,
        dataStart,
        compressedSize: compSize,
      });
    } else {
      out.push({ name, size: 0, method, dir: true, crc, dataStart: 0, compressedSize: 0 });
    }

    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** 解压一个条目 */
export async function readZipEntry(buf: ArrayBuffer, entry: ZipEntry): Promise<Uint8Array> {
  if (entry.dir) return new Uint8Array(0);
  const start = entry.dataStart;
  const n = entry.compressedSize;
  if (start + n > buf.byteLength) throw new Error(`条目「${entry.name}」的数据越界，包可能不完整`);
  const raw = new Uint8Array(buf, start, n);

  let data: Uint8Array;
  if (entry.method === 0) {
    data = raw;
  } else if (entry.method === 8) {
    data = await inflateRaw(raw);
  } else {
    throw new Error(`条目「${entry.name}」用了不支持的压缩方式（${entry.method}），只认 store 与 deflate`);
  }

  // 长度说谎：以中央目录声明的为准
  if (data.length !== entry.size) {
    throw new Error(
      `条目「${entry.name}」解压出来是 ${data.length} 字节，包里写的是 ${entry.size} 字节 —— 包可能坏了`,
    );
  }
  if (entry.crc && crc32(data) !== entry.crc) {
    throw new Error(`条目「${entry.name}」校验失败（CRC 对不上），包可能在传输中损坏`);
  }
  return data;
}

/* ------------------------------------------------------------------ */
/* 包名 → 落盘的相对路径                                                */
/* ------------------------------------------------------------------ */

/**
 * 把包内路径变成**可以安全落盘**的相对路径。
 *
 * 挡三样：绝对路径 / 盘符、`..`、反斜杠（Windows 上 `\` 也是分隔符，
 * 不挡住的话 `..\..\x` 能绕开对 `..` 的检查）。
 * 挡不住就返回 null —— 由调用方决定是跳过还是报错，**绝不软处理成"换个名字"**，
 * 那样出了问题没人知道文件去哪了。
 */
export function safeRelPath(name: string): string | null {
  const raw = name.replace(/^\/+/, "");
  if (!raw) return null;
  if (/^[A-Za-z]:/.test(raw)) return null; // C:\...
  if (raw.includes("\\")) return null;
  const parts = raw.split("/");
  for (const seg of parts) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") return null;
  }
  return parts.filter((s) => s && s !== ".").join("/");
}

/* ------------------------------------------------------------------ */
/* 内部                                                                */
/* ------------------------------------------------------------------ */

function findEocd(dv: DataView, len: number): number {
  const from = Math.max(0, len - MAX_EOCD_SCAN);
  // 从后往前找：文件末尾可能挂着自解压 stub 之类的东西
  for (let i = len - 22; i >= from; i--) {
    if (dv.getUint32(i, true) === EOCD_SIG) return i;
  }
  return -1;
}

function decodeName(buf: ArrayBuffer, at: number, len: number): string {
  // flag bit 11 表示 UTF-8；否则规范上是 CP437。中文名在非 UTF-8 包里会乱码，
  // 但工具包里的文件名都是 ASCII（index.html / manifest.json / ai/*.js），
  // 两种编码在 ASCII 上完全一致 —— 所以这里一律按 UTF-8 解，够用且不丢信息。
  return new TextDecoder("utf-8").decode(new Uint8Array(buf, at, len));
}

/** 本地头里数据段的起始位置（本地头的 extra 长度可能与中央目录不同，必须以它自己为准） */
function localDataStart(dv: DataView, len: number, localOff: number, name: string): number {
  if (localOff + 30 > len || dv.getUint32(localOff, true) !== LFH_SIG) {
    throw new Error(`条目「${name}」的本地头坏了，包可能被截断`);
  }
  const nameLen = dv.getUint16(localOff + 26, true);
  const extraLen = dv.getUint16(localOff + 28, true);
  return localOff + 30 + nameLen + extraLen;
}

function readZip64Extra(extra: Uint8Array): { size: number; compSize: number; offset: number } | null {
  const dv = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
  let p = 0;
  while (p + 4 <= extra.length) {
    const id = dv.getUint16(p, true);
    const sz = dv.getUint16(p + 2, true);
    if (id === 0x0001) {
      let q = p + 4;
      let size = 0;
      let compSize = 0;
      let offset = 0;
      // 字段按顺序出现，但可能只出现后几个（前面那些本就没到 0xFFFFFFFF）
      if (sz >= 8) { size = dv.getUint32(q, true) + dv.getUint32(q + 4, true) * 2 ** 32; q += 8; }
      if (sz >= 16) { compSize = dv.getUint32(q, true) + dv.getUint32(q + 4, true) * 2 ** 32; q += 8; }
      if (sz >= 24) { offset = dv.getUint32(q, true) + dv.getUint32(q + 4, true) * 2 ** 32; }
      return { size, compSize, offset };
    }
    p += 4 + sz;
  }
  return null;
}

async function inflateRaw(raw: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("当前环境不支持 DecompressionStream，没法解压 deflate 条目");
  }
  const ds = new DecompressionStream("deflate-raw");
  // 复制一份再喂给 Blob：raw 是整块 zip 上的一个视图（有 offset），
  // 直接给 Blob 会把整个包都塞进去
  const body = new Uint8Array(raw);
  const out = await new Response(new Blob([body]).stream().pipeThrough(ds)).arrayBuffer();
  return new Uint8Array(out);
}

/* CRC32：中央目录里存的是它，用它验完整性 */
let table: Uint32Array | null = null;
function crc32(data: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    c = table[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

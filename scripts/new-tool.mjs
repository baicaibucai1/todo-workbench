#!/usr/bin/env node
/**
 * 新建一个内置工具：`npm run tool:new <id> [--name 名称] [--icon package]`
 *
 * ============================ 默认从哪份模板派生 ============================
 *
 * 默认拷 `tools/scratchpad`（模板工具）的界面当起点 —— 它是这个项目里
 * **唯一的正牌模板**：写工具的人照它抄，AI 助手代写工具时也以它为参考。
 * 想改模板，改的是 scratchpad 本身；这里只是把它的副本递出去。
 * （要一个空白但合规的最小骨架，加 `--blank`。）
 *
 * ============================ 为什么要有它 ============================
 *
 * 「加一个内置工具」在很长一段时间里是**七处手工同步**：
 *
 *   1. tools/<id>/                 目录 + manifest.json（唯一真源）
 *   2. src/lib/tools.ts            BUILTIN_TOOLS 里再手抄一遍 manifest
 *   3. tests/placeholder-tools.mjs 侧栏工具数（写死）
 *   4. tests/tool-browser.mjs      设置页工具数（写死）
 *   5. tests/tools-standalone.mjs  THEME_TOOLS（手写数组）
 *   6. README.md                   工具表
 *   7. （镜像工具）sync-tools.mjs  + 回灌外部源文件
 *
 * 漏掉任何一处**都不报错**，只是界面上有一半不对 —— 这类问题查起来最贵。
 * 这个脚本把 1~6 变成一次执行；第 7 项要人决定，脚本只负责提醒。
 *
 * ------------------------------------------------------------------
 * 那些写死的数字为什么保留
 * ------------------------------------------------------------------
 * `tool-browser.mjs` 里那句注释写得很清楚：写死是为了让「多出一个陌生工具」
 * 能被立刻发现，而不是悄无声息地出现在用户的侧边栏里。所以这里**不把它们
 * 改成从目录自动推导** —— 推导出来就永远相等，那道防盗门就没了。
 * 做法是：数字集中到 tests/tool-registry.mjs 一处（由本脚本维护），
 * 并由 `npm run tool:audit` 拿它与 tools/<id>/manifest.json 对账。
 *
 * 用法：
 *   node scripts/new-tool.mjs <id> [--name 名称] [--icon package] [--desc 说明]
 *                             [--version 0.1.0]
 *                             [--blank]       用最小骨架而不是 scratchpad 模板
 *                             [--from <id>]   从另一个已有工具派生
 *                             [--template]    打上样板标签（默认停用、挂"参考模板"徽章）
 *                             [--dry-run] [--no-patch]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const TOOLS = path.join(ROOT, "tools");
const SKELETON = path.join(__dirname, "tool-skeleton.html");

/* ------------------------------------------------------------------ */
/* 参数                                                                */
/* ------------------------------------------------------------------ */

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry-run");
const NO_PATCH = argv.includes("--no-patch");

function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
}

const id = argv.find((a) => !a.startsWith("--") && a !== "true");
const opts = {
  name: flag("name", null),
  icon: flag("icon", "package"),
  desc: flag("desc", null),
  version: flag("version", "0.1.0"),
  // 正牌模板是 scratchpad；--blank 才用最小骨架
  from: flag("from", argv.includes("--blank") ? null : "scratchpad"),
  template: argv.includes("--template"),
};

const TOOL_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;

/**
 * 建目录**之前**的工具数。
 *
 * README 那句「表里的 N 个」要以它为基准 —— 等目录建完再数就多算一个，
 * 而那个数字写错比不写更糟（它会让人以为表比实际长）。
 */
const totalBefore = fs
  .readdirSync(TOOLS, { withFileTypes: true })
  .filter((e) => e.isDirectory() && fs.existsSync(path.join(TOOLS, e.name, "manifest.json")))
  .length;

function die(msg) {
  console.error(`\n  [x] ${msg}\n`);
  process.exit(1);
}

if (!id) die("缺工具 id。用法：npm run tool:new <id> [--name 名称] [--icon package]");
if (!TOOL_ID_RE.test(id)) {
  die(`id「${id}」不合法：只能用小写字母、数字和连字符，以字母开头，长度 2-32`);
}
if (fs.existsSync(path.join(TOOLS, id))) die(`tools/${id}/ 已经存在了`);

/* ------------------------------------------------------------------ */
/* 图标白名单（与 src/lib/icons.ts 对齐，认不出来宿主会静默退回包裹图标）  */
/* ------------------------------------------------------------------ */

const ICONS = readIconWhitelist();
if (!ICONS.includes(opts.icon)) {
  die(`图标「${opts.icon}」不在白名单里。可选：${ICONS.join(" / ")}`);
}

function readIconWhitelist() {
  const src = fs.readFileSync(path.join(ROOT, "src/lib/icons.ts"), "utf8");
  const m = /export const ICONS[^=]*=\s*\{([\s\S]*?)\n\};/.exec(src);
  if (!m) return [];
  // 形如 `crop: Crop,` / `sticky-note: StickyNote,`
  return [...m[1].matchAll(/^\s{2}"?([a-z0-9-]+)"?\s*:/gm)].map((x) => x[1]);
}

/* ------------------------------------------------------------------ */
/* 生成工具目录                                                         */
/* ------------------------------------------------------------------ */

const name = opts.name ?? id;
const desc =
  opts.desc ??
  `TODO：一句话说清「${name}」是干什么的，以及它和旁边某个工具的区别（写成"它不是什么"最容易懂）`;

/**
 * 从已有工具派生一份界面。
 *
 * 换掉的是**写死在源码里的那几处** id（工具内部的 TOOL_ID、注释里提到的
 * 真实表名、<title>）。别做全文无差别替换：说明文字里出现"scratchpad"
 * 多半是在讲它的来历，整段换掉会把话改得不通。
 */
function deriveFrom(sourceId) {
  const srcDir = path.join(TOOLS, sourceId);
  if (!fs.existsSync(srcDir)) die(`--from ${sourceId}：tools/${sourceId}/ 不存在`);
  const srcManifest = JSON.parse(fs.readFileSync(path.join(srcDir, "manifest.json"), "utf8"));
  const srcHtml = fs.readFileSync(path.join(srcDir, srcManifest.entry || "index.html"), "utf8");
  const under = id.replace(/-/g, "_");
  const srcUnder = sourceId.replace(/-/g, "_");
  const html = srcHtml
    // 工具内部那个常量：独立运行时它是 localStorage 的键前缀
    .replace(/(var TOOL_ID\s*=\s*")[^"]*(")/, `$1${id}$2`)
    // 注释/文案里写明的真实表名 tool_scratchpad_notes
    .replaceAll(`tool_${srcUnder}_`, `tool_${under}_`)
    .replace(/<title>[^<]*<\/title>/, `<title>${name}</title>`);
  console.log(`  · 界面从 tools/${sourceId}/ 派生（TOOL_ID 与表名前缀已换成 ${id}）`);
  return { html, schema: srcManifest.schema };
}

let derived;
let html;
if (opts.from) {
  derived = deriveFrom(opts.from);
  html = derived.html;
} else {
  derived = { schema: undefined };
  html = fs
    .readFileSync(SKELETON, "utf8")
    .replaceAll("{{NAME}}", name)
    .replaceAll("{{ID}}", id)
    .replaceAll("{{IDUNDER}}", id.replace(/-/g, "_"));
}

const manifest = {
  id,
  name,
  version: opts.version,
  description: desc,
  icon: opts.icon,
  entry: "index.html",
  dbVersion: 1,
  author: "内置",
  ...(opts.template ? { tags: ["template"] } : {}),
  // 从模板派生时连 schema 一起带过来（scratchpad 的那张 notes 表）。
  // 需要改表结构时记住：以后**加列**只能靠 dbVersion +1 + 用户在
  // 「设置 → 数据库」里清理数据（见 docs/tool-authoring-and-injection.md §十一）
  ...(derived.schema ? { schema: derived.schema } : {}),
};

const dir = path.join(TOOLS, id);
const changes = [];

function write(rel, content) {
  const abs = path.join(ROOT, rel);
  if (DRY) {
    changes.push(`新建 ${rel}（${content.length} 字节）`);
    return;
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  changes.push(`新建 ${rel}`);
}

write(`tools/${id}/index.html`, html);
write(`tools/${id}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);

/* ------------------------------------------------------------------ */
/* 同步登记点                                                          */
/* ------------------------------------------------------------------ */

/** 读文件 → 改 → 写（找不到锚点时记一笔"需手工"，绝不静默跳过） */
function patch(rel, fn) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return changes.push(`✗ ${rel}：文件不存在，需手工处理`);
  const src = fs.readFileSync(abs, "utf8");
  const out = fn(src);
  if (out === src) return changes.push(`✗ ${rel}：没找到锚点，需手工处理`);
  if (!DRY) fs.writeFileSync(abs, out);
  return changes.push(`改 ${rel}`);
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function countTools() {
  return fs
    .readdirSync(TOOLS, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(TOOLS, e.name, "manifest.json")))
    .length;
}


/** README 表头写着「表里的六个」这种中文数字，加减工具时得跟着改 */
const CN = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
function cnToNum(s) {
  if (s === "十") return 10;
  const i = CN.indexOf(s);
  return i > 0 ? i : 0;
}
function numToCn(n) {
  if (n <= 10) return CN[n];
  if (n < 20) return `十${CN[n - 10]}`;
  return String(n);
}

const TODO_LINE = opts.template
  ? `    // 它是给写工具的人照着抄的样板，不是给用户日常用的功能（打上 template 标签后设置页会挂一枚徽章，默认停用它另见 settings.ts 的 DEFAULT_SETTINGS）`
  : `    // TODO：一句话说清这个工具是干什么的、以及它与旁边某个工具的区别`;

/**
 * 把一个 schema 对象写成 tools.ts 里那种排版。
 *
 * 手写漂亮没意义，但它会被人读 —— 所以标量数组压成一行，对象一律展开。
 */
/** 单行写法：能塞进 88 列就用它，跟现有代码里 `indexes: [...]` 那种一行一致 */
function toInline(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(toInline).join(", ")}]`;
  return `{ ${Object.keys(v).map((k) => `${k}: ${toInline(v[k])}`).join(", ")} }`;
}

function toTs(v, indent = 0) {
  const pad = " ".repeat(indent);
  const inline = toInline(v);
  if (inline.length + indent <= 88) return inline;
  if (Array.isArray(v)) {
    const inner = v.map((x) => `${pad}  ${toTs(x, indent + 2)}`).join(",\n");
    return `[\n${inner},\n${pad}]`;
  }
  const inner = Object.keys(v)
    .map((k) => `${pad}  ${k}: ${toTs(v[k], indent + 2)}`)
    .join(",\n");
  return `{\n${inner},\n${pad}}`;
}

if (!NO_PATCH) {
  /* 1. src/lib/tools.ts —— BUILTIN_TOOLS */
  patch("src/lib/tools.ts", (src) => {
    const open = "const BUILTIN_TOOLS: ToolManifest[] = [";
    const at = src.indexOf(open);
    if (at < 0) return src;
    // 数组的收尾是顶格的 `];`，从 open 之后找第一个
    const close = src.indexOf("\n];", at);
    if (close < 0) return src;
    const entry = [
      "  {",
      TODO_LINE,
      `    id: "${id}",`,
      `    name: ${JSON.stringify(name)},`,
      `    version: "${opts.version}",`,
      `    description:`,
      `      ${JSON.stringify(desc)},`,
      `    icon: "${opts.icon}",`,
      `    entry: "index.html",`,
      `    dbVersion: 1,`,
      `    author: "内置",`,
      ...(opts.template ? [`    tags: ["template"],`] : []),
      ...(derived.schema ? [`    schema: ${toTs(derived.schema, 4)},`] : []),
      "  },",
    ].join("\n");
    // close 指向 "\n];" 的换行处，插在它前面
    return `${src.slice(0, close)}\n${entry}${src.slice(close)}`;
  });

  /* 2. tests/tool-registry.mjs —— 三个写死清单的唯一出处 */
  patch("tests/tool-registry.mjs", (src) => {
    let out = src;
    // ALL_TOOL_IDS
    out = out.replace(
      /(export const ALL_TOOL_IDS = \[)([\s\S]*?)(\n\];)/,
      (_, a, body, c) => `${a}${body.replace(/\s+$/, "")}\n  "${id}",${c}`,
    );
    // ENABLED_TOOL_IDS：模板类工具默认停用，不进这一档
    if (!opts.template) {
      out = out.replace(
        /(export const ENABLED_TOOL_IDS = \[)([\s\S]*?)(\n\];)/,
        (_, a, body, c) => `${a}${body.replace(/\s+$/, "")}\n  "${id}",${c}`,
      );
    }
    // THEME_TOOLS：[id, 短名]
    out = out.replace(
      /(export const THEME_TOOLS[^=]*= \[)([\s\S]*?)(\n\];)/,
      (_, a, body, c) => `${a}${body.replace(/\s+$/, "")}\n  ["${id}", ${JSON.stringify(name)}],${c}`,
    );
    return out;
  });

  /* 3. README.md —— 工具表 + 表头那句数量 */
  patch("README.md", (src) => {
    const head = "| 工具 | 版本 | 做什么 |";
    const at = src.indexOf(head);
    if (at < 0) return src;
    // 换行符跟着文件走：README 在工作区里是 CRLF（core.autocrlf），
    // 插一行 LF 进去会让那一行的 diff 平白多一个字节
    const nl = src.includes("\r\n") ? "\r\n" : "\n";
    const lines = src.slice(at).split("\n");
    // end 必须先把表头那一行算进去 —— 漏了它，插入点会整体前移一行，
    // 新行就插进上一行的中间去了
    let end = at + lines[0].length + 1;
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].startsWith("|")) break;
      end += lines[i].length + 1;
    }
    const row = `| ${name} | ${opts.version} | ${desc} |`;
    const withRow = `${src.slice(0, end)}${row}${nl}${src.slice(end)}`;
    // 表头上方那句「表里的 N 个」。
    // 用**建目录之前**的数 +1：write() 已经把新目录落盘了，
    // 这里再数一次会多算一个（也顺手对一下旧数字对不对，不对说明早就在漂）
    return withRow.replace(/表里的([一二三四五六七八九十]+)个/, (whole, cn) => {
      const n = cnToNum(cn);
      const next = totalBefore + 1;
      if (n && n !== totalBefore) {
        changes.push(`✗ README 里写的是「${cn}」个，而 tools/ 下当时有 ${totalBefore} 个 —— 早就在漂了`);
      }
      return `表里的${numToCn(next)}个`;
    });
  });
}

/* ------------------------------------------------------------------ */
/* 收尾                                                                */
/* ------------------------------------------------------------------ */


console.log(`\n  ${DRY ? "[预演] " : ""}新建内置工具 ${id}（${name}）\n`);
for (const c of changes) console.log(`    ${c}`);

console.log(`
  接下来要人做的：
    1. 打开 tools/${id}/index.html 把 TODO 那一句换成真说明
    2. 跑 \`npm run tool:audit\` 确认七处登记点都对齐了
    3. 需要换图标 / 加表的话，改 manifest.json 后**再跑一次** tool:audit
       （BUILTIN_TOOLS 是手抄的，两边漂移它才抓得到）
${opts.template ? `    4. 它是样板工具：去 src/lib/settings.ts 的 DEFAULT_SETTINGS 把它加进默认停用清单\n` : `    4. 想给它拍一张 README 截图：scripts/gen-readme-shots.mjs\n`}
  如果这个工具是从别处镜像来的（源文件在仓库外），还要：
    · 在 scripts/sync-tools.mjs 的 SOURCES 里登记
    · 改完 tools/${id}/index.html 后**回灌**源文件，否则 tools:sync 会把改动冲掉
`);

if (DRY) console.log("  （--dry-run：没有写任何文件）\n");

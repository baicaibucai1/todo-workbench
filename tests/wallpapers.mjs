/**
 * 壁纸资源校验。
 *
 * 为什么值得单独一条门禁：壁纸是**随包发布的静态资源**，
 * 而且它是被 Vite 从 public/ 搬进 dist/、再由 Tauri 把整个 dist 嵌进 exe 的。
 * 这条链路上任何一步断了都不会报错 —— 只会表现为"设置界面的壁纸格子是空的"，
 * 而这在使用打包好的应用时根本没法当场查。
 *
 * 所以这里逐层验：
 *   1. 源资源（public/wallpapers）：清单合法、图片是真 JPEG、体积合理
 *   2. 构建产物（dist/wallpapers，存在时）：与源一致，没少文件
 *   3. 已打包的 exe（存在时）：资源键真的嵌进去了
 *
 * 第 3 条只有在 exe 比 dist 新时才有意义（否则是旧产物），
 * 那种情况下会明确说"跳过"，而不是假装通过。
 *
 * 用法：node tests/wallpapers.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "public", "wallpapers");
const DIST = path.join(ROOT, "dist", "wallpapers");

let passed = 0;
let failed = 0;
const failures = [];

function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function info(label, v) {
  console.log(`    · ${label}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
}
function skip(name, why) {
  console.log(`  SKIP  ${name} — ${why}`);
}

/** JPEG 以 FF D8 FF 开头、FF D9 结尾 */
function isJpeg(buf) {
  return (
    buf.length > 4 &&
    buf[0] === 0xff &&
    buf[1] === 0xd8 &&
    buf[2] === 0xff &&
    buf[buf.length - 2] === 0xff &&
    buf[buf.length - 1] === 0xd9
  );
}

/** 从 JPEG 的 SOF 段读出真实宽高 —— 不信清单里写的，读文件本身 */
function jpegSize(buf) {
  let i = 2;
  while (i < buf.length - 9) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    // SOF0/1/2/3、SOF5..7、SOF9..11、SOF13..15 都带尺寸
    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isSof) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    const len = buf.readUInt16BE(i + 2);
    i += 2 + len;
  }
  return null;
}

console.log("\n1. 源资源 public/wallpapers");
if (!fs.existsSync(SRC)) {
  check("public/wallpapers 目录存在", false, "目录不存在，需要跑 node scripts/fetch-wallpapers.mjs");
} else {
  const manifestPath = path.join(SRC, "index.json");
  check("清单 index.json 存在", fs.existsSync(manifestPath));

  let manifest = null;
  if (fs.existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch (e) {
      check("清单是合法 JSON", false, String(e.message));
    }
  }

  if (manifest) {
    check("清单是合法 JSON", true);
    const items = Array.isArray(manifest.items) ? manifest.items : [];
    info("清单条目", `${items.length} 张`);
    info("抓取时间", manifest.fetchedAt ?? "(未记录)");
    check("清单里有图片", items.length > 0, `${items.length} 张`);
    check("清单记录了来源", typeof manifest.source === "string" && manifest.source.length > 0);

    const dates = new Set();
    const files = new Set();
    for (const it of items) {
      check(`条目 ${it.file} 有文件名`, typeof it.file === "string" && it.file.length > 0);
      check(`条目 ${it.file} 记录了日期`, /^\d{8}$/.test(it.date ?? ""), String(it.date));
      dates.add(it.date);
      files.add(it.file);

      const p = path.join(SRC, it.file);
      if (!fs.existsSync(p)) {
        check(`${it.file} 文件存在`, false, "清单里有、磁盘上没有");
        continue;
      }
      const buf = fs.readFileSync(p);
      const kb = buf.length / 1024;
      check(`${it.file} 是真 JPEG`, isJpeg(buf), `前 3 字节 ${[...buf.slice(0, 3)].join(",")}`);
      // 太小说明下到的是必应对失效 id 返回的占位图
      check(`${it.file} 体积合理（> 20 KB）`, kb > 20, `${kb.toFixed(0)} KB`);

      const size = jpegSize(buf);
      if (size) {
        check(`${it.file} 是横向大图（够铺满）`,
          size.w >= 1280 && size.h >= 720 && size.w > size.h,
          `${size.w}x${size.h}`);
      } else {
        check(`${it.file} 能读出尺寸`, false, "没找到 SOF 段");
      }
    }

    check("日期不重复", dates.size === items.length, `${dates.size} / ${items.length}`);
    check("文件名不重复", files.size === items.length, `${files.size} / ${items.length}`);

    // 文件名必须等于日期，抓取脚本就是这么定的；对不上说明手工改过或清单过期
    check("文件名与日期一致",
      items.every((it) => it.file === `${it.date}.jpg`),
      items.filter((it) => it.file !== `${it.date}.jpg`).map((it) => it.file).join(", "));

    const totalBytes = items.reduce(
      (n, it) => n + (fs.existsSync(path.join(SRC, it.file)) ? fs.statSync(path.join(SRC, it.file)).size : 0),
      0,
    );
    info("合计体积", `${(totalBytes / 1048576).toFixed(1)} MB`);
    // 壁纸会整体嵌进 exe，失控的体积会直接变成安装包大小
    check("合计体积在预算内（< 12 MB）", totalBytes < 12 * 1048576,
      `${(totalBytes / 1048576).toFixed(1)} MB`);

    const orphans = fs
      .readdirSync(SRC)
      .filter((n) => n !== "index.json" && !files.has(n));
    check("目录里没有清单之外的多余图片", orphans.length === 0, orphans.join(", "));

    console.log("\n2. 构建产物 dist/wallpapers");
    if (!fs.existsSync(DIST)) {
      skip("dist 与源一致", "还没构建过（dist/wallpapers 不存在）");
    } else {
      const missing = items.filter((it) => !fs.existsSync(path.join(DIST, it.file)));
      check("清单里的图都进了 dist", missing.length === 0, missing.map((m) => m.file).join(", "));
      check("dist 里有清单 index.json", fs.existsSync(path.join(DIST, "index.json")));

      // 体积一致 = 是同一份文件，而不是某次构建的残留
      const mismatch = items.filter((it) => {
        const a = path.join(SRC, it.file);
        const b = path.join(DIST, it.file);
        if (!fs.existsSync(a) || !fs.existsSync(b)) return true;
        return fs.statSync(a).size !== fs.statSync(b).size;
      });
      check("dist 里的图与源逐字节同源（体积一致）", mismatch.length === 0,
        mismatch.map((m) => m.file).join(", "));
    }

    console.log("\n3. 已打包的 exe");
    const exe = path.join(
      ROOT,
      "src-tauri",
      "target",
      "x86_64-pc-windows-gnu",
      "release",
      "todo-workbench.exe",
    );
    if (!fs.existsSync(exe)) {
      skip("exe 里嵌了壁纸资源", "还没打包过");
    } else {
      const distIdx = path.join(ROOT, "dist", "index.html");
      const fresh =
        fs.existsSync(distIdx) && fs.statSync(exe).mtimeMs >= fs.statSync(distIdx).mtimeMs;
      if (!fresh) {
        skip("exe 里嵌了壁纸资源", "exe 比 dist 旧，是上一次打包的产物，重打一次才有意义");
      } else {
        // Tauri 把整个 dist 嵌进 exe；资源键是明文存的，图片本体是压缩的，
        // 所以只能验"键在不在" —— 但这就足够证明文件被收进去了
        const buf = fs.readFileSync(exe);
        // 一个资源键都没有 = 这个 exe 根本没嵌 dist，通常不是"壁纸丢了"，
        // 而是某次被打断的构建留下的半成品（或绕开 build-desktop.mjs
        // 直接跑了 cargo / tauri build）。把成因写进失败信息里，
        // 免得下次照着"壁纸"去查一个跟壁纸无关的问题。
        if (
          buf.indexOf(Buffer.from("wallpapers/", "utf8")) === -1 &&
          buf.indexOf(Buffer.from("tools/", "utf8")) === -1
        ) {
          info(
            "提示",
            "exe 里一个随包资源键都没有 —— 多半是中断的构建留下的产物，完整打包一次再看",
          );
        }
        const absent = items.filter(
          (it) => buf.indexOf(Buffer.from(`wallpapers/${it.file}`, "utf8")) === -1,
        );
        check("exe 里嵌了全部壁纸资源键", absent.length === 0,
          absent.map((a) => a.file).join(", "));
        check("exe 里嵌了壁纸清单键",
          buf.indexOf(Buffer.from("wallpapers/index.json", "utf8")) !== -1);
        info("exe", `${(buf.length / 1048576).toFixed(1)} MB`);
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* 4. 打包脚本必须把 public/ 算进「源码变新」                            */
/* ------------------------------------------------------------------ */
/**
 * 这一节盯的是**打包脚本自身的判据**，不碰图片。
 *
 * 踩过一次：`build-desktop.mjs` 的 `distIsStale()` 只遍历 `src` 和 `tools`，
 * 而且只看 `.ts/.css/.html/.json`。往 `public/wallpapers/` 加一批新图后，
 * 它判定"源码没变"→ **复用旧 dist** → 新壁纸进不了安装包，
 * 而打包流程和上面 1~3 节看起来都是正常往下走的，只有第 2/3 节会红。
 *
 * 也就是说：前面三节能抓到症状，但抓不到病因。病因得单独钉住，
 * 否则有人改回 `['src', 'tools']` 时，只会在"下次加壁纸"时才暴露。
 */
{
  const script = path.join(ROOT, "scripts", "build-desktop.mjs");
  const src = fs.existsSync(script) ? fs.readFileSync(script, "utf8") : "";

  // 只看 distIsStale 这个函数体，别被文件里别处的 'public' 字样骗过去
  const start = src.indexOf("function distIsStale(");
  const body = start >= 0 ? src.slice(start, start + 1600) : "";

  check("打包脚本可读", !!src);
  check("能定位到 distIsStale 函数", start >= 0);
  check(
    "distIsStale 会把 public/ 算进源码目录",
    /['"]public['"]/.test(body),
    "漏了 public/ 就等于漏掉整个静态资源目录",
  );
  check(
    "distIsStale 会看图片扩展名",
    /jpg|jpeg|png|svg|webp/.test(body),
    "只认 .ts/.css 的话，新加的壁纸不会被判定为改动",
  );
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed) {
  console.log("失败项：");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failed ? 1 : 0);

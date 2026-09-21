/**
 * 从必应每日壁纸抓一批图片，落到 public/wallpapers/。
 *
 * 为什么是「抓下来随包发布」而不是运行时联网拉：
 *   工作台是离线优先的本机应用，且必须能打包成桌面安装包。
 *   依赖运行时联网的话，"换背景"在断网时就变成一排加载不出来的灰格子。
 *   所以这里只负责**取一次**，之后图片就是工程里的静态资源。
 *
 * 用法：
 *   node scripts/fetch-wallpapers.mjs                # 抓 6 张（已存在的跳过）
 *   node scripts/fetch-wallpapers.mjs --n 8          # 抓 8 张
 *   node scripts/fetch-wallpapers.mjs --force        # 重新下载
 *   node scripts/fetch-wallpapers.mjs --mkt en-US    # 换个市场（图片不一样）
 *
 * 产物：
 *   public/wallpapers/<起始日期>.jpg
 *   public/wallpapers/index.json   清单（界面按它渲染，标题/版权也来自它）
 */

import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "public", "wallpapers");

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const COUNT = Math.max(1, Math.min(8, Number(flag("--n", "6")) || 6));
const MKT = flag("--mkt", "zh-CN");
const FORCE = argv.includes("--force");

/** 必应只对带 `_1920x1080.jpg` 后缀的 id 出图，`&w=`/`&h=` 参数会被 404（实测过） */
const RES = "1920x1080";

const UA = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
};

function get(url, asBuffer = false) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: UA }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} ${url}`));
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          resolve(asBuffer ? buf : buf.toString("utf8"));
        });
      })
      .on("error", reject);
  });
}

console.log(`必应壁纸抓取 · 市场 ${MKT} · 目标 ${COUNT} 张 · 分辨率 ${RES}\n`);

const feed = JSON.parse(
  await get(
    `https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=${COUNT}&mkt=${MKT}`,
  ),
);
const images = feed.images ?? [];
if (!images.length) {
  console.error("必应没有返回任何图片，稍后重试（偶发）。");
  process.exit(1);
}
console.log(`接口返回 ${images.length} 张`);

fs.mkdirSync(OUT_DIR, { recursive: true });

const items = [];
let downloaded = 0;
let skipped = 0;

for (const img of images) {
  const date = img.startdate ?? "unknown";
  const file = `${date}.jpg`;
  const dest = path.join(OUT_DIR, file);
  const url = `https://www.bing.com${img.urlbase}_${RES}.jpg`;
  const meta = {
    file,
    date,
    // mkt 也要记下来：换市场抓的两批图会混在同一个目录里，靠它区分来源
    mkt: MKT,
    title: (img.title ?? "").trim(),
    copyright: (img.copyright ?? "").trim(),
    url,
  };

  if (!FORCE && fs.existsSync(dest) && fs.statSync(dest).size > 1024) {
    skipped++;
    items.push(meta);
    console.log(`  跳过  ${file}（已存在 ${Math.round(fs.statSync(dest).size / 1024)} KB）`);
    continue;
  }

  try {
    const buf = await get(url, true);
    // 必应对失效 id 会返回一张很小的占位图，靠体积挡掉
    if (buf.length < 20 * 1024) throw new Error(`返回体积异常 ${buf.length} 字节`);
    fs.writeFileSync(dest, buf);
    downloaded++;
    items.push(meta);
    console.log(
      `  下载  ${file}  ${(buf.length / 1024).toFixed(0)} KB  ${meta.title || "(无标题)"}`,
    );
  } catch (err) {
    console.log(`  失败  ${file}  ${err instanceof Error ? err.message : err}`);
  }
}

if (!items.length) {
  console.error("\n一张都没拿到，检查网络后重试。");
  process.exit(1);
}

// 按日期倒序：界面里最新的排最前，符合"最近换了什么壁纸"的直觉
items.sort((a, b) => b.date.localeCompare(a.date));

const manifest = {
  source: "Bing 每日壁纸（HPImageArchive）",
  fetchedAt: new Date().toISOString(),
  resolution: RES,
  items,
};
fs.writeFileSync(
  path.join(OUT_DIR, "index.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);

const total = items.reduce((n, it) => {
  const p = path.join(OUT_DIR, it.file);
  return n + (fs.existsSync(p) ? fs.statSync(p).size : 0);
}, 0);

console.log(
  `\n完成：新下载 ${downloaded} 张，跳过 ${skipped} 张，清单共 ${items.length} 张 ` +
    `（合计 ${(total / 1024 / 1024).toFixed(1)} MB）`,
);
console.log(`位置：${path.relative(ROOT, OUT_DIR)}`);

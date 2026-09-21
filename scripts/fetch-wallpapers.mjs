/**
 * 从必应每日壁纸抓一批图片，落到 public/wallpapers/。
 *
 * 为什么是「抓下来随包发布」而不是运行时联网拉：
 *   工作台是离线优先的本机应用，且必须能打包成桌面安装包。
 *   依赖运行时联网的话，"换背景"在断网时就变成一排加载不出来的灰格子。
 *   所以这里只负责**取一次**，之后图片就是工程里的静态资源。
 *
 * 用法：
 *   node scripts/fetch-wallpapers.mjs                # 抓最近 2 页（约 16 天，已存在的跳过）
 *   node scripts/fetch-wallpapers.mjs --pages 1      # 只抓最近 8 天
 *   node scripts/fetch-wallpapers.mjs --pages 4      # 往回翻 4 页（约 32 天）
 *   node scripts/fetch-wallpapers.mjs --force        # 重新下载（已存在的也重抓）
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
const MANIFEST = path.join(OUT_DIR, "index.json");

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};

/** 必应这个接口一次最多给 8 天，再多要用 idx 往回翻页 */
const PER_PAGE = 8;
const PAGES = Math.max(1, Math.min(8, Number(flag("--pages", "2")) || 2));
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

/**
 * 读已有清单。
 *
 * **必须与旧清单合并**，不能整份重写 —— 重写会把"这次没抓到、但目录里还在"的
 * 老图变成孤儿，而 `tests/wallpapers.mjs` 有一条「目录里没有清单之外的多余图片」，
 * 一重写就红。最早那版脚本就是整份重写，只能"抓一批覆盖一批"，攒不起来。
 */
function readExisting() {
  try {
    const data = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
    return Array.isArray(data?.items) ? data.items : [];
  } catch {
    return [];
  }
}

console.log(
  `必应壁纸抓取 · 市场 ${MKT} · ${PAGES} 页 × ${PER_PAGE} 天 · 分辨率 ${RES}\n`,
);

fs.mkdirSync(OUT_DIR, { recursive: true });

// date -> 条目。旧清单先铺底，抓到的覆盖同日期的旧记录（补上更完整的版权信息等）
const byDate = new Map();
for (const it of readExisting()) {
  if (it && typeof it.date === "string") byDate.set(it.date, it);
}
const before = byDate.size;

let downloaded = 0;
let skipped = 0;
let failed = 0;

for (let page = 0; page < PAGES; page++) {
  const idx = page * PER_PAGE;
  const feedUrl = `https://www.bing.com/HPImageArchive.aspx?format=js&idx=${idx}&n=${PER_PAGE}&mkt=${MKT}`;

  let images = [];
  try {
    images = JSON.parse(await get(feedUrl)).images ?? [];
  } catch (err) {
    console.log(`  第 ${page + 1} 页（idx=${idx}）取不到：${err.message}`);
    failed++;
    continue;
  }
  if (!images.length) {
    console.log(`  第 ${page + 1} 页（idx=${idx}）返回 0 张`);
    continue;
  }
  console.log(`第 ${page + 1} 页（idx=${idx}）返回 ${images.length} 张`);

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
      byDate.set(date, { ...byDate.get(date), ...meta });
      console.log(`  跳过  ${file}（已存在 ${Math.round(fs.statSync(dest).size / 1024)} KB）`);
      continue;
    }

    try {
      const buf = await get(url, true);
      // 必应对失效 id 会返回一张很小的占位图，靠体积挡掉
      if (buf.length < 20 * 1024) throw new Error(`返回体积异常 ${buf.length} 字节`);
      fs.writeFileSync(dest, buf);
      downloaded++;
      byDate.set(date, meta);
      console.log(
        `  下载  ${file}  ${(buf.length / 1024).toFixed(0)} KB  ${meta.title || "(无标题)"}`,
      );
    } catch (err) {
      failed++;
      console.log(`  失败  ${file}  ${err instanceof Error ? err.message : err}`);
    }
  }
}

const items = [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));
if (!items.length) {
  console.error("\n一张都没拿到，检查网络后重试。");
  process.exit(1);
}

// 清单里只留**文件确实在**的条目：抓失败或图被删了，界面上就不该出现空格子
const onDisk = items.filter((it) => {
  const p = path.join(OUT_DIR, it.file);
  return fs.existsSync(p) && fs.statSync(p).size > 1024;
});
const dropped = items.length - onDisk.length;

const manifest = {
  source: "Bing 每日壁纸（HPImageArchive）",
  fetchedAt: new Date().toISOString(),
  resolution: RES,
  items: onDisk,
};
fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

const total = onDisk.reduce((n, it) => {
  const p = path.join(OUT_DIR, it.file);
  return n + (fs.existsSync(p) ? fs.statSync(p).size : 0);
}, 0);

console.log(
  `\n完成：新下载 ${downloaded} 张，跳过 ${skipped} 张，失败 ${failed} 张`,
);
console.log(
  `清单：原有 ${before} 条 → 现有 ${onDisk.length} 条` +
    (dropped ? `（剔掉 ${dropped} 条文件不在的）` : ""),
);
console.log(`合计 ${(total / 1024 / 1024).toFixed(1)} MB`);
console.log(`位置：${path.relative(ROOT, OUT_DIR)}`);

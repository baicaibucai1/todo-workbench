/**
 * Little Star —— 确定性守恒检查（静态复算）
 * =====================================================================
 * 为什么需要它：主 RNG 是单条流，贴图生成会消耗掉几百次抽样，之后才轮到
 * 「星系名 → 星型 → 行星」。所以【动贴图函数的数量/顺序、或增删任何抽 rng()
 * 的对象，都会让全序列整体错位】——星系名从「薄曙」变掉、行星布局全变。
 * 本脚本把抽样序列复刻一遍，求出「星型」那一次抽到的原始值 f，再用 src/
 * 里【当前真实】的 STAR_TYPES 权重算一遍命中结果，最后与浏览器实测值对照。
 *
 * 三层校验（缺一不可）：
 *   ① 本脚本静态复算：f = 0.374455，且用真实权重命中 M
 *   ② 源码里的计数锚点：抽到星型时主 RNG 已抽 884 次
 *      （rngDraws，见 src/10-core.js「基础工具」段的包装函数）
 *   ③ verify.mjs 在真浏览器里断言 ①② 的实测值一致
 *   ①② 对不上 → 说明贴图段多抽/少抽了，本脚本的【复刻段】需要同步更新；
 *   ①③ 对不上 → 说明权重表或数组顺序被改了，需要重新校准。
 *
 * ★ 复刻段是手工维护的。改动 src/40-textures.js 里任何贴图函数后，回来更新
 *   下面标了「复刻」的循环次数。
 *
 * ★ 源码读的是 src/ 片段的拼装结果（不是 game.js）：本脚本校验的是**源**；
 *   game.js 有没有跟着重新拼装，由 build.mjs --check / verify.mjs [0] 负责。
 *
 * 用法：node scripts/roll-check.mjs      （全部通过退出码 0，否则 1）
 */
import { readSources } from "./build.mjs";

/* 拼装（不含导航表 —— 本脚本解析的是数据，与区块行号无关） */
const SRC = readSources().map((p) => p.text).join("");

/* 期望值：任何一项变化都必须是有意为之，改完同步更新这里 */
const EXPECT = {
  drawsAtStarPick: 884,    // 抽到星型时（含该次）主 RNG 的累计抽数
  nameIdx: 47,             // 星系名索引
  name: "薄曙",
  roll: 0.374455,          // 星型原始抽值
  starId: "M"              // 该抽值应当命中的星型
};

const fails = [];
const ok = (cond, label, detail) => {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${detail ? "  —— " + detail : ""}`);
  if (!cond) fails.push(label);
};

/* ---- 从 game.js 解析真实数据（不抄写，避免与源码脱节） ---- */
function parseNames(src) {
  const m = /var NAME_SYLL = \[([\s\S]*?)\];/.exec(src);
  if (!m) throw new Error("未能从 src/ 解析出 NAME_SYLL");
  return (m[1].match(/"([^"]*)"/g) || []).map((s) => s.slice(1, -1));
}
function parseStarTypes(src) {
  const m = /var STAR_TYPES = \[([\s\S]*?)\n\];/.exec(src);
  if (!m) throw new Error("未能从 src/ 解析出 STAR_TYPES");
  return m[1]
    .split(/\n(?=\s*\{ id: ")/)
    .map((chunk) => {
      const id = /id:\s*"([A-Z]+)"/.exec(chunk);
      const w = /(?:^|[\s,])w:\s*([\d.]+)/.exec(chunk);
      const name = /name:\s*"([^"]+)"/.exec(chunk);
      return id && w ? { id: id[1], w: +w[1], name: name ? name[1] : "" } : null;
    })
    .filter(Boolean);
}
function parseSeed(src) {
  const m = /var _rngCore = mulberry32\((\d+)\)/.exec(src);
  if (!m) throw new Error("未能从 src/ 解析出主 RNG 种子（改过包装函数？）");
  return +m[1];
}

const NAMES = parseNames(SRC);
const STARS = parseStarTypes(SRC);
const SEED = parseSeed(SRC);

/* ---- 复刻主 RNG 抽样序列 ---- */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(SEED);
let count = 0;
const draw = () => { count++; return rng(); };
const rand = (a, b) => a + draw() * (b - a);

console.log("Little Star —— 确定性守恒检查");
console.log("════════════════════════════════════════════════════════════");
console.log(`主 RNG 种子 ${SEED}（从 src/ 解析）· 星型库 ${STARS.length} 种\n`);

console.log("[1] 复刻贴图段抽样（src/40-textures.js 里 buildTextures 的调用顺序）");
/* 复刻：starSurfaceTex —— 90×5 + 40×4 = 610 */
for (let i = 0; i < 90; i++) { rand(0.1, 0.4); draw(); rand(0, 256); rand(0, 128); rand(6, 22); }
for (let j = 0; j < 40; j++) { rand(0.08, 0.25); rand(0, 256); rand(0, 128); rand(3, 9); }
/* 复刻：ghostTex / bracketTex / selRingTex / photonTex —— 0 次（零随机绘制） */
/* 复刻：cloudTex —— 46×4 = 184 */
for (let c = 0; c < 46; c++) { rand(0.05, 0.16); rand(0, 256); rand(0, 128); rand(5, 15); }
/* 复刻：ringBandTex —— while (r < 62) r += rand(2.5, 6)，每轮 3 抽 + 25% 概率 1 抽 */
let r = 20;
while (r < 62) {
  rand(0.15, 0.6); rand(1.5, 4.5);
  if (draw() < 0.25) rand(1, 3);
  r += rand(2.5, 6);
}
/* 复刻：nebulaTex —— 9×5 = 45 */
for (let n = 0; n < 9; n++) { rand(60, 196); rand(60, 196); rand(40, 100); rand(0.05, 0.12); rand(0.02, 0.05); }
const textureDraws = count;
console.log(`  贴图段共 ${textureDraws} 抽`);

console.log("\n[2] 星系名 → 星型");
const nameDraw = draw();
const starDraw = draw();
const nameIdx = Math.floor(nameDraw * NAMES.length);
const drawsAtStarPick = count;
console.log(`  星系名抽值 ${nameDraw.toFixed(6)} → 索引 ${nameIdx}（「${NAMES[nameIdx]}」）`);
console.log(`  星型原始抽值 f = ${starDraw.toFixed(6)}`);
console.log(`  抽到星型时累计 ${drawsAtStarPick} 抽（贴图 ${textureDraws} + 名 1 + 星型 1）`);

console.log("\n[3] 对账");
ok(drawsAtStarPick === EXPECT.drawsAtStarPick, "累计抽数与锚点一致",
  `${drawsAtStarPick} / 期望 ${EXPECT.drawsAtStarPick}`);
ok(nameIdx === EXPECT.nameIdx && NAMES[nameIdx] === EXPECT.name, "星系名仍是「薄曙」",
  `索引 ${nameIdx} → ${NAMES[nameIdx]}`);
ok(Math.abs(starDraw - EXPECT.roll) < 5e-7, "星型抽值与锚点一致",
  `${starDraw.toFixed(6)} / 期望 ${EXPECT.roll}`);
ok(STARS.length === 15, "星型库 15 种", `${STARS.length} 种`);

/* 用 src/ 里的真实权重跑一遍 weightedPick（与 src/10-core.js 同算法） */
const total = STARS.reduce((s, t) => s + t.w, 0);
let rem = starDraw * total;
let hit = STARS[STARS.length - 1];
for (const t of STARS) { rem -= t.w; if (rem <= 0) { hit = t; break; } }
ok(hit.id === EXPECT.starId, "该抽值命中 M（红矮星）",
  `命中 ${hit.id}「${hit.name}」· 权重合计 ${total.toFixed(2)}`);

console.log("\n════════════════════════════════════════════════════════════");
if (fails.length) {
  console.error(`✗ ${fails.length} 项不一致 —— 确定性序列已经漂移，见文件头「三层校验」判断改哪里。`);
  process.exit(1);
}
console.log("✓ 静态复算全部通过。浏览器实测值由 verify.mjs 断言（getState().rngDraws / starRoll）。");

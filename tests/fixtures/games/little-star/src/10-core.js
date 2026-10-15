/* ================= 基础工具 ================= */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/* 主随机流 + 抽数计数器。
 * 计数器是「确定性守恒」的锚点：贴图 / 世界生成每抽一次就 +1，所以只要
 * 抽到星型时的累计抽数不变，就证明此前没有任何东西多抽或少抽。
 * scripts/roll-check.mjs 静态复算出同一个数，verify.mjs 断言浏览器里的实测值
 * —— 两边对不上就说明有贴图函数增删了 rng 调用，必须重新校准星型权重。 */
var _rngCore = mulberry32(20261014);
var rngDraws = 0;
function rng() { rngDraws++; return _rngCore(); }
function rand(a, b) { return a + rng() * (b - a); }
/* 恒星专章独立随机流（种子与主流行不同）：新增视觉随机一律走这里，
 * 不动主序列，保证星系名 / 行星布局 / 小行星带逐一稳定 */
var srng = mulberry32(777001);
function srand(a, b) { return a + srng() * (b - a); }
function irand(a, b) { return Math.floor(rand(a, b + 1)); }
function pick(arr) { return arr[Math.floor(rng() * arr.length)]; }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function roman(n) {
  var m = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];
  return m[n - 1] || String(n);
}
function weightedPick(list) {
  var total = 0, i;
  for (i = 0; i < list.length; i++) total += list[i].w;
  var r = rng() * total;
  weightedPick.lastR = r / total;   // 原始抽值（0~1）：调试 / 确定性回归断言用
  for (i = 0; i < list.length; i++) {
    r -= list[i].w;
    if (r <= 0) return list[i];
  }
  return list[list.length - 1];
}

/* ---- 绘制随机流（画布贴图专用） ----
 * 默认就是主序列，所以 buildTextures 里的全局贴图与从前**逐抽一致**（rngDraws 不变）。
 * 但行星贴图会被 withSeed 切到「本行星专属流」：于是行星表面的绘制细节
 * （斑块数量、裂缝走向、冰盖范围……）可以任意增删，而**不再扰动主序列**
 * ——星系名 / 恒星 / 轨道布局因此不会因为改了贴图算法而漂移。
 * 规则：画布绘制一律用 drand / dpick / drng；只有世界生成（genXxx）才用 rng/rand。 */
var _drawRng = rng;
function drng() { return _drawRng(); }
function drand(a, b) { return a + _drawRng() * (b - a); }
function dpick(arr) { return arr[Math.floor(_drawRng() * arr.length)]; }
function withSeed(seed, fn) {
  var saved = _drawRng;
  _drawRng = mulberry32(seed | 0);
  try { return fn(); } finally { _drawRng = saved; }
}
/* 由种子派生第二个独立流（结构判定：行星环 / 云层……与表面绘制互不干扰） */
function seedStream(seed, salt) { return mulberry32((seed ^ salt) | 0); }


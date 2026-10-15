/* ================= 物种（库）与摇篮判定（v0.8 新增） ================= */

/* 「物种」是本作第一张**跨系统**的表：它描述的不是天体，而是「谁在这片星系里诞生」。
 * 第一版只有一种：人类 —— 但表本身按 15-registry.js 的约定登记，加物种 = 加一条数据。
 *
 * 三个概念各归各位：
 *   物种（本文件上半）   一张库表：生存条件 / 权重 / 文明命名 —— 静态数据
 *   摇篮评分（本文件下半） 纯函数：只读行星**已有**字段算出 0–100 分 —— 不抽任何随机数
 *   文明（35-civ.js）    实例：某个物种在某颗行星上的发源地 —— 运行时事实
 *
 * ★ 为什么评分必须是纯函数（本文件最重要的约束）：
 *   发源地是与「星系名 / 行星布局」同级的**世界事实**——刷新一百次也得是同一颗。
 *   评分一旦调用 rng()，它就会随贴图段的任何增删而漂移（确定性守恒，见 README §四）。
 *   所以这里只做算术：输入是温度 / 挥发分 / 气压档 / 重力，输出是分数。
 * ★ 评分口径写在物种数据里（comfortK / waterMin / weights…），不散在函数里 ——
 *   以后加「硅基生命」时，多半是加一条数据；等真出现「评分项目都不同」的物种
 *   （比如气态生命没有重力项），再回头把评分函数做成按物种可选，届时按需分支。
 */
var SPECIES = [
  {
    id: "human",
    name: "人类",
    sci: "Homo sapiens",
    kind: "碳基生命",
    habitat: "岩质行星 · 液态水 · 约 1 bar 大气",
    desc: "以液态水为溶剂、需可呼吸大气层与接近 1 g 表面重力的碳基智慧物种；温度耐受窗口窄。",
    civ: { id: "humanity", name: "人类文明" },
    /* 摇篮口径（评分的全部可调参数 —— 见下方 cradleScore） */
    cradle: {
      comfortK: [278, 308],   /* 舒适带（约 5–35 ℃）：这一段拿满温度分 */
      surviveK: [248, 343],   /* 生存带（约 −25–70 ℃）：带外温度分归零，带内线性衰减 */
      waterMin: 0.28,         /* 液态水的储量起点（与「类地行星」的判定阈值同源） */
      waterFull: 0.78,        /* 富水到这一档，液态水项满分 */
      gravBest: 9.807,        /* 最适表面重力（= 地球 g，单位 m/s²） */
      gravTol: 12             /* 偏离多少 m/s² 归零 */
    },
    weights: { temp: 40, water: 25, atmo: 20, grav: 15 },  /* 四项权重，和必须 = 100 */
    atmoPref: { "无": 0, "稀薄": 0.5, "适中": 1, "浓密": 0.55 }
  }
];

/* 物种表 → 注册表（v0.7 的原语）：结构查重 + 语义体检见 src/15-registry.js。
 * 体检里按 20-data.js 的真实气压档核对 atmoPref 是否覆盖全 —— 加一个新品类的
 * 气压档而忘了给物种配分，在这里就会变红。 */
var Species = makeRegistry("物种", {
  required: ["id", "name", "sci", "kind", "habitat", "desc", "civ", "cradle", "weights", "atmoPref"],
  checks: [
    function (list) {
      var bad = [];
      var atmoSet = {};
      PlanetTypes.all().forEach(function (t) { atmoSet[t.atmoP] = true; });
      var civIds = {};
      list.forEach(function (sp) {
        var w = sp.weights || {}, C = sp.cradle || {}, pref = sp.atmoPref || {};
        var sum = (w.temp || 0) + (w.water || 0) + (w.atmo || 0) + (w.grav || 0);
        if (sum !== 100) bad.push("「" + sp.id + "」四项权重和 " + sum + " ≠ 100");
        if (!(C.comfortK && C.surviveK) || C.comfortK.length !== 2 || C.surviveK.length !== 2) {
          bad.push("「" + sp.id + "」的舒适带 / 生存带不是两元组");
        } else if (!(C.surviveK[0] <= C.comfortK[0] && C.comfortK[1] <= C.surviveK[1])) {
          bad.push("「" + sp.id + "」舒适带不在生存带内：[" + C.comfortK + "] ⊄ [" + C.surviveK + "]");
        }
        if (!(C.waterMin >= 0 && C.waterMin < C.waterFull && C.waterFull <= 1)) {
          bad.push("「" + sp.id + "」水储量阈值不合法：" + C.waterMin + " → " + C.waterFull);
        }
        if (!(C.gravBest > 0 && C.gravTol > 0)) bad.push("「" + sp.id + "」重力参数不合法");
        Object.keys(atmoSet).forEach(function (k) {
          if (typeof pref[k] !== "number") bad.push("「" + sp.id + "」的 atmoPref 未覆盖气压档「" + k + "」");
        });
        Object.keys(pref).forEach(function (k) {
          var v = pref[k];
          if (typeof v !== "number" || v < 0 || v > 1) bad.push("「" + sp.id + "」atmoPref." + k + " 越界：" + v);
        });
        var civ = sp.civ || {};
        if (!civ.id || !civ.name) bad.push("「" + sp.id + "」缺文明命名（civ.id / civ.name）");
        else if (civIds[civ.id]) bad.push("文明 id 撞车：「" + civ.id + "」被两个物种占用");
        else civIds[civ.id] = true;
      });
      return bad;
    }
  ]
}).addAll(SPECIES);

/* ---- 评分件：分段线性（单侧衰减到 0） ----
 * [a,b] 满分区；下方沿 [lo,a] 线性升到 1、上方沿 [b,hi] 线性降到 0；窗外一律 0。 */
function bandScore(v, a, b, lo, hi) {
  if (v >= a && v <= b) return 1;
  if (v < a) return v <= lo ? 0 : (v - lo) / (a - lo);
  return v >= hi ? 0 : (hi - v) / (hi - b);
}

/* ---- 液态水项：先看相态（温度），再看储量 ----
 * 液态水窗口内按储量给 0.4–1.0 分；冰封给 0.25（可取冰，起点低）；
 * 水汽给 0.15（湿热的困局：有水的原料，没有水的形态）；蒸干/极度贫水 = 0。 */
function waterScore(p, C) {
  if (p.water < 0.08) return 0;
  if (p.tempSurf > 273 && p.tempSurf < 373) {
    return clamp01(0.4 + 0.6 * (p.water - C.waterMin) / (C.waterFull - C.waterMin));
  }
  if (p.tempSurf <= 273 && p.tempSurf > 200) return 0.25;
  if (p.tempSurf >= 373 && p.tempSurf < 900) return p.water >= C.waterMin ? 0.15 : 0;
  return 0;
}

/* ---- 单颗行星的摇篮评分（纯函数：只读行星字段，不抽随机数） ----
 * 四项各得一个 0–1 系数 → 乘物种权重 → 取整成整数分；总分 = 分项和。
 * 分项取整后再求和（而不是「取整总分」），保证「面板上四个数加起来 == 总分」
 * 这件事永远成立 —— verify 会断言它。 */
function cradleScore(p, sp) {
  var W = sp.weights, C = sp.cradle;
  if (p.bulk !== "rock") {
    /* 气态行星没有固体表面：资格直接为零（但不丢出——选址总要选出个「最优解」，
     * 面板会把 why 原样显示，让人看得见为什么是它） */
    return {
      total: 0, why: "气态行星没有固体表面",
      parts: [
        { k: "温度", v: 0, max: W.temp, note: "—" },
        { k: "液态水", v: 0, max: W.water, note: "—" },
        { k: "大气", v: 0, max: W.atmo, note: "—" },
        { k: "重力", v: 0, max: W.grav, note: "—" }
      ]
    };
  }
  var t = bandScore(p.tempSurf, C.comfortK[0], C.comfortK[1], C.surviveK[0], C.surviveK[1]);
  var w = waterScore(p, C);
  var a = sp.atmoPref[p.type.atmoP] || 0;
  var g = clamp01(1 - Math.abs(p.g - C.gravBest) / C.gravTol);
  var parts = [
    { k: "温度", v: Math.round(W.temp * t), max: W.temp, note: Math.round(p.tempSurf) + " K" },
    { k: "液态水", v: Math.round(W.water * w), max: W.water, note: p.water < 0.08 ? "近乎无水" : "储量 " + Math.round(p.water * 100) + "%" },
    { k: "大气", v: Math.round(W.atmo * a), max: W.atmo, note: p.type.atmoP },
    { k: "重力", v: Math.round(W.grav * g), max: W.grav, note: p.g.toFixed(2) + " g" }
  ];
  var total = 0;
  for (var i = 0; i < parts.length; i++) total += parts[i].v;
  return { total: total, parts: parts };
}

/* ---- 选址：全星系评分最高者胜出；平局取**更内侧**（轨道序靠前）----
 * 用严格大于号扫描 = 「先出现者保持」——平局规则不需要额外代码。
 * 返回 board 是**轨道序**的榜（面板 / 调试看全貌），fit 是胜者的登记材料。 */
function pickCradle(planets, sp) {
  var board = [], bestIdx = -1, bestScore = -Infinity, second = null;
  planets.forEach(function (p, i) {
    var s = cradleScore(p, sp);
    board.push({ name: p.name, idx: i, total: s.total });
    if (s.total > bestScore) {
      second = bestIdx >= 0 ? { name: planets[bestIdx].name, total: bestScore } : null;
      bestScore = s.total;
      bestIdx = i;
    } else if (second === null || s.total > second.total) {
      second = { name: p.name, total: s.total };
    }
  });
  var best = bestIdx >= 0 ? planets[bestIdx] : null;
  var fit = null;
  if (best) {
    var win = cradleScore(best, sp);
    fit = {
      total: win.total, parts: win.parts, why: win.why || null,
      second: second, tie: !!(second && second.total === win.total),
      candidates: planets.length,
      report: "评估 " + planets.length + " 颗行星：评分 " + win.total + " 居首" +
        (second ? (second.total === win.total ? "（并列，取更内侧）" : "，次席「" + second.name + "」" + second.total + " 分") : "")
    };
  }
  return { planet: best, fit: fit, board: board };
}

/* ---- 给 verify / 控制台的干净快照（不出原始对象，避免测试改了游戏数据） ---- */
function speciesIds() {
  return Species.all().map(function (sp) { return sp.id; });
}
function speciesTable() {
  return Species.all().map(function (sp) {
    return {
      id: sp.id, name: sp.name, sci: sp.sci, kind: sp.kind, habitat: sp.habitat, desc: sp.desc,
      civ: { id: sp.civ.id, name: sp.civ.name },
      weights: { temp: sp.weights.temp, water: sp.weights.water, atmo: sp.weights.atmo, grav: sp.weights.grav },
      cradle: {
        comfortK: sp.cradle.comfortK.slice(), surviveK: sp.cradle.surviveK.slice(),
        waterMin: sp.cradle.waterMin, waterFull: sp.cradle.waterFull,
        gravBest: sp.cradle.gravBest, gravTol: sp.cradle.gravTol
      },
      atmoPref: { "无": sp.atmoPref["无"], "稀薄": sp.atmoPref["稀薄"], "适中": sp.atmoPref["适中"], "浓密": sp.atmoPref["浓密"] }
    };
  });
}

/* ================= 物资（v0.9 新增）：元素制家底 —— 蕴藏与可采两本账 ================= */

/* 「资源」在本作的立场（先读这段，再看代码）：
 *   星际资源不标准化「物质」，标准化「账本」—— 物质因世界而异（那正是本作的财产），
 *   可比性从账来，不从货来。四条细则：
 *     ① 单位律：账目用自造单位「单位物资」（1 单位 = 10²¹ kg —— 显示标度）。
 *        内部按 kg 计算，全链可溯源：构成% × 行星质量 × 配方 → 元素 kg → ÷ 标度。
 *     ② 账本律：14 个物资大类（9 现役 + 5 待命），元素按化学性质归户、**单一归属**。
 *     ③ 存量律：本版只回答「行星身上有什么、够不够得着」—— 不开采、不运输
 *        （那是纪年系统的活）。**恒星物资页不做**（留给以后的「能量采集」）。
 *     ④ 溯源律：每个数字都能指着行星的一个字段说出公式（老法律，资源版细则）。
 *
 * 三层结构（自上而下）：
 *   元素表 ELEMENTS   31 种：配方用得上者 + 待命大类的展示成员
 *   配方 RECIPES      12 个构成标签 → 元素质量占比（教科书折算，加载时归一化）
 *   物资表 MATERIALS  14 大类 —— 元素表的「归户」（单质单列、其余按族）
 *
 * ★★ 本文件最重要的两条约束（verify [19] 逐条断言）：
 *   一、零 RNG：推导只读行星既有字段（comp / mE），不抽任何随机数 ——
 *       主 RNG 流（884 / 0.374455 / 薄曙 / M）一格不动。
 *   二、守恒：Σ蕴藏 ≡ 行星质量。构成是整数百分比、和恰 100（20-data），
 *       配方归一化后和恰 1 —— 两层「恰好」让守恒精确到机器精度。
 *
 * 两本账（星球蕴含 ≠ 可以被采集）：
 *   蕴藏 = 行星全部物质按配方折算的元素总量 —— 行星常量
 *   可采 = 按「位置可及档」折减后的可达部分 —— 行星 × 工程等级
 *   ★ 取率是工程等级的函数（siteRate）：科技树未上线，现锁在 L0；将来升级只改
 *     SITE_RATES 一张表，可采数字自己长大（单调不减、天花板恒等于蕴藏）。
 *
 * ★ 后期会有「延伸物质」（合金 / 化合物 / 制品……）：届时新开一张制品表、
 *   引用本表物资作原料，本表不回改（用户 10-14 定的口径：到时候再说）。
 */

/* ---- 标度与常数 ----
 * 全代码原本没有 kg（质量单位一直是 M⊕）—— 物资账要「物质量」就得引入一个换算常数。
 * 存 kg 是为了溯源：显示除以标度之后，数字仍能一步步走回行星质量。 */
var EARTH_KG = 5.9722e24;   /* 地球质量 kg（教科书常数） */
var UNIT_KG = 1e21;         /* 1 单位物资 = 10²¹ kg（自造显示单位，比例全保真） */

/* ---- 元素表（31 种）----
 * 只收「配方用得上」与「待命大类要展示」的元素 —— 不是化学教科书，是账本的名册。
 * id 即元素符号。不设独立注册表：它是物资表的**成员字典**，查重 / 归属 / 闭包
 * 全部由物资表的语义体检覆盖（见下方 Materials 的 checks）。 */
var ELEMENTS = [
  { id: "H", name: "氢" }, { id: "He", name: "氦" }, { id: "Ne", name: "氖" },
  { id: "Ar", name: "氩" }, { id: "Kr", name: "氪" }, { id: "Xe", name: "氙" },
  { id: "C", name: "碳" }, { id: "N", name: "氮" }, { id: "O", name: "氧" }, { id: "Si", name: "硅" },
  { id: "Na", name: "钠" }, { id: "K", name: "钾" }, { id: "Mg", name: "镁" },
  { id: "Ca", name: "钙" }, { id: "Al", name: "铝" },
  { id: "Fe", name: "铁" }, { id: "Ni", name: "镍" }, { id: "Cr", name: "铬" },
  { id: "Mn", name: "锰" }, { id: "Co", name: "钴" },
  { id: "S", name: "硫" }, { id: "F", name: "氟" }, { id: "Cl", name: "氯" },
  { id: "Ag", name: "银" }, { id: "Au", name: "金" }, { id: "Pt", name: "铂" },
  { id: "U", name: "铀" }, { id: "Th", name: "钍" },
  { id: "La", name: "镧" }, { id: "Ce", name: "铈" }, { id: "Nd", name: "钕" }
];
var ELEM_BY_ID = {};
ELEMENTS.forEach(function (e) { ELEM_BY_ID[e.id] = e; });

/* ---- 配方：12 个构成标签 → 元素质量占比 ----
 * 标签与 20-data.js 的 buildComposition 一一对应（相态名由温度决定，共 12 种）：
 *   岩质三桶   铁镍核（Fe 90 / Ni 10）· 硅酸盐幔 · 挥发分六相
 *   巨行星三桶 H₂·He（原初丰度 74 / 26）· 水氨冰 / 水氨甲烷幔 · 岩石核
 * 数值全部是氧化物 / 化学式的**教科书折算**（不是发明），加载时归一化到和为 1：
 *   硅酸盐幔 = 橄榄岩质幔氧化物折算（O / Mg / Si / Fe / Ca / Al / Na / K）
 *   水=H₂O · 铁镍核=类地行星核口径 · 水氨冰=水 60/氨 25/甲烷 15 · 水氨甲烷幔=水 55/氨 25/甲烷 20
 *   「已蒸干」= 氢已逃逸、氧留在岩壳；「被剥离」= 恒星风剥离后的含水矿物残渣
 * ★ 已知口径（留给未来）：碳行星（碳 > 50%）的碳在构成模型里并入「硅酸盐幔」桶，
 *   本表按标准幔折算 —— 碳行星的特殊性留待构成模型细分的版本再修。
 * ★ 覆盖检查写进注册表体检：配方键 ↔ 可及档键一一对应；将来 buildComposition 出现
 *   新标签而这里没配 → verify [19] 的 15 星型扫描会拿真实行星标签把它抓出来。 */
var MANTLE = { O: 0.4423, Mg: 0.2333, Si: 0.2092, Fe: 0.0628, Ca: 0.0260, Al: 0.0235, Na: 0.0026, K: 0.0003 };
var WATER = { H: 0.1119, O: 0.8881 };
var RECIPES_RAW = {
  "铁镍核": { Fe: 0.90, Ni: 0.10 },
  "硅酸盐幔": MANTLE,
  "岩石核": MANTLE,
  "水冰": WATER, "冰水": WATER, "液态水": WATER, "水汽": WATER,
  "挥发分（被剥离）": WATER,                              /* 剥离后残留的含水矿物：按水口径折算 */
  "挥发分（已蒸干）": { O: 1 },                           /* 氢已逃逸、氧留在岩壳（熔岩世界） */
  "H₂·He": { H: 0.74, He: 0.26 },
  "水氨冰": { H: 0.1492323, O: 0.5328560, N: 0.2056104, C: 0.1123013 },
  "水氨甲烷幔": { H: 0.1562032, O: 0.4884513, N: 0.2056104, C: 0.1497351 }
};

/* 归一化（加载时一次）：原始值允许极小的舍入偏离，归一化后每张配方**恰好**和为 1
 * —— 守恒链的第一环（verify 对两条都断言：原始值接近 1、归一化后等于 1）。 */
var RECIPES = (function () {
  var out = {};
  Object.keys(RECIPES_RAW).forEach(function (k) {
    var r = RECIPES_RAW[k], sum = 0;
    Object.keys(r).forEach(function (el) { sum += r[el]; });
    var n = {};
    Object.keys(r).forEach(function (el) { n[el] = r[el] / sum; });
    out[k] = n;
  });
  return out;
})();

/* ---- 可及档：位置决定「够不够得着」----
 * 对「构成桶」打位置标：表层（流体 / 气层）全取 · 岩壳十取一 · 深部百取一。
 * ★ 三档取率不是常数，是**工程等级的函数**（siteRate）。三个 L0 值是全表唯一
 *   待设的工程参数，其余全部可由构成与质量推导 —— 数字几乎全是「发现」的。
 *   将来科技树上线 = 往 SITE_RATES 里追加各档的下一档值（单调不减，天花板上限 1）。 */
var SITE_CLASS = {
  "铁镍核": "deep", "岩石核": "deep",
  "硅酸盐幔": "crust",
  "水冰": "surface", "冰水": "surface", "液态水": "surface", "水汽": "surface",
  "挥发分（被剥离）": "surface", "挥发分（已蒸干）": "surface",
  "H₂·He": "surface",
  "水氨冰": "deep", "水氨甲烷幔": "deep"
};
var SITE_RATES = {
  surface: [1.0],     /* L0：表层全取 —— 大气与海洋本身就是它的仓储 */
  crust: [0.10],      /* L0：岩壳十取一 —— 露天矿脉 */
  deep: [0.01]        /* L0：深部百取一 —— 打一眼深井 */
};
var ENGINEERING = { level: 0, name: "L0" };   /* 科技树未上线：取率锁在 L0 */
function siteRate(cls, level) {
  var arr = SITE_RATES[cls];
  if (!arr || !arr.length) return 0;
  var lv = level === undefined ? ENGINEERING.level : level;
  if (!(lv >= 0)) lv = 0;
  if (lv >= arr.length) lv = arr.length - 1;   /* 未填的未来等级 = 沿用最高已知档 */
  return arr[lv];
}

/* ---- 物资表（14 大类 = 9 现役 + 5 待命）----
 * 两条规则：
 *   单一归属：每个元素恰属一个大类 —— 单质单列者从其族中移出（铁单列 ⇒ 过渡金属现只有镍）；
 *   现役 ⇔ 族内至少一名成员被配方覆盖（换句话说：本星系真出得来）。
 *   待命类是骨架位，等对应世界 / 玩法点亮（硫化物行星、卤水世界、精炼工业……）。
 * 表序 = 展示顺序（面板按此列出，零量类收进行尾一行）。 */
var MATERIALS = [
  { id: "h",      name: "氢",       members: ["H"],                          status: "active" },
  { id: "noble",  name: "惰性气体", members: ["He", "Ne", "Ar", "Kr", "Xe"], status: "active" },
  { id: "c",      name: "碳",       members: ["C"],                          status: "active" },
  { id: "n",      name: "氮",       members: ["N"],                          status: "active" },
  { id: "o",      name: "氧",       members: ["O"],                          status: "active" },
  { id: "si",     name: "硅",       members: ["Si"],                         status: "active" },
  { id: "alkali", name: "活跃金属", members: ["Na", "K", "Mg", "Ca", "Al"],  status: "active" },
  { id: "fe",     name: "铁",       members: ["Fe"],                         status: "active" },
  { id: "tm",     name: "过渡金属", members: ["Ni", "Cr", "Mn", "Co"],       status: "active" },
  { id: "s",      name: "硫",       members: ["S"],                          status: "standby" },
  { id: "hal",    name: "卤素",     members: ["F", "Cl"],                    status: "standby" },
  { id: "prec",   name: "贵金属",   members: ["Ag", "Au", "Pt"],             status: "standby" },
  { id: "rad",    name: "放射性",   members: ["U", "Th"],                    status: "standby" },
  { id: "rare",   name: "稀土",     members: ["La", "Ce", "Nd"],             status: "standby" }
];

/* 物资表 → 注册表：结构查重 + 语义体检（boot 时跑）。
 * 体检比别的表重 —— 它还替元素表、配方表、可及档表站岗（见 checks ⑥⑦）。 */
var Materials = makeRegistry("物资", {
  required: ["id", "name", "members", "status"],
  checks: [
    function (list) {
      var bad = [];
      /* ① 元素表自检：id / 名齐全、无重复 */
      var seen = {};
      ELEMENTS.forEach(function (e) {
        if (!e || !e.id || !e.name) { bad.push("元素表有条目缺 id / name"); return; }
        if (seen[e.id]) bad.push("元素表重复元素：" + e.id);
        seen[e.id] = true;
      });
      /* ② 单一归属：每个元素恰属一个大类（重复 = 重复记账），成员必须在元素表里 */
      var owner = {};
      list.forEach(function (cat) {
        if (!cat.members || !cat.members.length) { bad.push("「" + cat.id + "」没有成员"); return; }
        cat.members.forEach(function (el) {
          if (!ELEM_BY_ID[el]) { bad.push("「" + cat.id + "」的成员 " + el + " 不在元素表里"); return; }
          if (owner[el]) bad.push("元素 " + el + " 同时属于「" + owner[el] + "」与「" + cat.id + "」");
          else owner[el] = cat.id;
        });
      });
      ELEMENTS.forEach(function (e) {
        if (!owner[e.id]) bad.push("元素「" + e.id + "」不属于任何物资大类");
      });
      return bad;
    },
    function (list) {
      var bad = [];
      /* ③ 配方闭包：标签 ↔ 配方 ↔ 可及档 三方一一对应；配方元素在表内；归一化后和 = 1 */
      var covered = {};
      Object.keys(RECIPES).forEach(function (k) {
        var r = RECIPES[k], sum = 0;
        Object.keys(r).forEach(function (el) {
          if (!ELEM_BY_ID[el]) bad.push("配方「" + k + "」含未知元素：" + el);
          covered[el] = true;
          sum += r[el];
        });
        if (Math.abs(sum - 1) > 1e-9) bad.push("配方「" + k + "」归一化后和 ≠ 1：" + sum);
        if (!SITE_CLASS[k]) bad.push("配方「" + k + "」没有可及档");
        else if (!SITE_RATES[SITE_CLASS[k]]) bad.push("配方「" + k + "」的可及档「" + SITE_CLASS[k] + "」没有取率表");
      });
      Object.keys(SITE_CLASS).forEach(function (k) {
        if (!RECIPES[k]) bad.push("可及档「" + k + "」没有对应配方（多余条目）");
      });
      /* ④ 原始值接近 1（教科书折算值不许被改烂到离谱） */
      Object.keys(RECIPES_RAW).forEach(function (k) {
        var r = RECIPES_RAW[k], sum = 0;
        Object.keys(r).forEach(function (el) { sum += r[el]; });
        if (Math.abs(sum - 1) > 5e-4) bad.push("原始配方「" + k + "」和的偏离过大：" + sum);
      });
      /* ⑤ 状态口径：现役 ⇔ 至少一名成员被配方覆盖；待命 ⇔ 一名都没有 */
      list.forEach(function (cat) {
        var hit = (cat.members || []).some(function (el) { return covered[el]; });
        var want = hit ? "active" : "standby";
        if (cat.status !== "active" && cat.status !== "standby") bad.push("「" + cat.name + "」status 非法：" + cat.status);
        else if (cat.status !== want) bad.push("「" + cat.name + "」status=" + cat.status + "，但配方覆盖对应 " + want);
      });
      /* ⑥ 取率表：值域 (0,1]、随等级单调不减（「可采只增不减」的结构保证） */
      Object.keys(SITE_RATES).forEach(function (cls) {
        var arr = SITE_RATES[cls];
        if (!arr || !arr.length) { bad.push("可及档「" + cls + "」没有取率"); return; }
        for (var i = 0; i < arr.length; i++) {
          if (!(arr[i] > 0 && arr[i] <= 1)) bad.push("取率 " + cls + "[" + i + "] = " + arr[i] + " 越界（应在 (0, 1]）");
          if (i > 0 && arr[i] < arr[i - 1]) bad.push("取率 " + cls + " 随等级下降：" + arr.join(" → "));
        }
      });
      /* ⑦ 三档齐备 */
      ["surface", "crust", "deep"].forEach(function (cls) {
        if (!SITE_RATES[cls]) bad.push("缺可及档：" + cls);
      });
      return bad;
    }
  ]
}).addAll(MATERIALS);

/* ---- 推导（纯函数，零 RNG）----
 * 输入只有行星的两个既有字段：p.comp（整数百分比构成）· p.mE（质量 M⊕）。
 * 输出按**元素**记的两本账（kg）：hold 蕴藏 · ext 可采。 */
function elementLedgerOf(p) {
  var massKg = p.mE * EARTH_KG;
  var hold = {}, ext = {}, unmatched = [];
  p.comp.forEach(function (c) {
    var label = c[0], pct = c[1];
    var r = RECIPES[label];
    if (!r) { if (unmatched.indexOf(label) < 0) unmatched.push(label); return; }
    var rate = siteRate(SITE_CLASS[label]);
    var bucketKg = massKg * (pct / 100);
    Object.keys(r).forEach(function (el) {
      var kg = bucketKg * r[el];
      hold[el] = (hold[el] || 0) + kg;
      ext[el] = (ext[el] || 0) + kg * rate;
    });
  });
  return { massKg: massKg, hold: hold, ext: ext, unmatched: unmatched };
}

/* 单颗行星的物资账（面板 / __game 共用）：按物资表顺序归户。
 * rows = 有量的大类（数值 + 格式化前的 kg）；zero = 零量大类名（收成一行）。 */
function materialsOf(p) {
  var led = elementLedgerOf(p);
  var rows = [], zero = [], sumHold = 0, sumExt = 0;
  Materials.all().forEach(function (cat) {
    var h = 0, e = 0;
    cat.members.forEach(function (el) {
      h += led.hold[el] || 0;
      e += led.ext[el] || 0;
    });
    sumHold += h;
    sumExt += e;
    if (h > 0) {
      rows.push({
        id: cat.id, label: matLabel(cat), members: cat.members.slice(),
        holdKg: h, extKg: e, units: h / UNIT_KG, extUnits: e / UNIT_KG
      });
    } else {
      zero.push(matLabel(cat));
    }
  });
  return {
    idx: p.idx, name: p.name,
    massKg: led.massKg, totalUnits: led.massKg / UNIT_KG,
    holdKg: sumHold, extKg: sumExt,
    rows: rows, zero: zero, unmatched: led.unmatched
  };
}

/* 大类显示名：单质单列者带元素符号（「氢 H」）；族不带（「活跃金属」） */
function matLabel(cat) {
  return cat.name + (cat.members.length === 1 ? " " + cat.members[0] : "");
}

/* kg → 「单位物资」显示串（面板与 verify 的页文本核对同源）：
 *   ≥100 → 取整 + 千分位（157 / 380,885）· ≥10 → 一位小数（18.5）
 *   ≥1 → 两位小数（3.86）· <1 → 两位有效数字（0.27） */
function matUnits(kg) {
  var v = kg / UNIT_KG;
  if (!(v > 0)) return "0";
  if (v >= 100) return fmtNum(Math.round(v));
  if (v >= 10) return v.toFixed(1);
  if (v >= 1) return v.toFixed(2);
  return v.toPrecision(2);
}

/* ---- 给 verify / 控制台的干净快照（不出原始对象）---- */
function matClone(x) { return JSON.parse(JSON.stringify(x)); }
function materialsTable() {
  var rates = {}, classes = {};
  Object.keys(SITE_RATES).forEach(function (k) { rates[k] = SITE_RATES[k].slice(); });
  Object.keys(SITE_CLASS).forEach(function (k) { classes[k] = SITE_CLASS[k]; });
  return {
    unit: "单位物资", unitKg: UNIT_KG, earthKg: EARTH_KG,
    eng: { level: ENGINEERING.level, name: ENGINEERING.name },
    elements: ELEMENTS.map(function (e) { return { id: e.id, name: e.name }; }),
    labels: Object.keys(RECIPES),
    recipes: matClone(RECIPES), recipesRaw: matClone(RECIPES_RAW),
    siteClass: classes, siteRates: rates,
    categories: Materials.all().map(function (c) {
      return { id: c.id, name: c.name, members: c.members.slice(), status: c.status, label: matLabel(c) };
    })
  };
}
/* 全部行星的物资账（可给单颗行星名过滤，与 planetData 同款签名） */
function planetMaterials(name) {
  return G.sys.planets.filter(function (p) { return !name || p.name === name; })
    .map(function (p) { return materialsOf(p); });
}

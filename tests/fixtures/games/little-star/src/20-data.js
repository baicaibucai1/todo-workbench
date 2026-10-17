/* ================= 静态数据 ================= */
/* 恒星光谱型（科学题材·v0.5 扩容至完整版图）：
 *   spec = 光谱分类 / tempK = 表面温度 / radiusSol·massSol·lumSol = 与太阳的比值
 *   —— 全部取值落在对应类型的真实科学区间内（见「恒星指导书」）
 *   klass = 类别（驱动视觉与面板）：ms 主序 / giant 巨星 / supergiant 超巨星 /
 *           bd 褐矮星 / wd 白矮星 / ns 中子星 / bh 黑洞
 *   w    = 抽取权重（近似真实统计：M 红矮星最多；O / 中子星 / 黑洞极稀有）
 *   size = 游戏内视觉尺度（风格化，非真实比例）；mat = 表面与活动性参数
 *     ├ noise 表面颗粒尺度   ├ spot 星斑强度     └ flareRate 耀斑频率倍率
 *   ⚠ 数组顺序与权重经 scripts/roll-check.mjs 复刻校准：抽值 0.374455 必须命中 M5V，
 *     否则「薄曙」会变型 / 行星布局漂移（贴图与抽样序列见文件头）。 */
var STAR_TYPES = [
  { id: "M", spec: "M5V", name: "红矮星", klass: "ms", color: 0xff8a5c, size: 1.5, w: 60,
    tempK: 3050, radiusSol: 0.17, massSol: 0.16, lumSol: 0.0015,
    mat: { noise: 3.3, spot: 0.95, flareRate: 1.7, act: "高（耀星型）" } },
  { id: "K", spec: "K2V", name: "橙矮星", klass: "ms", color: 0xffb466, size: 1.8, w: 10,
    tempK: 5000, radiusSol: 0.80, massSol: 0.82, lumSol: 0.32,
    mat: { noise: 3.0, spot: 0.6, flareRate: 1.05, act: "中" } },
  { id: "G", spec: "G2V", name: "黄矮星", klass: "ms", color: 0xffd27a, size: 2.1, w: 5,
    tempK: 5780, radiusSol: 1.0, massSol: 1.0, lumSol: 1.0,
    mat: { noise: 2.8, spot: 0.45, flareRate: 0.8, act: "中" } },
  { id: "F", spec: "F5V", name: "黄白色主序星", klass: "ms", color: 0xf8f0d0, size: 2.3, w: 2.5,
    tempK: 6500, radiusSol: 1.3, massSol: 1.35, lumSol: 2.5,
    mat: { noise: 2.6, spot: 0.3, flareRate: 0.65, act: "中低" } },
  { id: "A", spec: "A5V", name: "白色主序星", klass: "ms", color: 0xe8eeff, size: 2.5, w: 1,
    tempK: 8400, radiusSol: 1.7, massSol: 1.9, lumSol: 13,
    mat: { noise: 2.4, spot: 0.18, flareRate: 0.5, act: "低" } },
  { id: "B", spec: "B5V", name: "蓝白主序星", klass: "ms", color: 0xa8c4ff, size: 2.9, w: 0.3,
    tempK: 15500, radiusSol: 3.9, massSol: 5.5, lumSol: 500,
    mat: { noise: 2.2, spot: 0.1, flareRate: 0.4, act: "低（强星风）" } },
  { id: "O", spec: "O5V", name: "蓝色主序星", klass: "ms", color: 0x9bb0ff, size: 3.3, w: 0.03,
    tempK: 40000, radiusSol: 11, massSol: 32, lumSol: 320000,
    mat: { noise: 2.0, spot: 0.06, flareRate: 0.35, act: "极强星风" } },
  { id: "RG", spec: "M0III", name: "红巨星", klass: "giant", color: 0xff9a55, size: 4.1, w: 2,
    tempK: 3850, radiusSol: 55, massSol: 1.3, lumSol: 600,
    mat: { noise: 3.6, spot: 0.7, flareRate: 0.4, act: "低（脉动）" } },
  { id: "RSG", spec: "M2Iab", name: "红超巨星", klass: "supergiant", color: 0xff7a4a, size: 5.4, w: 0.12,
    tempK: 3550, radiusSol: 800, massSol: 16, lumSol: 120000,
    mat: { noise: 3.8, spot: 0.75, flareRate: 0.35, act: "低（强对流）" } },
  { id: "L", spec: "L5", name: "褐矮星（L 型）", klass: "bd", color: 0xd85f2e, size: 0.95, w: 1.2,
    tempK: 1700, radiusSol: 0.10, massSol: 0.055, lumSol: 0.00005,
    mat: { noise: 4.2, spot: 1.0, flareRate: 0.5, act: "极低（近红外）" } },
  { id: "T", spec: "T5", name: "褐矮星（T 型）", klass: "bd", color: 0x9a4a66, size: 0.85, w: 0.5,
    tempK: 1000, radiusSol: 0.095, massSol: 0.03, lumSol: 0.0000032,
    mat: { noise: 4.5, spot: 0.9, flareRate: 0.2, act: "极低（甲烷吸收）" } },
  { id: "Y", spec: "Y1", name: "褐矮星（Y 型）", klass: "bd", color: 0x6a5578, size: 0.75, w: 0.15,
    tempK: 400, radiusSol: 0.085, massSol: 0.015, lumSol: 0.0000001,
    mat: { noise: 4.8, spot: 0.8, flareRate: 0.1, act: "近零（红外）" } },
  { id: "WD", spec: "DA2", name: "白矮星", klass: "wd", color: 0xdceaff, size: 1.1, w: 2,
    tempK: 25200, radiusSol: 0.0126, massSol: 0.62, lumSol: 0.056,
    mat: { noise: 1.7, spot: 0.05, flareRate: 0.15, act: "低（宁静）" } },
  { id: "NS", spec: "PSR", name: "中子星", klass: "ns", color: 0xcfe6ff, size: 0.55, w: 0.06,
    tempK: 600000, radiusSol: 0.0000172, massSol: 1.4, lumSol: 0.03,
    mat: { noise: 1.2, spot: 0, flareRate: 0, act: "强磁场 · 高速自转" } },
  { id: "BH", spec: "BH", name: "黑洞", klass: "bh", color: 0x0a0a12, size: 1.35, w: 0.03,
    tempK: 0, radiusSol: 0.0000424, massSol: 10, lumSol: 0,
    mat: { noise: 1, spot: 0, flareRate: 0, act: "无（事件视界）" } }
];

/* 星型表 → 注册表（v0.7）：结构查重 + 语义体检在 boot 时跑，见 src/15-registry.js。
 * ★ 注册必须紧跟表定义：权重（w）与表序被 roll-check 与本文件后面的抽样复刻共同依赖。 */
var StarTypes = makeRegistry("恒星类型", {
  required: ["id", "spec", "name", "klass", "color", "size", "w", "tempK", "radiusSol", "massSol", "lumSol", "mat"],
  checks: [
    RegChecks.color("color"),
    RegChecks.range("tempK", 0, 1e8),
    RegChecks.range("radiusSol", 1e-7, 2000),
    RegChecks.range("massSol", 1e-6, 200),
    RegChecks.range("lumSol", 0, 1e7),
    RegChecks.range("w", 0, 1e6),
    RegChecks.range("size", 0.1, 50),
    RegChecks.oneOf("klass", ["ms", "giant", "supergiant", "bd", "wd", "ns", "bh"])
  ]
}).addAll(STAR_TYPES);
/* ================= 行星物理（所有数值由公式算出，不硬编码） =================
 * 因果链（这也是「行星」一节要写进指导书的东西）：
 *   ① 恒星属性 (T★ R★ L★ M★) + 轨道半长轴 a
 *        → 平衡温度 T_eq = T★·(1-A)^¼·√(R★/2a)     ← 表面温度取决于恒星与距离
 *        → 恒星辐照 S = L★/a²
 *   ② 半径 R →（质量-半径关系 M(R)）→ 质量 M
 *        → 表面重力 g = GM/R²   → 逃逸速度 v = √(2GM/R)
 *   ③ a + M★ →（开普勒第三定律 P = 2π√(a³/GM)）→ 公转周期 P
 *        → 轨道速度 v = 2πa/P
 *   ④ 气候带（由 T_eq） + 挥发分 / 金属丰度 / 体积 → 行星类型
 *        → 该类型的反照率与温室系数回代，得出真实表面温度 T_surf
 * 类型判定用「基准反照率 0.3、无温室」的平衡温度 T_eq0 作气候带判据，
 * 再用各型自身的反照率与温室系数算真实 T_surf —— 金星与地球的差别正在于此。 */

var AU_KM = 1.495978707e8;      /* 1 AU = ? km */
var R_SOL_AU = 0.00465047;      /* 1 R☉ = ? AU（平衡温度换算用） */
var VIS_PER_AU = 700;           /* 本作换算：1 AU = 700 场景单位（轨道视觉半径 = au×700） */

function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
/* 单次均匀抽值 → 三角分布（峰在 0.5）：给「中间值最常见」的自然量用（半径等） */
function triU(u) { return u < 0.5 ? Math.sqrt(u * 0.5) : 1 - Math.sqrt((1 - u) * 0.5); }
/* 平衡温度：恒星给多少辐照、行星反射多少 → 无大气时的温度 */
function eqTemp(star, au, albedo) {
  return star.tempK * Math.sqrt(star.radiusSol / (2 * (au / R_SOL_AU))) * Math.pow(1 - albedo, 0.25);
}
/* 恒星辐照（地球 = 1）：S = L★/a² */
function insolation(star, au) { return star.lumSol / (au * au); }
/* 开普勒第三定律：P² = 4π²a³/(G(M★+m)) —— 太阳质量 / 天文单位为量纲即得「年」 */
function keplerDays(au, starMassSol, planetMassEarth) {
  var ms = starMassSol + (planetMassEarth || 0) / 332946;   /* 行星质量一并计入 */
  return 365.25 * Math.sqrt(au * au * au / ms);
}
/* 轨道速度 v = 2πa/P（km/s） */
function orbitKms(au, days) { return 2 * Math.PI * au * AU_KM / (days * 86400); }
/* ---- 构成模型 ----
 * 岩质行星按三个储库分成质量占比：铁镍核 / 硅酸盐幔 / 挥发分。
 * 铁镍占比是唯一的一阶自由量（水星 ≈ 0.63、地球 ≈ 0.32、月球 ≈ 0.03），
 * 由 metal 抽值线性映射而来。 */
var IRON_EARTH = 0.32;                                      /* 地球的铁镍质量占比（基准） */
function ironFrac(metal) { return clamp(0.06 + 0.86 * metal, 0.03, 0.70); }
/* 挥发分**质量**占比：由 water 抽值给出，且只在「有大气顶着」时才留得住。
 * ★ 这一项与温度无关 —— 它是形成时留下的总量，不是此刻的相态（相态见 volatileState）。
 * 下限 0.008：地球的水（含地幔水）只占质量 0.02%，但那是「表面水」的口径；
 * 按「总储库」口径给 1% 才不至于让所有行星在这一格都显示 0%。 */
function volMass(water, atmoP) {
  var v = clamp((water - 0.45) * 0.75, 0, 0.40);            /* 只有明显富水的抽值才算挥发分大户 */
  return Math.max(v * (atmoP === "无" ? 0.12 : 1), 0.008);  /* 无大气 = 被恒星风剥离，只剩残渣 */
}
/* 挥发分的**相态**：只由表面温度决定 —— 同一个水分子，冷是冰、热是汽。
 * 900 K 以上返回 null：水分子被紫外线分解、氢逃逸，储库名存实亡。 */
function volatileState(T) {
  if (T < 200) return "水冰";
  if (T < 273) return "冰水";
  if (T <= 373) return "液态水";
  if (T < 900) return "水汽";
  return null;
}

/* 质量-半径关系（岩质，Valencia 型）：R ≤ 1.5 R⊕ 时 M = R^3.57（硅酸盐自压缩）；
 * 更大的「超级地球」压缩变缓 → M = 5.06·(R/1.5)²（5.06 = 1.5^3.57）。
 * 基准式以地球成分为标定点（R=1 → M=1），再乘**体积加权混合密度比**修正成分偏离：
 *   1/ρ = Σ(xᵢ/ρᵢ)  —— 铁 7.87 / 硅酸盐 3.3 / 水冰 1.0 g/cm³（未压缩材料密度）
 * 于是铁核大的更沉（水星型 ≈ +29%）、富水的更轻（海洋行星 ≈ −38%），两端夹住防外推发散。 */
var RHO_IRON = 7.87, RHO_SIL = 3.3, RHO_VOL = 1.0;
/* 地球成分的**比容**（1/ρ）—— 密度比的比较基准 */
var RHO_REF_INV = IRON_EARTH / RHO_IRON + (1 - IRON_EARTH) / RHO_SIL;
/* 岩质行星的三储库质量占比 —— ★ 唯一算法：
 * 质量（rockyMass）与面板/指导书的「构成」显示都从这里取，两处不可能各算一套。 */
function rockyParts(metal, water, atmoP) {
  var iron = ironFrac(metal);
  var vol = volMass(water, atmoP);
  var sil = 1 - iron - vol;
  if (sil < 0.05) { sil = 0.05; iron = Math.max(0.03, 1 - sil - vol); }   /* 极端抽值兜底 */
  return { iron: iron, sil: sil, vol: vol };
}
/* ★ 入参就是要展示的那一份分量（不是重新用 iron/vol 推 sil）——
 * 否则 rockyParts 的兜底修正只影响显示、不影响质量，两处会悄悄对不上。 */
function mixDensRatio(q) {
  return RHO_REF_INV / (q.iron / RHO_IRON + q.sil / RHO_SIL + q.vol / RHO_VOL);
}
function rockyMass(rE, metal, water, atmoP) {
  var base = rE <= 1.5 ? Math.pow(rE, 3.57) : 5.06 * Math.pow(rE / 1.5, 2);
  return base * clamp(mixDensRatio(rockyParts(metal, water, atmoP)), 0.60, 1.45);
}
/* 气态巨行星：半径对质量极不敏感（木星 / 土星同量级）→ 由质量反推半径。
 * 指数取 0.14：拿木星 318 M⊕/11.21 R⊕ 与土星 95 M⊕/9.45 R⊕ 两点定出
 * （0.05 那种近似值会把土星级压成 10.6 R⊕，密度掉到 0.45 —— 比土星实际稀一半）。 */
function giantRadius(mE) { return 11.21 * Math.pow(mE / 317.8, 0.14); }
/* 冰巨星：天王星 4.0 / 海王星 3.9 R⊕ → R ≈ 3.9·(M/17)^0.12 */
function iceGiantRadius(mE) { return 3.9 * Math.pow(mE / 17, 0.12); }
/* 表面重力 g = GM/R²（m/s²；地球 9.807） */
function gravG(mE, rE) { return 9.807 * mE / (rE * rE); }
/* 逃逸速度 v_esc = √(2GM/R)（km/s；地球 11.19） */
function escKms(mE, rE) { return 11.186 * Math.sqrt(mE / rE); }

/* ---- 构成：把「主要成分」算成质量占比 ----
 * 这是面板「构成」行与指导书的唯一数据源。两个分支都只读已有的物理量，
 * 不存任何写死的文案，因此换恒星（温度变）→ 挥发分相态跟着变。
 *   岩质：铁镍核 / 硅酸盐幔 / 挥发分（相态由表面温度定）
 *   巨行星：H₂·He 包层 / 冰 / 岩石核（包层占比随总质量上升而下降 ——
 *           木星重元素只占 ~4%，土星反而 ~10%，本条即这一观测事实的一阶拟合）
 * 返回值 [[名称, 整数百分比], …] 按占比降序，整数和恰好 100（最大项吸收舍入误差）。 */
function buildComposition(c) {
  var parts;
  if (c.kind === "giant") {
    if (c.typeId === "icegiant") {
      var hhe = clamp(9 - 3 * (c.mE / 17), 2, 9);
      var rock = clamp(13 + 3 * (c.mE / 17), 13, 18);
      parts = [["水氨甲烷幔", 100 - hhe - rock], ["岩石核", rock], ["H₂·He", hhe]];
    } else {
      /* 重元素占比随包层质量上升而下降（木星 ~4% / 土星 ~10%）→ 包层 = 其余 */
      var heavy = clamp(30 / (1 + c.mE / 50), 3, 28);
      parts = [["H₂·He", 100 - heavy], ["水氨冰", heavy * 0.55], ["岩石核", heavy * 0.45]];
    }
  } else {
    var q = rockyParts(c.metal, c.water, c.atmoP);
    var vn = volatileState(c.tempSurf);
    /* 无大气者挥发分已被剥离，标签直接写明原因（否则「水汽」会让人以为它还留着水） */
    var label = vn === null ? "挥发分（已蒸干）"
      : (c.atmoP === "无" && c.water < 0.55 ? "挥发分（被剥离）" : vn);
    parts = [[label, q.vol * 100], ["硅酸盐幔", q.sil * 100], ["铁镍核", q.iron * 100]];
  }
  parts.sort(function (a, b) { return b[1] - a[1]; });
  var pct = parts.map(function (a) { return Math.round(a[1]); });
  pct[0] += 100 - pct.reduce(function (a, b) { return a + b; }, 0);
  return parts.map(function (a, i) { return [a[0], pct[i]]; });
}

/* ---- 行星类型库（16 型）----
 * 判定字段（resolvePlanetType 按表序扫描，先命中者胜；条件文本由这些字段实时生成，
 * 所以改数据 = 指导书与面板同步，不会脱节）：
 *   kind   rock 岩质 / giant 巨行星
 *   t0/t1  T_eq0 气候带区间 [下界, 上界) K —— T_eq0 = 基准反照率 0.3 的平衡温度
 *   water  挥发分丰度区间（省略 = 不限）    metal 金属丰度下限
 *   atmoMin 大气厚度下限                    rMax 半径上限 R⊕
 *   carbon 需「碳抽签」命中
 * 物理字段：albedo 真实反照率 · green 温室系数（T_surf = T_eq·green）
 *   rRange 岩质半径区间 R⊕ / massRange 巨行星质量区间 M⊕ · dens 平均密度 g/cm³
 * 展示字段：atmo 大气成分 · atmoP 气压档 · surface 表面成分 · color 色点
 *   tex 贴图模式 · pal 表面调色板（[底色, 低, 中, 高] 由暗到亮） */
var PLANET_TYPES = [
  { id: "carbon", name: "碳行星", kind: "rock", t0: 0, t1: 9e9, carbon: true,
    rRange: [0.5, 2.2], albedo: 0.09, green: 1.10, dens: 4.2,
    atmo: "CO · CH₄（稀薄）", atmoP: "稀薄", surface: "碳化硅 · 石墨地幔（碳 > 50%）",
    color: 0x3a3740, tex: "rock", pal: ["#1e1c22", "#2b2830", "#403c48", "#565064"] },

  { id: "iron", name: "铁行星", kind: "rock", t0: 0, t1: 9e9, water: [0, 0.08], metal: 0.66,
    rRange: [0.3, 1.1], albedo: 0.12, green: 1.00, dens: 7.9,
    atmo: "无", atmoP: "无", surface: "铁镍核裸露 · 硅酸盐壳被剥离",
    color: 0x9a9490, tex: "metal", pal: ["#5a5450", "#7a7068", "#9a9088", "#c0b6aa"] },

  { id: "dwarf", name: "矮行星", kind: "rock", t0: 0, t1: 9e9, rMax: 0.45,
    rRange: [0.12, 0.45], albedo: 0.35, green: 1.00, dens: 2.6,
    atmo: "无（或极稀薄）", atmoP: "无", surface: "岩冰混合 · 未能成球",
    color: 0xa8a49c, tex: "rock", pal: ["#6a6660", "#8a8880", "#a8a49c", "#c4bfb4"] },

  { id: "lava", name: "熔岩行星", kind: "rock", t0: 1000, t1: 9e9,
    rRange: [0.4, 2.4], albedo: 0.10, green: 1.25, dens: 5.6,
    atmo: "SO₂ · 岩石蒸气", atmoP: "稀薄", surface: "硅酸盐熔岩海 · 昼夜翻涌",
    color: 0xd4502a, tex: "lava", pal: ["#180d0a", "#2e1a13", "#ff7a2a", "#ffc06a"] },

  { id: "greenhouse", name: "温室行星", kind: "rock", t0: 265, t1: 9e9, atmoMin: 0.60,
    rRange: [0.5, 2.4], albedo: 0.72, green: 2.95, dens: 5.2,
    atmo: "CO₂（浓密 · 数十至百 bar）", atmoP: "浓密", surface: "玄武岩平原 · 硫酸云顶",
    color: 0xd9b06a, tex: "venus", pal: ["#a8823f", "#c9a35f", "#e0c48a", "#f4e2bc"] },

  { id: "hotrock", name: "炽岩行星", kind: "rock", t0: 470, t1: 1000,
    rRange: [0.4, 2.2], albedo: 0.12, green: 1.00, dens: 5.0,
    atmo: "无（被恒星风剥离）", atmoP: "无", surface: "裸露玄武岩 · 撞击坑密布",
    color: 0xa8604a, tex: "rock", pal: ["#4a2a20", "#6e3c2c", "#8f5540", "#b8705a"] },

  { id: "barren", name: "荒芜行星", kind: "rock", t0: 88, t1: 470, atmoMax: 0.18, water: [0, 0.15],
    rRange: [0.3, 1.8], albedo: 0.14, green: 1.00, dens: 4.0,
    atmo: "无（真空）", atmoP: "无", surface: "裸岩 · 厚风化层 · 撞击坑",
    color: 0x8c8a84, tex: "rock", pal: ["#48463f", "#66645d", "#8c8a84", "#aaa69c"] },

  { id: "ocean", name: "海洋行星", kind: "rock", t0: 232, t1: 326, water: [0.62, 9],
    rRange: [0.7, 2.4], albedo: 0.18, green: 1.10, dens: 4.6,
    atmo: "N₂ · H₂O（浓密 · 云量高）", atmoP: "浓密", surface: "全球海洋（覆盖 > 90%）",
    color: 0x3f7fbf, tex: "ocean", pal: ["#0f3f66", "#1d5c92", "#2f7fb8", "#5aa0cc"] },

  { id: "terra", name: "类地行星", kind: "rock", t0: 232, t1: 326, water: [0.28, 9],
    rRange: [0.45, 2.0], albedo: 0.30, green: 1.13, dens: 5.5,
    atmo: "N₂ · O₂（约 1 bar）", atmoP: "适中", surface: "硅酸盐大陆 + 液态水海洋",
    color: 0x5a9e6f, tex: "terra", pal: ["#12324f", "#3f7a4a", "#5f9a52", "#8aa860"] },

  { id: "desert", name: "沙漠行星", kind: "rock", t0: 232, t1: 470,
    rRange: [0.4, 2.0], albedo: 0.35, green: 1.05, dens: 5.2,
    atmo: "CO₂（稀薄）", atmoP: "稀薄", surface: "硅酸盐沙丘 · 干涸河床",
    color: 0xc9a35f, tex: "desert", pal: ["#8a6a33", "#b3833f", "#c9a35f", "#e2c894"] },

  { id: "tundra", name: "冻原行星", kind: "rock", t0: 172, t1: 232,
    rRange: [0.4, 2.2], albedo: 0.45, green: 1.05, dens: 5.3,
    atmo: "N₂ · CO₂（稀薄）", atmoP: "稀薄", surface: "冻土 · 季节性冰盖进退",
    color: 0x9fb0b4, tex: "ice", pal: ["#4f5a60", "#75828a", "#9fb0b4", "#ccd8dc"] },

  { id: "ice", name: "冰封行星", kind: "rock", t0: 88, t1: 172,
    rRange: [0.4, 2.2], albedo: 0.62, green: 1.00, dens: 4.9,
    atmo: "N₂ · CH₄（稀薄）", atmoP: "稀薄", surface: "水冰壳（下覆液态海洋）",
    color: 0xcfe4f0, tex: "ice", pal: ["#7f9cae", "#a8c8dc", "#cfe4f0", "#eef7fc"] },

  { id: "cryo", name: "冰冻世界", kind: "rock", t0: 0, t1: 88,
    rRange: [0.3, 1.8], albedo: 0.70, green: 1.00, dens: 2.1,
    atmo: "近乎真空（N₂ 凝华）", atmoP: "无", surface: "N₂ · CH₄ · CO 冰原",
    color: 0xdfe9f5, tex: "cryo", pal: ["#93a2bd", "#b8c6dc", "#dfe9f5", "#ffffff"] },

  { id: "hotjupiter", name: "热木星", kind: "giant", t0: 900, t1: 9e9,
    massRange: [80, 700], albedo: 0.10, green: 1.15, dens: 0.9,
    atmo: "H₂ · He（受热膨胀 · 逃逸中）", atmoP: "浓密", surface: "无固体表面 · 硅酸盐云",
    color: 0xd2703a, tex: "hotjup", pal: ["#7a3016", "#b8501f", "#e08040", "#f4c088"] },

  { id: "gas", name: "气态巨行星", kind: "giant", t0: 170, t1: 900,
    massRange: [50, 450], albedo: 0.34, green: 1.12, dens: 1.3,
    atmo: "H₂ · He（浓密）", atmoP: "浓密", surface: "无固体表面 · 氨云顶",
    color: 0xc9a878, tex: "gas", pal: ["#8a6a44", "#b58a5c", "#c9a878", "#e6d4ac"] },

  { id: "icegiant", name: "冰巨星", kind: "giant", t0: 0, t1: 170,
    massRange: [6, 35], albedo: 0.30, green: 1.05, dens: 1.6,
    atmo: "H₂ · He · CH₄（甲烷致青）", atmoP: "浓密", surface: "无固体表面 · 水氨幔",
    color: 0x7fb6d9, tex: "icegiant", pal: ["#4f88b0", "#6aa6cc", "#93c6e2", "#bce0f0"] }
];
/* 行星类型表 → 注册表（v0.7）：结构查重 + 语义体检见 src/15-registry.js。
 * 表序 = 判定优先级，first() 取第一个命中 —— 顺序写在数组里，不在代码里。 */
var PlanetTypes = makeRegistry("行星类型", {
  required: ["id", "name", "kind", "t0", "t1", "albedo", "green", "dens", "atmo", "atmoP", "surface", "color", "tex", "pal"],
  checks: [
    RegChecks.color("color"),
    RegChecks.range("albedo", 0.001, 1),
    RegChecks.range("green", 1, 10),
    RegChecks.range("dens", 0.01, 30),
    function (list) {
      var bad = [];
      list.forEach(function (t) {
        if (!(t.t1 > t.t0)) bad.push("「" + t.id + "」气候带窗口倒置：[" + t.t0 + ", " + t.t1 + ")");
        if (!t.rRange && !t.massRange) bad.push("「" + t.id + "」既没有 rRange 也没有 massRange");
        if (!t.pal || t.pal.length < 2) bad.push("「" + t.id + "」调色板少于 2 色");
        if (!t.comp) bad.push("「" + t.id + "」缺参考构成（TYPE_COMP 未覆盖该 id）");
      });
      return bad;
    }
  ]
}).addAll(PLANET_TYPES);

/* 按 id 索引（注册表自带；保留这个短别名 —— 全项目几十处引用它） */
var PT_BY_ID = PlanetTypes.byId;

/* 各型的典型内部构成（参考数据，指导书行星库用）。
 * 注意与「某颗行星的构成」区分：这里是类型的标定描述，具体占比由 buildComposition
 * 按该行星自己的金属/挥发分丰度与表面温度现算 —— 面板「构成」行读的是后者。 */
var TYPE_COMP = {
  carbon: "石墨地幔 + 碳化硅壳 · 铁核极小",
  iron: "铁镍核 ≈ 70% · 硅酸盐幔被剥离殆尽",
  dwarf: "岩冰混合 · 未完成分异（无金属核）",
  lava: "硅酸盐熔融幔 + 铁核 · 挥发分已蒸干",
  greenhouse: "硅酸盐幔 + 铁镍核 · CO₂ 大气 < 0.01% 质量",
  hotrock: "玄武岩壳 + 铁核 · 无挥发分储库",
  barren: "硅酸盐岩壳 + 铁镍核 · 挥发分 < 1%",
  ocean: "挥发分 > 25% · 全球水幔覆铁核",
  terra: "硅酸盐幔 + 铁镍核 + 液态水圈",
  desert: "硅酸盐地壳 + 铁核 · 挥发分已逃逸",
  tundra: "岩壳 + 铁核 · 水以冰与冻土封存",
  ice: "水冰壳 + 液态水层 + 岩核",
  cryo: "N₂ · CH₄ 冰壳 + 岩核 · 挥发分凝华",
  hotjupiter: "H₂·He 包层 + 硅酸盐云 · 岩石核",
  gas: "H₂·He 包层 ≈ 90% · 冰与岩石核",
  icegiant: "水·氨·甲烷幔 ≈ 80% + 岩石核"
};
PLANET_TYPES.forEach(function (t) { t.comp = TYPE_COMP[t.id] || ""; });

/* 类型判定：按表序扫描，第一个条件全中的胜出（先特殊、后一般）。
 * 扫描本身交给注册表的 first()（顺序语义在表里，机制在 15-registry.js）。 */
function resolvePlanetType(c) {
  var hit = PlanetTypes.first(function (t) {
    if (t.kind !== c.bulk) return false;
    if (c.teq0 < t.t0 || c.teq0 >= t.t1) return false;
    if (t.water && !(c.water >= t.water[0] && c.water < t.water[1])) return false;
    if (t.metal !== undefined && c.metal < t.metal) return false;
    if (t.atmoMin !== undefined && c.atmo < t.atmoMin) return false;
    if (t.atmoMax !== undefined && c.atmo >= t.atmoMax) return false;
    if (t.rMax !== undefined && c.rE >= t.rMax) return false;
    if (t.carbon && !c.carbon) return false;
    return true;
  });
  return hit || PT_BY_ID.barren;              /* 兜底型：荒芜行星 */
}
/* 条件文本：由判定字段实时生成（指导书「形成条件」列），改数据即同步 */
function typeCond(t) {
  if (t.carbon) return "碳/硅比异常（稀有）";
  if (t.metal !== undefined) return "铁镍丰度 > " + Math.round(t.metal * 100) + "% 且贫挥发分";
  if (t.rMax !== undefined) return "半径 < " + t.rMax + " R⊕（引力未能圆化）";
  var s = "T_eq0 " + t.t0 + "–" + (t.t1 > 1e6 ? "∞" : t.t1) + " K";
  if (t.atmoMin !== undefined && t.atmoMin > 0) s += " · 大气 " + (t.atmoMin > 0.55 ? "浓密" : "存在");
  else if (t.atmoMax !== undefined) s += " · 真空（无大气）";
  else if (t.water) s += t.water[0] >= 0.5 ? " · 富挥发分"
    : (t.water[0] >= 0.15 ? " · 湿润" : " · 贫挥发分");
  return s;
}

/* ---- 构建版本：单一数据源 ----
 * 同时写入 ① 右下角版本戳（#ver）② __game.version。
 * 用途：一眼判断「眼前这页是不是最新构建」——历史上出现过改了代码但浏览器
 * 没刷新、误判「功能没生效」的情况。发版时只改这一行。 */
var VERSION = "0.19.0";

function $(id) { return document.getElementById(id); }
function fmtNum(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
function cssOf(hex) { return "#" + ("000000" + hex.toString(16)).slice(-6); }
var NAME_SYLL = ["开阳", "北斗", "天狼", "参宿", "心月", "青云", "紫微", "太微", "荧惑", "岁星",
  "辰星", "镇星", "轩辕", "毕宿", "角宿", "亢宿", "房宿", "尾宿", "箕斗", "牛郎",
  "织女", "河鼓", "天津", "阁道", "腾蛇", "翼火", "奎木", "娄金", "胃土", "崴海",
  "扶摇", "沧澜", "朔风", "赤霄", "玄墨", "苍梧", "白泽", "麒麟", "蓬莱", "方壶",
  "瀛洲", "岱舆", "员峤", "扶桑", "若木", "归墟", "光年", "薄曙", "长庚", "启明"];


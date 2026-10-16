/* ================= 全局状态 ================= */
var G = {
  sys: null,                  // 唯一星系
  selectedPlanet: null,       // 单击选中的行星
  selectedStar: false,        // 是否选中恒星
  focusPlanet: null,          // 相机正在跟随的行星（双击聚焦）
  holdTarget: false           // 测试 / 截图用：暂缓目标点回中
};
var __frames = 0;

/* ================= 星系生成（确定性：每次打开同一个星系） ================= */

/* 视觉公转角速度 = 真实开普勒关系的等比缩放（同一条 1/a^1.5 幂律）：
 * 真实周期是天量级，无法直接观看；取系数使最内行星约 40 秒一周，
 * 于是「内侧显著快于外侧」这一开普勒特征在画面上依然成立。 */
var VIS_ORBIT_K = 10.2;

/* 主序列只抽「决定世界骨架」的十一个值，且一抽一用、顺序固定。
 * 贴图细节 / 环 / 云全部走本行星专属随机流（见 行星贴图 一节），
 * 所以以后调整贴图算法不会让行星布局漂移。 */
function genPlanets(sysName, n, star) {
  var out = [];
  for (var i = 0; i < n; i++) {
    var d = {
      orbit: 16 + i * 9.5 + rand(-1.2, 1.2),   // 视觉轨道半径
      rR: rng(),      // 半径抽值
      wR: rng(),      // 挥发分抽值
      mR: rng(),      // 金属丰度抽值
      aR: rng(),      // 大气厚度抽值
      cR: rng(),      // 碳抽签
      gR: rng(),      // 巨行星判定
      tR: rng(),      // 潮汐锁定半径
      sR: rng(),      // 自转周期
      iR: rng(),      // 轨道倾角
      pR: rng(),      // 起始相位
      sdR: rng()      // 贴图随机流种子
    };
    out.push(planetPhysics(sysName, i, d, star));
  }
  return out;
}

/* 由轨道 + 抽取值算出全部物理量（唯一入口：面板 / 贴图 / 指导书都读这里） */
function planetPhysics(sysName, i, d, star) {
  var au = d.orbit / VIS_PER_AU;
  var teq0 = eqTemp(star, au, 0.30);             /* 气候带判据：基准反照率 0.3 */
  var distT = clamp01((d.orbit - 13) / 46);      /* 0 = 最内 · 1 = 最外 */

  /* 组分 —— 决定形态，也和温度共同决定类型。两条相反的梯度，正是原行星盘的真实格局：
   *   挥发分随距离上升（雪线外侧才留得住冰）
   *   金属丰度随距离下降（难熔物质先在热的内侧凝结 —— 水星铁核占 63%、地球 32%、外带更贫铁）
   * 各自再叠一次自身散布，避免同心圆式的刻板结果。 */
  var water = clamp01((0.16 + 0.66 * distT) * (0.25 + 1.5 * d.wR));
  var atmo = clamp01(water * 0.45 + d.aR * 0.75);  /* 大气 = 挥发分 + 独立抽签 */
  var metal = clamp01((0.62 - 0.52 * distT) * (0.45 + 1.1 * d.mR));

  /* 巨行星形成概率随距离上升（外侧固体物质更多） */
  var bulk = d.gR < (0.05 + 0.40 * distT) ? "giant" : "rock";

  var c = { bulk: bulk, teq0: teq0, water: water, metal: metal, atmo: atmo, rE: 99, carbon: false };
  var type, rE, mE;
  if (bulk === "giant") {
    type = resolvePlanetType(c);
    var mr = type.massRange;
    mE = mr[0] + (mr[1] - mr[0]) * Math.pow(d.rR, 1.6);      /* 质量重尾：小质量更常见 */
    rE = (type.id === "icegiant" ? iceGiantRadius(mE) : giantRadius(mE));
    if (type.id === "hotjupiter") rE *= 1.12;                /* 受热膨胀 */
  } else {
    /* 半径取三角分布（峰值 ≈ 1.1 R⊕）：类地尺度最常见，迷你行星与超级地球两端渐稀 */
    rE = 0.22 + 1.75 * triU(d.rR);
    c.rE = rE;
    c.carbon = d.cR < 0.035;
    type = resolvePlanetType(c);
    /* 质量要等类型定下来再算：挥发分算不算数，取决于该型有没有大气顶着（atmoP） */
    mE = rockyMass(rE, metal, water, type.atmoP);
  }

  /* 真实温度：该型自身的反照率 → 真实平衡温度；再乘温室系数 → 表面温度。
   * 金星之所以 737 K 而地球 288 K，差别全在这两步。 */
  var teq = eqTemp(star, au, type.albedo);
  var tSurf = teq * type.green;

  /* 构成（质量占比）：放在温度之后算 —— 挥发分的相态取决于表面温度 */
  var comp = buildComposition({
    kind: type.kind, typeId: type.id, atmoP: type.atmoP,
    mE: mE, water: water, metal: metal, tempSurf: tSurf
  });

  /* 轨道（开普勒第三定律 → 周期 → 速度） */
  var periodDays = keplerDays(au, star.massSol, mE);
  var vOrbit = orbitKms(au, periodDays);

  /* 自转：潮汐锁定半径以内 → 同步自转（一边永昼、一边永夜）。
   * 锁定半径 ∝ M★^(1/3)，再乘一次潮汐耗散的不确定性系数（0.8–1.3）。 */
  var lockR = 0.8 + 0.5 * d.tR;
  var tidal = au < 0.075 * Math.pow(star.massSol, 1 / 3) * lockR;
  var rotFree = 6 + Math.pow(d.sR, 0.7) * 60;      /* 自由自转周期 6–66 小时 */
  var rotH = tidal ? periodDays * 24 : rotFree;

  return {
    idx: i,
    name: sysName + " " + roman(i + 1),
    seed: 1 + Math.floor(d.sdR * 2e9),
    bulk: bulk, type: type,
    /* 轨道 */
    orbit: d.orbit, au: au, incl: (d.iR - 0.5) * 0.28, angle: d.pR * Math.PI * 2,
    /* ★ v0.14：偏心率（0 = 圆轨道；>0 走椭圆解算 —— 恒星位于椭圆的一个焦点） */
    ecc: 0,
    periodDays: periodDays, vOrbit: vOrbit,
    orbitSpeed: VIS_ORBIT_K / Math.pow(d.orbit, 1.5),
    /* 组分 */
    water: water, atmo: atmo, metal: metal, carbon: !!c.carbon,
    iron: bulk === "giant" ? 0 : rockyParts(metal, water, type.atmoP).iron,
    comp: comp,
    /* 物理量 */
    rE: rE, mE: mE, radiusKm: rE * 6371, dens: 5.514 * mE / (rE * rE * rE),
    g: gravG(mE, rE), vEsc: escKms(mE, rE),
    insol: insolation(star, au), teq: teq, teq0: teq0, tempSurf: tSurf,
    rotH: rotH, rotFree: rotFree, lockR: lockR, tidal: tidal,
    /* 视觉 */
    spin: clamp(6 / rotH, 0.08, 0.9),
    size: clamp(0.92 * Math.pow(rE, 0.42), 0.42, 2.6)
  };
}

function genSystem() {
  var name = pick(NAME_SYLL);
  var starType = weightedPick(STAR_TYPES);
  G._starRoll = +weightedPick.lastR.toFixed(6);   // 恒星级抽值（确定性回归用）
  G._starDraws = rngDraws;                        // 抽到星型时的累计抽数（序列锚点）
  var planets = genPlanets(name, irand(5, 7), starType);
  /* ★ v0.14：外围增补行星（用户：测试星系行星太少了）—— 走**专属流**，不消耗主序列。
   * 主序列在星型抽出之后还要被「发源地 / 星海 / 陨石带」连续消费：在中间多抽
   * 一格，后面全部整体错位（确定性守恒，见 README §四）。专属流与主种子同源
   * （10-core 的 mulberry32(20261014)）—— 同一次抽签永远长出同一个星系。 */
  planets = planets.concat(genExtraPlanets(name, planets.length, starType));
  /* ★ v0.14：卫星登记（每颗行星一份；细节走本行星派生流 —— 同样不碰主序列） */
  planets.forEach(function (p) { genMoons(p); });
  return { name: name, starType: starType, planets: planets };
}

/* ---- v0.14：外围增补行星（3 颗，含椭圆轨道）----
 * 抽值口径与 genPlanets 完全一致（同一组字段，直接喂 planetPhysics），
 * 物理上与被主序列抽出的行星没有任何差别；唯一的不同是随机来源。
 * 类型取向：前两颗强制岩质（其一高偏心 ——「椭圆轨道行星」的确定性样本），
 * 第三颗强制巨行星（外带巨行星，与行星盘模型一致，也当卫星的宿主）。 */
var EXTRA_SEED = 20261014;                    /* 与主种子同源（10-core 的 mulberry32(20261014)） */
function genExtraPlanets(sysName, start, star) {
  var xr = seedStream(EXTRA_SEED, 0x9E4B0A17);
  var out = [];
  for (var k = 0; k < 3; k++) {
    var d = {
      orbit: 16 + (start + k) * 9.5 + (xr() - 0.5) * 2.4,   // 顺势外延（间距与内侧一致）
      rR: xr(), wR: xr(), mR: xr(), aR: xr(), cR: xr(),
      gR: k === 2 ? 0.02 : 0.88,                            // 岩 · 岩 · 巨
      tR: xr(), sR: xr(), iR: xr(), pR: xr(), sdR: xr()
    };
    var p = planetPhysics(sysName, start + k, d, star);
    /* 偏心率：一颗轻椭圆 + 一颗显著椭圆（近日掠过 / 远日慢行）+ 一颗近圆 */
    p.ecc = k === 0 ? +(0.08 + xr() * 0.08).toFixed(4)
      : k === 1 ? +(0.24 + xr() * 0.10).toFixed(4)
        : +(xr() * 0.05).toFixed(4);
    if (k === 2) p._extraTail = true;                       // 最外一颗（genMoons 的卫星宿主之一）
    out.push(p);
  }
  return out;
}

/* ================= three.js 基础 ================= */
var canvas = document.getElementById("scene");
var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x000000, 1);   // 纯黑：与 UI 的黑白体系一致（原为蓝黑 #05070d）

var scene = new THREE.Scene();
var camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.5, 2000);

function makeOrbit(theta, phi, radius, minR, maxR) {
  return { theta: theta, phi: phi, radius: radius, minR: minR, maxR: maxR, target: new THREE.Vector3(0, 0, 0) };
}
var orbit = makeOrbit(0.9, 1.12, 92, 16, 260);
var camGoalRadius = 92;            // 相机半径目标（双击聚焦/回全景时平滑过渡）

function applyOrbit(cam, o) {
  o.phi = clamp(o.phi, 0.12, Math.PI - 0.12);
  o.radius = clamp(o.radius, o.minR, o.maxR);
  var sinPhi = Math.sin(o.phi);
  cam.position.set(
    o.target.x + o.radius * sinPhi * Math.sin(o.theta),
    o.target.y + o.radius * Math.cos(o.phi),
    o.target.z + o.radius * sinPhi * Math.cos(o.theta)
  );
  cam.lookAt(o.target);
}


/* ================= 场景 ================= */
var systemGroup = new THREE.Group();
var systemT = 0;                  // 装饰动画时钟（真实秒）

function buildStarfield(sc) {
  var n = 1600, pos = new Float32Array(n * 3), i;
  for (i = 0; i < n; i++) {
    var r = rand(700, 1150), th = rand(0, Math.PI * 2), ph = Math.acos(rand(-1, 1));
    pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
    pos[i * 3 + 1] = r * Math.cos(ph) * 0.55;
    pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
  }
  var geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  var mat = new THREE.PointsMaterial({
    color: 0x9fb4d8, size: 1.5, sizeAttenuation: false,
    transparent: true, opacity: 0.8, depthWrite: false
  });
  sc.add(new THREE.Points(geo, mat));
}

/* 背景：星海 + 星云（只建一次，不进 systemGroup） */
function buildBackdrop() {
  scene.add(systemGroup);
  scene.add(new THREE.AmbientLight(0xa8c0e8, 0.5));
  buildStarfield(scene);
  var nebs = [
    { c: 0x4a3a8a, x: -480, y: 160, z: -620, s: 950, o: 0.20 },
    { c: 0x1a5a6a, x: 620, y: -120, z: -420, s: 820, o: 0.16 },
    { c: 0x6a3a7a, x: 180, y: 340, z: 560, s: 1050, o: 0.13 }
  ];
  nebs.forEach(function (n) {
    var sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: nebT, color: n.c, transparent: true, opacity: n.o,
      depthWrite: false, blending: THREE.AdditiveBlending
    }));
    sp.position.set(n.x, n.y, n.z);
    sp.scale.set(n.s, n.s, 1);
    scene.add(sp);
  });
}

/* 空间站 / 防务平台 / 交通船 / 彗星模型已移除（v0.5：聚焦恒星与行星舞台） */

/* ---- 恒星视觉：按 klass 组装（可被 setStarType 重建） ----
 * 等离子球（ms/giant/supergiant/bd/wd/ns）= shader 表面 + 双层光晕；
 * 黑洞 = 黑色事件视界 + 暖色吸积光晕 + 光子环（不生成等离子表面）。 */
var STAR_VIS = {
  bh: { inOp: 0.85, outOp: 0.30, inMul: 2.35, outMul: 5.6, inCol: 0xffb070, outCol: 0xff8a50, light: 1.1 },
  ns: { inOp: 0.95, outOp: 0.34, inMul: 3.6, outMul: 9.0, inCol: 0xcfe6ff, outCol: 0xbfe4ff, light: 2.3 },
  wd: { inOp: 0.90, outOp: 0.26, inMul: 3.1, outMul: 6.6, inCol: null, outCol: 0xdceaff, light: 2.0 },
  bd: { inOp: 0.55, outOp: 0.14, inMul: 2.6, outMul: 5.2, inCol: null, outCol: null, light: 1.4 },
  supergiant: { inOp: 0.75, outOp: 0.22, inMul: 3.0, outMul: 7.2, inCol: null, outCol: 0xffe6b8, light: 2.3 }
};
var STAR_VIS_DEFAULT = { inOp: 0.8, outOp: 0.24, inMul: 2.9, outMul: 6.0, inCol: null, outCol: 0xffe6b8, light: 2.1 };

function buildStarVisual(sys) {
  var st = sys.starType;
  var Rg = st.size * 2.1;
  var smat = st.mat || {};
  var klass = st.klass || "ms";
  var v = STAR_VIS[klass] || STAR_VIS_DEFAULT;

  // 表面
  if (klass === "bh") {
    sys._star = new THREE.Mesh(new THREE.SphereGeometry(Rg, 48, 32),
      new THREE.MeshBasicMaterial({ color: 0x04050a }));
  } else {
    var star = new THREE.Mesh(new THREE.SphereGeometry(Rg, 64, 48), starSurfaceMaterial(st.color, smat));
    star.rotation.z = 0.4;
    sys._star = star;
  }
  systemGroup.add(sys._star);

  // 光晕（屏幕朝向径向渐变精灵：恒为圆形、无硬边——「干净球体」的保障）
  var glowIn = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTex, color: v.inCol == null ? st.color : v.inCol, transparent: true, opacity: v.inOp,
    depthWrite: false, blending: THREE.AdditiveBlending
  }));
  glowIn.scale.set(Rg * v.inMul, Rg * v.inMul, 1);
  glowIn.userData.base = Rg * v.inMul;
  glowIn.userData.op = v.inOp;
  sys._glowIn = glowIn;
  systemGroup.add(glowIn);

  var glowOut = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTex, color: v.outCol == null ? st.color : v.outCol, transparent: true, opacity: v.outOp,
    depthWrite: false, blending: THREE.AdditiveBlending
  }));
  glowOut.scale.set(Rg * v.outMul, Rg * v.outMul, 1);
  glowOut.userData.base = Rg * v.outMul;
  glowOut.userData.op = v.outOp;
  sys._glowOut = glowOut;
  systemGroup.add(glowOut);

  // 光子环（黑洞专属）
  sys._photon = null;
  if (klass === "bh") {
    var ph = new THREE.Sprite(new THREE.SpriteMaterial({
      map: photonT, color: 0xffd9a8, transparent: true, opacity: 0.8,
      depthWrite: false, blending: THREE.AdditiveBlending
    }));
    ph.scale.set(Rg * 2.3, Rg * 2.3, 1);
    ph.userData.base = Rg * 2.3;
    sys._photon = ph;
    systemGroup.add(ph);
  }

  // 选中效果：科幻括号（呼吸淡入）+ 细环（缓慢旋转）
  var brk = new THREE.Sprite(new THREE.SpriteMaterial({
    map: bracketT, color: 0xffffff, transparent: true, opacity: 0,
    depthTest: false, depthWrite: false
  }));
  brk.scale.set(Rg * 2.75, Rg * 2.75, 1);
  brk.visible = false;
  brk.renderOrder = 6;
  sys._starSel = brk;
  systemGroup.add(brk);

  var sring = new THREE.Sprite(new THREE.SpriteMaterial({
    map: selRingT, color: 0xffffff, transparent: true, opacity: 0,
    depthTest: false, depthWrite: false
  }));
  sring.scale.set(Rg * 3.15, Rg * 3.15, 1);
  sring.visible = false;
  sring.renderOrder = 5;
  sys._starRing = sring;
  systemGroup.add(sring);

  // 光照
  var light = sys._light;
  if (!light) {
    light = new THREE.PointLight(0xffffff, 2.1, 0, 0);
    sys._light = light;
    systemGroup.add(light);
  }
  light.color.setHex(st.color).lerp(new THREE.Color(0xffffff), klass === "bh" ? 0.35 : 0.55);
  light.intensity = v.light;

  // 耀斑（自动触发受 flareRate 控制；黑洞 / 中子星 rate=0 不喷发）
  sys._pulse = 1;
  buildFlareSystem(sys, Rg, st.color);
  sys._flare.rate = smat.flareRate || 0;
  sys._nextFlare = smat.flareRate > 0 ? (8 + srng() * 6) / smat.flareRate : Infinity;
}

/* 拆掉旧恒星视觉（setStarType 重建前调用；共享贴图不销毁） */
function removeStarVisual(sys) {
  ["_star", "_glowIn", "_glowOut", "_photon", "_starSel", "_starRing"].forEach(function (k) {
    var o = sys[k];
    if (!o) return;
    systemGroup.remove(o);
    if (o.geometry) o.geometry.dispose();
    if (o.material) o.material.dispose();
    sys[k] = null;
  });
  if (sys._flare) {
    systemGroup.remove(sys._flare.pts);
    systemGroup.remove(sys._flare.flash);
    sys._flare.pts.geometry.dispose();
    sys._flare = null;
  }
}

/* 切换星系恒星类型（预览 / 调试；行星布局不动） */
function setStarType(id) {
  var t = null, i;
  for (i = 0; i < STAR_TYPES.length; i++) {
    if (STAR_TYPES[i].id === id) { t = STAR_TYPES[i]; break; }
  }
  if (!t || !G.sys) return false;
  removeStarVisual(G.sys);
  G.sys.starType = t;
  buildStarVisual(G.sys);
  recomputePlanets(G.sys);           // 换恒星 → 全部行星重新结算（温度/周期/速度/辐照）
  buildHZ(G.sys);                    // 宜居带随光度重画
  foundCivilizations(G.sys);         // ★ v0.8：温度变了 → 发源地重新选举（评分是温度的纯函数）
  syncCivBeacons();                  //   信标跟着搬：老发源地摘环、新发源地挂环
  renderPanel();
  /* 书开着时要跟着重渲染：三张插图的「本星系」标记、十一栏的实测数据都是现场读的 */
  if (FSM_OVERLAY.is("guide")) renderGuide();
  return true;
}

/* 宜居带标注：液态水可存在的轨道区间 —— 内缘 √(L/1.1)、外缘 √(L/0.53) AU。
 * 用虚线画，与 UI 的「虚线 = 标注而非实体」语义一致；换恒星后要重建。 */
function clearHZ(sys) {
  (sys._hzLines || []).forEach(function (ln) {
    systemGroup.remove(ln);
    ln.geometry.dispose();
    ln.material.dispose();
  });
  sys._hzLines = [];
}
function buildHZ(sys) {
  clearHZ(sys);
  var hzIn = Math.sqrt(sys.starType.lumSol / 1.1) * VIS_PER_AU;
  var hzOut = Math.sqrt(sys.starType.lumSol / 0.53) * VIS_PER_AU;
  sys._hz = [hzIn, hzOut];
  [hzIn, hzOut].forEach(function (r) {
    if (!isFinite(r) || r < 2 || r > 900) return;   // 黑洞/极暗天体没有宜居带
    var pts = [];
    for (var i = 0; i <= 128; i++) {
      var a = (i / 128) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r));
    }
    var ln = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineDashedMaterial({
        color: 0x8a8a8a, dashSize: 1.1, gapSize: 1.0, transparent: true, opacity: 0.40
      }));
    ln.computeLineDistances();
    sys._hzLines.push(ln);
    systemGroup.add(ln);
  });
}
/* 换恒星后重算行星的物理量（温度 / 周期 / 速度 / 辐照）——
 * 类型与外表是行星「出生时」的定局，不随恒星改变：恒星只改变它接到的能量。 */
/* 换恒星后重算每颗行星接收到的能量 —— 只改「受到什么」，不改「是什么」。
 * ★ 行星的**类型（＝形成时的身份）与构成占比是形成时定下的**，换恒星不会改写：
 *   铁镍核 / 硅酸盐幔 / 挥发分的质量占比一律照旧，会变的只有挥发分的**相态**
 *   —— 因为相态是当前表面温度的函数，而温度正是这次重算改掉的东西。
 *   所以构成要跟着重算，否则面板上的相态会停留在旧温度上。 */
function recomputePlanets(sys) {
  var st = sys.starType;
  sys.planets.forEach(function (p) {
    p.teq0 = eqTemp(st, p.au, 0.30);
    p.teq = eqTemp(st, p.au, p.type.albedo);
    p.tempSurf = p.teq * p.type.green;
    p.insol = insolation(st, p.au);
    p.periodDays = keplerDays(p.au, st.massSol, p.mE);
    p.vOrbit = orbitKms(p.au, p.periodDays);
    p.tidal = p.au < 0.075 * Math.pow(st.massSol, 1 / 3) * p.lockR;
    p.rotH = p.tidal ? p.periodDays * 24 : p.rotFree;
    p.comp = buildComposition({
      kind: p.bulk, typeId: p.type.id, atmoP: p.type.atmoP,
      mE: p.mE, water: p.water, metal: p.metal, tempSurf: p.tempSurf
    });
  });
}

function buildScene(sys) {

  // ---- 恒星本体（按 klass 组装：等离子球 / 黑洞视界） ----
  buildStarVisual(sys);

  // ---- 轨道环线（顶点色 = 亮度带：只有行星所在的弧段亮，其余退成暗线） ----
  sys.planets.forEach(function (p) {
    var pts = [], seg = 96;
    for (var i = 0; i <= seg; i++) {
      var a = (i / seg) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * p.orbit, 0, Math.sin(a) * p.orbit));
    }
    var geo = new THREE.BufferGeometry().setFromPoints(pts);
    geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array((seg + 1) * 3), 3));
    var line = new THREE.LineLoop(geo, new THREE.LineBasicMaterial({
      color: 0xffffff, vertexColors: true, transparent: true, opacity: 0.55
    }));
    line.rotation.x = -p.incl;
    p._orbitLine = line;
    p._orbitSeg = seg;
    systemGroup.add(line);
  });

  // ---- 宜居带（见 buildHZ） ----
  buildHZ(sys);

  // ---- 行星（纹理表面 / 大气 / 云层 / 行星环 / 卫星） ----
  sys.planets.forEach(function (p) {
    var grp = new THREE.Group();
    systemGroup.add(grp);
    p._group = grp;

    var maps = paintPlanetMaps(p);                  /* ← 贴图由行星物理数据算出 */
    var mat = new THREE.MeshLambertMaterial({ map: maps.map });
    if (maps.bumpMap) {
      /* 凹凸 = 同一个高程场（42-terrain.js 导出）—— 贴近时地形会被光照塑形。
       * 强度跟着「起伏」走：被大气磨平的世界不该有刀劈一般的阴影。 */
      mat.bumpMap = maps.bumpMap;
      mat.bumpScale = 0.19 * clamp(maps.params.relief, 0.35, 1.4);
    }
    if (maps.emissiveMap) {
      mat.emissive = new THREE.Color(0xff9a4a);
      mat.emissiveMap = maps.emissiveMap;
      mat.emissiveIntensity = 1.1;
    }
    var mesh = new THREE.Mesh(new THREE.SphereGeometry(p.size, 32, 24), mat);
    grp.add(mesh);
    p._mesh = mesh;

    /* 结构判定（行星环等）走本行星的派生流：不消耗主序列 */
    var rs = seedStream(p.seed, 0x5f356495);

    // 大气辉光：凡有可观大气的类型都描一圈自身色调的菲涅尔边（厚度由 atmo 定）
    if (p.atmo >= 0.22) {
      var atmo = new THREE.Mesh(
        new THREE.SphereGeometry(p.size * (1.05 + 0.07 * p.atmo), 24, 18),
        atmoMaterial(p.type.color, 0.25 + 0.55 * p.atmo)
      );
      grp.add(atmo);
      p._atmo = atmo;
    } else {
      p._atmo = null;
    }

    // 云层：大气够厚、且不是气态行星（本身已是云顶）或熔岩（水汽不凝）才有
    var cloudy = p.atmo >= 0.40 && p.bulk === "rock" && p.tempSurf < 700 && p.tempSurf > 150;
    if (cloudy) {
      var cloud = new THREE.Mesh(
        new THREE.SphereGeometry(p.size * 1.02, 24, 18),
        new THREE.MeshLambertMaterial({ map: cloudT, transparent: true, opacity: 0.25 + 0.5 * p.atmo, depthWrite: false })
      );
      grp.add(cloud);
      p._cloud = cloud;
    } else {
      p._cloud = null;
    }

    // 行星环：太阳系四颗巨行星都有环（土星最盛）→ 巨行星按质量给高概率，倾角随机
    var ringP = p.bulk === "giant" ? clamp(0.50 + p.mE / 1200, 0.50, 0.90) : 0;
    if (rs() < ringP) {
      var ring = new THREE.Mesh(
        new THREE.RingGeometry(p.size * 1.45, p.size * 2.5, 44),
        new THREE.MeshLambertMaterial({
          map: ringBandT, transparent: true, opacity: 0.85,
          side: THREE.DoubleSide, depthWrite: false
        })
      );
      ring.rotation.x = Math.PI / 2 + (rs() - 0.5) * 0.7;
      ring.rotation.y = rs() * Math.PI;
      grp.add(ring);
      p._ring = ring;
    } else {
      p._ring = null;
    }

    // 卫星：已随 v0.5 移除（原 p._moon 分支删除）

    // 选中效果：科幻括号（呼吸淡入，替代旧白色粗环）
    var sel = new THREE.Sprite(new THREE.SpriteMaterial({
      map: bracketT, color: 0xffffff, transparent: true, opacity: 0,
      depthTest: false, depthWrite: false
    }));
    sel.scale.set(p.size * 3.2, p.size * 3.2, 1);
    sel.visible = false;
    sel.renderOrder = 6;
    grp.add(sel);
    p._selRing = sel;
  });

  // ---- 小行星带（选最大的轨道间隙） ----
  var orbits = sys.planets.map(function (p) { return p.orbit; }).sort(function (a, b) { return a - b; });
  var gapR = 0, gapBest = 0;
  for (var gi = 0; gi < orbits.length - 1; gi++) {
    var mid = (orbits[gi] + orbits[gi + 1]) / 2, gap = orbits[gi + 1] - orbits[gi];
    if (gap > gapBest && mid > 24) { gapBest = gap; gapR = mid; }
  }
  sys._belt = null; sys._beltCount = 0;
  if (gapR > 0) {
    var belt = new THREE.Group();
    var beltMats = [
      new THREE.MeshLambertMaterial({ color: 0x8a8578 }),
      new THREE.MeshLambertMaterial({ color: 0x6f6a60 }),
      new THREE.MeshLambertMaterial({ color: 0x9a9488 })
    ];
    var rockGeo = new THREE.DodecahedronGeometry(0.24, 0);
    var count = 150;
    for (var bi = 0; bi < count; bi++) {
      var rock = new THREE.Mesh(rockGeo, pick(beltMats));
      var ra = rand(0, Math.PI * 2), rr = gapR + rand(-2.2, 2.2);
      rock.position.set(Math.cos(ra) * rr, rand(-0.9, 0.9), Math.sin(ra) * rr);
      rock.rotation.set(rand(0, 3), rand(0, 3), rand(0, 3));
      var sc = rand(0.5, 1.5);
      rock.scale.set(sc, sc * rand(0.6, 1), sc);
      belt.add(rock);
    }
    sys._belt = belt;
    sys._beltCount = count;
    systemGroup.add(belt);
  }

  // 空间站 / 防务平台 / 交通船 / 彗星：已随 v0.5 移除（聚焦恒星与行星舞台）

  updateScene(sys, 0);
}

/* ================= 场景更新 ================= */
var _tmpV = new THREE.Vector3();
var _tmpV2 = new THREE.Vector3();
var _upV = new THREE.Vector3(0, 1, 0);
var _zeroV = new THREE.Vector3(0, 0, 0);

function updateScene(sys, dt) {
  var eff = dt;
  systemT += dt;

  // ---- 恒星：表面流动 / 自转 / 光晕呼吸 / 脉冲 / 选中效果 ----
  sys._pulse += (1 - sys._pulse) * Math.min(1, dt * 2.0);
  var pulse = sys._pulse;
  var st = sys.starType;
  var klass = st.klass || "ms";
  if (sys._star) {
    sys._star.rotation.y += 0.025 * dt;
    if (sys._star.material.uniforms) sys._star.material.uniforms.uTime.value = systemT;
  }
  // 中子星：周期脉冲（自转灯塔效应）
  var blink = 1;
  if (klass === "ns") {
    var nph = systemT % 1.6;
    if (nph < 0.1) blink = 1 - Math.sin((nph / 0.1) * Math.PI) * 0.75;
  }
  // 黑洞：吸积盘明暗呼吸
  var shimmer = klass === "bh" ? 0.9 + 0.1 * Math.sin(systemT * 2.3) : 1;
  if (sys._glowIn) {
    var s1 = sys._glowIn.userData.base * (1 + 0.02 * Math.sin(systemT * 1.6) + (pulse - 1) * 0.5);
    sys._glowIn.scale.set(s1, s1, 1);
    sys._glowIn.material.opacity = sys._glowIn.userData.op * blink * shimmer * (1 + (pulse - 1) * 0.6);
  }
  if (sys._glowOut) {
    var s2 = sys._glowOut.userData.base * (1 + 0.035 * Math.sin(systemT * 1.6) + (pulse - 1) * 0.35);
    sys._glowOut.scale.set(s2, s2, 1);
    sys._glowOut.material.opacity = sys._glowOut.userData.op * blink * shimmer * (1 + (pulse - 1) * 0.4);
  }
  if (sys._photon) {
    var sph = sys._photon.userData.base * (1 + 0.02 * Math.sin(systemT * 2.3));
    sys._photon.scale.set(sph, sph, 1);
    sys._photon.material.opacity = 0.62 + 0.14 * Math.sin(systemT * 2.3);
  }
  // 恒星选中：科幻括号（呼吸淡入）+ 细环（旋转）
  if (sys._starSel) {
    var bm = sys._starSel.material;
    var bTo = G.selectedStar && selectionMarkVisible() ? 0.68 + 0.16 * Math.sin(systemT * 2.4) : 0;
    bm.opacity += (bTo - bm.opacity) * Math.min(1, dt * 8);
    sys._starSel.visible = bm.opacity > 0.02;
  }
  if (sys._starRing) {
    var rm = sys._starRing.material;
    var rTo = G.selectedStar && selectionMarkVisible() ? 0.28 + 0.08 * Math.sin(systemT * 1.7) : 0;
    rm.opacity += (rTo - rm.opacity) * Math.min(1, dt * 8);
    sys._starRing.visible = rm.opacity > 0.02;
    rm.rotation = systemT * 0.25;   // rm 即材质：四枚航迹点缓慢扫描
  }

  // 耀斑：自动间歇爆发（rate>0 时）+ 手动触发
  if (sys._flare) {
    if (sys._flare.rate > 0) {
      sys._nextFlare -= dt;
      if (sys._nextFlare <= 0 && !sys._flare.active) {
        triggerFlare(sys);
        sys._nextFlare = (7 + srng() * 9) / sys._flare.rate;
      }
    }
    updateFlare(sys, dt);
  }
  updateLensFlare();

  sys.planets.forEach(function (p) {
    p.angle += p.orbitSpeed * eff;
    var ci = Math.cos(p.incl), si = Math.sin(p.incl);
    var x = Math.cos(p.angle) * p.orbit, z0 = Math.sin(p.angle) * p.orbit;
    p._group.position.set(x, z0 * si, z0 * ci);

    /* 自转：潮汐锁定的行星不自转——它把**同一面**永远朝向恒星，
     * 贴图的日下点画在 u=0.25，故这里的相位取 -(angle + π/2)。
     * 未锁定的行星按自转周期转动（转得越快 spin 越大，由 rotH 算出）。 */
    if (p.tidal) {
      p._mesh.rotation.y = -(p.angle + Math.PI / 2);
    } else {
      p._mesh.rotation.y += p.spin * eff;
    }
    if (p._cloud) p._cloud.rotation.y += p.spin * 1.35 * eff;

    /* 聚焦 = 沉浸观察地表：云与大气雾按相机模式淡出（否则半透明白雾
     * 正好糊在要看的表面上 —— v0.11 首版的「聚焦仍糊」就是它）。
     * base 存在 userData 上，退出聚焦原样恢复。 */
    if (p._cloud) {
      if (p._cloud.userData.base === undefined) p._cloud.userData.base = p._cloud.material.opacity;
      p._cloud.material.opacity = p._cloud.userData.base * (FSM_CAMERA.is("focus") ? 0.30 : 1);
    }
    if (p._atmo) {
      if (p._atmo.userData.base === undefined) p._atmo.userData.base = p._atmo.material.uniforms.uRim.value;
      p._atmo.material.uniforms.uRim.value = p._atmo.userData.base * (FSM_CAMERA.is("focus") ? 0.55 : 1);
    }

    // 行星选中：科幻括号（呼吸淡入）
    if (p._selRing) {
      /* 选中效果：科幻括号（聚焦态下不显示 —— selectionMarkVisible 见 72-focus.js） */
      var sm = p._selRing.material;
      var sTo = (G.selectedPlanet === p && selectionMarkVisible()) ? 0.68 + 0.16 * Math.sin(systemT * 2.6) : 0;
      sm.opacity += (sTo - sm.opacity) * Math.min(1, dt * 9);
      p._selRing.visible = sm.opacity > 0.02;
    }
    /* 发源地信标：虚线环缓慢呼吸（虚线 = 标注而非实体，与宜居带同一套语义） */
    if (p._civRing) p._civRing.material.opacity = 0.30 + 0.12 * Math.sin(systemT * 1.7);
    /* 轨道线：顶点色 = 亮度带 —— 只有行星身后的一小段弧亮起，其余退成暗灰。
     * 选中时整条轨道一起提亮（黑白体系里不引入第二个色相）。 */
    if (p._orbitLine) {
      var on = (G.selectedPlanet === p);
      var col = p._orbitLine.geometry.attributes.color;
      for (var k = 0; k <= p._orbitSeg; k++) {
        var seg = (k / p._orbitSeg) * Math.PI * 2;
        var d = Math.abs(seg - p.angle) % (Math.PI * 2);
        if (d > Math.PI) d = Math.PI * 2 - d;
        var b = Math.max(0, 1 - d / 1.15);            /* 身后约 66° 的拖尾 */
        b = b * b;
        var lum = (on ? 0.30 : 0.10) + b * (on ? 0.70 : 0.42);
        col.setXYZ(k, lum, lum, lum);
      }
      col.needsUpdate = true;
      p._orbitLine.material.opacity = on ? 0.95 : 0.60;
    }
  });

  if (sys._belt) sys._belt.rotation.y += 0.018 * eff;
}


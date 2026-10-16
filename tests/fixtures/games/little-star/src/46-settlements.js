/* ===== 聚落系统（v0.13 · 实验性） ===== */

/* DESIGN.md §5 的落地点：在**聚焦档**的星球表面放置「聚落（城市）」。
 *
 * 实验性边界（本检查点）：
 *   ✅ B 键进「选址模式」→ 光标预览（可建/不可建）→ 点击放置 → 白盒楼群 + 全景点位标记
 *   ✅ 可建判定 = **连续场上的纯函数**（硬闸门：不是海 / 不是悬崖 / 不是极冠 / 不叠城）
 *   ✅ 选址评分（平坦 / 靠海 / 气候 / 可及 —— 「可及」暂用行星物理量的代理，
 *      将来接 28-materials 的「物资账 × 取率」，见 DESIGN §5.2）
 *   ✅ 数据是唯一真值源（p._cities）：几何 / 标记全部派生，重建地表后自愈
 *   ❌ 不做：删除 / 移动 / 命名（暂用 #编号）/ 科技树 / 编年史（下一轮）
 *
 * 契约纪律（README §五·8）：
 *   ① 连续场是唯一真值源 —— 落点从 hAt() 求，不读格子、不读几何顶点；
 *   ③ 边界用连续量等值线 —— 「不是海」= h ≤ sea 的等值线，不是格子判定；
 *   ④ 坡度从连续场梯度求（与 44 的解析法线同构造）；
 *   ⑦ worldToLocal 唯一转换点 —— 射线先变换到 _cs.mesh 局部系再做球面求交。
 *
 * 档位分工（DESIGN §5.4 方案 A）：
 *   聚焦档 = 真正的几何城市（挂 p._cs.mesh 下，随自转）；
 *   全景档 = 点位标记（LineSegments 线语言，挂 p._mesh 下 —— 聚焦时随网格一起隐藏）。
 */

/* ---- ① 表面几何查询（连续场 → 可见表面局部坐标） ---- */

/* 表面半径口径与 44 的行星几何逐字一致：海面 = size，陆地抬 amp×(h−0.5)。
 * 返回局部坐标（相对 p._group，即 _cs.mesh 的父坐标系）。 */
function focusSurfacePos(p, dir) {
  var cs = p._cs;
  var h = cs.field.hAt(dir[0], dir[1], dir[2]);
  var disp = h > 0.5 ? cs.amp * (h - 0.5) : 0;
  var rr = p.size * (1 + disp);
  return { pos: [dir[0] * rr, dir[1] * rr, dir[2] * rr], h: h, r: rr };
}

/* 坡度 = 连续场梯度的模（径向位移 / 单位表面弧长，无量纲）。与 44 pass 4 的
 * 解析法线同构造（两个正交切向 + 有限差分，步长 ≈ 一格）。 */
function focusSurfaceSlope(p, dir) {
  var cs = p._cs;
  var e = 0.9 * (Math.PI / 2) / cs.N;
  var vx = dir[0], vy = dir[1], vz = dir[2];
  var t1x = -vz, t1y = 0, t1z = vx;
  var t1L = Math.sqrt(t1x * t1x + t1z * t1z);
  if (t1L < 1e-6) { t1x = 1; t1y = 0; t1z = 0; t1L = 1; }
  t1x /= t1L; t1z /= t1L;
  var t2x = vy * t1z - vz * t1y, t2y = vz * t1x - vx * t1z, t2z = vx * t1y - vy * t1x;
  var f = cs.field;
  var h0 = f.hAt(vx, vy, vz);
  var ha = f.hAt(vx + t1x * e, vy + t1y * e, vz + t1z * e);
  var hb = f.hAt(vx + t2x * e, vy + t2y * e, vz + t2z * e);
  var s = p.size * cs.amp;
  var g1 = (ha - h0) * s / e, g2 = (hb - h0) * s / e;
  return Math.sqrt(g1 * g1 + g2 * g2);
}

/* ---- ② 连续场 ↔ 格子（DISIGN §5.3 的桥；格子 id 供显示与查重） ---- */

/* 方向 → 立方球「面 + 格坐标」。近似逆（面选择精确；u/v 未做面角反算 ——
 * 格子只作离散编号展示用，判重走角距离，不依赖这个逆的精度）。 */
function dirToCell(dir) {
  var ax = Math.abs(dir[0]), ay = Math.abs(dir[1]), az = Math.abs(dir[2]);
  var f, u, v;
  if (ax >= ay && ax >= az) {
    if (dir[0] > 0) { f = 0; u = -dir[2] / ax; v = dir[1] / ax; }
    else { f = 1; u = dir[2] / ax; v = dir[1] / ax; }
  } else if (ay >= az) {
    if (dir[1] > 0) { f = 2; u = dir[0] / ay; v = -dir[2] / ay; }
    else { f = 3; u = dir[0] / ay; v = dir[2] / ay; }
  } else {
    if (dir[2] > 0) { f = 4; u = dir[0] / az; v = dir[1] / az; }
    else { f = 5; u = -dir[0] / az; v = dir[1] / az; }
  }
  var N = FOCUS_N;
  var i = clamp(Math.floor((u + 1) * 0.5 * N), 0, N - 1);
  var j = clamp(Math.floor((v + 1) * 0.5 * N), 0, N - 1);
  return { face: f, i: i, j: j, id: "面" + f + "·" + i + "," + j };
}

/* 角距离（两方向的夹角）—— 「不叠城」闸门的判据 */
function dirAngle(a, b) {
  var d = clamp(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1, 1);
  return Math.acos(d);
}

/* ---- ③ 可建判定（纯函数：硬闸门 + 评分 —— DESIGN §5.2） ---- */

var SITE_SLOPE_MAX = 0.35;   /* 坡度闸门（无量纲斜率；45° = 1.0）*/
var SITE_MIN_GAP = 0.05;     /* 城间距：角距离 ≈ 2 格（格宽 = 90°/64 ≈ 0.0245 rad）*/

function siteCheck(p, dir) {
  var cs = p ? p._cs : null;
  if (!cs || !cs.field) return { ok: false, gate: "地表未构建", gates: ["地表未构建"], score: 0, parts: [] };
  var f = cs.field;
  var h = f.hAt(dir[0], dir[1], dir[2]);
  var pr = terrainParams(p);
  var lat = Math.abs(dir[1]);                       /* sin(纬度) 的近似 */
  var gates = [];

  /* 硬闸门（不满足 = 根本不能建） */
  if (cs.sea > 0 && h <= 0.5) gates.push("海面");
  var slope = focusSurfaceSlope(p, dir);
  if (slope > SITE_SLOPE_MAX) gates.push("悬崖（坡度过陡）");
  if (lat > 1 - pr.capFrac - 0.03) gates.push("极冠");
  var minD = 9;
  var cities = p._cities || [];
  for (var k = 0; k < cities.length; k++) {
    var d = dirAngle(dir, cities[k].dir);
    if (d < minD) minD = d;
  }
  if (cities.length && minD < SITE_MIN_GAP) gates.push("离已有聚落太近");

  /* 评分（100 制）—— 「可及」是实验性代理（行星级物理量），将来接物资账 */
  var parts = [];
  parts.push({ k: "平坦", v: Math.round(30 * clamp01(1 - slope / SITE_SLOPE_MAX)), max: 30, note: "坡度 " + slope.toFixed(2) });
  var tSea = cs.sea > 0 ? clamp01(1 - (h - 0.5) / 0.18) : 0.5;
  parts.push({ k: "靠海", v: Math.round(25 * tSea), max: 25, note: cs.sea > 0 ? (h <= 0.5 ? "海" : "海拔 " + h.toFixed(2)) : "无海" });
  var tClim = clamp01(1 - Math.max(0, lat - 0.45) / 0.40);
  parts.push({ k: "气候", v: Math.round(20 * tClim), max: 20, note: "纬度 " + (Math.asin(clamp(dir[1], -1, 1)) * 57.3).toFixed(0) + "°" });
  var tMat = clamp01(p.metal * 0.7 + (p.carbon ? 0.3 : 0));
  parts.push({ k: "可及", v: Math.round(25 * tMat), max: 25, note: "金属 " + Math.round(p.metal * 100) + "%" + (p.carbon ? " · 碳" : "") });
  var total = 0;
  for (var q = 0; q < parts.length; q++) total += parts[q].v;

  var cell = dirToCell(dir);
  return {
    ok: gates.length === 0, gate: gates[0] || null, gates: gates,
    h: h, slope: slope, lat: lat, cell: cell,
    score: total, parts: parts, minGap: minD
  };
}

/* ---- ④ 城市几何（白盒楼群 —— 一城一 Mesh，顶点色烘微明暗） ---- */

var _cityMat = null;
function cityMaterial() {
  if (!_cityMat) _cityMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
  return _cityMat;
}

/* 局部正交基（东 / 北 / 径向）——在局部系里摆放盒子 */
function _localFrame(dir) {
  var vx = dir[0], vy = dir[1], vz = dir[2];
  var t1x = -vz, t1y = 0, t1z = vx;
  var L = Math.sqrt(t1x * t1x + t1z * t1z);
  if (L < 1e-6) { t1x = 1; t1y = 0; t1z = 0; L = 1; }
  t1x /= L; t1z /= L;
  var t2x = vy * t1z - vz * t1y, t2y = vz * t1x - vx * t1z, t2z = vx * t1y - vy * t1x;
  return { e1: [t1x, t1y, t1z], e2: [t2x, t2y, t2z], n: [vx, vy, vz] };
}

/* 一栋楼：8 顶点 12 三角形（DoubleSide 免绕序）；顶点色按面法向与径向的关系烘明暗 */
function _pushBox(verts, cols, idx, frame, center, hw, hd, hh, base) {
  var e1 = frame.e1, e2 = frame.e2, n = frame.n;
  var e3 = n;
  var corners = [];
  for (var a = -1; a <= 1; a += 2) {
    for (var b = -1; b <= 1; b += 2) {
      for (var c = -1; c <= 1; c += 2) {
        corners.push([
          center[0] + e1[0] * hw * a + e2[0] * hd * b + e3[0] * hh * c,
          center[1] + e1[1] * hw * a + e2[1] * hd * b + e3[1] * hh * c,
          center[2] + e1[2] * hw * a + e2[2] * hd * b + e3[2] * hh * c
        ]);
      }
    }
  }
  for (var v = 0; v < 8; v++) { verts.push(corners[v][0], corners[v][1], corners[v][2]); }
  /* 顶点色的「明暗」按每个顶点在径向的高度：顶亮底暗（白盒的立体感）。
   * 顶点顺序 = (a,b,c) 三重循环 —— c 是最内层（bit0）：c=+1 亮 / c=−1 暗。 */
  for (var w2 = 0; w2 < 8; w2++) {
    var lum = 0.72 + 0.28 * (w2 & 1);
    cols.push(lum, lum, lum);
  }
  /* 6 面 × 2 三角形（8 顶点编号：(a,b,c) → 位 2a+4b+ c 的组合顺序
   *  0(-1,-1,-1) 1(-1,-1,1) 2(-1,1,-1) 3(-1,1,1)
   *  4(1,-1,-1) 5(1,-1,1) 6(1,1,-1) 7(1,1,1)） */
  var F = [
    [0, 1, 3, 2], [4, 6, 7, 5],      /* ±e1 */
    [0, 4, 5, 1], [2, 3, 7, 6],      /* ±e2 */
    [0, 2, 6, 4], [1, 5, 7, 3]       /* ±e3 */
  ];
  for (var fi = 0; fi < 6; fi++) {
    var f4 = F[fi];
    idx.push(base + f4[0], base + f4[1], base + f4[2], base + f4[0], base + f4[2], base + f4[3]);
  }
}

function buildCityGeometry(p, city) {
  var sp = focusSurfacePos(p, city.dir);
  var frame = _localFrame(city.dir);
  var R = p.size * 0.045;                 /* 城市量级（实验性：视觉优先的夸张比例） */
  var verts = [], cols = [], idx = [];
  var seed = (p.seed ^ 0x51fa3d) | 0;
  var k, base = 0;
  /* 主楼（中央）+ 4 栋副楼（环布）：参数全走 hash3i（确定性，零 RNG） */
  var nB = 5;
  for (k = 0; k < nB; k++) {
    var isMain = k === 0;
    var ang = hash3i(k, 1, 1, seed) * Math.PI * 2;
    var rad = isMain ? 0 : (0.35 + 0.55 * hash3i(k, 2, 2, seed)) * R;
    var hw = (isMain ? 0.30 : 0.13 + 0.10 * hash3i(k, 3, 3, seed)) * R;
    var hd = (isMain ? 0.30 : 0.13 + 0.10 * hash3i(k, 4, 4, seed)) * R;
    var hh = (isMain ? 0.52 : 0.18 + 0.24 * hash3i(k, 5, 5, seed)) * R;
    var ox = Math.cos(ang) * rad, oy = Math.sin(ang) * rad;
    var cx = sp.pos[0] + frame.e1[0] * ox + frame.e2[0] * oy + frame.n[0] * (hh * 0.92);
    var cy = sp.pos[1] + frame.e1[1] * ox + frame.e2[1] * oy + frame.n[1] * (hh * 0.92);
    var cz = sp.pos[2] + frame.e1[2] * ox + frame.e2[2] * oy + frame.n[2] * (hh * 0.92);
    _pushBox(verts, cols, idx, frame, [cx, cy, cz], hw, hd, hh, base);
    base += 8;
  }
  var geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(cols, 3));
  geo.setIndex(idx);
  return geo;
}

/* 城市 → 聚焦档 Mesh（挂 _cs.mesh 下：随自转、随聚焦显隐；重建后自愈） */
function syncCityMeshes(p) {
  if (!p._cs || !p._cities) return;
  for (var i = 0; i < p._cities.length; i++) {
    var city = p._cities[i];
    if (city._mesh && city._mesh.parent === p._cs.mesh) continue;
    city._mesh = new THREE.Mesh(buildCityGeometry(p, city), cityMaterial());
    p._cs.mesh.add(city._mesh);
    city.ms = city._mesh.geometry.attributes.position.count / 8;   /* 楼数（对账用） */
  }
}

/* ---- ⑤ 全景档点位标记（DESIGN §5.4 方案 A：退化为线语言，不新增 Mesh） ---- */

function ensureCityMarker(p, city) {
  if (city._marker || !p._mesh) return;
  var frame = _localFrame(city.dir);
  /* 小方框（4 段线 × 8 顶点），浮在表面上方一点 */
  var rr = p.size * 1.012;
  var cx = city.dir[0] * rr, cy = city.dir[1] * rr, cz = city.dir[2] * rr;
  var u = p.size * 0.06;   /* 标记半宽（占行星半径 6% —— 远景也要看得见） */
  var q = [
    [+1, +1], [-1, +1], [-1, +1], [-1, -1],
    [-1, -1], [+1, -1], [+1, -1], [+1, +1]
  ];
  var pos = [];
  for (var i = 0; i < 8; i++) {
    pos.push(
      cx + frame.e1[0] * u * q[i][0] + frame.e2[0] * u * q[i][1],
      cy + frame.e1[1] * u * q[i][0] + frame.e2[1] * u * q[i][1],
      cz + frame.e1[2] * u * q[i][0] + frame.e2[2] * u * q[i][1]
    );
  }
  var geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  var mat = new THREE.LineBasicMaterial({ color: 0xc9d1dd, transparent: true, opacity: 0.9 });
  city._marker = new THREE.LineSegments(geo, mat);
  p._mesh.add(city._marker);
}

/* ---- ⑥ 放置（唯一写入点：承诺 = 往 p._cities 里追加） ---- */

function placeCity(p, dir) {
  var chk = siteCheck(p, dir);
  if (!chk.ok) return { ok: false, gate: chk.gate, gates: chk.gates, check: chk };
  p._cities = p._cities || [];
  var city = {
    n: p._cities.length + 1,               /* 序号命名（实验性） */
    dir: [dir[0], dir[1], dir[2]],
    h: chk.h, slope: chk.slope,
    cell: chk.cell,
    score: chk.score, parts: chk.parts
  };
  p._cities.push(city);
  syncCityMeshes(p);
  ensureCityMarker(p, city);
  return { ok: true, city: city, count: p._cities.length };
}

/* ---- ⑦ 射线 → 表面方向（契约⑦：先变换到 _cs.mesh 局部系，再做球面迭代求交） ---- */

var _raycaster = new THREE.Raycaster();
var _siteInv = new THREE.Matrix4();

function rayToSurfaceDir(p, cx, cy) {
  var cs = p && p._cs;
  if (!cs || !cs.field) return null;
  var ndcX = (cx / window.innerWidth) * 2 - 1;
  var ndcY = -(cy / window.innerHeight) * 2 + 1;
  _raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
  _siteInv.copy(cs.mesh.matrixWorld).invert();
  var o = _raycaster.ray.origin.clone().applyMatrix4(_siteInv);
  var d = _raycaster.ray.direction.clone().transformDirection(_siteInv);

  /* 迭代：球面半径 R(h)（从海面基准开始收敛到真实地表） */
  var rr = p.size * 1.02;
  var dir = null;
  for (var it = 0; it < 3; it++) {
    var t = _raySphere(o, d, rr);
    if (t === null) return null;
    var px = o.x + d.x * t, py = o.y + d.y * t, pz = o.z + d.z * t;
    var L = Math.sqrt(px * px + py * py + pz * pz) || 1;
    dir = [px / L, py / L, pz / L];
    var sp = focusSurfacePos(p, dir);
    rr = sp.r;
  }
  return dir;
}

/* 射线 vs 球（原点在球内取远根；否则取近根 = 朝向相机的表面） */
function _raySphere(o, d, R) {
  var a = d.x * d.x + d.y * d.y + d.z * d.z;
  var b = 2 * (o.x * d.x + o.y * d.y + o.z * d.z);
  var c = o.x * o.x + o.y * o.y + o.z * o.z - R * R;
  var disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  var sq = Math.sqrt(disc);
  var t1 = (-b - sq) / (2 * a), t2 = (-b + sq) / (2 * a);
  if (t2 < 0) return null;
  return t1 > 0 ? t1 : t2;
}

/* ---- ⑧ 选址模式 + 光标（B 键进出；点击 = 承诺） ---- */

var _site = {
  on: false, p: null, mouse: null,
  dir: null, check: null, hudKey: "", panelKey: "", note: "", noteUntil: 0,
  lastCheck: 0, trace: []
};
var _siteCursor = null;

/* 共享材质判定（rebuild 的 dispose 排除名单 —— 见 99-boot 的 rebuildFocusSurface） */
function isSharedSiteMaterial(m) {
  if (!m) return false;
  if (m === _cityMat) return true;
  if (_siteCursor && m === _siteCursor.material) return true;
  return false;
}

function siteModeOn() { return _site.on; }

function setSiteMode(on) {
  if (on) {
    if (!(FSM_CAMERA.is("focus") && G.focusPlanet && isSolidPlanet(G.focusPlanet))) return false;
    _site.p = G.focusPlanet;
    _site.on = true;
    _site.note = "";
    ensureSiteCursor(_site.p);
    if (_site.mouse) siteUpdateCursor(_site.mouse[0], _site.mouse[1], true);
  } else {
    _site.on = false;
    if (_siteCursor) _siteCursor.visible = false;
    _site.note = "";
  }
  _site.hudKey = "";                    /* 强制刷新 HUD */
  _site.panelKey = "";                  /* 强制刷新操作面板（v0.15） */
  return _site.on;
}

function ensureSiteCursor(p) {
  if (!_siteCursor) {
    /* 24 段折线的圆环（LineSegments —— 不吃 «Line/LineLoop» 的审计口径） */
    var segs = 24, pos = [];
    for (var i = 0; i < segs; i++) {
      var a1 = (i / segs) * Math.PI * 2, a2 = ((i + 1) / segs) * Math.PI * 2;
      pos.push(Math.cos(a1), 0, Math.sin(a1), Math.cos(a2), 0, Math.sin(a2));
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    _siteCursor = new THREE.LineSegments(geo,
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95 }));
    _siteCursor.renderOrder = 998;
    _siteCursor.material.depthTest = false;
  }
  if (_siteCursor.parent !== p._cs.mesh) p._cs.mesh.add(_siteCursor);
  _siteCursor.visible = true;
}

/* 光标更新：位置 = 表面点；朝向 = 从 (0,1,0) 转到径向；白色 = 可建 / 暗灰 = 不可建 */
var _siteUp = new THREE.Vector3(0, 1, 0);
var _siteN = new THREE.Vector3();
function siteUpdateCursor(cx, cy, force) {
  if (!_site.on || !_site.p || !_site.p._cs) return;
  _site.mouse = [cx, cy];
  var dir = rayToSurfaceDir(_site.p, cx, cy);
  if (!dir) { if (_siteCursor) _siteCursor.visible = false; _site.dir = null; return; }
  _site.dir = dir;
  var sp = focusSurfacePos(_site.p, dir);
  _siteCursor.position.set(sp.pos[0], sp.pos[1], sp.pos[2]);
  _siteN.set(dir[0], dir[1], dir[2]);
  _siteCursor.quaternion.setFromUnitVectors(_siteUp, _siteN);
  var sc = _site.p.size * 0.05;
  _siteCursor.scale.set(sc, sc, sc);      /* 环面在局部 xy 平面 → 缩放后平贴切平面 */
  _siteCursor.visible = true;
  /* 评分是相对贵的（hAt 多次）——节流（80ms 或强制） */
  var now = performance.now();
  if (force || now - _site.lastCheck > 80) {
    _site.lastCheck = now;
    _site.check = siteCheck(_site.p, dir);
  }
  if (_site.check) {
    var ok = _site.check.ok;
    _siteCursor.material.color.setHex(ok ? 0xffffff : 0x6a7280);
    _siteCursor.material.opacity = ok ? 0.95 : 0.55;
  }
  _site.hudKey = "";                       /* 评分/可建变了 → HUD 刷新 */
  /* 调试 trace：最近 6 次光标更新（帧号 + 坐标 + 落点）—— 抓「缓存落点 ≠ 现算落点」用 */
  if (_site.trace) {
    _site.trace.push({
      f: typeof __frames === "number" ? __frames : -1, cx: cx, cy: cy,
      d: [+dir[0].toFixed(4), +dir[1].toFixed(4), +dir[2].toFixed(4)]
    });
    if (_site.trace.length > 6) _site.trace.shift();
  }
  return dir;
}

/* 点击 = 尝试放置（返回 true 表示已被选址模式消费）
 *
 * ★★ v0.15 关键修正：**点击直接用预览算出的落点方向**（`_site.dir`），不再自己重做一次射线。
 * 起因：预览与点击各做一次 rayToSurfaceDir，两次之间隔着若干帧，且屏幕坐标取整 0.5px
 * （盘缘附近 ≈0.17°）—— 在**海岸线**（h ≈ 0.5 的等值线）上这点差就足以翻转判定：
 * 实测同一鼠标点连采得到 true/true/false/true，玩家会看到「白环显示可建、点下去说海面」。
 * 预览算出的方向就是「玩家此刻看到的那块地」，点击照它落城 = 所见即所得，
 * 而且这条链路**只有一个转换点**（契约⑦的精神：预览与提交共用同一个真值）。 */
function handleSiteClick(cx, cy) {
  if (!_site.on || !_site.p) return false;
  var dir = null;
  if (_site.dir && _site.mouse &&
    Math.abs(_site.mouse[0] - cx) <= 2 && Math.abs(_site.mouse[1] - cy) <= 2) {
    dir = _site.dir;                      /* 鼠标没动过 → 用预览的落点（真值同源） */
  } else {
    dir = rayToSurfaceDir(_site.p, cx, cy);   /* 兜底：位置对不上才现算 */
  }
  if (!dir) return true;                  /* 点到太空：消费但不动作 */
  var res = placeCity(_site.p, dir);
  /* ★ v0.15：记下「这一次点击用的是哪个落点」—— 让「预览 = 点击 = 城市落点」可对账
   * （城市数据里的 dir 就是这里的 dir，同一个数组，逐位相同）。 */
  _site.lastClick = {
    dir: [+dir[0].toFixed(6), +dir[1].toFixed(6), +dir[2].toFixed(6)],
    src: _site.dir === dir ? "preview" : "recompute",
    cx: cx, cy: cy, ok: res.ok,
    gate: res.ok ? null : res.gate,
    n: res.ok ? res.city.n : null, score: res.ok ? res.city.score : null
  };
  if (res.ok) {
    _site.note = "已建聚落 #" + res.city.n + " · " + res.city.score + " 分（" +
      res.city.parts.map(function (x) { return x.k + " " + x.v; }).join(" · ") + "）";
  } else {
    _site.note = "不可建： " + res.gate;
  }
  _site.noteUntil = performance.now() + 3600;
  _site.check = siteCheck(_site.p, dir);
  _site.hudKey = "";
  return true;
}

/* ---- ⑨ 每帧同步（HUD 防抖 + 相机移动时光标跟随位置） ---- */

function syncSettlements() {
  /* 退出聚焦 → 选址模式自动解除（不残留状态） */
  if (_site.on && !FSM_CAMERA.is("focus")) setSiteMode(false);
  /* 光标：模式开着但鼠标没动时，相机动了 → 光标要跟着重投射（位置准确优先）；
   * 并自愈「重建地表后光标挂在旧 mesh 上」的情况 */
  if (_site.on && _site.p && _site.p._cs) {
    if (_siteCursor && _siteCursor.parent !== _site.p._cs.mesh) _site.p._cs.mesh.add(_siteCursor);
    if (_site.mouse) siteUpdateCursor(_site.mouse[0], _site.mouse[1], false);
  }
  /* HUD：只在关键值变化时写 DOM */
  var inFocus = FSM_CAMERA.is("focus") && G.focusPlanet && isSolidPlanet(G.focusPlanet);
  var cnt = inFocus && G.focusPlanet._cities ? G.focusPlanet._cities.length : 0;
  var scoreTxt = "";
  if (_site.on && _site.check) scoreTxt = _site.check.ok ? "评分 " + _site.check.score : "不可建 · " + _site.check.gate;
  var noteTxt = _site.note && performance.now() < _site.noteUntil ? _site.note : "";
  var key = (inFocus ? G.focusPlanet.name : "") + "|" + cnt + "|" + (_site.on ? 1 : 0) + "|" + scoreTxt + "|" + noteTxt;
  if (key !== _site.hudKey) {
    _site.hudKey = key;
    var elSites = $("fh-sites");
    var elMode = $("fh-mode");
    if (elSites) {
      elSites.textContent = inFocus ? "聚落 " + cnt + (_site.on ? "" : " · B 选址") : "聚落 —";
    }
    if (elMode) {
      var show = !!(_site.on || noteTxt);
      elMode.classList.toggle("hidden", !show);
      if (show) elMode.textContent = noteTxt || ("选址模式 · " + (scoreTxt || "移动光标") + " · 点击放置 · B 退出");
    }
  }
  updateSitePanel(false);              /* ★ v0.15：聚焦操作面板（左下角一块） */
}

/* ---- ⑩ 聚焦操作面板（v0.15 · 实验：建城） ----
 * 用户原话：「我们现在选薄曙三作为实验项目的开始，第一增加聚焦时的操作面板，我们需要放置城市」。
 *
 * ★ **实验场收敛到一颗行星**：`EXPERIMENT_PLANET` 只在这一颗的聚焦档里露出操作面板 ——
 *   其余行星一个字节都不出现（用户审美「花活越少越好」；实验没成熟前不外溢）。
 *   要放开成「所有固态行星」：把常量改成 `null`（判据就只剩「聚焦 + 固态」）。
 * ★ **单一写入者**：主按钮与 B 键走**同一个** `setSiteMode()` —— 面板只是它的投影，
 *   面板里不写任何互斥分支（第四节 7 的纪律）。
 * ★ 零 RNG：面板只读已有字段 + 写 DOM，不抽任何随机数（不变量 8）。 */

var EXPERIMENT_PLANET = "薄曙 III";
var elFocusPanel = null, elFpName = null, elFpBuild = null;
var elFpCount = null, elFpLand = null, elFpRead = null, elFpNote = null;

/* 面板宿主 = 当前聚焦目标，且它必须是「实验场」固态行星（卫星 / 气态 / 别的行星一律 null） */
function sitePanelHost() {
  if (!FSM_CAMERA.is("focus") || !G.focusPlanet) return null;
  var p = G.focusPlanet;
  if (p._isMoon || !isSolidPlanet(p)) return null;
  if (EXPERIMENT_PLANET && p.name !== EXPERIMENT_PLANET) return null;
  return p;
}

function setupSitePanel() {
  elFocusPanel = $("focus-panel");
  elFpName = $("fp-name");
  elFpBuild = $("fp-build");
  elFpCount = $("fp-count");
  elFpLand = $("fp-land");
  elFpRead = $("fp-read");
  elFpNote = $("fp-note");
  /* 主按钮 = B 键的等价入口（同一个 setSiteMode；不在这里写任何模式逻辑） */
  if (elFpBuild) elFpBuild.addEventListener("click", function () { setSiteMode(!siteModeOn()); });
  updateSitePanel(true);
}

/* 每帧刷新（syncSettlements 尾调）—— 只在关键值变了才碰 DOM：
 * 整段重绘会吃掉真实点击（见 72-focus 的 HUD 节流同一条教训）。 */
function updateSitePanel(force) {
  if (!elFocusPanel) return;
  var p = sitePanelHost();
  var cnt = p && p._cities ? p._cities.length : 0;
  /* 陆地占比：连续场实测（海平面重标定后的水面覆盖的补）—— 薄曙 III 是 90% 水的
   * 海洋行星，可建陆地只有一成（实测 10%），玩家得知道这件事（不然会以为「建不了」）。 */
  var landTxt = "—";
  if (p) landTxt = p._cs ? (100 - p._cs.seaFrac * 100).toFixed(0) + "%" : "—";
  var readTxt = "—", readCls = "";
  if (p) {
    if (_site.on && _site.check) {
      readTxt = _site.check.ok ? "可建 · " + _site.check.score + " 分" : "不可建 · " + _site.check.gate;
      readCls = _site.check.ok ? "ok" : "bad";
    } else {
      readTxt = _site.on ? "移动光标" : "未开始";
    }
  }
  var noteTxt = _site.note && performance.now() < _site.noteUntil ? _site.note : "";
  var key = (p ? p.name : "") + "|" + cnt + "|" + landTxt + "|" + (_site.on ? 1 : 0) + "|" + readTxt + "|" + noteTxt;
  if (!force && key === _site.panelKey) return;
  _site.panelKey = key;
  elFocusPanel.classList.toggle("hidden", !p);
  if (!p) return;
  if (elFpName) elFpName.textContent = p.name;
  if (elFpBuild) {
    elFpBuild.textContent = _site.on ? "停止放置" : "放置城市";
    elFpBuild.classList.toggle("on", _site.on);
  }
  if (elFpCount) elFpCount.textContent = cnt + " 座";
  if (elFpLand) elFpLand.textContent = landTxt;
  if (elFpRead) { elFpRead.textContent = readTxt; elFpRead.className = "fp-v " + readCls; }
  if (elFpNote) {
    elFpNote.classList.toggle("hidden", !noteTxt);
    if (noteTxt) elFpNote.textContent = noteTxt;
  }
}

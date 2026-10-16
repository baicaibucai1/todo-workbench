/* ================= 卫星（v0.14 起；v0.16 扩张）：小天体环绕 ================= */

/* 是什么：为**每一颗**行星挂上环绕的小天体 —— v0.14 只给「某些行星」挂 1~2 颗
 * （用户：「为某些行星增加卫星，卫星在行星被聚焦时，可以被再次聚焦」），
 * v0.16 按用户「增加卫星」把覆盖铺满、颗数按体量分档（不与聚焦耦合）。
 *
 * 三条纪律：
 *   ① **数据是唯一真值源**：p._moons 登记全部卫星（位置是角度的纯函数）；
 *      网格 / 轨道线 / 纹理全是派生 —— 场景重建不丢卫星。
 *   ② **随机不走主序列**：卫星细节全部来自本行星派生流 seedStream(p.seed, 盐)，
 *      不消耗主 RNG（确定性守恒，见 README §四）。
 *   ③ **卫星挂在行星 group 下、不挂 _mesh 下**：轨道面随公转平移，但不随行星自转
 *      旋转（行星自转只发生在 _mesh 上）——物理上轨道与自转本来就互不绑定。
 *
 * 与聚焦的关系（v0.14）：
 *   · 聚焦行星时双击卫星 → 聚焦卫星（72-focus 的 enterFocus 对卫星同样可用）；
 *   · 卫星聚焦时 Esc → 退回**母行星**的聚焦档（72-focus 的 exitFocus，层层退出）；
 *   · 卫星自转 = 潮汐锁定（一面永朝母星）；镜头随动与行星同一套口径
 *     （每帧写 m._rotDelta → 99-boot 读，见「聚焦时行星停转」的修正）。
 *   · 卫星是**小天体**：表面表示只用程序化贴图（不建立方球连续地表，
 *     也不参与聚落选址 —— 46-settlements 的 isSolidPlanet 门天然挡住）。 */

var MOON_SEED_SALT = 0x3D0D5A17;          /* genMoons 的派生流盐 */
var MOON_TEX_W = 512, MOON_TEX_H = 256;   /* 卫星贴图：聚焦时占大半个屏幕也不糊 */

/* ---- ① 数据登记（genSystem 的 planets.forEach 调一次）----
 *
 * ★ v0.16「增加卫星」：**每颗行星都有卫星**，颗数按体量分档 ——
 *   巨行星 2~3 颗 · 大岩质（半径 ≥ 1.0）1~2 颗 · 小岩质 1 颗。
 *   轨道沿半径方向**均匀铺开**（不再是「2.1~2.9 倍母星半径」的小区间）：
 *   多颗卫星挤在同一条带上会互相穿插，「均匀铺开 + 内侧更快」才像一套卫星系。
 *
 * ★ 轨道的硬上界来自聚焦档，不是随手取的：`FOCUS_MOON_K = 1.55` 要把**整条轨道**
 *   收进视野，而 `focusDistance` 的上限是 10.0 → 最外轨道必须满足 1.55 × a ≤ 10。
 *   所以 arMax 随母星半径收缩（大行星的轨道半径倍数必须更小）。
 *   —— 本片**不碰**聚焦代码：下面这行只是把那条既有约束抄进来当设计预算。 */
function moonCountFor(p, r) {
  if (p.bulk === "giant") return 2 + (r() < 0.55 ? 1 : 0);
  if (p.size >= 1.0) return 1 + (r() < 0.35 ? 1 : 0);
  return 1;
}

function genMoons(p) {
  var r = seedStream(p.seed, MOON_SEED_SALT);
  var want = moonCountFor(p, r);
  var arMin = 1.95;
  var arMax = Math.max(arMin + 0.15, Math.min(2.75, 6.30 / p.size));
  p._moons = [];
  for (var k = 0; k < want; k++) {
    /* 每颗各占一条**等宽的径向带**，带内随机（0.25~0.75）—— 留出间距，
     * 不做「整条带随机」（那样相邻两颗可能贴到一起）。 */
    var slot = (arMax - arMin) / want;
    var ar = arMin + slot * (k + 0.25 + 0.5 * r());   /* 轨道半径 / 母星半径 */
    p._moons.push({
      _isMoon: true,
      name: p.name + " · 卫" + ["一", "二", "三", "四"][k],
      parent: p,
      seed: 1 + Math.floor(r() * 2e9),
      size: clamp(p.size * (0.22 + 0.10 * r()), 0.16, 0.62),
      a: p.size * ar,                           /* 轨道半径（半径倍数见上） */
      /* 公转角速度：开普勒序（内侧更快，一圈约 25~59 秒）。刻意压慢 ——
       * 卫星是「夜空里一个稳定的同伴」，不是陀螺；也好在聚焦档里点得中它。 */
      speed: 0.22 * Math.pow(1.95 / ar, 1.5) * (0.80 + 0.35 * r()),
      incl: (r() - 0.5) * 0.16,               /* 轨道面相对母星赤道的小倾角（±0.08 rad ≈ ±4.6°，卫星系近共面） */
      angle: r() * Math.PI * 2,
      tint: 0.55 + 0.30 * r(),                 /* 灰度基色 */
      warm: r()                                /* 冷暖偏移（同一体系里不引入彩度） */
    });
  }
}

/* ---- ② 程序化贴图：石灰色 + 陨击坑（确定性：seed 局部流 + 位置哈希）----
 * 小天体的主视觉是坑：低频斑驳 + 26 枚坑（暗底 + 亮环）就是全部。 */
function moonTexture(m) {
  var W = MOON_TEX_W, H = MOON_TEX_H, sd = m.seed | 0;
  function h2(x, y) {                          /* 位置哈希（不占任何随机流） */
    var v = Math.sin(x * 127.1 + y * 311.7 + sd * 0.137) * 43758.5453;
    return v - Math.floor(v);
  }
  function vn(x, y) {                          /* 2D 值噪声（双线性 + 平滑） */
    var xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    var u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    var a = h2(xi, yi), b = h2(xi + 1, yi), c2 = h2(xi, yi + 1), d = h2(xi + 1, yi + 1);
    return (a + (b - a) * u) * (1 - v) + (c2 + (d - c2) * u) * v;
  }
  var t = mkTex(W, H, function (g) {
    var img = g.createImageData(W, H);
    var base = m.tint, wm = (m.warm - 0.5);
    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        var n = vn(x * 0.09, y * 0.09) * 0.6 + vn(x * 0.23 + 40, y * 0.23 + 40) * 0.4;
        var v = base * (0.72 + 0.52 * n);
        v *= 0.92 + 0.16 * vn(x * 0.035 + 90, y * 0.035 + 9);   /* 低频斑驳 */
        var i = (y * W + x) * 4;
        img.data[i] = Math.max(0, Math.min(255, v * 255 * (1 + wm * 0.06)));
        img.data[i + 1] = Math.max(0, Math.min(255, v * 255 * (1 + wm * 0.02)));
        img.data[i + 2] = Math.max(0, Math.min(255, v * 255 * (1 - wm * 0.05)));
        img.data[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    /* 陨击坑：暗底 + 亮环（经度方向环绕由 UV 接缝外的坑自然截断，可接受） */
    var r = mulberry32(sd ^ 0x51ED);
    for (var k = 0; k < 26; k++) {
      var cx = r() * W, cy = 10 + r() * (H - 20);
      var rad = 2 + Math.pow(r(), 2) * 12;
      g.beginPath(); g.arc(cx, cy, rad, 0, Math.PI * 2);
      g.fillStyle = "rgba(0,0,0," + (0.10 + 0.14 * r()).toFixed(2) + ")";
      g.fill();
      g.beginPath(); g.arc(cx, cy, rad * 1.25, 0, Math.PI * 2);
      g.strokeStyle = "rgba(255,255,255,0.10)"; g.lineWidth = 1.2; g.stroke();
    }
  });
  t.wrapS = THREE.RepeatWrapping;              /* 经度环绕 */
  return t;
}

/* ---- ③ 视觉装配（buildScene 的每行星循环调一次；无卫星时零开销）---- */
function buildMoonVisuals(p) {
  var list = p._moons || [];
  for (var i = 0; i < list.length; i++) {
    var m = list[i];
    var mg = new THREE.Group();                /* 轨道载体（挂行星 group —— 不随自转） */
    p._group.add(mg);
    m._group = mg;
    var mesh = new THREE.Mesh(
      new THREE.SphereGeometry(m.size, 20, 14),
      new THREE.MeshLambertMaterial({ map: moonTexture(m) }));
    mesh.rotation.y = -m.angle;                /* 潮汐锁定初始相位（此后每帧增量推） */
    mg.add(mesh);
    m._mesh = mesh;
    /* 轨道线：一圈细环（LineLoop —— 计入 [2] 的「线类对象审计」，公式已含卫星） */
    var pts = [], seg = 48;
    for (var k = 0; k <= seg; k++) {
      var a = (k / seg) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * m.a, 0, Math.sin(a) * m.a));
    }
    var ln = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: 0x9a9a9a, transparent: true, opacity: 0.16 }));
    ln.rotation.x = -m.incl;
    p._group.add(ln);                          /* 线挂 group（若挂 mg 会随轨道位移漂走） */
    m._orbitLine = ln;
  }
}

/* ---- ④ 每帧推进（updateScene 的每行星循环调，dt 秒）---- */
function updateMoons(p, dt) {
  var list = p._moons;
  if (!list || !list.length) return;
  for (var i = 0; i < list.length; i++) {
    var m = list[i];
    if (!m._mesh) continue;
    m.angle += m.speed * dt;
    var ci = Math.cos(m.incl), si = Math.sin(m.incl);
    var x0 = Math.cos(m.angle) * m.a, z0 = Math.sin(m.angle) * m.a;
    m._group.position.set(x0, z0 * si, z0 * ci);
    /* 潮汐锁定：自转与公转同速反向（一面永朝母星）；增量式 —— 与行星自转同一口径 */
    var dRot = -m.speed * dt;
    m._mesh.rotation.y += dRot;
    m._rotDelta = dRot;                        /* 镜头同速随动的口径（99-boot 每帧读） */
  }
}

/* ---- ⑤ 聚焦目标泛化：「行星或卫星」的世界坐标（v0.14）----
 * 聚焦目标从「行星」泛化到「行星或卫星」之后，所有「目标在哪」的读数都收口到
 * 这两个函数：行星 = group 坐标（group 只平移、无旋转，局部即世界）；
 * 卫星 = 母星 group 坐标 + 轨道载体局部坐标。两者都在本帧的 updateScene /
 * updateMoons 里刚写过，直接相加就是当前值 —— 不必等 renderer 的世界矩阵
 * （那是上一帧的）。镜头跟随（99-boot）/ 拾取（70-camera-input）/ 屏幕投影
 * （__game.moons）共用这一个口，避免各写一份、各处漂移。 */
var _fwTmp = new THREE.Vector3();
function focusWorldPos(out) {
  var f = G.focusPlanet;
  if (!f) return null;
  if (f._isMoon) {
    out.set(f._group.position.x, f._group.position.y, f._group.position.z);
    if (f.parent && f.parent._group) out.add(f.parent._group.position);
  } else {
    out.copy(f._group.position);
  }
  return out;
}
function moonWorldPos(m, out) {
  out.set(m._group.position.x, m._group.position.y, m._group.position.z);
  if (m.parent && m.parent._group) out.add(m.parent._group.position);
  return out;
}
/* 天体视半径（像素）：拾取阈值 / 遮挡判定用（与恒星拾取同一公式） */
function apparentRadius(worldR, dist) {
  var tanH = Math.tan((camera.fov * Math.PI) / 360);
  return worldR * ((window.innerHeight / 2) / Math.max(dist * tanH, 0.001));
}

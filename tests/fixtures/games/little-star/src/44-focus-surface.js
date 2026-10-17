/* ================= 聚焦地表（v0.12：立方球连续地表） ================= */

/* 是什么：聚焦档的**表面表示**。demo（demos/cube-sphere）验证过的 C 路线在这里
 * 落地 —— 连续场 heightFn(dir) → 立方球网格 → 片元逐像素调色/受光。
 * 非聚焦仍走 40/42 的贴图管线（远景要的是一张糊得起的图，不是几何）。
 *
 * ── 单一真值源：两种表示 = 同一份地形的两种采样 ──────────────────────
 *   同一批噪声函数（hash3i/fbm3/ridged3）、同一份坑表（genCraters）、
 *   同一张色带（TerrainProfiles.bands）、同一套物理参数（terrainParams：
 *   海平面←water、雪线/极冠←tempSurf、起伏←atmo/重力、熔岩←类型画像）。
 *   收缩进片元的只有「逐像素」的那部分：色带过渡、海深吸收、雪线、极冠、光照。
 *
 * ── 三条硬约束（父项目「确定性守恒」+ demo 架构契约）────────────────
 *   ① 零 RNG：高度场全走 hash3i(seed, 坐标)。聚焦/重建不碰主随机流。
 *   ② 法线从连续场求梯度（有限差分）—— 六面网格边顶点重复，逐面算法线
 *      会在接缝处裂出一道亮线（demo 的教训）。水面的法线直接取径向。
 *   ③ 边界用连续量等值线 + fwidth；受光用**真实恒星方向**（受光量 = 物理量，
 *      每帧从行星轨道位置反推），太阳色与恒星的灯同源。
 *
 * ── ★ v0.18：片元细节（「网格只管剪影」这句话的另一半）──────────────
 *   上面②说的「法线从连续场求梯度」是**顶点级**的：几何 N=64 → 一格 1.4°，
 *   而颜色的最小尺度＝顶点插值的尺度（近景十几到几十像素）—— 于是近看一片糊。
 *   注释里写着「细节只保留 N=64 能表达的频段，让位给片元承担」，但片元从来
 *   只做插值，这活一直没人接。v0.18 补上：
 *     片元四级值噪声（120/340/900/2400 每弧度 = 波长 3.0/1.06/0.40/0.15°），
 *     纯坐标哈希（h31/vn3，与 CPU 侧 _ch31/_cvn3 同族）、零随机流；
 *     低频两级进高程（动等高线位置，贴岸压到 35% 保住「所见即所得」），
 *     细两级进反照率斑驳，并以 900 那级的切向梯度扰动法线（立体感交给真实光照）。
 *   ★ 每级按**像素足迹**淡出（bandAA）—— 贴图有 mipmap，程序化噪声得自己算 LOD，
 *     否则近看是细节、拉远就是一片闪。
 *
 * ── 生命周期 ─────────────────────────────────────────────────────
 *   ensureFocusSurface(p)  首次聚焦时现场构建（约 150~300ms），缓存在 p._cs
 *   syncFocusSurface()     每帧一处裁决：谁被聚焦谁亮 —— Esc / 退出钮 /
 *                          双击空白都收敛到这条路，不必各自维护
 */

var FOCUS_N = 64;          /* 每面分段：demo 实测 48 已看不出网格，64 留一倍余量 */

/* ---- ① 立方体六面 → 单位球（与 demo 同一套映射：面片均匀、无极点挤压） ---- */
var CS_FACES = [
  function (u, v) { return [1, v, -u]; },
  function (u, v) { return [-1, v, u]; },
  function (u, v) { return [u, 1, -v]; },
  function (u, v) { return [u, -1, v]; },
  function (u, v) { return [u, v, 1]; },
  function (u, v) { return [-u, v, -1]; }
];
function csCubeToSphere(u, v, f) {
  var p = CS_FACES[f](u, v);
  var x = p[0], y = p[1], z = p[2];
  var x2 = x * x, y2 = y * y, z2 = z * z;
  var sx = x * Math.sqrt(1 - y2 / 2 - z2 / 2 + (y2 * z2) / 3);
  var sy = y * Math.sqrt(1 - z2 / 2 - x2 / 2 + (z2 * x2) / 3);
  var sz = z * Math.sqrt(1 - x2 / 2 - y2 / 2 + (x2 * y2) / 3);
  var L = Math.sqrt(sx * sx + sy * sy + sz * sz) || 1;
  return [sx / L, sy / L, sz / L];
}

/* ---- ② 连续高程场：与 42-terrain.buildHeightField 同源（少掉河流一层） ----
 * 贴图管线：粗网格基底 → Catmull-Rom 上采样 → 归一化 → 坑/河 → 细节 → 海平面。
 * 这里直接在网格顶点上取值（顶点即采样点），顺序保持一致：
 *   基底(fbm+山脊) → 归一化 → 陨击坑 → 细节 → 有海则分位数量海平面、重标定 0.5。
 * ★ 细节只保留 N=64 能表达的两个频段（9.5 / 38 每弧度）；119 那层波长 ≈ 2 格，
 *   进几何只剩顶点级抖动（伪影而不是细节）——让位给片元承担。
 */
function makeFocusField(p, pr) {
  var prof = pr.prof, sd = pr.seed;
  var craters = genCraters(pr);                       /* ★ 与贴图管线同一份坑表 */
  var s1 = (sd ^ 0x2f1a77) | 0, s2 = (sd ^ 0x7f3a1d) | 0;
  var fq = prof.freq, oct = prof.oct, ridge = prof.ridge, relief = pr.relief;
  var mn = 0, inv = 1, seaLvl = 0, sinv = 0;

  function baseAt(dx, dy, dz) {
    return fbm3(dx * fq, dy * fq, dz * fq, sd, oct)
      + ridge * ridged3(dx * fq * 1.7, dy * fq * 1.7, dz * fq * 1.7, sd, oct - 1);
  }
  function dentAt(dx, dy, dz) {
    /* 陨击坑逐点解析版（碗形凹 + 环形坑壁）—— 公式与 carveCraters 逐字相同 */
    var sum = 0;
    for (var k = 0; k < craters.length; k++) {
      var c = craters[k];
      var px = dx - c.nx, py = dy - c.ny, pz = dz - c.nz;
      var d = Math.sqrt(px * px + py * py + pz * pz) / (2 * c.R);
      if (d < 1) sum -= c.depth * relief * (1 - d * d) * 0.85;
      var rt = (d - 1) / 0.17;
      if (rt > -3 && rt < 3) sum += c.rim * relief * Math.exp(-rt * rt) * 0.55;
    }
    return sum;
  }
  function detailAt(dx, dy, dz) {
    return relief * (
      0.100 * (fbm3(dx * 9.5, dy * 9.5, dz * 9.5, s1, 3) - 0.5) +
      0.055 * (fbm3(dx * 38, dy * 38, dz * 38, s2, 2) - 0.5));
  }
  function hAt(dx, dy, dz) {
    var h = (baseAt(dx, dy, dz) - mn) * inv + dentAt(dx, dy, dz) + detailAt(dx, dy, dz);
    if (sinv > 0) h = 0.5 + (h - seaLvl) * sinv;
    return h;
  }
  return {
    hAt: hAt, baseAt: baseAt, dentAt: dentAt, detailAt: detailAt,
    setRange: function (a, b) { mn = a; inv = 1 / Math.max(1e-6, b - a); },
    setSea: function (lvl, iv) { seaLvl = lvl; sinv = iv; }
  };
}

/* ---- ③ 几何：顶点 / 法线 / 位移（一次构建，按行星缓存） ---- */
/* 位移口径：海面 = 半径 size（与贴图球的轮廓一致，不「长大」）；
 * 陆地再往上抬 amp × (h − 0.5)，最高约 +7%（relief 归一后）。 */
function buildFocusGeometry(p, pr, N) {
  var t0 = performance.now();
  var amp = 0.075 * clamp(pr.relief, 0.3, 1.5);
  var field = makeFocusField(p, pr);
  var st = hpStatSample(field, p, pr.sea);   /* ★ v0.18 统计与网格解耦（47）：换网格不动海岸线 */
  var vpf = (N + 1) * (N + 1);
  var total = 6 * vpf;
  var dirs = new Float32Array(total * 3);
  var hgt = new Float32Array(total);
  var f, i, j, k, u, v, d;

  /* pass 1：方向 + 基底（归一化常数来自固定等面积采样，不在本网格上求） */
  k = 0;
  for (f = 0; f < 6; f++) {
    for (j = 0; j <= N; j++) {
      for (i = 0; i <= N; i++) {
        u = -1 + (2 * i) / N; v = -1 + (2 * j) / N;
        d = csCubeToSphere(u, v, f);
        dirs[k * 3] = d[0]; dirs[k * 3 + 1] = d[1]; dirs[k * 3 + 2] = d[2];
        hgt[k] = field.baseAt(d[0], d[1], d[2]);
        k++;
      }
    }
  }
  field.setRange(st.mn, st.mx);
  var inv = 1 / Math.max(1e-6, st.mx - st.mn);

  /* pass 2：特征叠加（坑 + 细节）→ 最终高程 */
  for (k = 0; k < total; k++) {
    var dx = dirs[k * 3], dy = dirs[k * 3 + 1], dz = dirs[k * 3 + 2];
    hgt[k] = (hgt[k] - st.mn) * inv
      + field.dentAt(dx, dy, dz) + field.detailAt(dx, dy, dz);
  }

  /* pass 3：有海 → 海平面/缩放用固定采样的统计（与 HEALPix 同一份） */
  var sea = pr.sea;
  if (sea) {
    var seaLvl = st.seaLvl, sinv = st.sinv;
    for (k = 0; k < total; k++) hgt[k] = 0.5 + (hgt[k] - seaLvl) * sinv;
    field.setSea(seaLvl, sinv);
  }

  /* pass 4：位置 + 解析法线（有限差分；水面法线 = 径向） */
  var pos = new Float32Array(total * 3);
  var nor = new Float32Array(total * 3);
  var seaA = sea ? 0.5 : -1;
  var e = 0.9 * (Math.PI / 2) / N;                   /* 差分步长 ≈ 一格——比这更小
                                                        会采到网格表达不了的噪声 */
  var sig = 0, below = st.below;   /* ★ 水面占比 = 固定采样的统计（网格无关） */
  for (k = 0; k < total; k++) {
    var vx = dirs[k * 3], vy = dirs[k * 3 + 1], vz = dirs[k * 3 + 2];
    var h2 = hgt[k];
    sig += h2;
    var disp = h2 > 0.5 ? amp * (h2 - 0.5) : 0;      /* 海面压平（水下不参与位移） */
    var rr = p.size * (1 + disp);
    pos[k * 3] = vx * rr; pos[k * 3 + 1] = vy * rr; pos[k * 3 + 2] = vz * rr;

    var nx, ny, nz;
    if (seaA > 0 && h2 <= seaA) { nx = vx; ny = vy; nz = vz; }
    else {
      /* 两个正交切向（东向 / 北向），再从连续场求梯度 —— demo 的构造 */
      var t1x = -vz, t1y = 0, t1z = vx;
      var t1L = Math.sqrt(t1x * t1x + t1z * t1z);
      if (t1L < 1e-6) { t1x = 1; t1y = 0; t1z = 0; t1L = 1; }
      t1x /= t1L; t1z /= t1L;
      var t2x = vy * t1z - vz * t1y, t2y = vz * t1x - vx * t1z, t2z = vx * t1y - vy * t1x;
      var h0 = field.hAt(vx, vy, vz);
      var ha = field.hAt(vx + t1x * e, vy + t1y * e, vz + t1z * e);
      var hb = field.hAt(vx + t2x * e, vy + t2y * e, vz + t2z * e);
      var s = p.size * amp;                          /* 高度差 → 径向位移的斜率 */
      var g1 = (ha - h0) * s / e, g2 = (hb - h0) * s / e;
      nx = vx - (t1x * g1 + t2x * g2);
      ny = vy - (t1y * g1 + t2y * g2);
      nz = vz - (t1z * g1 + t2z * g2);
      var nL = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      nx /= nL; ny /= nL; nz /= nL;
    }
    nor[k * 3] = nx; nor[k * 3 + 1] = ny; nor[k * 3 + 2] = nz;
  }

  var idx = [];
  for (f = 0; f < 6; f++) {
    for (j = 0; j < N; j++) {
      for (i = 0; i < N; i++) {
        var a = f * vpf + j * (N + 1) + i;
        idx.push(a, a + 1, a + N + 2, a, a + N + 2, a + N + 1);
      }
    }
  }
  var geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute("aH", new THREE.Float32BufferAttribute(hgt, 1));
  geo.setIndex(idx);
  return {
    geo: geo, amp: amp, field: field, N: N, lvl: N, verts: total, tris: idx.length / 3,
    seaFrac: seaA > 0 ? below / st.npix : 0,
    sig: +sig.toFixed(3), ms: Math.round(performance.now() - t0)
  };
}

/* ---- ④ 材质：色带贴图 + 片元调色/受光 ----
 * 色带 = TerrainProfiles.bands 的 256px 采样（与贴图管线同一张表、同一插值），
 * 于是「两种表示是同一颗星球」在颜色上也成立。 */
var _rampT = {};
function focusRampTex(prof) {
  if (_rampT[prof.id]) return _rampT[prof.id];
  var ramp = mkRamp(prof);
  var t = mkTex(256, 1, function (g, w) {
    var img = g.createImageData(w, 1), d = img.data;
    for (var i = 0; i < w; i++) {
      var c = rampAt(ramp, i / (w - 1));
      d[i * 4] = c[0]; d[i * 4 + 1] = c[1]; d[i * 4 + 2] = c[2]; d[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  });
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = false;
  _rampT[prof.id] = t;
  return t;
}

var FOCUS_VS = [
  "attribute float aH;",
  "/* ★ v0.19：Goldberg（六/五边形）每格都要带自己的三个数 —— aCellH 本格中心高程、",
  "   aCell 本格的哈希色号、aEdge 0 = 格心 / 1 = 格角（渲染出格边界）。",
  "   另两种网格（cube / healpix）没有这几个属性 → 取通用值 0，配 uXXX_K = 0 即无效。 */",
  "attribute float aCellH; attribute float aCell; attribute float aEdge;",
  "varying float vH;",
  "varying float vCellH; varying float vCell; varying float vEdge;",
  "varying vec3 vWN;",       /* 世界空间法线：星球自转，光照得在物体空间之外算 */
  "varying vec3 vWDir;",     /* 世界空间径向：量坡度用 */
  "varying vec3 vDir;",      /* 物体空间方向：细节噪声与纬度都挂在它上面（跟着地表转） */
  "varying vec3 vNObj;",     /* 物体空间法线：细节扰动在物体空间做（零 RNG 的噪声也锚在这） */
  "varying vec3 vWP;",       /* 世界空间位置：视线方向（水面高光要用） */
  "void main() {",
  "  vH = aH;",
  "  vCellH = aCellH; vCell = aCell; vEdge = aEdge;",
  "  vDir = normalize(position);",
  "  vNObj = normalize(normal);",
  "  vWN = normalize(mat3(modelMatrix) * normal);",
  "  vWDir = normalize(mat3(modelMatrix) * position);",
  "  vec4 wp = modelMatrix * vec4(position, 1.0);",
  "  vWP = wp.xyz;",
  "  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);",
  "}"
].join("\n");

/* 四级细节噪声的频率（每弧度）：波长 3.0° / 1.06° / 0.40° / 0.15°。
 * 前两级进高程（几何 N=64 表达不了），后两级进反照率与法线（近景真正的「质感」）。 */
var FS_F1 = 120, FS_F2 = 340, FS_F3 = 900, FS_F4 = 2400;

var FOCUS_FS = [
  "uniform sampler2D uRamp;",
  "uniform vec3 uSunDir; uniform vec3 uSunCol; uniform vec3 uAmb;",
  "uniform mat3 uModel3;",       /* 物体 → 世界（只取旋转部分）：把细节法线转回去受光 */
  "uniform float uSea; uniform float uSnowH; uniform float uCapFrac; uniform float uLava;",
  "uniform float uHasSea; uniform float uDetailK; uniform float uMottK;",
  "uniform float uBumpK; uniform float uWaveK; uniform float uSpecK; uniform float uFresK;",
  "/* ★ v0.19：六/五边形的「一格一块」三件套（几何位移仍走连续场，只有着色用它们） */",
  "uniform float uPlateauK; uniform float uAlbedoK; uniform float uEdgeK;",
  "varying float vH;",
  "varying float vCellH; varying float vCell; varying float vEdge;",
  "varying vec3 vWN; varying vec3 vWDir; varying vec3 vDir; varying vec3 vNObj; varying vec3 vWP;",
  "",
  "/* ★ v0.18：逐像素细节。h31/vn3 与 CPU 侧 _ch31/_cvn3 同族（同一套哈希常数与",
  "   平滑插值）；它只吃坐标，**零随机流** —— 主序列一格不碰。 */",
  "float h31(vec3 p) {",
  "  vec3 q = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3)) * 17.0;",
  "  return fract(q.x * q.y * q.z * (q.x + q.y + q.z));",
  "}",
  "float vn3(vec3 x) {",
  "  vec3 i = floor(x), f = x - i;",
  "  f = f * f * (3.0 - 2.0 * f);",
  "  return mix(mix(mix(h31(i), h31(i + vec3(1.0, 0.0, 0.0)), f.x),",
  "                 mix(h31(i + vec3(0.0, 1.0, 0.0)), h31(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),",
  "             mix(mix(h31(i + vec3(0.0, 0.0, 1.0)), h31(i + vec3(1.0, 0.0, 1.0)), f.x),",
  "                 mix(h31(i + vec3(0.0, 1.0, 1.0)), h31(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);",
  "}",
  "/* 带限：某一级的波长缩到接近一个像素时把它收掉 —— 贴图有 mipmap，程序化噪声",
  "   只能自己算 LOD。没有这一步，拉远之后高频细节就是一片闪烁的噪点。 */",
  "float bandAA(float f, float fd) {",
  "  return clamp((6.2831853 / f / max(fd, 1e-6) - 1.6) / 1.6, 0.0, 1.0);",
  "}",
  "",
  "void main() {",
  "  vec3 d = normalize(vDir);",
  "  vec3 nO = normalize(vNObj);",
  "  vec3 wn = normalize(vWN);",
  "  vec3 V = normalize(cameraPosition - vWP);",
  "",
  "  /* ① 像素在方向上的足迹 → 四级细节（每级各自带限） */",
  "  float fd = max(length(dFdx(d)), length(dFdy(d)));",
  "  vec3 o1 = vec3(2.7, 8.1, 4.3), o2 = vec3(6.1, 1.7, 9.7);",
  "  vec3 o3 = vec3(3.3, 5.9, 1.1), o4 = vec3(8.7, 2.3, 6.5);",
  "  float a1 = bandAA(120.0, fd), a2 = bandAA(340.0, fd);",
  "  float a3 = bandAA(900.0, fd), a4 = bandAA(2400.0, fd);",
  "  float n1 = vn3(d * 120.0 + o1), n2 = vn3(d * 340.0 + o2);",
  "  float n3 = vn3(d * 900.0 + o3), n4 = vn3(d * 2400.0 + o4);",
  "",
  "  /* ② 高程细节：只让低频两级参与（动的是等高线的位置）。贴岸处压到 35% ——",
  "     细节不能把海陆判据挪走几像素，否则「白环说可建、点下去说海面」会回来。 */",
  "  float coastGuard = uHasSea * (1.0 - smoothstep(0.02, 0.10, abs(vH - uSea)));",
  "  float hDet = uDetailK * (a1 * 0.62 * (n1 - 0.5) + a2 * 0.38 * (n2 - 0.5));",
  "  hDet *= 1.0 - 0.65 * coastGuard;",
  "  /* ★ v0.19 plateau：着色时向「本格中心高程」混合 —— 一格一个高度平台，",
  "     才是眼睛能认出来的铺砌（而不是「凑巧用了六边形做个网格」）。",
  "     ★ 只改**着色**，几何位移照样按连续场 —— 一旦往顶点上加每格偏移，",
  "     相邻两格会对同一个角点给出不同高度 ⇒ 裂缝。",
  "     ★ 贴岸 35% 区域内不玩这套：海岸线必须与 CPU 连续场逐点一致，否则",
  "     「白环说可建、点下去说海面」会回来（与 v0.15 那条 bug 同一根电线）。 */",
  "  float plate = uPlateauK * (1.0 - coastGuard);",
  "  float hF = clamp(mix(vH, vCellH, plate) + hDet, 0.0, 1.0);",
  "",
  "  /* ③ 水陆分界：连续量等值线 + 像素宽过渡（下限 1e-5 是 C 路线契约③） */",
  "  float fw = max(fwidth(hF) * 1.2, 1e-5);",
  "  float wMask = uHasSea * (1.0 - smoothstep(uSea - fw, uSea + fw, hF));",
  "  float wDepth = 0.0;",
  "",
  "  /* ④ 色带（与贴图管线同一张表、同一 S 曲线） */",
  "  float hc = clamp(0.5 + (hF - 0.5) * 1.55, 0.0, 1.0);",
  "  vec3 base = texture2D(uRamp, vec2(hc, 0.5)).rgb;",
  "",
  "  /* ⑤ 海洋：与 42-terrain v0.17 逐项同口径（拍岸浅滩 / 陆架 / 深海吸收）。",
  "     ★ v0.17 那轮只修了贴图管线，聚焦档一直还是旧公式 (uSea−h)/0.30 ——",
  "     在 0.30 水深就饱和，整片海是一块死蓝。 */",
  "  if (wMask > 0.002) {",
  "    wDepth = max(uSea - hF, 0.0);",
  "    float sh = 1.0 - smoothstep(0.0, 0.055, wDepth);",
  "    float dp = sqrt(clamp(wDepth / 0.45, 0.0, 1.0));",
  "    base *= vec3(1.0 - 0.46 * dp, 1.0 - 0.30 * dp, 1.0 - 0.08 * dp);",
  "    base += (vec3(0.345, 0.698, 0.675) - base) * (sh * sh * 0.55 * wMask);",
  "  }",
  "",
  "  /* ⑥ 雪线 + 极冠（同一公式；用 hF ⇒ 边界比顶点插值锐一档） */",
  "  if (uSnowH < 1.0) {",
  "    float t = clamp((hF - uSnowH) / max(0.06, 1.0 - uSnowH), 0.0, 1.0);",
  "    base = mix(base, vec3(0.96, 0.97, 0.99), t * 0.9);",
  "  }",
  "  if (uCapFrac > 0.0) {",
  "    float latL = abs(asin(clamp(d.y, -1.0, 1.0))) / 1.5707963;",
  "    float w = clamp((latL - (1.0 - uCapFrac)) / max(0.06, uCapFrac * 0.55), 0.0, 1.0);",
  "    base = mix(base, vec3(0.99, 0.99, 1.0), w * w);",
  "  }",
  "",
  "  /* ⑦ 反照率斑驳：细两级直接乘在颜色上（色带对 h 的响应太弱，走色带看不见）。",
  "     水面只要一点点 —— 平的水面长出颗粒感会显脏。 */",
  "  float mott = a3 * (n3 - 0.5) * 1.32 + a4 * (n4 - 0.5) * 0.68;",
  "  base *= 1.0 + uMottK * mott * (1.0 - 0.72 * wMask);",
  "",
  "  /* ⑦b ★ v0.19：每格一色 + 格边界压暗 —— 「六边形拼出来的球面」最后一步。",
  "     aCell 是本格自己的哈希（零 RNG）；aEdge 在格心 = 0、格角 = 1，而三角扇的",
  "     **外边**整条都是 1 ⇒ smoothstep 出来的是一圈贴着边界的暗环，相邻两格压的",
  "     正好是同一条边（两端都是 1）⇒ 不会出现接不上的缝。 */",
  "  base *= 1.0 + uAlbedoK * (vCell - 0.5) * 2.0;",
  "  float ed = smoothstep(0.74, 1.0, vEdge) * uEdgeK * (1.0 - 0.45 * wMask);",
  "  ed *= 1.0 - 0.5 * coastGuard;",
  "  base *= 1.0 - ed;",
  "",
  "  /* ⑧ 细节法线：物体空间求切向梯度，再用 uModel3 转回世界 ——",
  "     山脊与波纹因此由**真实光照**塑形（立体感的主力），而不是烘死在颜色里。",
  "     水面上同一份梯度当波纹用（幅度大得多），海面才有碎浪与耀斑。 */",
  "  vec3 tO = normalize(cross(nO, vec3(0.0, 1.0, 0.0)) + vec3(1e-4, 0.0, 0.0));",
  "  vec3 bO = cross(nO, tO);",
  "  float e = 0.55 / 900.0;",
  "  float g1 = vn3((d + tO * e) * 900.0 + o3) - vn3((d - tO * e) * 900.0 + o3);",
  "  float g2 = vn3((d + bO * e) * 900.0 + o3) - vn3((d - bO * e) * 900.0 + o3);",
  "  nO = normalize(nO - (tO * g1 + bO * g2) * (uBumpK + uWaveK * wMask) * a3);",
  "  wn = normalize(uModel3 * nO);",
  "",
  "  /* ⑨ 坡度暗化：地形可读性（潮汐锁定行星日照面几乎无影，纯光照会「看起来是平的」） */",
  "  float slope = 1.0 - max(dot(wn, normalize(vWDir)), 0.0);",
  "  base *= 1.0 - clamp(slope * 1.6, 0.0, 0.28);",
  "",
  "  /* ⑩ 光照：真实恒星方向（受光量 = 物理量） */",
  "  vec3 L = normalize(uSunDir);",
  "  float dl = max(dot(wn, L), 0.0);",
  "  vec3 col = base * (uAmb + uSunCol * dl);",
  "",
  "  /* ⑪ 海洋的「水感」：太阳耀斑 + 掠射菲涅尔。这两步才是「像不像水」的关键 ——",
  "     没有高光通道的水面（Lambert 时代）永远是一片哑光蓝。 */",
  "  if (wMask > 0.002) {",
  "    vec3 Hv = normalize(L + V);",
  "    float sp = pow(max(dot(wn, Hv), 0.0), 110.0);",
  "    float fres = pow(1.0 - max(dot(wn, V), 0.0), 5.0);",
  "    col += uSunCol * (sp * uSpecK * wMask);",
  "    col = mix(col, uSunCol * 0.40 + uAmb * 0.85,",
  "      clamp(fres * uFresK, 0.0, 0.80) * wMask * (1.0 - 0.5 * clamp(wDepth / 0.45, 0.0, 1.0)));",
  "  }",
  "",
  "  /* ⑫ 熔岩自发光：只在最高处透出来（裂缝），与贴图 emissiveMap 同一口径 */",
  "  if (uLava > 0.5) {",
  "    float lit = clamp((hF - 0.80) / 0.20, 0.0, 1.0);",
  "    col += vec3(1.0, 0.62, 0.26) * lit * lit * 0.85;",
  "  }",
  "",
  "  gl_FragColor = vec4(col, 1.0);",
  "}"
].join("\n");

/* ---- ⑤ 云层：装饰层（只进渲染管线，不参与拾取/几何/统计，demo 契约⑤） ----
 * ★ v0.12.3：云图案从「片元逐像素 3D 噪声」改成「一张烘焙贴图」（用户拍板：
 * 云是装饰物，用单纯贴图即可）。动机与工艺：
 *   ① 修锯齿 —— 逐像素噪声在云边是「采样走样」（毛刺/碎点）；贴图 + linear /
 *      mipmap 是**预过滤**过的，边缘天然平滑；
 *   ② 性能 —— 每像素 ~48 次哈希 → 1 次纹理采样；
 *   ③ 云量 / 不透明度仍是材质 uniform（逐行星），贴图全行星共享、零运行时成本；
 *      不同行星靠「初始相位（seed）」+「云量」区分图案方位。
 * 生成用与旧着色器**同构**的 CPU 噪声（h31/vn3/cfbm —— 同频率、同混合、同拉伸），
 * 所以云的形态与旧版一致，只是不再有逐像素走样。 */
var CLOUD_TEX_W = 1024, CLOUD_TEX_H = 512;   /* 细节上限：近景云团不糊（生成 ~150ms，启动时空闲预热） */
var _cloudTex = null, _cloudTexMs = 0;

function _cfract(x) { return x - Math.floor(x); }
function _ch31(x, y, z) {
  var px = _cfract(x * 0.3183099 + 0.1) * 17;
  var py = _cfract(y * 0.3183099 + 0.2) * 17;
  var pz = _cfract(z * 0.3183099 + 0.3) * 17;
  return _cfract(px * py * pz * (px + py + pz));
}
function _cvn3(x, y, z) {
  var ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  var fx = x - ix, fy = y - iy, fz = z - iz;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
  var n000 = _ch31(ix, iy, iz), n100 = _ch31(ix + 1, iy, iz);
  var n010 = _ch31(ix, iy + 1, iz), n110 = _ch31(ix + 1, iy + 1, iz);
  var n001 = _ch31(ix, iy, iz + 1), n101 = _ch31(ix + 1, iy, iz + 1);
  var n011 = _ch31(ix, iy + 1, iz + 1), n111 = _ch31(ix + 1, iy + 1, iz + 1);
  var x00 = n000 + (n100 - n000) * fx, x10 = n010 + (n110 - n010) * fx;
  var x01 = n001 + (n101 - n001) * fx, x11 = n011 + (n111 - n011) * fx;
  var y0 = x00 + (x10 - x00) * fy, y1 = x01 + (x11 - x01) * fy;
  return y0 + (y1 - y0) * fz;
}

/* 生成一次（启动空闲预热；万一没赶上，首次出现云壳时同步兜底）；经度方向天然无缝：
 * u=0 与 u=1 是同方向（球面采样保证），配合 RepeatWrapping 无接缝。 */
function buildCloudTex() {
  if (_cloudTex) return _cloudTex;
  var t0 = (typeof performance !== "undefined" ? performance.now() : 0);
  var W = CLOUD_TEX_W, H = CLOUD_TEX_H;
  var data = new Uint8Array(W * H * 4);
  var i = 0;
  for (var j = 0; j < H; j++) {
    var lat = ((j + 0.5) / H) * Math.PI;              /* 0 = 北极 → π = 南极 */
    var sl = Math.sin(lat), cl = Math.cos(lat);
    for (var k = 0; k < W; k++) {
      var lon = ((k + 0.5) / W) * Math.PI * 2;
      var dx = sl * Math.cos(lon), dy = cl, dz = sl * Math.sin(lon);
      /* 主云团：4 八度；细碎层：2 八度（与旧着色器逐参数同构） */
      var s = 0, nn = 0, a = 0.5, px = dx * 2.85, py = dy * 2.85, pz = dz * 2.85;
      for (var o = 0; o < 4; o++) { s += a * _cvn3(px, py, pz); nn += a; a *= 0.5; px *= 2.13; py *= 2.13; pz *= 2.13; }
      var m = s / nn;
      var s2 = 0, nn2 = 0, a2 = 0.5;
      px = dx * 2.85 * 3.4 + 11; py = dy * 2.85 * 3.4 + 11; pz = dz * 2.85 * 3.4 + 11;
      for (var o2 = 0; o2 < 2; o2++) { s2 += a2 * _cvn3(px, py, pz); nn2 += a2; a2 *= 0.5; px *= 2.21; py *= 2.21; pz *= 2.21; }
      var v = m * 0.66 + (s2 / nn2) * 0.34;
      v = Math.min(1, Math.max(0, (v - 0.5) * 2.1 + 0.5));     /* 对比拉伸（烘焙） */
      var b = (v * 255) | 0;
      data[i++] = b; data[i++] = b; data[i++] = b; data[i++] = 255;
    }
  }
  var tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;                       /* 经度环绕无缝 */
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;         /* mipmap 预过滤 = 抗走样 */
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  _cloudTexMs = Math.round((typeof performance !== "undefined" ? performance.now() : 0) - t0);
  return (_cloudTex = tex);
}

var FOCUS_CLOUD_VS = [
  "varying vec3 vWN;",
  "varying vec2 vUv;",
  "void main() {",
  "  vUv = uv;",
  "  vWN = normalize(mat3(modelMatrix) * normal);",
  "  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);",
  "}"
].join("\n");

var FOCUS_CLOUD_FS = [
  "uniform vec3 uSunDir; uniform vec3 uSunCol; uniform vec3 uTint;",
  "uniform float uCover; uniform float uOpacity;",
  "uniform sampler2D uMap;",
  "varying vec3 vWN; varying vec2 vUv;",
  "void main() {",
  "  /* ★ v0.12.3：图案来自烘焙贴图（生成时已含对比拉伸与细碎层）。",
  "     贴图是预过滤的（linear/mipmap）—— 云边天然平滑，不再有逐像素",
  "     噪声的走样毛刺；云量 uCover 仍是逐行星 uniform，阈值化在此完成。 */",
  "  float n = texture2D(uMap, vUv).r;",
  "  float a = smoothstep(uCover, uCover + 0.24, n);",
  "  if (a < 0.004) discard;",
  "  vec3 wn = normalize(vWN);",
  "  float dl = max(dot(wn, uSunDir), 0.0);",
  "  vec3 col = mix(uTint * 0.20, uTint * uSunCol, pow(dl, 0.62));",
  "  gl_FragColor = vec4(col, a * uOpacity);",
  "}"
].join("\n");

/* ---- ⑥ 构建 + 每帧同步 ---- */

/* 与 50-scene 的贴图云同一条判定（写在这里供两处共用，勿各写一份） */
function planetCloudy(p) {
  return p.atmo >= 0.40 && p.bulk === "rock" && p.tempSurf < 700 && p.tempSurf > 150;
}

/* ★ v0.18 细节强度（全部按 relief 缩放：被大气磨平的世界不该有刀劈一般的颗粒）。
 * 参考值：relief 0.70（薄曙 III）→ 高程细节 ±0.021、斑驳 ±14%、法线切向 ~0.19。 */
var FS_DETAIL_K = 0.042;      /* 高程细节幅度（h 单位） */
var FS_MOTT_K = 0.20;         /* 反照率斑驳幅度 */
var FS_BUMP_K = 0.62;         /* 陆地细节法线的切向斜率 */
var FS_WAVE_K = 1.05;         /* 水面波纹法线（同一份梯度，幅度大得多） */
var FS_SPEC_K = 1.30;         /* 太阳耀斑强度 */
var FS_FRES_K = 1.15;         /* 掠射菲涅尔强度 */

/* 聚焦档云壳的不透明度。★ 全景档的云在聚焦时会淡到 0.30（50-scene 的
 * 「聚焦 = 沉浸观察地表」），但这层云壳是 v0.12.3 才加的，当时漏了同一处理 ——
 * uOpacity 一直挂在 0.72，等于拿一层半透明白雾糊在要看的表面上。对齐到同一档。 */
var FOCUS_CLOUD_OP = 0.27;

/* ★ v0.19：聚焦网格的方案。默认 **Goldberg 六/五边形**（用户可以一眼看出球面是
 * 被一块块拼起来的，见 47）；HEALPix 与立方球留作 A/B 对照
 * （`__game.setFocusMesh("hex" | "healpix" | "cube")`）。
 * ★★ 不管用哪种网格，**统计都走 HEALPix 采样**（hpStatSample）—— 换网格不算重新生成星球。 */
var FOCUS_MESH_KIND = "hex";
var FOCUS_LOD_HOLD_MS = 500;      /* 换档的最小间隔：贴着阈值来回缩会一直重建 */

/* 屏幕「每弧度多少像素」—— LOD 选档的输入（相机到最近表面点的距离） */
function focusPxPerRad(p) {
  var d = Math.max(0.05, orbit.radius - p.size);
  return (window.innerHeight / 2) / (Math.tan(camera.fov * Math.PI / 360) * d);
}
function focusLvlFor(p) {
  if (FOCUS_MESH_KIND === "hex") return hexPickNu(focusPxPerRad(p));
  if (FOCUS_MESH_KIND === "healpix") return hpPickNside(focusPxPerRad(p));
  return FOCUS_N;
}
function focusBuildGeom(p, pr, lvl) {
  if (FOCUS_MESH_KIND === "hex") return buildHexGeometry(p, pr, lvl);
  if (FOCUS_MESH_KIND === "healpix") return buildHealpixGeometry(p, pr, lvl);
  return buildFocusGeometry(p, pr, FOCUS_N);
}
/* ★ v0.19：「一格一块」的三件套只有 hex 网格有那几个逐格属性 ——
 * 换到其它网格时把强度归零（属性缺失时 WebGL 给通用值 0，乘 0 天然安全）。 */
function hexUniforms() {
  var on = (FOCUS_MESH_KIND === "hex");
  return {
    uPlateauK: on ? HEX_PLATEAU_K : 0,
    uAlbedoK: on ? HEX_ALBEDO_K : 0,
    uEdgeK: on ? HEX_EDGE_K : 0
  };
}
function applyHexUniforms(cs) {
  if (!cs || !cs.mat) return;
  var u = hexUniforms();
  cs.mat.uniforms.uPlateauK.value = u.uPlateauK;
  cs.mat.uniforms.uAlbedoK.value = u.uAlbedoK;
  cs.mat.uniforms.uEdgeK.value = u.uEdgeK;
}
/* 只换几何（档位变了）：材质 / 云壳 / 城市都留着 —— 城市数据是唯一真值源 */
function rebuildFocusGeom(p) {
  var cs = p._cs;
  if (!cs) return null;
  var pr = terrainParams(p);
  var g = focusBuildGeom(p, pr, focusLvlFor(p));
  if (cs.mesh.geometry) cs.mesh.geometry.dispose();
  cs.mesh.geometry = g.geo;
  cs.nside = g.lvl; cs.lvl = g.lvl; cs.N = g.N; cs.verts = g.verts; cs.tris = g.tris;
  cs.pents = g.pents || 0; cs.hexes = g.hexes || 0;
  cs.ms = g.ms; cs.seaFrac = g.seaFrac; cs.sig = g.sig;
  cs.field = g.field; cs.amp = g.amp; cs.sea = pr.sea ? 0.5 : -1;
  cs.switchedAt = performance.now();
  applyHexUniforms(cs);
  syncCityMeshes(p);
  return cs;
}

function ensureFocusSurface(p) {
  if (!p || p._cs || !isSolidPlanet(p)) return p ? p._cs || null : null;
  var pr = terrainParams(p);
  var g = focusBuildGeom(p, pr, focusLvlFor(p));
  var rel = clamp(pr.relief, 0.3, 1.5);
  var mat = new THREE.ShaderMaterial({
    uniforms: {
      uRamp: { value: focusRampTex(pr.prof) },
      uSunDir: { value: new THREE.Vector3(1, 0, 0) },
      uSunCol: { value: new THREE.Vector3(1, 1, 1) },
      uAmb: { value: new THREE.Vector3(0.34, 0.38, 0.46) },
      uModel3: { value: new THREE.Matrix3() },
      uSea: { value: pr.sea ? 0.5 : -1 },
      uHasSea: { value: pr.sea ? 1 : 0 },
      uSnowH: { value: pr.snowH },
      uCapFrac: { value: pr.capFrac },
      uLava: { value: pr.lava ? 1 : 0 },
      uDetailK: { value: FS_DETAIL_K * rel },
      uMottK: { value: FS_MOTT_K * clamp(rel, 0.45, 1.4) },
      uBumpK: { value: FS_BUMP_K * rel },
      uWaveK: { value: FS_WAVE_K * clamp(rel, 0.5, 1.2) },
      uSpecK: { value: FS_SPEC_K },
      uFresK: { value: FS_FRES_K },
      /* ★ v0.19：紧紧只属于 hex 网格的三件套（非 hex 一律 0，见 hexUniforms） */
      uPlateauK: { value: hexUniforms().uPlateauK },
      uAlbedoK: { value: hexUniforms().uAlbedoK },
      uEdgeK: { value: hexUniforms().uEdgeK }
    },
    /* 片元里 dFdx/fwidth 求像素足迹（细节带限 + 等值线抗锯齿）。
     * WebGL2 里导数是核心功能，WebGL1 下 three 会按这个开关插扩展声明。 */
    extensions: { derivatives: true },
    vertexShader: FOCUS_VS,
    fragmentShader: FOCUS_FS
  });
  var group = new THREE.Group();
  var mesh = new THREE.Mesh(g.geo, mat);
  group.add(mesh);
  var cloud = null, cloudMat = null;
  if (planetCloudy(p)) {
    cloudMat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: buildCloudTex() },              /* ★ v0.12.3：烘焙云贴图（全行星共享） */
        uSunDir: { value: new THREE.Vector3(1, 0, 0) },
        uSunCol: { value: new THREE.Vector3(1, 1, 1) },
        uTint: { value: rawColor(p.type.color).lerp(new THREE.Color(1, 1, 1), 0.82) },
        uCover: { value: clamp(0.82 - 0.22 * clamp(p.atmo, 0, 1), 0.54, 0.82) },
        uOpacity: { value: FOCUS_CLOUD_OP }
      },
      vertexShader: FOCUS_CLOUD_VS,
      fragmentShader: FOCUS_CLOUD_FS,
      transparent: true,
      depthWrite: false
    });
    cloud = new THREE.Mesh(new THREE.SphereGeometry(p.size * (1 + g.amp + 0.015), 64, 48), cloudMat);
    /* 云图案方位按行星种子转一个相位（共享贴图、不同行星朝相机的一面不同） */
    cloud.rotation.y = hash3i(p.seed, 3, 7, 11) * Math.PI * 2;
    group.add(cloud);
  }
  group.visible = false;
  p._group.add(group);
  p._cs = {
    group: group, mesh: mesh, mat: mat, cloud: cloud, cloudMat: cloudMat,
    /* v0.19：kind = hex | healpix | cube；nside = 当前 LOD 档位（hex 是 ν，
     * healpix 是 nside，cube 恒为 FOCUS_N）。pents/hexes 只在 hex 网格有意义。 */
    kind: FOCUS_MESH_KIND, nside: g.lvl || 0, lvl: g.lvl || 0,
    N: g.N, pents: g.pents || 0, hexes: g.hexes || 0,
    verts: g.verts, tris: g.tris, ms: g.ms, seaFrac: g.seaFrac, sig: g.sig,
    /* ★ v0.13：连续场 + 位移幅度 + 海平面 —— 聚落系统（46）的就地查询口 */
    field: g.field, amp: g.amp, sea: pr.sea ? 0.5 : -1,
    switchedAt: 0
  };
  /* ★ v0.13：重建后城市网格自愈（城市数据是唯一真值源，几何是派生） */
  syncCityMeshes(p);
  return p._cs;
}

/* 太阳色：与 buildStarVisual 的灯同一构造（星色向白偏 0.55），强度统一系数 */
var CS_SUN_K = 1.02;
var _csWhite = new THREE.Color(1, 1, 1);
var _csSun = new THREE.Color();
var _csM4 = new THREE.Matrix4();               /* ★ v0.18：物体→世界（取旋转部分） */
var _csM3 = new THREE.Matrix3();

/* 每帧一处裁决：聚焦谁，谁换连续地表。三件事：
 *   ① 首次聚焦 → 现场构建（缓存，第二次进入零延迟）
 *   ② 可见性：立方球亮 ⇔ 贴图网格/贴图云隐（一次切换，不每帧写）
 *   ③ 受光：太阳方向 = 行星 → 恒星（恒星在原点，随公转每帧变） */
function syncFocusSurface() {
  if (!G.sys) return;
  var st = G.sys.starType;
  var want = (FSM_CAMERA.is("focus") && G.focusPlanet && isSolidPlanet(G.focusPlanet)) ? G.focusPlanet : null;
  if (want && !want._cs) ensureFocusSurface(want);
  var list = G.sys.planets;
  for (var i = 0; i < list.length; i++) {
    var p = list[i], cs = p._cs;
    if (!cs) continue;
    var on = (p === want);
    if (cs.group.visible !== on) {
      cs.group.visible = on;
      p._mesh.visible = !on;
      if (p._cloud) p._cloud.visible = !on;
    }
    if (!on) continue;
    var gp = p._group.position;
    var L = Math.sqrt(gp.x * gp.x + gp.y * gp.y + gp.z * gp.z) || 1;
    var ux = -gp.x / L, uy = -gp.y / L, uz = -gp.z / L;
    cs.mat.uniforms.uSunDir.value.set(ux, uy, uz);
    /* ★ v0.18：细节法线在**物体空间**求（零 RNG 的噪声锚在地表上，不随世界转），
     * 再乘这一份「物体 → 世界」的旋转回去受光。用 matrixWorld 的旋转部分，
     * 与几何用的是同一份变换 —— 不会出现受光方向与地表错开一帧。 */
    p._group.updateMatrixWorld();
    _csM4.copy(p._group.matrixWorld);
    _csM3.setFromMatrix4(_csM4);
    cs.mat.uniforms.uModel3.value.copy(_csM3);

    /* ★ LOD（hex + healpix 都走这里）：相机拉近/拉远跨过档位阈值就按新档重建，
     * 一格的屏幕尺寸因此始终压在十几 px，不会像固定 N 那样「拉得越近越糊」。
     * 两道闸门：档位真的变了 + 距上次换档 > 500ms（否则在阈值附近缩放会一直重建）。 */
    var wantLvl = focusLvlFor(p);
    if (cs.lvl && wantLvl !== cs.lvl
      && (performance.now() - (cs.switchedAt || 0)) > FOCUS_LOD_HOLD_MS) {
      rebuildFocusGeom(p);
    }
    /* 无分配：setHex 会走色彩管理，convertLinearToSRGB 还原成「raw sRGB」
     * —— 与 40-textures.rawColor 同一口径（纯 ShaderMaterial 直写输出） */
    _csSun.setHex(st.color).convertLinearToSRGB().lerp(_csWhite, 0.55).multiplyScalar(CS_SUN_K);
    cs.mat.uniforms.uSunCol.value.set(_csSun.r, _csSun.g, _csSun.b);
    if (cs.cloudMat) {
      cs.cloudMat.uniforms.uSunDir.value.set(ux, uy, uz);
      cs.cloudMat.uniforms.uSunCol.value.set(_csSun.r, _csSun.g, _csSun.b);
    }
  }
}

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
  var vpf = (N + 1) * (N + 1);
  var total = 6 * vpf;
  var dirs = new Float32Array(total * 3);
  var hgt = new Float32Array(total);
  var f, i, j, k, u, v, d;

  /* pass 1：方向 + 基底 + 范围（归一化常数） */
  k = 0;
  var mn = Infinity, mx = -Infinity;
  for (f = 0; f < 6; f++) {
    for (j = 0; j <= N; j++) {
      for (i = 0; i <= N; i++) {
        u = -1 + (2 * i) / N; v = -1 + (2 * j) / N;
        d = csCubeToSphere(u, v, f);
        dirs[k * 3] = d[0]; dirs[k * 3 + 1] = d[1]; dirs[k * 3 + 2] = d[2];
        var b = field.baseAt(d[0], d[1], d[2]);
        if (b < mn) mn = b;
        if (b > mx) mx = b;
        hgt[k] = b;                                  /* 暂存基底，pass 2 覆盖 */
        k++;
      }
    }
  }
  field.setRange(mn, mx);

  /* pass 2：特征叠加（坑 + 细节）→ 最终高程 */
  for (k = 0; k < total; k++) {
    var dx = dirs[k * 3], dy = dirs[k * 3 + 1], dz = dirs[k * 3 + 2];
    /* hAt 的归一化已就位；这里不能直接复用 hgt[k]（那是基底原值） */
    var h = (hgt[k] - mn) * (1 / Math.max(1e-6, mx - mn))
      + field.dentAt(dx, dy, dz) + field.detailAt(dx, dy, dz);
    hgt[k] = h;
  }

  /* pass 3：有海 → 分位数定海平面 + 重标定到 0.5（与 42-terrain 同一函数、
   * 同一保证：水面覆盖 = 挥发分丰度） */
  var sea = pr.sea;
  if (sea) {
    var seaLvl = quantile(hgt, clamp(p.water * 1.15, 0.05, 0.95));
    var lo = Infinity, hi = -Infinity;
    for (k = 0; k < total; k++) { if (hgt[k] < lo) lo = hgt[k]; if (hgt[k] > hi) hi = hgt[k]; }
    var sinv = 1.15 / Math.max(1e-6, hi - lo);
    for (k = 0; k < total; k++) hgt[k] = 0.5 + (hgt[k] - seaLvl) * sinv;
    field.setSea(seaLvl, sinv);
  }

  /* pass 4：位置 + 解析法线（有限差分；水面法线 = 径向） */
  var pos = new Float32Array(total * 3);
  var nor = new Float32Array(total * 3);
  var seaA = sea ? 0.5 : -1;
  var e = 0.9 * (Math.PI / 2) / N;                   /* 差分步长 ≈ 一格——比这更小
                                                        会采到网格表达不了的噪声 */
  var sig = 0, below = 0;
  for (k = 0; k < total; k++) {
    var vx = dirs[k * 3], vy = dirs[k * 3 + 1], vz = dirs[k * 3 + 2];
    var h2 = hgt[k];
    sig += h2;
    if (seaA > 0 && h2 < seaA) below++;
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
    geo: geo, amp: amp, field: field, N: N, verts: total, tris: idx.length / 3,
    seaFrac: seaA > 0 ? below / total : 0,
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
  "varying float vH;",
  "varying vec3 vWN;",       /* 世界空间法线：星球自转，光照得在物体空间之外算 */
  "varying vec3 vWDir;",     /* 世界空间径向：量坡度用 */
  "varying vec3 vDir;",      /* 物体空间方向：纬度（极冠）只跟它有关 */
  "void main() {",
  "  vH = aH;",
  "  vDir = normalize(position);",
  "  vWN = normalize(mat3(modelMatrix) * normal);",
  "  vWDir = normalize(mat3(modelMatrix) * position);",
  "  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);",
  "}"
].join("\n");

var FOCUS_FS = [
  "uniform sampler2D uRamp;",
  "uniform vec3 uSunDir; uniform vec3 uSunCol; uniform vec3 uAmb;",
  "uniform float uSea; uniform float uSnowH; uniform float uCapFrac; uniform float uLava;",
  "varying float vH; varying vec3 vWN; varying vec3 vWDir; varying vec3 vDir;",
  "void main() {",
  "  /* 色带：与贴图同一条（先 S 曲线拉伸，与 buildTerrainMaps 的取色口径一致） */",
  "  float hc = clamp(0.5 + (clamp(vH, 0.0, 1.0) - 0.5) * 1.55, 0.0, 1.0);",
  "  vec3 base = texture2D(uRamp, vec2(hc, 0.5)).rgb;",
  "  /* 水下吸收（与贴图同一公式）—— 浅海亮、深海暗 */",
  "  if (uSea > 0.0 && vH < uSea) {",
  "    float dep = clamp((uSea - vH) / 0.30, 0.0, 1.0);",
  "    base *= vec3(1.0 - 0.35 * dep, 1.0 - 0.22 * dep, 1.0 - 0.05 * dep);",
  "  }",
  "  /* 雪线 + 极冠（与贴图同一公式；边界取自连续高度/纬度，天然抗锯齿） */",
  "  if (uSnowH < 1.0) {",
  "    float t = clamp((vH - uSnowH) / max(0.06, 1.0 - uSnowH), 0.0, 1.0);",
  "    base = mix(base, vec3(0.96, 0.97, 0.99), t * 0.9);",
  "  }",
  "  if (uCapFrac > 0.0) {",
  "    float latL = abs(asin(clamp(vDir.y, -1.0, 1.0))) / 1.5707963;",
  "    float w = clamp((latL - (1.0 - uCapFrac)) / max(0.06, uCapFrac * 0.55), 0.0, 1.0);",
  "    base = mix(base, vec3(0.99, 0.99, 1.0), w * w);",
  "  }",
  "  /* 坡度暗化：地形可读性（潮汐锁定行星日照面几乎无影，纯光照会「看起来是平的」） */",
  "  vec3 wn = normalize(vWN);",
  "  float slope = 1.0 - max(dot(wn, normalize(vWDir)), 0.0);",
  "  base *= 1.0 - clamp(slope * 1.6, 0.0, 0.28);",
  "  /* 光照：真实恒星方向（受光量 = 物理量） */",
  "  float d1 = max(dot(wn, uSunDir), 0.0);",
  "  vec3 col = base * (uAmb + uSunCol * d1);",
  "  /* 熔岩自发光：只在最高处透出来（裂缝），与贴图 emissiveMap 同一口径 */",
  "  if (uLava > 0.5) {",
  "    float lit = clamp((vH - 0.80) / 0.20, 0.0, 1.0);",
  "    col += vec3(1.0, 0.62, 0.26) * lit * lit * 0.85;",
  "  }",
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

function ensureFocusSurface(p) {
  if (!p || p._cs || !isSolidPlanet(p)) return p ? p._cs || null : null;
  var pr = terrainParams(p);
  var g = buildFocusGeometry(p, pr, FOCUS_N);
  var mat = new THREE.ShaderMaterial({
    uniforms: {
      uRamp: { value: focusRampTex(pr.prof) },
      uSunDir: { value: new THREE.Vector3(1, 0, 0) },
      uSunCol: { value: new THREE.Vector3(1, 1, 1) },
      uAmb: { value: new THREE.Vector3(0.34, 0.38, 0.46) },
      uSea: { value: pr.sea ? 0.5 : -1 },
      uSnowH: { value: pr.snowH },
      uCapFrac: { value: pr.capFrac },
      uLava: { value: pr.lava ? 1 : 0 }
    },
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
        uOpacity: { value: 0.72 }
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
    N: g.N, verts: g.verts, tris: g.tris, ms: g.ms, seaFrac: g.seaFrac, sig: g.sig,
    /* ★ v0.13：连续场 + 位移幅度 + 海平面 —— 聚落系统（46）的就地查询口 */
    field: g.field, amp: g.amp, sea: pr.sea ? 0.5 : -1
  };
  /* ★ v0.13：重建后城市网格自愈（城市数据是唯一真值源，几何是派生） */
  syncCityMeshes(p);
  return p._cs;
}

/* 太阳色：与 buildStarVisual 的灯同一构造（星色向白偏 0.55），强度统一系数 */
var CS_SUN_K = 1.02;
var _csWhite = new THREE.Color(1, 1, 1);
var _csSun = new THREE.Color();

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

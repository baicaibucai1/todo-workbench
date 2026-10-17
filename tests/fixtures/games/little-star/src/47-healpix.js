/* ================= HEALPix（v0.18）：等面积分层球面像素化 ================= */

/* 是什么：把球面切成 12·nside² 个**面积严格相同**的像素，像素中心落在
 * 4·nside−1 条等纬圈上（Górski et al. 2005）。用它换掉立方球，图的是三件事：
 *
 *   ① **等面积**：数像素就是数面积。海平面分位数 / 水面覆盖 / 陆地占比这些
 *      统计量因此**无偏** —— 立方球在立方体棱角处密、面心处疏（实测单元面积
 *      最大/最小 1.286），数顶点是有偏的估计。
 *   ② **层次**：nside 翻一倍 = 每个像素四分。分辨率因此可以跟着相机走
 *      （LOD 阶梯），不必像 N 那样一锤定音。
 *   ③ **同样的「N」下更细**：nside=64 的单元角尺寸 0.916°，立方球 N=64 是
 *      1.195~1.355°（均值 1.27°）。近景糊的根子就在这儿。
 *
 * ── 公式（与 Górski 2004 / SpeedyWeather 文档逐项一致，勿凭记忆改）──────
 *   环 j = 1 .. 4n−1（j=1 最靠北极）：
 *   北极冠  j < n        ：z = 1 − j²/(3n²)              每环 4j 个像素
 *   赤道带  n ≤ j ≤ 3n   ：z = 4/3 − 2j/(3n)             每环 4n 个像素
 *   南极冠  j > 3n       ：z = −1 + (4n−j)²/(3n²)        每环 4(4n−j) 个像素
 *   经度   北极冠 φ = (π/2j)(i − ½)
 *          赤道带 φ = (π/2n)(i − s/2)，s = (j−n+1) mod 2（逐环错开半个像素
 *                     —— 这就是 HEALPix 赤道带那片菱形格的来处）
 *          南极冠 与北极冠同式，j' = 4n−j
 *   像素面积恒为 4π/(12n²)；赤道带可直接解析核对：Δz = 2/(3n)、Δφ = 2π/(4n)
 *   → 面积 = 4π/(12n²) ✓（极冠的像素边界是**曲线** cosθ = a + b/φ²，靠它补齐
 *   等面积 —— 我们只用中心点，不画曲线边界）。
 *
 * ── 网格怎么搭 ──────────────────────────────────────────────────
 *   顶点 = 像素中心（12n² 个，再加两个极点），相邻两环之间用「拉链」算法连成
 *   三角带：两环像素数不同（极冠 4j ↔ 4(j+1)）也能无缝，不会出现 T 型裂缝。
 *   于是顶点数 = 12n²+2、三角形数 = 24n²（两条都可被机器复算，见 verify）。
 *   ★ 极冠里这样搭出来的格子的**形状**不是 HEALPix 那条曲线边界围出的像素
 *     （面积也就不严格相等）—— 但采样点是真的 HEALPix 中心，统计无偏；
 *     网格只负责「剪影 + 位移」，这点差异看不出来。
 *
 * ★ 零 RNG：全是坐标的解析函数，主随机流一格不碰（focusSurface 的构建/重建
 *   必须保持 rngDraws 不变）。
 */

/* LOD 阶梯：nside 越大越细。上限 128 —— 再往上构建耗时（≈像素数×3 次求高）
 * 会到 0.8s 级别，那是玩家能感觉到的卡顿，不值。 */
var HP_LADDER = [32, 64, 128];
var HP_TARGET_PX = 9;         /* 目标：一个单元在屏幕上不超过 9px */
var HP_STAT_NSIDE = 64;       /* 统计用的采样密度（网格 nside 变化时统计量不变） */

function hpNpix(nside) { return 12 * nside * nside; }
function hpArea(nside) { return 4 * Math.PI / hpNpix(nside); }
function hpCellRad(nside) { return Math.sqrt(hpArea(nside)); }   /* 单元角尺寸（rad） */
function hpRings(nside) { return 4 * nside - 1; }

function hpRingZ(nside, j) {
  var n = nside;
  if (j < n) return 1 - (j * j) / (3 * n * n);
  if (j <= 3 * n) return 4 / 3 - (2 * j) / (3 * n);
  return -1 + (4 * n - j) * (4 * n - j) / (3 * n * n);
}
function hpRingN(nside, j) {
  var n = nside;
  if (j < n) return 4 * j;
  if (j <= 3 * n) return 4 * n;
  return 4 * (4 * n - j);
}
/* 环 j 上第 i 个像素中心的经度（i 从 0 起） */
function hpRingPhi(nside, j, i) {
  var n = nside;
  if (j < n) return (Math.PI / (2 * j)) * (i + 0.5);
  if (j <= 3 * n) {
    var s = (j - n + 1) % 2;
    return (Math.PI / (2 * n)) * (i + 0.5 - s / 2);
  }
  var jj = 4 * n - j;
  return (Math.PI / (2 * jj)) * (i + 0.5);
}

/* 选档：让「一个单元在屏幕上 ≤ HP_TARGET_PX」的最小 nside。
 * pxPerRad = 屏幕每弧度多少像素（由焦距与相机到表面的距离算出）。 */
function hpPickNside(pxPerRad) {
  for (var i = 0; i < HP_LADDER.length; i++) {
    if (hpCellRad(HP_LADDER[i]) * pxPerRad <= HP_TARGET_PX) return HP_LADDER[i];
  }
  return HP_LADDER[HP_LADDER.length - 1];
}

/* ---- 统计：与显示网格解耦（v0.18） ----
 * 海平面分位数 / 高度归一化若在**显示网格**上求，LOD 换档（32↔64↔128）就会
 * 挪动海岸线与起伏幅度 —— 聚焦时缩放一下地表就「跳一下」，聚落面板的陆地%
 * 也跟着变。因此统计在固定等面积采样（HP_STAT_NSIDE，12n² 格）上求一次、
 * 按行星缓存；cube 与 healpix 两种网格共用同一份 ⇒ 同一颗星球只有一种地表。
 * 全是坐标的解析函数，零 RNG（rngDraws 一格不碰）。 */
function hpStatSample(field, p, water) {
  if (p._hpStat) return p._hpStat;
  var n = HP_STAT_NSIDE, nring = hpRings(n), npix = hpNpix(n);
  var dirs = new Float32Array(npix * 3);
  var h = new Float32Array(npix);
  var mn = Infinity, mx = -Infinity, k = 0, j, i;
  for (j = 1; j <= nring; j++) {
    var N = hpRingN(n, j), z = hpRingZ(n, j);
    var rr = Math.sqrt(Math.max(0, 1 - z * z));
    for (i = 0; i < N; i++) {
      var phi = hpRingPhi(n, j, i);
      var dx = rr * Math.cos(phi), dz = rr * Math.sin(phi);
      dirs[k * 3] = dx; dirs[k * 3 + 1] = z; dirs[k * 3 + 2] = dz;
      var b = field.baseAt(dx, z, dz);
      if (b < mn) mn = b;
      if (b > mx) mx = b;
      h[k] = b; k++;
    }
  }
  field.setRange(mn, mx);
  var inv = 1 / Math.max(1e-6, mx - mn);
  var lo = Infinity, hi = -Infinity;
  for (k = 0; k < npix; k++) {
    var dx = dirs[k * 3], dy = dirs[k * 3 + 1], dz = dirs[k * 3 + 2];
    h[k] = (h[k] - mn) * inv + field.dentAt(dx, dy, dz) + field.detailAt(dx, dy, dz);
    if (h[k] < lo) lo = h[k];
    if (h[k] > hi) hi = h[k];
  }
  var seaLvl = 0, sinv = 0, below = 0;
  if (water) {
    seaLvl = quantile(h, clamp(p.water * 1.15, 0.05, 0.95));
    sinv = 1.15 / Math.max(1e-6, hi - lo);
    for (k = 0; k < npix; k++) if (0.5 + (h[k] - seaLvl) * sinv < 0.5) below++;
  }
  return (p._hpStat = { mn: mn, mx: mx, seaLvl: seaLvl, sinv: sinv, below: below, npix: npix });
}

/* ---- 几何：像素中心当顶点，环间拉链 ---- */
function buildHealpixGeometry(p, pr, nside) {
  var t0 = performance.now();
  var amp = 0.075 * clamp(pr.relief, 0.3, 1.5);
  var field = makeFocusField(p, pr);              /* ★ 与立方球同源（44） */
  var st = hpStatSample(field, p, pr.sea);        /* ★ 统计与网格解耦（见上） */
  var n = nside, nring = hpRings(n), npix = hpNpix(n);
  var vcount = npix + 2;                          /* 像素中心 + 南北极点 */
  var dirs = new Float32Array(vcount * 3);
  var phis = new Float32Array(npix);              /* ★ 每顶点经度（拉链按真实角度走） */
  var ringStart = new Int32Array(nring + 2);
  var ringN = new Int32Array(nring + 2);
  var k, j, i;

  /* ① 方向表 + 环索引 */
  k = 0;
  for (j = 1; j <= nring; j++) {
    var N = hpRingN(n, j), z = hpRingZ(n, j);
    var rr = Math.sqrt(Math.max(0, 1 - z * z));
    ringStart[j] = k; ringN[j] = N;
    for (i = 0; i < N; i++) {
      var phi = hpRingPhi(n, j, i);
      phis[k] = phi;
      dirs[k * 3] = rr * Math.cos(phi);
      dirs[k * 3 + 1] = z;
      dirs[k * 3 + 2] = rr * Math.sin(phi);
      k++;
    }
  }
  var iN = npix, iS = npix + 1;
  dirs[iN * 3] = 0; dirs[iN * 3 + 1] = 1; dirs[iN * 3 + 2] = 0;
  dirs[iS * 3] = 0; dirs[iS * 3 + 1] = -1; dirs[iS * 3 + 2] = 0;

  /* ② 高程：基底 → 归一 → 坑 + 细节（与立方球逐段同序，保证同一颗星球）。
   *    范围用**固定等面积采样**的统计（st），不再各自为政。 */
  var hgt = new Float32Array(vcount);
  field.setRange(st.mn, st.mx);
  var inv = 1 / Math.max(1e-6, st.mx - st.mn);
  for (k = 0; k < vcount; k++) {
    var dx = dirs[k * 3], dy = dirs[k * 3 + 1], dz = dirs[k * 3 + 2];
    hgt[k] = (field.baseAt(dx, dy, dz) - st.mn) * inv
      + field.dentAt(dx, dy, dz) + field.detailAt(dx, dy, dz);
  }

  /* ③ 海平面：分位数与缩放都来自固定采样（st）⇒ 换档不动海岸线 */
  var sea = pr.sea, seaA = sea ? 0.5 : -1, below = st.below, sig = 0;
  if (sea) {
    var seaLvl = st.seaLvl, sinv = st.sinv;
    for (k = 0; k < vcount; k++) hgt[k] = 0.5 + (hgt[k] - seaLvl) * sinv;
    field.setSea(seaLvl, sinv);
  }
  for (k = 0; k < npix; k++) sig += hgt[k];

  /* ④ 位置 + 解析法线（有限差分；水面法线 = 径向） */
  var pos = new Float32Array(vcount * 3);
  var nor = new Float32Array(vcount * 3);
  var e = 0.9 * hpCellRad(n);                     /* 差分步长 ≈ 一个单元 */
  for (k = 0; k < vcount; k++) {
    var vx = dirs[k * 3], vy = dirs[k * 3 + 1], vz = dirs[k * 3 + 2];
    var h2 = hgt[k];
    var disp = h2 > 0.5 ? amp * (h2 - 0.5) : 0;   /* 海面压平（水下不参与位移） */
    var rad = p.size * (1 + disp);
    pos[k * 3] = vx * rad; pos[k * 3 + 1] = vy * rad; pos[k * 3 + 2] = vz * rad;
    var nx, ny, nz;
    if (seaA > 0 && h2 <= seaA) { nx = vx; ny = vy; nz = vz; }
    else {
      var t1x = -vz, t1y = 0, t1z = vx;
      var t1L = Math.sqrt(t1x * t1x + t1z * t1z);
      if (t1L < 1e-6) { t1x = 1; t1y = 0; t1z = 0; t1L = 1; }
      t1x /= t1L; t1z /= t1L;
      var t2x = vy * t1z - vz * t1y, t2y = vz * t1x - vx * t1z, t2z = vx * t1y - vy * t1x;
      var h0 = field.hAt(vx, vy, vz);
      var ha = field.hAt(vx + t1x * e, vy + t1y * e, vz + t1z * e);
      var hb = field.hAt(vx + t2x * e, vy + t2y * e, vz + t2z * e);
      var s = p.size * amp;
      var g1 = (ha - h0) * s / e, g2 = (hb - h0) * s / e;
      nx = vx - (t1x * g1 + t2x * g2);
      ny = vy - (t1y * g1 + t2y * g2);
      nz = vz - (t1z * g1 + t2z * g2);
      var nL = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      nx /= nL; ny /= nL; nz /= nL;
    }
    nor[k * 3] = nx; nor[k * 3 + 1] = ny; nor[k * 3 + 2] = nz;
  }

  /* ⑤ 三角带：相邻两环按**真实经度中点**拉链 + 两极的扇形盖。
   * ★★ 不能按「索引占比」拉（v0.18 首版的真 bug）：赤道带相邻环错开半个像素
   *   （HEALPix 菱形格），中心点连线因此是**三角格**不是四边格 —— 按索引强行
   *   配四边形会拉出互相重叠的折叠三角形，z-fighting 成整条赤道带的网点
   *   （实测网点密度按纬度分布在 z=−2/3 处断崖：带内 g≈65，南冠 g≈6）。
   *   按角度走则天然得到正确的三角格：谁的中点先到就推谁一格，一格一三角。
   *   三角形数不变：每环对恰发出 N_j + N_{j+1} 个，总计仍 2·npix = 24n²。 */
  function midPhi(base, cnt, i2) {                /* 环内第 i2/i2+1 顶点间的中点经度（跨缝自动 +2π） */
    var p0 = phis[base + (i2 % cnt)], p1 = phis[base + ((i2 + 1) % cnt)];
    if (p1 < p0) p1 += 2 * Math.PI;
    return 0.5 * (p0 + p1);
  }
  var tris = 2 * npix;                             /* 可机器复算：Σ(N_j + N_{j+1}) + 8 */
  var idx = new Uint32Array(tris * 3);
  var t = 0;
  for (j = 1; j < nring; j++) {
    var m = ringN[j], kk = ringN[j + 1];
    var a0 = ringStart[j], b0 = ringStart[j + 1];
    var ia = 0, ib = 0;
    while (ia < m || ib < kk) {
      var ea = ia < m ? midPhi(a0, m, ia) : Infinity;
      var eb = ib < kk ? midPhi(b0, kk, ib) : Infinity;
      var A = a0 + Math.min(ia, m - 1), B = b0 + Math.min(ib, kk - 1);
      if (eb < ea) { idx[t++] = A; idx[t++] = B; idx[t++] = b0 + ((ib + 1) % kk); ib++; }
      else { idx[t++] = A; idx[t++] = B; idx[t++] = a0 + ((ia + 1) % m); ia++; }
    }
  }
  /* 极点扇形（第 1 环 / 末环各 4 个点） */
  for (i = 0; i < ringN[1]; i++) {
    idx[t++] = iN; idx[t++] = ringStart[1] + i; idx[t++] = ringStart[1] + ((i + 1) % ringN[1]);
  }
  var lastR = nring, lN = ringN[lastR], lS = ringStart[lastR];
  for (i = 0; i < lN; i++) {
    idx[t++] = iS; idx[t++] = lS + ((i + 1) % lN); idx[t++] = lS + i;
  }
  /* 缠绕方向：按「面法线朝外」逐面校正（省得在两套环序里推符号）。
   * ★ 别复用 t：它是上面填索引的游标，这里再用会把上报的面数冲掉。 */
  for (var w = 0; w < tris; w++) {
    var o = w * 3, a = idx[o], b = idx[o + 1], c = idx[o + 2];
    var ax = pos[b * 3] - pos[a * 3], ay = pos[b * 3 + 1] - pos[a * 3 + 1], az = pos[b * 3 + 2] - pos[a * 3 + 2];
    var bx = pos[c * 3] - pos[a * 3], by = pos[c * 3 + 1] - pos[a * 3 + 1], bz = pos[c * 3 + 2] - pos[a * 3 + 2];
    var cx2 = ay * bz - az * by, cy2 = az * bx - ax * bz, cz2 = ax * by - ay * bx;
    var rx = pos[a * 3] + pos[b * 3] + pos[c * 3];
    var ry = pos[a * 3 + 1] + pos[b * 3 + 1] + pos[c * 3 + 1];
    var rz = pos[a * 3 + 2] + pos[b * 3 + 2] + pos[c * 3 + 2];
    if (cx2 * rx + cy2 * ry + cz2 * rz < 0) { var tmp = idx[o + 1]; idx[o + 1] = idx[o + 2]; idx[o + 2] = tmp; }
  }

  var geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute("aH", new THREE.Float32BufferAttribute(hgt, 1));
  geo.setIndex(new THREE.Uint32BufferAttribute(idx, 1));
  return {
    geo: geo, amp: amp, field: field, nside: nside, lvl: nside, N: nside,
    verts: vcount, tris: tris,
    seaFrac: seaA > 0 ? below / st.npix : 0,
    sig: +sig.toFixed(3), ms: Math.round(performance.now() - t0)
  };
}

/* ============================================================================
 * Goldberg 多面体（v0.19）：六边形 + 12 个五边形拼成一个球面
 * ==========================================================================
 * 用户为什么要换：「改成六边形和五边形拼接成球面」—— HEALPix 的**统计**无可挑剔
 * （严格等面积），但它铺出来的是菱形格，肉眼看不出「球面是被一块块拼起来的」。
 * 能同时满足「每个铺砌单元同构」与「恰好拼满球面」的，是 geodesic 的**对偶**
 * = Goldberg 多面体（C60 那一族）：
 *
 *   正二十面体每条边分 ν 段 → 20ν² 个小三角 → 顶点 10ν²+2 个；
 *   每个顶点周围恰好 5 或 6 个三角形 ⇒ 对偶出来的每个**面**就是 5 或 6 边形，
 *   五边形正好 12 个（正二十面体原本的 12 个顶点，曲率缺陷躲不掉），
 *   其余 10ν²−10 个是六边形。
 *
 * 数量关系（全可被机器复算，verify [22] 逐条验）：
 *   格数     = 10ν² + 2        （= 细分球顶点数）
 *   五边形   = 12
 *   六边形   = 10ν² − 10
 *   三角形   = 3 × 20ν² = 60ν² （每个 k 边形发 k 个三角扇）
 *   顶点     = 格心副本 + Σk = (10ν²+2) + 60ν² = 70ν² + 2
 *
 * ★ 为什么 ν 只能是 2 的幂：网格靠 1→4 递归细分生成，每条边的中点用**整数键**
 *   (a,b) 缓存去重 —— 一旦用浮点坐标当哈希键做合并，接缝两侧「相等的」两个点
 *   可能量化到不同桶里 ⇒ 共享边被拆成两条 ⇒ 那个顶点各自只拿到一半邻面 ⇒
 *   复发「折叠三角形」那一类事故（签到过一次，不重来）。
 *
 * ★ 严格等面积的六边形球不存在 —— 所以 **统计仍然走上面的 HEALPix 采样**：
 *     显示网格 = Goldberg（好看） · 统计采样 = HEALPix（无偏）
 *   两者解耦，换网格 / 换 LOD 档都不会挪动海岸线（hpStatSample 的功劳）。
 *
 * ★ 零 RNG：全是坐标的解析函数 + 按索引的哈希，主随机流一格不碰。
 */

var HEX_LADDER = [8, 16, 32];   /* ν 阶梯（必须是 2 的幂，见上） */
var HEX_TARGET_PX = 26;         /* 一格在屏幕上不超过 26px —— 再小就看不出「是一块一块的」了 */
var HEX_PLATEAU_K = 0.45;       /* 一格一高：着色时向「本格中心高程」混合的比例 */
var HEX_ALBEDO_K = 0.07;        /* 每格反照率抖动（让同一片地形看出格子） */
var HEX_EDGE_K = 0.16;          /* 格边界压暗（读/bindings 见 44 片元 ⑦b） */

function hexCells(nu) { return 10 * nu * nu + 2; }
function hexCellRad(nu) { return Math.sqrt(4 * Math.PI / hexCells(nu)); }   /* 一格边长量级（rad） */
function hexPickNu(pxPerRad) {
  for (var i = 0; i < HEX_LADDER.length; i++) {
    if (hexCellRad(HEX_LADDER[i]) * pxPerRad <= HEX_TARGET_PX) return HEX_LADDER[i];
  }
  return HEX_LADDER[HEX_LADDER.length - 1];
}

/* ---- 正二十面体 + 1→4 递归细分（按 ν 缓存：与行星无关） ---- */
var _geoSph = {};
function geoSphere(nu) {
  if (_geoSph[nu]) return _geoSph[nu];
  var t0 = (1 + Math.sqrt(5)) / 2;
  var rv = [
    [-1, t0, 0], [1, t0, 0], [-1, -t0, 0], [1, -t0, 0],
    [0, -1, t0], [0, 1, t0], [0, -1, -t0], [0, 1, -t0],
    [t0, 0, -1], [t0, 0, 1], [-t0, 0, -1], [-t0, 0, 1]
  ];
  /* 标准面表（外法线 CCW）；缠绕最终还有一道几何校正，符号对不对不至于致命 */
  var rf = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]
  ];
  var vx = [], fx = [], i;
  for (i = 0; i < 12; i++) {
    var ax = rv[i][0], ay = rv[i][1], az = rv[i][2];
    var L0 = Math.sqrt(ax * ax + ay * ay + az * az);
    vx.push(ax / L0, ay / L0, az / L0);
  }
  for (i = 0; i < 20; i++) fx.push(rf[i][0], rf[i][1], rf[i][2]);

  var levels = Math.round(Math.log(nu) / Math.LN2);
  for (var lv = 0; lv < levels; lv++) {
    var cache = Object.create(null);
    var nf = fx.length / 3;
    var of = new Int32Array(nf * 12);
    var o = 0;
    /* 一条边的中点只建一次 —— 整数键去重，不看浮点坐标（见上方 ★） */
    var midOf = function (a, b) {
      var key = a < b ? a * 1e7 + b : b * 1e7 + a;
      var m = cache[key];
      if (m !== undefined) return m;
      var sx = vx[a * 3] + vx[b * 3], sy = vx[a * 3 + 1] + vx[b * 3 + 1], sz = vx[a * 3 + 2] + vx[b * 3 + 2];
      var L = Math.sqrt(sx * sx + sy * sy + sz * sz) || 1;
      m = vx.length / 3;
      vx.push(sx / L, sy / L, sz / L);
      cache[key] = m;
      return m;
    };
    for (var f = 0; f < nf; f++) {
      var a = fx[f * 3], b = fx[f * 3 + 1], c = fx[f * 3 + 2];
      var ab = midOf(a, b), bc = midOf(b, c), ca = midOf(c, a);
      of[o++] = a; of[o++] = ab; of[o++] = ca;
      of[o++] = ab; of[o++] = b; of[o++] = bc;
      of[o++] = ca; of[o++] = bc; of[o++] = c;
      of[o++] = ab; of[o++] = bc; of[o++] = ca;
    }
    fx = of;
  }
  return (_geoSph[nu] = { v: new Float32Array(vx), f: fx });
}

/* ---- 几何：Goldberg 的每一格 = 一个三角扇 ---- */
function buildHexGeometry(p, pr, nu) {
  var t0 = performance.now();
  var amp = 0.075 * clamp(pr.relief, 0.3, 1.5);
  var field = makeFocusField(p, pr);            /* ★ 与 HEALPix / 立方球同源（44） */
  var st = hpStatSample(field, p, pr.sea);      /* ★ 统计仍走 HEALPix 采样（网格无关） */
  var gs = geoSphere(nu);
  var V = gs.v.length / 3, F = gs.f.length / 3;
  var PN = V + F;                               /* 唯一的采样点：格心 + 格角 */
  var dir = new Float32Array(PN * 3);
  var k, i, f;

  /* ① 采样点：格心 = 细分球顶点；格角 = 相邻三角形的外心范数（对偶的定义） */
  dir.set(gs.v, 0);
  for (f = 0; f < F; f++) {
    var a = gs.f[f * 3], b = gs.f[f * 3 + 1], c = gs.f[f * 3 + 2];
    var cx = gs.v[a * 3] + gs.v[b * 3] + gs.v[c * 3];
    var cy = gs.v[a * 3 + 1] + gs.v[b * 3 + 1] + gs.v[c * 3 + 1];
    var cz = gs.v[a * 3 + 2] + gs.v[b * 3 + 2] + gs.v[c * 3 + 2];
    var cl = Math.sqrt(cx * cx + cy * cy + cz * cz) || 1;
    var oo = (V + f) * 3;
    dir[oo] = cx / cl; dir[oo + 1] = cy / cl; dir[oo + 2] = cz / cl;
  }

  /* ② 高程：基底 → 归一化用固定采样的 mn/mx → 坑 + 细节（与另两种网格逐段同序） */
  var hgt = new Float32Array(PN);
  for (k = 0; k < PN; k++) {
    hgt[k] = field.baseAt(dir[k * 3], dir[k * 3 + 1], dir[k * 3 + 2]);
  }
  field.setRange(st.mn, st.mx);
  var inv = 1 / Math.max(1e-6, st.mx - st.mn);
  for (k = 0; k < PN; k++) {
    var dx = dir[k * 3], dy = dir[k * 3 + 1], dz = dir[k * 3 + 2];
    hgt[k] = (hgt[k] - st.mn) * inv + field.dentAt(dx, dy, dz) + field.detailAt(dx, dy, dz);
  }
  var sea = pr.sea, seaA = sea ? 0.5 : -1;
  if (sea) {
    var seaLvl = st.seaLvl, sinv = st.sinv;
    for (k = 0; k < PN; k++) hgt[k] = 0.5 + (hgt[k] - seaLvl) * sinv;
    field.setSea(seaLvl, sinv);
  }

  /* ③ 位置 + 解析法线（与 HEALPix 同一套：有限差分 + 水面法线取径向） */
  var pn = new Float32Array(PN * 3), nn = new Float32Array(PN * 3);
  var e = 0.85 * hexCellRad(nu);                /* 差分步长 ≈ 一格 */
  for (k = 0; k < PN; k++) {
    var vx = dir[k * 3], vy = dir[k * 3 + 1], vz = dir[k * 3 + 2];
    var h2 = hgt[k];
    var disp = h2 > 0.5 ? amp * (h2 - 0.5) : 0;
    var rad = p.size * (1 + disp);
    pn[k * 3] = vx * rad; pn[k * 3 + 1] = vy * rad; pn[k * 3 + 2] = vz * rad;
    var nx, ny, nz;
    if (seaA > 0 && h2 <= seaA) { nx = vx; ny = vy; nz = vz; }
    else {
      var t1x = -vz, t1y = 0, t1z = vx;
      var t1L = Math.sqrt(t1x * t1x + t1z * t1z);
      if (t1L < 1e-6) { t1x = 1; t1y = 0; t1z = 0; t1L = 1; }
      t1x /= t1L; t1z /= t1L;
      var t2x = vy * t1z - vz * t1y, t2y = vz * t1x - vx * t1z, t2z = vx * t1y - vy * t1x;
      var h0 = field.hAt(vx, vy, vz);
      var ha = field.hAt(vx + t1x * e, vy + t1y * e, vz + t1z * e);
      var hb = field.hAt(vx + t2x * e, vy + t2y * e, vz + t2z * e);
      var s = p.size * amp;
      var g1 = (ha - h0) * s / e, g2 = (hb - h0) * s / e;
      nx = vx - (t1x * g1 + t2x * g2);
      ny = vy - (t1y * g1 + t2y * g2);
      nz = vz - (t1z * g1 + t2z * g2);
      var nL = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      nx /= nL; ny /= nL; nz /= nL;
    }
    nn[k * 3] = nx; nn[k * 3 + 1] = ny; nn[k * 3 + 2] = nz;
  }

  /* ④ 邻接：每个格心周围有哪些格角（= 它周围有哪些三角形）。必须按**绕格心的
     真实方位角**排序 —— 排出来的环就是这一格的多边形边界。 */
  var deg = new Int32Array(V + 1), start = new Int32Array(V + 1);
  for (f = 0; f < F; f++) {
    deg[gs.f[f * 3]]++; deg[gs.f[f * 3 + 1]]++; deg[gs.f[f * 3 + 2]]++;
  }
  var tot = 0;
  for (i = 0; i < V; i++) { start[i] = tot; tot += deg[i]; }
  start[V] = tot;                               /* = 3F = 60ν² */
  var cur = new Int32Array(V);
  for (i = 0; i < V; i++) cur[i] = start[i];
  var nbr = new Int32Array(tot);                /* 每格自己的、已排好绕序的角点表 */
  for (f = 0; f < F; f++) {
    nbr[cur[gs.f[f * 3]]++] = f;
    nbr[cur[gs.f[f * 3 + 1]]++] = f;
    nbr[cur[gs.f[f * 3 + 2]]++] = f;
  }
  for (i = 0; i < V; i++) {
    var bx = gs.v[i * 3], by = gs.v[i * 3 + 1], bz = gs.v[i * 3 + 2];
    var e1x = -bz, e1y = 0, e1z = bx;
    var e1L = Math.sqrt(e1x * e1x + e1z * e1z);
    if (e1L < 1e-6) { e1x = 1; e1y = 0; e1z = 0; e1L = 1; }
    e1x /= e1L; e1z /= e1L;
    var e2x = by * e1z - bz * e1y, e2y = bz * e1x - bx * e1z, e2z = bx * e1y - by * e1x;
    var s0 = start[i], dn = deg[i];
    /* 插入排序（每格 5~6 个）：闭包里算方位角，避免临时数组 */
    var ang = function (ff) {
      var ox = dir[(V + ff) * 3] - bx, oy = dir[(V + ff) * 3 + 1] - by, oz = dir[(V + ff) * 3 + 2] - bz;
      return Math.atan2(ox * e2x + oy * e2y + oz * e2z, ox * e1x + oy * e1y + oz * e1z);
    };
    for (var q = 1; q < dn; q++) {
      var ff = nbr[s0 + q], wa = ang(ff), r = q - 1;
      while (r >= 0 && ang(nbr[s0 + r]) > wa) { nbr[s0 + r + 1] = nbr[s0 + r]; r--; }
      nbr[s0 + r + 1] = ff;
    }
  }

  /* ⑤ 顶点：每格**各写一份**自己的角点（共享关系靠「同一份 Results 值」保证——
   *    同一坐标两次算出来的 pos/nor 逐位相同，所以看起来是无缝的），
   *    省去跨格索引，也让「每格一个属性」（aCell / aCellH）成为可能。 */
  var pents = 0, hexes = 0;
  for (i = 0; i < V; i++) { if (deg[i] === 5) pents++; else if (deg[i] === 6) hexes++; }
  var vcount = V + tot;                         /* 格心副本 + Σk = 70ν²+2 */
  var pos = new Float32Array(vcount * 3);
  var nor = new Float32Array(vcount * 3);
  var aH = new Float32Array(vcount);
  var aCellH = new Float32Array(vcount);
  var aCell = new Float32Array(vcount);
  var aEdge = new Float32Array(vcount);
  var cellHash = new Float32Array(V);
  for (i = 0; i < V; i++) cellHash[i] = _ch31(i * 0.137 + 0.71, 3.13, i * 0.061 + 1.7);

  function writeVert(o3, src, hHere, cellH, hv, ed) {
    pos[o3] = pn[src * 3]; pos[o3 + 1] = pn[src * 3 + 1]; pos[o3 + 2] = pn[src * 3 + 2];
    nor[o3] = nn[src * 3]; nor[o3 + 1] = nn[src * 3 + 1]; nor[o3 + 2] = nn[src * 3 + 2];
    aH[o3 / 3] = hHere; aCellH[o3 / 3] = cellH; aCell[o3 / 3] = hv; aEdge[o3 / 3] = ed;
  }
  var vc = 0;
  for (i = 0; i < V; i++) {
    for (var q = 0; q < deg[i]; q++) {
      var fq = nbr[start[i] + q];
      writeVert(vc * 3, V + fq, hgt[V + fq], hgt[i], cellHash[i], 1);
      vc++;
    }
  }
  var cbase = vc;
  for (i = 0; i < V; i++) {
    writeVert(vc * 3, i, hgt[i], hgt[i], cellHash[i], 0);
    vc++;
  }

  /* ⑥ 三角扇：格心 + 相邻两角。每条边对应一个三角形 ⇒ 三角形数 = tot = 60ν² */
  var tris = tot;
  var idx = new Uint32Array(tris * 3);
  var t = 0;
  for (i = 0; i < V; i++) {
    var base = start[i], dn2 = deg[i], ctr = cbase + i;
    for (var q2 = 0; q2 < dn2; q2++) {
      idx[t++] = ctr;
      idx[t++] = base + q2;
      idx[t++] = base + ((q2 + 1) % dn2);
    }
  }
  /* 缠绕：逐面按「面法线朝外」校正（与 HEALPix 同一道保险）。
   * ★ 别复用 t（它是填索引的游标），用独立游标 w。 */
  for (var w = 0; w < tris; w++) {
    var o = w * 3, ia2 = idx[o], ib2 = idx[o + 1], ic2 = idx[o + 2];
    var axx = pos[ib2 * 3] - pos[ia2 * 3], ayy = pos[ib2 * 3 + 1] - pos[ia2 * 3 + 1], azz = pos[ib2 * 3 + 2] - pos[ia2 * 3 + 2];
    var bxx = pos[ic2 * 3] - pos[ia2 * 3], byy = pos[ic2 * 3 + 1] - pos[ia2 * 3 + 1], bzz = pos[ic2 * 3 + 2] - pos[ia2 * 3 + 2];
    var ccx = ayy * bzz - azz * byy, ccy = azz * bxx - axx * bzz, ccz = axx * byy - ayy * bxx;
    var rx = pos[ia2 * 3] + pos[ib2 * 3] + pos[ic2 * 3];
    var ry = pos[ia2 * 3 + 1] + pos[ib2 * 3 + 1] + pos[ic2 * 3 + 1];
    var rz = pos[ia2 * 3 + 2] + pos[ib2 * 3 + 2] + pos[ic2 * 3 + 2];
    if (ccx * rx + ccy * ry + ccz * rz < 0) { var tm = idx[o + 1]; idx[o + 1] = idx[o + 2]; idx[o + 2] = tm; }
  }

  /* ⑦ 高程签名：只取格心（逐格求和），与网格种类无关的稳定指纹 */
  var sig = 0;
  for (i = 0; i < V; i++) sig += hgt[i];

  var geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute("aH", new THREE.Float32BufferAttribute(aH, 1));
  geo.setAttribute("aCellH", new THREE.Float32BufferAttribute(aCellH, 1));
  geo.setAttribute("aCell", new THREE.Float32BufferAttribute(aCell, 1));
  geo.setAttribute("aEdge", new THREE.Float32BufferAttribute(aEdge, 1));
  geo.setIndex(new THREE.Uint32BufferAttribute(idx, 1));
  return {
    geo: geo, amp: amp, field: field, nu: nu, lvl: nu, N: nu,
    verts: vcount, tris: tris, pents: pents, hexes: hexes,
    seaFrac: seaA > 0 ? st.below / st.npix : 0,
    sig: +sig.toFixed(3), ms: Math.round(performance.now() - t0)
  };
}

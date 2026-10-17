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
    geo: geo, amp: amp, field: field, nside: nside, N: nside,
    verts: vcount, tris: tris,
    seaFrac: seaA > 0 ? below / st.npix : 0,
    sig: +sig.toFixed(3), ms: Math.round(performance.now() - t0)
  };
}

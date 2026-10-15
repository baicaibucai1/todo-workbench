/* ================= 地形生成器（v0.11：固态行星表面构建） ================= */

/* 是什么：把「行星表面」从「画笔涂色」升级为「地形构建」。
 *
 * 旧做法是在画布上随机撒色块（blobs）——远景勉强能看，一旦聚焦贴近就只剩
 * 糊成一团的斑。这里改成一条**构建管线**：先算出一张真实的**高程场**（每个
 * 像素的高度都是算出来的），再由「高度 + 纬度 + 物理数据」调色，最后把同一
 * 份高程导出成凹凸贴图（bumpMap）——贴近时地形会真的被光照塑形。
 *
 * ── 管线（buildTerrainMaps）──────────────────────────────────────────
 *   ① 标量噪声   hash3 → 3D value noise → fbm / ridged
 *      ★ 零 RNG：不用主随机流、也不用 drand，坐标哈希决定一切（同不变量 8）。
 *        于是**改贴图算法不会再让星系错位**——它压根不碰那条随机流。
 *        ★ 3D 噪声的好处：直接在球面上采样 → 没有赤道接缝、没有极点撕裂。
 *   ② 高程场     粗网格 fbm + 山脊层 → Catmull-Rom 双三次上采样
 *                → 高频细节层 → 陨击坑（碗形凹 + 环形坑壁）→ 河网（顺坡下切）
 *   ③ 调色       高度分带（每型一张色带）+ 纬度气候带 + 海平面 + 雪线
 *                + 细节抖动 + 潮汐锁定的昼夜热力
 *   ④ 导出       颜色贴图 + 凹凸贴图（同一份高程，二者天然逐像素对齐）
 *
 * ── 参数全部由物理数据算出（延续 v0.6 的「贴图 = 物理的读数」）─────────
 *   陨击坑密度 ← 大气厚度（有大气才有风化与掩埋，真空世界坑满为患）
 *   地形起伏   ← 大气 + 表面重力（低重力才抬得动高山）
 *   海平面     ← 挥发分丰度（直接按高程分布的**分位数**量出来，口径一致）
 *   雪线 / 极冠 ← 表面温度（273 K 冰点，越冷雪线越低）
 *   河流       ← 有液态水 + 有起伏（才有顺坡下切的排水网）
 *
 * ── 两级分辨率：全景档省、聚焦档精 ────────────────────────────────────
 *   全景时行星只有几十像素 → TEX_LO；聚焦时它占满画面 → upgradeTerrain()
 *   现场构建 TEX_HI 并换上去（同星第二次进入直接取缓存）。
 *   先做固态行星（bulk === "rock"）—— 气态仍用 v0.6 的带纹做法。 */

var TEX_LO = 768, TEX_HI = 2048;      /* 贴图宽度×2 = 高度的 equirect 规格 */

/* ───────────────────────── ① 标量噪声（零 RNG） ───────────────────────── */
/* 整数哈希：输入相同永远得到相同的值，抽多少次都不影响世界的随机序列 */
function hash3i(x, y, z, s) {
  var h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 1442695041) ^ (s | 0);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
/* 三线性插值的 3D value noise（在**球面坐标**上取值，故无接缝） */
function vnoise3(x, y, z, s) {
  var xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  var xf = x - xi, yf = y - yi, zf = z - zi;
  var u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  var c000 = hash3i(xi, yi, zi, s), c100 = hash3i(xi + 1, yi, zi, s);
  var c010 = hash3i(xi, yi + 1, zi, s), c110 = hash3i(xi + 1, yi + 1, zi, s);
  var c001 = hash3i(xi, yi, zi + 1, s), c101 = hash3i(xi + 1, yi, zi + 1, s);
  var c011 = hash3i(xi, yi + 1, zi + 1, s), c111 = hash3i(xi + 1, yi + 1, zi + 1, s);
  var x00 = c000 + (c100 - c000) * u, x10 = c010 + (c110 - c010) * u;
  var x01 = c001 + (c101 - c001) * u, x11 = c011 + (c111 - c011) * u;
  var y0 = x00 + (x10 - x00) * v, y1 = x01 + (x11 - x01) * v;
  return y0 + (y1 - y0) * w;
}
/* 分形叠加：每个八度频率翻倍、振幅减半（地形的基本「堆叠」手法） */
function fbm3(x, y, z, s, oct) {
  var a = 0.5, f = 1, sum = 0;
  for (var i = 0; i < oct; i++) {
    sum += a * vnoise3(x * f, y * f, z * f, (s + i * 1013) | 0);
    f *= 2; a *= 0.5;
  }
  return sum;
}
/* 脊化噪声：山脊burstness把噪声的低谷翻折成山脊（|2n−1|），用来长山脉 */
function ridged3(x, y, z, s, oct) {
  var a = 0.5, f = 1, sum = 0;
  for (var i = 0; i < oct; i++) {
    var n = vnoise3(x * f, y * f, z * f, (s + i * 3571) | 0);
    sum += a * (1 - Math.abs(n * 2 - 1));
    f *= 2.1; a *= 0.52;
  }
  return sum;
}

/* ─────────────────── ② 地形画像表（第六张注册表） ─────────────────── */
/* 每种地表「质地」一份画像：噪声怎么用（freq/oct/ridge）+ 要不要海 +
 * 要不要河 + 高度色带。表本身参与 boot 体检（缺字段 / 色带不单调会被抓）。 */
var TERRAIN_PROFILES = [
  { id: "terra", name: "大陆 − 海洋", freq: 2.4, oct: 5, ridge: 0.55, relief: 1.00,
    sea: true, rivers: true, craters: 0.10,
    bands: [[0.00, "#07203a"], [0.30, "#0d3a5e"], [0.44, "#155880"], [0.50, "#2a7a94"],
      [0.515, "#8fa377"], [0.56, "#4e7a41"], [0.68, "#5e8145"], [0.80, "#7a7358"],
      [0.90, "#9d9789"], [1.00, "#eeeef0"]] },

  { id: "ocean", name: "全球海洋", freq: 2.1, oct: 5, ridge: 0.40, relief: 0.80,
    sea: true, rivers: false, craters: 0.06,
    bands: [[0.00, "#04203c"], [0.35, "#0b4a76"], [0.60, "#1a78a8"], [0.72, "#2f95c0"],
      [0.78, "#b7b48c"], [0.86, "#6f9478"], [1.00, "#e6eef4"]] },

  { id: "desert", name: "沙丘 − 台地", freq: 2.8, oct: 4, ridge: 0.30, relief: 0.85,
    sea: false, rivers: true, craters: 0.28,
    bands: [[0.00, "#5e3f1e"], [0.28, "#7f5c2a"], [0.48, "#a2793c"], [0.64, "#c19455"],
      [0.78, "#a07d4c"], [0.90, "#7f6647"], [1.00, "#d3bb8f"]] },

  { id: "ice", name: "冰壳 − 裂隙", freq: 2.6, oct: 4, ridge: 0.45, relief: 0.75,
    sea: false, rivers: false, craters: 0.22,
    bands: [[0.00, "#43606f"], [0.30, "#67869a"], [0.52, "#8fadc2"], [0.70, "#b8cedb"],
      [0.86, "#d8e6ef"], [1.00, "#ffffff"]] },

  { id: "cryo", name: "氮冰原", freq: 2.2, oct: 4, ridge: 0.25, relief: 0.55,
    sea: false, rivers: false, craters: 0.30,
    bands: [[0.00, "#61708c"], [0.30, "#8390ab"], [0.55, "#a5b1c6"], [0.76, "#c5cedf"],
      [1.00, "#f4f6fb"]] },

  { id: "rock", name: "裸岩 − 风化层", freq: 3.2, oct: 5, ridge: 0.40, relief: 1.10,
    sea: false, rivers: false, craters: 0.80,
    bands: [[0.00, "#25211d"], [0.32, "#3e3933"], [0.52, "#57514a"], [0.70, "#736c64"],
      [0.85, "#8d877e"], [1.00, "#b0aaa0"]] },

  { id: "metal", name: "金属壳", freq: 3.0, oct: 5, ridge: 0.30, relief: 0.70,
    sea: false, rivers: false, craters: 0.85,
    bands: [[0.00, "#332e2b"], [0.32, "#4d4741"], [0.55, "#6b635c"], [0.75, "#8a8179"],
      [1.00, "#b3aba2"]] },

  { id: "lava", name: "熔岩壳", freq: 3.0, oct: 5, ridge: 0.55, relief: 0.95,
    sea: false, rivers: false, craters: 0.05, lava: true,
    bands: [[0.00, "#120a08"], [0.28, "#281510"], [0.52, "#452318"], [0.68, "#6e3419"],
      [0.80, "#b85420"], [0.91, "#f08a2a"], [1.00, "#ffcf82"]] },

  { id: "venus", name: "玄武岩 − 硫酸云", freq: 2.3, oct: 4, ridge: 0.35, relief: 0.60,
    sea: false, rivers: false, craters: 0.12,
    bands: [[0.00, "#6e5024"], [0.32, "#8f7138"], [0.55, "#ad9150"], [0.72, "#c9ad68"],
      [0.88, "#dcc489"], [1.00, "#eee0b6"]] }
];

var TerrainProfiles = makeRegistry("地形画像", {
  required: ["id", "name", "freq", "oct", "ridge", "relief", "craters", "bands"],
  checks: [
    function (list) {
      var bad = [];
      list.forEach(function (t) {
        if (!(t.freq > 0.5 && t.freq <= 8)) bad.push("「" + t.id + "」噪声频率出界：" + t.freq);
        if (t.oct < 2 || t.oct > 6) bad.push("「" + t.id + "」八度数出界：" + t.oct);
        if (t.ridge < 0 || t.ridge > 1) bad.push("「" + t.id + "」山脊权重出界：" + t.ridge);
        var b = t.bands || [];
        if (b.length < 4) { bad.push("「" + t.id + "」色带少于 4 段"); return; }
        if (b[0][0] !== 0) bad.push("「" + t.id + "」色带未从高度 0 起步");
        if (b[b.length - 1][0] !== 1) bad.push("「" + t.id + "」色带未终止于高度 1");
        for (var i = 0; i < b.length; i++) {
          if (!/^#[0-9a-f]{6}$/i.test(b[i][1])) bad.push("「" + t.id + "」第 " + (i + 1) + " 段颜色不是 #rrggbb");
          if (i && !(b[i][0] > b[i - 1][0])) bad.push("「" + t.id + "」色带高度不是严格升序（第 " + (i + 1) + " 段）");
        }
      });
      return bad;
    }
  ]
}).addAll(TERRAIN_PROFILES);

/* 色带 → 可直接插值的 RGB 三元组 */
function mkRamp(prof) {
  return prof.bands.map(function (b) {
    var n = parseInt(b[1].slice(1), 16);
    return { h: b[0], r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  });
}
function rampAt(ramp, h) {
  var i = 1;
  while (i < ramp.length - 1 && h > ramp[i].h) i++;
  var a = ramp[i - 1], b = ramp[i];
  var t = Math.max(0, Math.min(1, (h - a.h) / Math.max(1e-6, b.h - a.h)));
  return [a.r + (b.r - a.r) * t, a.g + (b.g - a.g) * t, a.b + (b.b - a.b) * t];
}

/* ─────────────────── ③ 物理 → 地形参数（纯算术，零 RNG） ─────────────────── */
function isSolidPlanet(p) { return p.bulk === "rock"; }

function terrainParams(p) {
  var prof = TerrainProfiles.get(p.type.tex) || TerrainProfiles.get("rock");
  var T = p.tempSurf;

  /* 起伏：大气与水把地形磨平（风蚀 / 沉积），表面重力把高山压回去。
   * 同样的坑，在无大气的小天体上留得住、在地球这样的世界里早被抹平。 */
  var erode = clamp(p.atmo * 0.42, 0, 0.5) + (prof.sea ? 0.10 : 0);
  var relief = clamp(prof.relief * (1 - erode) * (0.85 + 0.30 * clamp(1 / Math.max(0.3, p.rE), 0.6, 1.8)), 0.25, 1.5);

  /* 陨击坑：大气挡得住小天体、也让老坑被掩埋 —— 真空世界坑满为患 */
  var craters = Math.round(prof.craters * (1 - p.atmo * 0.75) * (14 + 26 * (1 - clamp(p.atmo, 0, 1))));

  /* 雪线与极冠：水冰在 273 K 以下稳定 —— 越冷，雪线越低、极冠越大。
   * 冻原以下（< 232 K）连赤道都可能常年封冰。 */
  var cold = clamp((273 - T) / 150, 0, 1);
  var snowH = clamp(0.95 - cold * 0.75, 0.12, 0.98);       /* 雪线高度（归一化海拔） */
  var capFrac = clamp(cold * 0.42 + (T < 100 ? 0.25 : 0), 0, 0.72);  /* 极冠覆盖的纬度比例 */
  if (prof.lava) { snowH = 1.02; capFrac = 0; }            /* 熔岩世界没有冰 */

  return {
    prof: prof, seed: p.seed | 0, relief: relief, craters: craters,
    sea: prof.sea, rivers: prof.rivers && !prof.lava,
    snowH: snowH, capFrac: capFrac, cold: cold, tempSurf: T, lava: !!prof.lava
  };
}

/* ─────────────────── ④ 高程场 ─────────────────── */
/* 粗网格 + 上行抽样：fbm 很贵（每个像素几十次哈希），所以先在粗网格上算，
 * 再用 Catmull-Rom 双三次插值到目标分辨率，最后补两层高频细节恢复锐度。
 * 横向（经度）**环绕取样**、纵向（纬度）**夹边** —— 贴合球的拓扑。 */
function upscaleTerrain(src, GW, GH, W, H) {
  var out = new Float32Array(W * H);
  var wy = new Float32Array(4);
  for (var y = 0; y < H; y++) {
    var sy = ((y + 0.5) / H) * GH - 0.5;
    var j1 = Math.floor(sy), ty = sy - j1;
    var t2 = ty * ty, t3 = t2 * ty;
    wy[0] = -0.5 * t3 + t2 - 0.5 * ty;
    wy[1] = 1.5 * t3 - 2.5 * t2 + 1;
    wy[2] = -1.5 * t3 + 2 * t2 + 0.5 * ty;
    wy[3] = 0.5 * t3 - 0.5 * t2;
    var rows = [
      Math.max(0, Math.min(GH - 1, j1 - 1)),
      Math.max(0, Math.min(GH - 1, j1)),
      Math.max(0, Math.min(GH - 1, j1 + 1)),
      Math.max(0, Math.min(GH - 1, j1 + 2))
    ];
    for (var x = 0; x < W; x++) {
      var sx = ((x + 0.5) / W) * GW - 0.5;
      var i1 = Math.floor(sx), tx = sx - i1;
      var s2 = tx * tx, s3 = s2 * tx;
      var wx0 = -0.5 * s3 + s2 - 0.5 * tx, wx1 = 1.5 * s3 - 2.5 * s2 + 1;
      var wx2 = -1.5 * s3 + 2 * s2 + 0.5 * tx, wx3 = 0.5 * s3 - 0.5 * s2;
      var v = 0;
      for (var m = 0; m < 4; m++) {
        var base = rows[m] * GW;
        var im1 = ((i1 - 1) % GW + GW) % GW, i0 = ((i1) % GW + GW) % GW;
        var ip1 = ((i1 + 1) % GW + GW) % GW, ip2 = ((i1 + 2) % GW + GW) % GW;
        var horiz = src[base + im1] * wx0 + src[base + i0] * wx1 + src[base + ip1] * wx2 + src[base + ip2] * wx3;
        v += wy[m] * horiz;
      }
      out[y * W + x] = v;
    }
  }
  return out;
}

/* 陨击坑的位置与大小：幂律分布（大坑稀少、小坑密集），种子来自地形流 */
function genCraters(pr) {
  var rnd = mulberry32((pr.seed ^ 0x51ed270b) | 0);
  var out = [];
  for (var i = 0; i < pr.craters; i++) {
    var lat = Math.asin(rnd() * 2 - 1);                  /* 按面积均匀，不在极点堆积 */
    var lon = rnd() * Math.PI * 2;
    var R = 0.012 * Math.pow(90, rnd());                 /* 0.012 ~ 0.09 弧度 */
    out.push({
      lat: lat, lon: lon, R: R,
      nx: Math.cos(lon) * Math.cos(lat), ny: Math.sin(lat), nz: Math.sin(lon) * Math.cos(lat),
      depth: 0.10 + 0.28 * Math.sqrt(R), rim: 0.04 + 0.14 * Math.sqrt(R)
    });
  }
  return out;
}
/* 把坑压进高程场：坑底碗形下沉 + 环形坑壁抬升（后者才是「看得出是坑」的关键） */
function carveCraters(field, W, H, pr) {
  var cs = genCraters(pr);
  for (var k = 0; k < cs.length; k++) {
    var c = cs[k], R = c.R * 1.35;
    var j0 = Math.max(0, Math.floor(((c.lat - R) + Math.PI / 2) / Math.PI * (H - 1)));
    var j1 = Math.min(H - 1, Math.ceil(((c.lat + R) + Math.PI / 2) / Math.PI * (H - 1)));
    for (var j = j0; j <= j1; j++) {
      var lat = (j / (H - 1)) * Math.PI - Math.PI / 2;
      var cl = Math.cos(lat), sl = Math.sin(lat);
      /* 该纬度上经度方向的半宽：靠近极点要按 cos(lat) 放大，否则覆盖不足 */
      var half = R / Math.max(0.12, Math.cos(lat));
      if (half > Math.PI) half = Math.PI;
      var i0 = Math.floor((c.lon - half) / (Math.PI * 2) * W);
      var span = Math.ceil(half * 2 / (Math.PI * 2) * W);
      for (var n = 0; n <= span; n++) {
        var i = ((i0 + n) % W + W) % W;
        var lon = (i / W) * Math.PI * 2;
        var px = Math.cos(lon) * cl - c.nx, py = sl - c.ny, pz = Math.sin(lon) * cl - c.nz;
        /* 弦长代替角距（省一次 acos，形状足够） */
        var d = Math.sqrt(px * px + py * py + pz * pz) / (2 * c.R);
        if (d >= 1.35) continue;
        var idx = j * W + i;
        if (d < 1) {
          field[idx] -= c.depth * pr.relief * (1 - d * d) * 0.85;
        }
        var rimT = (d - 1.0) / 0.17;
        if (rimT > -3 && rimT < 3) field[idx] += c.rim * pr.relief * Math.exp(-rimT * rimT) * 0.55;
      }
    }
  }
}
/* 河网：从高处顺最陡下降走 n 步，沿途下切。水往低处走 —— 这是「排水网络」
 * 最朴素的写法，但足以让高原上出现树枝状的沟谷（旱星就是干河床）。 */
function carveRivers(field, W, h, pr, wet) {
  var rnd = mulberry32((pr.seed ^ 0x1b873593) | 0);
  var n = wet ? 26 : 14;
  for (var t = 0; t < n; t++) {
    var i = Math.floor(rnd() * W), j = Math.floor(rnd() * h);
    var steps = 90 + Math.floor(rnd() * 90);
    for (var s = 0; s < steps; s++) {
      var idx = j * W + i;
      field[idx] -= (wet ? 0.02 : 0.015) * pr.relief;
      /* 找 8 邻域里最低的点 */
      var bi = i, bj = j, bv = field[idx];
      for (var dy = -1; dy <= 1; dy++) {
        var jj = j + dy;
        if (jj < 0 || jj >= h) continue;
        for (var dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          var ii = ((i + dx) % W + W) % W;
          var v = field[jj * W + ii];
          if (v < bv) { bv = v; bi = ii; bj = jj; }
        }
      }
      if (bi === i && bj === j) break;             /* 走到盆地底部，河到头了 */
      i = bi; j = bj;
    }
  }
}

/* 完整高程场（归一化到 0–1），W×H 是最终贴图分辨率。
 * ★ 分层顺序是刻意的：**先归一化基底，再以「最终高程」为单位叠加特征** ——
 *   若把坑 / 河 / 细节掺进归一化之前，它们的深度会被 min/max 拉伸稀释到
 *   百分之几，聚焦时就只剩一团糊（v0.11 首版踩过这个坑）。 */
function buildHeightField(pr, p, W, H) {
  var GW = Math.max(24, Math.round(W / 8)), GH = Math.max(12, Math.round(H / 8));
  /* ① 粗网格：大陆基底 + 山脊层 */
  var coarse = new Float32Array(GW * GH);
  var pr0 = pr.prof, sd = pr.seed;
  for (var j = 0; j < GH; j++) {
    var lat0 = (j / (GH - 1)) * Math.PI - Math.PI / 2;
    var clat = Math.cos(lat0), slat = Math.sin(lat0);
    for (var i = 0; i < GW; i++) {
      var lon0 = (i / GW) * Math.PI * 2;
      var sx = Math.cos(lon0) * clat * pr0.freq, sy = slat * pr0.freq, sz = Math.sin(lon0) * clat * pr0.freq;
      coarse[j * GW + i] = fbm3(sx, sy, sz, sd, pr0.oct) + pr0.ridge * ridged3(sx * 1.7, sy * 1.7, sz * 1.7, sd, pr0.oct - 1);
    }
  }
  /* ② 上采样 → 归一化：基底地形就位（0 = 最低洼，1 = 最高峰） */
  var field = upscaleTerrain(coarse, GW, GH, W, H);
  var mn = Infinity, mx = -Infinity, k;
  for (k = 0; k < field.length; k++) { if (field[k] < mn) mn = field[k]; if (field[k] > mx) mx = field[k]; }
  var inv = 1 / Math.max(1e-6, mx - mn);
  for (k = 0; k < field.length; k++) field[k] = (field[k] - mn) * inv;

  /* ③ 特征叠加（全部以最终高程为单位；relief 决定「山有多高、坑有多深」） */
  carveCraters(field, W, H, pr);
  if (pr.rivers) carveRivers(field, W, H, pr, pr.sea);
  for (var y = 0; y < H; y++) {
    var lat = (y / (H - 1)) * Math.PI - Math.PI / 2;
    var cl = Math.cos(lat) * 9.5, sl = Math.sin(lat) * 9.5;
    for (var x = 0; x < W; x++) {
      var lon = (x / W) * Math.PI * 2;
      var px = Math.cos(lon) * cl, py = sl, pz = Math.sin(lon) * cl;
      /* 三个频段：地貌轮廓（山群）+ 岩层起伏 + 地表颗粒。
       * 频段必须一路铺到「贴图上十来个像素一个周期」，否则贴近后只剩雾。 */
      field[y * W + x] += pr.relief * (
        0.100 * (fbm3(px, py, pz, (sd ^ 0x2f1a77), 3) - 0.5) +
        0.055 * (fbm3(px * 4, py * 4, pz * 4, (sd ^ 0x7f3a1d), 2) - 0.5) +
        0.030 * (vnoise3(px * 12.6, py * 12.6, pz * 12.6, (sd ^ 0x11e6de)) - 0.5)
      );
    }
  }
  /* ④ 有海的世界：按分位数量出海平面并**重标定到 0.5** ——
   * 「水多水少」永远只体现为同一件事：水面线落在哪里。 */
  if (pr.sea) {
    var seaLvl = quantile(field, clamp(p.water * 1.15, 0.05, 0.95));
    var lo = Infinity, hi2 = -Infinity;
    for (k = 0; k < field.length; k++) { if (field[k] < lo) lo = field[k]; if (field[k] > hi2) hi2 = field[k]; }
    var sinv = 1.15 / Math.max(1e-6, hi2 - lo);
    for (k = 0; k < field.length; k++) field[k] = 0.5 + (field[k] - seaLvl) * sinv;
  }
  return field;
}
/* 分位数：拿直方图画累加，找到「覆盖到 c 比例」的那个高度。
 * 为什么走分位数：噪声的形状和 `water` 没有任何先验关系，硬写死阈值会让
 * 让「水变多」这件事失效；走直方图则**保证**水面覆盖恰好等于挥发分丰度。 */
function quantile(field, c) {
  var BINS = 512, hist = new Int32Array(BINS), mn = Infinity, mx = -Infinity, i;
  for (i = 0; i < field.length; i++) { if (field[i] < mn) mn = field[i]; if (field[i] > mx) mx = field[i]; }
  var inv = BINS / Math.max(1e-6, mx - mn);
  for (i = 0; i < field.length; i++) {
    var b = Math.floor((field[i] - mn) * inv);
    if (b >= BINS) b = BINS - 1;
    hist[b]++;
  }
  var want = c * field.length, acc = 0;
  for (i = 0; i < BINS; i++) {
    acc += hist[i];
    if (acc >= want) return mn + (i + 0.5) / inv;
  }
  return mx;
}

/* ─────────────────── ⑤ 构建地表（颜色 + 凹凸 + 自发光） ─────────────────── */
function buildTerrainMaps(p, W) {
  var H = W >> 1;
  return withSeed(p.seed, function () {
    var pr = terrainParams(p);
    var ramp = mkRamp(pr.prof);
    var field = buildHeightField(pr, p, W, H);

    var cCol = document.createElement("canvas"); cCol.width = W; cCol.height = H;
    var g = cCol.getContext("2d");
    var img = g.createImageData(W, H), d = img.data;
    var cBump = document.createElement("canvas"); cBump.width = W; cBump.height = H;
    var gB = cBump.getContext("2d");
    var imgB = gB.createImageData(W, H), dB = imgB.data;
    var cEm = pr.lava ? document.createElement("canvas") : null;
    var gE = null, imgE = null, dE = null;
    if (cEm) { cEm.width = W; cEm.height = H; gE = cEm.getContext("2d"); imgE = gE.createImageData(W, H); dE = imgE.data; }

    var seaA = pr.sea ? 0.5001 : -1;                 /* 归一化后的海平面（见 buildHeightField） */
    var grainS = p.seed & 0xffff;

    for (var j = 0; j < H; j++) {
      var latAbs = Math.abs((j / (H - 1)) * 2 - 1);            /* 0 = 赤道，1 = 极点 */
      /* 极冠：纬度越靠近极点越白；冷星（capFrac 大）从更低的纬度就开始封冰 */
      var white = pr.capFrac > 0 ? clamp((latAbs - (1 - pr.capFrac)) / Math.max(0.06, pr.capFrac * 0.55), 0, 1) : 0;
      /* 山体阴影（hillshade）：高程梯度的固定西北光。为什么它必不可少 ——
       * 潮汐锁定的行星永远正面朝光，真实光照下凹凸贴图几乎不出影子；
       * 把「立体感」直接烘进颜色，贴到哪颗星、什么角度都看得见地形。 */
      var jm = Math.max(0, j - 1), jp = Math.min(H - 1, j + 1);
      for (var i = 0; i < W; i++) {
        var idx = j * W + i;
        var hgt = clamp(field[idx], 0, 1);
        var gx = field[j * W + ((i + 1) % W)] - field[j * W + ((i - 1 + W) % W)];
        var gy = field[jp * W + i] - field[jm * W + i];
        var shade = clamp(1.16 - (gx + gy) * 14 * pr.relief, 0.62, 1.42);
        /* 高度走一遍 S 曲线再取色：把「高度差」放大成「色差」——
         * 色带本身相邻两档差距温和，直接取色会让地形糊成一片（v0.11 教训） */
        var rgb = rampAt(ramp, clamp(0.5 + (hgt - 0.5) * 1.55, 0, 1));

        /* 细节抖动：一点点颗粒感（±7%），避免大片同色看着像塑料 */
        var gr = (hash3i(i, j, grainS, 7717) - 0.5) * 0.14;
        var r = rgb[0] * shade * (1 + gr), gg = rgb[1] * shade * (1 + gr), bb = rgb[2] * shade * (1 + gr);

        /* 雪线：高于雪线的高处积雪；海平面以下不受影响 */
        if (pr.snowH < 1 && hgt > pr.snowH) {
          var t = clamp((hgt - pr.snowH) / Math.max(0.06, 1 - pr.snowH), 0, 1);
          r += (245 - r) * t * 0.9; gg += (248 - gg) * t * 0.9; bb += (252 - bb) * t * 0.9;
        }
        /* 极冠 / 高纬封冰 */
        if (white > 0) {
          var w2 = white * white;
          r += (252 - r) * w2; gg += (253 - gg) * w2; bb += (255 - bb) * w2;
        }
        /* 水下：越深越暗、越偏蓝 —— 水体自身的吸收与遮蔽 */
        if (seaA > 0 && hgt < seaA) {
          var dep = clamp((seaA - hgt) / 0.30, 0, 1);
          r *= 1 - 0.35 * dep; gg *= 1 - 0.22 * dep; bb *= 1 - 0.05 * dep;
        }

        var o = idx * 4;
        d[o] = r; d[o + 1] = gg; d[o + 2] = bb; d[o + 3] = 255;

        /* 凹凸 = 同一份高程（×由args起伏调整的强度）——山脊与坑都会被光照塑形 */
        var bv = Math.round(255 * clamp(hgt, 0, 1));
        dB[o] = dB[o + 1] = dB[o + 2] = bv; dB[o + 3] = 255;

        /* 熔岩自发光：只在最高处透出来（裂缝），比整页发亮克制得多 */
        if (dE) {
          var lit = clamp((hgt - 0.80) / 0.20, 0, 1);
          var e = Math.round(255 * lit * lit);
          dE[o] = e; dE[o + 1] = Math.round(e * 0.62); dE[o + 2] = Math.round(e * 0.26); dE[o + 3] = 255;
        }
      }
    }
    g.putImageData(img, 0, 0);
    gB.putImageData(imgB, 0, 0);

    /* 潮汐锁定：永昼面 / 永夜面的热反差（沿用 v0.6 的做法） */
    if (p.tidal) {
      var T = pr.tempSurf;
      var hotCore = T > 500 ? "rgba(255,150,60,0.62)" : (T > 273 ? "rgba(255,195,130,0.40)" : "rgba(205,222,255,0.24)");
      var hotMid = T > 500 ? "rgba(255,110,40,0.26)" : (T > 273 ? "rgba(255,160,90,0.17)" : "rgba(190,210,240,0.11)");
      dayNightGrad(g, W, H, "rgba(4,8,18,0.50)", hotCore, hotMid);   /* 压暗克制些：地形本身要看得见 */
    }
    if (gE) gE.putImageData(imgE, 0, 0);

    var texMap = new THREE.CanvasTexture(cCol);
    var texBump = new THREE.CanvasTexture(cBump);
    texMap.anisotropy = 4; texBump.anisotropy = 4;
    var out = { map: texMap, bumpMap: texBump, height: field, params: pr };
    if (cEm) out.emissiveMap = new THREE.CanvasTexture(cEm);
    return out;
  });
}

/* 两级分辨率：聚焦时现场构建高清图层（结果缓存在行星上，第二次进入零延迟） */
function upgradeTerrain(p) {
  if (!p) return null;
  if (!p._terrainHi) p._terrainHi = buildTerrainMaps(p, TEX_HI);
  return p._terrainHi;
}
/* 把高清图层换到网格的材质上（聚焦时由 enterFocus 调用）。
 * ★ 低清贴图留在那里：退出聚焦不必重建，第二次进入也不必重建 —— 只是 GPU 上多一张。 */
function refineSurface(p) {
  if (!p || !p._mesh || p._surfHi) return false;
  var hi = upgradeTerrain(p);
  if (!hi) return false;
  var m = p._mesh.material;
  m.map = hi.map;
  if (hi.bumpMap) { m.bumpMap = hi.bumpMap; m.bumpScale = 0.19 * clamp(hi.params.relief, 0.35, 1.4); }
  if (hi.emissiveMap) m.emissiveMap = hi.emissiveMap;
  m.needsUpdate = true;
  p._surfHi = true;
  return true;
}

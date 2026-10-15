/* ================= 程序化贴图（全部画布绘制，零外部资源） ================= */
var glowTex = null, ringTex = null;
var starTex = null, cloudT = null, ringBandT = null, nebT = null;
var ghostT = null;                    /* 镜头鬼影贴图 */
var bracketT = null, selRingT = null, photonT = null;   /* 选中括号 / 细环 / 黑洞光子环 */

function mkTex(w, h, draw) {
  var c = document.createElement("canvas");
  c.width = w; c.height = h;
  var g = c.getContext("2d");
  draw(g, w, h);
  var t = new THREE.CanvasTexture(c);
  t.anisotropy = 2;
  return t;
}
/* 跨接缝的圆形笔触（球面横向环绕） */
function wrapCircle(g, w, x, y, r) {
  [[0], [-w], [w]].forEach(function (o) {
    g.beginPath(); g.arc(x + o[0], y, r, 0, Math.PI * 2); g.fill();
  });
}
/* ---- 画布笔触（全部走「绘制随机流」：默认主序列，行星贴图内为专属流） ---- */
function blobs(g, w, h, n, colors, rMin, rMax, aMin, aMax) {
  for (var i = 0; i < n; i++) {
    g.globalAlpha = drand(aMin, aMax);
    g.fillStyle = dpick(colors);
    wrapCircle(g, w, drand(0, w), drand(0, h), drand(rMin, rMax));
  }
  g.globalAlpha = 1;
}
/* 极冠：纬度方向的白（冰）渐变。frac 由表面温度算出（见 paintPlanetMaps） */
function poleCaps(g, w, h, frac, aTop, aBot) {
  if (frac <= 0.002) return;
  var s = h * frac;
  var g1 = g.createLinearGradient(0, 0, 0, s);
  g1.addColorStop(0, "rgba(255,255,255," + aTop + ")");
  g1.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = g1; g.fillRect(0, 0, w, s);
  var g2 = g.createLinearGradient(0, h, 0, h - s);
  g2.addColorStop(0, "rgba(255,255,255," + aBot + ")");
  g2.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = g2; g.fillRect(0, h - s, w, s);
}
/* 撞击坑（环形）：小亮环 + 暗心。数量由大气厚度算出——无大气才留得住 */
function craters(g, w, h, n, ring, dark) {
  for (var i = 0; i < n; i++) {
    var cx = drand(0, w), cy = drand(h * 0.1, h * 0.9), rr = drand(w * 0.006, w * 0.026);
    [[0], [-w], [w]].forEach(function (o) {
      g.globalAlpha = drand(0.16, 0.34);
      g.fillStyle = dark;
      g.beginPath(); g.arc(cx + o[0], cy, rr, 0, Math.PI * 2); g.fill();
      g.globalAlpha = drand(0.2, 0.45);
      g.strokeStyle = ring; g.lineWidth = 1.4;
      g.beginPath(); g.arc(cx + o[0], cy, rr, 0, Math.PI * 2); g.stroke();
    });
  }
  g.globalAlpha = 1;
}
function cracks(g, w, h, n, color, lw, alpha, glow, mag) {
  var m = mag || 1;
  g.strokeStyle = color; g.lineWidth = lw; g.globalAlpha = alpha;
  if (glow) { g.shadowColor = color; g.shadowBlur = glow; }
  for (var i = 0; i < n; i++) {
    var x = drand(0, w), y = drand(0, h);
    g.beginPath(); g.moveTo(x, y);
    var seg = 4 + (drng() * 5 | 0);
    for (var k = 0; k < seg; k++) {
      x += drand(-16, 16) * m; y += drand(-8, 8) * m;
      g.lineTo(x, y);
    }
    g.stroke();
  }
  g.shadowBlur = 0; g.globalAlpha = 1;
}
/* 纬向带纹（气态行星）。minH/maxH 由自转速度算出——转得越快，带纹越细越密 */
function bands(g, w, h, palette, minH, maxH, alpha) {
  var y = 0;
  while (y < h) {
    var bh = drand(minH, maxH);
    g.globalAlpha = alpha;
    g.fillStyle = dpick(palette);
    g.fillRect(0, y, w, bh + 1);
    y += bh;
  }
  // 涡旋
  for (var i = 0; i < 10; i++) {
    g.globalAlpha = drand(0.06, 0.16);
    g.fillStyle = dpick(palette);
    g.beginPath();
    g.ellipse(drand(0, w), drand(0, h), drand(10, 34), drand(2.5, 6), drand(-0.15, 0.15), 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 1;
}
/* 昼夜热力分布（潮汐锁定行星专用）：日下点在纹理 u = 0.25 处（恒朝恒星），
 * 向永夜面平滑衰减。三段跨接缝绘制，横向环绕不露接缝。 */
function dayNightGrad(g, w, h, coldTint, hotCore, hotMid) {
  g.globalAlpha = 1;
  g.fillStyle = coldTint;                       /* 先铺永夜面冷色 */
  g.fillRect(0, 0, w, h);
  var cx = w * 0.25, r = w * 0.52;
  [[0], [-w], [w]].forEach(function (o) {
    var rg = g.createRadialGradient(cx + o[0], h * 0.5, 0, cx + o[0], h * 0.5, r);
    rg.addColorStop(0, hotCore);                /* 日下点：最热 */
    rg.addColorStop(0.45, hotMid);
    rg.addColorStop(1, "rgba(0,0,0,0)");        /* 到永夜面完全淡出 */
    g.fillStyle = rg;
    g.fillRect(0, 0, w, h);
  });
}

/* ================= 行星表面贴图（由物理数据「算出」，不是随机涂色） =================
 * 每一处画法都由 p 上的物理量驱动：
 *   极冠大小   ← 表面温度与冰点（273 K）之差 —— 越冷冠越大
 *   海陆比例   ← 挥发分丰度 water —— 海的面积就是水量的直接读数
 *   撞击坑数量 ← 大气厚度 —— 有大气才有风化与掩埋；真空世界坑满为患
 *   熔岩裂缝   ← 表面温度 —— 越热裂缝越密、越亮
 *   气态带纹   ← 自转速度 —— 转得越快带纹越细（木星 10 小时 vs 金星 243 天）
 *   昼夜反差   ← 是否潮汐锁定 —— 永昼面灼热、永夜面冰封
 * 随机只用于「细节笔触」，且走本行星专属流：改画法不会移动世界骨架（见 绘制随机流）。 */
function paintPlanetMaps(p) {
  return withSeed(p.seed, function () {
    var t = p.type, pal = t.pal, tex = t.tex, T = p.tempSurf;
    var W = 512, H = 256;

    /* ★ 固态行星（v0.11 起）：交给地形生成器 src/42-terrain.js —— 那里算出真实
     * 高程场；本文件这一套「撒色块」的画法只在气态行星上继续用（它没有固体表面）。
     * 判断口径 = bulk（岩质 / 巨行星），不看 tex —— 两者的分工在 42-terrain.js 里。 */
    if (isSolidPlanet(p)) return buildTerrainMaps(p, TEX_LO);


    /* 极冠：水冰在 273 K 以下稳定堆积；热星型没有极冠 */
    var cap = clamp((273 - T) / 150, 0, 1) * 0.28;
    if (T > 320 || tex === "lava" || tex === "venus" || tex === "hotjup") cap = 0;

    /* ---- 气态行星：纬向带纹，带纹宽度由自转速度算出 ---- */
    if (tex === "gas" || tex === "hotjup" || tex === "icegiant") {
      var fine = tex === "icegiant" ? 1.9 : (tex === "hotjup" ? 0.55 : 1);
      var bh = clamp(26 - p.spin * 22, 3, 15) * fine;
      return {
        map: mkTex(W, H, function (g, w, h) {
          g.fillStyle = pal[2]; g.fillRect(0, 0, w, h);
          bands(g, w, h, pal, bh * 0.7, bh * 1.6, tex === "icegiant" ? 0.40 : 0.85);
          if (tex === "hotjup") {                     /* 受热膨胀 → 强对流涡旋 */
            for (var i = 0; i < 6; i++) {
              g.globalAlpha = drand(0.18, 0.38); g.fillStyle = pal[3];
              g.beginPath();
              g.ellipse(drand(0, w), drand(h * 0.2, h * 0.8), drand(16, 46), drand(6, 15), 0, 0, Math.PI * 2);
              g.fill();
            }
            g.globalAlpha = 1;
          }
        })
      };
    }

    /* ---- 熔岩行星：裂缝密度与自发光强度由表面温度算出 ---- */
    if (tex === "lava") {
      var nHot = Math.round(clamp((T - 900) / 130, 4, 26));
      return {
        map: mkTex(W, H, function (g, w, h) {
          g.fillStyle = pal[0]; g.fillRect(0, 0, w, h);
          blobs(g, w, h, 40, [pal[1]], w * 0.015, w * 0.06, 0.5, 0.9);
          cracks(g, w, h, nHot, pal[2], 2.4, 0.55, 6, 2);
          cracks(g, w, h, Math.round(nHot * 0.5), pal[3], 1.8, 0.5, 8, 2);
        }),
        emissiveMap: mkTex(W, H, function (g, w, h) {
          g.fillStyle = "#000000"; g.fillRect(0, 0, w, h);
          cracks(g, w, h, nHot, pal[2], 2.8, 0.9, 6, 2);
          cracks(g, w, h, Math.round(nHot * 0.5), pal[3], 2.2, 0.95, 9, 2);
        })
      };
    }

    /* ---- 岩质 / 冰质：底色 + 地形 + 极冠（+ 潮汐锁定的昼夜反差） ---- */
    var map = mkTex(W, H, function (g, w, h) {
      if (tex === "terra" || tex === "ocean") {
        /* 海陆比例 = 挥发分丰度的直接读数：水越多，海越大、陆地越碎 */
        var cover = clamp(p.water * 1.15, 0.15, 0.96);
        var land = Math.round(74 * (1 - cover));
        g.fillStyle = pal[0]; g.fillRect(0, 0, w, h);
        blobs(g, w, h, land, [pal[1], pal[2], pal[3]], w * 0.018, w * 0.065, 0.7, 0.95);
        if (cover < 0.78) {
          blobs(g, w, h, Math.round(land * 0.6), ["#b09858", "#9a8a4a"],
            w * 0.012, w * 0.035, 0.3, 0.55);         /* 干旱带 */
        }
        poleCaps(g, w, h, cap, 0.6, 0.55);
      } else if (tex === "desert") {
        g.fillStyle = pal[1]; g.fillRect(0, 0, w, h);
        blobs(g, w, h, 50, [pal[0], pal[2], pal[3]], w * 0.015, w * 0.07, 0.3, 0.65);
        cracks(g, w, h, 12, pal[0], 1.6, 0.32, 0, 2);   /* 干涸河床 */
        poleCaps(g, w, h, cap, 0.3, 0.3);
      } else if (tex === "venus") {
        g.fillStyle = pal[1]; g.fillRect(0, 0, w, h);
        blobs(g, w, h, 44, [pal[0], pal[2], pal[3]], w * 0.02, w * 0.09, 0.18, 0.42);
        for (var i = 0; i < 30; i++) {                /* 硫酸云：横向拉长的涡 */
          g.globalAlpha = drand(0.07, 0.18); g.fillStyle = pal[3];
          g.beginPath();
          g.ellipse(drand(0, w), drand(0, h), drand(24, 70), drand(4, 13), 0, 0, Math.PI * 2);
          g.fill();
        }
        g.globalAlpha = 1;
      } else if (tex === "ice" || tex === "cryo") {
        g.fillStyle = pal[2]; g.fillRect(0, 0, w, h);
        blobs(g, w, h, 36, [pal[0], pal[1], pal[3]], w * 0.015, w * 0.08, 0.3, 0.6);
        cracks(g, w, h, 20, pal[0], 1.5, 0.4, 0, 2);    /* 冰壳裂隙 */
        poleCaps(g, w, h, Math.min(0.34, cap + 0.12), 0.65, 0.65);
      } else {
        /* 裸岩 / 铁 / 碳 / 炽岩 / 荒芜 / 矮行星 */
        g.fillStyle = pal[1]; g.fillRect(0, 0, w, h);
        blobs(g, w, h, 44, [pal[0], pal[2], pal[3]], w * 0.012, w * 0.06, 0.3, 0.7);
        craters(g, w, h, Math.round(6 + 26 * (1 - p.atmo)), pal[3], pal[0]);
        poleCaps(g, w, h, cap, 0.34, 0.34);
      }
      /* 潮汐锁定：永昼面 / 永夜面的热反差（配色由表面温度给） */
      if (p.tidal) {
        var hotCore = T > 500 ? "rgba(255,150,60,0.62)" : (T > 273 ? "rgba(255,195,130,0.40)" : "rgba(205,222,255,0.24)");
        var hotMid = T > 500 ? "rgba(255,110,40,0.26)" : (T > 273 ? "rgba(255,160,90,0.17)" : "rgba(190,210,240,0.11)");
        dayNightGrad(g, w, h, "rgba(4,8,18,0.62)", hotCore, hotMid);
      }
    });
    return { map: map };
  });
}
/* 云层（类地/海洋） */
function cloudTex() {
  return mkTex(256, 128, function (g, w, h) {
    g.clearRect(0, 0, w, h);
    for (var i = 0; i < 46; i++) {
      g.globalAlpha = rand(0.05, 0.16);
      g.fillStyle = "#ffffff";
      wrapCircle(g, w, rand(0, w), rand(0, h), rand(5, 15));
    }
    g.globalAlpha = 1;
  });
}

/* 星云背景贴图（柔和团絮） */
function nebulaTex() {
  return mkTex(256, 256, function (g, w, h) {
    g.clearRect(0, 0, w, h);
    for (var i = 0; i < 9; i++) {
      var x = rand(60, w - 60), y = rand(60, h - 60), r = rand(40, 100);
      var gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, "rgba(255,255,255," + rand(0.05, 0.12).toFixed(2) + ")");
      gr.addColorStop(0.6, "rgba(255,255,255," + rand(0.02, 0.05).toFixed(2) + ")");
      gr.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = gr;
      g.fillRect(0, 0, w, h);
    }
  });
}

/* 环带贴图（同心圆环，供 RingGeometry 平面 UV 使用） */
function ringBandTex() {
  return mkTex(128, 128, function (g, w, h) {
    g.clearRect(0, 0, w, h);
    var cx = w / 2, cy = h / 2;
    for (var r = 20; r < 62; r += rand(2.5, 6)) {
      g.strokeStyle = "#d8c8a8";
      g.globalAlpha = rand(0.15, 0.6);
      g.lineWidth = rand(1.5, 4.5);
      g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();
      if (rng() < 0.25) { // 缝隙
        g.globalAlpha = 0.9;
        g.strokeStyle = "#05070d";
        g.beginPath(); g.arc(cx, cy, r + rand(1, 3), 0, Math.PI * 2); g.stroke();
      }
    }
    g.globalAlpha = 1;
  });
}

/* 彗尾贴图已随彗星移除（v0.5，零随机消耗，删除不影响确定性序列） */

/* 旧版恒星表面贴图 —— 保留函数与调用，纯为维持确定性随机序列；
 * v0.4 起恒星表面改为实时着色器（见 starSurfaceMaterial） */
function starSurfaceTex() {
  return mkTex(256, 128, function (g, w, h) {
    g.fillStyle = "#ffffff"; g.fillRect(0, 0, w, h);
    for (var i = 0; i < 90; i++) {
      g.globalAlpha = rand(0.1, 0.4);
      g.fillStyle = rng() < 0.5 ? "#e8d8a8" : "#fff2c8";
      wrapCircle(g, w, rand(0, w), rand(0, h), rand(6, 22));
    }
    for (var j = 0; j < 40; j++) {
      g.globalAlpha = rand(0.08, 0.25);
      g.fillStyle = "#d8b878";
      wrapCircle(g, w, rand(0, w), rand(0, h), rand(3, 9));
    }
    g.globalAlpha = 1;
  });
}

/* 镜头鬼影：软环状 bokeh 光斑 */
function ghostTex() {
  return mkTex(128, 128, function (g, w, h) {
    var cx = w / 2, cy = h / 2;
    var gr = g.createRadialGradient(cx, cy, 0, cx, cy, 62);
    gr.addColorStop(0, "rgba(255,255,255,0.55)");
    gr.addColorStop(0.5, "rgba(255,255,255,0.12)");
    gr.addColorStop(0.78, "rgba(255,255,255,0.6)");
    gr.addColorStop(0.9, "rgba(255,255,255,0.18)");
    gr.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = gr;
    g.fillRect(0, 0, w, h);
  });
}

/* 选中括号（科幻 HUD 四角 L 形）—— v0.5 新增，绘制零随机消耗 */
function bracketTex() {
  return mkTex(256, 256, function (g, w, h) {
    g.strokeStyle = "#ffffff"; g.lineWidth = 5; g.lineCap = "round";
    var m = 34, L = 52;
    [[m, m, 1, 1], [w - m, m, -1, 1], [m, h - m, 1, -1], [w - m, h - m, -1, -1]].forEach(function (c) {
      g.beginPath();
      g.moveTo(c[0] + c[2] * L, c[1]);
      g.lineTo(c[0], c[1]);
      g.lineTo(c[0], c[1] + c[3] * L);
      g.stroke();
    });
  });
}

/* 选中细环（恒星用）：纤细圆环 + 四枚航迹点，缓慢旋转时像扫描环 */
function selRingTex() {
  return mkTex(256, 256, function (g, w, h) {
    var cx = w / 2, cy = h / 2;
    g.strokeStyle = "#ffffff"; g.lineWidth = 2.5;
    g.beginPath(); g.arc(cx, cy, 108, 0, Math.PI * 2); g.stroke();
    g.fillStyle = "#ffffff";
    for (var i = 0; i < 4; i++) {
      var a = Math.PI / 4 + i * Math.PI / 2;
      g.beginPath(); g.arc(cx + Math.cos(a) * 108, cy + Math.sin(a) * 108, 5, 0, Math.PI * 2); g.fill();
    }
  });
}

/* 黑洞光子环：纤细亮环 + 外圈柔光（吸积物质的「光学签名」） */
function photonTex() {
  return mkTex(256, 256, function (g, w, h) {
    var cx = w / 2, cy = h / 2;
    g.strokeStyle = "#ffffff"; g.lineWidth = 3.5; g.globalAlpha = 0.95;
    g.beginPath(); g.arc(cx, cy, 96, 0, Math.PI * 2); g.stroke();
    g.globalAlpha = 0.22; g.lineWidth = 14;
    g.beginPath(); g.arc(cx, cy, 96, 0, Math.PI * 2); g.stroke();
    g.globalAlpha = 1;
  });
}

/* 大气辉光（菲涅尔 shader，BackSide 外层球） */
/* 大气菲涅尔辉光。strength = 边缘不透明度（由大气厚度算出，0~0.8） */
function atmoMaterial(colorHex, strength) {
  return new THREE.ShaderMaterial({
    uniforms: {
      glowColor: { value: new THREE.Color(colorHex) },
      uRim: { value: strength === undefined ? 0.6 : strength }
    },
    vertexShader: [
      "varying vec3 vNormal;",
      "varying vec3 vView;",
      "void main() {",
      "  vec4 mv = modelViewMatrix * vec4(position, 1.0);",
      "  vNormal = normalize(normalMatrix * normal);",
      "  vView = normalize(-mv.xyz);",
      "  gl_Position = projectionMatrix * mv;",
      "}"
    ].join("\n"),
    fragmentShader: [
      "uniform vec3 glowColor;",
      "uniform float uRim;",
      "varying vec3 vNormal;",
      "varying vec3 vView;",
      "void main() {",
      "  float rim = pow(clamp(0.72 - dot(vNormal, vView), 0.0, 1.0), 2.2);",
      "  gl_FragColor = vec4(glowColor, rim * uRim);",
      "}"
    ].join("\n"),
    transparent: true,
    blending: THREE.AdditiveBlending,
    side: THREE.BackSide,
    depthWrite: false
  });
}

/* 纯 ShaderMaterial 的颜色按 sRGB 原值输出（不受色彩管理转换影响） */
function rawColor(hex) {
  return new THREE.Color(hex).convertLinearToSRGB();
}

/* 恒星表面：动态等离子体（低对比柔和颗粒 + 星斑 + 临边变暗）
 * v0.4.1「回归球体」：临边变暗（limb darkening）取代旧的临边增亮——
 * 边缘略暗、中心泛白热，视觉上才是「一颗球」而非「一张发光圆盘」；
 * 颗粒改为低对比缓慢翻腾，去掉大块硬斑（旧版像贴了蜂窝贴图）。
 * 参数由光谱型驱动：uNoise = 颗粒尺度，uSpot = 星斑强度（0~1） */
function starSurfaceMaterial(colorHex, mat) {
  mat = mat || {};
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: rawColor(colorHex) },
      uHot: { value: rawColor(colorHex).lerp(new THREE.Color(1, 1, 1), 0.72) },
      uDark: { value: rawColor(colorHex).multiplyScalar(0.38) },
      uNoise: { value: mat.noise || 2.8 },
      uSpot: { value: mat.spot != null ? mat.spot : 0.5 }
    },
    vertexShader: [
      "varying vec2 vUv;",
      "varying vec3 vN;",
      "varying vec3 vP;",
      "void main() {",
      "  vUv = uv;",
      "  vN = normalize(mat3(modelMatrix) * normal);",
      "  vec4 wp = modelMatrix * vec4(position, 1.0);",
      "  vP = wp.xyz;",
      "  gl_Position = projectionMatrix * viewMatrix * wp;",
      "}"
    ].join("\n"),
    fragmentShader: [
      "uniform float uTime;",
      "uniform vec3 uColor;",
      "uniform vec3 uHot;",
      "uniform vec3 uDark;",
      "uniform float uNoise;",
      "uniform float uSpot;",
      "varying vec2 vUv;",
      "varying vec3 vN;",
      "varying vec3 vP;",
      "float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }",
      "float noise2(vec2 p) {",
      "  vec2 i = floor(p); vec2 f = fract(p);",
      "  f = f * f * (3.0 - 2.0 * f);",
      "  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),",
      "             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);",
      "}",
      "float fbm(vec2 p) {",
      "  float v = 0.0; float a = 0.5;",
      "  for (int k = 0; k < 4; k++) { v += a * noise2(p); p *= 2.03; a *= 0.5; }",
      "  return v;",
      "}",
      "void main() {",
      "  float th = vUv.x * 6.28318;",     // 经度方向取样做环向无缝
      "  vec2 p = vec2(cos(th), sin(th)) * uNoise + vec2(0.0, vUv.y * uNoise * 2.0);",
      "  float t = uTime * 0.04;",
      "  float n = fbm(p + vec2(t * 1.4, -t)) * 0.6 + fbm(p * 2.7 - vec2(t, t * 0.7)) * 0.4;",
      "  float bright = 1.0 + (n - 0.5) * 0.24;",     // 柔和颗粒：±12% 缓慢起伏
      "  float spot = smoothstep(0.76 - uSpot * 0.18, 0.96, fbm(p * 0.8 + 11.7 - vec2(t * 0.6, 0.0)));",
      "  vec3 col = uColor * bright;",
      "  col = mix(col, uDark, spot * 0.5 * uSpot);",
      "  vec3 N = normalize(vN);",
      "  vec3 V = normalize(cameraPosition - vP);",
      "  float ndv = clamp(dot(N, V), 0.0, 1.0);",
      "  float limb = pow(ndv, 0.55);",                // 1 = 正对相机（中心），0 = 临边
      "  col *= mix(0.74, 1.1, limb);",                 // 临边变暗 → 球体感
      "  col = mix(col, uHot, pow(limb, 3.0) * 0.4);",  // 中心泛白热
      "  gl_FragColor = vec4(col, 1.0);",
      "}"
    ].join("\n")
  });
}

/* 日冕壳材质已在 v0.4.1 移除：贴壳的菲涅尔亮线会在球体外圈形成
 * 一圈硬边光环，破坏球体轮廓。光晕改由屏幕朝向的渐变精灵承担。 */

function buildTextures() {
  var c = document.createElement("canvas"); c.width = c.height = 128;
  var g = c.getContext("2d");
  var grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.22, "rgba(255,255,255,0.55)");
  grad.addColorStop(0.55, "rgba(255,255,255,0.10)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  glowTex = new THREE.CanvasTexture(c);

  var c2 = document.createElement("canvas"); c2.width = c2.height = 128;
  var g2 = c2.getContext("2d");
  g2.strokeStyle = "#ffffff"; g2.lineWidth = 9;
  g2.beginPath(); g2.arc(64, 64, 50, 0, Math.PI * 2); g2.stroke();
  g2.lineWidth = 3; g2.globalAlpha = 0.5;
  g2.beginPath(); g2.arc(64, 64, 50, 0, Math.PI * 2); g2.stroke();
  ringTex = new THREE.CanvasTexture(c2);

  starTex = starSurfaceTex();   // 保留调用：维持确定性随机序列（表面已改为着色器）
  ghostT = ghostTex();
  cloudT = cloudTex();
  ringBandT = ringBandTex();
  nebT = nebulaTex();
  /* v0.5 新增三张（选中括号 / 选中细环 / 光子环）：
   * 全部为固定坐标绘制、零随机消耗，不会扰动确定性序列 */
  bracketT = bracketTex();
  selRingT = selRingTex();
  photonT = photonTex();
}


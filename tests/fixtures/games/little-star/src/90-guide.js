/* ================= 恒星指导书（游戏内科普档案） ================= */

/* 记录科学数据：主序序列 / 光度级 / 褐矮星 / 致密天体 / 演化归宿；
 * 「本作星型库」一节由 STAR_TYPES 实时生成，保证与代码不脱节。
 * ★ 栏目化（v0.6.1）：全书 = 导言 + 恒星篇 6 栏 + 行星篇 6 栏，左栏导航、右栏只渲染当前栏目，
 *   不再是「一页到底」的长卷。栏目清单见 guideChannels()，是导航 / 目录 / 翻页的唯一事实来源。
 * DOM 契约：#hud > #guide-btn 打开 · #guide（.hidden 关闭）> .g-book >
 *           .g-head > #guide-close · .g-main > #guide-nav（左栏） + #guide-body（当前栏目）。 */
var elGuide = null, elGuideBody = null, elGuideNav = null;
var guideSel = 0;            /* 当前栏目下标 —— 模块级，重开指导书回到上次读到的那栏 */
var guideCount = 0;          /* 栏目总数（renderGuide 写入），翻页边界判断用 */
var GUIDE = {
  intro: "本作中的「恒星」取广义——一切可居于星系中心的大质量天体：从褐矮星、主序星、巨星，到白矮星、中子星乃至黑洞，均在星型库之列。以下为真实科学数据，各类型在本作中的取值均落在对应区间内。",
  seq: [
    ["O5V", "蓝色", "≥ 30,000 K", "16–90 M☉", "6.6 R☉+", "10⁴–10⁶ L☉", "0.00003%", "参宿一"],
    ["B5V", "蓝白", "10,000–30,000 K", "2.1–16 M☉", "1.8–6.6 R☉", "25–30,000 L☉", "0.13%", "参宿七"],
    ["A5V", "白色", "7,500–10,000 K", "1.4–2.1 M☉", "1.4–1.8 R☉", "5–25 L☉", "0.6%", "天狼星"],
    ["F5V", "黄白", "6,000–7,500 K", "1.04–1.4 M☉", "1.15–1.4 R☉", "1.5–5 L☉", "3%", "南河三"],
    ["G2V", "黄色", "5,200–6,000 K", "0.8–1.04 M☉", "0.96–1.15 R☉", "0.6–1.5 L☉", "7.6%", "太阳"],
    ["K2V", "橙色", "3,700–5,200 K", "0.50–0.85 M☉", "0.7–0.96 R☉", "0.08–0.6 L☉", "12%", "天仓五"],
    ["M5V", "红色", "2,400–3,700 K", "0.08–0.45 M☉", "≤ 0.7 R☉", "≤ 0.08 L☉", "76%", "比邻星"]
  ],
  lum: [
    ["Ia / Ib", "超巨星", "光度 10⁴–10⁶ L☉；参宿四（M2 Ia）即此类"],
    ["II", "亮巨星", "光度介于超巨星与巨星之间"],
    ["III", "巨星", "氢壳燃烧、体积膨胀（红巨星）"],
    ["IV", "次巨星", "主序向巨星演化的过渡阶段"],
    ["V", "主序星（矮星）", "核心稳定烧氢——恒星一生的 90%"],
    ["VI", "次矮星", "贫金属、高速运动的老恒星"],
    ["VII", "白矮星", "恒星残骸（详见「致密天体」）"]
  ],
  cold: [
    ["L5", "1,300–2,400 K", "褐矮星：质量不到 0.08 M☉，从未点燃氢聚变（失败的恒星）"],
    ["T5", "700–1,300 K", "褐矮星：甲烷吸收带显著，辐射以近红外为主"],
    ["Y1", "< 700 K", "褐矮星：几乎只辐射红外，可冷于行星"]
  ],
  compact: [
    ["白矮星 DA2", "≈ 25,000 K", "0.62 M☉ · 0.0126 R☉", "电子简并压撑起的碳氧核，地球大小；缓慢冷却"],
    ["中子星 PSR", "≈ 600,000 K", "1.4 M☉ · 半径 ≈ 12 km", "一立方厘米重数亿吨；强磁场 + 高速自转"],
    ["黑洞 BH", "霍金辐射 ≈ 0", "10 M☉ · 视界 ≈ 30 km", "连中子简并压也撑不住，光也无法逃逸"]
  ],
  fate: [
    ["< 0.08 M☉", "褐矮星 —— 从未点燃聚变，缓慢冷却"],
    ["0.08–0.5 M☉", "红矮星 —— 可燃烧万亿年，宇宙至今无一走完全程"],
    ["0.5–8 M☉", "红巨星 → 行星状星云 → 白矮星 →（理论）黑矮星"],
    ["8–25 M☉", "红超巨星 → 超新星 → 中子星"],
    ["> 25 M☉", "沃尔夫-拉叶星 → 超新星 / 伽马暴 → 黑洞"]
  ],

  /* ---- 行星篇 ---- */
  pClass: [
    ["岩质行星", "0.1–2.2 R⊕", "硅酸盐 · 铁镍", "有固体表面。矮行星到超级地球都属此类；内部的铁核占比可高可低"],
    ["冰巨星", "3.5–4.2 R⊕", "H₂O · NH₃ · CH₄ 幔", "天王星 4.0 / 海王星 3.9 R⊕；甲烷吸收红光，故呈青色"],
    ["气态巨行星", "9–13 R⊕", "H₂ · He", "无固体表面。半径对质量极不敏感——木星 318 M⊕ 与土星 95 M⊕ 几乎一样大"]
  ],
  pZone: [
    ["熔岩行星", "> 1500 K", "硅酸盐熔融", "岩石熔化，表面是翻涌的岩浆海"],
    ["炽岩行星", "700–1500 K", "硅酸盐固态", "热到发红但未熔融；大气多被恒星风剥离"],
    ["温室行星", "400–1500 K", "CO₂ 浓密", "金星型：失控温室把热量锁住（金星 T_eq 227 K → 实际 737 K）"],
    ["沙漠行星", "300–400 K", "无液态水", "水已逃逸或从未留驻"],
    ["类地 / 海洋行星", "273–373 K", "液态水", "← 液态水窗口即「宜居带」；水多则成全球海洋行星"],
    ["冻原行星", "195–273 K", "水冰 + 冻土", "季节性冰盖进退（火星 210 K）"],
    ["冰封行星", "63–195 K", "CO₂ · 水冰", "大气稀薄，CO₂ 凝成霜（木卫二表面约 100 K）"],
    ["冰冻世界", "< 63 K", "N₂ · CH₄ 冰", "连氮与甲烷都冻成固体（冥王星 44 K）"]
  ],
  pCompose: [
    ["铁镍核", "地球 32% · 水星 ≈ 63% · 月球 ≈ 3%", "密度最高的一档，深埋中心。铁核越大，同半径的行星越沉——水星只有 0.38 R⊕ 却比月球重一倍多"],
    ["硅酸盐幔 / 壳", "地球 ≈ 68%", "橄榄石 · 辉石类岩石，占据体积主体，决定行星的「硬度」"],
    ["挥发分", "地球 ≈ 1% · 海洋行星 > 25%", "水 · 氨 · 甲烷。占比由形成位置（雪线内外）与自身抽签共同决定；它的<b>相态</b>再被表面温度改写"]
  ],
  pGrad: [
    ["金属丰度", "内高外低", "难熔物质只在热的内侧凝结成固体，先被恒星吸走 → 越靠里铁镍越多（水星 63% → 地球 32% → 外带更贫铁）"],
    ["挥发分", "内低外高", "雪线以外温度低到能让水·氨·甲烷结成冰并被留住 → 越靠外越富水（内侧干成沙漠，外侧冻成冰原）"]
  ],
  pPhase: [
    ["< 200 K", "水冰", "水永远是冰，地表像木卫二那样裂开"],
    ["200–273 K", "冰水", "冻土与季节性冰盖（火星）"],
    ["273–373 K", "液态水", "液态水窗口 = 宜居带（地球）"],
    ["373–900 K", "水汽", "海洋被蒸干，水只以蒸汽存在于大气（金星）"],
    ["> 900 K", "已蒸干", "水分子被紫外线分解、氢逃逸——储库彻底清空（水星 · 熔岩行星）"]
  ],
  pFormula: [
    ["平衡温度", "T_eq = T★·(1−A)^¼·√(R★/2a)", "恒星给多少辐照、行星反射多少 → 无大气时的温度"],
    ["表面温度", "T_surf = T_eq × 温室系数", "地球 255→288 K（×1.13）；金星 227→737 K（×3.2）"],
    ["开普勒第三定律", "P = 2π√(a³/G(M★+m))", "公转周期：离得越远越慢（地球 1 年）"],
    ["轨道速度", "v = 2πa/P", "离恒星越近跑得越快（水星 47.4 km/s vs 海王星 5.4）"],
    ["质量-半径关系", "岩质 M = R^3.57（R ≤ 1.5 R⊕）", "更大时自压缩变缓、指数降到 2；巨行星反过来由质量定半径。本作再乘「体积加权混合密度比」，让成分真正落到质量上"],
    ["混合密度（本作用）", "1/ρ = Σ(xᵢ/ρᵢ) → M = M基准·(ρ/ρ地球成分)", "铁 7.87 / 硅酸盐 3.3 / 水冰 1.0 g/cm³ 三种材料按质量分数加权：铁核越大越沉（水星型 +29%），富水的越轻（海洋行星 −38%）"],
    ["平均密度", "ρ = M / (4πR³/3)", "由质量与半径直接得到，因此「构成 → 密度」这条链是算出来的：水星 5.43 · 地球 5.51 · 月球 3.34 g/cm³"],
    ["表面重力", "g = GM/R²", "地球 9.81 m/s²；决定人能跳多高、山能长多高"],
    ["逃逸速度", "v_esc = √(2GM/R)", "决定能不能留住大气（地球 11.2 km/s，月球只有 2.4）"],
    ["潮汐锁定", "a < 0.075·M★^⅓ AU 时被锁定", "锁定后同步自转：一面永昼、一面永夜，昼夜反差可达数百度"]
  ]
};

/* ---- 科普插图（内联 SVG，v0.6.1） ----
 * 三张图：光谱序列 / 赫罗图 / 演化归宿分岔。全部内联在书页里，零外部资源。
 * ★ 配色纪律：图里只有两个颜色来源 —— ① 本书的黑白灰**变量**（文字与线）
 *   ② **恒星光谱色**（O 蓝 → M 红）。后者是数据不是装饰，与 .g-dot 同一条规矩。
 * ★ 数据联动：每张图都会标出**本星系那颗恒星**（色带高亮 / 标记点 / 白框行），
 *   所以 __game.setStarType() 换型预览时，图上的标记跟着走 —— 与库里的「本星系」标同源。
 *
 * 坐标口径（图内手绘，但映射是算的）：
 *   光谱带 i 的中心 x = bandX(i)；赫罗图 y = 238.6 − 30.1·lg L（1 个数量级 = 30.1px） */
var SPEC_BANDS = [
  { s: "O", c: "#9bb0ff", tMin: 30000, t: ["> 30,000", "K"],       share: "0.00003%", star: "参宿一" },
  { s: "B", c: "#aabfff", tMin: 10000, t: ["10,000–", "30,000 K"], share: "0.13%",    star: "参宿七" },
  { s: "A", c: "#cad7ff", tMin: 7500,  t: ["7,500–", "10,000 K"],  share: "0.6%",     star: "天狼星" },
  { s: "F", c: "#f4f1ff", tMin: 6000,  t: ["6,000–", "7,500 K"],   share: "3%",       star: "南河三" },
  { s: "G", c: "#ffe9b8", tMin: 5200,  t: ["5,200–", "6,000 K"],   share: "7.6%",     star: "太阳" },
  { s: "K", c: "#ffcd8f", tMin: 3700,  t: ["3,700–", "5,200 K"],   share: "12%",      star: "天仓五" },
  { s: "M", c: "#ff8f5e", tMin: 2400,  t: ["2,400–", "3,700 K"],   share: "76%",      star: "比邻星" }
];
var BAND_X0 = 92, BAND_W = 78.3;
function bandX(i) { return BAND_X0 + BAND_W * (i + 0.5); }
/* 温度 → 光谱带下标（只按温度，致密天体也要能落位）；低于 2,400 K（褐矮星域）返回 −1 */
function bandRaw(tempK) {
  for (var i = 0; i < SPEC_BANDS.length; i++) if (tempK >= SPEC_BANDS[i].tMin) return i;
  return -1;
}
/* 光谱序列图上的高亮格：致密天体不走这条序列（白矮星按 DA/DB… 分，黑洞没有光谱型） */
function bandOf(st) {
  if (["wd", "ns", "bh"].indexOf(st.klass) >= 0) return -1;
  return bandRaw(st.tempK);
}
/* 赫罗图坐标：x 取光谱带中心，y 由光度定；超出图幅（10⁻⁴–10⁶ L☉）返回 null */
function hrXY(st) {
  var i = bandRaw(st.tempK), L = st.lumSol;
  if (i < 0 || !(L > 0)) return null;
  var lg = Math.log(L) / Math.LN10;
  if (lg < -4 || lg > 6) return null;
  return { x: bandX(i), y: 238.6 - 30.1 * lg };
}
/* 致密天体在图上的补充说明（它们的位置只是「温度对应处」，不在主序上） */
function figNote(st) {
  if (st.klass === "bh") return "黑洞没有光谱型，不在这条序列上。";
  if (st.klass === "ns") return "中子星按温度落在 O 带附近，但它不在主序上。";
  if (st.klass === "wd") return "白矮星按温度落在 B 带附近，属恒星残骸，不在主序上。";
  return "";
}
function figWrap(body, cap) {
  return '<figure class="g-fig">' + body + "<figcaption>" + cap + "</figcaption></figure>";
}

var GUIDE_FIG = {
  /* 图一：O→M 光谱分类序列（色带 = 真实光谱色，最左最热最蓝） */
  seq: function (st) {
    var hi = bandOf(st), x = bandX(hi);
    var h = '<svg viewBox="0 0 680 310" font-size="12" role="img" aria-labelledby="fSeqT">' +
      '<title id="fSeqT">恒星光谱分类序列：O 到 M 的温度、颜色、数量占比与代表星</title>' +
      '<desc>七个主序光谱型 O B A F G K M 按表面温度从高到低排列，含颜色色带、温度区间、' +
      "太阳邻域数量占比与代表恒星；本星系恒星所在的带被白框标出。</desc>";
    if (hi >= 0) h += '<text class="fg-hi" x="' + x + '" y="38" text-anchor="middle" font-size="10.5">本 星 系</text>';
    h += '<g class="fg-hi" text-anchor="middle" font-size="22" font-weight="600">';
    SPEC_BANDS.forEach(function (b, i) { h += '<text x="' + bandX(i) + '" y="58">' + b.s + "</text>"; });
    h += "</g>";
    SPEC_BANDS.forEach(function (b, i) {
      h += '<rect x="' + (BAND_X0 + BAND_W * i) + '" y="70" width="' + BAND_W + '" height="62" fill="' + b.c + '" ' +
        (i === hi ? 'class="fg-cur"' : 'stroke="var(--rule)" stroke-width="0.5"') + "/>";
    });
    function vals(y, fn) {
      return '<g text-anchor="middle">' + SPEC_BANDS.map(function (b, i) {
        return '<text x="' + bandX(i) + '" y="' + y + '"' + (i === hi ? ' class="fg-hi"' : "") + ">" + fn(b) + "</text>";
      }).join("") + "</g>";
    }
    h += '<text x="40" y="163">表面温度</text>' + vals(152, function (b) { return b.t[0]; }) +
      vals(167, function (b) { return b.t[1]; });
    h += '<text x="40" y="214">数量占比</text>' + vals(214, function (b) { return b.share; });
    h += '<text x="40" y="254">代表星</text>' + vals(254, function (b) { return b.star; });
    h += '<text class="fg-lo" x="40" y="284">每个光谱型再分 0–9 个次型：太阳 = G2V、比邻星 = M5.5V；后缀字母（V 等）表示光度级。</text>' +
      '<text class="fg-lo" x="40" y="300">数量占比为太阳邻域（约 10 秒差距内）恒星普查数据。</text></svg>';
    var cur = hi >= 0
      ? "本星系恒星（" + st.spec + " · " + fmtNum(st.tempK) + " K）落在 <b>" + SPEC_BANDS[hi].s + " 带</b>（白框那一格）。"
      : "本星系恒星（" + st.spec + " · " + fmtNum(st.tempK) + " K）不在这条主序序列上。";
    return figWrap(h, cur + figNote(st));
  },

  /* 图二：赫罗图（温度 - 光度），四大区域 + 主序带；本星系恒星落点用实色点标出 */
  hr: function (st) {
    /* 主序带折线：7 个光谱带的代表光度（lg L ≈ 5.5 → −2.5，从左上到右下） */
    var LG_MS = [5.5, 3.5, 2, 1, 0, -0.8, -2.5];
    var MS = SPEC_BANDS.map(function (b, i) {
      return { x: bandX(i), c: b.c, y: 238.6 - 30.1 * LG_MS[i] };
    });
    var d = "M" + MS.map(function (p) { return p.x.toFixed(1) + " " + p.y.toFixed(1); }).join(" L");
    var h = '<svg viewBox="0 0 680 454" font-size="12" role="img" aria-labelledby="fHrT">' +
      '<title id="fHrT">恒星赫罗图：主序带、巨星、超巨星、白矮星四大区域</title>' +
      '<desc>以光谱型和光度为轴的赫罗图，标注四大区域与太阳、参宿四、比邻星的位置，并标出本星系恒星。</desc>' +
      '<text class="fg-hi" x="84" y="48">光度 L☉（对数刻度）</text>';
    [118.2, 178.4, 238.6, 298.8, 359].forEach(function (y) {
      h += '<line class="fg-grid" x1="84" y1="' + y + '" x2="640" y2="' + y + '"/>';
    });
    h += '<rect class="fg-frame" x="84" y="58" width="556" height="316"/>';
    h += '<g text-anchor="end">' + ["10⁶", "10⁴", "10²", "1", "10⁻²", "10⁻⁴"].map(function (t, i) {
      return '<text x="76" y="' + (62 + i * 60.2) + '">' + t + "</text>";
    }).join("") + "</g>";
    /* 三个区域框（白矮星区 / 巨星区 / 超巨星区） */
    h += '<rect class="fg-zone" x="200" y="62" width="440" height="34" rx="14"/><text x="216" y="83">超巨星 Ia–Ib</text>';
    h += '<rect class="fg-zone" x="400" y="148" width="240" height="45" rx="14"/><text x="416" y="175">巨星 III</text>';
    h += '<rect class="fg-zone" x="150" y="314" width="290" height="45" rx="14"/><text x="166" y="341">白矮星 VII</text>';
    /* 主序带：粗光晕 + 细线 + 各光谱带落点（颜色即光谱色） */
    h += '<path d="' + d + '" fill="none" stroke="var(--edge)" stroke-width="24" stroke-linecap="round" stroke-linejoin="round" opacity="0.14"/>' +
      '<path d="' + d + '" fill="none" stroke="var(--edge)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>';
    MS.forEach(function (p) {
      h += '<circle cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="2.6" fill="' + p.c + '"/>';
    });
    h += '<text x="285" y="172" text-anchor="middle">主序带 V · 约 90% 的恒星生涯</text>';
    /* 三颗参考星（颜色同样是光谱色） */
    h += '<circle cx="441.4" cy="238.6" r="4.5" fill="#ffe9b8"/><text x="452" y="243">太阳 G2V</text>';
    h += '<circle cx="596" cy="76" r="3.5" fill="#ff8f5e"/><text x="596" y="108" text-anchor="middle">参宿四</text>';
    h += '<circle cx="600.3" cy="313.8" r="3.5" fill="#ff8f5e"/><text x="600.9" y="337" text-anchor="middle">比邻星</text>';
    /* ★ 本星系恒星：实色点 + 白环 + 引线标签 */
    var xy = hrXY(st);
    if (xy) {
      var right = xy.x > 470;
      /* 与三颗参考星撞上时标签上移一行 —— 本作默认星系是 M 型，正好压在比邻星旁边 */
      var hit = [[441.4, 238.6], [596, 76], [600.3, 313.8]].some(function (r) {
        return Math.abs(r[0] - xy.x) < 26 && Math.abs(r[1] - xy.y) < 26;
      });
      h += '<circle class="fg-cur" cx="' + xy.x.toFixed(1) + '" cy="' + xy.y.toFixed(1) + '" r="5.5" fill="' + cssOf(st.color) + '"/>' +
        '<text class="fg-hi" x="' + (right ? xy.x - 11 : xy.x + 11).toFixed(1) + '" y="' + (xy.y + (hit ? -11 : 4)).toFixed(1) +
        '"' + (right ? ' text-anchor="end"' : "") + ">本星系 " + st.spec + "</text>";
    }
    h += '<g class="fg-hi" text-anchor="middle" font-size="13">' + MS.map(function (p, i) {
      return '<text x="' + p.x.toFixed(1) + '" y="392">' + SPEC_BANDS[i].s + "</text>";
    }).join("") + "</g>";
    h += '<text x="362" y="412" text-anchor="middle">光谱型：O → M（表面温度递减）</text>' +
      '<text class="fg-lo" x="40" y="434">完整编号 = 光谱型 + 光度级：太阳 = G2V、参宿四 = M1-2 Ia-ab、天狼星 = A1V。</text></svg>';
    /* 落不进图幅时说清是哪一头出的界，别只写一句「未标注」 */
    var miss = st.klass === "bh" ? "没有光谱型与光度，落不到这张图上"
      : (st.tempK < 2400
        ? "的表面温度 " + fmtNum(st.tempK) + " K 已在 M 带之下（褐矮星域）"
        : "的光度 " + st.lumSol + " L☉ 超出图幅（10⁻⁴–10⁶ L☉）");
    var cap = xy
      ? "本星系恒星（" + st.spec + " · " + fmtNum(st.tempK) + " K · " + st.lumSol + " L☉）落在（" +
        Math.round(xy.x) + ", " + Math.round(xy.y) + "）—— 白环那个点。" + figNote(st)
      : "本星系恒星（" + st.spec + "）" + miss + "，未标注。" + figNote(st);
    return figWrap(h, cap);
  },

  /* 图三：演化归宿分岔（按初始质量五档）；本星系恒星所在那一档整体高亮 */
  fate: function (st) {
    var ROWS = [
      { m: "≤ 0.08 M☉",  html: '<g class="fg-end"><rect x="152" y="60" width="220" height="42" rx="8"/></g>' +
          '<text class="fg-hi" x="262" y="86" text-anchor="middle">棕矮星（从未点燃氢聚变）</text>' },
      { m: "0.08–0.5 M☉", html: '<g class="fg-node"><rect x="152" y="120" width="150" height="42" rx="8"/></g>' +
          '<text class="fg-hi" x="227" y="146" text-anchor="middle">红矮星</text>' +
          '<line class="fg-arrow" x1="304" y1="141" x2="312" y2="141" marker-end="url(#fArrow)"/>' +
          '<g class="fg-end"><rect x="314" y="120" width="150" height="42" rx="8"/></g>' +
          '<text class="fg-hi" x="389" y="146" text-anchor="middle">白矮星（理论）</text>' },
      { m: "0.5–8 M☉", html: [["主序星", 152, 87], ["红巨星", 251, 87], ["行星状星云", 350, 87]].map(function (n) {
          return '<g class="fg-node"><rect x="' + n[1] + '" y="180" width="' + n[2] + '" height="42" rx="8"/></g>' +
            '<text class="fg-hi" x="' + (n[1] + n[2] / 2) + '" y="206" text-anchor="middle">' + n[0] + "</text>";
        }).join("") + '<line class="fg-arrow" x1="340" y1="201" x2="348" y2="201" marker-end="url(#fArrow)"/>' +
          '<line class="fg-arrow" x1="439" y1="201" x2="447" y2="201" marker-end="url(#fArrow)"/>' +
          '<g class="fg-end"><rect x="449" y="180" width="87" height="42" rx="8"/></g>' +
          '<text class="fg-hi" x="492.5" y="206" text-anchor="middle">白矮星</text>' +
          '<line class="fg-arrow" x1="538" y1="201" x2="546" y2="201" marker-end="url(#fArrow)"/>' +
          '<g class="fg-end"><rect x="548" y="180" width="87" height="42" rx="8"/></g>' +
          '<text class="fg-hi" x="591.5" y="206" text-anchor="middle">黑矮星</text>' +
          '<line class="fg-arrow" x1="241" y1="201" x2="249" y2="201" marker-end="url(#fArrow)"/>' },
      { m: "8–25 M☉", html: [["主序星", 152, 112], ["红超巨星", 276, 112]].map(function (n) {
          return '<g class="fg-node"><rect x="' + n[1] + '" y="240" width="' + n[2] + '" height="42" rx="8"/></g>' +
            '<text class="fg-hi" x="' + (n[1] + n[2] / 2) + '" y="266" text-anchor="middle">' + n[0] + "</text>";
        }).join("") + '<line class="fg-arrow" x1="266" y1="261" x2="274" y2="261" marker-end="url(#fArrow)"/>' +
          '<line class="fg-arrow" x1="390" y1="261" x2="398" y2="261" marker-end="url(#fArrow)"/>' +
          '<g class="fg-node"><rect x="400" y="240" width="112" height="42" rx="8"/></g>' +
          '<text class="fg-hi" x="456" y="266" text-anchor="middle">Ⅱ型超新星</text>' +
          '<line class="fg-arrow" x1="514" y1="261" x2="522" y2="261" marker-end="url(#fArrow)"/>' +
          '<g class="fg-end"><rect x="524" y="240" width="112" height="42" rx="8"/></g>' +
          '<text class="fg-hi" x="580" y="266" text-anchor="middle">中子星</text>' },
      { m: "&gt; 25 M☉", html: [["主序星", 152, 112], ["沃尔夫-拉叶星", 276, 112]].map(function (n) {
          return '<g class="fg-node"><rect x="' + n[1] + '" y="300" width="' + n[2] + '" height="42" rx="8"/></g>' +
            '<text class="fg-hi" x="' + (n[1] + n[2] / 2) + '" y="326" text-anchor="middle">' + n[0] + "</text>";
        }).join("") + '<line class="fg-arrow" x1="266" y1="321" x2="274" y2="321" marker-end="url(#fArrow)"/>' +
          '<line class="fg-arrow" x1="390" y1="321" x2="398" y2="321" marker-end="url(#fArrow)"/>' +
          '<g class="fg-node"><rect x="400" y="300" width="112" height="42" rx="8"/></g>' +
          '<text class="fg-hi" x="456" y="326" text-anchor="middle">超新星与伽马暴</text>' +
          '<line class="fg-arrow" x1="514" y1="321" x2="522" y2="321" marker-end="url(#fArrow)"/>' +
          '<g class="fg-end"><rect x="524" y="300" width="112" height="42" rx="8"/></g>' +
          '<text class="fg-hi" x="580" y="326" text-anchor="middle">黑洞</text>' }
    ];
    var LIM = [0.08, 0.5, 8, 25, 1 / 0];
    var cur = 0;
    while (cur < 4 && st.massSol > LIM[cur]) cur++;
    var h = '<svg viewBox="0 0 680 410" font-size="12" role="img" aria-labelledby="fFateT">' +
      '<title id="fFateT">恒星演化归宿分岔图</title>' +
      '<desc>按初始质量分成五条演化路径：棕矮星、红矮星、类太阳恒星到白矮星、大质量恒星到中子星、' +
      "超大质量恒星到黑洞；本星系恒星所在的那一档被高亮。</desc>" +
      '<defs><marker id="fArrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">' +
      '<path d="M2 1L8 5L2 9" fill="none" stroke="#6e6e6e" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>' +
      '<text class="fg-hi" x="88" y="46" text-anchor="middle">初始质量</text>' +
      '<text class="fg-hi" x="396" y="46" text-anchor="middle">演化路径</text>';
    ROWS.forEach(function (r, i) {
      var y = 60 + i * 60;
      h += '<rect class="fg-node' + (i === cur ? " fg-cur" : "") + '" x="40" y="' + y + '" width="96" height="42" rx="8"/>' +
        '<text x="88" y="' + (y + 26) + '" text-anchor="middle"' + (i === cur ? ' class="fg-hi"' : "") + ">" + r.m + "</text>" +
        r.html;
      if (i === cur) h += '<circle cx="26" cy="' + (y + 21) + '" r="4.5" fill="' + cssOf(st.color) + '" class="fg-cur"/>';
    });
    h += '<text class="fg-lo" x="40" y="374">红矮星寿命以万亿年计——今天宇宙里还没有一颗走完全程；</text>' +
      '<text class="fg-lo" x="40" y="390">黑矮星仍是理论天体：宇宙才 138 亿岁，白矮星还没冷却到那一步。（M☉ = 太阳质量）</text></svg>';
    return figWrap(h, "本星系恒星的质量 " + st.massSol + " M☉ 落在「" +
      ROWS[cur].m.replace("&gt;", ">") + "」那一档（白框行 + 左侧实色点）—— " +
      "它这一档的终点是<b>" + ["棕矮星", "白矮星（理论）", "黑矮星（理论）", "中子星", "黑洞"][cur] + "</b>。" +
      "质量是恒星唯一无法回头的命运参数。");
  }
};

function guideSec(title, inner) {
  return '<section class="g-sec"><h3>' + title + "</h3>" + inner + "</section>";
}
function guideTable(head, rows) {
  var h = '<table class="g-tbl"><thead><tr>';
  head.forEach(function (c) { h += "<th>" + c + "</th>"; });
  h += "</tr></thead><tbody>";
  rows.forEach(function (r) {
    h += "<tr>";
    r.forEach(function (c, i) { h += '<td class="' + (i === 0 ? "em" : "") + '">' + c + "</td>"; });
    h += "</tr>";
  });
  return h + "</tbody></table>";
}
/* ---- 栏目化：左栏导航 + 右栏单栏目渲染（v0.6.1） ---- */

/* 栏目清单 —— 唯一事实来源：左栏导航、导言目录、翻页条、测试全读它，改一处即全书同步。
 * 每项 { part, short, title, html }：part = 所属篇（空串 = 不入篇，如导言）、
 * short = 左栏用的短名、title = 正文标题、html = 正文片段（惰性函数，渲染到才求值，
 * 因此「本星系实测」这类读现场数据的栏目每次打开都是新值）。 */
function guideChannels() {
  if (!G.sys) return [];
  var st = G.sys.starType;
  var ch = [];
  function add(part, short, title, html) {
    ch.push({ part: part, short: short, title: title, html: html });
  }

  /* ---- 导言（封面页，含实时生成的目录） ---- */
  add("", "导 言", "导 言", function () {
    return '<p class="g-intro">' + GUIDE.intro + "</p>" +
      '<p class="g-note">全书两篇十二栏：点左栏或下面的目录可直接翻到那一节，也可以用 ← / → 逐栏翻阅。' +
      '当前星系的实测数据在「十一、本星系的实测数据」。</p>' +
      guideToc(ch);
  });

  /* ---- 恒星篇（六栏） ---- */
  add("恒 星 篇", "一、主序光谱序列", "一、主序光谱序列（按表面温度排列）", function () {
    return GUIDE_FIG.seq(st) +
      guideTable(["光谱型", "颜色", "表面温度", "质量", "半径", "光度", "数量占比", "代表星"], GUIDE.seq) +
      '<p class="g-note">数量占比 = 太阳邻域恒星普查；每个光谱型再分 0–9 次型（太阳 = G2、比邻星 = M5.5），后缀字母（V 等）是光度级。</p>';
  });
  add("恒 星 篇", "二、光度级", "二、光度级（耶基斯系统）", function () {
    return GUIDE_FIG.hr(st) + guideTable(["光度级", "名称", "说明"], GUIDE.lum);
  });
  add("恒 星 篇", "三、褐矮星", "三、冷端延伸：褐矮星（亚恒星）", function () {
    return guideTable(["光谱型", "表面温度", "说明"], GUIDE.cold);
  });
  add("恒 星 篇", "四、致密天体", "四、致密天体（恒星残骸）", function () {
    return guideTable(["天体", "表面温度", "质量 · 尺度", "说明"], GUIDE.compact);
  });
  add("恒 星 篇", "五、演化归宿", "五、演化归宿（由初始质量决定）", function () {
    return GUIDE_FIG.fate(st) + guideTable(["初始质量", "演化路径"], GUIDE.fate);
  });
  add("恒 星 篇", "六、本作星型库", "六、本作星型库（" + STAR_TYPES.length + " 种）", function () {
    return '<div class="g-lib">' + STAR_TYPES.map(function (t) {
      var cur = t.id === st.id;
      return '<div class="g-chip' + (cur ? " cur" : "") + '">' +
        '<span class="g-dot" style="background:' + cssOf(t.color) + '"></span>' +
        '<span class="g-cs">' + t.spec + '</span><span class="g-cn">' + t.name + "</span>" +
        '<span class="g-cv">' + (t.klass === "bh" ? "霍金辐射" : fmtNum(t.tempK) + " K") + " · " + t.massSol + " M☉</span>" +
        (cur ? '<span class="g-cur-tag">本星系</span>' : "") + "</div>";
    }).join("") + "</div>" +
    '<p class="g-note">提示：控制台执行 __game.setStarType("ID") 可切换恒星类型预览（ID：' +
      STAR_TYPES.map(function (t) { return t.id; }).join(" / ") + "）。</p>";
  });

  /* ---- 行星篇（六栏） ---- */
  add("行 星 篇", "七、行星的分类", "七、行星的分类（按体积与成分）", function () {
    return guideTable(["类别", "半径", "主要成分", "说明"], GUIDE.pClass);
  });
  add("行 星 篇", "八、气候带", "八、气候带：表面温度决定形态", function () {
    return guideTable(["类型", "表面温度", "关键成分", "说明"], GUIDE.pZone) +
      '<p class="g-note">判定顺序：先由「基准反照率 0.3、无温室」的平衡温度 T_eq0 定气候带，' +
      '再过一遍挥发分 / 金属丰度 / 体积的筛子；最后用该型自身的反照率与温室系数算出真实表面温度。' +
      '同一气候带上，干湿不同就会分出沙漠与海洋。</p>';
  });
  add("行 星 篇", "九、内部构成", "九、内部构成：三种储库", function () {
    return guideTable(["储库", "质量占比（实测标定）", "说明"], GUIDE.pCompose) +
      '<p class="g-note"><b>构成决定形态</b>：铁镍核与硅酸盐幔的比例定下密度和硬度，挥发分多寡定下「沙漠 / 类地 / 海洋」的分野。' +
      '本作不写死任何一颗行星的成分——面板「构成」行是按该行星自己的金属丰度、挥发分丰度与表面温度现算出来的质量占比。</p>' +
      '<h4 class="g-sub">两条相反的梯度（构成不是随机撒的）</h4>' +
      guideTable(["梯度", "方向", "成因"], GUIDE.pGrad) +
      '<p class="g-note">于是「离恒星越近的行星越致密、越靠外的越富水」这条真实规律会在本星系里自然浮现，' +
      '不需要额外写规则去摆布——它只是两个抽值各自乘了一个随轨道距离变化的比例。</p>' +
      '<h4 class="g-sub">温度改写挥发分的相态</h4>' +
      guideTable(["表面温度", "挥发分相态", "后果"], GUIDE.pPhase) +
      '<p class="g-note">同一份水，温度不同就是完全不同的世界：同样是水分子，在 100 K 是冰壳、在 300 K 是海洋、在 700 K 只配活在大气里。' +
      '温度高到 900 K 以上时水分子被紫外线分解、氢原子逃逸，挥发分储库被彻底清空——这就是水星与熔岩行星干燥的原因。</p>';
  });
  add("行 星 篇", "十、物理量公式", "十、行星物理量怎么算", function () {
    return guideTable(["物理量", "公式", "说明"], GUIDE.pFormula);
  });
  add("行 星 篇", "十一、本星系实测", "十一、本星系的实测数据（全部由公式算出）", function () {
    return guideWorked() + guidePlanetTable() +
      '<h4 class="g-sub">本星系各行星的构成（与上表同一批计算）</h4>' + guideCompTable();
  });
  add("行 星 篇", "十二、本作行星库", "十二、本作行星库（" + PLANET_TYPES.length + " 型）", function () {
    return '<div class="g-lib">' + PLANET_TYPES.map(function (t) {
      var cur = G.sys.planets.some(function (p) { return p.type.id === t.id; });
      return '<div class="g-chip col' + (cur ? " cur" : "") + '">' +
        '<span class="g-dot" style="background:' + cssOf(t.color) + '"></span>' +
        '<span class="g-cs">' + t.name + '</span>' +
        '<span class="g-cv">ρ ≈ ' + t.dens + ' g/cm³</span>' +
        (cur ? '<span class="g-cur-tag">本星系</span>' : "") +
        '<span class="g-cn">构成：' + t.comp + '</span>' +
        '<span class="g-cn2">' + t.surface + ' · 大气 ' + t.atmo + '</span>' +
        '<span class="g-cn2">形成条件：' + typeCond(t) + '</span></div>';
    }).join("") + "</div>";
  });

  return ch;
}

/* 导言页的目录：从栏目清单实时生成，所以永远不会和左栏脱节 */
function guideToc(list) {
  var h = "", part = null, open = false;
  list.forEach(function (c, i) {
    if (!c.part) return;
    if (c.part !== part) {
      if (open) h += "</div>";
      h += '<h4 class="gt-part">' + c.part + "</h4>";   /* 与栏内小标题 .g-sub 区分开，便于测试计数 */
      h += '<div class="g-toc">';
      part = c.part; open = true;
    }
    h += '<button class="gt-item" data-goto="' + i + '">' + c.title + "</button>";
  });
  return h + (open ? "</div>" : "");
}

/* 渲染【当前栏目】：左栏导航 + 右栏正文 + 底部翻页。
 * ★ 只把选中那一栏插进 DOM —— 其余十二栏不落地，这是「不挤在一页」的实现要点。 */
function renderGuide() {
  if (!elGuideBody || !elGuideNav || !G.sys) return;
  var chs = guideChannels();
  guideCount = chs.length;
  if (guideSel < 0 || guideSel >= guideCount) guideSel = 0;

  /* 左栏：篇分隔 + 栏目按钮（data-goto 与导言目录共用下面那套委托点击） */
  var nav = "", part = null;
  chs.forEach(function (c, i) {
    if (c.part && c.part !== part) { part = c.part; nav += '<p class="g-part">' + c.part + "</p>"; }
    nav += '<button class="gn-item' + (i === guideSel ? " on" : "") + '" data-goto="' + i + '"' +
      (i === guideSel ? ' aria-current="true"' : "") + ">" + c.short + "</button>";
  });
  elGuideNav.innerHTML = nav;

  /* 右栏：篇脚注 + 正文 + 翻页条 */
  var c = chs[guideSel];
  elGuideBody.innerHTML =
    (c.part ? '<p class="g-crumb">' + c.part + "</p>" : "") +
    guideSec(c.title, c.html()) +
    guidePager(chs, guideSel);
  elGuideBody.scrollTop = 0;
  var on = elGuideNav.querySelector(".gn-item.on");
  if (on && on.scrollIntoView) on.scrollIntoView({ block: "nearest" });
}

/* 底部翻页条：上一栏 / 第 n ÷ m 栏 / 下一栏 */
function guidePager(chs, i) {
  var prev = i > 0
    ? '<button class="gp-btn" data-goto="' + (i - 1) + '">‹ ' + chs[i - 1].short + "</button>"
    : '<button class="gp-btn" disabled>已是第一栏</button>';
  var next = i < chs.length - 1
    ? '<button class="gp-btn" data-goto="' + (i + 1) + '">' + chs[i + 1].short + " ›</button>"
    : '<button class="gp-btn" disabled>已是最后一栏</button>';
  return '<div class="g-page">' + prev +
    '<span class="gp-mid">' + (i + 1) + " ÷ " + chs.length + "</span>" + next + "</div>";
}

/* 翻到第 i 栏 —— 左栏 / 目录 / 翻页条 / ←→ 键四条入口共用（越界即忽略） */
function guideGoto(i) {
  if (i < 0 || i >= guideCount || i === guideSel) return;
  guideSel = i;
  renderGuide();
}

/* 反算示范：拿本星系第一颗行星，把公式代入真实数字走一遍 —— 面板上的数就是这么来的 */
function guideWorked() {
  var st = G.sys.starType, p = G.sys.planets[0];
  if (!p) return "";
  var aSol = (p.au / R_SOL_AU).toFixed(1);
  return '<div class="g-work">' +
    "<p><b>" + p.name + "（" + p.type.name + "）的表面温度是这样算出来的：</b></p>" +
    "<p>① 轨道半长轴 a = " + p.orbit.toFixed(1) + " 场景单位 ÷ " + VIS_PER_AU +
    " = <b>" + p.au.toFixed(4) + " AU</b></p>" +
    "<p>② 平衡温度 T_eq = T★·(1−A)^¼·√(R★/2a) = " + fmtNum(st.tempK) + " × (1−" + p.type.albedo +
    ")^¼ × √(" + st.radiusSol + " / (2 × " + p.au.toFixed(4) + " AU ÷ " + R_SOL_AU + ")) = <b>" +
    Math.round(p.teq) + " K</b></p>" +
    "<p>③ 该型的温室系数 ×" + p.type.green + " → 表面温度 <b>" + Math.round(p.tempSurf) + " K（" +
    Math.round(p.tempSurf - 273.15) + " ℃）</b></p>" +
    "<p>④ 开普勒第三定律 → 公转周期 <b>" + fmtPeriod(p.periodDays) + "</b>；" +
    "轨道速度 <b>" + p.vOrbit.toFixed(1) + " km/s</b></p>" +
    "<p>⑤ 质量-半径关系：R = " + p.rE.toFixed(2) + " R⊕ → 基准质量 " + fmtMass(rockyBase(p)) +
    "（地球成分）。再乘混合密度比 ×" + densRatio(p) + " —— 把铁镍 " + (p.iron * 100).toFixed(0) +
    "% / 挥发分 " + volPct(p) + "% 代进 1/ρ = Σ(xᵢ/ρᵢ) 得到 → 质量 <b>" + fmtMass(p.mE) + "</b> → " +
    "表面重力 <b>" + p.g.toFixed(2) + " m/s²</b>、逃逸速度 <b>" + p.vEsc.toFixed(2) + " km/s</b></p>" +
    "<p>⑥ 构成（质量占比）→ <b>" + composeOf(p) + "</b>；" +
    (volatileState(p.tempSurf) === null
      ? "表面温度 " + Math.round(p.tempSurf) + " K 已过水的分解线，挥发分储库名存实亡"
      : "同样一份水，此刻因表面温度 " + Math.round(p.tempSurf) + " K 而以「" + volLabel(p) + "」存在") + "</p>" +
    "<p>⑦ 质量 ÷ 体积 → 平均密度 <b>" + p.dens.toFixed(2) + " g/cm³</b>（地球 5.51）</p>" +
    "</div>";
}
/* 供示范块展示「修正前 / 修正后」用的两个中间量 */
function rockyBase(p) {
  if (p.bulk === "giant") return p.mE;
  return p.rE <= 1.5 ? Math.pow(p.rE, 3.57) : 5.06 * Math.pow(p.rE / 1.5, 2);
}
function densRatio(p) { return (p.mE / rockyBase(p)).toFixed(3); }
/* 从 comp 里挑出挥发分那一项 —— 面板与指导书共用，保证两处永不打架 */
function volEntry(p) {
  var re = /挥发分|水冰|冰水|液态水|水汽/;
  for (var i = 0; i < p.comp.length; i++) if (re.test(p.comp[i][0])) return p.comp[i];
  return ["—", 0];
}
function volPct(p) { return volEntry(p)[1]; }
function volLabel(p) { return volEntry(p)[0]; }
/* 本星系全行星数据表（现场读取，因此换恒星类型后会立刻反映新数值） */
function guidePlanetTable() {
  var rows = G.sys.planets.map(function (p) {
    return [
      p.name.replace(G.sys.name + " ", "") + " 号",
      p.type.name,
      p.au.toFixed(4),
      Math.round(p.teq) + " K",
      Math.round(p.tempSurf) + " K",
      p.rE.toFixed(2) + " R⊕",
      (p.mE >= 100 ? fmtNum(Math.round(p.mE)) : p.mE.toFixed(2)) + " M⊕",
      fmtPeriod(p.periodDays),
      p.g.toFixed(1),
      p.tidal ? "锁定" : p.rotH.toFixed(1) + " h"
    ];
  });
  return guideTable(["", "分类", "a (AU)", "T_eq", "T_surf", "半径", "质量", "公转周期", "g (m/s²)", "自转"],
    rows) +
    '<p class="g-note">T_eq = 平衡温度（不含温室）；T_surf = 表面温度；g = 表面重力。' +
    '横向看：离恒星越远，T_eq 越低；纵向看：同一颗行星的 T_surf − T_eq 就是它大气温室效应的贡献。</p>';
}
/* 本星系各行星的构成表 —— 占比来自 buildComposition，相态随温度变化 */
function guideCompTable() {
  var rows = G.sys.planets.map(function (p) {
    return [
      p.name.replace(G.sys.name + " ", "") + " 号",
      p.type.name,
      composeOf(p),
      volLabel(p),
      p.dens.toFixed(2)
    ];
  });
  return guideTable(["", "分类", "构成（质量占比）", "挥发分相态", "密度 g/cm³"], rows) +
    '<p class="g-note">★ <b>构成占比是形成时定下的，只有相态跟着当前表面温度走</b>：' +
    '把恒星换成红巨星重算一遍，最外那颗的「水冰」就会熔成「液态水」甚至变成「水汽」，' +
    '而铁镍核与硅酸盐幔的比例一格不动。这也是为什么用 __game.setStarType() 预览恒星时，' +
    '行星的分类不会跟着变——分类记的是它的出身，温度记的是它的现状。</p>';
}

/* ---- 覆盖层状态机的副作用（表在 25-fsm.js）----
 * ★ v0.7：书的开合以前是散在四处的 `elGuide.classList.add/remove("hidden")`，
 * 而「书开着时键盘归书、合着时归场景」靠现查 class 判断。现在 DOM 的 class 是
 * FSM_OVERLAY 状态的投影，只有 applyOverlay 一处写它：
 *   机器说 guide → 重渲染 + 摘掉 hidden（重渲染必须在摘之前，插图要量尺寸）
 *   机器说 none  → 加回 hidden
 * 外层调用者一律用 openGuide() / closeGuide() 发事件，不许再直接碰 class。 */
function applyOverlay() {
  if (!elGuide) return;
  if (FSM_OVERLAY.is("guide")) {
    renderGuide();                     /* 每次打开重渲染：现场数据（实测表）保持最新 */
    elGuide.classList.remove("hidden");
  } else {
    elGuide.classList.add("hidden");
  }
}
function openGuide() { return FSM_OVERLAY.send("openGuide"); }
function closeGuide() { return FSM_OVERLAY.send("close"); }

function setupGuide() {
  elGuide = $("guide");
  elGuideNav = $("guide-nav");
  elGuideBody = $("guide-body");
  var btn = $("guide-btn");
  if (!btn || !elGuide) return;
  btn.addEventListener("click", openGuide);
  $("guide-close").addEventListener("click", closeGuide);
  /* 委托点击：栏目按钮（左栏 / 导言目录）与翻页按钮都带 data-goto；
   * 点在书页之外的遮罩上则关闭。 */
  elGuide.addEventListener("click", function (e) {
    var t = e.target.closest && e.target.closest("[data-goto]");
    if (t) { guideGoto(parseInt(t.getAttribute("data-goto"), 10)); return; }
    if (e.target === elGuide) closeGuide();
  });
  window.addEventListener("keydown", function (e) {
    if (FSM_OVERLAY.is("guide")) {         /* 书开着：键盘归书 */
      if (e.key === "Escape") closeGuide();
      else if (e.key === "ArrowLeft") guideGoto(guideSel - 1);
      else if (e.key === "ArrowRight") guideGoto(guideSel + 1);
    } else if (FSM_CAMERA.is("focus") && e.key === "Escape") {
      exitFocus();                         /* v0.10：书合着 + 聚焦中 → Esc 退出聚焦（回落跟随档） */
    }
    /* 其余情况键盘归场景（暂不设全局快捷键） */
  });
}


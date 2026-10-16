/* =====================================================================
 * Little Star —— 单星系沙盘（game.js · v0.10.0）
 * ---------------------------------------------------------------------
 * 【是什么】three.js 单星系沙盘：一颗恒星 + 若干行星 + 小行星带，点天体看
 *          科学数据。恒星取广义——主序 / 巨星 / 褐矮星 / 致密天体 15 个
 *          类型；行星 16 个类型。取值全部落在真实科学区间。
 *          每颗行星带一张物资账（14 大类元素家底，蕴藏 / 可采两本账）；
 *          双击行星进「聚焦」——相机贴近、操作精度提高一档。
 * 【怎么跑】见同目录 README.md（起服务 / 跑测试 / 改代码的 SOP 全在那边）。
 * 【依赖】three.js r159 UMD（同目录 three.min.js）。无打包、无 npm、无框架。
 *          经典 <script> 直接加载，file:// 与 http:// 均可运行。
 *
 * ── ★ 本文件是生成物，别手改 ─────────────────────────────────────────
 *    源码在 src/ 下 17 个片段里，由 scripts/build.mjs 按 ORDER 顺序拼装
 *    而成。片段【不是】独立模块——它们同处一个 IIFE，照旧用裸标识符互相
 *    引用，没有 import / export / 命名空间。切分只是把一页长卷拆成章节。
 *
 *      src/00-prologue.js      本文件头 / 不变量 / IIFE 开
 *      src/10-core.js          基础工具（RNG / 绘制随机流 / 数值与 DOM）
 *      src/15-registry.js      对象类型注册表原语（表 = 本项目的骨架）
 *      src/20-data.js          静态数据（恒星库 / 行星物理与类型库 / 版本号）
 *      src/25-fsm.js           状态机原语 + 四台机器（选择 / 相机 / 覆盖层 / 面板）
 *      src/27-species.js       物种库（人类）+ 摇篮评分（世界事实派生，零 RNG）
 *      src/28-materials.js     物资账（14 大类元素家底 · 蕴藏 / 可采两本账，零 RNG）
 *      src/30-system.js        全局状态 / 星系生成 / three.js 基础
 *      src/35-civ.js           文明实例（物种 × 发源地）+ 发源地信标环
 *      src/40-textures.js      程序化贴图（气态行星 / 大气 / 恒星 / UI 素材）
 *      src/42-terrain.js       地形生成器（v0.11）：高程场 → 地表贴图 + 凹凸图
 *      src/50-scene.js         场景组装 + 每帧更新
 *      src/60-star-fx.js       恒星专章：耀斑 / 镜头光斑
 *      src/70-camera-input.js  相机聚焦 + 输入（三台机器的副作用）
 *      src/72-focus.js         聚焦镜头（v0.10）：贴近档 / 操作精度 / HUD
 *      src/80-panel.js         右侧信息面板（行星 / 资源 / 文明 三页标签）
 *      src/90-guide.js         恒星指导书（含内联 SVG 插图）
 *      src/99-boot.js          主循环 / 启动 / IIFE 收
 *
 *    改完任何片段后：node scripts/build.mjs   （重新拼成本文件）
 *    忘了也不要紧——verify.mjs 的 [0] 节会拿拼装结果与磁盘对比并报错。
 *    改版本号改 src/20-data.js 的 VERSION 常量（版本戳的单一数据源）。
 *
 * ── 区块导航 ─────────────────────────────────────────────────────────
 *    由 scripts/build.mjs 在拼装时生成，请勿手改；
 *    新增 / 删除顶层区块后跑 node scripts/build.mjs
 * @nav:begin
 *   起点    区段   区块                                               源文件
 *   ─────  ─────  ───────────────────────────────────────────────────  ────────────────────────
 *     143     59  基础工具                                             src/10-core.js:1
 *     202    158  对象类型注册表（v0.7 新增）                          src/15-registry.js:1
 *     360    387  静态数据                                             src/20-data.js:1
 *     747    154  状态机（v0.7 新增）                                  src/25-fsm.js:1
 *     901    187  物种（库）与摇篮判定（v0.8 新增）                    src/27-species.js:1
 *    1088    319  物资（v0.9 新增）：元素制家底 —— 蕴藏与可采两本账    src/28-materials.js:1
 *    1407     10  全局状态                                             src/30-system.js:1
 *    1417    158  星系生成（确定性：每次打开同一个星系）               src/30-system.js:11
 *    1575     28  three.js 基础                                        src/30-system.js:169
 *    1603    192  卫星（v0.14 起；v0.16 扩张）：小天体环绕             src/34-moons.js:1
 *    1795    123  文明（实例）· 发源地信标（v0.8 新增）                src/35-civ.js:1
 *    1918    608  程序化贴图（全部画布绘制，零外部资源）               src/40-textures.js:1
 *    2526    549  地形生成器（v0.11：固态行星表面构建）                src/42-terrain.js:1
 *    3075    489  聚焦地表（v0.12：立方球连续地表）                    src/44-focus-surface.js:1
 *    3564    562  聚落系统（v0.13 · 实验性）                           src/46-settlements.js:1
 *    4126    441  场景                                                 src/50-scene.js:1
 *    4567    183  场景更新                                             src/50-scene.js:442
 *    4750    194  恒星专章：耀斑 / 镜头光斑                            src/60-star-fx.js:1
 *    4944     25  相机聚焦                                             src/70-camera-input.js:1
 *    4969    171  输入：轨道相机 + 拾取                                src/70-camera-input.js:26
 *    5140    158  聚焦镜头（v0.10 新增）                               src/72-focus.js:1
 *    5298    267  右侧信息面板（选中天体时展开）                       src/80-panel.js:1
 *    5565    614  恒星指导书（游戏内科普档案）                         src/90-guide.js:1
 *    6179     72  主循环                                               src/99-boot.js:1
 *    6251    728  启动                                                 src/99-boot.js:73
 *   共 25 个区块 · 21 个源文件 · 6978 行
 * @nav:end
 * ─────────────────────────────────────────────────────────────────────
 *
 * ┌─ 不可破坏的不变量 ────────────────────────────────────────────────┐
 * │ 1. 确定性守恒（最容易踩）                                         │
 * │ 贴图生成会吃掉主 RNG 流——动贴图函数的数量 / 顺序，                │
 * │ 或增删任何抽 rng() 的对象，都会整体错位：                         │
 * │ 星系名会从「薄曙」变掉、行星布局全变。                            │
 * │ 规则：新增视觉随机一律走独立流 srng / srand（种子 777001）；      │
 * │ 删除对象要【保留它原本的 rng() 调用作为占位】。                   │
 * │ 自查：node scripts/roll-check.mjs → f=0.374455 → 命中 M           │
 * │ 2. 命名：*Tex 是画布工厂函数，*T 是 THREE.Texture 实例。          │
 * │ 传错会让 program 编译失败 → rAF 静默死（画面冻结、无报错）。      │
 * │ 3. IIFE 私有：全部片段拼装后整体包在 (function(){ "use strict";   │
 * │ … })() 内，顶层声明不挂 window。对外只暴露 window.__game；        │
 * │ 新增对外能力请挂到 __game，别改成全局变量。                       │
 * │ 4. 单位约定：轨道半径 1 单位 ≈ 1/26 AU；恒星视觉半径 Rg=size*2.1；│
 * │ 真实科学值只存在于 STAR_TYPES 的 tempK/radiusSol/massSol/lumSol。 │
 * │ 5. ★ 片段顺序不许重排：ORDER 顺序 = 顶层代码的执行顺序。          │
 * │ 加片段要同时登记两处：build.mjs 的 ORDER 清单、                   │
 * │ verify.mjs [0] 节的片段数断言。                                   │
 * │ 6. ★ 加一类对象 → 先建一张注册表（makeRegistry，15-registry.js）  │
 * │ 表序 = 判定优先级 = 展示顺序；缺字段 / 重复 id / 越界数值由 boot  │
 * │ 统一 console.error（verify 会因此变红）。新表自动进体检、自动出   │
 * │ 现在 __game.registries() 里 —— 别另抄一份索引，也别列第二份清单。 │
 * │ 7. ★ 新增交互 → 改状态机表（makeMachine，25-fsm.js），不在回调里  │
 * │ 手写分支。表里没写的转移一律被拒并记数（__game.fsm().illegal）；  │
 * │ G 字段与 DOM 的类都只是机器状态的投影 —— 赋值只许出现在副作用函   │
 * │ 数（applyXxx）里，别处不许再直接改。                              │
 * │ 8. ★ 评估路径零 RNG：评分 / 选址 / 物资账 / 任何派生世界事实     │
 * │ （摇篮评分、发源地选举、蕴藏与可采两本账）只许读已生成的字段做    │
 * │ 算术，一次 rng() 都不许抽 —— 抽了就整体错位（不变量 1）。         │
 * │ 换恒星后重算 = 重新跑同一条纯函数，因此「世界事实」永远可复算；   │
 * │ 抽查：refound 往返（verify [18]）、账本往返（verify [19]）。      │
 * │ 9. ★ 物资账（v0.9）：构成出现新标签 = 同时补配方与可及档          │
 * │ （verify [19] 的 15 星型扫描会抓漏配）；「蕴藏」按行星质量守恒    │
 * │ （构成整数和 100 × 配方归一化和 1，两层「恰好」），「可采 ≤ 蕴藏」│
 * │ 且随工程等级单调不减 —— 取率表 SITE_RATES 是唯一可调的工程参数   │
 * │ （28-materials.js），升级只许追加档位、不许回改已发布的取率。     │
 * │ 10. ★ 聚焦镜头（v0.10）：三档距离只许在 applyCamera 一处分档；    │
 * │ 聚焦档放宽的 orbit.minR 退出时必须恢复 16（不泄漏到全景档）；     │
 * │ 距地表读数是推导量，不另存状态（HUD 只投影它）。                   │
 * │ 11. ★ 地形生成器（v0.11）：固态行星的表面不许画出来 —— 必须       │
 * │ 先算高程场（42-terrain.js），再由「高度 + 纬度 + 物理」调色；     │
 * │ 地表因此是**推导物**，贴图与凹凸图读同一份高程（天然对齐）。     │
 * │ ★ 零 RNG —— 噪声是「种子 × 坐标」的哈希，**不碰主随机流**，     │
 * │ 所以改地形算法不会让星系错位（这是不变量 1 唯一的豁免口）。      │
 * │ ★ 全景档 TEX_LO、聚焦档升级 TEX_HI 并缓存：贴图分辨率也分级。    │
 * └───────────────────────────────────────────────────────────────────┘
 *
 * ── 版本要点（细节见 README）──────────────────────────────────────────
 *    v0.11.0 地形生成器：固态行星的表面由**高程场**构建（3D 噪声 + 陨击坑 +
 *            河网 → 高度分带调色 + 同一份高程导出凹凸图），全景 / 聚焦两级分
 *            辨率；聚焦态不再画选中标记
 *    v0.10.0 聚焦镜头：相机第三态 focus —— 双击行星贴近（行星占画面约 2/3）
 *            + 操作精度提高一档（灵敏度 ×0.32）+ 顶部聚焦 HUD（距地表读数）
 *    v0.9.0  物资系统：14 大类元素制家底（9 现役 + 5 待命）+ 自造单位
 *            「单位物资」（1 = 10²¹ kg）+ 蕴藏 / 可采两本账（取率随工程）
 *            + 右侧「资源」页（面板第三页）+ 物资表注册表（第五张表）
 *    v0.8.0  物种与文明：人类物种库 + 摇篮评分选址（发源地 = 世界事实）
 *            + 右侧「行星 / 文明」标签页（第四台机器）+ 发源地信标环
 *    v0.7.0  源码拆分为 src/ 13 片段 + 拼装器 build.mjs（本文件成生成物）
 *            + 两个原语：对象注册表（15-registry）/ 状态机（25-fsm）
 *    v0.6.1  指导书栏目化 13 栏 + 三张内联 SVG 科普插图 + 书页固定高度
 *    v0.6.0  行星篇：计算贴图 / 16 型行星库 / 轨道优化 / 物理量全算出
 *    v0.5.x  恒星取广义：15 型星体库 + 游戏内指导书 + 黑白硬边 UI
 * ===================================================================== */
(function () {
"use strict";

/* ================= 基础工具 ================= */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/* 主随机流 + 抽数计数器。
 * 计数器是「确定性守恒」的锚点：贴图 / 世界生成每抽一次就 +1，所以只要
 * 抽到星型时的累计抽数不变，就证明此前没有任何东西多抽或少抽。
 * scripts/roll-check.mjs 静态复算出同一个数，verify.mjs 断言浏览器里的实测值
 * —— 两边对不上就说明有贴图函数增删了 rng 调用，必须重新校准星型权重。 */
var _rngCore = mulberry32(20261014);
var rngDraws = 0;
function rng() { rngDraws++; return _rngCore(); }
function rand(a, b) { return a + rng() * (b - a); }
/* 恒星专章独立随机流（种子与主流行不同）：新增视觉随机一律走这里，
 * 不动主序列，保证星系名 / 行星布局 / 小行星带逐一稳定 */
var srng = mulberry32(777001);
function srand(a, b) { return a + srng() * (b - a); }
function irand(a, b) { return Math.floor(rand(a, b + 1)); }
function pick(arr) { return arr[Math.floor(rng() * arr.length)]; }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function roman(n) {
  var m = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];
  return m[n - 1] || String(n);
}
function weightedPick(list) {
  var total = 0, i;
  for (i = 0; i < list.length; i++) total += list[i].w;
  var r = rng() * total;
  weightedPick.lastR = r / total;   // 原始抽值（0~1）：调试 / 确定性回归断言用
  for (i = 0; i < list.length; i++) {
    r -= list[i].w;
    if (r <= 0) return list[i];
  }
  return list[list.length - 1];
}

/* ---- 绘制随机流（画布贴图专用） ----
 * 默认就是主序列，所以 buildTextures 里的全局贴图与从前**逐抽一致**（rngDraws 不变）。
 * 但行星贴图会被 withSeed 切到「本行星专属流」：于是行星表面的绘制细节
 * （斑块数量、裂缝走向、冰盖范围……）可以任意增删，而**不再扰动主序列**
 * ——星系名 / 恒星 / 轨道布局因此不会因为改了贴图算法而漂移。
 * 规则：画布绘制一律用 drand / dpick / drng；只有世界生成（genXxx）才用 rng/rand。 */
var _drawRng = rng;
function drng() { return _drawRng(); }
function drand(a, b) { return a + _drawRng() * (b - a); }
function dpick(arr) { return arr[Math.floor(_drawRng() * arr.length)]; }
function withSeed(seed, fn) {
  var saved = _drawRng;
  _drawRng = mulberry32(seed | 0);
  try { return fn(); } finally { _drawRng = saved; }
}
/* 由种子派生第二个独立流（结构判定：行星环 / 云层……与表面绘制互不干扰） */
function seedStream(seed, salt) { return mulberry32((seed ^ salt) | 0); }

/* ================= 对象类型注册表（v0.7 新增） ================= */

/* 「表」是本项目的骨架：恒星 15 型 / 行星 16 型，往后还有舰船 · 建筑 · 资源 ·
 * 科技 · 事件…… 每一类都会长成「一张**有顺序**的表 + 一个按 id 的索引」。
 * 与其每加一类就手抄一遍索引 / 查重 / 兜底，不如把这件事做成一个原语，
 * 让每张表自动获得同一套保证：
 *
 *   ① 结构问题当场记录：重复 id · 缺必填字段 · 键为空
 *   ② 顺序即语义：表序 = 判定优先级（first() 取第一个命中）= 展示顺序
 *   ③ 统一查询面：get / has / all / first / where / describe / audit
 *   ④ 统一审计面：登记在册（Registries），boot 时体检一遍；__game.registries()
 *      交给 verify 断言「所有表体检为空」—— 新增一类对象时**自动**进入审计
 *
 * ★ 为什么是「记录问题」而不是「抛异常」：这些表在**加载期**构建，抛出去就是
 *   整页白屏（连 __game 都没有，无从排查）。所以把问题攒进 problems、由 boot
 *   用 console.error 打出来 —— verify 的「全程零 console error」会把任何一条
 *   问题变成红灯。既有硬约束，又不至于把页面搞死。
 *
 * 用法（现成的两组例子见 20-data.js）：
 *   var FooTypes = makeRegistry("Foo 类型", {
 *     required: ["id", "name", "hp"],          // 缺一即报
 *     checks: [function (list) { ... }]        // 该族自己的语义体检
 *   }).addAll(FOO_LITERAL);
 */
var Registries = [];              /* 登记在册的全部注册表（boot 时统一体检） */

function makeRegistry(kind, opts) {
  opts = opts || {};
  var required = opts.required || ["id", "name"];
  var key = opts.key || "id";
  var checks = opts.checks || [];
  var list = [], byId = {}, problems = [];

  function structural(entry, idx) {
    if (!entry || typeof entry !== "object") {
      problems.push(kind + "[" + idx + "] 不是对象");
      return;
    }
    var id = entry[key];
    if (id === undefined || id === null || id === "") {
      problems.push(kind + "[" + idx + "] 的 " + key + " 为空");
      return;
    }
    for (var i = 0; i < required.length; i++) {
      var f = required[i];
      if (entry[f] === undefined || entry[f] === null || entry[f] === "") {
        problems.push(kind + "「" + id + "」缺必填字段：" + f);
      }
    }
    if (Object.prototype.hasOwnProperty.call(byId, id)) {
      /* 重复的**丢弃**：宁可少一条，也不要静默覆盖（后期最贵的 bug 之一） */
      problems.push(kind + " 出现重复 " + key + "：「" + id + "」被忽略，前一条生效");
      return;
    }
    byId[id] = entry;
    list.push(entry);
  }

  var reg = {
    kind: kind,
    list: list,
    byId: byId,
    problems: problems,
    add: function (entry) { structural(entry, list.length); return reg; },
    addAll: function (arr) { arr.forEach(function (e) { structural(e, list.length); }); return reg; },
    size: function () { return list.length; },
    has: function (id) { return Object.prototype.hasOwnProperty.call(byId, id); },
    get: function (id) { return byId[id] || null; },
    all: function () { return list; },
    /* 表序扫描：第一个 pred 为真的胜出 —— 判定优先级就写在表的顺序里 */
    first: function (pred) {
      for (var i = 0; i < list.length; i++) if (pred(list[i])) return list[i];
      return null;
    },
    where: function (pred) { return list.filter(pred); },
    describe: function () {
      return kind + " ×" + list.length + "：" + list.map(function (t) { return t[key]; }).join(" / ");
    },
    /* 全量体检：结构问题 + 该族的语义体检（每次重算，别缓存） */
    audit: function () {
      var out = problems.slice();
      for (var i = 0; i < checks.length; i++) out = out.concat(checks[i](list) || []);
      return out;
    },
    /* 交给 verify：干净的结构快照（不暴露原始对象，避免测试改了游戏数据） */
    snapshot: function () {
      return list.map(function (t) { return { id: t[key], name: t.name }; });
    }
  };
  Registries.push(reg);
  return reg;
}

/* boot 时跑一遍：任何一条问题都通过 console.error 出声（verify 会因此变红） */
function auditRegistries() {
  var all = [];
  Registries.forEach(function (r) { all = all.concat(r.audit()); });
  all.forEach(function (msg) { console.error("[注册表体检] " + msg); });
  return all;
}

/* ---- 共性体检件（各表按需组装，避免每张表重写一遍同样的检查） ---- */
var RegChecks = {
  /* 必须是合法的 0xRRGGBB 数字色（颜色是数据，最终由 cssOf() 转 CSS） */
  color: function (field) {
    return function (list) {
      var bad = [];
      list.forEach(function (t) {
        var c = t[field || "color"];
        if (typeof c !== "number" || c < 0 || c > 0xffffff || (c | 0) !== c) {
          bad.push("「" + t.id + "」的 " + (field || "color") + " 不是合法色值：" + c);
        }
      });
      return bad;
    };
  },
  /* 数值字段必须有限且落在区间内 */
  range: function (field, lo, hi) {
    return function (list) {
      var bad = [];
      list.forEach(function (t) {
        var v = t[field];
        if (typeof v !== "number" || !isFinite(v) || v < lo || v > hi) {
          bad.push("「" + t.id + "」的 " + field + " = " + v + " 越界（应在 [" + lo + ", " + hi + "]）");
        }
      });
      return bad;
    };
  },
  /* 枚举字段必须取自白名单 */
  oneOf: function (field, allowed) {
    return function (list) {
      var bad = [];
      list.forEach(function (t) {
        if (allowed.indexOf(t[field]) < 0) {
          bad.push("「" + t.id + "」的 " + field + " = " + t[field] + " 不在允许集合内");
        }
      });
      return bad;
    };
  }
};

/* ---- 自检：证明体检器不是摆设 ----
 * 一个坏了却没人发现的守卫等于没有。verify 会调它，断言**恰好 3 条**问题、
 * 且三类问题各自出现。探针用完从册上摘掉，不留残余。 */
function registrySelfTest() {
  var probe = makeRegistry("自检探针", { required: ["id", "name"] });
  probe.add({ id: "ok", name: "正常条目" });        /* 好条目：必须**不**出声 */
  probe.add({ id: "dup", name: "先来的" });
  probe.add({ id: "dup", name: "后来的" });        /* ① 重复 id：后到的丢弃、前一条生效 */
  probe.add({ id: "noName" });                    /* ② 缺必填字段 name */
  probe.add({ name: "无 id" });                   /* ③ 连键都没有 —— 只报「id 为空」而**不**再
                                                   *    级联报「缺 name」：一个根因一条消息 */
  var found = probe.audit();                       /* 期望恰好 3 条，不是 4 条 */
  Registries.pop();
  return found;
}
/* ================= 静态数据 ================= */
/* 恒星光谱型（科学题材·v0.5 扩容至完整版图）：
 *   spec = 光谱分类 / tempK = 表面温度 / radiusSol·massSol·lumSol = 与太阳的比值
 *   —— 全部取值落在对应类型的真实科学区间内（见「恒星指导书」）
 *   klass = 类别（驱动视觉与面板）：ms 主序 / giant 巨星 / supergiant 超巨星 /
 *           bd 褐矮星 / wd 白矮星 / ns 中子星 / bh 黑洞
 *   w    = 抽取权重（近似真实统计：M 红矮星最多；O / 中子星 / 黑洞极稀有）
 *   size = 游戏内视觉尺度（风格化，非真实比例）；mat = 表面与活动性参数
 *     ├ noise 表面颗粒尺度   ├ spot 星斑强度     └ flareRate 耀斑频率倍率
 *   ⚠ 数组顺序与权重经 scripts/roll-check.mjs 复刻校准：抽值 0.374455 必须命中 M5V，
 *     否则「薄曙」会变型 / 行星布局漂移（贴图与抽样序列见文件头）。 */
var STAR_TYPES = [
  { id: "M", spec: "M5V", name: "红矮星", klass: "ms", color: 0xff8a5c, size: 1.5, w: 60,
    tempK: 3050, radiusSol: 0.17, massSol: 0.16, lumSol: 0.0015,
    mat: { noise: 3.3, spot: 0.95, flareRate: 1.7, act: "高（耀星型）" } },
  { id: "K", spec: "K2V", name: "橙矮星", klass: "ms", color: 0xffb466, size: 1.8, w: 10,
    tempK: 5000, radiusSol: 0.80, massSol: 0.82, lumSol: 0.32,
    mat: { noise: 3.0, spot: 0.6, flareRate: 1.05, act: "中" } },
  { id: "G", spec: "G2V", name: "黄矮星", klass: "ms", color: 0xffd27a, size: 2.1, w: 5,
    tempK: 5780, radiusSol: 1.0, massSol: 1.0, lumSol: 1.0,
    mat: { noise: 2.8, spot: 0.45, flareRate: 0.8, act: "中" } },
  { id: "F", spec: "F5V", name: "黄白色主序星", klass: "ms", color: 0xf8f0d0, size: 2.3, w: 2.5,
    tempK: 6500, radiusSol: 1.3, massSol: 1.35, lumSol: 2.5,
    mat: { noise: 2.6, spot: 0.3, flareRate: 0.65, act: "中低" } },
  { id: "A", spec: "A5V", name: "白色主序星", klass: "ms", color: 0xe8eeff, size: 2.5, w: 1,
    tempK: 8400, radiusSol: 1.7, massSol: 1.9, lumSol: 13,
    mat: { noise: 2.4, spot: 0.18, flareRate: 0.5, act: "低" } },
  { id: "B", spec: "B5V", name: "蓝白主序星", klass: "ms", color: 0xa8c4ff, size: 2.9, w: 0.3,
    tempK: 15500, radiusSol: 3.9, massSol: 5.5, lumSol: 500,
    mat: { noise: 2.2, spot: 0.1, flareRate: 0.4, act: "低（强星风）" } },
  { id: "O", spec: "O5V", name: "蓝色主序星", klass: "ms", color: 0x9bb0ff, size: 3.3, w: 0.03,
    tempK: 40000, radiusSol: 11, massSol: 32, lumSol: 320000,
    mat: { noise: 2.0, spot: 0.06, flareRate: 0.35, act: "极强星风" } },
  { id: "RG", spec: "M0III", name: "红巨星", klass: "giant", color: 0xff9a55, size: 4.1, w: 2,
    tempK: 3850, radiusSol: 55, massSol: 1.3, lumSol: 600,
    mat: { noise: 3.6, spot: 0.7, flareRate: 0.4, act: "低（脉动）" } },
  { id: "RSG", spec: "M2Iab", name: "红超巨星", klass: "supergiant", color: 0xff7a4a, size: 5.4, w: 0.12,
    tempK: 3550, radiusSol: 800, massSol: 16, lumSol: 120000,
    mat: { noise: 3.8, spot: 0.75, flareRate: 0.35, act: "低（强对流）" } },
  { id: "L", spec: "L5", name: "褐矮星（L 型）", klass: "bd", color: 0xd85f2e, size: 0.95, w: 1.2,
    tempK: 1700, radiusSol: 0.10, massSol: 0.055, lumSol: 0.00005,
    mat: { noise: 4.2, spot: 1.0, flareRate: 0.5, act: "极低（近红外）" } },
  { id: "T", spec: "T5", name: "褐矮星（T 型）", klass: "bd", color: 0x9a4a66, size: 0.85, w: 0.5,
    tempK: 1000, radiusSol: 0.095, massSol: 0.03, lumSol: 0.0000032,
    mat: { noise: 4.5, spot: 0.9, flareRate: 0.2, act: "极低（甲烷吸收）" } },
  { id: "Y", spec: "Y1", name: "褐矮星（Y 型）", klass: "bd", color: 0x6a5578, size: 0.75, w: 0.15,
    tempK: 400, radiusSol: 0.085, massSol: 0.015, lumSol: 0.0000001,
    mat: { noise: 4.8, spot: 0.8, flareRate: 0.1, act: "近零（红外）" } },
  { id: "WD", spec: "DA2", name: "白矮星", klass: "wd", color: 0xdceaff, size: 1.1, w: 2,
    tempK: 25200, radiusSol: 0.0126, massSol: 0.62, lumSol: 0.056,
    mat: { noise: 1.7, spot: 0.05, flareRate: 0.15, act: "低（宁静）" } },
  { id: "NS", spec: "PSR", name: "中子星", klass: "ns", color: 0xcfe6ff, size: 0.55, w: 0.06,
    tempK: 600000, radiusSol: 0.0000172, massSol: 1.4, lumSol: 0.03,
    mat: { noise: 1.2, spot: 0, flareRate: 0, act: "强磁场 · 高速自转" } },
  { id: "BH", spec: "BH", name: "黑洞", klass: "bh", color: 0x0a0a12, size: 1.35, w: 0.03,
    tempK: 0, radiusSol: 0.0000424, massSol: 10, lumSol: 0,
    mat: { noise: 1, spot: 0, flareRate: 0, act: "无（事件视界）" } }
];

/* 星型表 → 注册表（v0.7）：结构查重 + 语义体检在 boot 时跑，见 src/15-registry.js。
 * ★ 注册必须紧跟表定义：权重（w）与表序被 roll-check 与本文件后面的抽样复刻共同依赖。 */
var StarTypes = makeRegistry("恒星类型", {
  required: ["id", "spec", "name", "klass", "color", "size", "w", "tempK", "radiusSol", "massSol", "lumSol", "mat"],
  checks: [
    RegChecks.color("color"),
    RegChecks.range("tempK", 0, 1e8),
    RegChecks.range("radiusSol", 1e-7, 2000),
    RegChecks.range("massSol", 1e-6, 200),
    RegChecks.range("lumSol", 0, 1e7),
    RegChecks.range("w", 0, 1e6),
    RegChecks.range("size", 0.1, 50),
    RegChecks.oneOf("klass", ["ms", "giant", "supergiant", "bd", "wd", "ns", "bh"])
  ]
}).addAll(STAR_TYPES);
/* ================= 行星物理（所有数值由公式算出，不硬编码） =================
 * 因果链（这也是「行星」一节要写进指导书的东西）：
 *   ① 恒星属性 (T★ R★ L★ M★) + 轨道半长轴 a
 *        → 平衡温度 T_eq = T★·(1-A)^¼·√(R★/2a)     ← 表面温度取决于恒星与距离
 *        → 恒星辐照 S = L★/a²
 *   ② 半径 R →（质量-半径关系 M(R)）→ 质量 M
 *        → 表面重力 g = GM/R²   → 逃逸速度 v = √(2GM/R)
 *   ③ a + M★ →（开普勒第三定律 P = 2π√(a³/GM)）→ 公转周期 P
 *        → 轨道速度 v = 2πa/P
 *   ④ 气候带（由 T_eq） + 挥发分 / 金属丰度 / 体积 → 行星类型
 *        → 该类型的反照率与温室系数回代，得出真实表面温度 T_surf
 * 类型判定用「基准反照率 0.3、无温室」的平衡温度 T_eq0 作气候带判据，
 * 再用各型自身的反照率与温室系数算真实 T_surf —— 金星与地球的差别正在于此。 */

var AU_KM = 1.495978707e8;      /* 1 AU = ? km */
var R_SOL_AU = 0.00465047;      /* 1 R☉ = ? AU（平衡温度换算用） */
var VIS_PER_AU = 700;           /* 本作换算：1 AU = 700 场景单位（轨道视觉半径 = au×700） */

function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
/* 单次均匀抽值 → 三角分布（峰在 0.5）：给「中间值最常见」的自然量用（半径等） */
function triU(u) { return u < 0.5 ? Math.sqrt(u * 0.5) : 1 - Math.sqrt((1 - u) * 0.5); }
/* 平衡温度：恒星给多少辐照、行星反射多少 → 无大气时的温度 */
function eqTemp(star, au, albedo) {
  return star.tempK * Math.sqrt(star.radiusSol / (2 * (au / R_SOL_AU))) * Math.pow(1 - albedo, 0.25);
}
/* 恒星辐照（地球 = 1）：S = L★/a² */
function insolation(star, au) { return star.lumSol / (au * au); }
/* 开普勒第三定律：P² = 4π²a³/(G(M★+m)) —— 太阳质量 / 天文单位为量纲即得「年」 */
function keplerDays(au, starMassSol, planetMassEarth) {
  var ms = starMassSol + (planetMassEarth || 0) / 332946;   /* 行星质量一并计入 */
  return 365.25 * Math.sqrt(au * au * au / ms);
}
/* 轨道速度 v = 2πa/P（km/s） */
function orbitKms(au, days) { return 2 * Math.PI * au * AU_KM / (days * 86400); }
/* ---- 构成模型 ----
 * 岩质行星按三个储库分成质量占比：铁镍核 / 硅酸盐幔 / 挥发分。
 * 铁镍占比是唯一的一阶自由量（水星 ≈ 0.63、地球 ≈ 0.32、月球 ≈ 0.03），
 * 由 metal 抽值线性映射而来。 */
var IRON_EARTH = 0.32;                                      /* 地球的铁镍质量占比（基准） */
function ironFrac(metal) { return clamp(0.06 + 0.86 * metal, 0.03, 0.70); }
/* 挥发分**质量**占比：由 water 抽值给出，且只在「有大气顶着」时才留得住。
 * ★ 这一项与温度无关 —— 它是形成时留下的总量，不是此刻的相态（相态见 volatileState）。
 * 下限 0.008：地球的水（含地幔水）只占质量 0.02%，但那是「表面水」的口径；
 * 按「总储库」口径给 1% 才不至于让所有行星在这一格都显示 0%。 */
function volMass(water, atmoP) {
  var v = clamp((water - 0.45) * 0.75, 0, 0.40);            /* 只有明显富水的抽值才算挥发分大户 */
  return Math.max(v * (atmoP === "无" ? 0.12 : 1), 0.008);  /* 无大气 = 被恒星风剥离，只剩残渣 */
}
/* 挥发分的**相态**：只由表面温度决定 —— 同一个水分子，冷是冰、热是汽。
 * 900 K 以上返回 null：水分子被紫外线分解、氢逃逸，储库名存实亡。 */
function volatileState(T) {
  if (T < 200) return "水冰";
  if (T < 273) return "冰水";
  if (T <= 373) return "液态水";
  if (T < 900) return "水汽";
  return null;
}

/* 质量-半径关系（岩质，Valencia 型）：R ≤ 1.5 R⊕ 时 M = R^3.57（硅酸盐自压缩）；
 * 更大的「超级地球」压缩变缓 → M = 5.06·(R/1.5)²（5.06 = 1.5^3.57）。
 * 基准式以地球成分为标定点（R=1 → M=1），再乘**体积加权混合密度比**修正成分偏离：
 *   1/ρ = Σ(xᵢ/ρᵢ)  —— 铁 7.87 / 硅酸盐 3.3 / 水冰 1.0 g/cm³（未压缩材料密度）
 * 于是铁核大的更沉（水星型 ≈ +29%）、富水的更轻（海洋行星 ≈ −38%），两端夹住防外推发散。 */
var RHO_IRON = 7.87, RHO_SIL = 3.3, RHO_VOL = 1.0;
/* 地球成分的**比容**（1/ρ）—— 密度比的比较基准 */
var RHO_REF_INV = IRON_EARTH / RHO_IRON + (1 - IRON_EARTH) / RHO_SIL;
/* 岩质行星的三储库质量占比 —— ★ 唯一算法：
 * 质量（rockyMass）与面板/指导书的「构成」显示都从这里取，两处不可能各算一套。 */
function rockyParts(metal, water, atmoP) {
  var iron = ironFrac(metal);
  var vol = volMass(water, atmoP);
  var sil = 1 - iron - vol;
  if (sil < 0.05) { sil = 0.05; iron = Math.max(0.03, 1 - sil - vol); }   /* 极端抽值兜底 */
  return { iron: iron, sil: sil, vol: vol };
}
/* ★ 入参就是要展示的那一份分量（不是重新用 iron/vol 推 sil）——
 * 否则 rockyParts 的兜底修正只影响显示、不影响质量，两处会悄悄对不上。 */
function mixDensRatio(q) {
  return RHO_REF_INV / (q.iron / RHO_IRON + q.sil / RHO_SIL + q.vol / RHO_VOL);
}
function rockyMass(rE, metal, water, atmoP) {
  var base = rE <= 1.5 ? Math.pow(rE, 3.57) : 5.06 * Math.pow(rE / 1.5, 2);
  return base * clamp(mixDensRatio(rockyParts(metal, water, atmoP)), 0.60, 1.45);
}
/* 气态巨行星：半径对质量极不敏感（木星 / 土星同量级）→ 由质量反推半径。
 * 指数取 0.14：拿木星 318 M⊕/11.21 R⊕ 与土星 95 M⊕/9.45 R⊕ 两点定出
 * （0.05 那种近似值会把土星级压成 10.6 R⊕，密度掉到 0.45 —— 比土星实际稀一半）。 */
function giantRadius(mE) { return 11.21 * Math.pow(mE / 317.8, 0.14); }
/* 冰巨星：天王星 4.0 / 海王星 3.9 R⊕ → R ≈ 3.9·(M/17)^0.12 */
function iceGiantRadius(mE) { return 3.9 * Math.pow(mE / 17, 0.12); }
/* 表面重力 g = GM/R²（m/s²；地球 9.807） */
function gravG(mE, rE) { return 9.807 * mE / (rE * rE); }
/* 逃逸速度 v_esc = √(2GM/R)（km/s；地球 11.19） */
function escKms(mE, rE) { return 11.186 * Math.sqrt(mE / rE); }

/* ---- 构成：把「主要成分」算成质量占比 ----
 * 这是面板「构成」行与指导书的唯一数据源。两个分支都只读已有的物理量，
 * 不存任何写死的文案，因此换恒星（温度变）→ 挥发分相态跟着变。
 *   岩质：铁镍核 / 硅酸盐幔 / 挥发分（相态由表面温度定）
 *   巨行星：H₂·He 包层 / 冰 / 岩石核（包层占比随总质量上升而下降 ——
 *           木星重元素只占 ~4%，土星反而 ~10%，本条即这一观测事实的一阶拟合）
 * 返回值 [[名称, 整数百分比], …] 按占比降序，整数和恰好 100（最大项吸收舍入误差）。 */
function buildComposition(c) {
  var parts;
  if (c.kind === "giant") {
    if (c.typeId === "icegiant") {
      var hhe = clamp(9 - 3 * (c.mE / 17), 2, 9);
      var rock = clamp(13 + 3 * (c.mE / 17), 13, 18);
      parts = [["水氨甲烷幔", 100 - hhe - rock], ["岩石核", rock], ["H₂·He", hhe]];
    } else {
      /* 重元素占比随包层质量上升而下降（木星 ~4% / 土星 ~10%）→ 包层 = 其余 */
      var heavy = clamp(30 / (1 + c.mE / 50), 3, 28);
      parts = [["H₂·He", 100 - heavy], ["水氨冰", heavy * 0.55], ["岩石核", heavy * 0.45]];
    }
  } else {
    var q = rockyParts(c.metal, c.water, c.atmoP);
    var vn = volatileState(c.tempSurf);
    /* 无大气者挥发分已被剥离，标签直接写明原因（否则「水汽」会让人以为它还留着水） */
    var label = vn === null ? "挥发分（已蒸干）"
      : (c.atmoP === "无" && c.water < 0.55 ? "挥发分（被剥离）" : vn);
    parts = [[label, q.vol * 100], ["硅酸盐幔", q.sil * 100], ["铁镍核", q.iron * 100]];
  }
  parts.sort(function (a, b) { return b[1] - a[1]; });
  var pct = parts.map(function (a) { return Math.round(a[1]); });
  pct[0] += 100 - pct.reduce(function (a, b) { return a + b; }, 0);
  return parts.map(function (a, i) { return [a[0], pct[i]]; });
}

/* ---- 行星类型库（16 型）----
 * 判定字段（resolvePlanetType 按表序扫描，先命中者胜；条件文本由这些字段实时生成，
 * 所以改数据 = 指导书与面板同步，不会脱节）：
 *   kind   rock 岩质 / giant 巨行星
 *   t0/t1  T_eq0 气候带区间 [下界, 上界) K —— T_eq0 = 基准反照率 0.3 的平衡温度
 *   water  挥发分丰度区间（省略 = 不限）    metal 金属丰度下限
 *   atmoMin 大气厚度下限                    rMax 半径上限 R⊕
 *   carbon 需「碳抽签」命中
 * 物理字段：albedo 真实反照率 · green 温室系数（T_surf = T_eq·green）
 *   rRange 岩质半径区间 R⊕ / massRange 巨行星质量区间 M⊕ · dens 平均密度 g/cm³
 * 展示字段：atmo 大气成分 · atmoP 气压档 · surface 表面成分 · color 色点
 *   tex 贴图模式 · pal 表面调色板（[底色, 低, 中, 高] 由暗到亮） */
var PLANET_TYPES = [
  { id: "carbon", name: "碳行星", kind: "rock", t0: 0, t1: 9e9, carbon: true,
    rRange: [0.5, 2.2], albedo: 0.09, green: 1.10, dens: 4.2,
    atmo: "CO · CH₄（稀薄）", atmoP: "稀薄", surface: "碳化硅 · 石墨地幔（碳 > 50%）",
    color: 0x3a3740, tex: "rock", pal: ["#1e1c22", "#2b2830", "#403c48", "#565064"] },

  { id: "iron", name: "铁行星", kind: "rock", t0: 0, t1: 9e9, water: [0, 0.08], metal: 0.66,
    rRange: [0.3, 1.1], albedo: 0.12, green: 1.00, dens: 7.9,
    atmo: "无", atmoP: "无", surface: "铁镍核裸露 · 硅酸盐壳被剥离",
    color: 0x9a9490, tex: "metal", pal: ["#5a5450", "#7a7068", "#9a9088", "#c0b6aa"] },

  { id: "dwarf", name: "矮行星", kind: "rock", t0: 0, t1: 9e9, rMax: 0.45,
    rRange: [0.12, 0.45], albedo: 0.35, green: 1.00, dens: 2.6,
    atmo: "无（或极稀薄）", atmoP: "无", surface: "岩冰混合 · 未能成球",
    color: 0xa8a49c, tex: "rock", pal: ["#6a6660", "#8a8880", "#a8a49c", "#c4bfb4"] },

  { id: "lava", name: "熔岩行星", kind: "rock", t0: 1000, t1: 9e9,
    rRange: [0.4, 2.4], albedo: 0.10, green: 1.25, dens: 5.6,
    atmo: "SO₂ · 岩石蒸气", atmoP: "稀薄", surface: "硅酸盐熔岩海 · 昼夜翻涌",
    color: 0xd4502a, tex: "lava", pal: ["#180d0a", "#2e1a13", "#ff7a2a", "#ffc06a"] },

  { id: "greenhouse", name: "温室行星", kind: "rock", t0: 265, t1: 9e9, atmoMin: 0.60,
    rRange: [0.5, 2.4], albedo: 0.72, green: 2.95, dens: 5.2,
    atmo: "CO₂（浓密 · 数十至百 bar）", atmoP: "浓密", surface: "玄武岩平原 · 硫酸云顶",
    color: 0xd9b06a, tex: "venus", pal: ["#a8823f", "#c9a35f", "#e0c48a", "#f4e2bc"] },

  { id: "hotrock", name: "炽岩行星", kind: "rock", t0: 470, t1: 1000,
    rRange: [0.4, 2.2], albedo: 0.12, green: 1.00, dens: 5.0,
    atmo: "无（被恒星风剥离）", atmoP: "无", surface: "裸露玄武岩 · 撞击坑密布",
    color: 0xa8604a, tex: "rock", pal: ["#4a2a20", "#6e3c2c", "#8f5540", "#b8705a"] },

  { id: "barren", name: "荒芜行星", kind: "rock", t0: 88, t1: 470, atmoMax: 0.18, water: [0, 0.15],
    rRange: [0.3, 1.8], albedo: 0.14, green: 1.00, dens: 4.0,
    atmo: "无（真空）", atmoP: "无", surface: "裸岩 · 厚风化层 · 撞击坑",
    color: 0x8c8a84, tex: "rock", pal: ["#48463f", "#66645d", "#8c8a84", "#aaa69c"] },

  { id: "ocean", name: "海洋行星", kind: "rock", t0: 232, t1: 326, water: [0.62, 9],
    rRange: [0.7, 2.4], albedo: 0.18, green: 1.10, dens: 4.6,
    atmo: "N₂ · H₂O（浓密 · 云量高）", atmoP: "浓密", surface: "全球海洋（覆盖 > 90%）",
    color: 0x3f7fbf, tex: "ocean", pal: ["#0f3f66", "#1d5c92", "#2f7fb8", "#5aa0cc"] },

  { id: "terra", name: "类地行星", kind: "rock", t0: 232, t1: 326, water: [0.28, 9],
    rRange: [0.45, 2.0], albedo: 0.30, green: 1.13, dens: 5.5,
    atmo: "N₂ · O₂（约 1 bar）", atmoP: "适中", surface: "硅酸盐大陆 + 液态水海洋",
    color: 0x5a9e6f, tex: "terra", pal: ["#12324f", "#3f7a4a", "#5f9a52", "#8aa860"] },

  { id: "desert", name: "沙漠行星", kind: "rock", t0: 232, t1: 470,
    rRange: [0.4, 2.0], albedo: 0.35, green: 1.05, dens: 5.2,
    atmo: "CO₂（稀薄）", atmoP: "稀薄", surface: "硅酸盐沙丘 · 干涸河床",
    color: 0xc9a35f, tex: "desert", pal: ["#8a6a33", "#b3833f", "#c9a35f", "#e2c894"] },

  { id: "tundra", name: "冻原行星", kind: "rock", t0: 172, t1: 232,
    rRange: [0.4, 2.2], albedo: 0.45, green: 1.05, dens: 5.3,
    atmo: "N₂ · CO₂（稀薄）", atmoP: "稀薄", surface: "冻土 · 季节性冰盖进退",
    color: 0x9fb0b4, tex: "ice", pal: ["#4f5a60", "#75828a", "#9fb0b4", "#ccd8dc"] },

  { id: "ice", name: "冰封行星", kind: "rock", t0: 88, t1: 172,
    rRange: [0.4, 2.2], albedo: 0.62, green: 1.00, dens: 4.9,
    atmo: "N₂ · CH₄（稀薄）", atmoP: "稀薄", surface: "水冰壳（下覆液态海洋）",
    color: 0xcfe4f0, tex: "ice", pal: ["#7f9cae", "#a8c8dc", "#cfe4f0", "#eef7fc"] },

  { id: "cryo", name: "冰冻世界", kind: "rock", t0: 0, t1: 88,
    rRange: [0.3, 1.8], albedo: 0.70, green: 1.00, dens: 2.1,
    atmo: "近乎真空（N₂ 凝华）", atmoP: "无", surface: "N₂ · CH₄ · CO 冰原",
    color: 0xdfe9f5, tex: "cryo", pal: ["#93a2bd", "#b8c6dc", "#dfe9f5", "#ffffff"] },

  { id: "hotjupiter", name: "热木星", kind: "giant", t0: 900, t1: 9e9,
    massRange: [80, 700], albedo: 0.10, green: 1.15, dens: 0.9,
    atmo: "H₂ · He（受热膨胀 · 逃逸中）", atmoP: "浓密", surface: "无固体表面 · 硅酸盐云",
    color: 0xd2703a, tex: "hotjup", pal: ["#7a3016", "#b8501f", "#e08040", "#f4c088"] },

  { id: "gas", name: "气态巨行星", kind: "giant", t0: 170, t1: 900,
    massRange: [50, 450], albedo: 0.34, green: 1.12, dens: 1.3,
    atmo: "H₂ · He（浓密）", atmoP: "浓密", surface: "无固体表面 · 氨云顶",
    color: 0xc9a878, tex: "gas", pal: ["#8a6a44", "#b58a5c", "#c9a878", "#e6d4ac"] },

  { id: "icegiant", name: "冰巨星", kind: "giant", t0: 0, t1: 170,
    massRange: [6, 35], albedo: 0.30, green: 1.05, dens: 1.6,
    atmo: "H₂ · He · CH₄（甲烷致青）", atmoP: "浓密", surface: "无固体表面 · 水氨幔",
    color: 0x7fb6d9, tex: "icegiant", pal: ["#4f88b0", "#6aa6cc", "#93c6e2", "#bce0f0"] }
];
/* 行星类型表 → 注册表（v0.7）：结构查重 + 语义体检见 src/15-registry.js。
 * 表序 = 判定优先级，first() 取第一个命中 —— 顺序写在数组里，不在代码里。 */
var PlanetTypes = makeRegistry("行星类型", {
  required: ["id", "name", "kind", "t0", "t1", "albedo", "green", "dens", "atmo", "atmoP", "surface", "color", "tex", "pal"],
  checks: [
    RegChecks.color("color"),
    RegChecks.range("albedo", 0.001, 1),
    RegChecks.range("green", 1, 10),
    RegChecks.range("dens", 0.01, 30),
    function (list) {
      var bad = [];
      list.forEach(function (t) {
        if (!(t.t1 > t.t0)) bad.push("「" + t.id + "」气候带窗口倒置：[" + t.t0 + ", " + t.t1 + ")");
        if (!t.rRange && !t.massRange) bad.push("「" + t.id + "」既没有 rRange 也没有 massRange");
        if (!t.pal || t.pal.length < 2) bad.push("「" + t.id + "」调色板少于 2 色");
        if (!t.comp) bad.push("「" + t.id + "」缺参考构成（TYPE_COMP 未覆盖该 id）");
      });
      return bad;
    }
  ]
}).addAll(PLANET_TYPES);

/* 按 id 索引（注册表自带；保留这个短别名 —— 全项目几十处引用它） */
var PT_BY_ID = PlanetTypes.byId;

/* 各型的典型内部构成（参考数据，指导书行星库用）。
 * 注意与「某颗行星的构成」区分：这里是类型的标定描述，具体占比由 buildComposition
 * 按该行星自己的金属/挥发分丰度与表面温度现算 —— 面板「构成」行读的是后者。 */
var TYPE_COMP = {
  carbon: "石墨地幔 + 碳化硅壳 · 铁核极小",
  iron: "铁镍核 ≈ 70% · 硅酸盐幔被剥离殆尽",
  dwarf: "岩冰混合 · 未完成分异（无金属核）",
  lava: "硅酸盐熔融幔 + 铁核 · 挥发分已蒸干",
  greenhouse: "硅酸盐幔 + 铁镍核 · CO₂ 大气 < 0.01% 质量",
  hotrock: "玄武岩壳 + 铁核 · 无挥发分储库",
  barren: "硅酸盐岩壳 + 铁镍核 · 挥发分 < 1%",
  ocean: "挥发分 > 25% · 全球水幔覆铁核",
  terra: "硅酸盐幔 + 铁镍核 + 液态水圈",
  desert: "硅酸盐地壳 + 铁核 · 挥发分已逃逸",
  tundra: "岩壳 + 铁核 · 水以冰与冻土封存",
  ice: "水冰壳 + 液态水层 + 岩核",
  cryo: "N₂ · CH₄ 冰壳 + 岩核 · 挥发分凝华",
  hotjupiter: "H₂·He 包层 + 硅酸盐云 · 岩石核",
  gas: "H₂·He 包层 ≈ 90% · 冰与岩石核",
  icegiant: "水·氨·甲烷幔 ≈ 80% + 岩石核"
};
PLANET_TYPES.forEach(function (t) { t.comp = TYPE_COMP[t.id] || ""; });

/* 类型判定：按表序扫描，第一个条件全中的胜出（先特殊、后一般）。
 * 扫描本身交给注册表的 first()（顺序语义在表里，机制在 15-registry.js）。 */
function resolvePlanetType(c) {
  var hit = PlanetTypes.first(function (t) {
    if (t.kind !== c.bulk) return false;
    if (c.teq0 < t.t0 || c.teq0 >= t.t1) return false;
    if (t.water && !(c.water >= t.water[0] && c.water < t.water[1])) return false;
    if (t.metal !== undefined && c.metal < t.metal) return false;
    if (t.atmoMin !== undefined && c.atmo < t.atmoMin) return false;
    if (t.atmoMax !== undefined && c.atmo >= t.atmoMax) return false;
    if (t.rMax !== undefined && c.rE >= t.rMax) return false;
    if (t.carbon && !c.carbon) return false;
    return true;
  });
  return hit || PT_BY_ID.barren;              /* 兜底型：荒芜行星 */
}
/* 条件文本：由判定字段实时生成（指导书「形成条件」列），改数据即同步 */
function typeCond(t) {
  if (t.carbon) return "碳/硅比异常（稀有）";
  if (t.metal !== undefined) return "铁镍丰度 > " + Math.round(t.metal * 100) + "% 且贫挥发分";
  if (t.rMax !== undefined) return "半径 < " + t.rMax + " R⊕（引力未能圆化）";
  var s = "T_eq0 " + t.t0 + "–" + (t.t1 > 1e6 ? "∞" : t.t1) + " K";
  if (t.atmoMin !== undefined && t.atmoMin > 0) s += " · 大气 " + (t.atmoMin > 0.55 ? "浓密" : "存在");
  else if (t.atmoMax !== undefined) s += " · 真空（无大气）";
  else if (t.water) s += t.water[0] >= 0.5 ? " · 富挥发分"
    : (t.water[0] >= 0.15 ? " · 湿润" : " · 贫挥发分");
  return s;
}

/* ---- 构建版本：单一数据源 ----
 * 同时写入 ① 右下角版本戳（#ver）② __game.version。
 * 用途：一眼判断「眼前这页是不是最新构建」——历史上出现过改了代码但浏览器
 * 没刷新、误判「功能没生效」的情况。发版时只改这一行。 */
var VERSION = "0.17.0";

function $(id) { return document.getElementById(id); }
function fmtNum(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
function cssOf(hex) { return "#" + ("000000" + hex.toString(16)).slice(-6); }
var NAME_SYLL = ["开阳", "北斗", "天狼", "参宿", "心月", "青云", "紫微", "太微", "荧惑", "岁星",
  "辰星", "镇星", "轩辕", "毕宿", "角宿", "亢宿", "房宿", "尾宿", "箕斗", "牛郎",
  "织女", "河鼓", "天津", "阁道", "腾蛇", "翼火", "奎木", "娄金", "胃土", "崴海",
  "扶摇", "沧澜", "朔风", "赤霄", "玄墨", "苍梧", "白泽", "麒麟", "蓬莱", "方壶",
  "瀛洲", "岱舆", "员峤", "扶桑", "若木", "归墟", "光年", "薄曙", "长庚", "启明"];

/* ================= 状态机（v0.7 新增） ================= */

/* 为什么要有它：交互逻辑散在事件回调里时，「现在是什么模式」「这个操作在这种模式下
 * 合不合法」只能靠读代码推。对象一多（舰船 · 建造 · 时间控制 · 事件弹窗…），
 * 模式会交叉相乘，于是冒出「点空白时把书关了、同时又取消了行星选中」这类
 * 谁都没设计过的组合。把它们写成**一张表**，问题就从「读代码」变成「查表」。
 *
 * 本作现在有四台小机器，各管一件事（表在文件下半部分）：
 *   FSM_SELECT   none / star / planet    —— 谁被选中（右侧面板跟着它）
 *   FSM_CAMERA   free / follow / focus   —— 相机：全景 / 中距离跟随 / 聚焦贴近（v0.10 起三档）
 *   FSM_OVERLAY  none / guide            —— 覆盖层开合（键盘路由与画布点击的闸门）
 *   FSM_PANEL    planet / res / civ      —— 右侧面板的标签页（文明页只对有文明的行星出现）
 *
 * 规则：
 *   · states[当前状态][事件] = 目标状态，或 { to, on }（to = 目标，on = 副作用）
 *   · 表里没有的转移 = **非法**：拒绝、不改状态、记一笔（__game.fsm().illegal）
 *   · 先落状态、再跑副作用 —— 副作用函数里读得到新状态（applySelect 就靠这个）
 *   · ★ verify 跑一遍完整交互巡览后断言 illegal 恒为 0：
 *     「用户点得出来的组合，全都在设计之内」这件事从此有机器判据
 *
 * ★ 「选择」那台的诚实说明：它的三个状态转移表是同一行（从任何状态都能选别的），
 *   所以它拦不住什么非法转移。它的价值在于把「三者互斥」这条不变量变成**结构** ——
 *   以前靠三处手写赋值（selectPlanet 里补一句 G.selectedStar = false）维持，
 *   现在 G 里的字段是机器状态的投影，不可能各说各话。
 *
 * 副作用函数（applySelect / applyCamera / applyOverlay）分别定义在
 * 70-camera-input.js 与 90-guide.js —— 全部片段同处一个 IIFE，
 * 函数声明会提升，按名字写在这里、在事件期调用即可。
 */
var MODES = [];                  /* 登记在册的状态机（__game.fsm() 一把读） */

function makeMachine(id, spec) {
  var state = spec.initial;
  var arg = null;                /* 最近一次事件的载荷（如「跟随哪颗行星」） */
  var log = [];                  /* 转移日志（环形，最近 24 条；诊断用） */
  var illegal = 0, lastIllegal = "";

  function record(mark, evt, from, to) {
    log.push(mark + " " + evt + "：" + from + " → " + to);
    if (log.length > 24) log.shift();
  }

  var m = {
    id: id,
    get: function () { return state; },
    is: function (s) { return state === s; },
    payload: function () { return arg; },
    /* 发一个事件。true = 发生了合法转移；false = 被拒（状态没动） */
    send: function (evt, payload) {
      var row = spec.states[state] ? spec.states[state][evt] : undefined;
      if (row === undefined) {
        illegal++;
        lastIllegal = evt + "（当时在 " + state + "）";
        record("✗ 非法", evt, state, state);
        return false;
      }
      var from = state;
      var to = typeof row === "string" ? row : row.to;
      arg = payload === undefined ? null : payload;
      state = to;
      record("→", evt, from, to);
      if (typeof row === "object" && row !== null && row.on) row.on(payload);
      return true;
    },
    /* 只读快照（verify / 控制台用） */
    snapshot: function () {
      return {
        id: id, state: state,
        payload: arg && arg.name ? arg.name : null,
        illegal: illegal, lastIllegal: lastIllegal, log: log.slice()
      };
    },
    /* 把非法计数清零（verify 在巡览开始前调一次，结束后断言它还是 0） */
    clearStats: function () { illegal = 0; lastIllegal = ""; log = []; },
    reset: function () { state = spec.initial; arg = null; },        /* 测试用 */
    /* ---- 探针（verify 专用）：证明守卫真会拦，且**不留痕** ----
     * 真发一个事件走完整条 send 通道，然后把状态与全部计数原样还回去 ——
     * 免得「为了证明守卫存在」反而污染了「全程零非法转移」的统计。
     * registrySelfTest 的姊妹：坏了却没人发现的守卫等于没有。 */
    probe: function (evt, payload) {
      var keep = { state: state, arg: arg, illegal: illegal, last: lastIllegal, log: log.slice() };
      var accepted = m.send(evt, payload);
      var out = { accepted: accepted, from: keep.state, to: state, blocked: !accepted && state === keep.state };
      state = keep.state; arg = keep.arg; illegal = keep.illegal; lastIllegal = keep.last; log = keep.log;
      return out;
    }
  };
  MODES.push(m);
  return m;
}

/* ---- 三台机器：全部规则一览（改交互先看这里） ---- */

/* 选择：从任何状态都能选别的；clear 幂等（点空白时无条件调用） */
var ROW_SELECT = {
  selectStar: { to: "star", on: applySelect },
  selectPlanet: { to: "planet", on: applySelect },
  clear: { to: "none", on: applySelect }
};
var FSM_SELECT = makeMachine("选择", {
  initial: "none",
  states: { none: ROW_SELECT, star: ROW_SELECT, planet: ROW_SELECT }
});

/* 相机：v0.10 起三态 —— free 全景 / follow 中距离跟随 / focus 聚焦贴近。
 * 三个事件全态可达（没有表外组合，代价是这台机器同样拦不住非法转移，价值在
 * 「三档距离写在一处」：applyCamera 按状态分档，见 70-camera-input.js）：
 *   enter(p)  聚焦到某行星（双击行星走这条；focus 态再发 = 换目标，幂等）
 *   follow(p) 中距离跟随（Esc / 退出钮从 focus 回落到这一档）
 *   home      回全景（双击空白；幂等） */
var ROW_CAMERA = {
  enter: { to: "focus", on: applyCamera },
  follow: { to: "follow", on: applyCamera },
  home: { to: "free", on: applyCamera }
};
var FSM_CAMERA = makeMachine("相机", {
  initial: "free",
  states: { free: ROW_CAMERA, follow: ROW_CAMERA, focus: ROW_CAMERA }
});

/* 覆盖层：指导书开 / 合（openGuide 幂等：重复打开只是重渲染） */
var FSM_OVERLAY = makeMachine("覆盖层", {
  initial: "none",
  states: {
    none: { openGuide: { to: "guide", on: applyOverlay } },
    guide: { close: { to: "none", on: applyOverlay }, openGuide: { to: "guide", on: applyOverlay } }
  }
});

/* 面板页：行星 / 资源 / 文明 三页（v0.8 两页，v0.9 增资源页）。同 ROW_SELECT 的诚实
 * 说明 —— 各状态行是同一张表，拦不住「非法转移」；它的价值在别处：① 唯一一处改
 * 「哪页在前」的赋值（applyPanelTab 按机器状态刷 DOM）② 页面不可用时由渲染层回落
 * （syncPanelTab 发 showPlanet），「机器 = DOM」这条对账永远成立。可用性守卫在事件源
 * （标签栏只在有行星时出现；文明钮只在发源地出现）。 */
var ROW_PANEL = {
  showPlanet: { to: "planet", on: applyPanelTab },
  showRes: { to: "res", on: applyPanelTab },
  showCiv: { to: "civ", on: applyPanelTab }
};
var FSM_PANEL = makeMachine("面板", {
  initial: "planet",
  states: { planet: ROW_PANEL, res: ROW_PANEL, civ: ROW_PANEL }
});

/* 全部机器的一把快照（__game.fsm()） */
function fsmSnapshot() {
  var out = { illegal: 0, machines: {} };
  MODES.forEach(function (m) {
    var s = m.snapshot();
    out.machines[s.id] = s;
    out.illegal += s.illegal;
  });
  return out;
}
/* ================= 物种（库）与摇篮判定（v0.8 新增） ================= */

/* 「物种」是本作第一张**跨系统**的表：它描述的不是天体，而是「谁在这片星系里诞生」。
 * 第一版只有一种：人类 —— 但表本身按 15-registry.js 的约定登记，加物种 = 加一条数据。
 *
 * 三个概念各归各位：
 *   物种（本文件上半）   一张库表：生存条件 / 权重 / 文明命名 —— 静态数据
 *   摇篮评分（本文件下半） 纯函数：只读行星**已有**字段算出 0–100 分 —— 不抽任何随机数
 *   文明（35-civ.js）    实例：某个物种在某颗行星上的发源地 —— 运行时事实
 *
 * ★ 为什么评分必须是纯函数（本文件最重要的约束）：
 *   发源地是与「星系名 / 行星布局」同级的**世界事实**——刷新一百次也得是同一颗。
 *   评分一旦调用 rng()，它就会随贴图段的任何增删而漂移（确定性守恒，见 README §四）。
 *   所以这里只做算术：输入是温度 / 挥发分 / 气压档 / 重力，输出是分数。
 * ★ 评分口径写在物种数据里（comfortK / waterMin / weights…），不散在函数里 ——
 *   以后加「硅基生命」时，多半是加一条数据；等真出现「评分项目都不同」的物种
 *   （比如气态生命没有重力项），再回头把评分函数做成按物种可选，届时按需分支。
 */
var SPECIES = [
  {
    id: "human",
    name: "人类",
    sci: "Homo sapiens",
    kind: "碳基生命",
    habitat: "岩质行星 · 液态水 · 约 1 bar 大气",
    desc: "以液态水为溶剂、需可呼吸大气层与接近 1 g 表面重力的碳基智慧物种；温度耐受窗口窄。",
    civ: { id: "humanity", name: "人类文明" },
    /* 摇篮口径（评分的全部可调参数 —— 见下方 cradleScore） */
    cradle: {
      comfortK: [278, 308],   /* 舒适带（约 5–35 ℃）：这一段拿满温度分 */
      surviveK: [248, 343],   /* 生存带（约 −25–70 ℃）：带外温度分归零，带内线性衰减 */
      waterMin: 0.28,         /* 液态水的储量起点（与「类地行星」的判定阈值同源） */
      waterFull: 0.78,        /* 富水到这一档，液态水项满分 */
      gravBest: 9.807,        /* 最适表面重力（= 地球 g，单位 m/s²） */
      gravTol: 12             /* 偏离多少 m/s² 归零 */
    },
    weights: { temp: 40, water: 25, atmo: 20, grav: 15 },  /* 四项权重，和必须 = 100 */
    atmoPref: { "无": 0, "稀薄": 0.5, "适中": 1, "浓密": 0.55 }
  }
];

/* 物种表 → 注册表（v0.7 的原语）：结构查重 + 语义体检见 src/15-registry.js。
 * 体检里按 20-data.js 的真实气压档核对 atmoPref 是否覆盖全 —— 加一个新品类的
 * 气压档而忘了给物种配分，在这里就会变红。 */
var Species = makeRegistry("物种", {
  required: ["id", "name", "sci", "kind", "habitat", "desc", "civ", "cradle", "weights", "atmoPref"],
  checks: [
    function (list) {
      var bad = [];
      var atmoSet = {};
      PlanetTypes.all().forEach(function (t) { atmoSet[t.atmoP] = true; });
      var civIds = {};
      list.forEach(function (sp) {
        var w = sp.weights || {}, C = sp.cradle || {}, pref = sp.atmoPref || {};
        var sum = (w.temp || 0) + (w.water || 0) + (w.atmo || 0) + (w.grav || 0);
        if (sum !== 100) bad.push("「" + sp.id + "」四项权重和 " + sum + " ≠ 100");
        if (!(C.comfortK && C.surviveK) || C.comfortK.length !== 2 || C.surviveK.length !== 2) {
          bad.push("「" + sp.id + "」的舒适带 / 生存带不是两元组");
        } else if (!(C.surviveK[0] <= C.comfortK[0] && C.comfortK[1] <= C.surviveK[1])) {
          bad.push("「" + sp.id + "」舒适带不在生存带内：[" + C.comfortK + "] ⊄ [" + C.surviveK + "]");
        }
        if (!(C.waterMin >= 0 && C.waterMin < C.waterFull && C.waterFull <= 1)) {
          bad.push("「" + sp.id + "」水储量阈值不合法：" + C.waterMin + " → " + C.waterFull);
        }
        if (!(C.gravBest > 0 && C.gravTol > 0)) bad.push("「" + sp.id + "」重力参数不合法");
        Object.keys(atmoSet).forEach(function (k) {
          if (typeof pref[k] !== "number") bad.push("「" + sp.id + "」的 atmoPref 未覆盖气压档「" + k + "」");
        });
        Object.keys(pref).forEach(function (k) {
          var v = pref[k];
          if (typeof v !== "number" || v < 0 || v > 1) bad.push("「" + sp.id + "」atmoPref." + k + " 越界：" + v);
        });
        var civ = sp.civ || {};
        if (!civ.id || !civ.name) bad.push("「" + sp.id + "」缺文明命名（civ.id / civ.name）");
        else if (civIds[civ.id]) bad.push("文明 id 撞车：「" + civ.id + "」被两个物种占用");
        else civIds[civ.id] = true;
      });
      return bad;
    }
  ]
}).addAll(SPECIES);

/* ---- 评分件：分段线性（单侧衰减到 0） ----
 * [a,b] 满分区；下方沿 [lo,a] 线性升到 1、上方沿 [b,hi] 线性降到 0；窗外一律 0。 */
function bandScore(v, a, b, lo, hi) {
  if (v >= a && v <= b) return 1;
  if (v < a) return v <= lo ? 0 : (v - lo) / (a - lo);
  return v >= hi ? 0 : (hi - v) / (hi - b);
}

/* ---- 液态水项：先看相态（温度），再看储量 ----
 * 液态水窗口内按储量给 0.4–1.0 分；冰封给 0.25（可取冰，起点低）；
 * 水汽给 0.15（湿热的困局：有水的原料，没有水的形态）；蒸干/极度贫水 = 0。 */
function waterScore(p, C) {
  if (p.water < 0.08) return 0;
  if (p.tempSurf > 273 && p.tempSurf < 373) {
    return clamp01(0.4 + 0.6 * (p.water - C.waterMin) / (C.waterFull - C.waterMin));
  }
  if (p.tempSurf <= 273 && p.tempSurf > 200) return 0.25;
  if (p.tempSurf >= 373 && p.tempSurf < 900) return p.water >= C.waterMin ? 0.15 : 0;
  return 0;
}

/* ---- 单颗行星的摇篮评分（纯函数：只读行星字段，不抽随机数） ----
 * 四项各得一个 0–1 系数 → 乘物种权重 → 取整成整数分；总分 = 分项和。
 * 分项取整后再求和（而不是「取整总分」），保证「面板上四个数加起来 == 总分」
 * 这件事永远成立 —— verify 会断言它。 */
function cradleScore(p, sp) {
  var W = sp.weights, C = sp.cradle;
  if (p.bulk !== "rock") {
    /* 气态行星没有固体表面：资格直接为零（但不丢出——选址总要选出个「最优解」，
     * 面板会把 why 原样显示，让人看得见为什么是它） */
    return {
      total: 0, why: "气态行星没有固体表面",
      parts: [
        { k: "温度", v: 0, max: W.temp, note: "—" },
        { k: "液态水", v: 0, max: W.water, note: "—" },
        { k: "大气", v: 0, max: W.atmo, note: "—" },
        { k: "重力", v: 0, max: W.grav, note: "—" }
      ]
    };
  }
  var t = bandScore(p.tempSurf, C.comfortK[0], C.comfortK[1], C.surviveK[0], C.surviveK[1]);
  var w = waterScore(p, C);
  var a = sp.atmoPref[p.type.atmoP] || 0;
  var g = clamp01(1 - Math.abs(p.g - C.gravBest) / C.gravTol);
  var parts = [
    { k: "温度", v: Math.round(W.temp * t), max: W.temp, note: Math.round(p.tempSurf) + " K" },
    { k: "液态水", v: Math.round(W.water * w), max: W.water, note: p.water < 0.08 ? "近乎无水" : "储量 " + Math.round(p.water * 100) + "%" },
    { k: "大气", v: Math.round(W.atmo * a), max: W.atmo, note: p.type.atmoP },
    { k: "重力", v: Math.round(W.grav * g), max: W.grav, note: p.g.toFixed(2) + " g" }
  ];
  var total = 0;
  for (var i = 0; i < parts.length; i++) total += parts[i].v;
  return { total: total, parts: parts };
}

/* ---- 选址：全星系评分最高者胜出；平局取**更内侧**（轨道序靠前）----
 * 用严格大于号扫描 = 「先出现者保持」——平局规则不需要额外代码。
 * 返回 board 是**轨道序**的榜（面板 / 调试看全貌），fit 是胜者的登记材料。 */
function pickCradle(planets, sp) {
  var board = [], bestIdx = -1, bestScore = -Infinity, second = null;
  planets.forEach(function (p, i) {
    var s = cradleScore(p, sp);
    board.push({ name: p.name, idx: i, total: s.total });
    if (s.total > bestScore) {
      second = bestIdx >= 0 ? { name: planets[bestIdx].name, total: bestScore } : null;
      bestScore = s.total;
      bestIdx = i;
    } else if (second === null || s.total > second.total) {
      second = { name: p.name, total: s.total };
    }
  });
  var best = bestIdx >= 0 ? planets[bestIdx] : null;
  var fit = null;
  if (best) {
    var win = cradleScore(best, sp);
    fit = {
      total: win.total, parts: win.parts, why: win.why || null,
      second: second, tie: !!(second && second.total === win.total),
      candidates: planets.length,
      report: "评估 " + planets.length + " 颗行星：评分 " + win.total + " 居首" +
        (second ? (second.total === win.total ? "（并列，取更内侧）" : "，次席「" + second.name + "」" + second.total + " 分") : "")
    };
  }
  return { planet: best, fit: fit, board: board };
}

/* ---- 给 verify / 控制台的干净快照（不出原始对象，避免测试改了游戏数据） ---- */
function speciesIds() {
  return Species.all().map(function (sp) { return sp.id; });
}
function speciesTable() {
  return Species.all().map(function (sp) {
    return {
      id: sp.id, name: sp.name, sci: sp.sci, kind: sp.kind, habitat: sp.habitat, desc: sp.desc,
      civ: { id: sp.civ.id, name: sp.civ.name },
      weights: { temp: sp.weights.temp, water: sp.weights.water, atmo: sp.weights.atmo, grav: sp.weights.grav },
      cradle: {
        comfortK: sp.cradle.comfortK.slice(), surviveK: sp.cradle.surviveK.slice(),
        waterMin: sp.cradle.waterMin, waterFull: sp.cradle.waterFull,
        gravBest: sp.cradle.gravBest, gravTol: sp.cradle.gravTol
      },
      atmoPref: { "无": sp.atmoPref["无"], "稀薄": sp.atmoPref["稀薄"], "适中": sp.atmoPref["适中"], "浓密": sp.atmoPref["浓密"] }
    };
  });
}
/* ================= 物资（v0.9 新增）：元素制家底 —— 蕴藏与可采两本账 ================= */

/* 「资源」在本作的立场（先读这段，再看代码）：
 *   星际资源不标准化「物质」，标准化「账本」—— 物质因世界而异（那正是本作的财产），
 *   可比性从账来，不从货来。四条细则：
 *     ① 单位律：账目用自造单位「单位物资」（1 单位 = 10²¹ kg —— 显示标度）。
 *        内部按 kg 计算，全链可溯源：构成% × 行星质量 × 配方 → 元素 kg → ÷ 标度。
 *     ② 账本律：14 个物资大类（9 现役 + 5 待命），元素按化学性质归户、**单一归属**。
 *     ③ 存量律：本版只回答「行星身上有什么、够不够得着」—— 不开采、不运输
 *        （那是纪年系统的活）。**恒星物资页不做**（留给以后的「能量采集」）。
 *     ④ 溯源律：每个数字都能指着行星的一个字段说出公式（老法律，资源版细则）。
 *
 * 三层结构（自上而下）：
 *   元素表 ELEMENTS   31 种：配方用得上者 + 待命大类的展示成员
 *   配方 RECIPES      12 个构成标签 → 元素质量占比（教科书折算，加载时归一化）
 *   物资表 MATERIALS  14 大类 —— 元素表的「归户」（单质单列、其余按族）
 *
 * ★★ 本文件最重要的两条约束（verify [19] 逐条断言）：
 *   一、零 RNG：推导只读行星既有字段（comp / mE），不抽任何随机数 ——
 *       主 RNG 流（884 / 0.374455 / 薄曙 / M）一格不动。
 *   二、守恒：Σ蕴藏 ≡ 行星质量。构成是整数百分比、和恰 100（20-data），
 *       配方归一化后和恰 1 —— 两层「恰好」让守恒精确到机器精度。
 *
 * 两本账（星球蕴含 ≠ 可以被采集）：
 *   蕴藏 = 行星全部物质按配方折算的元素总量 —— 行星常量
 *   可采 = 按「位置可及档」折减后的可达部分 —— 行星 × 工程等级
 *   ★ 取率是工程等级的函数（siteRate）：科技树未上线，现锁在 L0；将来升级只改
 *     SITE_RATES 一张表，可采数字自己长大（单调不减、天花板恒等于蕴藏）。
 *
 * ★ 后期会有「延伸物质」（合金 / 化合物 / 制品……）：届时新开一张制品表、
 *   引用本表物资作原料，本表不回改（用户 10-14 定的口径：到时候再说）。
 */

/* ---- 标度与常数 ----
 * 全代码原本没有 kg（质量单位一直是 M⊕）—— 物资账要「物质量」就得引入一个换算常数。
 * 存 kg 是为了溯源：显示除以标度之后，数字仍能一步步走回行星质量。 */
var EARTH_KG = 5.9722e24;   /* 地球质量 kg（教科书常数） */
var UNIT_KG = 1e21;         /* 1 单位物资 = 10²¹ kg（自造显示单位，比例全保真） */

/* ---- 元素表（31 种）----
 * 只收「配方用得上」与「待命大类要展示」的元素 —— 不是化学教科书，是账本的名册。
 * id 即元素符号。不设独立注册表：它是物资表的**成员字典**，查重 / 归属 / 闭包
 * 全部由物资表的语义体检覆盖（见下方 Materials 的 checks）。 */
var ELEMENTS = [
  { id: "H", name: "氢" }, { id: "He", name: "氦" }, { id: "Ne", name: "氖" },
  { id: "Ar", name: "氩" }, { id: "Kr", name: "氪" }, { id: "Xe", name: "氙" },
  { id: "C", name: "碳" }, { id: "N", name: "氮" }, { id: "O", name: "氧" }, { id: "Si", name: "硅" },
  { id: "Na", name: "钠" }, { id: "K", name: "钾" }, { id: "Mg", name: "镁" },
  { id: "Ca", name: "钙" }, { id: "Al", name: "铝" },
  { id: "Fe", name: "铁" }, { id: "Ni", name: "镍" }, { id: "Cr", name: "铬" },
  { id: "Mn", name: "锰" }, { id: "Co", name: "钴" },
  { id: "S", name: "硫" }, { id: "F", name: "氟" }, { id: "Cl", name: "氯" },
  { id: "Ag", name: "银" }, { id: "Au", name: "金" }, { id: "Pt", name: "铂" },
  { id: "U", name: "铀" }, { id: "Th", name: "钍" },
  { id: "La", name: "镧" }, { id: "Ce", name: "铈" }, { id: "Nd", name: "钕" }
];
var ELEM_BY_ID = {};
ELEMENTS.forEach(function (e) { ELEM_BY_ID[e.id] = e; });

/* ---- 配方：12 个构成标签 → 元素质量占比 ----
 * 标签与 20-data.js 的 buildComposition 一一对应（相态名由温度决定，共 12 种）：
 *   岩质三桶   铁镍核（Fe 90 / Ni 10）· 硅酸盐幔 · 挥发分六相
 *   巨行星三桶 H₂·He（原初丰度 74 / 26）· 水氨冰 / 水氨甲烷幔 · 岩石核
 * 数值全部是氧化物 / 化学式的**教科书折算**（不是发明），加载时归一化到和为 1：
 *   硅酸盐幔 = 橄榄岩质幔氧化物折算（O / Mg / Si / Fe / Ca / Al / Na / K）
 *   水=H₂O · 铁镍核=类地行星核口径 · 水氨冰=水 60/氨 25/甲烷 15 · 水氨甲烷幔=水 55/氨 25/甲烷 20
 *   「已蒸干」= 氢已逃逸、氧留在岩壳；「被剥离」= 恒星风剥离后的含水矿物残渣
 * ★ 已知口径（留给未来）：碳行星（碳 > 50%）的碳在构成模型里并入「硅酸盐幔」桶，
 *   本表按标准幔折算 —— 碳行星的特殊性留待构成模型细分的版本再修。
 * ★ 覆盖检查写进注册表体检：配方键 ↔ 可及档键一一对应；将来 buildComposition 出现
 *   新标签而这里没配 → verify [19] 的 15 星型扫描会拿真实行星标签把它抓出来。 */
var MANTLE = { O: 0.4423, Mg: 0.2333, Si: 0.2092, Fe: 0.0628, Ca: 0.0260, Al: 0.0235, Na: 0.0026, K: 0.0003 };
var WATER = { H: 0.1119, O: 0.8881 };
var RECIPES_RAW = {
  "铁镍核": { Fe: 0.90, Ni: 0.10 },
  "硅酸盐幔": MANTLE,
  "岩石核": MANTLE,
  "水冰": WATER, "冰水": WATER, "液态水": WATER, "水汽": WATER,
  "挥发分（被剥离）": WATER,                              /* 剥离后残留的含水矿物：按水口径折算 */
  "挥发分（已蒸干）": { O: 1 },                           /* 氢已逃逸、氧留在岩壳（熔岩世界） */
  "H₂·He": { H: 0.74, He: 0.26 },
  "水氨冰": { H: 0.1492323, O: 0.5328560, N: 0.2056104, C: 0.1123013 },
  "水氨甲烷幔": { H: 0.1562032, O: 0.4884513, N: 0.2056104, C: 0.1497351 }
};

/* 归一化（加载时一次）：原始值允许极小的舍入偏离，归一化后每张配方**恰好**和为 1
 * —— 守恒链的第一环（verify 对两条都断言：原始值接近 1、归一化后等于 1）。 */
var RECIPES = (function () {
  var out = {};
  Object.keys(RECIPES_RAW).forEach(function (k) {
    var r = RECIPES_RAW[k], sum = 0;
    Object.keys(r).forEach(function (el) { sum += r[el]; });
    var n = {};
    Object.keys(r).forEach(function (el) { n[el] = r[el] / sum; });
    out[k] = n;
  });
  return out;
})();

/* ---- 可及档：位置决定「够不够得着」----
 * 对「构成桶」打位置标：表层（流体 / 气层）全取 · 岩壳十取一 · 深部百取一。
 * ★ 三档取率不是常数，是**工程等级的函数**（siteRate）。三个 L0 值是全表唯一
 *   待设的工程参数，其余全部可由构成与质量推导 —— 数字几乎全是「发现」的。
 *   将来科技树上线 = 往 SITE_RATES 里追加各档的下一档值（单调不减，天花板上限 1）。 */
var SITE_CLASS = {
  "铁镍核": "deep", "岩石核": "deep",
  "硅酸盐幔": "crust",
  "水冰": "surface", "冰水": "surface", "液态水": "surface", "水汽": "surface",
  "挥发分（被剥离）": "surface", "挥发分（已蒸干）": "surface",
  "H₂·He": "surface",
  "水氨冰": "deep", "水氨甲烷幔": "deep"
};
var SITE_RATES = {
  surface: [1.0],     /* L0：表层全取 —— 大气与海洋本身就是它的仓储 */
  crust: [0.10],      /* L0：岩壳十取一 —— 露天矿脉 */
  deep: [0.01]        /* L0：深部百取一 —— 打一眼深井 */
};
var ENGINEERING = { level: 0, name: "L0" };   /* 科技树未上线：取率锁在 L0 */
function siteRate(cls, level) {
  var arr = SITE_RATES[cls];
  if (!arr || !arr.length) return 0;
  var lv = level === undefined ? ENGINEERING.level : level;
  if (!(lv >= 0)) lv = 0;
  if (lv >= arr.length) lv = arr.length - 1;   /* 未填的未来等级 = 沿用最高已知档 */
  return arr[lv];
}

/* ---- 物资表（14 大类 = 9 现役 + 5 待命）----
 * 两条规则：
 *   单一归属：每个元素恰属一个大类 —— 单质单列者从其族中移出（铁单列 ⇒ 过渡金属现只有镍）；
 *   现役 ⇔ 族内至少一名成员被配方覆盖（换句话说：本星系真出得来）。
 *   待命类是骨架位，等对应世界 / 玩法点亮（硫化物行星、卤水世界、精炼工业……）。
 * 表序 = 展示顺序（面板按此列出，零量类收进行尾一行）。 */
var MATERIALS = [
  { id: "h",      name: "氢",       members: ["H"],                          status: "active" },
  { id: "noble",  name: "惰性气体", members: ["He", "Ne", "Ar", "Kr", "Xe"], status: "active" },
  { id: "c",      name: "碳",       members: ["C"],                          status: "active" },
  { id: "n",      name: "氮",       members: ["N"],                          status: "active" },
  { id: "o",      name: "氧",       members: ["O"],                          status: "active" },
  { id: "si",     name: "硅",       members: ["Si"],                         status: "active" },
  { id: "alkali", name: "活跃金属", members: ["Na", "K", "Mg", "Ca", "Al"],  status: "active" },
  { id: "fe",     name: "铁",       members: ["Fe"],                         status: "active" },
  { id: "tm",     name: "过渡金属", members: ["Ni", "Cr", "Mn", "Co"],       status: "active" },
  { id: "s",      name: "硫",       members: ["S"],                          status: "standby" },
  { id: "hal",    name: "卤素",     members: ["F", "Cl"],                    status: "standby" },
  { id: "prec",   name: "贵金属",   members: ["Ag", "Au", "Pt"],             status: "standby" },
  { id: "rad",    name: "放射性",   members: ["U", "Th"],                    status: "standby" },
  { id: "rare",   name: "稀土",     members: ["La", "Ce", "Nd"],             status: "standby" }
];

/* 物资表 → 注册表：结构查重 + 语义体检（boot 时跑）。
 * 体检比别的表重 —— 它还替元素表、配方表、可及档表站岗（见 checks ⑥⑦）。 */
var Materials = makeRegistry("物资", {
  required: ["id", "name", "members", "status"],
  checks: [
    function (list) {
      var bad = [];
      /* ① 元素表自检：id / 名齐全、无重复 */
      var seen = {};
      ELEMENTS.forEach(function (e) {
        if (!e || !e.id || !e.name) { bad.push("元素表有条目缺 id / name"); return; }
        if (seen[e.id]) bad.push("元素表重复元素：" + e.id);
        seen[e.id] = true;
      });
      /* ② 单一归属：每个元素恰属一个大类（重复 = 重复记账），成员必须在元素表里 */
      var owner = {};
      list.forEach(function (cat) {
        if (!cat.members || !cat.members.length) { bad.push("「" + cat.id + "」没有成员"); return; }
        cat.members.forEach(function (el) {
          if (!ELEM_BY_ID[el]) { bad.push("「" + cat.id + "」的成员 " + el + " 不在元素表里"); return; }
          if (owner[el]) bad.push("元素 " + el + " 同时属于「" + owner[el] + "」与「" + cat.id + "」");
          else owner[el] = cat.id;
        });
      });
      ELEMENTS.forEach(function (e) {
        if (!owner[e.id]) bad.push("元素「" + e.id + "」不属于任何物资大类");
      });
      return bad;
    },
    function (list) {
      var bad = [];
      /* ③ 配方闭包：标签 ↔ 配方 ↔ 可及档 三方一一对应；配方元素在表内；归一化后和 = 1 */
      var covered = {};
      Object.keys(RECIPES).forEach(function (k) {
        var r = RECIPES[k], sum = 0;
        Object.keys(r).forEach(function (el) {
          if (!ELEM_BY_ID[el]) bad.push("配方「" + k + "」含未知元素：" + el);
          covered[el] = true;
          sum += r[el];
        });
        if (Math.abs(sum - 1) > 1e-9) bad.push("配方「" + k + "」归一化后和 ≠ 1：" + sum);
        if (!SITE_CLASS[k]) bad.push("配方「" + k + "」没有可及档");
        else if (!SITE_RATES[SITE_CLASS[k]]) bad.push("配方「" + k + "」的可及档「" + SITE_CLASS[k] + "」没有取率表");
      });
      Object.keys(SITE_CLASS).forEach(function (k) {
        if (!RECIPES[k]) bad.push("可及档「" + k + "」没有对应配方（多余条目）");
      });
      /* ④ 原始值接近 1（教科书折算值不许被改烂到离谱） */
      Object.keys(RECIPES_RAW).forEach(function (k) {
        var r = RECIPES_RAW[k], sum = 0;
        Object.keys(r).forEach(function (el) { sum += r[el]; });
        if (Math.abs(sum - 1) > 5e-4) bad.push("原始配方「" + k + "」和的偏离过大：" + sum);
      });
      /* ⑤ 状态口径：现役 ⇔ 至少一名成员被配方覆盖；待命 ⇔ 一名都没有 */
      list.forEach(function (cat) {
        var hit = (cat.members || []).some(function (el) { return covered[el]; });
        var want = hit ? "active" : "standby";
        if (cat.status !== "active" && cat.status !== "standby") bad.push("「" + cat.name + "」status 非法：" + cat.status);
        else if (cat.status !== want) bad.push("「" + cat.name + "」status=" + cat.status + "，但配方覆盖对应 " + want);
      });
      /* ⑥ 取率表：值域 (0,1]、随等级单调不减（「可采只增不减」的结构保证） */
      Object.keys(SITE_RATES).forEach(function (cls) {
        var arr = SITE_RATES[cls];
        if (!arr || !arr.length) { bad.push("可及档「" + cls + "」没有取率"); return; }
        for (var i = 0; i < arr.length; i++) {
          if (!(arr[i] > 0 && arr[i] <= 1)) bad.push("取率 " + cls + "[" + i + "] = " + arr[i] + " 越界（应在 (0, 1]）");
          if (i > 0 && arr[i] < arr[i - 1]) bad.push("取率 " + cls + " 随等级下降：" + arr.join(" → "));
        }
      });
      /* ⑦ 三档齐备 */
      ["surface", "crust", "deep"].forEach(function (cls) {
        if (!SITE_RATES[cls]) bad.push("缺可及档：" + cls);
      });
      return bad;
    }
  ]
}).addAll(MATERIALS);

/* ---- 推导（纯函数，零 RNG）----
 * 输入只有行星的两个既有字段：p.comp（整数百分比构成）· p.mE（质量 M⊕）。
 * 输出按**元素**记的两本账（kg）：hold 蕴藏 · ext 可采。 */
function elementLedgerOf(p) {
  var massKg = p.mE * EARTH_KG;
  var hold = {}, ext = {}, unmatched = [];
  p.comp.forEach(function (c) {
    var label = c[0], pct = c[1];
    var r = RECIPES[label];
    if (!r) { if (unmatched.indexOf(label) < 0) unmatched.push(label); return; }
    var rate = siteRate(SITE_CLASS[label]);
    var bucketKg = massKg * (pct / 100);
    Object.keys(r).forEach(function (el) {
      var kg = bucketKg * r[el];
      hold[el] = (hold[el] || 0) + kg;
      ext[el] = (ext[el] || 0) + kg * rate;
    });
  });
  return { massKg: massKg, hold: hold, ext: ext, unmatched: unmatched };
}

/* 单颗行星的物资账（面板 / __game 共用）：按物资表顺序归户。
 * rows = 有量的大类（数值 + 格式化前的 kg）；zero = 零量大类名（收成一行）。 */
function materialsOf(p) {
  var led = elementLedgerOf(p);
  var rows = [], zero = [], sumHold = 0, sumExt = 0;
  Materials.all().forEach(function (cat) {
    var h = 0, e = 0;
    cat.members.forEach(function (el) {
      h += led.hold[el] || 0;
      e += led.ext[el] || 0;
    });
    sumHold += h;
    sumExt += e;
    if (h > 0) {
      rows.push({
        id: cat.id, label: matLabel(cat), members: cat.members.slice(),
        holdKg: h, extKg: e, units: h / UNIT_KG, extUnits: e / UNIT_KG
      });
    } else {
      zero.push(matLabel(cat));
    }
  });
  return {
    idx: p.idx, name: p.name,
    massKg: led.massKg, totalUnits: led.massKg / UNIT_KG,
    holdKg: sumHold, extKg: sumExt,
    rows: rows, zero: zero, unmatched: led.unmatched
  };
}

/* 大类显示名：单质单列者带元素符号（「氢 H」）；族不带（「活跃金属」） */
function matLabel(cat) {
  return cat.name + (cat.members.length === 1 ? " " + cat.members[0] : "");
}

/* kg → 「单位物资」显示串（面板与 verify 的页文本核对同源）：
 *   ≥100 → 取整 + 千分位（157 / 380,885）· ≥10 → 一位小数（18.5）
 *   ≥1 → 两位小数（3.86）· <1 → 两位有效数字（0.27） */
function matUnits(kg) {
  var v = kg / UNIT_KG;
  if (!(v > 0)) return "0";
  if (v >= 100) return fmtNum(Math.round(v));
  if (v >= 10) return v.toFixed(1);
  if (v >= 1) return v.toFixed(2);
  return v.toPrecision(2);
}

/* ---- 给 verify / 控制台的干净快照（不出原始对象）---- */
function matClone(x) { return JSON.parse(JSON.stringify(x)); }
function materialsTable() {
  var rates = {}, classes = {};
  Object.keys(SITE_RATES).forEach(function (k) { rates[k] = SITE_RATES[k].slice(); });
  Object.keys(SITE_CLASS).forEach(function (k) { classes[k] = SITE_CLASS[k]; });
  return {
    unit: "单位物资", unitKg: UNIT_KG, earthKg: EARTH_KG,
    eng: { level: ENGINEERING.level, name: ENGINEERING.name },
    elements: ELEMENTS.map(function (e) { return { id: e.id, name: e.name }; }),
    labels: Object.keys(RECIPES),
    recipes: matClone(RECIPES), recipesRaw: matClone(RECIPES_RAW),
    siteClass: classes, siteRates: rates,
    categories: Materials.all().map(function (c) {
      return { id: c.id, name: c.name, members: c.members.slice(), status: c.status, label: matLabel(c) };
    })
  };
}
/* 全部行星的物资账（可给单颗行星名过滤，与 planetData 同款签名） */
function planetMaterials(name) {
  return G.sys.planets.filter(function (p) { return !name || p.name === name; })
    .map(function (p) { return materialsOf(p); });
}
/* ================= 全局状态 ================= */
var G = {
  sys: null,                  // 唯一星系
  selectedPlanet: null,       // 单击选中的行星
  selectedStar: false,        // 是否选中恒星
  focusPlanet: null,          // 相机正在跟随的行星（双击聚焦）
  holdTarget: false           // 测试 / 截图用：暂缓目标点回中
};
var __frames = 0;

/* ================= 星系生成（确定性：每次打开同一个星系） ================= */

/* 视觉公转角速度 = 真实开普勒关系的等比缩放（同一条 1/a^1.5 幂律）：
 * 真实周期是天量级，无法直接观看；取系数使最内行星约 40 秒一周，
 * 于是「内侧显著快于外侧」这一开普勒特征在画面上依然成立。 */
var VIS_ORBIT_K = 10.2;

/* 主序列只抽「决定世界骨架」的十一个值，且一抽一用、顺序固定。
 * 贴图细节 / 环 / 云全部走本行星专属随机流（见 行星贴图 一节），
 * 所以以后调整贴图算法不会让行星布局漂移。 */
function genPlanets(sysName, n, star) {
  var out = [];
  for (var i = 0; i < n; i++) {
    var d = {
      orbit: 16 + i * 9.5 + rand(-1.2, 1.2),   // 视觉轨道半径
      rR: rng(),      // 半径抽值
      wR: rng(),      // 挥发分抽值
      mR: rng(),      // 金属丰度抽值
      aR: rng(),      // 大气厚度抽值
      cR: rng(),      // 碳抽签
      gR: rng(),      // 巨行星判定
      tR: rng(),      // 潮汐锁定半径
      sR: rng(),      // 自转周期
      iR: rng(),      // 轨道倾角
      pR: rng(),      // 起始相位
      sdR: rng()      // 贴图随机流种子
    };
    out.push(planetPhysics(sysName, i, d, star));
  }
  return out;
}

/* 由轨道 + 抽取值算出全部物理量（唯一入口：面板 / 贴图 / 指导书都读这里） */
function planetPhysics(sysName, i, d, star) {
  var au = d.orbit / VIS_PER_AU;
  var teq0 = eqTemp(star, au, 0.30);             /* 气候带判据：基准反照率 0.3 */
  var distT = clamp01((d.orbit - 13) / 46);      /* 0 = 最内 · 1 = 最外 */

  /* 组分 —— 决定形态，也和温度共同决定类型。两条相反的梯度，正是原行星盘的真实格局：
   *   挥发分随距离上升（雪线外侧才留得住冰）
   *   金属丰度随距离下降（难熔物质先在热的内侧凝结 —— 水星铁核占 63%、地球 32%、外带更贫铁）
   * 各自再叠一次自身散布，避免同心圆式的刻板结果。 */
  var water = clamp01((0.16 + 0.66 * distT) * (0.25 + 1.5 * d.wR));
  var atmo = clamp01(water * 0.45 + d.aR * 0.75);  /* 大气 = 挥发分 + 独立抽签 */
  var metal = clamp01((0.62 - 0.52 * distT) * (0.45 + 1.1 * d.mR));

  /* 巨行星形成概率随距离上升（外侧固体物质更多） */
  var bulk = d.gR < (0.05 + 0.40 * distT) ? "giant" : "rock";

  var c = { bulk: bulk, teq0: teq0, water: water, metal: metal, atmo: atmo, rE: 99, carbon: false };
  var type, rE, mE;
  if (bulk === "giant") {
    type = resolvePlanetType(c);
    var mr = type.massRange;
    mE = mr[0] + (mr[1] - mr[0]) * Math.pow(d.rR, 1.6);      /* 质量重尾：小质量更常见 */
    rE = (type.id === "icegiant" ? iceGiantRadius(mE) : giantRadius(mE));
    if (type.id === "hotjupiter") rE *= 1.12;                /* 受热膨胀 */
  } else {
    /* 半径取三角分布（峰值 ≈ 1.1 R⊕）：类地尺度最常见，迷你行星与超级地球两端渐稀 */
    rE = 0.22 + 1.75 * triU(d.rR);
    c.rE = rE;
    c.carbon = d.cR < 0.035;
    type = resolvePlanetType(c);
    /* 质量要等类型定下来再算：挥发分算不算数，取决于该型有没有大气顶着（atmoP） */
    mE = rockyMass(rE, metal, water, type.atmoP);
  }

  /* 真实温度：该型自身的反照率 → 真实平衡温度；再乘温室系数 → 表面温度。
   * 金星之所以 737 K 而地球 288 K，差别全在这两步。 */
  var teq = eqTemp(star, au, type.albedo);
  var tSurf = teq * type.green;

  /* 构成（质量占比）：放在温度之后算 —— 挥发分的相态取决于表面温度 */
  var comp = buildComposition({
    kind: type.kind, typeId: type.id, atmoP: type.atmoP,
    mE: mE, water: water, metal: metal, tempSurf: tSurf
  });

  /* 轨道（开普勒第三定律 → 周期 → 速度） */
  var periodDays = keplerDays(au, star.massSol, mE);
  var vOrbit = orbitKms(au, periodDays);

  /* 自转：潮汐锁定半径以内 → 同步自转（一边永昼、一边永夜）。
   * 锁定半径 ∝ M★^(1/3)，再乘一次潮汐耗散的不确定性系数（0.8–1.3）。 */
  var lockR = 0.8 + 0.5 * d.tR;
  var tidal = au < 0.075 * Math.pow(star.massSol, 1 / 3) * lockR;
  var rotFree = 6 + Math.pow(d.sR, 0.7) * 60;      /* 自由自转周期 6–66 小时 */
  var rotH = tidal ? periodDays * 24 : rotFree;

  return {
    idx: i,
    name: sysName + " " + roman(i + 1),
    seed: 1 + Math.floor(d.sdR * 2e9),
    bulk: bulk, type: type,
    /* 轨道 */
    orbit: d.orbit, au: au, incl: (d.iR - 0.5) * 0.28, angle: d.pR * Math.PI * 2,
    /* ★ v0.14：偏心率（0 = 圆轨道；>0 走椭圆解算 —— 恒星位于椭圆的一个焦点） */
    ecc: 0,
    periodDays: periodDays, vOrbit: vOrbit,
    orbitSpeed: VIS_ORBIT_K / Math.pow(d.orbit, 1.5),
    /* 组分 */
    water: water, atmo: atmo, metal: metal, carbon: !!c.carbon,
    iron: bulk === "giant" ? 0 : rockyParts(metal, water, type.atmoP).iron,
    comp: comp,
    /* 物理量 */
    rE: rE, mE: mE, radiusKm: rE * 6371, dens: 5.514 * mE / (rE * rE * rE),
    g: gravG(mE, rE), vEsc: escKms(mE, rE),
    insol: insolation(star, au), teq: teq, teq0: teq0, tempSurf: tSurf,
    rotH: rotH, rotFree: rotFree, lockR: lockR, tidal: tidal,
    /* 视觉 */
    spin: clamp(6 / rotH, 0.08, 0.9),
    size: clamp(0.92 * Math.pow(rE, 0.42), 0.42, 2.6)
  };
}

function genSystem() {
  var name = pick(NAME_SYLL);
  var starType = weightedPick(STAR_TYPES);
  G._starRoll = +weightedPick.lastR.toFixed(6);   // 恒星级抽值（确定性回归用）
  G._starDraws = rngDraws;                        // 抽到星型时的累计抽数（序列锚点）
  var planets = genPlanets(name, irand(5, 7), starType);
  /* ★ v0.14：外围增补行星（用户：测试星系行星太少了）—— 走**专属流**，不消耗主序列。
   * 主序列在星型抽出之后还要被「发源地 / 星海 / 陨石带」连续消费：在中间多抽
   * 一格，后面全部整体错位（确定性守恒，见 README §四）。专属流与主种子同源
   * （10-core 的 mulberry32(20261014)）—— 同一次抽签永远长出同一个星系。 */
  planets = planets.concat(genExtraPlanets(name, planets.length, starType));
  /* ★ v0.14：卫星登记（每颗行星一份；细节走本行星派生流 —— 同样不碰主序列） */
  planets.forEach(function (p) { genMoons(p); });
  return { name: name, starType: starType, planets: planets };
}

/* ---- v0.14：外围增补行星（3 颗，含椭圆轨道）----
 * 抽值口径与 genPlanets 完全一致（同一组字段，直接喂 planetPhysics），
 * 物理上与被主序列抽出的行星没有任何差别；唯一的不同是随机来源。
 * 类型取向：前两颗强制岩质（其一高偏心 ——「椭圆轨道行星」的确定性样本），
 * 第三颗强制巨行星（外带巨行星，与行星盘模型一致，也当卫星的宿主）。 */
var EXTRA_SEED = 20261014;                    /* 与主种子同源（10-core 的 mulberry32(20261014)） */
function genExtraPlanets(sysName, start, star) {
  var xr = seedStream(EXTRA_SEED, 0x9E4B0A17);
  var out = [];
  for (var k = 0; k < 3; k++) {
    var d = {
      orbit: 16 + (start + k) * 9.5 + (xr() - 0.5) * 2.4,   // 顺势外延（间距与内侧一致）
      rR: xr(), wR: xr(), mR: xr(), aR: xr(), cR: xr(),
      gR: k === 2 ? 0.02 : 0.88,                            // 岩 · 岩 · 巨
      tR: xr(), sR: xr(), iR: xr(), pR: xr(), sdR: xr()
    };
    var p = planetPhysics(sysName, start + k, d, star);
    /* 偏心率：一颗轻椭圆 + 一颗显著椭圆（近日掠过 / 远日慢行）+ 一颗近圆 */
    p.ecc = k === 0 ? +(0.08 + xr() * 0.08).toFixed(4)
      : k === 1 ? +(0.24 + xr() * 0.10).toFixed(4)
        : +(xr() * 0.05).toFixed(4);
    if (k === 2) p._extraTail = true;                       // 最外一颗（标记用；v0.16 起卫星按体量分配，不再看它）
    out.push(p);
  }
  return out;
}

/* ================= three.js 基础 ================= */
var canvas = document.getElementById("scene");
var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x000000, 1);   // 纯黑：与 UI 的黑白体系一致（原为蓝黑 #05070d）

var scene = new THREE.Scene();
var camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.5, 2000);

function makeOrbit(theta, phi, radius, minR, maxR) {
  return { theta: theta, phi: phi, radius: radius, minR: minR, maxR: maxR, target: new THREE.Vector3(0, 0, 0) };
}
var orbit = makeOrbit(0.9, 1.12, 92, 16, 260);
var camGoalRadius = 92;            // 相机半径目标（双击聚焦/回全景时平滑过渡）

function applyOrbit(cam, o) {
  o.phi = clamp(o.phi, 0.12, Math.PI - 0.12);
  o.radius = clamp(o.radius, o.minR, o.maxR);
  var sinPhi = Math.sin(o.phi);
  cam.position.set(
    o.target.x + o.radius * sinPhi * Math.sin(o.theta),
    o.target.y + o.radius * Math.cos(o.phi),
    o.target.z + o.radius * sinPhi * Math.cos(o.theta)
  );
  cam.lookAt(o.target);
}

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
/* ================= 文明（实例）· 发源地信标（v0.8 新增） ================= */

/* 文明 = 物种 × 发源地。第一版每个物种只成立一个文明（人类文明），
 * 发源地 = 全星系适居评分最高者（评分与选址见 27-species.js，纯函数）。
 *
 * ★ 时序（两个函数必须分开的原因）：
 *   foundCivilizations  纯数据：选址 + 登记进 Civilizations 表 —— boot 里在**搭场景之前**
 *                       （这样注册表体检能一次覆盖全部表）
 *   syncCivBeacons      场景物：给发源地挂信标 —— 搭场景**之后**（行星才有 _group）
 * ★ 换恒星（setStarType）后温度整体重算 → 发源地按新条件**重新选举**：
 *   发源地不是行星的「出身」（出身不可变），而是「当前条件下的最优解」（可重算）。
 *   信标跟着走：老发源地摘环、新发源地挂环 —— 都由 syncCivBeacons 收口。
 * ★ 信标是**虚线细环**：与宜居带同一个视觉语义（虚线 = 标注而非实体）。
 *   纯几何、零随机 —— 不消耗任何随机流，确定性锚点（884 抽）不受影响。
 */
var Civilizations = makeRegistry("文明", {
  required: ["id", "name", "speciesId", "home", "fit"],
  checks: [
    function (list) {
      var bad = [];
      list.forEach(function (c) {
        if (!Species.has(c.speciesId)) {
          bad.push("「" + c.id + "」的 speciesId「" + c.speciesId + "」不在物种表内");
        }
        if (!c.home || c.home.bulk !== "rock") {
          bad.push("「" + c.id + "」的发源地不是岩质行星（无固体表面）");
        }
        if (c.fit) {
          var sum = 0;
          (c.fit.parts || []).forEach(function (p) { sum += p.v; });
          if (sum !== c.fit.total) bad.push("「" + c.id + "」分项和 " + sum + " ≠ 总分 " + c.fit.total);
        }
        if (c.home && G.sys && G.sys.planets.indexOf(c.home) < 0) {
          bad.push("「" + c.id + "」的发源地不在本星系（行星引用失效）");
        }
      });
      return bad;
    }
  ]
});

/* ---- 成立 / 重选：对每个物种选址并登记（幂等：重复调用 = 重新选举） ---- */
function foundCivilizations(sys) {
  if (!sys || !sys.planets || !sys.planets.length) return;
  Species.all().forEach(function (sp) {
    var pick = pickCradle(sys.planets, sp);
    if (!pick.planet) return;          /* 表坏了才会没有胜者；注册表体检会另报 */
    var civ = Civilizations.first(function (c) { return c.speciesId === sp.id; });
    if (!civ) {
      civ = { id: sp.civ.id, name: sp.civ.name, speciesId: sp.id };
      civ.home = pick.planet;
      civ.fit = pick.fit;
      Civilizations.add(civ);
    } else {
      civ.home = pick.planet;          /* 换恒星 → 发源地跟着新温度走 */
      civ.fit = pick.fit;
    }
  });
}

/* ---- 发源地信标：虚线细环（纯几何，零随机） ---- */
function makeCivRing(p) {
  var pts = [], seg = 72;
  for (var i = 0; i <= seg; i++) {
    var a = (i / seg) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * p.size * 2.35, 0, Math.sin(a) * p.size * 2.35));
  }
  var ring = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineDashedMaterial({
      color: 0xededed, dashSize: p.size * 0.42, gapSize: p.size * 0.34,
      transparent: true, opacity: 0.32
    })
  );
  ring.computeLineDistances();          /* 虚线材质的前提（与宜居带同款） */
  ring.rotation.x = -p.incl;            /* 与轨道面平行（和轨道线同一倾角） */
  return ring;
}

/* 把信标刷成与 Civilizations 表一致：只在发源地上有环。
 * 调用点：boot（buildScene 之后）· setStarType（重新选举之后）。 */
function syncCivBeacons() {
  if (!G.sys || !G.sys.planets) return;
  G.sys.planets.forEach(function (p) {
    var want = !!civOf(p);
    if (want && !p._civRing) {
      p._civRing = makeCivRing(p);
      p._group.add(p._civRing);
    } else if (!want && p._civRing) {
      p._group.remove(p._civRing);
      p._civRing.geometry.dispose();
      p._civRing.material.dispose();
      p._civRing = null;
    }
  });
}

/* ---- 查询：行星 → 文明 / 全量快照 ---- */
function civOf(p) {
  if (!p) return null;
  return Civilizations.first(function (c) { return c.home === p; });
}
function civReport() {
  return Civilizations.all().map(function (c) {
    var sp = Species.get(c.speciesId) || {};
    return {
      id: c.id, name: c.name,
      speciesId: c.speciesId, speciesName: sp.name || "?",
      home: c.home.name, homeIdx: G.sys.planets.indexOf(c.home),
      score: c.fit.total,
      parts: c.fit.parts.map(function (p) { return { k: p.k, v: p.v, max: p.max, note: p.note }; }),
      second: c.fit.second, tie: c.fit.tie, candidates: c.fit.candidates,
      report: c.fit.report, why: c.fit.why,
      beacon: !!(c.home && c.home._civRing)
    };
  });
}
/* 某个物种的完整评分榜（轨道序）—— 现算，永远与当前恒星条件一致 */
function cradleBoardOf(speciesId) {
  var sp = Species.get(speciesId || "human");
  if (!sp || !G.sys) return null;
  return pickCradle(G.sys.planets, sp).board;
}
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
/* 云层（类地/海洋）—— v0.17 起**只作兜底**，行星实际用的是下面的 cloudTexFor。
 * ★★ 为什么不能删这个调用：它消耗主随机流（46 × 4 次 rand），而
 *   `setupTextures()` 里的调用次序是**确定性契约的一部分**（roll-check 的
 *   rngDraws = 884 就锚在这条序列上）。删掉或改它的抽取次数 → 星系整体错位。
 *   所以这里原样保留，全景档改走 cloudTexFor（零随机流的哈希噪声）。 */
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

/* ── 云层（v0.17 重做）─────────────────────────────────────────────
 * ★ 旧实现是一张 256×128 的全局单例：46 个随机圆斑，**所有行星共用同一张**
 *   —— 5 颗有云的行星顶着同一团斑块、只是转速不同。这是「一眼假」的根源。
 * 现在按行星各自生成，并且带上真实大气环流的**纬向带**骨架（云是被行星风
 * 梳成条带的，不是一堆圆斑）。
 * ★ 零随机流：噪声坐标的偏移直接由 p.seed 算出，一格主 RNG 都不碰
 *   （确定性守恒的铁律 —— 同 IIFE 内可复用聚焦档云壳那套 _cvn3，纯 hash）。
 * 缓存按 seed：同一颗行星不会重复生成。 */
var CLOUD_PAN_W = 512, CLOUD_PAN_H = 256;
var _cloudPanCache = {};

/* 纬向带：赤道辐合带多云 · 副热带高压（±26°）晴 · 中纬气旋带（±56°）多云 · 极区少云。
 * 真实行星的云几乎都是这个骨架 —— 没有它，云就只是一团均匀噪声。 */
function cloudLatBand(latDeg) {
  var a = Math.abs(latDeg);
  var itcz = Math.exp(-Math.pow(a / 10, 2));          /* 赤道辐合带（ITCZ） */
  var sub = Math.exp(-Math.pow((a - 26) / 12, 2));    /* 副热带高压：晴空带 */
  var mid = Math.exp(-Math.pow((a - 56) / 16, 2));    /* 中纬气旋带 */
  /* 副热带只压到 0.20 而不到 0：晴空带是「云少」，不是「一滴都没有」——
   * 压到 0 会露出一条僵直的秃带，看着像画上去的刻度线。 */
  return clamp(0.50 + 0.46 * itcz + 0.36 * mid - 0.30 * sub, 0, 1.28);
}

function cloudTexFor(p) {
  var sd = (p && p.seed) | 0;
  if (_cloudPanCache[sd]) return _cloudPanCache[sd];
  var W = CLOUD_PAN_W, H = CLOUD_PAN_H;
  /* 由 seed 派生三个坐标偏移：同一套噪声，换颗星就是另一片天 */
  var ox = (sd % 977) * 0.137, oy = (((sd / 977) | 0) % 613) * 0.211, oz = (((sd / 613) | 0) % 401) * 0.173;
  var data = new Uint8Array(W * H * 4), i = 0;
  for (var j = 0; j < H; j++) {
    var band = cloudLatBand(((j + 0.5) / H) * 180 - 90);
    var lat = ((j + 0.5) / H) * Math.PI;
    var sl = Math.sin(lat), cl = Math.cos(lat);
    for (var k = 0; k < W; k++) {
      var lon = ((k + 0.5) / W) * Math.PI * 2;
      var dx = sl * Math.cos(lon), dy = cl, dz = sl * Math.sin(lon);
      /* 纬度方向频率更高 → 云团被纬向风拉成东西向的长条（气旋带的观感） */
      var s = 0, nn = 0, a = 0.5;
      var px = dx * 2.60 + ox, py = dy * 2.60 * 2.35 + oy, pz = dz * 2.60 + oz;
      for (var o = 0; o < 4; o++) {
        s += a * _cvn3(px, py, pz); nn += a; a *= 0.5;
        px *= 2.07; py *= 2.07; pz *= 2.07;
      }
      var v = ((s / nn) - 0.5) * 2.0 + 0.5;
      var b = (clamp(v * band, 0, 1) * 255) | 0;
      data[i++] = b; data[i++] = b; data[i++] = b; data[i++] = 255;
    }
  }
  var tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;                    /* 经度环绕无缝 */
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;      /* mipmap 预过滤 = 远景不走样 */
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return (_cloudPanCache[sd] = tex);
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

/* 云层材质（v0.17）：比 Lambert 多两件真实大气该有的事
 *   ① **临边增亮**（limb brightening）—— 视线在行星边缘穿过的大气更厚，云也更白；
 *      没有它，云看着就是贴在球面上的一张纸（这是「大气」与「贴纸」的分界）。
 *   ② **夜面的云看不见** —— Lambert 会把夜半球压成一层**黑色半透明**（云变黑
 *      盖住地表），而真实情况是那里没光、云就不显现；所以让 alpha 随光照衰减。
 * uSun 由场景每帧喂（世界系指向恒星的单位向量）。 */
function cloudMaterial(map, opacity) {
  return new THREE.ShaderMaterial({
    uniforms: {
      map: { value: map },
      uSun: { value: new THREE.Vector3(1, 0, 0) },
      uBase: { value: opacity },        /* 原始不透明度（聚焦档淡出要用） */
      uOpacity: { value: opacity },
      uRim: { value: 0.95 }
    },
    vertexShader: [
      "varying vec2 vUv;",
      "varying vec3 vN;",
      "varying vec3 vV;",
      "void main() {",
      "  vUv = uv;",
      "  vec4 wp = modelMatrix * vec4(position, 1.0);",
      "  vN = normalize(mat3(modelMatrix) * normal);",   /* 世界系法线：跟着自转转 */
      "  vV = normalize(cameraPosition - wp.xyz);",
      "  gl_Position = projectionMatrix * viewMatrix * wp;",
      "}"
    ].join("\n"),
    fragmentShader: [
      "uniform sampler2D map;",
      "uniform vec3 uSun;",
      "uniform float uOpacity;",
      "uniform float uRim;",
      "varying vec2 vUv;",
      "varying vec3 vN;",
      "varying vec3 vV;",
      "void main() {",
      "  float c = texture2D(map, vUv).r;",
      "  vec3 N = normalize(vN);",
      "  float lam = dot(N, normalize(uSun));",
      "  float lit = clamp(lam * 1.10 + 0.04, 0.0, 1.0);",       /* 晨昏线留一点软过渡 */
      "  float rim = pow(clamp(0.80 - dot(N, normalize(vV)), 0.0, 1.0), 1.9);",
      "  float a = c * uOpacity * lit * (1.0 + uRim * rim);",
      "  gl_FragColor = vec4(vec3(1.0), clamp(a, 0.0, 1.0));",
      "}"
    ].join("\n"),
    transparent: true,
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
/* 凹凸强度系数（v0.17）：0.19 → 0.42。原来山几乎不出立体感（实测各行星
 * bumpScale 只有 0.09~0.18，冰行星 0.092 基本是个光滑球），因为旧设计把立体感
 * 全押在贴图里那道**烘死的方向性阴影**上。现在反过来：让**实时光照**（bumpMap）
 * 当主力，烘的那道退居次要 —— 山影于是永远和晨昏线一致。 */
var BUMP_K = 0.42;

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
    /* 镜面遮罩（v0.17）：决定**太阳耀斑出现在哪里** —— 海面满、冰/雪中等、裸岩哑光。
     * ★ 「看起来像水」几乎全靠这一层：Lambert 没有高光通道，光靠调颜色只能得到
     *   一片哑光蓝（v0.16 及以前就是这样）；有了它，海面才会被阳光点燃出一小片反光。 */
    var cSpec = document.createElement("canvas"); cSpec.width = W; cSpec.height = H;
    var gS = cSpec.getContext("2d");
    var imgS = gS.createImageData(W, H), dS = imgS.data;
    var cEm = pr.lava ? document.createElement("canvas") : null;
    var gE = null, imgE = null, dE = null;
    if (cEm) { cEm.width = W; cEm.height = H; gE = cEm.getContext("2d"); imgE = gE.createImageData(W, H); dE = imgE.data; }

    var seaA = pr.sea ? 0.5001 : -1;                 /* 归一化后的海平面（见 buildHeightField） */
    var grainS = p.seed & 0xffff;

    for (var j = 0; j < H; j++) {
      var latAbs = Math.abs((j / (H - 1)) * 2 - 1);            /* 0 = 赤道，1 = 极点 */
      /* 极冠：纬度越靠近极点越白；冷星（capFrac 大）从更低的纬度就开始封冰 */
      var white = pr.capFrac > 0 ? clamp((latAbs - (1 - pr.capFrac)) / Math.max(0.06, pr.capFrac * 0.55), 0, 1) : 0;
      /* ★ v0.17 山体着色：从「固定方向 hillshade」改成「曲率遮蔽 + 轻微方向感」。
       * 为什么必须改：旧写法把一道**固定东南向**的光烘进贴图（`(gx+gy)*14`），但
       * 除了潮汐锁定的行星，贴图空间里的真实光照方向每时每刻都在扫（行星在自转），
       * 于是烘死的影子会和实时光照的晨昏线**长期互相矛盾** —— 亮面上冒出暗坡、
       * 暗面上冒出亮坡。这是「失真」最主要的来源之一。
       * 现在的分工：立体感的**主力**交给 bumpMap + 实时光照（bumpScale 同步调大），
       * 贴图里只留两样：
       *   ① 曲率遮蔽（**无方向**：脊/峰提亮、谷/坑底压暗 —— 在任何光照下都成立）；
       *   ② 一点点方向感（幅度压到原来的约三分之一，只作暗示，偶尔撞了也不刺眼）。
       * 另：经度梯度按 cos(lat) 还原真实距离 —— 不做的话极点附近被 equirect 横向
       *     拉伸，|lat| > 70° 的阴影会糊成条纹（旧写法的可见畸变）。 */
      var jm = Math.max(0, j - 1), jp = Math.min(H - 1, j + 1);
      var cosLatJ = Math.max(0.15, Math.cos((j / (H - 1)) * Math.PI - Math.PI / 2));
      for (var i = 0; i < W; i++) {
        var idx = j * W + i;
        var hgt = clamp(field[idx], 0, 1);
        var hL = field[j * W + ((i - 1 + W) % W)], hR = field[j * W + ((i + 1) % W)];
        var hU = field[jm * W + i], hD = field[jp * W + i];
        var gx = (hR - hL) / cosLatJ, gy = hD - hU;
        /* 曲率 = 邻域均值 − 中心：谷底/坑底为正（凹），脊线/峰顶为负（凸） */
        var curv = (hL + hR + hU + hD) * 0.25 - hgt;
        var ao = clamp(1 - curv * 26 * pr.relief, 0.74, 1.26);
        var dir = clamp(1 - (gx * 0.62 + gy * 0.62) * 5 * pr.relief, 0.90, 1.10);
        var shade = ao * dir;
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
        /* 水下（v0.17 重做）：三段 —— 拍岸浅滩（透光见底，偏青绿并**提亮**）、
         * 陆架过渡、深海（吸收红光 → 压暗压蓝）。
         * ★ 旧写法 `dep = (seaA − h) / 0.30` 在 0.30 水深就**饱和**：薄曙 III 实测
         *   31.9% 的海洋像素已经是「同一片最暗的死蓝」，再深也毫无区别 —— 那片海
         *   因此看着像刷了一层蓝漆。现在改成 sqrt 压缩：浅处变化快（层次都堆在
         *   近岸，正是眼睛看得出深浅的地方），深处仍可分（饱和点推到 0.45 且非线性）。 */
        if (seaA > 0 && hgt < seaA) {
          /* ★ 变量名必须是 wd 而不是 d：`var` 是**函数作用域**，写成 var d 会把外层
           * 那个 ImageData.data（`d = img.data`，下面 `d[o] = r`）整个遮蔽掉 ——
           * 于是颜色数组变成 number，第一颗有海的行星就崩在 d[o] 上。 */
          var wd = seaA - hgt;
          var shallow = 1 - clamp(wd / 0.055, 0, 1);      /* 1 = 贴岸，0 = 深过陆架 */
          var deep = clamp(Math.sqrt(wd / 0.45), 0, 1);   /* 0 = 水面，1 = 最深 */
          r *= 1 - 0.46 * deep; gg *= 1 - 0.30 * deep; bb *= 1 - 0.08 * deep;
          var sw2 = shallow * shallow;                    /* 平方：只有紧贴岸线才泛绿 */
          r += (88 - r) * sw2 * 0.55; gg += (178 - gg) * sw2 * 0.55; bb += (172 - bb) * sw2 * 0.55;
        }

        var o = idx * 4;
        d[o] = r; d[o + 1] = gg; d[o + 2] = bb; d[o + 3] = 255;

        /* 镜面遮罩：海面满、冰与雪中等、裸岩近乎哑光。水下越深反光越弱（碎浪散光）。 */
        var specV = 26;
        if (seaA > 0 && hgt < seaA) specV = 255 - 46 * clamp((seaA - hgt) / 0.30, 0, 1);
        if (pr.snowH < 1 && hgt > pr.snowH) specV = Math.max(specV, 150);
        if (white > 0) specV = Math.max(specV, 40 + 150 * white);
        if (pr.prof.id === "ice" || pr.prof.id === "cryo") specV = Math.max(specV, 90);
        dS[o] = dS[o + 1] = dS[o + 2] = Math.round(specV); dS[o + 3] = 255;

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
    gS.putImageData(imgS, 0, 0);

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
    var texSpec = new THREE.CanvasTexture(cSpec);
    texMap.anisotropy = 4; texBump.anisotropy = 4; texSpec.anisotropy = 4;
    var out = { map: texMap, bumpMap: texBump, specularMap: texSpec, height: field, params: pr };
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
  if (hi.bumpMap) { m.bumpMap = hi.bumpMap; m.bumpScale = BUMP_K * clamp(hi.params.relief, 0.35, 1.4); }
  if (hi.specularMap) m.specularMap = hi.specularMap;
  if (hi.emissiveMap) m.emissiveMap = hi.emissiveMap;
  m.needsUpdate = true;
  p._surfHi = true;
  return true;
}
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
/* ================= 场景 ================= */
var systemGroup = new THREE.Group();
var systemT = 0;                  // 装饰动画时钟（真实秒）
var _tmpSunV = new THREE.Vector3();  /* v0.17：云壳每帧复用的临时量（世界坐标 → 指向恒星） */

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
    /* ★ v0.14：椭圆轨道 —— 参数 E 扫出的椭圆 X = a(cosE − e)、Z = a√(1−e²)·sinE
     * （恒星位于焦点；e=0 时退化成原来的圆，逐点相同）。 */
    var bAx = p.orbit * Math.sqrt(1 - p.ecc * p.ecc), ecc = p.ecc;
    for (var i = 0; i <= seg; i++) {
      var a = (i / seg) * Math.PI * 2;
      pts.push(new THREE.Vector3((Math.cos(a) - ecc) * p.orbit, 0, bAx * Math.sin(a)));
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
    /* ★ v0.17：固态行星从 Lambert 换成 Phong —— 唯一目的是拿到**高光通道**，
     * 让海面能出太阳耀斑（Lambert 没有 specular，海因此永远是一片哑光蓝 ——
     * 「像不像水」几乎全看这一条）。漫反射两者一致；只有带 specularMap 的行星
     * 才换，气态 / 熔岩照旧走 Lambert，不给它们凭空加反光。 */
    var mat = maps.specularMap
      ? new THREE.MeshPhongMaterial({ map: maps.map, specular: 0xdfeaf2, shininess: 78 })
      : new THREE.MeshLambertMaterial({ map: maps.map });
    if (maps.bumpMap) {
      /* 凹凸 = 同一个高程场（42-terrain.js 导出）—— 贴近时地形会被光照塑形。
       * 强度跟着「起伏」走：被大气磨平的世界不该有刀劈一般的阴影。
       * ★ v0.17 系数 0.19 → BUMP_K(0.42)：立体感的主力改由**实时光照**承担，
       *   贴图里那道烘死的固定方向阴影退居次要（见 buildTerrainMaps 的 shade）。 */
      mat.bumpMap = maps.bumpMap;
      mat.bumpScale = BUMP_K * clamp(maps.params.relief, 0.35, 1.4);
    }
    if (maps.specularMap) mat.specularMap = maps.specularMap;
    if (maps.emissiveMap) {
      mat.emissive = new THREE.Color(0xff9a4a);
      mat.emissiveMap = maps.emissiveMap;
      mat.emissiveIntensity = 1.1;
    }
    var mesh = new THREE.Mesh(new THREE.SphereGeometry(p.size, 32, 24), mat);
    /* 潮汐锁定：初始相位对齐 -(angle + π/2)（贴图日下点在 u=0.25 → 恒朝恒星），
     * 此后每帧按公转角速度增量推进（每帧自转注释里的「增量式」）。 */
    if (p.tidal) mesh.rotation.y = -(p.angle + Math.PI / 2);
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
    var cloudy = planetCloudy(p);
    if (cloudy) {
      /* ★ v0.17：云图改成**按行星各自生成**（cloudTexFor —— 零随机流，见 40-textures），
       * 材质换成带**临边增亮**的云材质（cloudMaterial）—— 旧版是 5 颗行星共用一张
       * 256×128 的圆斑图。球段数 24×18 → 48×32：云是这颗星的主视觉，24 段的多边形
       * 轮廓在近景一眼就看得出。 */
      var cloud = new THREE.Mesh(
        new THREE.SphereGeometry(p.size * 1.02, 48, 32),
        cloudMaterial(cloudTexFor(p), 0.25 + 0.5 * p.atmo)
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

    // 卫星（v0.14 重新上线）：数据由 34-moons.js 的 genMoons 登记 —— 这里只装配派生视觉
    buildMoonVisuals(p);

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
  sys._belt = null; sys._beltCount = 0; sys._beltRocks = null;
  if (gapR > 0) {
    /* ★ v0.14：陨石带重做（用户：「优化陨石带的陨石效果」）——
     *   ① 随机走**专属流**：场景装配原是 884 锚点之后唯一还在消耗主 RNG 的
     *      地方（150 块 × 7 抽）。抽数变化本身无害（锚点之后没人对账），但
     *      「场景不碰主序列」是更干净的不变量，与外围行星 / 卫星同一口径。
     *   ② 形状不再千篇一律：6 种**径向畸变**的岩体。畸变按**位置**哈希算
     *      （不用顺序流）：同一个角在多张面里各有一份顶点副本，只有按位置
     *      算才能让它们同步位移 —— 按顺序流会把接缝撕开（岩石不能漏气）。
     *   ③ 尺寸幂律：大量小碎石 + 少数大块（pow 2.2 重尾），不再粗细匀称。
     *   ④ **差速公转**：每块按自己的半径走开普勒序（内快外慢），带子会缓慢
     *      流动、剪切成弧，不再是整组刚体绕圈；顺带每块慢速自翻（tumble）。
     * 性能口径不变：150 网格 / 6 几何 / 3 材质（与重做前同量级 draw call），
     * 每帧 150 次三角函数 + 3 个欧拉角增量，远低于一帧预算。 */
    var belt = new THREE.Group();
    var beltMats = [
      new THREE.MeshLambertMaterial({ color: 0x8a8578 }),
      new THREE.MeshLambertMaterial({ color: 0x6f6a60 }),
      new THREE.MeshLambertMaterial({ color: 0x9a9488 })
    ];
    var br = seedStream(EXTRA_SEED, 0x8E17B0A5);
    var VARIANTS = 6, rockGeos = [];
    for (var v = 0; v < VARIANTS; v++) {
      var g0 = new THREE.DodecahedronGeometry(0.24, 0);
      var pos = g0.attributes.position;
      for (var vi = 0; vi < pos.count; vi++) {
        var vx = pos.getX(vi), vy = pos.getY(vi), vz = pos.getZ(vi);
        var hv = Math.sin(vx * 127.1 + vy * 311.7 + vz * 74.7 + v * 19.7) * 43758.5453;
        var kk = 1 + (hv - Math.floor(hv) - 0.5) * 0.5;
        pos.setXYZ(vi, vx * kk, vy * kk, vz * kk);
      }
      g0.computeVertexNormals();                 /* 非索引几何 → 逐面法线（裂面感是天生的棱角） */
      rockGeos.push(g0);
    }
    var count = 150, rocks = [];
    for (var bi = 0; bi < count; bi++) {
      var rock = new THREE.Mesh(rockGeos[Math.floor(br() * VARIANTS)], beltMats[Math.floor(br() * 3)]);
      var rr = gapR + (br() - 0.5) * 5.2;                  /* 径向铺满整道间隙 */
      var sc = 0.25 + Math.pow(br(), 2.2) * 1.25;          /* 幂律：小碎为主、大块稀少 */
      rock.scale.set(sc, sc * (0.6 + br() * 0.4), sc);
      rock.rotation.set(br() * 3, br() * 3, br() * 3);
      var rk = {
        m: rock,
        a: br() * Math.PI * 2,
        r: rr,
        y: (br() - 0.5) * 1.1,                              /* 盘很薄（与行星盘一致） */
        sp: 0.022 * Math.pow(gapR / rr, 1.5),               /* 差速：内快外慢（开普勒序） */
        tx: (br() - 0.5) * 0.22, ty: (br() - 0.5) * 0.22, tz: (br() - 0.5) * 0.22
      };
      rock.position.set(Math.cos(rk.a) * rr, rk.y, Math.sin(rk.a) * rr);
      belt.add(rock);
      rocks.push(rk);
    }
    sys._belt = belt;
    sys._beltRocks = rocks;
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

  /* ★ v0.12：聚焦地表的每帧裁决（见 44-focus-surface.js）——谁被聚焦谁亮、
   * 太阳方向随公转更新、首次聚焦现场构建。入口/出口都走这一条路。 */
  syncFocusSurface();

  sys.planets.forEach(function (p) {
    /* ★ v0.14：聚焦**不再冻结自转** —— 用户反馈「行星在被聚焦时完全停止了自转」，
     * 那不对：世界永远在转。自转照常推进；「对准的面不转走」改由**镜头一侧**
     * 解决 —— 相机以同行星自转的角速度**同向**绕行（同步卫星视角，99-boot 每帧读
     * p._rotDelta 后 orbit.theta **同向**等量推进 —— 方向写反会让面以 2 倍
     * 自转速度滑走，见 99-boot 的修正注）。于是面在画面上稳住，而自转可见于
     * 星空扫过 / 日下点推移 / 云层漂移 —— 既没停转，也不丢「对准的面」。 */
    p.angle += p.orbitSpeed * eff;
    /* ★ v0.14：椭圆轨道 —— M 均匀推进（开普勒均近点角），位置由 E − e·sinE = M
     * 解出（牛顿迭代 3 步）：x = a(cosE − e)（恒星位于焦点）、z = a√(1−e²)·sinE。
     * e=0 时 E ≡ M，位置与旧式**逐字节一致** —— 既有行星的轨道分毫不动。 */
    var ox = Math.cos(p.angle) * p.orbit, oz = Math.sin(p.angle) * p.orbit;
    p._E = p.angle;
    if (p.ecc > 0) {
      var E = p.angle;
      for (var it = 0; it < 3; it++) {
        E -= (E - p.ecc * Math.sin(E) - p.angle) / (1 - p.ecc * Math.cos(E));
      }
      p._E = E;
      ox = (Math.cos(E) - p.ecc) * p.orbit;
      oz = Math.sqrt(1 - p.ecc * p.ecc) * Math.sin(E) * p.orbit;
    }
    var ci = Math.cos(p.incl), si = Math.sin(p.incl);
    p._group.position.set(ox, oz * si, oz * ci);

    /* 自转：照常推进（不再有 frozen 分支）。潮汐锁定行星仍按「公转角速度」
     * 增量式推进（初始相位在 mesh 创建处对齐 -(angle + π/2)）。 */
    var dRot = p.tidal ? -p.orbitSpeed * eff : p.spin * eff;
    p._mesh.rotation.y += dRot;
    p._rotDelta = dRot;              /* 镜头同速随动的口径（99-boot 每帧读） */
    if (p._cloud) p._cloud.rotation.y += p.spin * 1.35 * eff;
    /* 云壳的太阳方向（世界系）：恒星在原点 → 由行星的世界坐标反推。
     * 云自己每帧在转（rotation.y），所以必须用**世界系**法线去点乘它 ——
     * 否则光照会跟着云一起转，晨昏线就钉死在贴图上了。 */
    if (p._cloud) {
      var cu = p._cloud.material.uniforms;
      if (cu && cu.uSun) {
        p._mesh.getWorldPosition(_tmpSunV);
        cu.uSun.value.copy(_tmpSunV).normalize().negate();
      }
    }

    /* 聚焦 = 沉浸观察地表：云与大气雾按相机模式淡出（否则半透明白雾
     * 正好糊在要看的表面上 —— v0.11 首版的「聚焦仍糊」就是它）。
     * base 存在 userData 上，退出聚焦原样恢复。 */
    if (p._cloud) {
      /* v0.17：云材质是 ShaderMaterial，不透明度在 uniform 里（uBase 记原值） */
      var cu2 = p._cloud.material.uniforms;
      if (cu2 && cu2.uOpacity) cu2.uOpacity.value = cu2.uBase.value * (FSM_CAMERA.is("focus") ? 0.30 : 1);
    }
    if (p._atmo) {
      if (p._atmo.userData.base === undefined) p._atmo.userData.base = p._atmo.material.uniforms.uRim.value;
      p._atmo.material.uniforms.uRim.value = p._atmo.userData.base * (FSM_CAMERA.is("focus") ? 0.55 : 1);
    }

    /* 聚焦地表（v0.12）：跟随贴图网格的同一自转；云壳独立漂移（比地表略快
     * 1.35 倍 —— 与贴图云同一口径），拉开「大气在动」的层次。
     * ★ v0.14：云壳不再冻结 —— 云在漂正是「世界在转」的可见信号之一。 */
    if (p._cs && p._cs.group.visible) {
      p._cs.mesh.rotation.y = p._mesh.rotation.y;
      if (p._cs.cloud) p._cs.cloud.rotation.y += p.spin * 1.35 * eff;
    }

    /* ★ v0.14：卫星环绕推进（34-moons.js；无卫星的行星零开销） */
    updateMoons(p, eff);

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

  /* 小行星带（v0.14）：每块差速公转 + 慢速自翻 —— 带子会缓慢流动、剪切成弧，
   * 不再是整组刚体绕圈（150 块的三角函数远低于一帧预算）。 */
  if (sys._beltRocks) {
    for (var ri = 0; ri < sys._beltRocks.length; ri++) {
      var rk = sys._beltRocks[ri];
      rk.a += rk.sp * eff;
      rk.m.position.set(Math.cos(rk.a) * rk.r, rk.y, Math.sin(rk.a) * rk.r);
      rk.m.rotation.x += rk.tx * eff;
      rk.m.rotation.y += rk.ty * eff;
      rk.m.rotation.z += rk.tz * eff;
    }
  }
}

/* ================= 恒星专章：耀斑 / 镜头光斑 ================= */

/* 耀斑：间歇性爆发（自动 + 手动触发），白热粒子向外喷发并淡出 */
function buildFlareSystem(sys, Rg, colorHex) {
  var N = 96;
  var geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(N * 3), 3));
  geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(N * 3), 3));
  var pts = new THREE.Points(geo, new THREE.PointsMaterial({
    map: glowTex, size: Rg * 0.15, sizeAttenuation: true,
    vertexColors: true, transparent: true,
    depthWrite: false, blending: THREE.AdditiveBlending
  }));
  pts.frustumCulled = false;
  pts.visible = false;
  systemGroup.add(pts);

  var flash = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTex, color: colorHex, transparent: true, opacity: 0,
    depthWrite: false, blending: THREE.AdditiveBlending
  }));
  flash.visible = false;
  systemGroup.add(flash);

  var data = [];
  for (var i = 0; i < N; i++) data.push({ vx: 0, vy: 0, vz: 0, life: 1 });
  sys._flare = {
    Rg: Rg, n: N, pts: pts, flash: flash, data: data,
    active: false, age: 0, dur: 2.2, flashDur: 0.5,
    origin: new THREE.Vector3(), fired: 0, col: rawColor(colorHex)
  };
}

function triggerFlare(sys) {
  var F = sys._flare;
  if (!F) return 0;
  var dir = new THREE.Vector3(srand(-1, 1), srand(-0.7, 0.9), srand(-1, 1)).normalize();
  F.origin.copy(dir).multiplyScalar(F.Rg * 1.02);
  F.flash.position.copy(F.origin);
  F.flash.visible = true;
  F.pts.visible = true;
  F.active = true;
  F.age = 0;
  F.fired++;
  var pos = F.pts.geometry.attributes.position;
  var cols = F.pts.geometry.attributes.color;
  for (var i = 0; i < F.n; i++) {
    var d = dir.clone();
    d.x += srand(-1.4, 1.4); d.y += srand(-1.4, 1.4); d.z += srand(-1.4, 1.4);
    d.normalize();
    var sp = srand(3.5, 11);
    var dd = F.data[i];
    dd.vx = d.x * sp; dd.vy = d.y * sp; dd.vz = d.z * sp;
    dd.life = srand(1.2, F.dur);
    pos.setXYZ(i, F.origin.x, F.origin.y, F.origin.z);
    cols.setXYZ(i, F.col.r, F.col.g, F.col.b);
  }
  pos.needsUpdate = true;
  cols.needsUpdate = true;
  sys._pulse = 1.7;
  return F.fired;
}

function updateFlare(sys, dt) {
  var F = sys._flare;
  if (!F || !F.active) return;
  F.age += dt;
  var pos = F.pts.geometry.attributes.position;
  var cols = F.pts.geometry.attributes.color;
  var maxLife = 0;
  for (var i = 0; i < F.n; i++) {
    var dd = F.data[i];
    var drag = Math.max(0, 1 - 0.9 * dt);
    dd.vx *= drag; dd.vy *= drag; dd.vz *= drag;
    pos.setXYZ(i, pos.getX(i) + dd.vx * dt, pos.getY(i) + dd.vy * dt, pos.getZ(i) + dd.vz * dt);
    var f = clamp(1 - F.age / dd.life, 0, 1);
    var b = Math.pow(f, 1.4);
    var mixw = clamp(F.age / dd.life + 0.15, 0, 1);   // 白热 → 恒星色
    cols.setXYZ(i,
      ((1 - mixw) * 1.0 + mixw * F.col.r) * b,
      ((1 - mixw) * 0.9 + mixw * F.col.g) * b,
      ((1 - mixw) * 0.85 + mixw * F.col.b) * b);
    if (dd.life > maxLife) maxLife = dd.life;
  }
  pos.needsUpdate = true;
  cols.needsUpdate = true;

  var fa = clamp(F.age / F.flashDur, 0, 1);
  if (fa < 1) {
    var sc = F.Rg * (2.2 + 3.4 * fa);
    F.flash.scale.set(sc, sc, 1);
    F.flash.material.opacity = 0.95 * (1 - fa);
  } else if (F.flash.visible) {
    F.flash.visible = false;
  }
  if (F.age > maxLife + 0.3) {
    F.active = false;
    F.pts.visible = false;
    F.flash.visible = false;
  }
}

/* 镜头光斑：恒星在画面上的「光学签名」——主光斑 + 对侧鬼影链。
 * v0.4.1：移除全屏横向拉丝（像屏幕上一道亮线，太扎眼），鬼影也整体调淡，
 * 只留克制、成链的 bokeh 光斑。 */
var lens = null;
var _lfV = new THREE.Vector3();

function buildLensFlare() {
  var group = new THREE.Group();
  camera.add(group);
  scene.add(camera);   // 相机挂进场景图后，其子对象（光斑）才会被渲染

  function mk(tex, color, opacity) {
    var sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, color: color, transparent: true, opacity: opacity,
      depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending
    }));
    sp.renderOrder = 999;
    group.add(sp);
    return sp;
  }

  lens = {
    group: group,
    main: mk(glowTex, 0xfff2d8, 0.4),
    ghosts: [
      { sprite: mk(ghostT, 0x9fd0ff, 0.22), k: -0.45, frac: 0.05, base: 0.22 },
      { sprite: mk(ghostT, 0xffc890, 0.17), k: -0.95, frac: 0.08, base: 0.17 },
      { sprite: mk(ghostT, 0x86c6a0, 0.13), k: -1.55, frac: 0.11, base: 0.13 }
    ],
    last: { visible: false, occl: 0, star: { x: 0, y: 0 }, ghosts: [] }
  };
}

/* ★ v0.11.1 光学修正：光源被行星挡住时，镜头光斑必须熄灭。
 * 真实相机里光斑产生于镜片内部的反射，前提是「光进得来」—— 前景行星把恒星
 * 完全挡在背后时，主光斑与鬼影链都不该出现在行星圆盘上。此前的实现是
 * depthTest:false + renderOrder 999 永远画在最顶层，亮斑「透过」星球，假。
 * 实现：屏幕空间圆盘遮挡 —— 恒星投影点落进行星的投影圆盘内（且行星在恒星
 * 更近侧）就算被挡；遮挡量 0..1 平滑过渡（行星边缘掠过时逐渐变暗，不跳变）。 */
function starOcclusion() {
  var occl = 0;
  var starN = projectToNdc(_zeroV);
  var asp = camera.aspect;
  var tanH = Math.tan((camera.fov * Math.PI) / 360);
  for (var i = 0; i < G.sys.planets.length; i++) {
    var pl = G.sys.planets[i];
    var pn = projectToNdc(pl._group.position);
    if (pn.z > starN.z) continue;            /* 行星在恒星更远侧，挡不住光 */
    var d = Math.hypot((starN.x - pn.x) * asp, starN.y - pn.y);
    var dist = camera.position.distanceTo(pl._group.position);
    var rp = pl.size / Math.max(dist * tanH, 0.001);   /* 行星投影半径（半高单位） */
    occl = Math.max(occl, clamp((rp * 1.02 - d) / (rp * 0.30), 0, 1));
  }
  return occl;
}

function updateLensFlare() {
  if (!lens) return;
  var ndc = projectToNdc(_zeroV);
  _lfV.copy(_zeroV).applyMatrix4(camera.matrixWorldInverse);
  var behind = _lfV.z > -1.0;
  var ed = Math.max(Math.abs(ndc.x), Math.abs(ndc.y));
  var fade = clamp((1.35 - ed) / 0.5, 0, 1);
  var occl = starOcclusion();
  fade *= (1 - occl);
  var vis = !behind && fade > 0.01;

  lens.last.visible = vis;
  lens.last.occl = +occl.toFixed(3);
  lens.last.star = { x: +ndc.x.toFixed(3), y: +ndc.y.toFixed(3) };
  lens.last.ghosts = [];

  var tanH = Math.tan((camera.fov * Math.PI) / 360);
  var D = 10;
  var worldH = 2 * tanH * D;          // 一屏高度对应的世界尺寸（D 深度处）

  function put(sp, nx, ny, w, h, opacity) {
    sp.position.set(nx * tanH * camera.aspect * D, ny * tanH * D, -D);
    sp.scale.set(w, h, 1);
    sp.material.opacity = opacity * fade;
    sp.visible = vis;
  }

  put(lens.main, ndc.x, ndc.y, 0.22 * worldH, 0.22 * worldH, 0.4);
  lens.ghosts.forEach(function (gh) {
    var gx = ndc.x * gh.k, gy = ndc.y * gh.k;   // 光学鬼影位于光源对侧
    var side = gh.frac * worldH;
    put(gh.sprite, gx, gy, side, side, gh.base);
    lens.last.ghosts.push({ x: +gx.toFixed(3), y: +gy.toFixed(3) });
  });
}

/* ================= 相机聚焦 ================= */

/* ★ v0.10：相机三态，距离分档全写在 applyCamera 这一处（free / follow / focus：
 *   全景 92 / 中距离 size×7+6 / 聚焦贴近 focusDistance()）。「跟随时必有目标、
 *   自由时必无目标」这条对应关系依旧只此一处，不会两档各说各话。
 * 注意分工：机器拥有的是 G.focusPlanet（跟不跟、跟谁）；camGoalRadius 只是**切换
 * 模式时的默认推距** —— 滚轮 / 双指缩放 / __game.zoomTo() 照样能改它，那是「看
 * 多远」，与模式无关。 */
function applyCamera(p) {
  var st = FSM_CAMERA.get();
  G.focusPlanet = st === "free" ? null : p;
  if (st === "focus") {
    /* 聚焦档：贴近 + 放宽 minR（否则 16 的底线会把推距钳死，根本贴不上去） */
    camGoalRadius = focusDistance(p);
    orbit.minR = Math.min(1.2, focusDistance(p) * 0.25);
  } else {
    orbit.minR = 16;                 /* ★ 退出聚焦必须恢复原底线，不泄漏 */
    camGoalRadius = st === "follow" ? clamp(p.size * 7 + 6, 16, 60) : 92;
  }
  renderFocusHud();                  /* HUD 是相机模式的投影（72-focus.js） */
}
/* 进入 / 退出聚焦由 72-focus.js 的 enterFocus / exitFocus 负责（它们会顺带
 * 升级该行星的高清地表）；这里只留「回全景」这一条直线出口。 */
function unfocusCamera() { return FSM_CAMERA.send("home"); }

/* ================= 输入：轨道相机 + 拾取 ================= */
var drag = null;

function projectToScreen(v3) {
  var v = v3.clone().project(camera);
  return { x: (v.x * 0.5 + 0.5) * window.innerWidth, y: (-v.y * 0.5 + 0.5) * window.innerHeight };
}
function projectToNdc(v3) {
  var v = v3.clone().project(camera);
  return { x: v.x, y: v.y, z: v.z };
}

var _mwTmp = new THREE.Vector3();   /* pickAt 的卫星世界坐标临时量（34-moons.js 的口径） */
function pickAt(cx, cy) {
  var bp = null, bpd = 34;
  G.sys.planets.forEach(function (pl) {
    var q = projectToNdc(pl._group.position);
    if (q.z > 1) return;                      /* 相机背后（v0.14 外围行星可飞出默认视距）：看不见，也不占拾取位 */
    var px = (q.x * 0.5 + 0.5) * window.innerWidth, py = (-q.y * 0.5 + 0.5) * window.innerHeight;
    var d = Math.hypot(px - cx, py - cy);
    if (d < bpd) { bpd = d; bp = pl; }
  });
  /* ★ v0.14：卫星拾取（嵌套聚焦的口子）—— 只有「当前聚焦目标所在系统」的卫星
   * 可点：聚焦行星时双击它的卫星 → 聚焦卫星；不聚焦时卫星不占拾取位，全景的
   * 既有行为一帧不变。阈值按视半径自适应（14px 下限），与母星的 34px 分开
   * 计分、谁离点击点近谁赢；被母星挡住的（背对半球）不参与。 */
  var bm = null, bmd = Infinity;
  var f = G.focusPlanet;
  var host = f ? (f._isMoon ? f.parent : f) : null;
  if (host && host._moons && host._moons.length) {
    var centre = host._group.position, c = camera.position;
    for (var i = 0; i < host._moons.length; i++) {
      var m = host._moons[i];
      if (!m._group) continue;
      var w = moonWorldPos(m, _mwTmp);
      var qm = projectToNdc(w);
      if (qm.z > 1) continue;                              /* 相机背后 */
      var rx = w.x - centre.x, ry = w.y - centre.y, rz = w.z - centre.z;
      var vx = c.x - centre.x, vy = c.y - centre.y, vz = c.z - centre.z;
      if (rx * vx + ry * vy + rz * vz <= 0) continue;      /* 背对母星：被挡着 */
      var mx = (qm.x * 0.5 + 0.5) * window.innerWidth, my = (-qm.y * 0.5 + 0.5) * window.innerHeight;
      var dm = Math.hypot(mx - cx, my - cy);
      if (dm < Math.max(14, apparentRadius(m.size, c.distanceTo(w)) * 1.15) && dm < bmd) { bmd = dm; bm = m; }
    }
  }
  if (bm && (!bp || bmd < bpd)) return { type: "moon", moon: bm };
  if (bp) return { type: "planet", planet: bp };
  // 恒星：按屏幕投影半径估算可点区域
  var sp = projectToScreen(_zeroV);
  var Rg = G.sys.starType.size * 2.1;
  var dist = camera.position.length();
  if (Math.hypot(sp.x - cx, sp.y - cy) < Math.max(apparentRadius(Rg, dist) * 1.05, 26)) return { type: "star" };
  return null;
}

function setupInput() {
  canvas.addEventListener("pointerdown", function (ev) {
    drag = { x: ev.clientX, y: ev.clientY, moved: 0, btn: ev.button };
    canvas.setPointerCapture(ev.pointerId);
    canvas.classList.add("dragging");
  });
  canvas.addEventListener("pointermove", function (ev) {
    if (drag) {
      var dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
      drag.moved += Math.abs(dx) + Math.abs(dy);
      drag.x = ev.clientX; drag.y = ev.clientY;
      /* v0.10：聚焦态灵敏度 ×0.32（inputScale）—— 贴着行星细看时，一格拖动
       * 只转一小步，方便对准地表某个角落；滚轮同理（指数化，可复合）。 */
      var s = inputScale();
      if (drag.btn === 2 || ev.shiftKey) {
        // 平移
        var panScale = orbit.radius * 0.0016 * s;
        var right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
        var up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
        orbit.target.addScaledVector(right, -dx * panScale).addScaledVector(up, dy * panScale);
      } else {
        orbit.theta -= dx * 0.005 * s;
        orbit.phi -= dy * 0.005 * s;
      }
    } else {
      canvas.classList.toggle("over", !!pickAt(ev.clientX, ev.clientY));
      /* ★ v0.13：选址模式 —— 光标跟随鼠标（落点 / 可建与否 / 评分预览） */
      if (siteModeOn()) siteUpdateCursor(ev.clientX, ev.clientY, false);
    }
  });
  canvas.addEventListener("pointerup", function (ev) {
    canvas.classList.remove("dragging");
    if (drag && drag.moved < 6) handleClick(ev.clientX, ev.clientY);
    drag = null;
  });
  canvas.addEventListener("pointerleave", function () {
    drag = null; canvas.classList.remove("dragging"); canvas.classList.remove("over");
  });
  canvas.addEventListener("wheel", function (ev) {
    ev.preventDefault();
    /* v0.10：聚焦态步进收窄（1.12 → 1.037）——  exponent 化让「收窄多少」可复合可读 */
    orbit.radius *= Math.pow(ev.deltaY > 0 ? 1.12 : 0.89, inputScale());
    camGoalRadius = clamp(orbit.radius, orbit.minR, orbit.maxR);
  }, { passive: false });
  canvas.addEventListener("dblclick", function (ev) {
    var hit = pickAt(ev.clientX, ev.clientY);
    if (hit && hit.type === "moon") {
      /* ★ v0.14：嵌套聚焦 —— 行星聚焦档里双击它的卫星 → 聚焦卫星
       * （选中先落到母行星：面板与选中效果始终给得出语境）。 */
      selectPlanet(hit.moon.parent);
      enterFocus(hit.moon);
    } else if (hit && hit.type === "planet") {
      selectPlanet(hit.planet);
      enterFocus(hit.planet);        /* v0.10：双击行星 = 聚焦（贴近档） */
    } else {
      if (hit && hit.type === "star") selectStar();
      unfocusCamera();               /* 双击空白：直接从任何一档回全景（home 全态可达） */
    }
  });
  canvas.addEventListener("contextmenu", function (ev) { ev.preventDefault(); });

  // 触屏：双指缩放
  var pinch = null;
  canvas.addEventListener("touchstart", function (ev) {
    if (ev.touches.length === 2) {
      pinch = Math.hypot(
        ev.touches[0].clientX - ev.touches[1].clientX,
        ev.touches[0].clientY - ev.touches[1].clientY
      );
    }
  }, { passive: true });
  canvas.addEventListener("touchmove", function (ev) {
    if (ev.touches.length === 2 && pinch) {
      var d = Math.hypot(
        ev.touches[0].clientX - ev.touches[1].clientX,
        ev.touches[0].clientY - ev.touches[1].clientY
      );
      orbit.radius *= pinch / Math.max(d, 1);
      camGoalRadius = clamp(orbit.radius, orbit.minR, orbit.maxR);
      pinch = d;
    }
  }, { passive: true });
  canvas.addEventListener("touchend", function () { pinch = null; });

  window.addEventListener("resize", function () {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  });
}

/* ================= 选中：星 / 行星 / 空 =================
 * ★ v0.7：三者互斥不再是「每个函数里记得补一句把别人清掉」，而是 FSM_SELECT 的
 * 状态本身 —— 三个函数退化成三个事件名，唯一一处赋值在 applySelect。
 * 谁想加第四种可选中对象（舰船 / 建筑），往表里加一行即可，互斥自动成立。 */
function applySelect(p) {
  var st = FSM_SELECT.get();
  G.selectedPlanet = st === "planet" ? p : null;
  G.selectedStar = st === "star";
  renderPanel();                       /* 面板是选中状态的投影（80-panel.js） */
}
function selectPlanet(p) { return FSM_SELECT.send("selectPlanet", p); }
function selectStar() { return FSM_SELECT.send("selectStar"); }
function clearSelection() { return FSM_SELECT.send("clear"); }

function handleClick(cx, cy) {
  /* ★ v0.13：选址模式开着时点击 = 承诺（放置聚落），不进「选中」语义 */
  if (siteModeOn() && handleSiteClick(cx, cy)) return;
  var hit = pickAt(cx, cy);
  if (hit && hit.type === "planet") selectPlanet(hit.planet);
  /* ★ v0.14：单击卫星 = 选中母行星（卫星是母行星的条目，面板给语境） */
  else if (hit && hit.type === "moon") selectPlanet(hit.moon.parent);
  else if (hit && hit.type === "star") selectStar();
  else clearSelection();
}

/* ================= 聚焦镜头（v0.10 新增） ================= */

/* 是什么：相机的第三态（FSM_CAMERA.focus）。双击行星进入 —— 相机贴近到行星
 * 占满画面约三分之二（「镜头内基本全是星球」），同时**操作精度提高一档**：
 * 旋转 / 平移 / 滚轮缩放的灵敏度全部收窄到 0.32 倍，方便贴着地表细看。
 *
 * ★ v0.14：聚焦目标从「行星」泛化到「行星或卫星」—— 行星聚焦档里双击它的
 * 卫星，同样进聚焦（贴近档）；Esc 从卫星回到**母行星**的聚焦档（exitFocus
 * 层层退出）。卫星没有连续地表 / 聚落（44 / 46 的 isSolidPlanet 门天然挡住），
 * 贴近看的是它的程序化贴图（34-moons.js 的 moonTexture）。
 *
 * 与 follow 的分工（v0.10 起三档距离，分档表在 applyCamera）：
 *   free    全景，半径 92
 *   follow  中距离跟随，行星占画面约 1/4 —— 看清它在哪
 *   focus   聚焦贴近，行星占画面约 2/3 —— 看清它本身
 * Esc / HUD 退出钮从 focus 回到 follow（还跟着，只是不贴了）；双击空白直接回全景。
 *
 * 三条约束：
 *   ① 聚焦距离 = 行星半径 × FOCUS_K，clamp 到 [1.6, 10.0] —— 与行星大小解耦，
 *      任何行星进来都占同样比例的画面（verify 按屏幕投影验算占比）；
 *      **带卫星的行星例外**：至少退到最大卫星轨道的 1.55 倍（FOCUS_MOON_K），
 *      否则卫星划出画面、点不到（v0.14）
 *   ② 聚焦档放宽 orbit.minR（否则 16 的底线把推距钳死，贴不上去）；退出必须
 *      恢复 16 —— 这条写在 applyCamera，不在这里各写一份
 *   ③ 距地表读数是**推导量**：(orbit.radius - p.size) / p.size，不另存状态；
 *      HUD 只投影它，相机一动读数自然跟着变
 * ★ v0.14 补：聚焦行星时若它有朝相机这侧的卫星，机位对准那颗卫星
 *   （aimFocusAtMoonSystem）；聚焦卫星时机位对准母星（aimFocusAtParent）——
 *   距离放宽只保证轨道在**水平**视野内，俯仰任意时轨道在屏上仍可能是竖椭圆
 *   （侧视一个水平面），卫星划出上下视野；对准之后卫星沿弧稳定可点。
 */
var FOCUS_K = 3.6;                 // 聚焦距离 = 行星半径 × 3.6（视角直径 ≈ 32°，占画面高约 2/3）
var FOCUS_MOON_K = 1.55;           // 有卫星的行星：至少退到最大卫星轨道半径的 1.55 倍
var MOON_VIEW_DIP = 0.3;           // 聚焦行星时镜头低于卫星轨道面的俯角（rad ≈ 17°，弧高 ≈ 289px）

/* ★ v0.14：带卫星的行星，聚焦距离还要容得下卫星轨道。卫星轨道 = 母星半径的
 * 2.1~2.9 倍，而 3.6R 的相机只能覆盖 1.68R 的水平视半径 —— 不放宽的话卫星
 * 一大半时间划出画面，「聚焦行星时双击它的卫星」这条交互就时灵时不灵
 * （实测：8 颗 front 卫星在 3.6R 下全部出屏）。取 max(3.6R, 1.55×最大轨道)：
 * 无卫星行星的口径一帧不变（3.6 铁律照旧），有卫星行星以「看得见卫星」优先。 */
function focusDistance(p) {
  var d = p.size * FOCUS_K;
  if (p._moons && p._moons.length) {
    var amax = 0;
    for (var i = 0; i < p._moons.length; i++) amax = Math.max(amax, p._moons[i].a);
    d = Math.max(d, amax * FOCUS_MOON_K);
  }
  return clamp(d, 1.6, 10.0);   /* 上限 10.0：容得下 1.55×最大卫星轨道（v0.14；无卫星行星 size×3.6 ≤ 8.52 从未触及） */
}

function enterFocus(p) {
  var ok = FSM_CAMERA.send("enter", p);
  /* ★ v0.12：固态行星首次聚焦时现场构建「立方球连续地表」（44-focus-surface.js），
   * 缓存在 p._cs —— 放在点击时刻构建而不是帧循环里，收尾动画不必等它。
   * 贴图网格的显隐由 syncFocusSurface（每帧一处裁决）接管。 */
  if (ok && p && isSolidPlanet(p)) ensureFocusSurface(p);
  /* ★ v0.14：机位对准（见两个 aim 函数）—— 聚焦行星 = 看它和它的卫星系；
   * 聚焦卫星 = 从母星方向看它（潮汐锁定那一面）。 */
  if (ok && p) {
    if (p._isMoon) aimFocusAtParent(p);
    else aimFocusAtMoonSystem(p);
  }
  return ok;
}

var _aimTmp = new THREE.Vector3();   /* aim* 的卫星/母星世界坐标临时量 */

/* 聚焦行星：机位对准一颗「朝相机这侧」的卫星 —— 相机落在它的径向外侧、
 * 高出轨道面 MOON_VIEW_DIP 俯角。距离放宽（FOCUS_MOON_K）只保证卫星轨道在
 * **水平**视野内；俯仰任意时轨道在屏上仍可能是竖椭圆（相机侧视一个水平面），
 * 卫星划出上下视野 —— DIP 俯角把轨道压成扁椭圆，卫星沿一条弧稳定划过母星
 * 盘上方（实测 ~310px，出盘且不出屏），全程可点（pickAt 实时投影，跟着鼠标
 * 即可）。没有 front 卫星时不对准（机位继承原视角）。
 * ★ 卫星**不**每帧钉屏：「卫星钉屏」（θ'≡公转角增量）与「面稳」（θ'≡−自转
 *   增量）数学互斥（差两个数量级，见 99-boot loop 的注）。卫星公转一圈
 *   26~63s，划出舒适区 3~7s —— 真实的天体运动，点它就跟鼠标。 */
function aimFocusAtMoonSystem(p) {
  if (!p._moons || !p._moons.length || !p._group) return false;
  var c = p._group.position, cam = camera.position;
  var vx = cam.x - c.x, vy = cam.y - c.y, vz = cam.z - c.z;
  for (var i = 0; i < p._moons.length; i++) {
    var m = p._moons[i];
    if (!m._group) continue;
    var w = moonWorldPos(m, _aimTmp);
    var dx = w.x - c.x, dy = w.y - c.y, dz = w.z - c.z;
    if (dx * vx + dy * vy + dz * vz <= 0) continue;      /* 背侧：这瞬对准它也会被母星挡 */
    orbit.theta = Math.atan2(dx, dz);
    orbit.phi = clamp(Math.atan2(Math.hypot(dx, dz), dy) + MOON_VIEW_DIP, 0.12, Math.PI - 0.12);
    return true;
  }
  return false;
}

/* 聚焦卫星：机位对准母星 —— 潮汐锁定 = 同一面永朝母星，从母星方向看卫星
 * 就是看到它「永远朝向母星」的那一面（月球正面的游戏语言）。
 * 聚焦卫星不跟踪任何天体（母星在卫星天空的方向由潮汐锁定天然固定）。 */
function aimFocusAtParent(moon) {
  var w = moonWorldPos(moon, _aimTmp);
  var p = moon.parent;
  if (!p || !p._group) return false;
  var c = p._group.position;
  var dx = c.x - w.x, dy = c.y - w.y, dz = c.z - w.z;
  orbit.theta = Math.atan2(dx, dz);
  orbit.phi = clamp(Math.atan2(Math.hypot(dx, dz), dy), 0.12, Math.PI - 0.12);
  return true;
}
function exitFocus() {
  /* Esc / 退出钮：回落中距离跟随（目标不变）。free 态下调它没有目标可跟，
   * 由调用方把关（键盘路由只在 focus 态接 Esc；按钮只在 HUD 可见时点得到）。
   * ★ v0.14：聚焦的是卫星 → Esc 回**上一级**（母行星的聚焦档）——
   * 与「卫星在行星被聚焦时可以被再次聚焦」配对：聚焦可以一层层进，
   * 退出也一层层出（卫星 → 行星 → 中距离跟随 → 全景）。 */
  if (!G.focusPlanet) return false;
  if (G.focusPlanet._isMoon) return enterFocus(G.focusPlanet.parent);
  return FSM_CAMERA.send("follow", G.focusPlanet);
}

/* 操作精度：聚焦态收窄到 0.32 倍（1 = 原样）。指数化让步进可复合。 */
function inputScale() { return FSM_CAMERA.is("focus") ? 0.32 : 1; }

/* 聚焦 = 沉浸观察：画面里就是那个天体本身，选中标记（科幻括号 / 细环）失去了
 * 意义 —— 它的作用是「在全景里指出被选中的是哪一颗」。故聚焦态下一律不画。
 * 两条更新线（行星 50-scene / 恒星 50-scene）都读这里，规则只有一份。 */
function selectionMarkVisible() { return !FSM_CAMERA.is("focus"); }

/* ---- HUD：聚焦模式的界面标识（顶部居中一条，见 index.html #focus-hud） ---- */
var elFocusHud = null, elFhName = null, elFhDist = null, elFhExit = null;
var fhLastDist = -1;

function setupFocusHud() {
  elFocusHud = $("focus-hud");
  elFhName = $("fh-name");
  elFhDist = $("fh-dist");
  elFhExit = $("fh-exit");
  if (elFhExit) elFhExit.addEventListener("click", exitFocus);
  renderFocusHud();
}

/* 显隐 + 名字：相机模式一切换就刷（applyCamera 调它） */
function renderFocusHud() {
  if (!elFocusHud) return;
  var on = FSM_CAMERA.is("focus") && !!G.focusPlanet;
  elFocusHud.classList.toggle("hidden", !on);
  if (elFhName) elFhName.textContent = on ? G.focusPlanet.name : "—";
  fhLastDist = -1;                 /* 强制下一次更新重写读数（换行星后读数必须变） */
}

/* 距地表读数：每帧调，但**节流** —— 变化不足 2% 不碰 DOM
 * （整段重绘会吃掉真实点击，这是面板「实时更新」条踩过的坑）。 */
function updateFocusHud() {
  if (!elFocusHud || elFocusHud.classList.contains("hidden")) return;
  var p = G.focusPlanet;
  if (!p) return;
  var d = (orbit.radius - p.size) / p.size;
  if (fhLastDist >= 0 && Math.abs(d - fhLastDist) / Math.max(d, 0.01) < 0.02) return;
  fhLastDist = d;
  elFhDist.textContent = "距地表 " + d.toFixed(1) + " 半径";
}
/* ================= 右侧信息面板（选中天体时展开） ================= */
var elPanel = null, elPName = null, elPSub = null, elPDot = null, elPRows = null, elPActions = null;
var elPTabs = null, elPCiv = null, elPRes = null;   /* v0.8 标签栏 + v0.9 资源页容器 */

function panelRow(k, v) {
  return '<div class="p-row"><span class="k">' + k + '</span><span class="v">' + v + "</span></div>";
}
function panelBtn(label) {
  return '<button class="p-btn" disabled>' + label + "<span>开发中</span></button>";
}
var PANEL_NOTE = '<div class="p-note">更多操作将在后续版本解锁</div>';

/* 恒星面板：按 klass 生成科学数据行（取值均落在真实科学区间） */
var KLASS_SUB = { ms: "恒星", giant: "恒星", supergiant: "恒星", bd: "亚恒星", wd: "致密天体", ns: "致密天体", bh: "致密天体" };
var SUP = { "-": "⁻", "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹" };
function sciStr(v) {
  var m = v.toExponential(1).split("e");
  var exp = String(Math.abs(+m[1])).split("").map(function (c) { return SUP[c] || c; }).join("");
  return m[0] + " × 10" + (m[1][0] === "-" ? SUP["-"] : "") + exp;
}
function fmtLum(v) {
  if (!v) return "—";
  return (v >= 0.01 ? String(v) : sciStr(v)) + " L☉";
}
function fmtRadius(rs) {
  if (rs >= 0.01) return rs + " R☉";
  return "≈ " + fmtNum(Math.round(rs * 696340)) + " km";
}
function starRows(st) {
  if (st.klass === "bh") {
    return panelRow("类别", "恒星级黑洞（事件视界）") +
      panelRow("质量", st.massSol + " M☉") +
      panelRow("视界半径", fmtRadius(st.radiusSol)) +
      panelRow("温度", "霍金辐射 ≈ 10⁻⁸ K（可忽略）") +
      panelRow("光度", "无固有辐射（吸积时除外）") +
      panelRow("活动性", st.mat.act);
  }
  if (st.klass === "ns") {
    return panelRow("类别", "脉冲星（中子星）") +
      panelRow("表面温度", "≈ " + fmtNum(st.tempK) + " K（X 射线）") +
      panelRow("半径", fmtRadius(st.radiusSol)) +
      panelRow("质量", st.massSol + " M☉") +
      panelRow("光度", fmtLum(st.lumSol) + "（以 X 射线为主）") +
      panelRow("活动性", st.mat.act);
  }
  return panelRow("光谱型", st.spec) +
    panelRow("表面温度", fmtNum(st.tempK) + " K") +
    panelRow("半径", fmtRadius(st.radiusSol)) +
    panelRow("质量", st.massSol + " M☉") +
    panelRow("光度", fmtLum(st.lumSol)) +
    panelRow("活动性", st.mat.act);
}

/* ---- 行星面板：全部数值来自 planetPhysics 的计算结果 ----
 * 面板不存任何天文数字：半径/质量/重力/温度/周期都是现场从公式算出来的，
 * 因此换成别的恒星（setStarType）后面板会立刻反映新的辐照与温度。 */
var PANEL_SEC = function (t) { return '<div class="p-sec">' + t + "</div>"; };
function fmtK(K) {
  return fmtNum(Math.round(K)) + " K（" + (K - 273.15 >= 0 ? "+" : "") + Math.round(K - 273.15) + " ℃）";
}
function fmtMass(mE) {
  var s = mE >= 1e4 ? sciStr(mE) : (mE >= 100 ? fmtNum(Math.round(mE)) : mE.toFixed(2));
  return s + " M⊕" + (mE >= 100 ? "（" + (mE / 317.8).toFixed(2) + " M♃）" : "");
}
function fmtPeriod(days) {
  return days >= 800 ? (days / 365.25).toFixed(1) + " 年" : fmtNum(+days.toFixed(1)) + " 天";
}
/* 行星处于哪条温度带（液态水窗口 = 宜居带） */
function zoneOf(T) {
  return T < 273 ? "冻结带（水冰稳定）" : (T > 373 ? "过热带（水无法液态存在）" : "宜居带（液态水可存在）");
}
/* 构成行的显示串：直接读 buildComposition 的结果（整数百分比，和恰好 100） */
function composeOf(p) {
  return p.comp.map(function (a) { return a[0] + " " + a[1] + "%"; }).join(" · ");
}
function planetRows(p) {
  var hz = (p.tempSurf >= 273 && p.tempSurf <= 373);
  return PANEL_SEC("物理量") +
    panelRow("分类", p.type.name) +
    panelRow("半径", fmtNum(Math.round(p.radiusKm)) + " km（" + p.rE.toFixed(2) + " R⊕）") +
    panelRow("质量", fmtMass(p.mE)) +
    panelRow("构成", composeOf(p)) +
    panelRow("平均密度", p.dens.toFixed(2) + " g/cm³") +
    panelRow("表面重力", p.g.toFixed(2) + " m/s²（" + (p.g / 9.807).toFixed(2) + " g）") +
    panelRow("逃逸速度", p.vEsc.toFixed(2) + " km/s") +
    PANEL_SEC("轨道") +
    panelRow("轨道半径", (p.au < 0.1 ? p.au.toFixed(4) : p.au.toFixed(3)) + " AU") +
    panelRow("公转周期", fmtPeriod(p.periodDays)) +
    panelRow("轨道速度", p.vOrbit.toFixed(1) + " km/s") +
    panelRow("恒星辐照", (p.insol >= 0.01 ? p.insol.toFixed(2) : sciStr(p.insol)) + " × 地球") +
    PANEL_SEC("自转与大气") +
    panelRow("自转周期", p.tidal ? "潮汐锁定（与公转同步）" : p.rotH.toFixed(1) + " 小时") +
    panelRow("平衡温度", fmtK(p.teq)) +
    panelRow("表面温度", fmtK(p.tempSurf)) +
    panelRow("温度带", zoneOf(p.tempSurf) + (hz ? "" : "")) +
    panelRow("大气", p.type.atmo) +
    panelRow("表面", p.type.surface);
}

/* ---- 标签页（v0.8 起，v0.9 扩三页）：行星 / 资源 / 文明 ----
 * 标签栏出现在**所有行星**上（资源页人人有）；「文明」钮只在发源地行星上出现。
 * 机器在 25-fsm.js（FSM_PANEL）。本文件负责三件事：
 *   setupPanelTabs  事件源：真点击标签按钮 → 发事件（可用性守卫也在这里）
 *   civRows / matRows  页面内容（全部现读注册表与行星字段，不缓存）
 *   applyPanelTab   把 DOM 刷成与「机器状态 + 当前选中」一致（机器的副作用）
 * 另有一条回落规则：页面不可用（切换选中 / 换恒星后发源地搬走 / 取消选中）时，
 * syncPanelTab 替用户把机器按回 planet ——「机器 = DOM」的对账因此永远成立。
 * 折叠（收起 / 展开）也在这个片段：它不是状态机，是**视图偏好**，见下方注释。 */
function setupPanelTabs() {
  elPTabs = $("p-tabs");
  elPCiv = $("p-civ");
  elPRes = $("p-res");
  setupPanelFold();   /* 面板的两处装配（标签栏 + 收起钮）都在本片段接线 —— 能少碰启动片段就少碰 */
  if (!elPTabs) return;
  elPTabs.addEventListener("click", function (e) {
    var b = e.target.closest ? e.target.closest("[data-tab]") : null;
    if (!b) return;
    var tab = b.getAttribute("data-tab");
    if (tab === "civ") {
      if (!civOf(G.selectedPlanet)) return;    /* 事件源守卫：不可用不发事件 */
      FSM_PANEL.send("showCiv");
    } else if (tab === "res") {
      if (!G.selectedPlanet) return;           /* 资源页只对行星 */
      FSM_PANEL.send("showRes");
    } else {
      FSM_PANEL.send("showPlanet");
    }
  });
}
function civRows(civ) {
  var sp = Species.get(civ.speciesId) || { name: "?", sci: "?", desc: "" };
  var fit = civ.fit;
  var rows = PANEL_SEC("文明") +
    panelRow("名称", civ.name) +
    panelRow("物种", sp.name + "（" + sp.sci + "）") +
    panelRow("发源地", civ.home.name) +
    PANEL_SEC("摇篮评估") +
    panelRow("适居评分", fit.total + " / 100");
  fit.parts.forEach(function (part) {
    rows += panelRow(part.k, part.v + " / " + part.max + " · " + part.note);
  });
  rows += '<div class="p-note">' + fit.report + "</div>";
  if (sp.desc) rows += '<div class="p-note">' + sp.desc + "</div>";
  return rows;
}
/* 资源页（v0.9）：两本账 = 可采（主）/ 蕴藏（辅，灰）。
 * 行 = 有量的大类（物资表序）；零量类收成一行；页脚口径说明。
 * ★ 可采与蕴藏相等（表层全取）时只显示一个数 —— 相等的东西不摆两次。 */
function matRows(p) {
  var m = materialsOf(p);
  var rows = PANEL_SEC("资源") +
    '<div class="p-note">单位物资（1 = 10²¹ kg）· 工程等级 ' + ENGINEERING.name + "</div>";
  m.rows.forEach(function (r) {
    var val = matUnits(r.extKg);
    if (r.extKg < r.holdKg * 0.9995) {
      val += ' / <span class="p-dim">' + matUnits(r.holdKg) + "</span>";
    }
    rows += panelRow(r.label, val);
  });
  if (m.zero.length) rows += '<div class="p-note">零量：' + m.zero.join(" · ") + "</div>";
  rows += '<div class="p-note">蕴藏 = 行星物质总量 · 可采 = 按位置可及折算 —— 随工程提升，可采只增不减</div>';
  return rows;
}
function applyPanelTab() {
  if (!elPanel || !elPTabs || !elPCiv || !elPRes) return;
  var p = G.selectedPlanet;
  var civ = p ? civOf(p) : null;
  var st = FSM_PANEL.get();
  var showCiv = !!civ && st === "civ";
  var showRes = !!p && st === "res";
  elPTabs.classList.toggle("hidden", !p);            /* 标签栏：所有行星都有（行星 / 资源 / 文明） */
  elPCiv.classList.toggle("hidden", !showCiv);
  elPRes.classList.toggle("hidden", !showRes);
  elPRows.classList.toggle("hidden", showCiv || showRes);   /* 三页互斥：一次只显示一页 */
  var tabs = elPTabs.querySelectorAll(".p-tab");
  for (var i = 0; i < tabs.length; i++) {
    var key = tabs[i].getAttribute("data-tab");
    tabs[i].classList.toggle("hidden", key === "civ" && !civ);   /* 文明钮只对发源地出现 */
    tabs[i].classList.toggle("on", key === (showRes ? "res" : (showCiv ? "civ" : "planet")));
  }
}
function syncPanelTab() {
  var p = G.selectedPlanet;
  var civ = p ? civOf(p) : null;
  if (FSM_PANEL.is("civ") && !civ) FSM_PANEL.send("showPlanet");   /* 文明页不可用 → 回落行星页 */
  if (FSM_PANEL.is("res") && !p) FSM_PANEL.send("showPlanet");     /* 资源页失去行星 → 回落行星页 */
  applyPanelTab();
}

/* ---- 折叠（收起 / 展开）：**整条面板向右侧收进去**，右边缘留一枚标签页 ----
 * 两个入口各管一个方向（不互相兼职）：
 *   收起  标题条右端的「收起 →」（#p-fold），箭头指着收进去的方向；只负责收。
 *   展开  右边缘的标签坞 #p-dock 里那一枚竖排标签页（.dock-tab[data-panel=info]）；
 *         点它把面板拉出来。坞里现在只有「信息面板」一枚，**多面板就往坞里加标签** ——
 *         显隐与样式都不用改（CSS 见 style.css；分派看 data-panel）。
 * 收法：整条面板滑出视口右边缘（内容不隐藏、只是收到屏幕外，宽高与滚动位置原样留着）。
 * 方向是横向的：面板在右侧，收起来的方向就该是右侧 —— 竖着收会留下一条 312px 宽的
 * 横条，照样横占画面（第一版做法，已否）。
 *
 * ★ 与「面板退场」是两件事，别混：
 *     未选中 → .hidden，整条面板退场（opacity 0 + 不接指针）—— 那是 FSM_SELECT 的投影；
 *     折叠   → .folded，选中着但用户把面板收到右边去了 —— 这是**视图偏好**。
 *   所以：① 它不进 FSM_PANEL（那台机器管的是「哪一页」，不是「在不在屏内」）；
 *        ② 它不随选中项变化复位 —— 用户关掉的东西不该自己弹回来。换目标时
 *           renderPanel 照常改写内容，只是还收在屏外。
 *   想让「选中新目标即自动展开」，在 renderPanel() 里加一行 setPanelFold(false) 即可。
 * ③ 标签坞的显隐**不归 JS 管**：#panel.folded:not(.hidden) ~ #p-dock 一条 CSS 搞定 ——
 *   于是「没选中」时整坞自动跟着退场（否则会出现「点开一个空面板」）。 */
var panelFolded = false;

function applyPanelFold() {
  if (!elPanel) return;
  elPanel.classList.toggle("folded", panelFolded);
}
function setPanelFold(on) { panelFolded = !!on; applyPanelFold(); return panelFolded; }
function togglePanelFold() { return setPanelFold(!panelFolded); }
function setupPanelFold() {
  var elFold = $("p-fold");
  if (elFold) elFold.addEventListener("click", togglePanelFold);
  var dock = $("p-dock");
  if (dock) {
    dock.addEventListener("click", function (e) {
      var t = e.target.closest ? e.target.closest(".dock-tab") : null;
      if (!t) return;
      /* 坞里现在只有信息面板一枚；多面板时按 data-panel 分派到各自的展开动作 */
      if (t.getAttribute("data-panel") === "info") togglePanelFold();
    });
  }
  applyPanelFold();          /* 初刷：DOM 与 panelFolded 对齐（默认展开） */
}

function renderPanel() {
  if (!elPanel) return;
  var p = G.selectedPlanet;
  if (!p && !G.selectedStar) {
    elPanel.classList.add("hidden");
    elPanel.dataset.kind = "none";
    elPanel.dataset.name = "";
    syncPanelTab();
    return;
  }
  elPanel.classList.remove("hidden");
  if (G.selectedStar) {
    var st = G.sys.starType;
    elPanel.dataset.kind = "star";
    elPanel.dataset.name = G.sys.name;
    elPName.textContent = G.sys.name;
    elPSub.textContent = (KLASS_SUB[st.klass] || "恒星") + " · " + st.name;
    elPDot.style.background = cssOf(st.color);
    elPRows.innerHTML = starRows(st);
    elPActions.innerHTML = panelBtn("部署恒星探测器") + panelBtn("建立能量采集阵列") + PANEL_NOTE;
    syncPanelTab();
    return;
  }
  elPanel.dataset.kind = "planet";
  elPanel.dataset.name = p.name;
  elPName.textContent = p.name;
  elPSub.textContent = "行星 · " + p.type.name + (p.tidal ? " · 潮汐锁定" : "");
  elPDot.style.background = cssOf(p.type.color);
  elPRows.innerHTML = planetRows(p);
  elPActions.innerHTML = panelBtn("派遣勘探队") + panelBtn("规划地表据点") + PANEL_NOTE;
  var civ = civOf(p);
  elPRes.innerHTML = matRows(p);
  elPCiv.innerHTML = civ ? civRows(civ) : "";
  syncPanelTab();
}

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
    } else if (FSM_CAMERA.is("focus") && (e.key === "b" || e.key === "B")) {
      setSiteMode(!siteModeOn());          /* ★ v0.13：聚焦中 B 键进出「聚落选址模式」 */
    }
    /* 其余情况键盘归场景 */
  });
}

/* ================= 主循环 ================= */
var lastT = 0;
var _fLead = new THREE.Vector3();   /* 相机跟随的「前馈目标点」（临时，见 loop 内注释） */
var _fprev = new THREE.Vector3();   /* 聚焦目标上一帧位置（前馈算速度用） */

function loop(tms) {
  var dt = Math.min((tms - lastT) / 1000, 0.1);
  lastT = tms;
  __frames++;

  updateScene(G.sys, dt);

  /* ★ v0.14：聚焦档「镜头与目标同速绕行」—— 自转**永不冻结**（世界永远在转），
   * 「对准的面不转走」由镜头一侧兑现：每帧把目标自转的增量等量补给相机方位角
   * （同步卫星视角）。面在画面上稳住，而自转可见于星空扫过 / 日下点推移 /
   * 云层漂移 —— 既没停转，也不丢「对准的面」。（v0.12.1 的「冻结自转」把
   * 世界摁停了，用户实测反馈「行星被聚焦时完全停止了自转」—— 那条路已废。）
   * 只作用于聚焦档：中距离跟随本来就该看见行星在转。
   * ★★ 方向（v0.14.1 修正，初版写反了）：是 **θ += rotDelta**（同向），不是 −=。
   * 推导：three.js 的 rotation.y += β 绕 +Y 正向转 → 面上固定点的世界方位
   * = α + β；屏幕上该点的水平角 = 点方位 − 相机方位 θ。要它稳，必须
   * dθ ≡ dβ ≡ rotDelta。写成 −= 时 θ 与 rotY 反向等量，屏幕上点以 **2 倍
   * 自转速度**滑走（实测 ~69px/s）—— [23] 的聚落点击踩中它：选点时是可建
   * 陆地，0.7s 后滑进海里（「不可建：海面」），贴地偏差 24.7px。 */
  if (FSM_CAMERA.is("focus") && G.focusPlanet && G.focusPlanet._rotDelta) {
    orbit.theta += G.focusPlanet._rotDelta;
  }

  // 相机：聚焦行星时平滑跟随；半径趋近目标值（双击聚焦/拉远都是平滑过渡）
  if (G.focusPlanet && G.focusPlanet._group) {
    var fpos = focusWorldPos(_fwTmp);      /* ★ v0.14：目标可能是卫星（世界坐标，34-moons.js） */
    var focusMode = FSM_CAMERA.is("focus");
    /* 聚焦档跟得更紧：贴近时行星公移一点、视角变化就很大（dt*5.5 vs 中距离 3.2） */
    var k = focusMode ? 5.5 : 3.2;
    if (focusMode && orbit.target.distanceToSquared(fpos) < 2.25) {
      /* ★ v0.12.2：收敛后启用「速度前馈」—— lerp 追匀速圆周目标的稳态滞后
       * = v/k（实测内圈行星 0.44 units ≈ 屏幕上 ~70px 的缓慢绕圈，行星不在
       * 画面正中）。目标点前移 v/k 后稳态误差归零：行星钉住画面中心，画面里
       * 在动的只有背景星空 ——「镜头随星球一起运动」。
       * v 用上一帧位移：与分母 dt*k 同源相除，dt 数学上抵消、无帧率噪声。
       * ★ v0.14：再补**二阶项**（向心加速度 a = −v²/R³·r，R = 公转半径）——
       * 一阶前馈只对匀速直线目标严格成立，圆周运动还剩 a/k² 的残差
       * （实测 ~6px，[23] 的聚落点击正踩它：站点在海岸附近时，6px 滑移
       * 就把落点从陆地送进海里 ——「不可建：海面」）。二阶补齐后行星
       * 钉在中心到亚像素级，「面稳」才是真稳（ecc>0 的行星速度真变，
       * 二阶是近似，但残差从一阶量级掉到三阶）。 */
      var dtk = Math.max(dt * k, 1e-4);
      var vx = (fpos.x - _fprev.x) / dtk, vy = (fpos.y - _fprev.y) / dtk, vz = (fpos.z - _fprev.z) / dtk;
      var R2 = fpos.x * fpos.x + fpos.y * fpos.y + fpos.z * fpos.z;
      var v2 = vx * vx + vy * vy + vz * vz;
      var accK = R2 > 1e-6 ? -v2 / (R2 * Math.sqrt(R2) * (k * k)) : 0;
      _fLead.set(
        fpos.x + vx + accK * fpos.x,
        fpos.y + vy + accK * fpos.y,
        fpos.z + vz + accK * fpos.z
      );
      orbit.target.lerp(_fLead, Math.min(1, dt * k));
    } else {
      orbit.target.lerp(fpos, Math.min(1, dt * k));
    }
    _fprev.copy(fpos);
  } else if (!G.holdTarget) {
    orbit.target.lerp(_zeroV, Math.min(1, dt * 2.2));
  }
  orbit.radius += (camGoalRadius - orbit.radius) * Math.min(1, dt * 4);
  applyOrbit(camera, orbit);
  syncSettlements();           /* ★ v0.13：选址光标跟随 + 聚落 HUD 防抖刷新（46） */
  updateFocusHud();            /* 聚焦 HUD 的距地表读数（内部按变化率节流，不每帧碰 DOM） */
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}

/* ================= 启动 ================= */
function boot() {
  elPanel = $("panel");
  elPName = $("p-name");
  elPSub = $("p-sub");
  elPDot = $("p-dot");
  elPRows = $("p-rows");
  elPActions = $("p-actions");
  setupPanelTabs();

  /* 右下角版本戳：写不出不影响任何玩法，纯给「页面是否最新」一个肉眼答案 */
  var elVer = $("ver");
  if (elVer) elVer.textContent = "v" + VERSION;

  buildTextures();
  G.sys = genSystem();
  /* ★ v0.8：文明成立（选址 + 登记，纯数据、不碰场景）—— 必须在体检之前，
   * 下面是**一次**覆盖全部五张表（恒星 / 行星 / 物种 / 物资 / 文明）的体检。 */
  foundCivilizations(G.sys);

  /* ★ v0.7 起的注册表体检，v0.8 挪到「全部表都建好、搭场景之前」：
   * 任何一张表有脏数据都要先出声。问题是「记录 + console.error」而不是 throw：
   * 加载期抛异常 = 整页白屏，连 __game 都没有，反而无从排查。
   * verify 的「零 console error」会把它变红灯。 */
  auditRegistries();

  buildBackdrop();
  buildScene(G.sys);
  syncCivBeacons();          // 发源地信标（场景就绪之后才有 _group 可挂）
  buildLensFlare();
  setupInput();
  setupGuide();
  setupFocusHud();             /* 聚焦 HUD（v0.10）：按钮 + 初刷 */
  setupSitePanel();            /* 聚焦操作面板（v0.15 · 实验：建城）：按钮 + 初刷 */
  renderPanel();
  requestAnimationFrame(loop);

  /* ---- 调试 / 测试 API（供 Playwright 断言） ---- */
  window.__game = {
    ready: true,
    version: VERSION,
    getState: function () {
      return {
        frames: __frames,
        system: G.sys.name,
        starType: G.sys.starType.name,
        starId: G.sys.starType.id,
        starRoll: G._starRoll,
        rngDraws: G._starDraws,          // 确定性锚点：抽到星型时主 RNG 已抽次数
        planets: G.sys.planets.map(function (p) {
          return {
            name: p.name, type: p.type.name, size: +p.size.toFixed(2), orbit: +p.orbit.toFixed(1),
            ecc: p.ecc, moons: (p._moons || []).length      /* ★ v0.14：偏心率 + 卫星数 */
          };
        }),
        selectedPlanet: G.selectedPlanet ? G.selectedPlanet.name : null,
        focus: G.focusPlanet ? G.focusPlanet.name : null
      };
    },
    sceneStats: function () {
      var s = G.sys;
      return {
        star: !!s._star,
        planets: s.planets.length,
        textured: s.planets.filter(function (p) { return !!(p._mesh && p._mesh.material.map); }).length,
        clouds: s.planets.filter(function (p) { return !!p._cloud; }).length,
        rings: s.planets.filter(function (p) { return !!p._ring; }).length,
        moons: G.sys.planets.reduce(function (n, p) { return n + (p._moons ? p._moons.length : 0); }, 0),
        atmo: s.planets.filter(function (p) { return !!p._atmo; }).length,
        beltRocks: s._beltCount || 0,
        hzLines: (s._hzLines || []).length,
        civRings: s.planets.filter(function (p) { return !!p._civRing; }).length,
        ships: (s._ships || []).length,
        station: !!s._station,
        platform: !!s._platform,
        comet: !!s._comet
      };
    },
    cameraState: function () {
      return {
        radius: +orbit.radius.toFixed(2),
        goal: +camGoalRadius.toFixed(2),
        theta: +orbit.theta.toFixed(3),
        phi: +orbit.phi.toFixed(3),
        mode: FSM_CAMERA.get(),
        focus: G.focusPlanet ? G.focusPlanet.name : null,
        /* ★ v0.14：聚焦目标是不是卫星（嵌套聚焦）—— 面板 / HUD / 判据都读这一个口 */
        focusIsMoon: !!(G.focusPlanet && G.focusPlanet._isMoon),
        /* 距地表读数（推导量，与 HUD 同源）：(radius - 行星半径) / 行星半径 */
        surface: G.focusPlanet ? +((orbit.radius - G.focusPlanet.size) / G.focusPlanet.size).toFixed(2) : null,
        minR: orbit.minR,
        target: { x: +orbit.target.x.toFixed(2), y: +orbit.target.y.toFixed(2), z: +orbit.target.z.toFixed(2) }
      };
    },
    planetScreenPos: function (name) {
      for (var i = 0; i < G.sys.planets.length; i++) {
        if (G.sys.planets[i].name === name) {
          var q = projectToNdc(G.sys.planets[i]._group.position);
          return {
            x: Math.round((q.x * 0.5 + 0.5) * window.innerWidth),
            y: Math.round((-q.y * 0.5 + 0.5) * window.innerHeight),
            /* NDC 深度：>1 = 在相机背后（v0.14 外围行星可飞出默认视距 92，
             * 那时它的屏幕投影是镜像的 —— 拾取 / 找空白点都要先问这一问） */
            z: +q.z.toFixed(3)
          };
        }
      }
      return null;
    },
    planetWorldPos: function (name) {
      for (var i = 0; i < G.sys.planets.length; i++) {
        if (G.sys.planets[i].name === name) {
          var v = G.sys.planets[i]._group.position;
          return { x: +v.x.toFixed(2), y: +v.y.toFixed(2), z: +v.z.toFixed(2) };
        }
      }
      return null;
    },
    planetAngle: function (name) {
      for (var i = 0; i < G.sys.planets.length; i++) {
        if (G.sys.planets[i].name === name) return +G.sys.planets[i].angle.toFixed(4);
      }
      return null;
    },
    shipPositions: null,   // 交通船已随 v0.5 移除，此接口随之下线
    selectPlanetByName: function (name) {
      for (var i = 0; i < G.sys.planets.length; i++) {
        if (G.sys.planets[i].name === name) { selectPlanet(G.sys.planets[i]); return true; }
      }
      return false;
    },
    clearSelection: clearSelection,
    focusPlanetByName: function (name) {
      for (var i = 0; i < G.sys.planets.length; i++) {
        if (G.sys.planets[i].name === name) {
          selectPlanet(G.sys.planets[i]);
          return enterFocus(G.sys.planets[i]);       /* 聚焦（相机第三态），不是中距离跟随 */
        }
      }
      return false;
    },
    unfocus: unfocusCamera,
    /* ---- v0.14 卫星观测点 ----
     * moons(name)：某行星的全部卫星 —— 数据（尺寸 / 轨道半径 / 角速度 / 相位）、
     * 世界坐标与屏幕坐标、网格自转相位、以及「是否在母星朝向相机的半球」
     * （背面那颗被母星挡着，拾取与可见性判定都读它）。 */
    moons: function (name) {
      var p = null, i;
      for (i = 0; i < G.sys.planets.length; i++) {
        if (G.sys.planets[i].name === name) { p = G.sys.planets[i]; break; }
      }
      if (!p || !p._moons) return null;
      return p._moons.map(function (m) {
        var w = moonWorldPos(m, new THREE.Vector3());
        var s = projectToScreen(w);
        var c = camera.position, ce = p._group.position;
        var rx = w.x - ce.x, ry = w.y - ce.y, rz = w.z - ce.z;
        var vx = c.x - ce.x, vy = c.y - ce.y, vz = c.z - ce.z;
        return {
          name: m.name, parent: p.name,
          size: +m.size.toFixed(3), a: +m.a.toFixed(3), speed: +m.speed.toFixed(3),
          angle: +m.angle.toFixed(4), incl: +m.incl.toFixed(3),
          dist: +w.distanceTo(ce).toFixed(3),              /* 与母星心的距率（应 ≈ a） */
          rotY: m._mesh ? +m._mesh.rotation.y.toFixed(6) : null,
          world: { x: +w.x.toFixed(3), y: +w.y.toFixed(3), z: +w.z.toFixed(3) },
          screen: { x: Math.round(s.x), y: Math.round(s.y) },
          front: rx * vx + ry * vy + rz * vz > 0            /* 母星朝向相机的半球（未被挡住） */
        };
      });
    },
    /* 聚焦一颗卫星（嵌套聚焦）—— 与 focusPlanetByName 同构：先选中母行星
     * （面板给语境），再进聚焦。 Esc 回母行星聚焦档（exitFocus）。 */
    focusMoonByName: function (moonName) {
      for (var i = 0; i < G.sys.planets.length; i++) {
        var ms = G.sys.planets[i]._moons || [];
        for (var k = 0; k < ms.length; k++) {
          if (ms[k].name === moonName) {
            selectPlanet(G.sys.planets[i]);
            return enterFocus(ms[k]);
          }
        }
      }
      return false;
    },
    planetMesh: function (name) {          /* 调试：真网格引用（getState 是快照，摸不到材质） */
      for (var i = 0; i < G.sys.planets.length; i++) {
        if (G.sys.planets[i].name === name) return G.sys.planets[i]._mesh;
      }
      return null;
    },
    drawCalls: function () { return renderer.info.render.calls; },
    debugRefs: function () { return { scene: scene, renderer: renderer, camera: camera }; },

    /* ---- 恒星专章 / 信息面板 扩展 API ---- */
    starInfo: function () {
      var s = G.sys, st = s.starType, F = s._flare;
      var u = s._star && s._star.material.uniforms;
      return {
        name: s.name, typeId: st.id, typeName: st.name, spec: st.spec,
        tempK: st.tempK, radiusSol: st.radiusSol, massSol: st.massSol, lumSol: st.lumSol,
        radius: +(st.size * 2.1).toFixed(2),
        shader: !!u,
        uTime: u ? +u.uTime.value.toFixed(2) : null,
        uNoise: u ? u.uNoise.value : null,
        uSpot: u ? u.uSpot.value : null,
        preset: { noise: st.mat.noise, spot: st.mat.spot, flareRate: st.mat.flareRate },
        halo: !!(s._glowIn && s._glowOut),
        clean: {
          streamer: !s._streamer,
          coronas: !(s._coronas || []).length,
          prominences: !(s._prominences || []).length
        },
        flaresFired: F ? F.fired : 0,
        flareActive: !!(F && F.active),
        lensGhosts: lens ? lens.ghosts.length : 0
      };
    },
    triggerFlare: function () { return triggerFlare(G.sys); },
    setStarType: function (id) { return setStarType(id); },   // 切换恒星类型（指导书 / 调试）
    starTypeIds: function () { return STAR_TYPES.map(function (t) { return t.id; }); },
    starTypeTable: function () {
      return STAR_TYPES.map(function (t) {
        return {
          id: t.id, name: t.name, spec: t.spec, klass: t.klass,
          tempK: t.tempK, radiusSol: t.radiusSol, massSol: t.massSol, lumSol: t.lumSol,
          w: t.w, color: cssOf(t.color)
        };
      });
    },
    guideOpen: function () { return !!(elGuide && !elGuide.classList.contains("hidden")); },
    /* 栏目化后的观测点：栏目总数 / 当前栏目 / 全书标题（verify 用来对账「没挤在一页」） */
    guideInfo: function () {
      var chs = guideChannels();
      return {
        count: chs.length, sel: guideSel,
        parts: chs.filter(function (c) { return c.part; })
          .map(function (c) { return c.part; })
          .filter(function (v, i, a) { return a.indexOf(v) === i; }),
        titles: chs.map(function (c) { return c.title; })
      };
    },
    guideGoto: function (i) { guideGoto(i); return guideSel; },

    /* ---- 行星物理观测点：全部是计算结果的原始值（verify.mjs 用公式复算对账） ---- */
    planetData: function (name) {
      return G.sys.planets.filter(function (p) { return !name || p.name === name; })
        .map(function (p) {
          return {
            name: p.name, typeId: p.type.id, typeName: p.type.name, bulk: p.bulk,
            seed: p.seed, orbit: +p.orbit.toFixed(3),
            /* ★ v0.14：椭圆轨道三件套 —— ecc 偏心率 / angle 均近点角 M /
             * E 偏近点角（ecc=0 时 E ≡ M；由 50-scene 的牛顿迭代解出） */
            ecc: p.ecc, angle: +p.angle.toFixed(6),
            E: p.ecc > 0 && p._E !== undefined ? +p._E.toFixed(6) : null,
            au: p.au, teq0: p.teq0, teq: p.teq, tempSurf: p.tempSurf,
            albedo: p.type.albedo, green: p.type.green,
            rE: p.rE, mE: p.mE, radiusKm: p.radiusKm, dens: p.dens, g: p.g, vEsc: p.vEsc,
            periodDays: p.periodDays, vOrbit: p.vOrbit, orbitSpeed: p.orbitSpeed,
            rotH: p.rotH, tidal: p.tidal, insol: p.insol, size: p.size,
            water: p.water, atmo: p.atmo, metal: p.metal, carbon: p.carbon,
            iron: p.iron, comp: p.comp, atmoP: p.type.atmoP,
            compSum: p.comp.reduce(function (a, b) { return a + b[1]; }, 0),
            volState: volatileState(p.tempSurf),
            volLabel: volLabel(p),
            tempZone: zoneOf(p.tempSurf),
            star: {
              tempK: G.sys.starType.tempK, radiusSol: G.sys.starType.radiusSol,
              massSol: G.sys.starType.massSol, lumSol: G.sys.starType.lumSol
            }
          };
        });
    },
    planetTypeTable: function () {
      return PLANET_TYPES.map(function (t) {
        return {
          id: t.id, name: t.name, kind: t.kind, t0: t.t0, t1: t.t1,
          albedo: t.albedo, green: t.green, dens: t.dens, cond: typeCond(t),
          /* 判定字段一并导出：verify.mjs 用它们重跑一遍 resolvePlanetType，
           * 对账「行星分类确实由抽值经表序扫描推出」而不是写死的。 */
          water: t.water || null, metal: t.metal !== undefined ? t.metal : null,
          atmoMin: t.atmoMin !== undefined ? t.atmoMin : null,
          atmoMax: t.atmoMax !== undefined ? t.atmoMax : null,
          rMax: t.rMax !== undefined ? t.rMax : null,
          carbon: !!t.carbon, massRange: t.massRange || null,
          atmo: t.atmo, surface: t.surface, comp: t.comp, color: cssOf(t.color), tex: t.tex
        };
      });
    },
    planetTypeIds: function () { return PLANET_TYPES.map(function (t) { return t.id; }); },
    /* 宜居带 + 轨道亮度带（轨道优化观测点） */
    hzInfo: function () {
      return {
        lines: (G.sys._hzLines || []).length,
        au: (G.sys._hz || []).map(function (r) { return +(r / VIS_PER_AU).toFixed(4); })
      };
    },
    orbitFx: function () {
      return G.sys.planets.map(function (p) {
        var col = p._orbitLine.geometry.attributes.color;
        var mx = 0, mn = 1;
        for (var i = 0; i <= p._orbitSeg; i++) {
          var v = col.getX(i);
          if (v > mx) mx = v;
          if (v < mn) mn = v;
        }
        return {
          name: p.name, max: +mx.toFixed(3), min: +mn.toFixed(3),
          opacity: +p._orbitLine.material.opacity.toFixed(2), seg: p._orbitSeg
        };
      });
    },
    /* ---- 地形生成器观测点（v0.11）：地表是**算出来的**，这里把每一层的参数
     * 与结果读数量出来，好让 verify.mjs 独立复算对账 ---- */
    terrain: function (name) {
      return G.sys.planets.filter(function (p) { return !name || p.name === name; })
        .map(function (p) {
          var pr = isSolidPlanet(p) ? terrainParams(p) : null;
          return {
            name: p.name, typeId: p.type.id, tex: p.type.tex, bulk: p.bulk,
            solid: isSolidPlanet(p), profile: pr ? pr.prof.id : null,
            seed: p.seed,
            relief: pr ? +pr.relief.toFixed(4) : 0,
            craters: pr ? pr.craters : 0,
            sea: pr ? pr.sea : false, rivers: pr ? pr.rivers : false,
            snowH: pr ? +pr.snowH.toFixed(4) : 0,
            capFrac: pr ? +pr.capFrac.toFixed(4) : 0,
            lava: pr ? pr.lava : false,
            tempSurf: p.tempSurf, water: p.water, atmo: p.atmo, rE: p.rE, g: p.g,
            texW: p._mesh.material.map && p._mesh.material.map.image ? p._mesh.material.map.image.width : 0,
            bumpW: p._mesh.material.bumpMap && p._mesh.material.bumpMap.image
              ? p._mesh.material.bumpMap.image.width : 0,
            hasBump: !!p._mesh.material.bumpMap,
            bumpScale: +p._mesh.material.bumpScale.toFixed(5),
            hasEmissive: !!p._mesh.material.emissiveMap, hi: !!p._surfHi
          };
        });
    },
    /* 高程场：给定行星与分辨率**重新跑一遍整条管线**并返回分布直方图。
     * 目的：verify 能独立验证「有海的世界确实跨过 0.5、山脉确有高值」，
     * 而不必信任场景里那张贴图的内部状态。 */
    heightField: function (name, W) {
      var p = null, i;
      for (i = 0; i < G.sys.planets.length; i++) if (G.sys.planets[i].name === name) p = G.sys.planets[i];
      if (!p || !isSolidPlanet(p)) return null;
      W = W || 256;
      var H = W >> 1, pr = terrainParams(p);
      var f = buildHeightField(pr, p, W, H);
      var hist = new Array(10).fill(0), sum = 0, mn = Infinity, mx = -Infinity;
      for (i = 0; i < f.length; i++) {
        var v = Math.max(0, Math.min(0.9999, f[i]));
        hist[Math.floor(v * 10)]++;
        sum += v; if (f[i] < mn) mn = f[i]; if (f[i] > mx) mx = f[i];
      }
      return {
        name: name, W: W, H: H, relief: +pr.relief.toFixed(4), sea: pr.sea,
        mean: +(sum / f.length).toFixed(4), min: +mn.toFixed(4), max: +mx.toFixed(4),
        hist: hist.map(function (c) { return +(c / f.length).toFixed(4); })
      };
    },
    /* 聚焦地表（v0.12）：立方球连续地表的观测点 ——
     * 结构（顶点/三角形）、物理（海平面/覆盖率/雪线）、确定性（高程签名）、
     * 云层（与 planetCloudy 同源）、可见性（立方球亮 ⇔ 贴图网格隐）。 */
    focusSurface: function (name) {
      var p = null, i;
      for (i = 0; i < G.sys.planets.length; i++) {
        if (G.sys.planets[i].name === (name || (G.focusPlanet && G.focusPlanet.name))) { p = G.sys.planets[i]; break; }
      }
      if (!p) return null;
      var cs = p._cs || null;
      var pr = isSolidPlanet(p) ? terrainParams(p) : null;
      return {
        name: p.name, solid: isSolidPlanet(p),
        cloudy: isSolidPlanet(p) && planetCloudy(p),
        built: !!cs, active: !!(cs && cs.group.visible),
        N: cs ? cs.N : 0,
        verts: cs ? cs.verts : 0, tris: cs ? cs.tris : 0, ms: cs ? cs.ms : 0,
        sea: pr && pr.sea ? 0.5 : -1, seaFrac: cs ? +cs.seaFrac.toFixed(4) : 0,
        water: p.water, atmo: p.atmo,
        snowH: pr ? +pr.snowH.toFixed(4) : 0, capFrac: pr ? +pr.capFrac.toFixed(4) : 0,
        relief: pr ? +pr.relief.toFixed(4) : 0,
        sig: cs ? cs.sig : 0,
        cloud: cs && cs.cloud ? {
          visible: cs.cloud.visible,
          cover: +cs.cloudMat.uniforms.uCover.value.toFixed(3),
          opacity: +cs.cloudMat.uniforms.uOpacity.value.toFixed(3),
          /* ★ v0.12.3：云图案 = 烘焙贴图（512×256 · linear/mipmap 预过滤） */
          texW: cs.cloudMat.uniforms.uMap.value.image.width,
          texH: cs.cloudMat.uniforms.uMap.value.image.height,
          texMs: _cloudTexMs
        } : null,
        meshVisible: p._mesh.visible,
        /* meshRotY = 自转相位（读贴图网格，退出聚焦后仍持续演进，是自转的真值）；
         * rotDelta = 自转增量（50-scene 每帧写）—— 聚焦档镜头同速随动的口径。
         * 自转**永不冻结**：v0.12.1 的「聚焦冻结自转」已废（世界永远在转，
         * 「对准的面不转走」由镜头以同角速度绕行兑现，见 99-boot 的 loop），
         * 所以 v0.12.1 的 frozen 字段随那套方案一起退役。 */
        meshRotY: +p._mesh.rotation.y.toFixed(6),
        rotDelta: +p._rotDelta.toFixed(6),
        sunDir: cs ? [
          +cs.mat.uniforms.uSunDir.value.x.toFixed(3),
          +cs.mat.uniforms.uSunDir.value.y.toFixed(3),
          +cs.mat.uniforms.uSunDir.value.z.toFixed(3)
        ] : null
      };
    },
    /* 聚焦云壳显隐（测量用：开/关差分 = 云的真实覆盖占比；也为将来「隐藏装饰层」留口） */
    setFocusClouds: function (on) {
      if (!G.focusPlanet || !G.focusPlanet._cs || !G.focusPlanet._cs.cloud) return null;
      G.focusPlanet._cs.cloud.visible = !!on;
      return G.focusPlanet._cs.cloud.visible;
    },
    /* 聚焦云壳相位（调试：看不同方位下的云图案 —— 对照「云多/云少的一面」） */
    setFocusCloudPhase: function (a) {
      if (!G.focusPlanet || !G.focusPlanet._cs || !G.focusPlanet._cs.cloud) return null;
      G.focusPlanet._cs.cloud.rotation.y = +a || 0;
      return G.focusPlanet._cs.cloud.rotation.y;
    },
    /* ---- v0.13 聚落系统观测点（实验性）----
     * settlements()：数量 / 列表 / 选址模式（verify 的对账入口）。
     * siteCheck(name, dir)：独立复算可建判定与评分（纯函数，不落盘）。
     * placeAt(name, dir)：直接放置（不经过鼠标 —— verify 的确定性链路）；
     *                    UI 链路（B 键 + 点击）由验证侧单独走。 */
    settlements: function (name) {
      var p = null, i;
      for (i = 0; i < G.sys.planets.length; i++) {
        if (G.sys.planets[i].name === (name || (G.focusPlanet && G.focusPlanet.name))) { p = G.sys.planets[i]; break; }
      }
      if (!p) return null;
      var list = (p._cities || []).map(function (c) {
        return {
          n: c.n, cell: c.cell.id, score: c.score, h: +c.h.toFixed(4), slope: +c.slope.toFixed(3),
          dir: [+c.dir[0].toFixed(6), +c.dir[1].toFixed(6), +c.dir[2].toFixed(6)],
          parts: c.parts, mesh: !!(c._mesh && c._mesh.parent), marker: !!c._marker
        };
      });
      return {
        name: p.name, count: list.length, list: list,
        mode: siteModeOn(), cursorVisible: !!(_siteCursor && _siteCursor.visible)
      };
    },
    siteCheck: function (name, dir) {
      var p = null, i;
      for (i = 0; i < G.sys.planets.length; i++) {
        if (G.sys.planets[i].name === name) { p = G.sys.planets[i]; break; }
      }
      if (!p || !p._cs) return null;
      var chk = siteCheck(p, dir);
      return {
        ok: chk.ok, gate: chk.gate, gates: chk.gates,
        h: +chk.h.toFixed(5), slope: +chk.slope.toFixed(4), lat: +chk.lat.toFixed(4),
        cell: chk.cell.id, score: chk.score, parts: chk.parts,
        minGap: +chk.minGap.toFixed(4)
      };
    },
    placeAt: function (name, dir) {
      var p = null, i;
      for (i = 0; i < G.sys.planets.length; i++) {
        if (G.sys.planets[i].name === name) { p = G.sys.planets[i]; break; }
      }
      if (!p || !p._cs) return null;
      var res = placeCity(p, dir);
      return res.ok
        ? { ok: true, n: res.city.n, count: res.count, cell: res.city.cell.id, score: res.city.score }
        : { ok: false, gate: res.gate, gates: res.gates };
    },
    /* 城市「站心」（表面点）的坐标 —— local 供重建对账（与公转无关），
     * world 供贴地投影对账（投影回屏幕应与点击点吻合） */
    cityWorld: function (name, idx) {
      var p = null, i;
      for (i = 0; i < G.sys.planets.length; i++) {
        if (G.sys.planets[i].name === name) { p = G.sys.planets[i]; break; }
      }
      if (!p || !p._cities || !p._cities[idx] || !p._cs) return null;
      var sp = focusSurfacePos(p, p._cities[idx].dir);
      var lv = new THREE.Vector3(sp.pos[0], sp.pos[1], sp.pos[2]);
      var wv = lv.clone();
      p._cs.mesh.localToWorld(wv);
      return {
        local: { x: +lv.x.toFixed(5), y: +lv.y.toFixed(5), z: +lv.z.toFixed(5) },
        world: { x: +wv.x.toFixed(4), y: +wv.y.toFixed(4), z: +wv.z.toFixed(4) }
      };
    },
    /* 表面方向 → 屏幕坐标（verify 找「可建点」后点它用） */
    siteScreen: function (name, dir) {
      var p = null, i;
      for (i = 0; i < G.sys.planets.length; i++) {
        if (G.sys.planets[i].name === name) { p = G.sys.planets[i]; break; }
      }
      if (!p || !p._cs) return null;
      var sp = focusSurfacePos(p, dir);
      var v = new THREE.Vector3(sp.pos[0], sp.pos[1], sp.pos[2]);
      p._cs.mesh.localToWorld(v);
      /* ★ front = 该点「真正可见」（在可见半球内 —— 视界圆以内）。
       * 两条错判都踩过：① 「点到相机 · 中心到相机 > 0」——背面点也满足，
       * 背面点的投影同样落在屏幕的球盘内；② 只判「同半球」还不够 ——
       * 视界圆（acos(size/距离) ≈ 67°）到 90° 之间是**掠射带**，那里的点
       * 被球缘挡着，射线会先命中边缘可见侧（偏差可达 30°+）。
       * 正解：cos(view) > cos(limb)，并留一点余量避开掠射带。 */
      var centre = new THREE.Vector3();
      p._group.getWorldPosition(centre);
      var camPos = camera.position;
      var rx = v.x - centre.x, ry = v.y - centre.y, rz = v.z - centre.z;
      var cx = camPos.x - centre.x, cy = camPos.y - centre.y, cz = camPos.z - centre.z;
      var rL = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1;
      var cL = Math.sqrt(cx * cx + cy * cy + cz * cz) || 1;
      var cosView = (rx * cx + ry * cy + rz * cz) / (rL * cL);
      var cosLimb = p.size / cL;
      var front = cosView > Math.min(0.98, cosLimb * 1.06 + 0.02);
      var vv = v.clone().project(camera);
      return {
        x: (vv.x * 0.5 + 0.5) * window.innerWidth,
        y: (-vv.y * 0.5 + 0.5) * window.innerHeight,
        front: front
      };
    },
    setSiteMode: function (on) { return setSiteMode(!!on); },
    /* ★ v0.15：聚焦操作面板的读数（verify 断言面板真的是一块「投影」而不是自说自话）。
     * host = 面板宿主行星名（null = 面板不出现）；build 是主按钮文案 —— 它必须与
     * siteModeOn() 同源（同一入口的两种呈现）。 */
    sitePanel: function () {
      var host = sitePanelHost();
      return {
        host: host ? host.name : null,
        experiment: EXPERIMENT_PLANET,
        visible: !!(elFocusPanel && !elFocusPanel.classList.contains("hidden")),
        build: elFpBuild ? elFpBuild.textContent : null,
        buildOn: !!(elFpBuild && elFpBuild.classList.contains("on")),
        count: elFpCount ? elFpCount.textContent : null,
        land: elFpLand ? elFpLand.textContent : null,
        read: elFpRead ? elFpRead.textContent : null,
        /* ★ 光标处诊断：面板读数到底算的是哪个坐标、落点在哪（对账「读数 = 点击」用） */
        cursor: _site.mouse
          ? {
            mouse: [_site.mouse[0], _site.mouse[1]],
            dir: _site.dir ? [+_site.dir[0].toFixed(4), +_site.dir[1].toFixed(4), +_site.dir[2].toFixed(4)] : null,
            h: _site.check ? +_site.check.h.toFixed(5) : null,
            ok: _site.check ? !!_site.check.ok : null,
            gate: _site.check ? _site.check.gate : null,
            score: _site.check ? _site.check.score : null,
            visible: !!(_siteCursor && _siteCursor.visible),
            frames: (typeof __frames === "number" ? __frames : -1),
            trace: _site.trace ? _site.trace.slice(-4) : null
          }
          : null,
        note: elFpNote && !elFpNote.classList.contains("hidden") ? elFpNote.textContent : "",
        lastClick: _site.lastClick || null,
        mode: siteModeOn()
      };
    },
    /* ★ v0.15 光标落点对账：用**光标的宿主行星**现算一次（`_site.p`），
     * 与 siteProbe(名字) 对比 —— 用来抓「预览落点 ≠ 现算落点」这类链路分叉。 */
    siteCursorProbe: function () {
      if (!_site.p || !_site.mouse) return null;
      var d = rayToSurfaceDir(_site.p, _site.mouse[0], _site.mouse[1]);
      var chk = d ? siteCheck(_site.p, d) : null;
      var d2 = _site.dir, ang = null;
      if (d && d2) {
        var dot = d[0] * d2[0] + d[1] * d2[1] + d[2] * d2[2];
        ang = +(Math.acos(Math.min(1, Math.max(-1, dot))) * 180 / Math.PI).toFixed(3);
      }
      return {
        sameAsFocus: _site.p === G.focusPlanet,
        pName: _site.p.name,
        meshRotY: _site.p._cs ? +_site.p._cs.mesh.rotation.y.toFixed(5) : null,
        cx: _site.mouse[0], cy: _site.mouse[1],
        now: d ? [+d[0].toFixed(4), +d[1].toFixed(4), +d[2].toFixed(4)] : null,
        cached: d2 ? [+d2[0].toFixed(4), +d2[1].toFixed(4), +d2[2].toFixed(4)] : null,
        angCachedVsNow: ang,
        dir: d ? [+d[0].toFixed(4), +d[1].toFixed(4), +d[2].toFixed(4)] : null,
        h: chk ? +chk.h.toFixed(5) : null,
        ok: chk ? !!chk.ok : null
      };
    },
    /* 屏幕坐标 → 地表落点方向 + 可建判定（对账「点击落点」用 —— rayToSurfaceDir 的精度） */
    siteProbe: function (name, cx, cy) {
      var p = null, i;
      for (i = 0; i < G.sys.planets.length; i++) {
        if (G.sys.planets[i].name === name) { p = G.sys.planets[i]; break; }
      }
      if (!p || !p._cs) return null;
      var dir = rayToSurfaceDir(p, cx, cy);
      if (!dir) return { dir: null };
      var chk = siteCheck(p, dir);
      return {
        dir: [+dir[0].toFixed(6), +dir[1].toFixed(6), +dir[2].toFixed(6)],
        ok: chk.ok, gate: chk.gate, h: +chk.h.toFixed(5), cell: chk.cell.id
      };
    },
    /* ★ v0.12.3：导出云贴图（base64 PNG）—— 看烘焙结果本身的形态与对比（调试 / 资产检查） */
    cloudTexPng: function () {
      if (!_cloudTex) return null;
      var img = _cloudTex.image, W = img.width, H = img.height, d = img.data;
      var cv = document.createElement("canvas"); cv.width = W; cv.height = H;
      var g = cv.getContext("2d");
      var id = g.createImageData(W, H);
      for (var i = 0; i < W * H; i++) {
        id.data[i * 4] = d[i * 4];
        id.data[i * 4 + 1] = d[i * 4];
        id.data[i * 4 + 2] = d[i * 4];
        id.data[i * 4 + 3] = 255;
      }
      g.putImageData(id, 0, 0);
      return cv.toDataURL("image/png");
    },
    /* 重建聚焦地表（确定性对账用）：拆掉重来一遍，签名必须与前一次相同 */
    rebuildFocusSurface: function (name) {
      var p = null, i;
      for (i = 0; i < G.sys.planets.length; i++) {
        if (G.sys.planets[i].name === name) { p = G.sys.planets[i]; break; }
      }
      if (!p || !isSolidPlanet(p)) return null;
      if (p._cs) {
        p._group.remove(p._cs.group);
        p._cs.group.traverse(function (o) {
          if (o.geometry) o.geometry.dispose();
          /* ★ v0.13：共享材质不 dispose（城市材质 / 选址光标材质是全行星单例 ——
           * 与 v0.12「共享 ShaderMaterial 被释放 → 下次拿到已销毁 program」同坑） */
          if (o.material && !isSharedSiteMaterial(o.material)) o.material.dispose();
        });
        p._cs = null;
      }
      ensureFocusSurface(p);
      syncFocusSurface();          /* 重建后立即恢复一致状态（可见性/太阳方向） */
      return window.__game.focusSurface(name);
    },
    /* 选中效果观测点：括号（呼吸淡入）/ 细环（扫描）/ 行星括号 */
    selectionFx: function () {
      var s = G.sys, pl = G.selectedPlanet;
      function m(o) {
        return o ? { visible: o.visible, opacity: +o.material.opacity.toFixed(3), isSprite: o.isSprite === true } : null;
      }
      return {
        star: m(s._starSel),
        starRing: s._starRing
          ? { visible: s._starRing.visible, opacity: +s._starRing.material.opacity.toFixed(3), rot: +s._starRing.material.rotation.toFixed(3) }
          : null,
        planet: pl ? m(pl._selRing) : null
      };
    },
    /* 星体视觉观测点（按 klass 校验：等离子表面 / 光子环 / 光照 / 耀斑） */
    starVis: function () {
      var s = G.sys, st = s.starType;
      return {
        klass: st.klass, typeId: st.id,
        hasPlasma: !!(s._star && s._star.material.uniforms),
        hasPhoton: !!s._photon,
        halo: !!(s._glowIn && s._glowOut),
        light: s._light ? { color: "#" + s._light.color.getHexString(), intensity: s._light.intensity } : null,
        flareRate: s._flare ? s._flare.rate : null
      };
    },
    lensFlareState: function () { return JSON.parse(JSON.stringify(lens.last)); },
    starScreenPos: function () {
      var p = projectToScreen(_zeroV);
      return { x: Math.round(p.x), y: Math.round(p.y) };
    },
    zoomTo: function (r) { orbit.radius = clamp(r, orbit.minR, orbit.maxR); camGoalRadius = orbit.radius; },
    setOrbitAngles: function (th, ph) { orbit.theta = th; orbit.phi = ph; },
    setTarget: function (x, y, z) { orbit.target.set(x, y, z); },
    holdTarget: function (on) { G.holdTarget = !!on; },

    /* ---- v0.7 结构层观测点：注册表 + 状态机 ----
     * 这两组是「对象 / 模式变多之后还给不给管得住」的机器判据：
     *   registries() —— 每张表的条目数与全量体检结果（problems 必须为空）；
     *                   selfTest 是探针自检，证明体检器**真能**抓到坏数据。
     *   fsm()        —— 三台机器的当前状态 + 非法转移计数（完整巡览后必须为 0）。 */
    registries: function () {
      var probs = [];
      var tables = Registries.map(function (r) {
        var p = r.audit();
        probs = probs.concat(p);
        return { kind: r.kind, size: r.size(), ids: r.snapshot().map(function (t) { return t.id; }), problems: p };
      });
      return {
        tables: tables,
        problems: probs,
        selfTest: registrySelfTest()      /* 探针用完自己摘掉，不留残余 */
      };
    },
    fsm: fsmSnapshot,
    /* 往某台机器真发一个事件、再原样还原：verify 用它证明「表外事件真的会被拦」，
     * 而不会把「全程零非法转移」的统计弄脏（实现见 25-fsm.js 的 probe）。 */
    fsmProbe: function (id, evt) {
      for (var i = 0; i < MODES.length; i++) {
        if (MODES[i].id === id) return MODES[i].probe(evt);
      }
      return null;
    },
    /* 状态机的可读速记（控制台 / 断言失败时看这一行就懂） */
    fsmBrief: function () {
      var s = fsmSnapshot();
      return Object.keys(s.machines).map(function (k) { return k + "=" + s.machines[k].state; }).join(" · ") +
        " · 非法=" + s.illegal;
    },

    /* ---- v0.8 物种与文明观测点 ----
     * speciesTable() 的字段就是评分函数的全部输入（权重 / 舒适带 / 气压偏好），
     * verify 拿它**独立复算**一遍摇篮评分，与游戏内选址对账。 */
    speciesIds: speciesIds,
    speciesTable: speciesTable,
    civInfo: civReport,
    cradleBoard: cradleBoardOf,

    /* ---- v0.9 物资观测点 ----
     * materialsTable() 的字段就是物资推导的全部输入（元素 / 配方 / 可及档 / 标度），
     * verify 拿它**独立复算**一遍两本账（蕴藏 / 可采），逐颗行星与游戏内数字对账。
     * rngLive() 是主 RNG 的**实时**抽数（getState().rngDraws 是历史锚点，只在抽星型时
     * 记过一笔，验不了「启动之后不再抽」）—— verify 用它证明零 RNG：连算三遍账本，
     * 这个数一格不动。 */
    materialsTable: materialsTable,
    planetMaterials: planetMaterials,
    rngLive: function () { return rngDraws; }
  };

  /* ★ v0.12.3：云贴图「空闲预热」—— 生成 1024×512 约 150ms，放到浏览器空闲时做，
   * 别卡住「双击聚焦」那一瞬（懒生成仍兜底：万一没赶上就同步生成一次）。 */
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(function () { buildCloudTex(); }, { timeout: 3000 });
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}

})();

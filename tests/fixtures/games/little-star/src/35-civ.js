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

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


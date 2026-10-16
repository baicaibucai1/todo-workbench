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


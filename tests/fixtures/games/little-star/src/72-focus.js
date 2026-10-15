/* ================= 聚焦镜头（v0.10 新增） ================= */

/* 是什么：相机的第三态（FSM_CAMERA.focus）。双击行星进入 —— 相机贴近到行星
 * 占满画面约三分之二（「镜头内基本全是星球」），同时**操作精度提高一档**：
 * 旋转 / 平移 / 滚轮缩放的灵敏度全部收窄到 0.32 倍，方便贴着地表细看。
 *
 * 与 follow 的分工（v0.10 起三档距离，分档表在 applyCamera）：
 *   free    全景，半径 92
 *   follow  中距离跟随，行星占画面约 1/4 —— 看清它在哪
 *   focus   聚焦贴近，行星占画面约 2/3 —— 看清它本身
 * Esc / HUD 退出钮从 focus 回到 follow（还跟着，只是不贴了）；双击空白直接回全景。
 *
 * 三条约束：
 *   ① 聚焦距离 = 行星半径 × FOCUS_K，clamp 到 [1.6, 9.4] —— 与行星大小解耦，
 *      任何行星进来都占同样比例的画面（verify 按屏幕投影验算占比）
 *   ② 聚焦档放宽 orbit.minR（否则 16 的底线把推距钳死，贴不上去）；退出必须
 *      恢复 16 —— 这条写在 applyCamera，不在这里各写一份
 *   ③ 距地表读数是**推导量**：(orbit.radius - p.size) / p.size，不另存状态；
 *      HUD 只投影它，相机一动读数自然跟着变
 */
var FOCUS_K = 3.6;                 // 聚焦距离 = 行星半径 × 3.6（视角直径 ≈ 32°，占画面高约 2/3）

function focusDistance(p) { return clamp(p.size * FOCUS_K, 1.6, 9.4); }

function enterFocus(p) {
  var ok = FSM_CAMERA.send("enter", p);
  /* ★ v0.12：固态行星首次聚焦时现场构建「立方球连续地表」（44-focus-surface.js），
   * 缓存在 p._cs —— 放在点击时刻构建而不是帧循环里，收尾动画不必等它。
   * 贴图网格的显隐由 syncFocusSurface（每帧一处裁决）接管。 */
  if (ok && p && isSolidPlanet(p)) ensureFocusSurface(p);
  return ok;
}
function exitFocus() {
  /* Esc / 退出钮：回落中距离跟随（目标不变）。free 态下调它没有目标可跟，
   * 由调用方把关（键盘路由只在 focus 态接 Esc；按钮只在 HUD 可见时点得到）。 */
  if (!G.focusPlanet) return false;
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

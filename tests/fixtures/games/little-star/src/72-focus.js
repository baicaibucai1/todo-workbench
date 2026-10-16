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

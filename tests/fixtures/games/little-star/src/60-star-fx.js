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


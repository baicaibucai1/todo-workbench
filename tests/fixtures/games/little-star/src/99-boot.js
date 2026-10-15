/* ================= 主循环 ================= */
var lastT = 0;

function loop(tms) {
  var dt = Math.min((tms - lastT) / 1000, 0.1);
  lastT = tms;
  __frames++;

  updateScene(G.sys, dt);

  // 相机：聚焦行星时平滑跟随；半径趋近目标值（双击聚焦/拉远都是平滑过渡）
  if (G.focusPlanet && G.focusPlanet._group) {
    /* 聚焦档跟得更紧：贴近时行星公移一点、视角变化就很大（dt*5.5 vs 中距离 3.2） */
    orbit.target.lerp(G.focusPlanet._group.position, Math.min(1, dt * (FSM_CAMERA.is("focus") ? 5.5 : 3.2)));
  } else if (!G.holdTarget) {
    orbit.target.lerp(_zeroV, Math.min(1, dt * 2.2));
  }
  orbit.radius += (camGoalRadius - orbit.radius) * Math.min(1, dt * 4);
  applyOrbit(camera, orbit);
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
          return { name: p.name, type: p.type.name, size: +p.size.toFixed(2), orbit: +p.orbit.toFixed(1) };
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
        moons: s.planets.filter(function (p) { return !!p._moon; }).length,
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
        /* 距地表读数（推导量，与 HUD 同源）：(radius - 行星半径) / 行星半径 */
        surface: G.focusPlanet ? +((orbit.radius - G.focusPlanet.size) / G.focusPlanet.size).toFixed(2) : null,
        minR: orbit.minR,
        target: { x: +orbit.target.x.toFixed(2), y: +orbit.target.y.toFixed(2), z: +orbit.target.z.toFixed(2) }
      };
    },
    planetScreenPos: function (name) {
      for (var i = 0; i < G.sys.planets.length; i++) {
        if (G.sys.planets[i].name === name) {
          var p = projectToScreen(G.sys.planets[i]._group.position);
          return { x: Math.round(p.x), y: Math.round(p.y) };
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
          opacity: +cs.cloudMat.uniforms.uOpacity.value.toFixed(3)
        } : null,
        meshVisible: p._mesh.visible,
        /* ★ v0.12.1：聚焦静止对账点 —— meshRotY = 自转相位（读贴图网格，退出聚焦
         * 后仍持续演进，是自转的真值）；frozen = 聚焦冻结是否生效（50-scene 每帧写）。 */
        meshRotY: +p._mesh.rotation.y.toFixed(6),
        frozen: !!p._spinFrozen,
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
          if (o.material) o.material.dispose();
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
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}

})();

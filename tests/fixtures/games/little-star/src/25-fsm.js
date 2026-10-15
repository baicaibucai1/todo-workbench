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

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

var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/lib/migrations.ts
var migrations, CURRENT_SCHEMA_VERSION;
var init_migrations = __esm({
  "src/lib/migrations.ts"() {
    "use strict";
    migrations = [
      {
        version: 1,
        name: "init_core_schema",
        sql: `
      CREATE TABLE IF NOT EXISTS core_lists (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        color       TEXT NOT NULL DEFAULT '#d4537e',
        sort_order  INTEGER NOT NULL DEFAULT 0,
        deleted     INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS core_tasks (
        id           TEXT PRIMARY KEY,
        list_id      TEXT NOT NULL REFERENCES core_lists(id) ON DELETE CASCADE,
        title        TEXT NOT NULL DEFAULT '',
        note         TEXT NOT NULL DEFAULT '',
        done         INTEGER NOT NULL DEFAULT 0,
        important    INTEGER NOT NULL DEFAULT 0,
        my_day       INTEGER NOT NULL DEFAULT 0,
        due_date     TEXT,
        remind_at    TEXT,
        completed_at TEXT,
        sort_order   INTEGER NOT NULL DEFAULT 0,
        deleted      INTEGER NOT NULL DEFAULT 0,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_core_tasks_list    ON core_tasks(list_id, deleted, sort_order);
      CREATE INDEX IF NOT EXISTS idx_core_tasks_myday   ON core_tasks(my_day, done, deleted);
      CREATE INDEX IF NOT EXISTS idx_core_tasks_due     ON core_tasks(due_date, deleted);

      CREATE TABLE IF NOT EXISTS core_steps (
        id         TEXT PRIMARY KEY,
        task_id    TEXT NOT NULL REFERENCES core_tasks(id) ON DELETE CASCADE,
        title      TEXT NOT NULL DEFAULT '',
        done       INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_core_steps_task ON core_steps(task_id, sort_order);

      CREATE TABLE IF NOT EXISTS core_settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `
      }
    ];
    CURRENT_SCHEMA_VERSION = migrations[migrations.length - 1].version;
  }
});

// node_modules/@tauri-apps/api/external/tslib/tslib.es6.js
function __classPrivateFieldGet(receiver, state, kind, f) {
  if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
  return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
}
function __classPrivateFieldSet(receiver, state, value, kind, f) {
  if (kind === "m") throw new TypeError("Private method is not writable");
  if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
  return kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value), value;
}
var init_tslib_es6 = __esm({
  "node_modules/@tauri-apps/api/external/tslib/tslib.es6.js"() {
  }
});

// node_modules/@tauri-apps/api/core.js
function transformCallback(callback, once = false) {
  return window.__TAURI_INTERNALS__.transformCallback(callback, once);
}
async function invoke(cmd, args = {}, options) {
  return window.__TAURI_INTERNALS__.invoke(cmd, args, options);
}
var _Channel_onmessage, _Channel_nextMessageIndex, _Channel_pendingMessages, _Channel_messageEndIndex, _Resource_rid, SERIALIZE_TO_IPC_FN, Channel;
var init_core = __esm({
  "node_modules/@tauri-apps/api/core.js"() {
    init_tslib_es6();
    SERIALIZE_TO_IPC_FN = "__TAURI_TO_IPC_KEY__";
    Channel = class {
      constructor(onmessage) {
        _Channel_onmessage.set(this, void 0);
        _Channel_nextMessageIndex.set(this, 0);
        _Channel_pendingMessages.set(this, []);
        _Channel_messageEndIndex.set(this, void 0);
        __classPrivateFieldSet(this, _Channel_onmessage, onmessage || (() => {
        }), "f");
        this.id = transformCallback((rawMessage) => {
          const index = rawMessage.index;
          if ("end" in rawMessage) {
            if (index == __classPrivateFieldGet(this, _Channel_nextMessageIndex, "f")) {
              this.cleanupCallback();
            } else {
              __classPrivateFieldSet(this, _Channel_messageEndIndex, index, "f");
            }
            return;
          }
          const message = rawMessage.message;
          if (index == __classPrivateFieldGet(this, _Channel_nextMessageIndex, "f")) {
            __classPrivateFieldGet(this, _Channel_onmessage, "f").call(this, message);
            __classPrivateFieldSet(this, _Channel_nextMessageIndex, __classPrivateFieldGet(this, _Channel_nextMessageIndex, "f") + 1, "f");
            while (__classPrivateFieldGet(this, _Channel_nextMessageIndex, "f") in __classPrivateFieldGet(this, _Channel_pendingMessages, "f")) {
              const message2 = __classPrivateFieldGet(this, _Channel_pendingMessages, "f")[__classPrivateFieldGet(this, _Channel_nextMessageIndex, "f")];
              __classPrivateFieldGet(this, _Channel_onmessage, "f").call(this, message2);
              delete __classPrivateFieldGet(this, _Channel_pendingMessages, "f")[__classPrivateFieldGet(this, _Channel_nextMessageIndex, "f")];
              __classPrivateFieldSet(this, _Channel_nextMessageIndex, __classPrivateFieldGet(this, _Channel_nextMessageIndex, "f") + 1, "f");
            }
            if (__classPrivateFieldGet(this, _Channel_nextMessageIndex, "f") === __classPrivateFieldGet(this, _Channel_messageEndIndex, "f")) {
              this.cleanupCallback();
            }
          } else {
            __classPrivateFieldGet(this, _Channel_pendingMessages, "f")[index] = message;
          }
        });
      }
      cleanupCallback() {
        window.__TAURI_INTERNALS__.unregisterCallback(this.id);
      }
      set onmessage(handler) {
        __classPrivateFieldSet(this, _Channel_onmessage, handler, "f");
      }
      get onmessage() {
        return __classPrivateFieldGet(this, _Channel_onmessage, "f");
      }
      [(_Channel_onmessage = /* @__PURE__ */ new WeakMap(), _Channel_nextMessageIndex = /* @__PURE__ */ new WeakMap(), _Channel_pendingMessages = /* @__PURE__ */ new WeakMap(), _Channel_messageEndIndex = /* @__PURE__ */ new WeakMap(), SERIALIZE_TO_IPC_FN)]() {
        return `__CHANNEL__:${this.id}`;
      }
      toJSON() {
        return this[SERIALIZE_TO_IPC_FN]();
      }
    };
    _Resource_rid = /* @__PURE__ */ new WeakMap();
  }
});

// node_modules/@tauri-apps/plugin-sql/dist-js/index.js
var dist_js_exports = {};
__export(dist_js_exports, {
  default: () => Database
});
var Database;
var init_dist_js = __esm({
  "node_modules/@tauri-apps/plugin-sql/dist-js/index.js"() {
    init_core();
    Database = class _Database {
      constructor(path) {
        this.path = path;
      }
      /**
       * **load**
       *
       * A static initializer which connects to the underlying database and
       * returns a `Database` instance once a connection to the database is established.
       *
       * # Sqlite
       *
       * The path is relative to `tauri::path::BaseDirectory::App` and must start with `sqlite:`.
       *
       * @example
       * ```ts
       * const db = await Database.load("sqlite:test.db");
       * ```
       */
      static async load(path) {
        const _path = await invoke("plugin:sql|load", {
          db: path
        });
        return new _Database(_path);
      }
      /**
       * **get**
       *
       * A static initializer which synchronously returns an instance of
       * the Database class while deferring the actual database connection
       * until the first invocation or selection on the database.
       *
       * # Sqlite
       *
       * The path is relative to `tauri::path::BaseDirectory::App` and must start with `sqlite:`.
       *
       * @example
       * ```ts
       * const db = Database.get("sqlite:test.db");
       * ```
       */
      static get(path) {
        return new _Database(path);
      }
      /**
       * **execute**
       *
       * Passes a SQL expression to the database for execution.
       *
       * @example
       * ```ts
       * // for sqlite & postgres
       * // INSERT example
       * const result = await db.execute(
       *    "INSERT into todos (id, title, status) VALUES ($1, $2, $3)",
       *    [ todos.id, todos.title, todos.status ]
       * );
       * // UPDATE example
       * const result = await db.execute(
       *    "UPDATE todos SET title = $1, completed = $2 WHERE id = $3",
       *    [ todos.title, todos.status, todos.id ]
       * );
       *
       * // for mysql
       * // INSERT example
       * const result = await db.execute(
       *    "INSERT into todos (id, title, status) VALUES (?, ?, ?)",
       *    [ todos.id, todos.title, todos.status ]
       * );
       * // UPDATE example
       * const result = await db.execute(
       *    "UPDATE todos SET title = ?, completed = ? WHERE id = ?",
       *    [ todos.title, todos.status, todos.id ]
       * );
       * ```
       */
      async execute(query, bindValues) {
        const [rowsAffected, lastInsertId] = await invoke("plugin:sql|execute", {
          db: this.path,
          query,
          values: bindValues ?? []
        });
        return {
          lastInsertId,
          rowsAffected
        };
      }
      /**
       * **select**
       *
       * Passes in a SELECT query to the database for execution.
       *
       * @example
       * ```ts
       * // for sqlite & postgres
       * const result = await db.select(
       *    "SELECT * from todos WHERE id = $1", [ id ]
       * );
       *
       * // for mysql
       * const result = await db.select(
       *    "SELECT * from todos WHERE id = ?", [ id ]
       * );
       * ```
       */
      async select(query, bindValues) {
        const result = await invoke("plugin:sql|select", {
          db: this.path,
          query,
          values: bindValues ?? []
        });
        return result;
      }
      /**
       * **close**
       *
       * Closes the database connection pool.
       *
       * @example
       * ```ts
       * const success = await db.close()
       * ```
       * @param db - Optionally state the name of a database if you are managing more than one. Otherwise, all database pools will be in scope.
       */
      async close(db2) {
        const success = await invoke("plugin:sql|close", {
          db: db2
        });
        return success;
      }
    };
  }
});

// src/lib/db.ts
var db_exports = {};
__export(db_exports, {
  db: () => db,
  dbInfo: () => dbInfo,
  initDb: () => initDb,
  isTauri: () => isTauri,
  resetDemoDb: () => resetDemoDb
});
function aggregate(fn, vals) {
  const nums = vals.filter((v) => typeof v === "number");
  switch (fn.toUpperCase()) {
    case "COUNT":
      return vals.length;
    case "MIN":
      return nums.length ? Math.min(...nums) : null;
    case "MAX":
      return nums.length ? Math.max(...nums) : null;
    case "SUM":
      return nums.reduce((a, b) => a + b, 0);
    case "AVG":
      return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
    default:
      return null;
  }
}
function splitTopLevel(raw) {
  const out = [];
  let depth = 0;
  let inStr = false;
  let cur = "";
  for (const ch of raw) {
    if (ch === "'") inStr = !inStr;
    if (!inStr) {
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
    }
    if (ch === "," && depth === 0 && !inStr) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
function splitAnd(whereRaw) {
  const out = [];
  let depth = 0;
  let inStr = false;
  let cur = "";
  for (let i = 0; i < whereRaw.length; i++) {
    const ch = whereRaw[i];
    if (ch === "'") inStr = !inStr;
    if (!inStr) {
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
    }
    if (depth === 0 && !inStr && /^AND$/i.test(whereRaw.slice(i, i + 3)) && /\s/.test(whereRaw[i - 1] ?? " ") && /\s/.test(whereRaw[i + 3] ?? " ")) {
      out.push(cur);
      cur = "";
      i += 2;
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}
function likeMatch(value, pattern) {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = escaped.replace(/%/g, ".*").replace(/_/g, ".");
  return new RegExp(`^${regex}$`, "is").test(value);
}
function parseAssignments(setRaw) {
  const parts = [];
  let depth = 0;
  let inStr = false;
  let cur = "";
  for (const ch of setRaw) {
    if (ch === "'") inStr = !inStr;
    if (!inStr) {
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
    }
    if (ch === "," && depth === 0 && !inStr) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((pair) => {
    const idx = pair.indexOf("=");
    if (idx < 0) return [pair.trim(), ""];
    return [pair.slice(0, idx).trim(), pair.slice(idx + 1).trim()];
  });
}
function splitStatements(sql) {
  const out = [];
  let cur = "";
  let inStr = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") {
      inStr = !inStr;
      cur += ch;
      continue;
    }
    if (ch === ";" && !inStr) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
async function initDb() {
  if (instance) return info;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    if (isTauri()) {
      const db2 = await SqliteDb.open();
      await db2.migrate();
      instance = db2;
      info = {
        driver: "sqlite",
        location: "%APPDATA%/todo-workbench/todo-workbench.db",
        schemaVersion: db2.schemaVersion
      };
    } else {
      const db2 = new MemoryDb();
      await db2.migrate();
      instance = db2;
      info = {
        driver: "memory",
        location: `${STORAGE_KEY} (localStorage)`,
        schemaVersion: db2.schemaVersion
      };
    }
    return info;
  })();
  try {
    return await initPromise;
  } catch (err) {
    initPromise = null;
    throw err;
  }
}
function db() {
  if (!instance) throw new Error("\u6570\u636E\u5E93\u5C1A\u672A\u521D\u59CB\u5316\uFF0C\u8BF7\u5148 await initDb()");
  return instance;
}
function dbInfo() {
  return info;
}
function resetDemoDb() {
  if (info.driver !== "memory") return;
  localStorage.removeItem(STORAGE_KEY);
  instance = null;
  initPromise = null;
}
var STORAGE_KEY, MemoryDb, SqliteDb, isTauri, instance, info, initPromise;
var init_db = __esm({
  "src/lib/db.ts"() {
    "use strict";
    init_migrations();
    STORAGE_KEY = "todo-workbench:demo-db";
    MemoryDb = class {
      tables = /* @__PURE__ */ new Map();
      version = 0;
      constructor() {
        this.restore();
      }
      restore() {
        try {
          const raw = localStorage.getItem(STORAGE_KEY);
          if (!raw) return;
          const snap = JSON.parse(raw);
          this.version = snap.version ?? 0;
          for (const [name, rows3] of snap.tables ?? []) {
            this.tables.set(name, { name, rows: rows3 });
          }
        } catch {
        }
      }
      persist() {
        try {
          const tables = [];
          for (const [name, t2] of this.tables) tables.push([name, t2.rows]);
          localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify({ version: this.version, tables })
          );
        } catch {
        }
      }
      table(name) {
        let t2 = this.tables.get(name);
        if (!t2) {
          t2 = { name, rows: [] };
          this.tables.set(name, t2);
        }
        return t2;
      }
      /** 执行 DDL / DML，返回受影响行数 */
      run(sql, params = []) {
        const s = sql.trim().replace(/;$/, "");
        const create = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i.exec(s);
        if (create) {
          this.table(create[1]);
          return 0;
        }
        if (/^CREATE\s+(?:UNIQUE\s+)?INDEX/i.test(s)) return 0;
        if (/^PRAGMA/i.test(s)) return 0;
        const insert = /^INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i.exec(s);
        if (insert) {
          const [, tableName, colsRaw, valsRaw] = insert;
          const cols = colsRaw.split(",").map((c) => c.trim());
          const vals = valsRaw.split(",").map((v) => v.trim());
          let pi = 0;
          const row = {};
          cols.forEach((col, i) => {
            row[col] = vals[i] === "?" ? params[pi++] ?? null : this.literal(vals[i]);
          });
          this.table(tableName).rows.push(row);
          return 1;
        }
        const update = /^UPDATE\s+(\w+)\s+SET\s+(.+?)(?:\s+WHERE\s+(.+))?$/is.exec(s);
        if (update) {
          const [, tableName, setRaw, whereRaw] = update;
          const assigns = parseAssignments(setRaw);
          const setParamCount = assigns.filter(([, v]) => v === "?").length;
          const whereBase = setParamCount;
          const target = this.table(tableName);
          let n = 0;
          for (const row of target.rows) {
            if (whereRaw && !this.match(row, whereRaw, params, whereBase)) continue;
            let pi = 0;
            for (const [col, valExpr] of assigns) {
              row[col] = valExpr === "?" ? params[pi++] ?? null : this.literal(valExpr);
            }
            n++;
          }
          return n;
        }
        const del = /^DELETE\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+))?$/is.exec(s);
        if (del) {
          const [, tableName, whereRaw] = del;
          const target = this.table(tableName);
          const before = target.rows.length;
          target.rows = whereRaw ? target.rows.filter((r) => !this.match(r, whereRaw, params)) : [];
          return before - target.rows.length;
        }
        return 0;
      }
      /** 把 SQL 字面量转成 JS 值 */
      literal(token) {
        const t2 = token.trim();
        if (/^NULL$/i.test(t2)) return null;
        if (/^'.*'$/s.test(t2)) return t2.slice(1, -1).replace(/''/g, "'");
        const n = Number(t2);
        if (!Number.isNaN(n) && t2 !== "") return n;
        return t2;
      }
      /**
       * 极简 WHERE 求值。
       *
       * 支持：col op ? / col op 字面量、col IS NULL / IS NOT NULL、col LIKE ?，
       * 多条件一律按 AND 处理。
       *
       * @param base 本条件在整体参数数组中的起始偏移。
       *   UPDATE 语句里 SET 子句会先消耗掉若干参数，WHERE 必须从它之后开始取，
       *   否则会读到属于 SET 的参数，导致更新条件错乱。
       */
      match(row, whereRaw, params, base = 0) {
        let pi = base;
        const conds = splitAnd(whereRaw);
        for (const cond of conds) {
          const c = cond.trim().replace(/^\(+|\)+$/g, "").trim();
          const isNull = /^(\w+)\s+IS\s+NULL$/i.exec(c);
          if (isNull) {
            if (row[isNull[1]] !== null && row[isNull[1]] !== void 0) return false;
            continue;
          }
          const notNull = /^(\w+)\s+IS\s+NOT\s+NULL$/i.exec(c);
          if (notNull) {
            if (row[notNull[1]] === null || row[notNull[1]] === void 0) return false;
            continue;
          }
          const like = /^(\w+)\s+(?:NOT\s+)?LIKE\s+(.+)$/i.exec(c);
          if (like) {
            const [, col, rhs] = like;
            const negate = /\sNOT\s+LIKE/i.test(c);
            const pattern = String(rhs === "?" ? params[pi++] ?? "" : this.literal(rhs));
            const hit = likeMatch(String(row[col] ?? ""), pattern);
            if (negate ? hit : !hit) return false;
            continue;
          }
          const cmp = /^(\w+)\s*(=|!=|<>|>=|<=|>|<)\s*(.+)$/.exec(c);
          if (cmp) {
            const [, col, op, rhs] = cmp;
            const left = row[col];
            const right = rhs === "?" ? params[pi++] : this.literal(rhs);
            const l = typeof left === "boolean" ? left ? 1 : 0 : left;
            const r = typeof right === "boolean" ? right ? 1 : 0 : right;
            switch (op) {
              case "=":
                if (l !== r) return false;
                break;
              case "!=":
              case "<>":
                if (l === r) return false;
                break;
              case ">":
                if (!(l > r)) return false;
                break;
              case "<":
                if (!(l < r)) return false;
                break;
              case ">=":
                if (!(l >= r)) return false;
                break;
              case "<=":
                if (!(l <= r)) return false;
                break;
            }
            continue;
          }
          return false;
        }
        return true;
      }
      /** 极简 SELECT：支持 WHERE / GROUP BY / ORDER BY / LIMIT，以及常见聚合函数 */
      query(sql, params = []) {
        const s = sql.trim().replace(/;$/, "");
        const m = /^SELECT\s+(.+?)\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+?))?(?:\s+GROUP\s+BY\s+(.+?))?(?:\s+ORDER\s+BY\s+(.+?))?(?:\s+LIMIT\s+(\d+))?$/is.exec(
          s
        );
        if (!m) return [];
        const [, colsRaw, tableName, whereRaw, groupRaw, orderRaw, limitRaw] = m;
        let rows3 = [...this.table(tableName).rows];
        if (whereRaw) rows3 = rows3.filter((r) => this.match(r, whereRaw, params));
        if (groupRaw) {
          const groupCols = groupRaw.split(",").map((c) => c.trim());
          const buckets = /* @__PURE__ */ new Map();
          for (const r of rows3) {
            const key = groupCols.map((c) => String(r[c] ?? "")).join("\0");
            if (!buckets.has(key)) buckets.set(key, []);
            buckets.get(key).push(r);
          }
          const projections = splitTopLevel(colsRaw);
          const out = [];
          for (const [, groupRows] of buckets) {
            const row = {};
            for (const p of projections) {
              const aggM = /^(COUNT|MIN|MAX|SUM|AVG)\((.+?)\)(?:\s+AS\s+(\w+)|\s+(\w+))?$/i.exec(p.trim());
              if (aggM) {
                const [, fn, inner, aliasA, aliasB] = aggM;
                const alias = aliasA ?? aliasB ?? fn.toLowerCase();
                row[alias] = aggregate(fn, groupRows.map((r) => r[inner.trim()]));
                continue;
              }
              const colM = /^(\w+)(?:\s+AS\s+(\w+))?$/i.exec(p.trim());
              if (colM) {
                const [, col, alias] = colM;
                row[alias ?? col] = groupRows[0]?.[col] ?? null;
              }
            }
            out.push(row);
          }
          rows3 = out;
          return rows3;
        }
        if (orderRaw) {
          const terms = orderRaw.split(",").map((t2) => t2.trim().split(/\s+/));
          rows3.sort((a, b) => {
            for (const [col, dir] of terms) {
              const av = a[col];
              const bv = b[col];
              if (av === bv) continue;
              if (av === null || av === void 0) return 1;
              if (bv === null || bv === void 0) return -1;
              const cmp = av > bv ? 1 : -1;
              return /DESC/i.test(dir ?? "") ? -cmp : cmp;
            }
            return 0;
          });
        }
        if (limitRaw) rows3 = rows3.slice(0, Number(limitRaw));
        const countMatch = /^COUNT\(\*\)(?:\s+AS\s+(\w+))?$/i.exec(colsRaw.trim());
        if (countMatch) {
          const alias = countMatch[1] ?? "count";
          return [{ [alias]: rows3.length }];
        }
        const agg = /^(COUNT|MIN|MAX|SUM|AVG)\((.+?)\)(?:\s+AS\s+(\w+))?$/i.exec(colsRaw.trim());
        if (agg) {
          const [, fn, inner, aliasRaw] = agg;
          const alias = aliasRaw ?? fn.toLowerCase();
          return [{ [alias]: aggregate(fn, rows3.map((r) => r[inner.trim()])) }];
        }
        if (colsRaw.trim() === "*") return rows3;
        const wanted = colsRaw.split(",").map((c) => c.trim().split(/\s+AS\s+/i).pop().trim());
        return rows3.map((r) => {
          const out = {};
          for (const w of wanted) out[w] = r[w] ?? null;
          return out;
        });
      }
      async select(sql, params) {
        return this.query(sql, params);
      }
      async execute(sql, params) {
        for (const stmt of splitStatements(sql)) {
          this.run(stmt, params);
        }
        this.persist();
      }
      async transaction(statements) {
        const snapshot = /* @__PURE__ */ new Map();
        for (const [name, t2] of this.tables) snapshot.set(name, t2.rows.map((r) => ({ ...r })));
        try {
          for (const { sql, params } of statements) {
            for (const stmt of splitStatements(sql)) this.run(stmt, params ?? []);
          }
          this.persist();
        } catch (err) {
          this.tables = new Map(
            [...snapshot].map(([name, rows3]) => [name, { name, rows: rows3 }])
          );
          throw err;
        }
      }
      /** 应用迁移并把 user_version 落在内存里 */
      async migrate() {
        const pending = migrations.filter((m) => m.version > this.version);
        for (const m of pending) {
          await this.transaction([{ sql: m.sql }]);
          this.version = m.version;
          this.persist();
        }
      }
      get schemaVersion() {
        return this.version;
      }
    };
    SqliteDb = class _SqliteDb {
      conn;
      constructor(conn) {
        this.conn = conn;
      }
      static async open() {
        const mod = await Promise.resolve().then(() => (init_dist_js(), dist_js_exports));
        const conn = await mod.default.load("sqlite:todo-workbench.db");
        return new _SqliteDb(conn);
      }
      async select(sql, params) {
        return await this.conn.select(sql, params ?? []);
      }
      async execute(sql, params) {
        await this.conn.execute(sql, params ?? []);
      }
      async transaction(statements) {
        await this.conn.execute("BEGIN", []);
        try {
          for (const { sql, params } of statements) {
            await this.conn.execute(sql, params ?? []);
          }
          await this.conn.execute("COMMIT", []);
        } catch (err) {
          await this.conn.execute("ROLLBACK", []);
          throw err;
        }
      }
      async migrate() {
        const rows3 = await this.select("PRAGMA user_version");
        const current = rows3[0]?.user_version ?? 0;
        for (const m of migrations.filter((x) => x.version > current)) {
          await this.transaction([{ sql: m.sql }]);
          await this.execute(`PRAGMA user_version = ${m.version}`);
        }
      }
      get schemaVersion() {
        return CURRENT_SCHEMA_VERSION;
      }
    };
    isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
    instance = null;
    info = {
      driver: "memory",
      location: `${STORAGE_KEY} (localStorage)`,
      schemaVersion: 0
    };
    initPromise = null;
  }
});

// src/lib/tools.ts
function toolTable(toolId, table) {
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(toolId)) {
    throw new Error(`\u975E\u6CD5\u7684\u5DE5\u5177 id: ${toolId}`);
  }
  if (!/^[a-z][a-z0-9_]{0,47}$/.test(table)) {
    throw new Error(`\u975E\u6CD5\u7684\u8868\u540D: ${table}`);
  }
  return `tool_${toolId.replace(/-/g, "_")}_${table}`;
}
var init_tools = __esm({
  "src/lib/tools.ts"() {
    "use strict";
    init_db();
  }
});

// src/lib/repo.ts
var repo_exports = {};
__export(repo_exports, {
  LIST_COLORS: () => LIST_COLORS,
  addDays: () => addDays,
  createList: () => createList,
  createTask: () => createTask,
  deleteList: () => deleteList,
  deleteTask: () => deleteTask,
  ensureToolTable: () => ensureToolTable,
  fetchCounts: () => fetchCounts,
  fetchLists: () => fetchLists,
  fetchTasks: () => fetchTasks,
  renameList: () => renameList,
  seedIfEmpty: () => seedIfEmpty,
  today: () => today,
  updateTask: () => updateTask
});
function today() {
  const d = /* @__PURE__ */ new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function addDays(dateStr, days) {
  const d = /* @__PURE__ */ new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + days);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
async function fetchLists() {
  const rows3 = await db().select(
    `SELECT * FROM core_lists WHERE deleted = 0 ORDER BY sort_order ASC`
  );
  return rows3.map(toList);
}
async function createList(name, color) {
  const existing = await fetchLists();
  const list = {
    id: uid(),
    name,
    color: color ?? LIST_COLORS[existing.length % LIST_COLORS.length],
    sortOrder: existing.length,
    deleted: false,
    createdAt: now(),
    updatedAt: now()
  };
  await db().execute(
    `INSERT INTO core_lists (id, name, color, sort_order, deleted, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, ?)`,
    [list.id, list.name, list.color, list.sortOrder, list.createdAt, list.updatedAt]
  );
  return list;
}
async function renameList(id, name) {
  await db().execute(`UPDATE core_lists SET name = ?, updated_at = ? WHERE id = ?`, [
    name,
    now(),
    id
  ]);
}
async function deleteList(id) {
  await db().transaction([
    { sql: `UPDATE core_lists SET deleted = 1, updated_at = ? WHERE id = ?`, params: [now(), id] },
    { sql: `UPDATE core_tasks SET deleted = 1, updated_at = ? WHERE list_id = ?`, params: [now(), id] }
  ]);
}
async function fetchTasks(q) {
  const where = ["deleted = 0"];
  const params = [];
  switch (q.view) {
    case "myday":
      where.push("my_day = 1");
      break;
    case "important":
      where.push("important = 1");
      break;
    case "planned":
      where.push("due_date IS NOT NULL");
      break;
    case "list":
      where.push("list_id = ?");
      params.push(q.listId ?? "");
      break;
    case "all":
      break;
  }
  if (!q.includeDone) where.push("done = 0");
  if (q.search?.trim()) {
    where.push("title LIKE ?");
    params.push(`%${q.search.trim()}%`);
  }
  const rows3 = await db().select(
    `SELECT * FROM core_tasks WHERE ${where.join(" AND ")}
     ORDER BY done ASC, sort_order ASC, created_at DESC`,
    params
  );
  return rows3.map(toTask);
}
async function createTask(input) {
  const rows3 = await db().select(
    `SELECT MIN(sort_order) AS m FROM core_tasks WHERE list_id = ? AND deleted = 0`,
    [input.listId]
  );
  const sortOrder = (rows3[0]?.m ?? 0) - 1;
  const task = {
    id: uid(),
    listId: input.listId,
    title: input.title,
    note: input.note ?? "",
    done: false,
    important: input.important ?? false,
    myDay: input.myDay ?? false,
    dueDate: input.dueDate ?? null,
    remindAt: null,
    completedAt: null,
    sortOrder,
    deleted: false,
    createdAt: now(),
    updatedAt: now()
  };
  await db().execute(
    `INSERT INTO core_tasks
       (id, list_id, title, note, done, important, my_day, due_date, remind_at,
        completed_at, sort_order, deleted, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?, NULL, NULL, ?, 0, ?, ?)`,
    [
      task.id,
      task.listId,
      task.title,
      task.note,
      task.important ? 1 : 0,
      task.myDay ? 1 : 0,
      task.dueDate,
      task.sortOrder,
      task.createdAt,
      task.updatedAt
    ]
  );
  return task;
}
async function updateTask(id, patch) {
  const sets = [];
  const params = [];
  for (const [key, value] of Object.entries(patch)) {
    const col = TASK_COLUMNS[key];
    if (!col) continue;
    sets.push(`${col} = ?`);
    params.push(typeof value === "boolean" ? value ? 1 : 0 : value);
  }
  if (!sets.length) return;
  if (typeof patch.done === "boolean") {
    sets.push("completed_at = ?");
    params.push(patch.done ? now() : null);
  }
  sets.push("updated_at = ?");
  params.push(now());
  params.push(id);
  await db().execute(`UPDATE core_tasks SET ${sets.join(", ")} WHERE id = ?`, params);
}
async function deleteTask(id) {
  await db().execute(`UPDATE core_tasks SET deleted = 1, updated_at = ? WHERE id = ?`, [
    now(),
    id
  ]);
}
async function fetchCounts() {
  const [myday, all, byList] = await Promise.all([
    db().select(
      `SELECT COUNT(*) AS c FROM core_tasks WHERE deleted = 0 AND done = 0 AND my_day = 1`
    ),
    db().select(
      `SELECT COUNT(*) AS c FROM core_tasks WHERE deleted = 0 AND done = 0`
    ),
    db().select(
      `SELECT list_id, COUNT(*) AS c FROM core_tasks
       WHERE deleted = 0 AND done = 0 GROUP BY list_id`
    )
  ]);
  const map = {};
  for (const r of byList) map[r.list_id] = r.c;
  return {
    myday: myday[0]?.c ?? 0,
    all: all[0]?.c ?? 0,
    byList: map
  };
}
function seedIfEmpty() {
  if (!seedPromise) {
    seedPromise = seedIfEmptyInner().catch((err) => {
      seedPromise = null;
      throw err;
    });
  }
  return seedPromise;
}
async function seedIfEmptyInner() {
  const lists2 = await fetchLists();
  if (lists2.length) return;
  const work2 = await createList("\u5DE5\u4F5C", "#d4537e");
  await createList("\u4E2A\u4EBA", "#378add");
  const samples = [
    { listId: work2.id, title: "1027 \u6539\u7801\u53D1\u8D27", myDay: true, important: true },
    { listId: work2.id, title: "\u6574\u7406\u672C\u5468\u8BA2\u5355\u8BB0\u5F55", myDay: true, dueDate: today() },
    { listId: work2.id, title: "\u786E\u8BA4\u56FE\u7247\u88C1\u526A\u5DE5\u5177\u7684\u5BFC\u51FA\u6548\u679C", dueDate: addDays(today(), 1) },
    { listId: work2.id, title: "\u68B3\u7406\u5DE5\u4F5C\u53F0\u63D2\u4EF6\u63A5\u53E3\u8349\u6848" }
  ];
  for (const s of samples) await createTask(s);
  const all = await fetchTasks({ view: "list", listId: work2.id, includeDone: true });
  const done = all.find((t2) => t2.title.includes("\u63D2\u4EF6\u63A5\u53E3"));
  if (done) await updateTask(done.id, { done: true });
}
async function ensureToolTable(toolId) {
  const table = toolTable(toolId, "orders");
  await db().execute(`
    CREATE TABLE IF NOT EXISTS ${table} (
      id         TEXT PRIMARY KEY,
      order_no   TEXT NOT NULL,
      amount     REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `);
  return table;
}
var now, uid, toTask, toList, LIST_COLORS, TASK_COLUMNS, seedPromise;
var init_repo = __esm({
  "src/lib/repo.ts"() {
    "use strict";
    init_db();
    init_tools();
    now = () => (/* @__PURE__ */ new Date()).toISOString();
    uid = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    toTask = (r) => ({
      id: r.id,
      listId: r.list_id,
      title: r.title,
      note: r.note,
      done: !!r.done,
      important: !!r.important,
      myDay: !!r.my_day,
      dueDate: r.due_date,
      remindAt: r.remind_at,
      completedAt: r.completed_at,
      sortOrder: r.sort_order,
      deleted: !!r.deleted,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    });
    toList = (r) => ({
      id: r.id,
      name: r.name,
      color: r.color,
      sortOrder: r.sort_order,
      deleted: !!r.deleted,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    });
    LIST_COLORS = [
      "#d4537e",
      "#378add",
      "#1d9e75",
      "#ba7517",
      "#534ab7",
      "#d85a30",
      "#888780"
    ];
    TASK_COLUMNS = {
      title: "title",
      note: "note",
      done: "done",
      important: "important",
      myDay: "my_day",
      dueDate: "due_date",
      remindAt: "remind_at",
      completedAt: "completed_at",
      sortOrder: "sort_order",
      listId: "list_id"
    };
    seedPromise = null;
  }
});

// tests/_diag.mjs
import { JSDOM } from "jsdom";
var dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
var { initDb: initDb2, resetDemoDb: resetDemoDb2 } = await Promise.resolve().then(() => (init_db(), db_exports));
var repo = await Promise.resolve().then(() => (init_repo(), repo_exports));
resetDemoDb2();
await initDb2();
await repo.seedIfEmpty();
var lists = await repo.fetchLists();
var work = lists.find((l) => l.name === "\u5DE5\u4F5C");
var t = await repo.createTask({ listId: work.id, title: "X", myDay: true });
console.log("\u521B\u5EFA\u540E myday \u67E5\u8BE2:", (await repo.fetchTasks({ view: "myday" })).map((x) => x.title));
await repo.updateTask(t.id, { done: true });
var rows = await repo.fetchTasks({ view: "myday", includeDone: true });
console.log("\u5B8C\u6210\u540E myday(\u542Bdone) \u67E5\u8BE2:", rows.map((x) => ({ t: x.title, done: x.done, myDay: x.myDay })));
var rows2 = await repo.fetchTasks({ view: "myday" });
console.log("\u5B8C\u6210\u540E myday(\u4E0D\u542Bdone) \u67E5\u8BE2:", rows2.map((x) => x.title));

//! 真正原子的事务 —— 补上 tauri-plugin-sql 缺的那一块。
//!
//! ## 为什么 JS 侧拼不出事务
//!
//! 插件的 `execute` / `select` 命令，实现都是这一句：
//!
//! ```ignore
//! let result = pool.execute(query).await?;   // wrapper.rs
//! ```
//!
//! `pool.execute(..)` 是 `Executor for &Pool`，语义是**从连接池现取一条连接、
//! 执行完就还回去**。而 sqlx 的池默认 `max_connections = 10`，
//! 空闲连接放在 `ArrayQueue` 里 —— push 尾、pop 头，也就是 **FIFO 轮转**。
//!
//! 于是前端把 `BEGIN / DELETE / INSERT / COMMIT` 发成四次独立 IPC 时，
//! 它们很可能落在**四条不同的连接**上：
//!
//! ```text
//! BEGIN  → 连接 A   （A 带着一个未提交事务被还回池里）
//! DELETE → 连接 B   autocommit，立刻生效          ← 原数据真的没了
//! INSERT → 连接 A   落进那个未提交事务            ← 别的连接看不见（WAL）
//! COMMIT → 连接 C   "cannot commit - no transaction is active" → 抛错
//! ```
//!
//! 净效果是**写入既没提交、原行又被删掉了**，而异常在上层是 `void saveSettings(..)`
//! 的 fire-and-forget，直接吞掉。实测后果：用户库里 `core_settings` 永远是 0 行，
//! 界面上表现为「拖完面板宽度松手就弹回，重启也不记得」。
//!
//! 顺带解释了两个看似矛盾的现象：任务 / 工单 / 清单都好好的（它们是**单语句**
//! `execute`，autocommit 必然提交），而迁移也正常（迁移虽然也走 transaction，
//! 但发生在启动期、池里还只有一条连接，四条语句恰好都用它）。
//!
//! ## 这里怎么做
//!
//! 把整段事务放在**同一条 `pool.acquire()` 出来的连接**上执行。
//! 连接在事务结束前不会还给池，`BEGIN` 和 `COMMIT` 必然是同一条 —— 这才是事务。
//!
//! `BEGIN` 而不是 `BEGIN IMMEDIATE`：本应用是单进程单写入者，deferred 足够，
//! 且与前端原来的写法保持一致。

use serde::Deserialize;
use serde_json::Value as JsonValue;
use sqlx::sqlite::SqliteConnection;
use sqlx::{Pool, Sqlite};
use tauri_plugin_sql::{DbInstances, DbPool};

/// 一条待执行语句。形状与前端 `Db.transaction` 的参数一致。
#[derive(Deserialize)]
pub struct TxStatement {
    pub sql: String,
    #[serde(default)]
    pub params: Vec<JsonValue>,
}

/// 在**一条连接**上原子地执行一批语句。
///
/// 任一步失败则整体回滚，并把错误原文交给前端 ——
/// 前端的 `saveSettings` 靠它决定要不要回退界面状态。
#[tauri::command]
pub async fn db_transaction(
    instances: tauri::State<'_, DbInstances>,
    db: String,
    statements: Vec<TxStatement>,
) -> Result<(), String> {
    let instances = instances.0.read().await;

    // 本应用只启用了 sqlite 一个驱动，所以 `DbPool` 只有这一个变体。
    // 不写兜底分支是故意的：日后若启用了 mysql/postgres，这个 match 会变成
    // 非穷尽，编译期就会提醒有人来把新驱动接上，而不是运行时静默走错分支。
    let pool: &Pool<Sqlite> = match instances.get(&db) {
        Some(DbPool::Sqlite(p)) => p,
        None => return Err(format!("数据库未加载: {db}")),
    };

    // 关键的一步：整段事务期间独占这条连接。
    let mut conn = pool.acquire().await.map_err(|e| e.to_string())?;

    sqlx::query("BEGIN")
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;

    match bind_and_run(&mut conn, &statements).await {
        Ok(()) => sqlx::query("COMMIT")
            .execute(&mut *conn)
            .await
            .map(|_| ())
            .map_err(|e| e.to_string()),
        Err(e) => {
            // 回滚本身失败没有更好的补救办法，但**不能把原始错误吞掉** ——
            // 它才是调用方需要知道的那条信息。
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            Err(e)
        }
    }
}

/// 逐条绑定参数并执行。绑定逻辑与插件 wrapper.rs 保持一致：
/// 数字统一按 f64 绑（`core_tasks.id` 这类 INTEGER 列在 SQLite 里
/// 与 REAL 比较仍相等），字符串绑定拥有所有权的 `String`，null 绑 `None`。
async fn bind_and_run(conn: &mut SqliteConnection, statements: &[TxStatement]) -> Result<(), String> {
    for st in statements {
        let mut q = sqlx::query(st.sql.as_str());
        for v in &st.params {
            q = if v.is_null() {
                q.bind(None::<JsonValue>)
            } else if let Some(s) = v.as_str() {
                q.bind(s.to_owned())
            } else if let Some(n) = v.as_number() {
                q.bind(n.as_f64().unwrap_or_default())
            } else {
                q.bind(v.clone())
            };
        }
        q.execute(&mut *conn).await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

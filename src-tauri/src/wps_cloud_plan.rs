//! 台账列定义与「在线表格同步」的纯逻辑 —— 不依赖 tauri / reqwest / 网络。
//!
//! 单独成一个文件，是为了能**离线编译成测试程序**跑一遍：
//! `plan_cloud_write` 决定"写哪几列、会不会覆盖用户自己的列"，
//! 这条逻辑错了会直接改坏用户的原表，不能只靠跑一次真表格来验证。
//! 宿主侧的 `wps_mcp.rs` 只负责 MCP 会话与命令封装，这里负责算。

use serde_json::{json, Map as JsonMap, Value as Json};

/// 台账列：左边是 SQLite 列名，右边是在线表格里的表头（顺序即列顺序）。
///
/// ⚠️ 与 `src/lib/kwiki.ts` 的 COLUMNS 是**同一份约定的两个拷贝** ——
/// 改一处必须改另一处，否则推上去的表头和拉回来的映射会对不上。
/// 之所以容忍这份重复：Rust 侧不该去 import 前端，而两侧的解析逻辑
/// （状态派生、键值比对）又必须完全一致。
pub const COLUMNS: &[(&str, &str)] = &[
    ("order_sn", "订单号"),
    ("tracking_no", "快递单号"),
    ("courier", "快递公司"),
    ("shipped_at", "发货时间"),
    ("store", "店铺"),
    ("category", "情况"),
    ("title", "详细描述"),
    ("handling", "处理方式"),
    ("result", "结果"),
    ("settled", "结账"),
    ("_status", "当前状态"),
    ("note", "处理情况"),
    ("created_at", "登记时间"),
    ("updated_at", "更新时间"),
];

/// JSON 值 → 表格里的文本。数字要原样吐出来（订单号 19 位不能变科学计数）。
pub fn cell_text(v: &Json) -> String {
    match v {
        Json::String(s) => s.clone(),
        Json::Number(n) => n.to_string(),
        Json::Bool(b) => {
            if *b {
                "1".into()
            } else {
                String::new()
            }
        }
        _ => String::new(),
    }
}

/// 算出"写哪几列、每列写什么、多出来的旧行清到哪"。
///
/// 返回 `(cols, clear, appended)`：`cols` 是每列要写的内容，`clear` 是要
/// 清掉的多余旧行，`appended` 是补在末尾的列数。原则：**只碰台账这 14 列**，
/// 用户自己加的列（备注 / 公式）一个都不动；表里没有的列补在最后，不插在中间。
/// 表头能不能认：有内容却一个台账列名都不认 → 多半是用户自己的表头，停手。
///
/// ★ 判据是"有没有非空格"，不是 `!header.is_empty()`：读回来的网格会补齐
///   成等宽，一张**全空的表**第一行也是 `["", "", …]` —— 向量非空但全是
///   空串。按旧判据它会被当成"用户的表头"报错，可它明明是张空表，
///   该往下走、把 14 列表头自己写进去（2026-10-19 测试异常单.ksheet 实踩）。
fn check_header(header: &[String]) -> Result<(), String> {
    let known: std::collections::HashSet<&str> = COLUMNS.iter().map(|(_, h)| *h).collect();
    let hits = header.iter().filter(|h| known.contains(h.trim())).count();
    let has_text = header.iter().any(|h| !h.trim().is_empty());
    if has_text && hits == 0 {
        return Err(format!(
            "这张表第一行是「{}」—— 一个台账列名都没认出来。请把第一行改成台账表头（订单号 / 快递单号 / 快递公司…），或者清空第一行让程序自己写。",
            clip(
                &header
                    .iter()
                    .map(|h| h.trim())
                    .filter(|h| !h.is_empty())
                    .collect::<Vec<_>>()
                    .join(" / "),
                120
            )
        ));
    }
    Ok(())
}

/// 台账 14 列各自落在表上第几列（1-based），认不出的补在末尾。
///
/// 补列的起点是**最后一个非空表头格**之后，不是 `header.len()`：读回来的
/// 网格会补齐成等宽，末尾几个空串会让补列落在 15、16，在表中间挖出空列。
fn locate_columns(header: &[String]) -> (Vec<(&'static str, &'static str, usize)>, usize) {
    let mut next = header
        .iter()
        .rposition(|h| !h.trim().is_empty())
        .map(|i| i + 1)
        .unwrap_or(0);
    let mut appended = 0;
    let mut out = Vec::with_capacity(COLUMNS.len());
    for &(key, label) in COLUMNS {
        let col = match header.iter().position(|h| h.trim() == label) {
            Some(i) => i + 1,
            None => {
                next += 1;
                appended += 1;
                next
            }
        };
        out.push((key, label, col));
    }
    (out, appended)
}

/// 一条数据的主键：**订单号，没有就用快递单号**（与 `kwiki.ts` 的 keyOf 同口径）。
///
/// 两边规则必须一字不差，否则"同一条单"会被认成两条，推一次多一行。
pub fn row_key(v: &JsonMap<String, Json>) -> String {
    let sn = norm_key(&v.get("order_sn").map(cell_text).unwrap_or_default());
    if !sn.is_empty() {
        return sn;
    }
    norm_key(&v.get("tracking_no").map(cell_text).unwrap_or_default())
}

/// 主键的归一化：去掉首尾空白，也去掉"当文本写"留下的前导单引号
/// （表上读回来的单号可能带它）。
fn norm_key(s: &str) -> String {
    s.trim().trim_start_matches('\'').trim().to_string()
}

/// 表上某一行的主键：按列位置把订单号 / 快递单号取出来。
fn grid_row_key(grow: &[String], located: &[(&str, &str, usize)]) -> String {
    let pick = |key: &str| -> String {
        located
            .iter()
            .find(|(k, _, _)| *k == key)
            .and_then(|(_, _, c)| grow.get(*c - 1))
            .map(|s| norm_key(s))
            .unwrap_or_default()
    };
    let a = pick("order_sn");
    if !a.is_empty() {
        return a;
    }
    pick("tracking_no")
}

/// 增量同步要写的一个格（行号、列号都是**表上的** 1-based 行号）
#[derive(Debug, Clone)]
pub struct SyncCell {
    pub row: usize,
    pub col: usize,
    pub value: String,
    /// 台账列名 —— 写格时靠它认「单号列」（那两列要当文本写）
    pub key: String,
    pub label: String,
}

/// 表上有、本地没有的行。**不删**，只报出来让人知道（那可能是别人手工加的）。
#[derive(Debug, Clone)]
pub struct SyncOrphan {
    pub row: usize,
    pub key: String,
}

/// 增量同步的结果：只写"新增的行"和"值真的变了的格"。
#[derive(Debug)]
pub struct SyncPlan {
    pub cols: Vec<(String, String, usize)>,
    /// 表里原来没有、这次补在末尾的列数
    pub appended: usize,
    /// 新增的行（每行是按 cols 顺序排好的值）
    pub appends: Vec<Vec<String>>,
    /// 新增的行从表上第几行开始写（1-based）
    pub append_start: usize,
    pub updates: Vec<SyncCell>,
    pub orphans: Vec<SyncOrphan>,
}

/// 算出"这次推送到底要写哪几格" —— **增量**，不是整本覆盖。
///
/// 表越大越不能全量写：几百行里改一格，却把整张表重写一遍，既慢又危险
/// （万一读到的是旧网格，会把别人刚填的内容抹掉）。所以这里做的是对账：
///   · 本地有、表上没有        → 追加一行
///   · 两边都有、值不一样      → 只写那些**变了**的格
///   · 表上有、本地没有        → 不动，报出来（orphans）
///   · 一边是空的              → 不当改动（别把已有的值抹掉）
pub fn plan_cloud_sync(
    header: &[String],
    grid: &[Vec<String>],
    rows: &[JsonMap<String, Json>],
) -> Result<SyncPlan, String> {
    check_header(header)?;
    let (located, appended) = locate_columns(header);
    let cols: Vec<(String, String, usize)> = located
        .iter()
        .map(|(k, l, c)| ((*k).to_string(), (*l).to_string(), *c))
        .collect();

    let mut lmap: std::collections::HashMap<String, &JsonMap<String, Json>> =
        std::collections::HashMap::new();
    let mut order: Vec<String> = Vec::new();
    for r in rows {
        let k = row_key(r);
        if k.is_empty() {
            continue; // 两个单号都没有 —— 与登记校验同一个口径，不当数据
        }
        if !lmap.contains_key(&k) {
            order.push(k.clone());
            lmap.insert(k, r);
        }
    }

    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut updates: Vec<SyncCell> = Vec::new();
    let mut orphans: Vec<SyncOrphan> = Vec::new();
    // 默认追加在表尾；中间有整行空着的就先填那个洞，不留空行
    let mut append_start = grid.len() + 1;

    for (i, grow) in grid.iter().enumerate().skip(1) {
        let row_no = i + 1; // 1-based 表行号
        let key = grid_row_key(grow, &located);
        if key.is_empty() {
            // 整行空 → 记下来给新行用（有单号却空着的行不算）
            if append_start > row_no && grow.iter().all(|c| c.trim().is_empty()) {
                append_start = row_no;
            }
            continue;
        }
        seen.insert(key.clone());
        let mine = match lmap.get(&key) {
            Some(r) => *r,
            None => {
                orphans.push(SyncOrphan { row: row_no, key });
                continue;
            }
        };
        for (k, label, col) in &cols {
            let want = mine.get(k.as_str()).map(cell_text).unwrap_or_default();
            let want = want.trim().to_string();
            if want.is_empty() {
                continue; // 本地空着 —— 不当"改动"，别把表上已有的值抹掉
            }
            let have = grow
                .get(*col - 1)
                .map(|s| norm_key(s))
                .unwrap_or_default();
            if have != want {
                updates.push(SyncCell {
                    row: row_no,
                    col: *col,
                    value: want,
                    key: k.clone(),
                    label: label.clone(),
                });
            }
        }
    }

    let appends: Vec<Vec<String>> = order
        .iter()
        .filter(|k| !seen.contains(k.as_str()))
        .map(|k| {
            let r = lmap[k.as_str()];
            cols.iter()
                .map(|(ck, _, _)| r.get(ck.as_str()).map(cell_text).unwrap_or_default())
                .collect()
        })
        .collect();

    Ok(SyncPlan {
        cols,
        appended,
        appends,
        append_start,
        updates,
        orphans,
    })
}

pub fn plan_cloud_write(
    header: &[String],
    old_rows: usize,
    rows: &[JsonMap<String, Json>],
) -> Result<(Vec<Json>, Vec<Json>, usize), String> {
    check_header(header)?;
    let (located, appended) = locate_columns(header);
    let mut cols: Vec<Json> = Vec::new();
    let mut clear: Vec<Json> = Vec::new();
    for (key, label, col) in &located {
        let mut values: Vec<Json> = Vec::with_capacity(rows.len() + 1);
        // 补列时把表头也写上；已有列也重写一遍表头（同一个值，不影响）
        values.push(Json::String((*label).to_string()));
        for r in rows {
            values.push(Json::String(r.get(*key).map(cell_text).unwrap_or_default()));
        }
        if old_rows + 1 > values.len() {
            clear.push(json!({
                "col": col,
                "from": values.len() + 1,
                "to": old_rows + 1,
            }));
        }
        // key 一起带出去：写格时得知道这一列是不是"单号列"
        // （那两列必须当文本写，不然 WPS 会把运单号存成数字）
        cols.push(json!({ "col": col, "key": *key, "values": values }));
    }
    Ok((cols, clear, appended))
}

/// 一个格最终写进在线表格的文本。
///
/// 长数字必须**当文本写**：服务端按 double 存，19 位订单号末尾直接丢了。
/// 实测（2026-10-19）：直写 `6931234567890123456` → 读回 `6.93123E+18`；
/// 前导单引号之后读回一字不差。前导零同理（"007" 当数字写就变 7）。
pub fn formula_of(v: &str) -> String {
    let digits = !v.is_empty() && v.chars().all(|c| c.is_ascii_digit());
    if digits && (v.len() >= 15 || (v.len() > 1 && v.starts_with('0'))) {
        return format!("'{v}");
    }
    v.to_string()
}

/// 按**列**决定要不要前置单引号。
///
/// 单号列（订单号 / 快递单号）一律当文本：2026-10-20 实测，12~14 位的纯数字
/// 运单号（中通、韵达都是这个长度）虽然没到 15 位不会被丢精度，但 WPS 把它
/// 当数字存，列一窄就显示成 `4.37249E+12` —— 用户看到的就是"科学计数法"。
/// 只要是纯数字就加引号，跟长度无关；带字母的单号（SF…、YT…）本来就是文本。
pub fn formula_for(key: &str, v: &str) -> String {
    if (key == "order_sn" || key == "tracking_no") && !v.is_empty() {
        if v.chars().all(|c| c.is_ascii_digit()) {
            return format!("'{v}");
        }
        return v.to_string();
    }
    formula_of(v)
}

/// 按字符截断，别把 UTF-8 切断（错误提示可能是中文）。
fn clip(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(pairs: &[(&str, &str)]) -> JsonMap<String, Json> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), Json::String((*v).to_string())))
            .collect()
    }

    fn sample_rows() -> Vec<JsonMap<String, Json>> {
        vec![
            row(&[("order_sn", "310-8421-9930"), ("tracking_no", "SF7392016458")]),
            row(&[("order_sn", "310-8421-9931"), ("tracking_no", "SF7392016459")]),
        ]
    }

    /// 造一张表：第一行是 14 列表头，后面每行最多给三个值 ——
    /// 订单号(第1列) / 快递单号(第2列) / 情况(第6列)，其余留空。
    fn sheet(data: &[&[&str]]) -> Vec<Vec<String>> {
        let at = [0usize, 1, 5];
        let head: Vec<String> = COLUMNS.iter().map(|(_, l)| (*l).to_string()).collect();
        let mut g = vec![head];
        for r in data {
            let mut line = vec![String::new(); COLUMNS.len()];
            for (i, v) in r.iter().enumerate() {
                if i < at.len() {
                    line[at[i]] = (*v).to_string();
                }
            }
            g.push(line);
        }
        g
    }

    /// 增量推送的核心场景：表上 3 行，本地 4 行（新增 1 条、改了第 1 条的
    /// 「情况」），表上还有 1 行本地没有。
    /// 应该只写：新增那一行 + 变动的那**一格**；多出来的那行留着不动。
    #[test]
    fn cloud_sync_only_writes_new_rows_and_changed_cells() {
        //              订单号          快递单号        情况
        let g = sheet(&[
            &["310-8421-9930", "SF7392016458", "旧值"], // 本地把「情况」改成了新值
            &["310-8421-9931", "SF7392016459", ""],     // 两边一样，一格都不该写
            &["777-777", "SF7777777777", ""],           // 本地没有 —— 留着不动
        ]);
        let header = g[0].clone();
        let rows = vec![
            row(&[("order_sn", "310-8421-9930"), ("tracking_no", "SF7392016458"), ("category", "新值")]),
            row(&[("order_sn", "310-8421-9931"), ("tracking_no", "SF7392016459")]),
            row(&[("order_sn", "310-8421-9932"), ("tracking_no", "SF7392016460")]), // 新增
        ];
        let p = plan_cloud_sync(&header, &g, &rows).unwrap();

        assert_eq!(p.appends.len(), 1, "只该追加 1 行：{:?}", p.appends);
        assert_eq!(p.appends[0][0], "310-8421-9932");
        // 表头 1 行 + 3 行数据 → 新行写第 5 行
        assert_eq!(p.append_start, 5);
        assert_eq!(p.updates.len(), 1, "只该改 1 格：{:?}", p.updates);
        assert_eq!(p.updates[0].row, 2);
        assert_eq!(p.updates[0].col, 6); // 第 6 列是「情况」
        assert_eq!(p.updates[0].value, "新值");
        assert_eq!(p.orphans.len(), 1);
        assert_eq!(p.orphans[0].key, "777-777");
        assert_eq!(p.appended, 0, "14 列都在，不需要补列");
    }

    /// 推完再推一次：**一格都不该写**（幂等）。不这条成立，每次推送都会
    /// 把整张表重写一遍 —— 表大起来就是灾难。
    #[test]
    fn cloud_sync_is_idempotent() {
        let g = sheet(&[
            &["310-8421-9930", "SF7392016458", "新值"],
            &["310-8421-9931", "SF7392016459", ""],
            &["310-8421-9932", "SF7392016460", ""],
        ]);
        let header = g[0].clone();
        let rows = vec![
            row(&[("order_sn", "310-8421-9930"), ("tracking_no", "SF7392016458"), ("category", "新值")]),
            row(&[("order_sn", "310-8421-9931"), ("tracking_no", "SF7392016459")]),
            row(&[("order_sn", "310-8421-9932"), ("tracking_no", "SF7392016460")]),
        ];
        let p = plan_cloud_sync(&header, &g, &rows).unwrap();
        assert!(p.appends.is_empty(), "{:?}", p.appends);
        assert!(p.updates.is_empty(), "{:?}", p.updates);
    }

    /// 单号是纯数字时，表上读回来可能带着"当文本写"留下的内容
    /// （或者被显示成科学计数法）—— 不能因此把同一条单认成两条。
    #[test]
    fn cloud_sync_matches_text_quoted_numbers() {
        let g = sheet(&[&["4372493024839", "SF7392016458", ""]]);
        let header = g[0].clone();
        let rows = vec![row(&[("order_sn", "4372493024839"), ("tracking_no", "SF7392016458")])];
        let p = plan_cloud_sync(&header, &g, &rows).unwrap();
        assert!(p.appends.is_empty(), "带引号也该认出是同一条：{:?}", p.appends);
    }

    /// 中间有整行空着 → 新行先填那个洞，不留空行
    #[test]
    fn cloud_sync_fills_blank_row_before_appending() {
        let g = sheet(&[
            &["310-8421-9930", "SF7392016458", ""],
            &["", "", ""],
            &["310-8421-9931", "SF7392016459", ""],
        ]);
        let header = g[0].clone();
        let rows = vec![
            row(&[("order_sn", "310-8421-9930"), ("tracking_no", "SF7392016458")]),
            row(&[("order_sn", "310-8421-9931"), ("tracking_no", "SF7392016459")]),
            row(&[("order_sn", "310-8421-9932"), ("tracking_no", "SF7392016460")]),
        ];
        let p = plan_cloud_sync(&header, &g, &rows).unwrap();
        assert_eq!(p.append_start, 3, "第 3 行空着，该填那儿");
    }

    /// 空表：14 列全补，列号从 1 连续排，表头写在每列第一格。
    #[test]
    fn cloud_plan_writes_all_columns_on_empty_sheet() {
        let rows = sample_rows();
        let (cols, clear, appended) = plan_cloud_write(&[], 0, &rows).unwrap();
        assert_eq!(cols.len(), COLUMNS.len());
        assert_eq!(appended, COLUMNS.len());
        assert!(clear.is_empty());
        assert_eq!(cols[0]["col"], 1);
        assert_eq!(cols[0]["values"][0], "订单号");
        assert_eq!(cols[0]["values"][1], rows[0]["order_sn"]);
        assert_eq!(cols[COLUMNS.len() - 1]["col"], COLUMNS.len());
        // 每列都带 key —— 写格那边要靠它认「单号列」（见 formula_for）
        assert_eq!(cols[0]["key"], "order_sn");
        assert_eq!(cols[1]["key"], "tracking_no");
    }

    /// 单号列一律当文本写：纯数字运单号哪怕只有 12 位也要加前导单引号，
    /// 不然 WPS 按数字存，列一窄就显示成科学计数法（2026-10-20 实测）。
    #[test]
    fn cloud_plan_writes_tracking_numbers_as_text() {
        // 12 位纯数字运单号（中通/韵达长度）—— 加引号
        assert_eq!(formula_for("tracking_no", "4372493024839"), "'4372493024839");
        // 19 位订单号 —— 加引号
        assert_eq!(formula_for("order_sn", "6931234567890123456"), "'6931234567890123456");
        // 带字母的单号本来就是文本，原样
        assert_eq!(formula_for("tracking_no", "SF7392016458"), "SF7392016458");
        assert_eq!(formula_for("order_sn", "261010-123"), "261010-123");
        // 其它列不受影响：短数字还是数字，15 位以上才升文本
        assert_eq!(formula_for("title", "123"), "123");
        assert_eq!(formula_for("note", "6931234567890123456"), "'6931234567890123456");
    }

    /// 用户表里已有部分列（顺序还不一样）：认出来的按原位写，别动人家的列序；
    /// 认不出的补在**最后**，不能插在中间。
    #[test]
    fn cloud_plan_keeps_existing_columns_and_appends_rest() {
        // 用户在第 1 列放了自己的「备注」，订单号被挤到第 2 列
        let header = vec!["备注".to_string(), "订单号".to_string()];
        let (cols, _clear, appended) = plan_cloud_write(&header, 0, &sample_rows()).unwrap();
        assert_eq!(appended, COLUMNS.len() - 1);
        // 第一列是 order_sn，表里在第 2 列
        assert_eq!(cols[0]["col"], 2);
        // 其余从第 3 列往后补（不覆盖第 1 列的「备注」）
        assert_eq!(cols[1]["col"], 3);
        // 多了用户那一列，总宽就是 15
        assert_eq!(cols[COLUMNS.len() - 1]["col"], COLUMNS.len() + 1);
        // 用户那一列一次都没被写过
        assert!(cols.iter().all(|c| c["col"] != 1));
    }

    /// 表头行被补齐出尾随空串时，补列仍应从最后一个**非空**表头之后开始，
    /// 不能在中间挖出空列（把 header.len() 当已占列数就会踩这个）。
    #[test]
    fn cloud_plan_ignores_padding_cells_in_header() {
        let header = vec![
            "订单号".to_string(),
            "快递单号".to_string(),
            String::new(),
            String::new(),
        ];
        let (cols, _clear, appended) = plan_cloud_write(&header, 0, &sample_rows()).unwrap();
        assert_eq!(appended, COLUMNS.len() - 2);
        assert_eq!(cols[0]["col"], 1);
        assert_eq!(cols[1]["col"], 2);
        // 空着的第 3 列就是第一个落脚点，不该跳到第 5 列
        assert_eq!(cols[2]["col"], 3);
    }

    /// 旧表行多：新数据只到第 3 行时，第 4~6 行要清掉（只清台账这几列）。
    #[test]
    fn cloud_plan_clears_extra_rows() {
        let header: Vec<String> = COLUMNS.iter().map(|(_, h)| (*h).to_string()).collect();
        let rows = sample_rows();
        let (_cols, clear, appended) = plan_cloud_write(&header, 5, &rows).unwrap();
        assert_eq!(appended, 0);
        assert_eq!(clear.len(), COLUMNS.len());
        assert_eq!(clear[0]["from"], 4); // 表头 1 + 2 行数据 = 3
        assert_eq!(clear[0]["to"], 6); // 旧表 5 行 + 表头
    }

    /// 表头一个台账列都认不出 → 明确报错，不能闷头补 14 列。
    #[test]
    fn cloud_plan_rejects_foreign_header() {
        let header = vec!["订单编号".to_string(), "快递".to_string()];
        let err = plan_cloud_write(&header, 0, &sample_rows()).unwrap_err();
        assert!(err.contains("订单编号"), "{err}");
        assert!(err.contains("没认出来"), "{err}");
    }

    /// ★ 整行空串的"空表"（网格补齐后第一行是 ["","","…"]）要当成空表：
    /// 自己把 14 列表头写进去，而不是报"没认出来"。
    /// （2026-10-19 实踩：测试异常单.ksheet 第一行看着空、其实是带格式的空格。）
    #[test]
    fn cloud_plan_treats_all_blank_header_as_empty_sheet() {
        let header = vec![String::new(); 20]; // 补齐出来的等宽网格就长这样
        let (cols, clear, appended) = plan_cloud_write(&header, 0, &sample_rows()).unwrap();
        assert_eq!(appended, COLUMNS.len());
        assert!(clear.is_empty());
        // 14 列从第 1 列开始排，不从中间或者 15 列开始
        assert_eq!(cols[0]["col"], 1);
        assert_eq!(cols[COLUMNS.len() - 1]["col"], COLUMNS.len());
    }
}

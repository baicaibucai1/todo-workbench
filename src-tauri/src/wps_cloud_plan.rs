//! 台账列定义与「云端表格」的纯逻辑 —— 不依赖 tauri / reqwest / 网络。
//!
//! 单独成一个文件，是为了能**离线编译成测试程序**跑一遍：
//! `plan_cloud_write` 决定"写哪几列、会不会覆盖用户自己的列"，
//! 这条逻辑错了会直接改坏用户的原表，不能只靠跑一次真表格来验证。
//! 宿主侧的 `wps.rs` 只负责 HTTP 与命令封装，这里负责算。

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

/// AirScript 返回的二维数组 → 等宽字符串网格。
pub fn cloud_grid(v: &Json) -> Vec<Vec<String>> {
    let rows = v
        .get("rows")
        .and_then(Json::as_array)
        .cloned()
        .unwrap_or_default();
    let mut grid: Vec<Vec<String>> = Vec::with_capacity(rows.len());
    for r in rows {
        match r {
            Json::Array(cells) => grid.push(cells.iter().map(cell_text).collect()),
            other => grid.push(vec![cell_text(&other)]),
        }
    }
    let width = grid.iter().map(Vec::len).max().unwrap_or(0);
    for r in &mut grid {
        r.resize(width, String::new());
    }
    grid
}

/// 算出"写哪几列、每列写什么、多出来的旧行清到哪"。
///
/// 返回 `(cols, clear, appended)`，形状与 AirScript 脚本里的 `write` 分支
/// 一一对应。原则：**只碰台账这 14 列**，用户自己加的列（备注 / 公式）
/// 一个都不动；表里没有的列补在最后，不插在中间。
pub fn plan_cloud_write(
    header: &[String],
    old_rows: usize,
    rows: &[JsonMap<String, Json>],
) -> Result<(Vec<Json>, Vec<Json>, usize), String> {
    let known: std::collections::HashSet<&str> = COLUMNS.iter().map(|(_, h)| *h).collect();
    let hits = header.iter().filter(|h| known.contains(h.trim())).count();
    // 表头不为空、却一个台账列都认不出来 → 多半是用户自己的表头（"订单编号"）。
    // 这时候硬写会把 14 列全补在后面，表变成两套列 —— 宁可停下来说清楚。
    if !header.is_empty() && hits == 0 {
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

    let mut cols: Vec<Json> = Vec::new();
    let mut clear: Vec<Json> = Vec::new();
    // 已占用的列数 = 最后一个**非空**表头格的位置 + 1。
    // 不能直接用 header.len()：cloud_grid 会把所有行补齐成等宽，
    // 表头行末尾可能挂着几个补出来的空串，用 len() 会让补列从 15、16 开始，
    // 在表中间挖出一段空列。
    let mut next = header
        .iter()
        .rposition(|h| !h.trim().is_empty())
        .map(|i| i + 1)
        .unwrap_or(0);
    let mut appended = 0;
    for (key, label) in COLUMNS {
        let found = header.iter().position(|h| h.trim() == *label);
        let col = match found {
            Some(i) => i + 1,
            None => {
                next += 1;
                appended += 1;
                next
            }
        };
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
        cols.push(json!({ "col": col, "values": values }));
    }
    Ok((cols, clear, appended))
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

    /// 表头行被 cloud_grid 补齐出尾随空串时，补列仍应从最后一个**非空**表头之后开始，
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

    /// AirScript 的二维数组可能长短不一：补齐成等宽，别让 C 列取到 undefined。
    #[test]
    fn cloud_grid_pads_ragged_rows() {
        let v: Json = serde_json::from_str(r#"{"rows":[["a","b"],["c"],[]]}"#).unwrap();
        let g = cloud_grid(&v);
        assert_eq!(g.len(), 3);
        assert!(g.iter().all(|r| r.len() == 2));
        assert_eq!(g[1][1], "");
    }
}

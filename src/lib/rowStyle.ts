/**
 * 列表行的「表面」样式 —— 待办行与工单行共用同一份。
 *
 * 抽出来不是为了少写几行：**同一个列表里混排的两种对象，选中态必须是同一种样子**。
 * 分在 TaskRow / OrderRow 里各写一遍，迟早在某次改动里分叉，而在 diff 里看不出来。
 *
 * 这里的规则牵扯到分组容器（TaskList），两边必须一起看：
 * 1. 选中 = 整行**浮起来**（自己的圆角 + 投影 + 描边 + 抬起 1px），不是左侧色条。
 * 2. 因此容器**不能有 overflow-hidden**（浮起的投影会被裁掉），
 *    圆角改由行自己负责：首行贴上圆角、末行贴下圆角。
 */

export interface RowSurface {
  /** 正被右侧详情面板查看 —— 这一行要浮起来 */
  active?: boolean;
  /** 分组里的第一行，替容器兜住左上/右上圆角 */
  first?: boolean;
  /** 分组里的最后一行，兜住左下/右下圆角 */
  last?: boolean;
  /**
   * 上一行是浮起的选中行。
   *
   * 选中行已经用自己的投影和描边划出了边界，下面再压一条分隔线就是"卡片下面垫了根棍子"。
   */
  prevActive?: boolean;
}

/**
 * 行容器上除布局外的那部分类名。
 *
 * 包着行内容的那个 div 自己还要写 `group relative flex … transition-[…]`：
 * transition 必须同时写 background-color / box-shadow / transform，
 * 只写 transition-colors 的话浮起是"跳"出来的，不是抬起来的。
 */
export function rowSurfaceClass(s: RowSurface): string {
  if (s.active) {
    // 背景用 bg-card（纯白 / 深色的浅一档）配 bg-surface 的容器：
    // 选中比周围亮一点，投影才是"浮"，否则同样深浅下只有投影，看着像脏了一块。
    return (
      "z-10 -translate-y-px rounded-lg bg-card shadow-row-active ring-1 ring-line"
    );
  }
  const parts = ["hover:bg-hover"];
  if (!s.first && !s.prevActive) parts.push("border-t border-line");
  if (s.first) parts.push("rounded-t-lg");
  if (s.last) parts.push("rounded-b-lg");
  return parts.join(" ");
}

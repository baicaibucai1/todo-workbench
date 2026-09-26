# examples/ —— 可抄的样本

这里放**给人读、给人抄**的样本。它和产品代码的分工是：

| 目录 | 会被打进安装包吗 | 会出现在用户设置页吗 |
| --- | --- | --- |
| `tools/` | 会（每个目录都进工具包 zip） | 会 |
| `tests/fixtures/tools/` | 不会 | 不会（只在 `?fixtureTools=` 下装载） |
| `examples/` | 不会 | 不会 |

所以**新增样本一律放这里**：多一个目录既不会让用户侧边栏变长，也不会让安装包变大。

---

## kitchen-sink · 能力演示

`examples/kitchen-sink/` 是一份**把宿主每一条通道都真跑一遍**的样本：

| 章节 | 用到的 op | 它演示什么 |
| --- | --- | --- |
| ① 上下文与当前待办 | `info`、`task.get` | 主题 / 驱动 / 表前缀 / 挂载位置；读"我挂在它上面的那条待办" |
| ② 键值配置 | `kv.get` `kv.set` `kv.all` `kv.del` | 工具自己的配置该存哪（不是表，是 kv） |
| ③ 私有表 | `schema.info`、`row.count` `row.select` `row.insert` `row.update` `row.delete` | 声明式 schema + 结构化 CRUD，没有 SQL |
| ④ 图库 | `gallery.list` `gallery.get` `gallery.put` | 跨工具共享素材库；图库关着时**降级显示宿主的原话** |
| ⑤ 工具联动 | `tools.list` `tools.open` `tools.send` | 拉起别的工具并转交数据；只投运行中的工具 |

它同时声明了三个注入位置（`detailSection` / `detailAction` / `rowAction`），
装上之后会同时出现在待办详情面板底部、详情头部按钮、列表行内按钮。

### 怎么装

**方式 A：整个目录复制（推荐，manifest 完整生效）**

把 `kitchen-sink/` 整个目录复制到工具目录：

```
%APPDATA%\com.sogapopo.todo-workbench\tools\kitchen-sink\
  manifest.json
  index.html
```

重启工作台（或设置 → 工具里刷新），它就会出现在侧边栏工具区，
并且在每条待办的详情面板底部出现「能力演示」分区。

**方式 B：设置 → 工具 → 导入 HTML 单文件**

只导入 `index.html` 也能跑，但**导入界面只填 id / 名称 / 图标**，
于是 `schema` / `capabilities` / `injects` 三样都不会写进 manifest ——
表现出来是：私有表用不了、图库被拒、注入位置不出现。
这三样必须由 `manifest.json` 提供，所以想看完整效果请用方式 A。

### 怎么验（不用装进桌面版也能验）

```bash
node scripts/verify-example.mjs
```

它把 `@tauri-apps/*` 别名成 Node 替身，于是**宿主的真代码**原样执行：
`installFromHtml` 真的落盘、`ensureToolSchema` 真的建表、
`createToolBridge` 真的应答 —— 然后把这个工具用到的每个 op 都调一遍
（含"图库关着时被拒"、"缺主键被拒"、"integer 列传字符串被拒"这些反面用例）。
全部通过会打印 `全部通过（22 次调用）`。

改了样本或改了宿主契约之后跑一次，就知道"文档里写的"和"代码认的"还是不是一回事。

### 它刻意做了什么

- **不写假按钮**：五个分区里每个按钮都真的发一次请求，失败就把宿主的
  原话显示在按钮下方（比如"这个扩展没有申请 gallery 能力"）。
- **主题跟随宿主**：收到 `tool:context` 后把 `ctx.theme` 写到 `<html data-theme>`
  ，深色模式不会留一块白。
- **关键状态挂 DOM**：`body[data-bind-state]`、按钮 `data-act`、
  行 `data-id` —— 这个项目的 e2e 靠这些属性断言。
- **删除要二次确认**：点「删除」按钮变成「再点一次确认」，不用弹窗阻塞。
- **整页模式下 `task.get` 是注定失败的**，它把那句拒绝照原话显示出来，
  并注明"整页模式下这是预期行为"——教学价值就在这句上。

#!/usr/bin/env node
/**
 * README 同步：把「坚果云同步（WebDAV）」一节扩成两个后端，并补上 Azure 应用注册指引。
 * 每处替换断言恰好命中 1 次。
 */
import fs from 'node:fs';

const FILE = 'README.md';

const AZURE_GUIDE = `#### 注册 Azure 应用（只在使用 OneDrive 时需要，约 5 分钟，免费）

1. 打开 <https://portal.azure.com>，用**要同步的那个微软账号**登录 →
   搜「Microsoft Entra ID」→ 左侧「应用注册」→「新注册」
2. **名称**填 \`待办工作台\`。⚠️ 这个名字会变成 OneDrive 里那个文件夹的名字，
   且**改注册名不会重命名已经建出来的文件夹** —— 所以一开始就起好
3. **「支持的帐户类型」**选「任何组织目录中的帐户和个人 Microsoft 帐户」。
   选成「仅此组织目录」的话，个人 outlook.com 账号会登不进去
4. **「重定向 URI」**平台选「**移动和桌面应用程序**」，然后勾选 \`http://localhost\`
   （列表里有现成的这一项）→「注册」
   - 只填 \`http://localhost\` 就够了：RFC 8252 §7.3 要求授权服务器对 loopback 地址
     放行**任意端口**，所以应用每次用随机端口，不必回来重新登记
   - ⚠️ 平台**别选「Web」** —— Web 平台按机密客户端处理（要 client_secret），
     而桌面应用把 secret 分发到每台机器上等于公开它
5. 注册完，在「概述」页复制 **「应用程序(客户端) ID」**，粘到设置页的「Azure 客户端 ID」
6. 左侧「API 权限」→「添加权限」→ **Microsoft Graph** →「**委托的权限**」，勾选这四项：
   - \`Files.ReadWrite.AppFolder\` —— **权限最小的那个**：只能读写应用自己那个文件夹
   - \`offline_access\` —— 没有它就拿不到长期令牌，每小时要重新登录一次
   - \`openid\`、\`profile\` —— 用来显示"已连接为 xxx@outlook.com"
   然后「添加权限」。个人账号**不需要**点「授予管理员同意」
7. 左侧「身份验证」→ 拉到最下面 → **「允许公共客户端流」改成「是」→ 保存**
   - ⚠️ 漏了这一步，登录会在换令牌时报 \`unauthorized_client\`
8. 回设置页点「连接 OneDrive」→ 浏览器打开微软登录页 → 登录并同意 →
   浏览器显示"授权完成，可以关闭这个窗口" → 应用这边自动变成"已连接：xxx@outlook.com"

**常见卡点：**

| 现象 | 原因 |
|---|---|
| \`unauthorized_client\` | 第 7 步没开「允许公共客户端流」 |
| \`invalid_request\` | 第 4 步没勾 \`http://localhost\`，或平台选成了「Web」 |
| \`invalid_client\` | client_id 复制错了（多带了空格） |
| \`invalid_grant\` | 授权被撤销或过期（改过密码、太久没用），重新点一次「连接 OneDrive」 |
| 浏览器过了、应用一直等 | 授权页的回调被浏览器插件或代理拦了，换个干净窗口重试 |

⚠️ 数据放在 OneDrive 的 \`Apps/<应用名>\` 里，而**网页版 OneDrive 默认不显示这个文件夹**。
在网页上找不到不等于没同步成功 —— 看设置页的「上次同步」和「本次结果」。
`;

const EDITS = [
  [
    `### 坚果云同步（WebDAV）

两台机器之间对齐数据，走坚果云的 WebDAV —— 不用自建服务器，也不依赖任何第三方账号体系，
填一个坚果云账号 + 一个**应用密码**（不是登录密码）就能用。`,
    `### 同步（坚果云 WebDAV / OneDrive）

两台机器之间对齐数据。**可以选同步到哪：**

| 后端 | 怎么配 | 数据放哪 |
|---|---|---|
| **坚果云 WebDAV** | 账号 + 一个**应用密码**（不是登录密码）。不用自建服务器，也不依赖任何第三方账号体系 | 坚果云里你自己建的目录 |
| **OneDrive** | 先在 Azure 注册一个免费应用拿 client_id，再点「连接 OneDrive」 | 你 OneDrive 的「应用」文件夹（\`Apps/<应用名>\`），**只申请了访问这一个文件夹的权限** |

两者是**两套协议**，不是同一套的两种填法：OneDrive 个人版没有 WebDAV
（那套 \`d.docs.live.net\` 的映射靠应用密码 + 网络驱动器，微软早已废弃，在频繁改写的内容上也不可靠）。
但除了"传输"这一层，分片、合并、墓碑的规则完全是同一套 —— 所以**两台机器可以用不同的后端**
（家里走 OneDrive、公司走坚果云），云端文件格式是同一个。

${AZURE_GUIDE}`,
  ],

  [
    `- ⚠️ **同步只在桌面版可用。** 浏览器演示模式的数据存在 \`localStorage\`，
  跟桌面版的 SQLite 是两套；而且 WebDAV 要用的 \`PROPFIND\` / \`MKCOL\` 浏览器也发不出去`,
    `- ⚠️ **同步只在桌面版可用。** 浏览器演示模式的数据存在 \`localStorage\`，
  跟桌面版的 SQLite 是两套；而且 WebDAV 要用的 \`PROPFIND\` / \`MKCOL\` 浏览器发不出去，
  OneDrive 登录要开本地端口收回调，浏览器里同样做不了
- ⚠️ **凭据只留在本机。** 坚果云的应用密码与 OneDrive 的长期令牌都是明文存在本机 SQLite 里
  （与数据库文件同级，理由见下面的「数据隔离」），且**同步设置本身不参与同步** ——
  它们不会被带到任何一台别的机器上`,
  ],

  [
    `触发是手动的，界面会显示上次同步时间与本次结果（取回 / 更新 / 上传 / 冲突各多少条）。
传输层在 Rust 侧（\`src-tauri/src/webdav.rs\`，\`reqwest\` + \`rustls\`，
**刻意关掉代理** —— 本机一个挂掉的代理会让所有请求原地失败）；
合并算法是纯 TS 函数（\`src/lib/sync.ts\`），不碰网络，所以能被完整单测覆盖。`,
    `触发是手动的，界面会显示上次同步时间与本次结果（取回 / 更新 / 上传 / 冲突各多少条）。

**传输层在 Rust 侧，两个后端各一个文件：**

| 文件 | 后端 | 说明 |
|---|---|---|
| \`src-tauri/src/webdav.rs\` | 坚果云等 | PROPFIND / MKCOL / PUT / GET + Basic Auth |
| \`src-tauri/src/onedrive.rs\` | OneDrive | 授权码 + PKCE 的 loopback 登录、Graph 的 get / put / stat |

两者共用同一个 HTTP 客户端（\`reqwest\` + \`rustls\`，**刻意关掉代理** ——
本机一个挂掉的代理会让所有请求原地失败）。OneDrive 那边不引任何新依赖：
SHA256 用已在依赖树里的 \`ring\`，base64url 自己写。

共同的上层是 \`src/lib/syncClient.ts\` 里的 \`RemoteTarget\` 句柄
（\`check\` / \`get\` / \`put\` / \`stat\` 四个方法），按 \`provider\` 分派 ——
**换后端不碰合并层一个字节**。合并算法是纯 TS 函数（\`src/lib/sync.ts\`），
不碰网络，所以能被完整单测覆盖。`,
  ],

  [
    `    src/webdav.rs     WebDAV 传输层（坚果云同步用；独立于「工具同步」）`,
    `    src/webdav.rs     WebDAV 传输层（坚果云等；独立于「工具同步」）
    src/onedrive.rs   OneDrive 传输层（Graph API + PKCE loopback 登录）`,
  ],

  [
    `- [x] **坚果云同步**（WebDAV 双向合并，默认只同步待办；只同步记录不传文件，设置不进同步）`,
    `- [x] **坚果云同步**（WebDAV 双向合并，默认只同步待办；只同步记录不传文件，设置不进同步）
- [x] **OneDrive 同步**（微软 Graph API + PKCE 登录，只用访达应用专属文件夹的最小权限）`,
  ],
];

const raw = fs.readFileSync(FILE, 'utf8');
const crlf = raw.includes('\r\n');
let text = raw.replace(/\r\n/g, '\n');

let n = 0;
for (const [oldS, newS] of EDITS) {
  n++;
  const count = text.split(oldS).length - 1;
  if (count !== 1) {
    console.error(`✗ 第 ${n} 处替换命中 ${count} 次（要求恰好 1 次），已中止，文件未改`);
    process.exit(1);
  }
  text = text.replace(oldS, newS);
  console.log(`✓ 第 ${n} 处替换完成`);
}

fs.writeFileSync(FILE, crlf ? text.replace(/\n/g, '\r\n') : text);
console.log(`已写回 ${FILE}`);

#!/usr/bin/env node
/**
 * 给 settings.ts 加 OneDrive 的键与默认值。
 *
 * ⚠️ settings.ts / Settings.tsx 是 **CRLF**：直接拿多行字符串去 Edit 会匹配不上。
 * 所以这里统一「读进来转 LF → 替换 → 写回 CRLF」，并对每处替换断言命中次数 ——
 * 少命中或多命中都要当场报错，而不是静默跳过（脚本最怕的就是"看起来跑过了"）。
 */
import fs from 'node:fs';

const FILE = 'src/lib/settings.ts';

const EDITS = [
  [
    // 1) 同步分区的第一个键：用哪个网盘。
    // 锚点只取「下一段文档注释的开头」—— 整段抄下来容易在细节上对不上
    `  /**
   * 坚果云 WebDAV 的服务地址。
   *
   * 默认是官方地址；做成可配置不只是"以后能换服务商"——`,
    `  /**
   * 同步用哪个网盘：\`webdav\`（坚果云、群晖、Nextcloud 都走这个）或 \`onedrive\`。
   *
   * 两者是**两套协议**，不是同一套的两种填法：OneDrive 个人版没有 WebDAV，
   * 走的是 Microsoft Graph + OAuth 登录。所以这个键决定的是
   * 「下面哪些字段有意义」—— 选了 OneDrive，账号密码那几项就不该再出现。
   * 默认保持 webdav：不能因为多了个新后端，就让老用户的配置换一种读法。
   */
  syncProvider: "sync.provider",

  /**
   * 坚果云 WebDAV 的服务地址。
   *
   * 默认是官方地址；做成可配置不只是"以后能换服务商"——`,
  ],

  [
    // 2) OneDrive 的键
    `  /** 上次成功同步的时刻与摘要。只用于展示，不参与任何判断 */
  syncLastAt: "sync.lastAt",
  syncLastSummary: "sync.lastSummary",
} as const;`,
    `  /** 上次成功同步的时刻与摘要。只用于展示，不参与任何判断 */
  syncLastAt: "sync.lastAt",
  syncLastSummary: "sync.lastSummary",

  /* ---------------------------- OneDrive ---------------------------- */

  /**
   * Azure 应用（客户端）ID。
   *
   * 公共客户端的 client_id **不是密钥** —— 它本来就会出现在授权页的网址里，
   * 内置进应用、明文存在设置里都无妨。真正要保密的是下面那个 refresh_token。
   */
  onedriveClientId: "onedrive.clientId",
  /**
   * 长期令牌，用来换短期 access_token。
   *
   * ⚠️ 与 syncPassword 同一个待遇：**明文存在本机 SQLite 里**，没有加密
   * （理由见上面那条）。它比应用密码还要敏感一点 —— 拿到它就能读写你
   * OneDrive 里这个应用的专属文件夹。
   * 唯一的好消息是**同步设置本身不参与同步**，它不会被带到别的机器上。
   */
  onedriveRefreshToken: "onedrive.refreshToken",
  /** 已连接账号（邮箱）。只用于界面显示"已连接为 xxx" */
  onedriveAccount: "onedrive.account",
} as const;`,
  ],

  [
    // 3) 默认值。provider 显式写 webdav，让"新后端"不改变任何既有行为
    `  [SETTINGS.syncLastAt]: "",
  [SETTINGS.syncLastSummary]: "",
};`,
    `  [SETTINGS.syncLastAt]: "",
  [SETTINGS.syncLastSummary]: "",
  // 新后端不改变既有行为：默认仍是坚果云 WebDAV
  [SETTINGS.syncProvider]: "webdav",
  [SETTINGS.onedriveClientId]: "",
  [SETTINGS.onedriveRefreshToken]: "",
  [SETTINGS.onedriveAccount]: "",
};`,
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
console.log(`已写回 ${FILE}（${crlf ? 'CRLF' : 'LF'}）`);

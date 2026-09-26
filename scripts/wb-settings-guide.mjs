#!/usr/bin/env node
/**
 * 在设置页的 OneDrive 面板里塞一份可折叠的「怎么拿 client_id」指引。
 * Settings.tsx 是 CRLF，走同样的转 LF 再写回。
 */
import fs from 'node:fs';

const FILE = 'src/components/Settings.tsx';

const GUIDE = `            <details className="rounded-lg border border-line px-3 py-2.5" data-onedrive-guide>
              <summary className="cursor-pointer text-[12.5px] text-fg-2">
                怎么拿这个 ID？（注册一个 Azure 应用，约 5 分钟，免费）
              </summary>
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-[11.5px] leading-relaxed text-fg-dim">
                <li>
                  打开 portal.azure.com 并用<b>要同步的那个微软账号</b>登录 → Microsoft Entra ID →
                  应用注册 → 新注册
                </li>
                <li>名称填「待办工作台」——它会变成 OneDrive 里那个文件夹的名字</li>
                <li>支持的帐户类型选「任何组织目录中的帐户和个人 Microsoft 帐户」</li>
                <li>
                  重定向 URI 的平台选「移动和桌面应用程序」，再勾选 http://localhost（列表里有这一项）
                  —— 勾了它就不必为端口操心，应用每次用随机端口都合法
                </li>
                <li>注册完在「概述」页复制「应用程序(客户端) ID」，填到上面那个框里</li>
                <li>
                  API 权限 → 添加权限 → Microsoft Graph → <b>委托的权限</b>，勾这四项：
                  Files.ReadWrite.AppFolder、offline_access、openid、profile
                </li>
                <li>
                  身份验证 → 拉到最下面 → 把「允许公共客户端流」改成「是」并保存
                  （漏了这一步，登录会报 unauthorized_client）
                </li>
              </ol>
            </details>
`;

const OLD = `            <p className="text-[11.5px] leading-relaxed text-fg-dim">
              数据放在 OneDrive 的「应用」文件夹里（路径形如 Apps/待办工作台），网页版默认不显示它 ——
              这是正常的，那个文件夹只有这个应用看得到。首次同步时会自动建出来。
            </p>
`;

const NEW = OLD + GUIDE;

const raw = fs.readFileSync(FILE, 'utf8');
const crlf = raw.includes('\r\n');
let text = raw.replace(/\r\n/g, '\n');

const count = text.split(OLD).length - 1;
if (count !== 1) {
  console.error(`✗ 命中 ${count} 次（要求恰好 1 次），已中止`);
  process.exit(1);
}
text = text.replace(OLD, NEW);

fs.writeFileSync(FILE, crlf ? text.replace(/\n/g, '\r\n') : text);
console.log(`✓ 已插入 Azure 注册指引（${crlf ? 'CRLF' : 'LF'}）`);

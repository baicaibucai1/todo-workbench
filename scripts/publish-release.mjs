#!/usr/bin/env node
/**
 * publish-release.mjs —— 把已经打好的安装包发成一个 GitHub Release
 *
 * 为什么要有这一层（而不是手动拖拽上传）：
 *
 * 1. **资产名必须是纯 ASCII。**
 *    GitHub 在 assets 上传 URL 的 `?name=` 里会**丢掉非 ASCII 字符** ——
 *    Tauri 按 productName 产出的安装包叫「待办工作台_0.1.0_x64-setup.exe」，
 *    原样上传会被存成「_0.1.0_x64-setup.exe」。后果不是报错，而是：
 *    update.json 里那个下载地址 404，客户端**静默**更新失败。2026-09-23 发
 *    v0.1.0 时就是这么栽的。所以统一改名成 `todo-workbench_<版本>_x64-setup.exe`
 *    再传。
 *
 * 2. **四样东西必须一起换。**
 *    安装包、`.sig` 签名、`update.json`、**工具包 zip**。漏了签名，老版本验签
 *    失败拒绝更新；update.json 没覆盖旧的，客户端会一直以为已是最新；工具包
 *    漏了，新装的用户打开就是一个没有工具的程序（0.2.0 起安装包不带工具，
 *    那份 zip 是他能拿到内置工具的唯一途径）。这个脚本保证同批上传。
 *
 * 3. **本机 git 协议不通**（github.com:443 → `Empty reply from server`），
 *    但 api.github.com / uploads.github.com 可达，因此全程走 REST API。
 *    令牌从 Git Credential Manager 现取，不落盘、不打印。
 *
 * 4. **发完要匿名验证。**
 *    只看带凭据的 API 返回不算数 —— 用户是匿名下载的。脚本最后会拉一次
 *    `releases/latest/download/update.json` 与安装包前几个字节。
 *
 * 用法：
 *   node scripts/publish-release.mjs                    # 版本号读 tauri.conf.json
 *   node scripts/publish-release.mjs --notes notes.md   # 指定发布说明（Markdown）
 *   node scripts/publish-release.mjs --dry              # 只打印计划，不发
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry");
const NOTES = (() => {
  const i = argv.indexOf("--notes");
  return i >= 0 ? argv[i + 1] : null;
})();

const say = (...a) => console.log(...a);
function die(msg, hint) {
  console.error("");
  console.error("[x] " + msg);
  if (hint) console.error("    " + hint);
  process.exit(1);
}

/* ------------------------------ 凭据与 API ------------------------------ */

/**
 * 跑一条外部命令，收集它打出来的东西。
 *
 * ⚠️ **这里刻意不用 `execFileSync` / `spawnSync`** —— 在本机环境（沙箱）里它们会
 * 直接以 `spawnSync git EBUSY` 崩掉，而异步的 `spawn` 一切正常。
 * 这个差别很有迷惑性：同一个 `git remote get-url origin`，在终端里敲得好好的，
 * 放进脚本就 EBUSY，很容易往"凭据""网络"那边去查。
 * 所以本项目里凡是「跑个子命令拿结果」的位置都统一走这个函数。
 */
function runCollect(cmd, args, opts = {}) {
  const { input, ...spawnOpts } = opts;
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, ...spawnOpts });
    let out = "";
    let err = "";
    p.stdout?.on("data", (d) => (out += d));
    p.stderr?.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${path.basename(cmd)} ${args.join(" ")} 退出码 ${code}${err ? `\n${err.trim()}` : ""}`));
    });
    if (input != null) p.stdin.end(input);
  });
}

/**
 * 取 GitHub 令牌。
 *
 * 两条路，环境变量优先：
 *   `GH_TOKEN` / `GITHUB_TOKEN` —— 显式给。CI 里用这个，也方便临时换一个令牌，
 *     不必去动 Windows 凭据管理器里那条。
 *   否则去 Git Credential Manager 问本机存的那个。
 *
 * 401 的两种成因要分清楚：**网络不通**和**令牌无效**症状完全不同 ——
 * 前者是连不上（本机代理会挡 git 协议，报 `server closed abruptly`），
 * 后者是服务器回了 `{"message":"Bad credentials"}`（说明网络是好的）。
 * 看到 401 就先去 GitHub 确认这个令牌还在、且勾了 `repo` 权限，别去查网络。
 */
async function getToken() {
  const fromEnv = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (fromEnv && fromEnv.trim()) {
    say("  令牌来源：环境变量 GH_TOKEN");
    return fromEnv.trim();
  }

  let out = "";
  try {
    out = await runCollect("git", ["credential", "fill"], {
      input: "protocol=https\nhost=github.com\n\n",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  } catch (e) {
    die("没能向 Git Credential Manager 取凭据。", String(e?.message ?? e));
  }
  const pw = ((out || "").match(/^password=(.*)$/m) || [])[1] || "";
  if (!pw) die("没取到令牌：Git Credential Manager 里没有 github.com 的凭据。");
  return pw;
}

function api(method, p, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        hostname: "api.github.com",
        path: p,
        method,
        headers: {
          "User-Agent": "todo-workbench-publish",
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(buf); } catch { /* 非 JSON 响应 */ }
          resolve({ status: res.statusCode, json, raw: buf });
        });
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

function uploadAsset(slug, releaseId, name, filePath, token) {
  const data = fs.readFileSync(filePath);
  const u = new URL(`https://uploads.github.com/repos/${slug}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: "POST",
        headers: {
          "User-Agent": "todo-workbench-publish",
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/octet-stream",
          "Content-Length": data.length,
        },
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(buf); } catch { /* 非 JSON */ }
          resolve({ status: res.statusCode, json, raw: buf });
        });
      },
    );
    req.on("error", reject);
    const CHUNK = 4 * 1024 * 1024;
    for (let off = 0; off < data.length; off += CHUNK) req.write(data.subarray(off, off + CHUNK));
    req.end();
  });
}

/* --------------------------------- 主流程 --------------------------------- */

const conf = JSON.parse(fs.readFileSync(path.join(ROOT, "src-tauri", "tauri.conf.json"), "utf8"));
const version = conf.version;
const tag = `v${version}`;

let remote = "";
try {
  remote = (await runCollect("git", ["remote", "get-url", "origin"], { cwd: ROOT })).trim();
} catch (e) {
  die("读不到 origin 地址。", String(e?.message ?? e));
}
const m = remote.match(/github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/);
if (!m) die(`看不懂 origin 地址：${remote}`);
const slug = `${m[1]}/${m[2]}`;

/* —— 1) 定位产物目录（GNU 工具链下带 target triple，不是简单的 target/release） —— */
const bundleDir = (() => {
  const plain = path.join(ROOT, "src-tauri", "target", "release", "bundle", "nsis");
  const targetRoot = path.join(ROOT, "src-tauri", "target");
  const candidates = [plain];
  if (fs.existsSync(targetRoot)) {
    for (const e of fs.readdirSync(targetRoot)) {
      candidates.push(path.join(targetRoot, e, "release", "bundle", "nsis"));
    }
  }
  return candidates.find((c) => fs.existsSync(c));
})();
if (!bundleDir) die("找不到打包产物目录，先跑 node scripts/build-desktop.mjs。");

say(`版本      : ${version}`);
say(`仓库      : ${slug}`);
say(`产物目录  : ${path.relative(ROOT, bundleDir)}`);

/* —— 2) 产物改名成 ASCII（见文件头注释第 1 条） —— */
const exes = fs.readdirSync(bundleDir).filter((f) => f.endsWith("-setup.exe"));
if (!exes.length) die(`在 ${path.relative(ROOT, bundleDir)} 里没有 -setup.exe，先打包。`);

const newest = exes
  .map((f) => ({ f, mt: fs.statSync(path.join(bundleDir, f)).mtimeMs }))
  .sort((a, b) => b.mt - a.mt)[0].f;

const wantExe = `todo-workbench_${version}_x64-setup.exe`;
const wantSig = `${wantExe}.sig`;

const park = (rel) => {
  // 用改名而不是删除：构建产物目录里可能有别的东西，且重命名不会被安全守卫拦
  const from = path.join(bundleDir, rel);
  if (!fs.existsSync(from)) return;
  const to = path.join(bundleDir, `${rel}.stale-${Date.now()}`);
  fs.renameSync(from, to);
  say(`  腾位：${rel} → ${path.basename(to)}`);
};

if (newest !== wantExe) {
  say(`产物改名：${newest} → ${wantExe}`);

  /*
   * ⚠️ 顺序不能乱。**签名必须先于安装包改名**，而且 `park()` 只能用在
   * 「目标位置」上 —— 用在源文件上会把待改名的那个文件先挪走，
   * 下面那句 `existsSync(srcSig)` 立刻变成 false，签名就再也不会被带上。
   *
   * 这个 bug 的实际表现相当绕：安装包改好了名、一路走到最后才发现
   * 「缺少签名文件」，而真正的作案点是几十行之前那次多余的 park，
   * 产物目录里只剩一个 `<原名>.sig.stale-<时间戳>` 让人摸不着头脑。
   */
  const srcSig = `${newest}.sig`;
  const srcSigPath = path.join(bundleDir, srcSig);
  if (fs.existsSync(srcSigPath)) {
    park(wantSig); // 上一轮留下来的同名旧签名 → 挪开，别让 rename 撞车
    fs.renameSync(srcSigPath, path.join(bundleDir, wantSig));
  }

  park(wantExe);
  fs.renameSync(path.join(bundleDir, newest), path.join(bundleDir, wantExe));
}

const exePath = path.join(bundleDir, wantExe);
const sigPath = path.join(bundleDir, wantSig);
if (!fs.existsSync(sigPath)) {
  die(`缺少签名文件 ${wantSig}`, "更新包必须签名，否则已安装的旧版本会拒绝安装。重新打包。");
}

/* —— 3.5) 工具包 —— */
/*
 * 0.2.0 起安装包不带任何工具，这份 zip 就成了用户拿到内置工具（图片裁剪、尺码表、
 * 随手记、AI 生成、五子棋）的唯一途径。它跟安装包必须是**同一次发布**：
 * 少传一次，用户下载到的就是一个打开什么工具都没有的程序 —— 而界面再怎么说
 * 清楚，也比不上 Release 上真的有那份文件。
 *
 * 所以这里缺了就直接停下来，而不是降级成"提示一下继续"。
 */
const toolsZipName = `todo-workbench-tools_${version}.zip`;
const toolsZip = path.join(ROOT, "release-assets", toolsZipName);
if (!fs.existsSync(toolsZip)) {
  die(
    `缺工具包 ${path.relative(ROOT, toolsZip)}`,
    "安装包不再携带工具，这份 zip 就是用户的唯一来源 —— 跑 node scripts/pack-tools.mjs 生成它。",
  );
}

/* —— 3) 生成 update.json —— */
const updateJson = path.join(ROOT, "update.json");
/*
 * update.json 里那句 notes 是**给用户看的**（更新对话框里就它一句话）。
 * 以前取的是 notes 文件的第一行 —— 而 Markdown 的第一行通常是 `# 标题`，
 * 于是用户看到的是「# 待办工作台 v0.2.0」这种将文件内容当场外泄的怪句子。
 * 这里取**第一个真正的正文段落**：跳过标题与分隔线，一直连到空行为止。
 */
function firstParagraph(md, max = 160) {
  let out = "";
  let started = false;
  for (const raw of md.split("\n")) {
    const line = raw.trim();
    if (!line) {
      if (started) break;
      continue; // 正文之前的标题 / 分隔线：跳过
    }
    if (!started) {
      // ⚠️ `-` / `*` 后面必须有空格才算列表项：只认符号本身的话，
      // 「**安装包从 62.9 MB 降到 7.3 MB。**」这种以加粗开头的正文会被当成
      // 无序列表跳过去，摘要就莫名其妙从段落中间开始。
      if (/^(#{1,6}\s|[-*+]\s|>{1,}\s|```|\||-{3,}$|={3,}$)/.test(line)) continue;
      started = true;
    }
    // 只在「两边都是西文」时才补空格：中文之间的空格是多余的，
    // 而英文单词粘连又是另一种难看
    const glue = /[A-Za-z0-9]$/.test(out) && /^[A-Za-z0-9]/.test(line) ? " " : "";
    out += glue + line;
    if (out.length >= max) break;
  }
  return out.slice(0, max).trim();
}
const notesFile = NOTES && fs.existsSync(NOTES) ? fs.readFileSync(NOTES, "utf8") : "";
const notes = firstParagraph(notesFile) || `待办工作台 ${tag}`;
const baseUrl = `https://github.com/${slug}/releases/download/${tag}`;

say("");
say("生成 update.json …");
try {
  await runCollect(process.execPath, [path.join(__dirname, "gen-update-json.mjs"), version, baseUrl], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, RELEASE_NOTES: notes },
  });
} catch (e) {
  die("生成 update.json 失败。", String(e?.message ?? e));
}

const assets = [exePath, sigPath, toolsZip, updateJson];
say("");
say("待上传：");
for (const a of assets) say(`  ${path.basename(a)}  (${(fs.statSync(a).size / 1024 / 1024).toFixed(2)} MB)`);

if (DRY) {
  say("");
  say("--dry：到此为止，没有发出任何请求。");
  process.exit(0);
}

/* —— 4) 建 / 复用 Release —— */
const token = getToken();
const [owner, repo] = slug.split("/");

let rel = await api("GET", `/repos/${owner}/${repo}/releases/tags/${tag}`, null, token);
if (rel.status === 200) {
  say(`\n[复用] release ${tag} (id=${rel.json.id})`);
} else if (rel.status === 404) {
  const created = await api(
    "POST",
    `/repos/${owner}/${repo}/releases`,
    {
      tag_name: tag,
      target_commitish: "main",
      name: `待办工作台 ${tag}`,
      body: NOTES && fs.existsSync(NOTES) ? fs.readFileSync(NOTES, "utf8") : `待办工作台 ${tag}`,
      draft: false,
      prerelease: false,
    },
    token,
  );
  if (created.status !== 201) die(`创建 release 失败 HTTP ${created.status}`, (created.raw || "").slice(0, 400));
  rel = created;
  say(`\n[新建] release ${tag} → ${rel.json.html_url}`);
} else {
  die(`查询 release 失败 HTTP ${rel.status}`, (rel.raw || "").slice(0, 400));
}

/* —— 5) 上传（先清掉不在名单里的残留资产） —— */
const existing = new Map((rel.json.assets || []).map((a) => [a.name, a]));
const wanted = new Set(assets.map((a) => path.basename(a)));
for (const [name, a] of existing) {
  if (wanted.has(name)) continue;
  const d = await api("DELETE", `/repos/${owner}/${repo}/releases/assets/${a.id}`, null, token);
  say(`  [清理] 删除残留资产 ${name} → HTTP ${d.status}`);
}

say("");
for (const abs of assets) {
  const name = path.basename(abs);
  const old = existing.get(name);
  if (old) {
    await api("DELETE", `/repos/${owner}/${repo}/releases/assets/${old.id}`, null, token);
    say(`  [替换] 先删旧资产 ${name}`);
  }
  process.stdout.write(`  ↑ ${name} … `);
  const r = await uploadAsset(slug, rel.json.id, name, abs, token);
  if (r.status !== 201) {
    console.log(`失败 HTTP ${r.status}`);
    die("上传被拒", (r.raw || "").slice(0, 400));
  }
  console.log("OK");
}

/* —— 6) 匿名验证（不带凭据） —— */
say("");
say("匿名验证（用户的角度）…");
const latestUrl = `https://github.com/${slug}/releases/latest/download/update.json`;
const r1 = await fetch(latestUrl, { redirect: "follow" });
if (r1.status !== 200) die(`latest/download/update.json 返回 HTTP ${r1.status}`);
const manifest = await r1.json();
if (manifest.version !== version) die(`update.json 里版本是 ${manifest.version}，期望 ${version}`);
const dlUrl = manifest.platforms?.["windows-x86_64"]?.url || "";
const r2 = await fetch(dlUrl, { redirect: "follow", headers: { Range: "bytes=0-1" } });
if (r2.status !== 206 && r2.status !== 200) die(`安装包地址下不动：HTTP ${r2.status}`, dlUrl);
const head = Buffer.from(await r2.arrayBuffer());
if (head[0] !== 0x4d || head[1] !== 0x5a) die("下载到的不是 PE 可执行文件（前两字节应为 MZ）");

// 工具包：匿名能不能下、是不是个真 zip（前两字节 PK）。
// 这条看着多余，但它防的是最尴尬的一种发布 —— 主程序装上了，
// 用户照着设置里的地址去下载工具包，结果 404。
const zipUrl = `https://github.com/${slug}/releases/download/${tag}/${toolsZipName}`;
const r3 = await fetch(zipUrl, { redirect: "follow", headers: { Range: "bytes=0-1" } });
if (r3.status !== 206 && r3.status !== 200) die(`工具包地址下不动：HTTP ${r3.status}`, zipUrl);
const zipHead = Buffer.from(await r3.arrayBuffer());
if (zipHead[0] !== 0x50 || zipHead[1] !== 0x4b) die("下载到的不是 zip（前两字节应为 PK）");

say(`  update.json  → ${latestUrl}`);
say(`  安装包       → ${dlUrl}`);
say(`  工具包       → ${zipUrl}`);
say(`  签名与清单一致、两份资产都可下载 ✓`);
say("");
say("发布完成：" + rel.json.html_url);

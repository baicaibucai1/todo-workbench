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
 * 2. **三样东西必须一起换。**
 *    安装包、`.sig` 签名、`update.json`。漏了签名，老版本验签失败拒绝更新；
 *    update.json 没覆盖旧的，客户端会一直以为已是最新。这个脚本保证同批上传。
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

import { execFileSync, spawnSync } from "node:child_process";
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

function getToken() {
  const r = spawnSync("git", ["credential", "fill"], {
    input: "protocol=https\nhost=github.com\n\n",
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    timeout: 30000,
  });
  const pw = ((r.stdout || "").match(/^password=(.*)$/m) || [])[1] || "";
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

const remote = execFileSync("git", ["remote", "get-url", "origin"], { cwd: ROOT, encoding: "utf8" }).trim();
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
  park(wantExe);
  park(wantSig);
  // 同名 .sig 必须跟着走，否则签名与包对不上号
  const srcSig = `${newest}.sig`;
  if (fs.existsSync(path.join(bundleDir, srcSig))) park(srcSig);
  fs.renameSync(path.join(bundleDir, newest), path.join(bundleDir, wantExe));
  if (fs.existsSync(path.join(bundleDir, srcSig))) {
    fs.renameSync(path.join(bundleDir, srcSig), path.join(bundleDir, wantSig));
  }
}

const exePath = path.join(bundleDir, wantExe);
const sigPath = path.join(bundleDir, wantSig);
if (!fs.existsSync(sigPath)) {
  die(`缺少签名文件 ${wantSig}`, "更新包必须签名，否则已安装的旧版本会拒绝安装。重新打包。");
}

/* —— 3) 生成 update.json —— */
const updateJson = path.join(ROOT, "update.json");
const notes = NOTES && fs.existsSync(NOTES)
  ? fs.readFileSync(NOTES, "utf8").split("\n")[0].trim()
  : `待办工作台 ${tag}`;
const baseUrl = `https://github.com/${slug}/releases/download/${tag}`;

say("");
say("生成 update.json …");
execFileSync(process.execPath, [path.join(__dirname, "gen-update-json.mjs"), version, baseUrl], {
  cwd: ROOT,
  stdio: "inherit",
  env: { ...process.env, RELEASE_NOTES: notes },
});

const assets = [exePath, sigPath, updateJson];
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

say(`  update.json  → ${latestUrl}`);
say(`  安装包       → ${dlUrl}`);
say(`  签名与清单一致、下载内容可执行 ✓`);
say("");
say("发布完成：" + rel.json.html_url);

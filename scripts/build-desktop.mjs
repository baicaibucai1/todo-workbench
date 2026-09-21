#!/usr/bin/env node
/**
 * build-desktop.mjs —— 桌面版打包的统一入口
 *
 * 为什么需要这一层（而不是让 .bat 直接调 `npm run tauri build`）：
 *
 * 1. **签名密码不能靠 cmd 设置。**
 *    cmd 里 `set "TAURI_SIGNING_PRIVATE_KEY_PASSWORD="` 是「删除变量」而不是
 *    「设为空字符串」。实测（`tauri signer sign`）：
 *      变量缺失      -> 挂起 12 秒仍未返回（在等交互式输入）→ 双击 .bat 会无限期卡住
 *      空字符串 ""   -> 244ms 签名成功
 *    Node 里 `env.X = ""` 才是真正的空字符串，所以这一步必须由 Node 来做。
 *
 * 2. **PATH 必须自己补。**
 *    MinGW 一定不在用户持久 PATH 里（我们解压在用户目录），而 GNU 目标下
 *    embed-resource 是用裸命令名 `windres` 去调它的，找不到就直接编译失败。
 *    目录清单交给 scripts/toolchain-path.mjs（它读 src-tauri/.cargo/config.toml）。
 *
 * 3. **WebView2Loader.dll 必须先进 src-tauri/。**
 *    见 scripts/sync-webview2-loader.mjs 的说明。
 *
 * 4. **输出要实时流式打印。**
 *    之前用 spawnSync 把输出全部缓冲到最后才打印，编译几分钟里窗口一片空白，
 *    用户会以为卡死。现在边跑边输出，同时留存完整日志。
 *
 * 5. **前端产物不重复构建。**
 *    由本脚本按需构建（直调 tsc / vite，绕开 npm 包装器），再把 Tauri 的
 *    beforeBuildCommand 置空，避免同一份前端构建两遍。
 *    注意这只影响本次调用；在正常终端里跑 `npm run tauri build` 不受影响。
 *
 * 用法：
 *   node scripts/build-desktop.mjs                # 正常打包
 *   node scripts/build-desktop.mjs --quiet        # 只在出错时输出
 *   node scripts/build-desktop.mjs --no-frontend  # 跳过前端产物检查
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
const QUIET = argv.includes('--quiet');
const SKIP_FRONTEND = argv.includes('--no-frontend');

const CLI = path.join(ROOT, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
const TSC = path.join(ROOT, 'node_modules', 'typescript', 'lib', 'tsc.js');
const VITE = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
const SIGN_KEY = path.join(ROOT, '.tauri-key');
const LOG_DIR = path.join(ROOT, '.setup-tmp');
const LOG = path.join(LOG_DIR, 'tauri-build.log');

const say = (...a) => {
  if (!QUIET) console.log(...a);
};

function fail(msg, hint) {
  console.error('');
  console.error('[x] ' + msg);
  if (hint) console.error('    ' + hint);
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function runCapture(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: ROOT, windowsHide: true });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', () => resolve({ out, err }));
  });
}

/** 跑一条命令，边跑边把输出转给当前终端，同时留存文本用于日志 */
function runStreamed(label, cmd, args, env) {
  return new Promise((resolve) => {
    say('');
    say(label);
    say('-'.repeat(Math.max(40, label.length)));

    const p = spawn(cmd, args, {
      cwd: ROOT,
      env,
      windowsHide: true,
      stdio: ['inherit', 'pipe', 'pipe'],
    });

    let captured = '';
    const forward = (stream, sink) => {
      stream.on('data', (d) => {
        captured += d.toString();
        if (!QUIET) sink.write(d);
      });
    };
    forward(p.stdout, process.stdout);
    forward(p.stderr, process.stderr);

    p.on('error', (e) => {
      captured += `\n[spawn error] ${e.message}\n`;
      if (!QUIET) console.error(`[spawn error] ${e.message}`);
      resolve({ code: -1, captured });
    });
    p.on('close', (code) => resolve({ code, captured }));
  });
}

/**
 * dist/ 是不是比源码旧。
 *
 * 原来只判断 `dist/index.html 存在与否` 就决定复用 —— 于是「改了源码再打包」
 * 会静默把**旧前端**打进安装包，而且产物看起来完全正常。
 * 这类问题只在装上运行后发现功能不对，极难往打包环节去想，所以按时间戳判断。
 */
function distIsStale() {
  const distIndex = path.join(ROOT, 'dist', 'index.html');
  if (!fs.existsSync(distIndex)) return true;

  const distTime = fs.statSync(distIndex).mtimeMs;
  const skip = new Set(['node_modules', 'dist', 'target', '.git', '.setup-tmp']);
  let newest = 0;

  // 图片也算「源码」：`public/` 下的静态资源（壁纸、图标）是 Vite 原样搬进
  // dist 的，它们变了就说明 dist 必须重建。只认 .ts/.css 的话，往
  // public/wallpapers/ 加一批新图会判定成"没有改动"、直接复用旧 dist ——
  // 于是新图永远进不了安装包，而打包脚本和门禁看起来都是成功的。
  const TRACKED = /\.(ts|tsx|css|html|json|jpg|jpeg|png|gif|svg|webp|ico|woff2?)$/;

  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      if (skip.has(name) || name.startsWith('.')) continue;
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else if (TRACKED.test(name)) newest = Math.max(newest, st.mtimeMs);
    }
  };
  // `public` 必须在列表里：壁纸就是放这儿的，漏了它就漏了整个静态资源目录。
  for (const d of ['src', 'tools', 'public']) {
    const p = path.join(ROOT, d);
    if (fs.existsSync(p)) walk(p);
  }
  return newest > distTime;
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main() {
  const logs = [];

  say('=== 前置检查 ===');
  for (const [name, p, hint] of [
    ['tauri CLI', CLI, '请先在项目根目录运行 npm install。'],
    [
      '签名私钥',
      SIGN_KEY,
      '这个密钥用于给更新包签名，丢了就无法再给已安装用户推送更新。请从备份恢复。',
    ],
  ]) {
    const ok = fs.existsSync(p);
    say(`  ${ok ? '[OK]  ' : '[缺失]'} ${name}${ok ? '' : '  ' + p}`);
    if (!ok) fail(`${name} 缺失：${p}`, hint);
  }

  // ---- PATH ----
  let toolchainPath = '';
  try {
    const r = await runCapture(process.execPath, [path.join(__dirname, 'toolchain-path.mjs')]);
    toolchainPath = r.out.trim();
  } catch (e) {
    fail('无法确定工具链路径。', e.message);
  }

  const env = {
    ...process.env,
    PATH: [toolchainPath, process.env.PATH].filter(Boolean).join(';'),
    // 关键：必须是「存在的空字符串」，不能是「不存在」——
    // cmd 的 `set "VAR="` 会删除变量，Tauri 就会转交互式索要密码并卡死。
    TAURI_SIGNING_PRIVATE_KEY: SIGN_KEY,
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '',
    CARGO_TERM_COLOR: 'never',
  };

  say('');
  say('  PATH 追加：');
  for (const d of toolchainPath.split(';').filter(Boolean)) {
    say(`    ${fs.existsSync(d) ? '[OK]  ' : '[缺失]'} ${d}`);
  }
  say(`  签名私钥：${SIGN_KEY}  （密码为空字符串）`);

  // ---- WebView2Loader.dll ----
  // GNU 工具链下 webview2-com-sys 动态链接它；
  // tauri-build 只把它拷进 target/，没加进 bundle.resources，安装包会漏装。
  const sync = await runStreamed(
    '同步 WebView2Loader.dll',
    process.execPath,
    [path.join(__dirname, 'sync-webview2-loader.mjs')],
    env,
  );
  logs.push(sync.captured);
  if (sync.code !== 0) {
    fail(
      'WebView2Loader.dll 同步失败。',
      '打包器会把缺失的资源当成致命错误，装上也会启动失败，因此不继续。',
    );
  }

  // ---- 工具副本与附属资源 ----
  //
  // 必须跑在**前端构建之前**：vite 会把整个 tools/ 目录原样复制进 dist，
  // 漏了这一步，dist 与安装包里就都是"缺 AI 模型"的工具版本。
  // （2026-09-21 的 bug 就是这样出去的：image-crop 的 ai/ 从来没被搬运过。）
  //
  // 这里用**非 --check 模式**，也就是直接同步，而不是挡住打包：
  //   · 源文件不在（别人 clone 了公开仓库）时 sync-tools 只 [跳过]，退出码仍是 0 —— 那是合法状态，
  //     工具会退回本地算法，不该拦住打包；
  //   · 只有真问题（工具入口缺失、内联 onclick 与 window 导出对不上）才返回 1。
  const tools = await runStreamed(
    '同步工具副本与附属资源',
    process.execPath,
    [path.join(__dirname, 'sync-tools.mjs')],
    env,
  );
  logs.push(tools.captured);
  if (tools.code !== 0) {
    fail(
      '工具副本同步失败。',
      '工具入口缺失，或内联 onclick 与 window 导出对不上。跑 node scripts/sync-tools.mjs 看详情。',
    );
  }

  // ---- 前端产物 ----
  if (!SKIP_FRONTEND) {
    const distIndex = path.join(ROOT, 'dist', 'index.html');
    if (fs.existsSync(distIndex) && !distIsStale()) {
      say('');
      say(`前端产物是最新的，直接复用：${path.relative(ROOT, distIndex)}`);
    } else {
      say('');
      say(
        fs.existsSync(distIndex)
          ? '前端产物比源码旧（源码改过），重新构建...'
          : '未发现前端产物 dist/，先构建前端（直调 tsc 与 vite，绕开 npm 包装器）...',
      );
      for (const [label, script, extra] of [
        ['类型检查', TSC, ['-b', '--pretty', 'false']],
        ['前端构建', VITE, ['build']],
      ]) {
        if (!fs.existsSync(script)) fail(`找不到 ${script}`, '请先运行 npm install。');
        const r = await runStreamed(label, process.execPath, [script, ...extra], env);
        logs.push(r.captured);
        if (r.code !== 0) fail(`${label} 失败。`, '修好后再重新打包。');
      }
    }
  }

  // ---- 打包 ----
  const override = JSON.stringify({ build: { beforeBuildCommand: '' } });

  const started = Date.now();
  const build = await runStreamed(
    '打包中（首次编译 Rust 依赖较久，之后增量很快）',
    process.execPath,
    [CLI, 'build', '--config', override],
    env,
  );
  logs.push(build.captured);
  const seconds = ((Date.now() - started) / 1000).toFixed(0);

  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.writeFileSync(
      LOG,
      `status=${build.code}\n耗时=${seconds}s\n\n${logs.join('\n\n=====\n\n')}`,
      'utf8',
    );
  } catch {
    /* 日志写不出来不影响打包结果 */
  }

  say('');
  if (build.code !== 0) {
    console.error(`[x] 打包失败（${seconds}s）。完整日志：${path.relative(ROOT, LOG)}`);
    process.exit(1);
  }

  say(`打包成功，耗时 ${seconds}s。`);

  // ---- 装完能不能用 ----
  // 「打包成功」只说明 NSIS 生成出来了，不代表安装目录里有该有的东西。
  // 见过的故障：WebView2Loader.dll 没进 resources（装完打不开）、
  // tools/ 里新增的工具没进包（侧边栏点了空白）。两者在 release/ 目录里都看不出问题。
  // 所以这里读生成的 installer.nsi，逐文件核对。
  const verify = await runStreamed(
    '校验安装包内容',
    process.execPath,
    [path.join(__dirname, 'check-installer.mjs')],
    env,
  );
  logs.push(verify.captured);
  if (verify.code !== 0) {
    console.error('');
    console.error('[x] 打包产物的内容校验没通过 —— 安装包能装，但装完可能缺文件。');
    console.error('    上面标 FAIL 的条目就是缺的东西，修好后重新打包。');
    process.exit(1);
  }

  say('产物位置用 `npm run build:status` 查看。');

  // ---- 静态资源是不是真的进了 exe ----
  // 前端资源（含壁纸）不是走 nsi 清单的，是 Tauri 把整个 dist 嵌进 exe。
  // 所以上面的安装包校验看不到它们 —— 而"壁纸没嵌进去"的表现只是
  // 设置里那排格子是空的，装完之后根本没法当场查。刚打完包时 exe 必然比
  // dist 新，正好是这条校验最有意义的时候。
  const assets = await runStreamed(
    '校验随包静态资源（壁纸）',
    process.execPath,
    [path.join(ROOT, 'tests', 'wallpapers.mjs')],
    env,
  );
  logs.push(assets.captured);
  if (assets.code !== 0) {
    console.error('');
    console.error('[x] 壁纸等静态资源没有完整嵌进 exe —— 装完能用，但设置里选不了壁纸。');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('[x] 未预期的错误：' + (e?.stack ?? e));
  process.exit(1);
});

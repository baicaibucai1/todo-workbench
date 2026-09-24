#!/usr/bin/env node
/**
 * check-installer.mjs —— 校验 NSIS 安装包「里面到底装了什么」
 *
 * 为什么需要这个脚本：
 *
 * 打包成功 ≠ 装上能用。踩过的坑都属于「文件在，但没进安装包」：
 *
 *   1. WebView2Loader.dll
 *      GNU 工具链下 todo-workbench.exe 的 PE 导入表第一项就是它。tauri-build 会把它
 *      拷进 target/，但没加进 bundle.resources → 安装目录里没有 → 双击弹「找不到
 *      WebView2Loader.dll」。release 目录里有这个文件，纯属假象。
 *
 *   2. 工具目录
 *      bundle.resources 的 glob（../tools/**\/*）在**打包那一刻**展开。tools/ 里有几个
 *      工具，安装包里就该有几个；少一个就是「侧边栏点了没反应」。
 *      而 dist/tools 一直是全的 —— 又一层「看着有」的假象。
 *
 * 所以判据只能是生成的 installer.nsi：那里面逐文件列着实际写进安装目录的东西，
 * 是唯一可信的清单。
 *
 * 关于 `_up_`：资源路径 `../tools/x` 里的 `..` 会被 Tauri 编码成 `_up_`，
 * 于是装到 $INSTDIR\_up_\tools\x。运行时的 resource_dir 解析用的是同一套规则，
 * 所以两边对得上 —— 这是设计，不是笔误。
 *
 * 用法：
 *   node scripts/check-installer.mjs               # 校验最近一次打包
 *   node scripts/check-installer.mjs --verbose     # 打印完整安装清单
 *   node scripts/check-installer.mjs --nsi <路径>  # 指定 installer.nsi
 *
 * 退出码：0 = 全通过，1 = 有缺漏（可直接当打包后的门禁）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
const VERBOSE = argv.includes('--verbose');
const nsiArgIdx = argv.indexOf('--nsi');

let pass = 0;
let fail = 0;

function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  —  ' + detail : ''}`);
  if (ok) pass++;
  else fail++;
}
const info = (label, value) => console.log(`         ${label}: ${value}`);

/* ------------------------------------------------------------------ */
/* 1. 找 installer.nsi                                                 */
/* ------------------------------------------------------------------ */

function findNsi() {
  if (nsiArgIdx >= 0 && argv[nsiArgIdx + 1]) {
    const p = path.resolve(argv[nsiArgIdx + 1]);
    return fs.existsSync(p) ? p : null;
  }
  for (const t of ['x86_64-pc-windows-gnu', 'x86_64-pc-windows-msvc']) {
    for (const arch of ['x64', 'arm64']) {
      const c = path.join(ROOT, 'src-tauri', 'target', t, 'release', 'nsis', arch, 'installer.nsi');
      if (fs.existsSync(c)) return c;
    }
  }
  return null;
}

console.log('=== 安装包内容校验 ===');
const nsi = findNsi();
if (!nsi) {
  console.error('  [x] 找不到 installer.nsi —— 还没成功打包过 NSIS，或产物被清了。');
  console.error('      先跑：node scripts/build-desktop.mjs');
  process.exit(1);
}
const nsiText = fs.readFileSync(nsi, 'utf8');
const nsiLines = nsiText.split(/\r?\n/);

info('脚本', nsi.replace(ROOT + path.sep, ''));
info('打包时间', fs.statSync(nsi).mtime.toLocaleString('zh-CN'));

/* ------------------------------------------------------------------ */
/* 2. 解析 nsi                                                         */
/* ------------------------------------------------------------------ */

/** 取 `!define NAME "VALUE"` */
function def(name) {
  const m = nsiText.match(new RegExp(`^\\s*!define\\s+${name}\\s+"([^"]*)"`, 'm'));
  return m ? m[1] : null;
}

const mainBinaryName = def('MAINBINARYNAME');
const mainBinarySrc = def('MAINBINARYSRCPATH');
const productName = def('PRODUCTNAME');
const mainExe = mainBinaryName ? `${mainBinaryName}.exe` : null;

/**
 * 安装段里的 File 行有两种：
 *   File /a "/oname=<装到哪里，相对 $INSTDIR>" "<源文件绝对路径>"
 *   File "${MAINBINARYSRCPATH}"        ← 主程序，装成 ${MAINBINARYNAME}.exe
 * 另外 WebView2 引导程序会 File 到 $TEMP，装完即弃，不算安装内容。
 */
const installFiles = [];
for (const line of nsiLines) {
  const t = line.trim();
  if (!/^File\s/.test(t)) continue;

  if (/\$TEMP/i.test(t)) {
    installFiles.push({ target: '(临时：WebView2 引导程序)', temp: true, raw: t });
    continue;
  }

  // /oname= 的值一直取到下一个引号
  const oname = t.match(/\/oname=([^"]+)"/i);
  if (oname) {
    installFiles.push({
      target: oname[1].replace(/\\/g, '/'),
      source: (t.match(/"([^"]+)"\s*$/) || [])[1] || null,
      raw: t,
    });
  } else {
    installFiles.push({ target: mainExe, source: mainBinarySrc, mainBinary: true, raw: t });
  }
}

/** 卸载段的 Delete 清单（把 ${NAME} 展开成实际值后再比对） */
function expandVars(s) {
  return s
    .replace(/\$\{MAINBINARYNAME\}/g, mainBinaryName || '')
    .replace(/\$\{PRODUCTNAME\}/g, productName || '')
    .replace(/\$\{MAINBINARYSRCPATH\}/g, mainBinarySrc || '');
}
const uninstallDeletes = new Set();
for (const line of nsiLines) {
  const m = line.match(/^\s*Delete\s+"\$INSTDIR\\?([^"]*)"/i);
  if (m) uninstallDeletes.add(expandVars(m[1]).replace(/\\/g, '/'));
}
// 也收 /REBOOTOK 形式
for (const line of nsiLines) {
  const m = line.match(/^\s*Delete\s+\/REBOOTOK\s+"\$INSTDIR\\?([^"]*)"/i);
  if (m) uninstallDeletes.add(expandVars(m[1]).replace(/\\/g, '/'));
}

/* ------------------------------------------------------------------ */
/* 3. 工具是否全部进包                                                  */
/* ------------------------------------------------------------------ */

const toolsDir = path.join(ROOT, 'tools');
const diskTools = fs.existsSync(toolsDir)
  ? fs
      .readdirSync(toolsDir)
      .filter((d) => fs.statSync(path.join(toolsDir, d)).isDirectory())
      .sort()
  : [];

/*
 * 工具随不随包，由配置决定，校验跟着配置走，而不是写死一边。
 *
 * 0.2.0 起是「不随包」：安装包只发程序本体，工具单独打成 zip 挂在同一个
 * Release 上。哪天又把 `../tools/**\/*` 加回 bundle.resources，这里的判据
 * 会自动翻回「每个工具、每个附属文件都必须在安装清单里」——不用记得改脚本，
 * 而「记得改」的那类约定通常都会忘。
 */
const conf = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  } catch (e) {
    check('读取 tauri.conf.json', false, String(e?.message ?? e));
    return {};
  }
})();
const resources = Array.isArray(conf.bundle?.resources) ? conf.bundle.resources : [];
const bundlesTools = resources.some((r) => /tools/i.test(String(r)));
const version = String(conf.version || '0.0.0');

/** 安装清单里那些「工具文件」条目 */
const toolEntries = installFiles.filter((f) => /^_up_\/tools\//i.test(f.target));

console.log('');
console.log('--- 1. 工具是否随包 ---');
info('bundle.resources', resources.length ? resources.join(' , ') : '(空)');
info('磁盘上的工具', `${diskTools.length} 个：${diskTools.join(', ')}`);
info('安装清单条目', `${installFiles.filter((f) => !f.temp).length} 项`);

if (!bundlesTools) {
  /*
   * 不随包时要守的三件事，一件比一件靠外：
   *   ① 安装清单里没有 tools 文件 —— 这是 NSIS 实际会写什么；
   *   ② bundle.resources 里没有 tools 条目 —— 这是 ① 之所以成立的原因；
   *   ③ 工具包 zip 存在且含全部工具 —— 这是「工具改由谁交付」。
   * 少验任何一条，都会得到一次"看着合格、实际缺一半"的发布。
   */
  check(
    '安装包里没有工具文件',
    toolEntries.length === 0,
    toolEntries.length ? `清单里还留着 ${toolEntries.length} 条 tools 资源` : '0 条',
  );

  const zipName = `todo-workbench-tools_${version}.zip`;
  const zipPath = path.join(ROOT, 'release-assets', zipName);
  if (fs.existsSync(zipPath)) {
    // zip 的文件名在中央目录里是明文，搜二进制就够 ——
    // 不必为了数条目去把几十兆解一遍
      const zipBuf = fs.readFileSync(zipPath);
      // zip 里该有的 = 磁盘工具 - pack-tools.mjs 的 EXCLUDE。
      // 两份清单必须同步：pack 那边排除谁（gomoku 是开发样本，不随包），
      // 这边的期望就得跟着排除 —— 否则每次打包都被自己人拦一道
      // （0.2.1 就是这么红过一回）。
      const packExcluded = ['gomoku'];
      const expected = diskTools.filter((t) => !packExcluded.includes(t));
      const absent = expected.filter(
        (t) => zipBuf.indexOf(Buffer.from(`tools/${t}/manifest.json`, 'utf8')) === -1,
      );
      check(
        `工具包 ${zipName} 含全部 ${expected.length} 个工具`,
        absent.length === 0,
        absent.length ? `缺：${absent.join(', ')}` : `${(zipBuf.length / 1048576).toFixed(1)} MB`,
      );
  } else {
    check(
      `存在工具包资产 ${zipName}`,
      false,
      '工具不随包，就必须有这份独立资产供用户下载 —— 跑 node scripts/pack-tools.mjs',
    );
  }
} else {

const targetSet = new Set(installFiles.map((f) => f.target.toLowerCase()));

if (diskTools.length === 0) {
  check('tools/ 下至少有一个工具', false, '目录是空的，检查路径');
} else {
  let missing = 0;
  for (const tool of diskTools) {
    for (const file of ['index.html', 'manifest.json']) {
      const want = `_up_/tools/${tool}/${file}`.toLowerCase();
      const hit = targetSet.has(want);
      if (!hit) missing++;
      check(`工具 ${tool} / ${file}`, hit, hit ? '' : `安装清单里缺 ${want}`);
    }
  }
  if (missing === 0) info('结论', '全部工具都会被装进安装目录');
}

/*
 * 工具的**附属目录**（tools/<id>/<sub>/）是否也进包。
 *
 * 为什么单列一条：上面那个循环只看 index.html 与 manifest.json，**完全盖不到子目录**。
 * 2026-09-21 就是这么漏掉的 —— image-crop 的 ai/（ONNX Runtime + MI-GAN 模型）
 * 从来没进过安装包，工具里的 AI 补全一直在跑降级路径，而源目录双击打开却是好的。
 * 两边看起来都正常，只是行为差一档，属于最难查的那类问题。
 *
 * 判据：磁盘上**存在**的附属目录，其每个文件都必须在安装清单里。
 * 磁盘上不存在就跳过 —— 那是 sync-tools 没能从源目录搬来的情况（别人 clone 仓库），
 * 工具会自己退回本地算法，不是打包错误。
 */
console.log('');
console.log('--- 1b. 工具的附属目录是否进包 ---');

let subDirs = 0;
let subBad = 0;
for (const tool of diskTools) {
  const toolDir = path.join(toolsDir, tool);
  const subs = fs
    .readdirSync(toolDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  for (const sub of subs) {
    const files = [];
    (function walk(p, prefix) {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        const full = path.join(p, e.name);
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) walk(full, rel);
        else files.push(rel);
      }
    })(path.join(toolDir, sub), "");

    subDirs++;
    const miss = files
      .filter((f) => !targetSet.has(`_up_/tools/${tool}/${sub}/${f}`.toLowerCase()))
      .sort();
    if (miss.length) subBad++;
    check(
      `${tool}/${sub}（${files.length} 个文件）`,
      miss.length === 0,
      miss.length ? `安装清单里缺：${miss.slice(0, 3).join(', ')}${miss.length > 3 ? ` 等 ${miss.length} 个` : ''}` : '',
    );
  }
}
if (subDirs === 0) info('结论', '没有附属目录（跳过）');
else if (subBad === 0) info('结论', `${subDirs} 个附属目录都会进安装目录`);

// 反向：安装清单里有、磁盘上已没有的工具（改了名或删了工具却没重新打包）
for (const f of installFiles) {
  const m = f.target.match(/^_up_\/tools\/([^/]+)\//i);
  if (m && !diskTools.includes(m[1])) {
    check(`安装清单里的工具 ${m[1]} 现在仍存在`, false, '磁盘上已无此工具，说明产物过期');
  }
}

} // end: bundlesTools

/* ------------------------------------------------------------------ */
/* 4. 主程序与运行时依赖                                                */
/* ------------------------------------------------------------------ */

console.log('');
console.log('--- 2. 主程序与运行时依赖 ---');
info('主程序名', mainExe || '(未能从 nsi 解析)');

const exeEntry = installFiles.find((f) => f.mainBinary || (mainExe && f.target === mainExe));
check(`${mainExe || '主程序'} 在安装清单里`, !!exeEntry, exeEntry ? 'File "${MAINBINARYSRCPATH}"' : '未找到');

const dllEntry = installFiles.find((f) => /webview2loader\.dll$/i.test(f.target));
check(
  'WebView2Loader.dll 在安装清单里（GNU 目标下缺了就启动不了）',
  !!dllEntry,
  dllEntry ? dllEntry.target : '未找到 —— 检查 tauri.conf.json 的 bundle.resources',
);
if (dllEntry?.source) {
  const exists = fs.existsSync(dllEntry.source);
  check(
    'WebView2Loader.dll 源文件存在且非空',
    exists && fs.statSync(dllEntry.source).size > 0,
    exists ? `${fs.statSync(dllEntry.source).size} 字节` : '源文件不存在',
  );
}

/* ------------------------------------------------------------------ */
/* 5. 更新能力与产物                                                    */
/* ------------------------------------------------------------------ */

console.log('');
console.log('--- 3. 自动更新产物 ---');

const upCount = installFiles.filter((f) => /^_up_\//i.test(f.target)).length;
// 严格一点：路径里带 `..` 的资源会被编成 _up_，那**必须**能在清单里数出来；
// 而不带 `..` 的资源（现在的 WebView2Loader.dll）压根不会走这条编码，
// 那时清单里出现 _up_ 反而说明混进了不该有的东西 —— 所以两个方向都要验。
if (resources.some((r) => /\.\./.test(String(r)))) {
  check('安装清单里有 _up_ 资源（`..` 的编码形式）', upCount > 0, `${upCount} 项`);
} else {
  check('没有出现多余的 _up_ 资源', upCount === 0, `${upCount} 项`);
}

const bundleDir = path.join(ROOT, 'src-tauri', 'target', 'x86_64-pc-windows-gnu', 'release', 'bundle');
let nsisPkg = null;
let sigFile = null;
// 产物会放在 bundle/nsis/ 里（不是 bundle/ 根），所以得递归找。
// 排除 WebView2 引导程序（那是随包携带的临时文件，不是我们的产物）。
function scanBundle(dir, depth = 0) {
  if (!fs.existsSync(dir) || depth > 3) return;
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) {
      scanBundle(p, depth + 1);
      continue;
    }
    if (!/\.(exe|sig)$/i.test(f)) continue;
    if (/webview2/i.test(f)) continue;
    if (/\.sig$/i.test(f)) sigFile = p;
    else nsisPkg = p;
  }
}
scanBundle(bundleDir);

const setupName = nsisPkg ? path.basename(nsisPkg) : null;
check(
  'NSIS 安装包已生成',
  !!nsisPkg,
  setupName || `未找到（看了 ${bundleDir.replace(ROOT + path.sep, '')}）`,
);
check(
  '安装包有配对的 .sig 签名（缺它就没法给已装用户推更新）',
  !!sigFile,
  sigFile ? path.basename(sigFile) : '未找到 —— 检查 TAURI_SIGNING_PRIVATE_KEY',
);
if (nsisPkg) {
  const bytes = fs.statSync(nsisPkg).size;
  info('安装包', `${(bytes / 1048576).toFixed(1)} MB  ${path.relative(ROOT, nsisPkg)}`);
  // 体积只作参考，不作断言：它随 opt-level / LTO / strip 设置漂移
  // （本项目是 opt-level="s" + lto + strip，2.7 MB 属正常）。
  // 「资源有没有打进去」已由上面逐文件核对精确覆盖，用体积当门禁只会制造假警报。
  const exeBytes = exeEntry?.source && fs.existsSync(exeEntry.source) ? fs.statSync(exeEntry.source).size : 0;
  if (exeBytes) {
    info('主程序', `${(exeBytes / 1048576).toFixed(1)} MB（未压缩）`);
  }
}

/* ------------------------------------------------------------------ */
/* 6. 卸载是否对称                                                      */
/* ------------------------------------------------------------------ */

console.log('');
console.log('--- 4. 卸载是否清得干净 ---');

const uninstallMissing = installFiles
  .filter((f) => !f.temp && !f.mainBinary)
  .map((f) => f.target)
  .filter((t) => !uninstallDeletes.has(t));

check(
  '安装清单里的每个资源都有对应卸载项',
  uninstallMissing.length === 0,
  uninstallMissing.length ? `缺 ${uninstallMissing.length} 项：${uninstallMissing.slice(0, 4).join(', ')}` : '',
);
check(
  '卸载会删除主程序',
  uninstallDeletes.has(mainExe) || [...uninstallDeletes].some((d) => d.endsWith('.exe')),
  [...uninstallDeletes].filter((d) => d.endsWith('.exe')).join(', ') || '(未找到 .exe 的 Delete)',
);

/* ------------------------------------------------------------------ */
/* 5. 运行时路径契约：装在哪 vs 配置允许读哪                             */
/* ------------------------------------------------------------------ */

/*
 * 这一节是为一个真实故障补的：工具文件确实都装进了安装目录，
 * 但 ① 代码去 %APPDATA%/tools 找它们（那目录是空的）、
 * ② assetProtocol.scope 只放行了 $RESOURCE/tools/**（实际在 $RESOURCE/_up_/tools/**）、
 * ③ CSP 的 frame-src 没允许 asset 协议。
 * 三项全对不上，表现就是「桌面版所有工具都打不开」，而浏览器 demo 一切正常 ——
 * 因为浏览器走的是 Vite 静态服务，根本不碰这条链路。
 *
 * 所以「装好了」和「能用」之间还差这一节：把安装位置和配置允许的位置对上账。
 */

console.log('');
console.log('--- 5. 运行时路径契约 ---');

/* conf 已在第 1 节读取过（同一份配置，不必读两遍） */
const security = conf.app?.security ?? {};
const assetProto = security.assetProtocol ?? {};
const scopeList = Array.isArray(assetProto.scope) ? assetProto.scope : [];

check('assetProtocol 已启用', assetProto.enable === true);

const toolRels = toolEntries.map((f) => f.target);
if (toolRels.length) {
  info('工具在资源根下的相对路径', `${toolRels.length} 条，例如 ${toolRels[0]}`);
}

/** `$RESOURCE/x/**` 这类 scope 条目能否覆盖某个相对路径 */
function scopeCovers(entry, rel) {
  if (typeof entry !== 'string' || !/^\$RESOURCE/i.test(entry)) return false; // 工具来自安装包
  const body = entry.replace(/^\$RESOURCE\/?/i, '');
  // 注意：通配符必须**一次替换完**。分两步写（先把 ** 换成 .* 再把 * 换成 [^/]*）
  // 会让第二步把第一步刚生成的 .* 里的星号也吃掉，变成 .[^/]* —— 静默匹配失败。
  const pattern =
    '^' +
    body
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*|\*/g, (m) => (m === '**' ? '.*' : '[^/]*')) +
    '$';
  return new RegExp(pattern, 'i').test(rel);
}

// 工具不随包时，安装清单里自然没有 tools 条目可以比对；
// 但**用户数据区**那条路必须照样放行 —— 下载的工具包就落在这儿，
// 助手写的工具也装在这儿。漏了它的表现是"工具装上了，iframe 一直白屏"。
if (bundlesTools) {
  const uncovered = toolRels.filter((rel) => !scopeList.some((s) => scopeCovers(s, rel)));
  check(
    'assetProtocol.scope 覆盖每一个工具文件',
    toolRels.length > 0 && uncovered.length === 0,
    uncovered.length
      ? `有 ${uncovered.length} 条没被放行，例如 ${uncovered[0]}；现有 scope: ${scopeList.join(' , ')}`
      : scopeList.join(' , '),
  );
} else {
  check(
    'assetProtocol.scope 放行用户数据区的工具目录（下载解压的工具、助手写的工具都在那儿）',
    scopeList.some((s) => /\$APPDATA\/tools/i.test(String(s))),
    scopeList.join(' , ') || '(未设置)',
  );
}

/** 拆 CSP 成指令表 */
function cspDirectives(text) {
  const out = {};
  for (const part of String(text ?? '').split(';')) {
    const bits = part.trim().split(/\s+/).filter(Boolean);
    if (bits.length) out[bits[0].toLowerCase()] = bits.slice(1).join(' ');
  }
  return out;
}
const csp = cspDirectives(security.csp);
const frameSrc = csp['frame-src'] ?? csp['default-src'] ?? '';
const connectSrc = csp['connect-src'] ?? csp['default-src'] ?? '';
const imgSrc = csp['img-src'] ?? csp['default-src'] ?? '';

check(
  'CSP 允许 iframe 加载 asset 协议（frame-src，缺了工具就是白屏）',
  /asset:|asset\.localhost/i.test(frameSrc),
  frameSrc || '(未设置)',
);
check(
  'CSP 的 connect-src 允许 https:（AI 生成工具要调外部 API）',
  /https:/i.test(connectSrc),
  connectSrc || '(未设置)',
);
check(
  'CSP 的 img-src 允许 https:（AI 返回的成品图是 https URL）',
  /https:/i.test(imgSrc),
  imgSrc || '(未设置)',
);

/* ------------------------------------------------------------------ */
/* 汇总                                                                */
/* ------------------------------------------------------------------ */

if (VERBOSE) {
  console.log('');
  console.log('--- 完整安装清单（写进 $INSTDIR 的东西）---');
  for (const f of installFiles) {
    console.log(`  ${f.temp ? '[临时] ' : '       '}${f.target}`);
  }
  console.log('');
  console.log('--- 卸载删除清单 ---');
  for (const d of [...uninstallDeletes].sort()) console.log(`         ${d}`);
}

console.log('');
console.log(`=== ${fail === 0 ? '全部通过' : '有 ' + fail + ' 项未通过'}（PASS ${pass} / FAIL ${fail}）===`);
process.exit(fail === 0 ? 0 : 1);

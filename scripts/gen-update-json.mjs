/**
 * 生成更新清单 update.json。
 *
 * Tauri updater 的静态更新源就是一个 JSON 文件，把构建产物信息写进去，
 * 应用启动后会去 endpoints 指定的地址拉取它来做版本比对。
 *
 * 用法：
 *   node scripts/gen-update-json.mjs <版本号> [下载地址前缀]
 *
 * 例：
 *   node scripts/gen-update-json.mjs 0.1.1 https://releases.example.com/todo-workbench
 *
 * 它会读取 src-tauri/target/release/bundle/nsis/ 下的安装包与 .sig 签名文件，
 * 生成 update.json 到项目根目录。
 */

import fs from "node:fs";
import path from "node:path";

// 定位安装包目录。
//
// 注意：显式指定 target triple 时（GNU 工具链就会），产物落在
// target/<triple>/release/bundle/nsis/ 下，不是 target/release/bundle/nsis/。
// 所以两种位置都要找，找不到就报错而不是静默用错的路径。
const BUNDLE_DIR = (() => {
  const plain = path.join("src-tauri", "target", "release", "bundle", "nsis");
  const candidates = [plain];

  const targetRoot = path.join("src-tauri", "target");
  if (fs.existsSync(targetRoot)) {
    for (const entry of fs.readdirSync(targetRoot)) {
      candidates.push(path.join(targetRoot, entry, "release", "bundle", "nsis"));
    }
  }
  return candidates.find((c) => fs.existsSync(c)) ?? plain;
})();

const OUT = "update.json";

const version = process.argv[2];
const baseUrl = process.argv[3] ?? "https://your-host.example.com/todo-workbench";

if (!version) {
  console.error("用法: node scripts/gen-update-json.mjs <版本号> [下载地址前缀]");
  process.exit(1);
}

if (!fs.existsSync(BUNDLE_DIR)) {
  console.error(`找不到打包目录: ${BUNDLE_DIR}`);
  console.error("请先执行 npm run tauri build");
  process.exit(1);
}

// NSIS 产物形如：待办工作台_0.1.0_x64-setup.exe（发布脚本会改成 ASCII 的
// todo-workbench_<版本>_x64-setup.exe），签名在同名 .sig 文件里。
const files = fs.readdirSync(BUNDLE_DIR);
const exes = files.filter((f) => f.endsWith("-setup.exe"));

/*
 * ⚠️ 必须**按版本认人**，不能"抓到哪个算哪个"。
 *
 * 产物目录是长期累积的：上一次发布留下的 `todo-workbench_0.1.0_x64-setup.exe`
 * 一直躺在这儿，而 readdir 的顺序恰好让它排在 0.2.0 前面 —— 于是更新清单会
 * 指向**上一版**的安装包，签名也是上一版那个，而生成过程一句警告都没有。
 *
 * 后果是最难查的那一种：老客户端欢天喜地"升级"完，版本号还停在旧版，
 * 客户端这边不报错（签名是配得上那个包的），服务端看清单也看不出毛病。
 */
const wantInstaller = `todo-workbench_${version}_x64-setup.exe`;
let installer = exes.includes(wantInstaller) ? wantInstaller : null;

if (!installer && exes.length) {
  // 退而求其次：取最新改动的那个，并且**必须喊出来** ——
  // 走到这里说明发布脚本的改名步骤没跑，得让人当场知道，而不是事后猜。
  installer = exes
    .map((f) => ({ f, mt: fs.statSync(path.join(BUNDLE_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mt - a.mt)[0].f;
  console.error(`⚠️ 没找到本该存在的 ${wantInstaller}，改用最近产物 ${installer}`);
  console.error(`   这通常意味着没跑 node scripts/publish-release.mjs 的改名步骤。`);
}

if (!installer) {
  console.error(`在 ${BUNDLE_DIR} 里没找到 -setup.exe 安装包`);
  console.error("现有文件：" + (files.join(", ") || "（空）"));
  console.error("");
  console.error("若只想产出安装包而不需要签名，可先把 tauri.conf.json 的");
  console.error("bundle.createUpdaterArtifacts 设为 false 再重新构建。");
  process.exit(1);
}

const sigPath = path.join(BUNDLE_DIR, `${installer}.sig`);
if (!fs.existsSync(sigPath)) {
  console.error(`缺少签名文件: ${installer}.sig`);
  console.error("签名用于让已安装的旧版本验证更新包来源，没有它 updater 会拒绝安装。");
  console.error("请确保设置了环境变量 TAURI_SIGNING_PRIVATE_KEY 后重新构建。");
  process.exit(1);
}

const signature = fs.readFileSync(sigPath, "utf8").trim();

const manifest = {
  version,
  notes: process.env.RELEASE_NOTES ?? `待办工作台 v${version}`,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature,
      url: `${baseUrl.replace(/\/$/, "")}/${encodeURIComponent(installer)}`,
    },
  },
};

fs.writeFileSync(OUT, JSON.stringify(manifest, null, 2) + "\n", "utf8");

console.log(`已生成 ${OUT}`);
console.log("");
console.log(JSON.stringify(manifest, null, 2));
console.log("");
console.log("下一步：把 update.json 和安装包一起上传到上面 url 所在的静态目录。");

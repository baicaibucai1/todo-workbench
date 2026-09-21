/**
 * 构建环境自检。
 * 打包桌面版之前先跑这个，确认前置条件是否齐备。
 */

import fs from "node:fs";
import cp from "node:child_process";
import os from "node:os";

const H = os.homedir();
const has = (p) => {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
};
const cmd = (n) => {
  try {
    cp.execSync(`where ${n}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const results = [];
const report = (label, ok, detail = "") => {
  results.push({ label, ok, detail });
  console.log(`${ok ? "  OK  " : "  --  "} ${label}${detail ? `  (${detail})` : ""}`);
};

console.log("\n========== 构建环境自检 ==========\n");

console.log("Rust 工具链");
const hasCargo = cmd("cargo");
const hasRustup = cmd("rustup");
report("cargo 命令", hasCargo, hasCargo ? "" : "未安装");
report("rustup 命令", hasRustup, hasRustup ? "" : "未安装");
report("~/.cargo 目录", has(`${H}/.cargo`));
report("~/.rustup 目录", has(`${H}/.rustup`));

console.log("\nMSVC 生成工具（Windows 原生编译必需）");
const vsPaths = [
  `${process.env["ProgramFiles(x86)"]}/Microsoft Visual Studio/Installer/vswhere.exe`,
  `${process.env.ProgramFiles}/Microsoft Visual Studio/Installer/vswhere.exe`,
];
const vswhere = vsPaths.find(has);
report("vswhere.exe", !!vswhere, vswhere ?? "未找到，MSVC 可能未安装");

if (hasCargo) {
  try {
    const v = cp.execSync("rustc --version", { encoding: "utf8" }).trim();
    console.log(`        rustc: ${v}`);
  } catch {
    /* ignore */
  }
  try {
    const targets = cp.execSync("rustup target list --installed", { encoding: "utf8" }).trim();
    console.log(`        已装目标: ${targets.split(/\r?\n/).join(", ")}`);
  } catch {
    /* ignore */
  }
}

console.log("\nWebView2 运行时（Tauri 依赖，Win11 自带）");
report(
  "EdgeWebView 目录",
  has("C:/Program Files (x86)/Microsoft/EdgeWebView/Application"),
);
report("Edge 浏览器", has("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"));

console.log("\n打包与更新工具");
report("winget", cmd("winget"));
report("nsis 目录", has(`${process.env.LOCALAPPDATA}/tauri`));

console.log("\n目标平台架构");
console.log(`        系统架构: ${os.arch()}`);
console.log(`        平台: ${os.platform()} ${os.release()}`);

console.log("\n==================================");
const blockers = results.filter((r) => !r.ok);
if (!hasCargo) {
  console.log("\n【阻塞】Rust 未安装，无法编译桌面版。");
} else if (!vswhere) {
  console.log("\n【阻塞】缺少 MSVC 生成工具，Rust 无法链接 Windows 二进制。");
} else {
  console.log("\n环境齐备，可以开始打包。");
}
console.log("");

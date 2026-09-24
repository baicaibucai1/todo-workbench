import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import fs from "node:fs";
import path from "node:path";

/**
 * 保证构建产物里**没有** tools/。
 *
 * 0.2.0 之前这里是反向的：把整个 tools/ 复制进 dist，再由 Tauri 把 dist 嵌进
 * exe。工具里有一份 50 MB 的抠图模型（image-crop/ai），于是每一个用户、每一次
 * 增量更新，都要为一个他可能压根不用的工具下载几十兆。
 *
 * 改成的样子：
 *   · 安装包（含 exe 里的 dist）一个工具都不带
 *   · 工具单独打成 zip，挂在同一个 Release 上（scripts/pack-tools.mjs），
 *     想要的用户下载解压到 %APPDATA%\…\tools 即可，或者让内置助手现写一个
 *
 * 这里做的是**删而不是不管**：dist/ 常常是复用的（打包脚本只在源码变新时才重建），
 * 一次过去构建的 dist/tools 会安静地躺在那儿、跟着下一次打包重新进 exe。
 * 显式删掉它，"不带工具"就不会因为目录里有什么残留而失效。
 *
 * 开发时不受影响：tools/ 在工程根目录下，dev server 本来就把它当静态资源服务，
 * 浏览器演示模式依旧能真正打开每个工具。
 */
function stripBundledTools(): Plugin {
  // 从 config root 推导，避免依赖启动时的 CWD
  let outDir = "";

  return {
    name: "workbench-no-bundled-tools",
    apply: "build",
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const dest = path.join(outDir, "tools");
      if (!fs.existsSync(dest)) return;
      const count = fs.readdirSync(dest).filter((n) =>
        fs.statSync(path.join(dest, n)).isDirectory(),
      ).length;
      fs.rmSync(dest, { recursive: true, force: true });
      console.log(
        `  \x1b[2m→\x1b[0m tools/ \x1b[2m已从产物中移除 ${count} 个工具（工具改为 Release 上的独立资产）\x1b[0m`,
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), stripBundledTools()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    /**
     * ⚠️ 必须是 `127.0.0.1`，不能省成 `false`（= 默认 `localhost`），也不能是 `::1`。
     *
     * 这不是风格问题，是**到底谁能连上**的问题。实测（Node 在 Windows 上起 http
     * server，逐一验证三种 client 地址）：
     *
     *   监听 127.0.0.1 ── 127.0.0.1 ✅   [::1] ❌   localhost ✅
     *   监听 ::1       ── 127.0.0.1 ❌   [::1] ✅   localhost ✅  ← 原来的默认值
     *   监听 ::        ── 三个都 ✅（但那是全接口，等于把 dev server 摊到局域网上）
     *
     * 本机 `localhost` 解析到 IPv6 的 `::1`，而 Vite 的默认 `host: false` 就绑到
     * 它上面 —— 于是**只认 IPv6**。工作台自己的内置浏览器预览走的是 127.0.0.1，
     * 连不上就白屏，而且半点提示都没有。
     *
     * 绑 127.0.0.1 是这里的最优解：IPv4 通、`localhost` 也通（Chromium 与 Node
     * 都会在 ::1 被拒后回落），同时**不**把服务暴露到局域网 —— `::` 虽然三个地址
     * 全通，但那等于对外开了一个口子。
     */
    host: "127.0.0.1",
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "chrome110",
    minify: "esbuild",
    sourcemap: false,
  },
});

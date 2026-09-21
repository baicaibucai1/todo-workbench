import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import fs from "node:fs";
import path from "node:path";

/**
 * 把 tools/ 目录当作静态资源随构建产出。
 *
 * 为什么需要它：工具是「运行时可插拔」的 —— 宿主只按 manifest 契约去读文件，
 * 不认识里面是什么内容，所以工具目录不参与打包，必须原样搬运。
 *
 * 开发时其实不需要这个插件：tools/ 就在工程根目录下，
 * dev server 会把它当静态资源直接服务，工具能被真实嵌入。
 * 这里只补上构建这一步，让 `vite preview` 和部署出去的精简 demo 也能用。
 */
function workbenchTools(): Plugin {
  // 从 config root 推导，避免依赖启动时的 CWD
  let toolsDir = "";
  let outDir = "";

  return {
    name: "workbench-tools",
    apply: "build",
    configResolved(config) {
      toolsDir = path.resolve(config.root, "tools");
      outDir = path.resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      if (!fs.existsSync(toolsDir)) return;
      const dest = path.join(outDir, "tools");
      fs.rmSync(dest, { recursive: true, force: true });
      fs.cpSync(toolsDir, dest, { recursive: true });
      const count = fs.readdirSync(dest).filter((n) =>
        fs.statSync(path.join(dest, n)).isDirectory(),
      ).length;
      console.log(
        `  \x1b[2m→\x1b[0m tools/ \x1b[2m已复制 ${count} 个工具到\x1b[0m ${path.relative(process.cwd(), dest)}`,
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), workbenchTools()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: false,
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

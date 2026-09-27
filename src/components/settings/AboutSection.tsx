import { SectionTitle, Card, InfoCell } from "./parts";
import type { Flash } from "./parts";
import { useState } from "react";
import { isTauri } from "../../lib/db";
import tauriConf from "../../../src-tauri/tauri.conf.json";

/* ------------------------------ 分区：关于与更新 ------------------------------ */

export function AboutSection({ say }: { say: (text: string, tone?: Flash["tone"]) => void }) {
  const [busy, setBusy] = useState(false);

  const checkUpdate = async () => {
    if (!isTauri()) {
      say("浏览器演示模式不支持更新检查；打包后的桌面版启动时会自行检查", "err");
      return;
    }
    setBusy(true);
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      say(update ? `发现新版本 ${update.version}` : "当前已是最新版本");
    } catch (err) {
      say(`检查更新失败：${err instanceof Error ? err.message : String(err)}`, "err");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-[520px]">
      <SectionTitle title="关于" desc={tauriConf.productName} />

      <Card>
        <div className="grid grid-cols-2 gap-y-2.5 text-[13px]">
          <InfoCell label="版本" value={`v${tauriConf.version}`} />
          <InfoCell label="运行环境" value={isTauri() ? "桌面应用" : "浏览器演示"} />
          <InfoCell label="作者" value="Sogapopo" />
          <InfoCell label="标识符" value={tauriConf.identifier} />
        </div>

        <p
          data-about-motto
          className="mt-4 border-t border-line pt-3.5 text-[11.5px] leading-relaxed text-fg-dim"
        >
          我们的生命都相当无序甚至是荒谬，也许这款应用能帮您从中构建部分的秩序
        </p>
      </Card>

      <div className="mt-4">
        <SectionTitle title="更新" desc="桌面版打包后支持自动更新，更新包经过签名校验。" />
        <Card>
          <button
            onClick={() => void checkUpdate()}
            disabled={busy}
            data-act="check-update"
            className="rounded-lg border border-line bg-card px-3 py-2 text-[13px] text-fg-2 hover:bg-hover disabled:opacity-50"
          >
            {busy ? "检查中…" : "检查更新"}
          </button>
        </Card>
      </div>
    </div>
  );
}

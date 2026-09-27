import { SectionTitle, Card, TextField } from "./parts";
import { Check } from "lucide-react";
import {
  AVATAR_COLORS,
  DEFAULT_PROFILE,
  SETTINGS,
} from "../../lib/settings";

/* ------------------------------ 分区：个人资料 ------------------------------ */

export function ProfileSection({
  settings,
  saveSettings,
}: {
  settings: Record<string, string>;
  saveSettings: (patch: Record<string, string>) => Promise<void>;
}) {
  const name = settings[SETTINGS.profileName] ?? "";
  const email = settings[SETTINGS.profileEmail] ?? "";
  const color = settings[SETTINGS.profileColor] ?? DEFAULT_PROFILE.color;

  return (
    <div className="max-w-[520px]">
      <SectionTitle
        title="个人资料"
        desc="只保存在本机，不会上传到任何地方。侧边栏顶部会实时显示这里的内容。"
      />

      <Card>
        <div className="flex items-center gap-4">
          <span
            className="grid size-16 shrink-0 place-items-center rounded-full text-[24px] font-medium text-white"
            style={{ background: color }}
          >
            {name.trim()[0] ?? "?"}
          </span>
          <div className="min-w-0">
            <div className="truncate text-[14px] font-medium text-fg">
              {name.trim() || "未设置昵称"}
            </div>
            <div className="truncate text-[12px] text-fg-dim">
              {email.trim() || "未填写邮箱"}
            </div>
          </div>
        </div>

        <div className="mt-4 grid gap-3">
          <TextField
            label="昵称"
            value={name}
            placeholder="想让别人怎么称呼你"
            onCommit={(v) => void saveSettings({ [SETTINGS.profileName]: v })}
          />
          <TextField
            label="邮箱"
            value={email}
            placeholder="name@example.com"
            onCommit={(v) => void saveSettings({ [SETTINGS.profileEmail]: v })}
          />
        </div>

        <div className="mt-4">
          <div className="mb-1.5 text-[12px] text-fg-dim">头像颜色</div>
          <div className="flex gap-2">
            {AVATAR_COLORS.map((c) => (
              <button
                key={c}
                onClick={() => void saveSettings({ [SETTINGS.profileColor]: c })}
                title={c}
                className="grid size-7 place-items-center rounded-full transition-transform hover:scale-110"
                style={{ background: c }}
              >
                {color === c && <Check size={14} className="text-white" strokeWidth={3} />}
              </button>
            ))}
          </div>
        </div>
      </Card>
    </div>
  );
}

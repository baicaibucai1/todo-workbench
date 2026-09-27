/**
 * 设置页的通用零件。
 *
 * 抽出来只有一个理由：九个分区里每一个都要用到标题、卡片、开关这几件，
 * 各写一份的结果是「改一处圆角要改九遍」。它们**不带任何业务逻辑**，
 * 拿到的 props 就是全部输入 —— 想给某个分区定制样式，改那个分区，别改这里。
 */

import {
  useEffect,
  useState,
} from "react";

/** 分区操作完成后顶栏右角那句提示的取值 */
export interface Flash {
  tone: "ok" | "err";
  text: string;
}

export function SectionTitle({ title, desc }: { title: string; desc?: string }) {
  return (
    <div className="mb-2.5">
      <h2 className="text-[14px] font-medium text-fg">{title}</h2>
      {desc && <p className="mt-0.5 text-[12px] leading-relaxed text-fg-dim">{desc}</p>}
    </div>
  );
}

export function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-card px-4 py-3.5">{children}</div>
  );
}

export function FieldRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0 pt-1.5">
        <div className="text-[13px] text-fg-2">{label}</div>
        {hint && <div className="mt-0.5 text-[11.5px] leading-relaxed text-fg-dim">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function InfoCell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11.5px] text-fg-dim">{label}</div>
      <div className="mt-0.5 text-[13px] text-fg-2">{value}</div>
    </div>
  );
}

export function TextField({
  label,
  value,
  placeholder,
  onCommit,
  testId,
  type = "text",
  hint,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onCommit: (v: string) => void;
  testId?: string;
  type?: string;
  hint?: string;
}) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);

  return (
    <label className="block">
      <span className="mb-1 block text-[12px] text-fg-dim">{label}</span>
      <input
        value={v}
        type={type}
        placeholder={placeholder}
        data-field={testId}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => {
          if (v !== value) onCommit(v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setV(value);
            e.currentTarget.blur();
          }
        }}
        className="w-full rounded-lg border border-line bg-card px-3 py-2 text-[13px] text-fg-2 outline-none focus:border-primary"
      />
      {hint && <span className="mt-1 block text-[11.5px] leading-relaxed text-fg-dim">{hint}</span>}
    </label>
  );
}

export function Switch({ on, onToggle, testId }: { on: boolean; onToggle: () => void; testId?: string }) {
  return (
    <button
      onClick={onToggle}
      role="switch"
      aria-checked={on}
      data-switch={testId}
      className="relative h-[22px] w-[40px] rounded-full transition-colors"
      style={{ background: on ? "var(--color-primary)" : "var(--color-track-off)" }}
    >
      <span
        className="absolute top-[3px] size-4 rounded-full bg-card transition-all"
        style={{ left: on ? 21 : 3 }}
      />
    </button>
  );
}

export function ActionButton({
  icon,
  label,
  onClick,
  ...rest
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      onClick={onClick}
      {...rest}
      className="flex items-center gap-1.5 rounded-lg border border-line bg-card px-3 py-2 text-[13px] text-fg-2 hover:bg-hover"
    >
      {icon}
      {label}
    </button>
  );
}

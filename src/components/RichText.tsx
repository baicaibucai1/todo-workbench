import { useMemo } from "react";


/* ------------------------------------------------------------------ */
/* 极简 Markdown 渲染                                                  */
/* ------------------------------------------------------------------ */

/**
 * 只认四种东西：围栏代码块、标题、列表、**粗体** 与 `行内代码`。
 *
 * 为什么不上一个 Markdown 库：这里渲染的是**模型输出**，而完整的 Markdown
 * 允许内联 HTML —— 那意味着要引 sanitizer，而"给一个会读你本机文件的东西
 * 加一条 HTML 注入通道"这件事，收益（表格好看一点）和代价完全不成比例。
 * 这里全部走 React 元素，不碰 dangerouslySetInnerHTML。
 */
type Block = { kind: "code"; lang: string; body: string } | { kind: "text"; lines: string[] };

export function parseBlocks(text: string): Block[] {
  const out: Block[] = [];
  const re = /```([a-zA-Z0-9-]*)[ \t]*\n([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ kind: "text", lines: text.slice(last, m.index).split("\n") });
    out.push({ kind: "code", lang: m[1] ?? "", body: (m[2] ?? "").replace(/\n$/, "") });
    last = m.index + m[0].length;
  }
  // 未闭合的围栏留在正文里当普通文本 —— 宁可少美化一处，也不能把模型的话吞掉
  if (last < text.length) out.push({ kind: "text", lines: text.slice(last).split("\n") });
  return out.filter((b) => b.kind === "code" || b.lines.some((l) => l.trim()));
}

export function RichText({ text }: { text: string }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return (
    <div className="space-y-2 text-[13px] leading-relaxed text-fg-2">
      {blocks.map((b, i) =>
        b.kind === "code" ? (
          <pre
            key={i}
            className="max-h-[360px] overflow-auto rounded-lg bg-surface px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-fg-3"
          >
            {b.body}
          </pre>
        ) : (
          <TextBlock key={i} lines={b.lines} />
        ),
      )}
    </div>
  );
}

function TextBlock({ lines }: { lines: string[] }) {
  const out: React.ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const t = lines[i].trim();
    if (!t) {
      i++;
      continue;
    }

    const h = /^(#{1,4})\s+(.*)$/.exec(t);
    if (h) {
      out.push(
        <div key={k++} className="pt-0.5 font-medium text-fg">
          {inline(h[2])}
        </div>,
      );
      i++;
      continue;
    }

    if (/^\s*[-*•]\s+/.test(lines[i])) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*•]\s+/, ""));
        i++;
      }
      out.push(
        <ul key={k++} className="ml-4 list-disc space-y-0.5">
          {items.map((it, n) => (
            <li key={n}>{inline(it)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    if (/^\d+[.、)]\s+/.test(t)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+[.、)]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+[.、)]\s+/, ""));
        i++;
      }
      out.push(
        <ol key={k++} className="ml-4 list-decimal space-y-0.5">
          {items.map((it, n) => (
            <li key={n}>{inline(it)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,4})\s/.test(lines[i].trim()) &&
      !/^\s*[-*•]\s+/.test(lines[i]) &&
      !/^\d+[.、)]\s+/.test(lines[i].trim())
    ) {
      para.push(lines[i].trim());
      i++;
    }
    out.push(<p key={k++}>{inline(para.join(" "))}</p>);
  }
  return <>{out}</>;
}

/** 行内：**粗体** 与 `代码`。两个都只走 React 元素，不解析 HTML */
function inline(s: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const re = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) parts.push(s.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) {
      parts.push(
        <b key={k++} className="font-medium text-fg">
          {tok.slice(2, -2)}
        </b>,
      );
    } else {
      parts.push(
        <code key={k++} className="rounded bg-chip px-1 py-px font-mono text-[11.5px] text-fg-3">
          {tok.slice(1, -1)}
        </code>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < s.length) parts.push(s.slice(last));
  return parts;
}

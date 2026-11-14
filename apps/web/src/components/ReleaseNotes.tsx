import type { ReactNode } from "react";

/**
 * Release notes as GitHub writes them, drawn as plain React elements (never
 * as HTML): ### headings, "- " bullets, paragraphs, **bold**, `code` and
 * https links. Anything else shows as text.
 */

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g;
  let last = 0;
  let i = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${i++}`;
    if (m[1]) out.push(<strong key={k}>{m[1]}</strong>);
    else if (m[2])
      out.push(
        <code key={k} className="rounded bg-slate-100 px-1 text-[0.9em] dark:bg-slate-800">
          {m[2]}
        </code>,
      );
    else
      out.push(
        <a
          key={k}
          href={m[4]}
          target="_blank"
          rel="noreferrer"
          className="text-brand-600 underline"
        >
          {m[3]}
        </a>,
      );
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function ReleaseNotes({ notes }: { notes: string }) {
  const blocks: ReactNode[] = [];
  let bullets: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) {
      const k = `p${blocks.length}`;
      blocks.push(
        <p key={k} className="text-sm">
          {inline(para.join(" "), k)}
        </p>,
      );
      para = [];
    }
    if (bullets.length) {
      const k = `ul${blocks.length}`;
      blocks.push(
        <ul key={k} className="list-disc space-y-1 pl-5 text-sm">
          {bullets.map((b, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static text, never reordered
            <li key={`${k}-${i}`}>{inline(b, `${k}-${i}`)}</li>
          ))}
        </ul>,
      );
      bullets = [];
    }
  };
  for (const raw of notes.split("\n")) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (h) {
      flush();
      const k = `h${blocks.length}`;
      blocks.push(
        <h4 key={k} className="pt-1 text-sm font-semibold">
          {inline(h[1] ?? "", k)}
        </h4>,
      );
      continue;
    }
    const b = line.match(/^[-*]\s+(.*)$/);
    if (b) {
      if (para.length) flush();
      bullets.push(b[1] ?? "");
      continue;
    }
    if (bullets.length) flush();
    para.push(line);
  }
  flush();
  return <div className="space-y-2 text-slate-700 dark:text-slate-300">{blocks}</div>;
}

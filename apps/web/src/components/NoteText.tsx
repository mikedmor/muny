/** Plain text from Muny, laid out by its lines. */

const BULLET = /^\s*[-•*]\s+/;
const NEXT = /^next month:\s*/i;

/**
 * Text with lines, like a notification or a review, keeping its lines: "- " lines as a bulleted list (the
 * monthly review), anything else as its own line. Spans, since it sits in a button.
 */
export function NoteText({ text }: { text: string }) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2 && !BULLET.test(lines[0] ?? ""))
    return <span className="block text-sm text-slate-500">{text}</span>;
  return (
    <span className="mt-1 block space-y-1 text-sm text-slate-500">
      {lines.map((l, n) =>
        BULLET.test(l) ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: lines of fixed text, never reordered
          <span key={n} className="flex gap-2">
            <span aria-hidden="true" className="select-none text-slate-400">
              •
            </span>
            <span className="min-w-0">{l.replace(BULLET, "")}</span>
          </span>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: lines of fixed text, never reordered
          <span key={n} className="block pt-1">
            {NEXT.test(l) ? (
              <>
                <span className="font-medium text-slate-700 dark:text-slate-300">Next month:</span>{" "}
                {l.replace(NEXT, "")}
              </>
            ) : (
              l
            )}
          </span>
        ),
      )}
    </span>
  );
}

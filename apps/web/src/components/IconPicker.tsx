import { useEffect, useMemo, useState } from "react";
import { type Entry, loadEmoji, searchIcons } from "../lib/icons.js";
import { CATEGORY_ICON_CHOICES } from "./visuals.js";

/**
 * Pick a category icon by searching ~1,900 emoji by name, keyword or
 * shortcode ("robot", "water", ":car:"). The emoji list (emojibase, MIT) ships
 * with Muny and loads when the picker opens; nothing is fetched from the web.
 * Pasting an emoji works too.
 */

/** An emoji typed or pasted into the search box. */
const pasted = (s: string) => {
  const m = s.match(/\p{Extended_Pictographic}(️|‍\p{Extended_Pictographic}|\p{EMod})*/u);
  return m?.[0] ?? null;
};

export function IconPicker({
  value,
  automatic,
  onChange,
}: {
  value: string | null;
  /** The icon used when none is picked (guessed from the name). */
  automatic: string;
  onChange: (icon: string | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [all, setAll] = useState<Entry[] | null>(null);
  useEffect(() => {
    let live = true;
    void loadEmoji().then((e) => live && setAll(e));
    return () => {
      live = false;
    };
  }, []);
  const results = useMemo(() => (all ? searchIcons(all, query) : []), [all, query]);
  const direct = pasted(query);
  const labelOf = useMemo(() => new Map((all ?? []).map((e) => [e.emoji, e.label])), [all]);
  const shown: { emoji: string; label: string }[] = query.trim()
    ? [
        ...(direct ? [{ emoji: direct, label: labelOf.get(direct) ?? "pasted" }] : []),
        ...results.filter((r) => r.emoji !== direct),
      ]
    : CATEGORY_ICON_CHOICES.map((emoji) => ({ emoji, label: labelOf.get(emoji) ?? "" }));

  return (
    <fieldset>
      <legend className="text-sm font-medium text-slate-700 dark:text-slate-300">Icon</legend>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <span
          aria-hidden="true"
          className="flex size-10 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xl leading-none dark:bg-slate-800"
        >
          {value || automatic}
        </span>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              const first = shown[0];
              if (query.trim() && first) {
                onChange(first.emoji);
                setQuery("");
              }
            }
          }}
          placeholder="Search icons: robot, water, car…"
          aria-label="Search icons"
          className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950"
        />
        {value && (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="text-xs text-brand-600 hover:underline"
            title="Go back to the icon guessed from the name"
          >
            Automatic
          </button>
        )}
      </div>
      <p className="mt-1 text-xs text-slate-500">
        {query.trim()
          ? all
            ? `${shown.length === 0 ? "No icons match" : `${shown.length} match${shown.length === 1 ? "" : "es"}`} “${query.trim()}”. Enter picks the first.`
            : "Loading icons…"
          : "Suggestions below; search ~1,900 icons by name, or paste any emoji."}
      </p>
      <div className="mt-2 flex max-h-32 flex-wrap gap-1 overflow-y-auto">
        {shown.map((i) => (
          <button
            key={i.emoji}
            type="button"
            title={i.label}
            aria-label={`Use ${i.label || i.emoji}`}
            aria-pressed={value === i.emoji}
            onClick={() => {
              onChange(i.emoji);
              setQuery("");
            }}
            className={
              value === i.emoji
                ? "flex size-9 items-center justify-center rounded-lg bg-brand-100 text-xl leading-none ring-2 ring-brand-500 dark:bg-brand-700/40"
                : "flex size-9 items-center justify-center rounded-lg text-xl leading-none hover:bg-slate-100 dark:hover:bg-slate-800"
            }
          >
            {i.emoji}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

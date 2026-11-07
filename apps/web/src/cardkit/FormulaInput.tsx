import { ExprError, FUNCTIONS, type FunctionInfo, parseExpr } from "@muny/shared";
import { useId, useMemo, useRef, useState } from "react";
import { cx } from "../components/ui.js";

/** A name a formula can use, for suggestions. */
export interface FormulaName {
  /** What gets inserted. */
  insert: string;
  label: string;
  detail?: string;
}

interface Suggestion extends FormulaName {
  from: number;
  fn?: FunctionInfo;
}

function parseError(text: string, optional: boolean): string | null {
  if (!text.trim()) return optional ? null : "Type a formula.";
  try {
    parseExpr(text);
    return null;
  } catch (e) {
    return e instanceof ExprError ? e.message : "That can't be read.";
  }
}

/** A formula, checked as you type, suggesting fields, named values and functions. */
export function FormulaInput({
  value,
  onChange,
  names,
  label,
  placeholder,
  rows = 2,
  optional = false,
}: {
  value: string;
  onChange: (v: string) => void;
  names: FormulaName[];
  label: string;
  placeholder?: string;
  rows?: number;
  /** Leaving it empty is fine. */
  optional?: boolean;
}) {
  const [caret, setCaret] = useState(0);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const area = useRef<HTMLTextAreaElement>(null);
  const id = useId();

  const suggestions = useMemo<Suggestion[]>(() => {
    if (!open) return [];
    const before = value.slice(0, caret);
    // Inside [brackets], only fields make sense.
    const bracket = /\[([^\]]*)$/.exec(before);
    if (bracket) {
      const q = (bracket[1] ?? "").toLowerCase();
      return names
        .filter((n) => n.insert.startsWith("[") && n.label.toLowerCase().includes(q))
        .slice(0, 12)
        .map((n) => ({ ...n, from: before.length - (bracket[0]?.length ?? 0) }));
    }
    const word = /[$A-Za-z_][A-Za-z0-9_]*$/.exec(before);
    if (!word) return [];
    const q = word[0].toLowerCase();
    const from = before.length - word[0].length;
    const own = names.filter(
      (n) =>
        n.insert.toLowerCase().replace(/^\[/, "").startsWith(q.replace(/^\$/, "")) ||
        n.label.toLowerCase().startsWith(q) ||
        n.insert.toLowerCase().startsWith(q),
    );
    const fns: Suggestion[] = q.startsWith("$")
      ? []
      : FUNCTIONS.filter((f) => f.name.startsWith(q)).map((f) => ({
          insert: `${f.name}(`,
          label: f.usage,
          detail: f.description,
          from,
          fn: f,
        }));
    return [...own.map((n) => ({ ...n, from })), ...fns].slice(0, 12);
  }, [open, value, caret, names]);

  const accept = (s: Suggestion) => {
    const next = `${value.slice(0, s.from)}${s.insert}${value.slice(caret)}`;
    onChange(next);
    const at = s.from + s.insert.length;
    setCaret(at);
    setOpen(false);
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(at, at);
    });
  };

  const error = parseError(value, optional);
  const showing = suggestions.length > 0;

  return (
    <div className="relative">
      <label
        htmlFor={id}
        className="mb-0.5 block text-xs font-medium text-slate-600 dark:text-slate-400"
      >
        {label}
      </label>
      <textarea
        ref={area}
        id={id}
        rows={rows}
        value={value}
        spellCheck={false}
        placeholder={placeholder}
        aria-invalid={!!error}
        aria-describedby={`${id}-state`}
        onChange={(e) => {
          onChange(e.target.value);
          setCaret(e.target.selectionStart);
          setActive(0);
          setOpen(true);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (!showing) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => (a + 1) % suggestions.length);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => (a - 1 + suggestions.length) % suggestions.length);
          } else if (e.key === "Enter" || e.key === "Tab") {
            const s = suggestions[active];
            if (s) {
              e.preventDefault();
              accept(s);
            }
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
        className={cx(
          "block w-full rounded-lg border bg-surface px-2 py-1.5 font-mono text-xs outline-none focus:ring-2 focus:ring-brand-500/30 dark:bg-slate-950",
          error ? "border-red-400 dark:border-red-700" : "border-slate-300 dark:border-slate-700",
        )}
      />
      {showing && (
        <ul className="absolute z-30 mt-1 max-h-56 w-full overflow-auto rounded-lg border border-slate-200 bg-surface py-1 text-xs shadow-lg dark:border-slate-700 dark:bg-slate-900">
          {suggestions.map((s, i) => (
            <li key={`${s.insert}-${s.label}`}>
              <button
                type="button"
                onPointerDown={(e) => {
                  e.preventDefault();
                  accept(s);
                }}
                className={cx(
                  "block w-full px-2 py-1 text-left hover:bg-slate-100 dark:hover:bg-slate-800",
                  i === active && "bg-slate-100 dark:bg-slate-800",
                )}
              >
                <span className="font-mono">{s.label}</span>
                {s.detail && <span className="block truncate text-slate-500">{s.detail}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      <p
        id={`${id}-state`}
        className={cx(
          "mt-0.5 text-[11px]",
          error ? "text-red-600 dark:text-red-400" : "text-slate-500",
        )}
      >
        {error ?? (value.trim() ? "Looks good." : "")}
      </p>
    </div>
  );
}

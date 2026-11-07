import { type StatementKind, TEMPLATE_FIELDS, type TemplateFieldType } from "@muny/shared";
import { type FormEvent, useState } from "react";
import { api } from "../lib/api.js";
import { Modal } from "./forms.js";
import { Alert, Button, Field } from "./ui.js";

/**
 * Teach Muny a statement layout: for each field, pick the line it's on; the
 * text before the value becomes the label Muny looks for. Saved as a template
 * for every statement containing the match text.
 */

const FIND: Record<TemplateFieldType, RegExp> = {
  money: /-?\$?\s?\d[\d,]*\.\d{2}/,
  date: /\d{1,2}\/\d{1,2}\/\d{2,4}|[A-Z][a-z]{2,8}\.? \d{1,2},? \d{4}/,
  percent: /\d{1,2}(?:\.\d{1,4})?\s?%/,
};

/** The label for a value on a line: the words just before it. */
function labelFrom(line: string, type: TemplateFieldType) {
  const m = FIND[type].exec(line);
  if (!m) return "";
  return line
    .slice(0, m.index)
    .replace(/[:\s]+$/, "")
    .trim()
    .slice(-60);
}

/** A sensible match text: a web address or the first line with letters. */
function suggestMatch(lines: string[]) {
  for (const l of lines) {
    const m = /\b(?:www\.)?[a-z0-9-]+\.(?:com|net|org|bank)\b/i.exec(l);
    if (m) return m[0];
  }
  return lines.find((l) => /[A-Za-z]{4}/.test(l))?.slice(0, 40) ?? "";
}

function Teach({
  kind,
  lines,
  onDone,
}: {
  kind: StatementKind;
  lines: string[];
  onDone: (saved: boolean) => void;
}) {
  const [name, setName] = useState("");
  const [match, setMatch] = useState(() => suggestMatch(lines));
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const fields = TEMPLATE_FIELDS[kind];
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const chosen = Object.fromEntries(
      Object.entries(labels)
        .filter(([, l]) => l.trim())
        .map(([k, l]) => [k, { label: l.trim() }]),
    );
    if (!Object.keys(chosen).length) return setError("Pick the line for at least one field.");
    try {
      await api.post("/api/statement-templates", {
        kind,
        name: name.trim() || match.trim() || "My statements",
        matchText: match.trim(),
        fields: chosen,
      });
      onDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save");
    }
  };
  return (
    <form onSubmit={save} className="space-y-4" noValidate>
      {error && <Alert>{error}</Alert>}
      <p className="text-sm text-slate-600 dark:text-slate-400">
        For each field, pick the line of this statement it's on. Muny remembers the words just
        before the value and reads them from every statement that contains the text below.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Statements that contain"
          value={match}
          onChange={(e) => setMatch(e.target.value)}
          hint="Text on every one of these statements, like the bank's web address."
        />
        <Field
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Central Bank card"
        />
      </div>
      <div className="space-y-3">
        {fields.map((f) => {
          const candidates = lines.filter((l) => FIND[f.type].test(l));
          return (
            <div
              key={f.key}
              className="grid gap-2 sm:grid-cols-[12rem_minmax(0,1fr)_minmax(0,14rem)]"
            >
              <span className="pt-2 text-sm font-medium">{f.label}</span>
              <select
                aria-label={`Line with the ${f.label.toLowerCase()}`}
                value=""
                onChange={(e) =>
                  e.target.value &&
                  setLabels((x) => ({ ...x, [f.key]: labelFrom(e.target.value, f.type) }))
                }
                className="min-w-0 rounded-lg border border-slate-300 bg-surface px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-950"
              >
                <option value="">
                  {candidates.length ? "Pick the line…" : "No line with this kind of value"}
                </option>
                {candidates.slice(0, 200).map((l, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: lines can repeat
                  <option key={i} value={l}>
                    {l.slice(0, 110)}
                  </option>
                ))}
              </select>
              <input
                aria-label={`${f.label}: label text`}
                value={labels[f.key] ?? ""}
                onChange={(e) => setLabels((x) => ({ ...x, [f.key]: e.target.value }))}
                placeholder="Label text"
                className="rounded-lg border border-slate-300 bg-surface px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950"
              />
            </div>
          );
        })}
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={() => onDone(false)}>
          Cancel
        </Button>
        <Button type="submit">Save and read again</Button>
      </div>
    </form>
  );
}

/** A "Teach Muny" button for a statement that didn't read fully. */
export function TeachButton({
  kind,
  lines,
  onSaved,
}: {
  kind: StatementKind;
  lines: string[];
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs text-brand-600 hover:underline dark:text-brand-500"
      >
        Teach Muny
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="Teach Muny this statement" wide>
        {open && (
          <Teach
            kind={kind}
            lines={lines}
            onDone={(saved) => {
              setOpen(false);
              if (saved) onSaved();
            }}
          />
        )}
      </Modal>
    </>
  );
}

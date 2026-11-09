import type { UndoPreview } from "@muny/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Redo2, Undo2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { announceChange, latestChange, type MadeChange, onChange, undo } from "../lib/changes.js";
import { Modal } from "./forms.js";
import { Alert, Button } from "./ui.js";

/**
 * Undo anywhere: after a change, "Changed transaction “Corner Cafe”  Undo"
 * at the bottom of the page (Ctrl+Z works too, outside text fields). Undoing
 * shows "Redo". When something changed since, or more would go than the
 * change itself touched, it asks first.
 */

/** Look before undoing: what would happen, what changed since. */
export function UndoDialog({
  id,
  preview,
  onClose,
  onDone,
}: {
  id: string;
  preview: UndoPreview;
  onClose: () => void;
  onDone: (c: MadeChange) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(preview.error);
  const go = async () => {
    setBusy(true);
    const r = await undo(id, true);
    setBusy(false);
    if (r.done) onDone({ id: r.result.id, title: r.result.title, isUndo: true });
    else setError("error" in r ? r.error : "That couldn't be undone.");
  };
  return (
    <Modal open onClose={onClose} title={`Undo “${preview.title}”?`}>
      <div className="space-y-4 text-sm">
        {preview.effects.length > 0 && (
          <div>
            <p className="font-medium">Undoing will:</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-slate-600 dark:text-slate-300">
              {preview.effects.map((e) => (
                <li key={e}>{e[0]?.toUpperCase() + e.slice(1)}</li>
              ))}
            </ul>
            {preview.extra && (
              <p className="mt-2 text-amber-700 dark:text-amber-400">
                That's more than the change itself touched: things added to it since go too.
              </p>
            )}
          </div>
        )}
        {preview.conflictCount > 0 && (
          <div>
            <p className="font-medium">Changed since, and would be put back anyway:</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-slate-600 dark:text-slate-300">
              {preview.conflicts.map((c) => (
                <li key={c}>{c}</li>
              ))}
              {preview.conflictCount > preview.conflicts.length && (
                <li>and {preview.conflictCount - preview.conflicts.length} more</li>
              )}
            </ul>
          </div>
        )}
        {error && <Alert>{error}</Alert>}
        <p className="text-xs text-slate-500">
          You can redo it afterwards from Settings → History.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          {!preview.error && (
            <Button disabled={busy} onClick={() => void go()}>
              Undo
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** Undo a change from anywhere: straight away, or after a look when it needs one. */
export function useUndo() {
  const qc = useQueryClient();
  const [asking, setAsking] = useState<{ id: string; preview: UndoPreview } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const done = useCallback(
    (c: MadeChange) => {
      setAsking(null);
      announceChange(c);
      void qc.invalidateQueries();
    },
    [qc],
  );
  const run = useCallback(
    async (id: string) => {
      setError(null);
      const r = await undo(id);
      if (r.done) done({ id: r.result.id, title: r.result.title, isUndo: true });
      else if ("preview" in r) setAsking({ id, preview: r.preview });
      else setError(r.error);
    },
    [done],
  );
  const dialog = asking ? (
    <UndoDialog
      id={asking.id}
      preview={asking.preview}
      onClose={() => setAsking(null)}
      onDone={done}
    />
  ) : null;
  return { run, dialog, error, clearError: () => setError(null) };
}

const typing = (t: EventTarget | null) =>
  t instanceof HTMLElement &&
  (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));

/** The bar at the bottom after a change, and Ctrl+Z. Once, in the app shell. */
export function UndoBar() {
  const [shown, setShown] = useState<MadeChange | null>(null);
  const { run, dialog, error, clearError } = useUndo();

  useEffect(() => onChange((c) => setShown(c)), []);
  useEffect(() => {
    if (!shown) return;
    const t = setTimeout(() => setShown(null), 8000);
    return () => clearTimeout(t);
  }, [shown]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "z" || e.altKey) return;
      if (typing(e.target) || document.querySelector("dialog[open]")) return;
      const c = latestChange();
      if (!c) return;
      e.preventDefault();
      setShown(null);
      void run(c.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [run]);

  return (
    <>
      {dialog}
      {(shown || error) && (
        <div
          role="status"
          className="fixed bottom-4 left-1/2 z-50 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-xl bg-slate-900 py-2 pr-2 pl-4 text-sm text-white shadow-lg dark:bg-slate-100 dark:text-slate-900"
        >
          <span className="min-w-0 truncate">{error ?? shown?.title}</span>
          {shown && !error && (
            <button
              type="button"
              onClick={() => {
                const id = shown.id;
                setShown(null);
                void run(id);
              }}
              className="inline-flex shrink-0 items-center gap-1 rounded-full px-3 py-1 font-medium text-brand-300 hover:bg-white/10 dark:text-brand-700 dark:hover:bg-slate-900/10"
            >
              {shown.isUndo ? (
                <Redo2 aria-hidden="true" className="size-4" />
              ) : (
                <Undo2 aria-hidden="true" className="size-4" />
              )}
              {shown.isUndo ? "Redo" : "Undo"}
            </button>
          )}
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => {
              setShown(null);
              clearError();
            }}
            className="shrink-0 rounded-full p-1 hover:bg-white/10 dark:hover:bg-slate-900/10"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        </div>
      )}
    </>
  );
}

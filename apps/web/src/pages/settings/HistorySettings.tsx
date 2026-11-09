import type { ChangeItem, ChangeList, UndoPreview } from "@muny/shared";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Redo2, Undo2 } from "lucide-react";
import { useState } from "react";
import { UndoDialog, useUndo } from "../../components/Undo.js";
import { Alert, Button, Card, cx } from "../../components/ui.js";
import { api } from "../../lib/api.js";
import { useAuthStatus } from "../../lib/auth.js";
import { announceChange } from "../../lib/changes.js";

/** Every change from the last 60 days, by you, your household or an assistant, and a way back. */
export function HistorySettings() {
  const qc = useQueryClient();
  const owner = useAuthStatus().data?.user?.role === "owner";
  const q = useInfiniteQuery({
    queryKey: ["changes"],
    queryFn: ({ pageParam }) =>
      api.get<ChangeList>(`/api/changes${pageParam ? `?before=${pageParam}` : ""}`),
    initialPageParam: 0,
    getNextPageParam: (last) => last.next ?? undefined,
  });
  const { run, dialog, error } = useUndo();
  const [looking, setLooking] = useState<{ id: string; preview: UndoPreview } | null>(null);
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  // Which change undid which, to offer Redo on the undo.
  const undoOf = new Map(items.filter((i) => i.undoOf).map((i) => [i.undoOf as string, i]));

  const look = async (id: string) => {
    setLooking({ id, preview: await api.get<UndoPreview>(`/api/changes/${id}/preview`) });
  };
  const clear = async () => {
    if (
      !window.confirm(
        "Forget the whole history? Nothing in Muny changes, but nothing here can be undone afterwards.",
      )
    )
      return;
    await api.delete("/api/changes");
    void qc.invalidateQueries({ queryKey: ["changes"] });
  };

  return (
    <section className="max-w-3xl space-y-4">
      <Card className="space-y-1 text-sm text-slate-600 dark:text-slate-300">
        <p>
          Every change made in Muny over the last 60 days, by anyone in your household or an
          assistant, with a way to undo it. Undoing puts back exactly what that change touched, and
          is a change itself, so it can be redone. Right after a change, <strong>Undo</strong> also
          appears at the bottom of the page, and <kbd>Ctrl</kbd>+<kbd>Z</kbd> works outside text
          fields.
        </p>
        <p className="text-xs text-slate-500">
          Passwords and sign-ins aren't kept here, and can't be undone. Things you remove stay in
          the history until it's 60 days old.
        </p>
      </Card>
      {(error || q.isError) && <Alert>{error ?? "Couldn't load the history."}</Alert>}
      {dialog}
      {looking && (
        <UndoDialog
          id={looking.id}
          preview={looking.preview}
          onClose={() => setLooking(null)}
          onDone={(c) => {
            setLooking(null);
            announceChange(c);
            void qc.invalidateQueries();
          }}
        />
      )}
      <Card className="p-0">
        {q.isPending ? (
          <p className="p-4 text-sm text-slate-500">Loading…</p>
        ) : items.length === 0 ? (
          <p className="p-4 text-sm text-slate-500">No changes yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {items.map((c) => (
              <Row
                key={c.id}
                c={c}
                onUndo={() => void look(c.id)}
                onRedo={() => {
                  const u = undoOf.get(c.id);
                  if (u) void run(u.id);
                }}
                canRedo={c.undone && undoOf.has(c.id)}
              />
            ))}
          </ul>
        )}
        {q.hasNextPage && (
          <div className="border-t border-slate-100 p-3 text-center dark:border-slate-800">
            <Button
              variant="ghost"
              disabled={q.isFetchingNextPage}
              onClick={() => void q.fetchNextPage()}
            >
              Show older
            </Button>
          </div>
        )}
      </Card>
      {owner && items.length > 0 && (
        <div className="text-right">
          <Button variant="ghost" className="text-red-600" onClick={() => void clear()}>
            Forget history
          </Button>
        </div>
      )}
    </section>
  );
}

function Row({
  c,
  onUndo,
  onRedo,
  canRedo,
}: {
  c: ChangeItem;
  onUndo: () => void;
  onRedo: () => void;
  canRedo: boolean;
}) {
  const at = new Date(c.at);
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <span className="min-w-0 flex-1">
        <span
          className={cx("block text-sm font-medium", c.undone && "text-slate-500 line-through")}
        >
          {c.title}
        </span>
        <span className="block text-xs text-slate-500">
          {c.actor.type === "agent" && <Bot aria-hidden="true" className="mr-1 inline size-3.5" />}
          {c.actor.name ?? (c.actor.type === "agent" ? "An assistant" : "Muny")} ·{" "}
          {at.toLocaleDateString(undefined, { month: "short", day: "numeric" })}{" "}
          {at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
          {c.parts.length > 0 && ` · ${c.parts.join(", ")}`}
          {c.undone && " · Undone"}
        </span>
      </span>
      {c.undone ? (
        canRedo && (
          <Button variant="secondary" onClick={onRedo} className="shrink-0">
            <Redo2 aria-hidden="true" className="size-4" /> Redo
          </Button>
        )
      ) : (
        <Button variant="secondary" onClick={onUndo} className="shrink-0">
          <Undo2 aria-hidden="true" className="size-4" /> Undo
        </Button>
      )}
    </li>
  );
}

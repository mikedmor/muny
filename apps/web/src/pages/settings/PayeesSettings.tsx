import type { PayeeSummary } from "@muny/shared";
import { useMemo, useState } from "react";
import { Alert, Button, Card } from "../../components/ui.js";
import {
  useDeletePayee,
  usePayeeCleanup,
  usePayeeCleanupPreview,
  usePayees,
  useRenamePayee,
} from "../../lib/queries.js";

function CleanupCard() {
  const [show, setShow] = useState(false);
  const preview = usePayeeCleanupPreview(show);
  const cleanup = usePayeeCleanup();
  const p = preview.data;

  return (
    <Card className="space-y-3">
      <div>
        <h3 className="font-semibold">Clean up merchant names</h3>
        <p className="text-sm text-slate-500">
          New imports get a tidy merchant name automatically (for example "SQ *CORNER CAFE 0123
          AUSTIN TX" becomes "Corner Cafe"). This fills in the ones that don't have one yet. It
          never changes names you set.
        </p>
      </div>
      {cleanup.data ? (
        <p className="text-sm">
          Done: {cleanup.data.updated.toLocaleString()} transactions now have a merchant name.
        </p>
      ) : !show ? (
        <Button variant="secondary" onClick={() => setShow(true)}>
          Preview cleanup
        </Button>
      ) : preview.isPending ? (
        <p className="text-sm text-slate-500">Looking…</p>
      ) : preview.isError ? (
        <Alert>{preview.error.message}</Alert>
      ) : p && p.transactions === 0 ? (
        <p className="text-sm">Every transaction already has a merchant name.</p>
      ) : (
        p && (
          <>
            <p className="text-sm">
              <strong>{p.transactions.toLocaleString()}</strong> transactions would get one of{" "}
              <strong>{p.payees.toLocaleString()}</strong> merchant names. The most common:
            </p>
            <div className="max-h-72 overflow-auto rounded-lg border border-slate-200 dark:border-slate-800">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-slate-50 text-left text-slate-500 dark:bg-slate-800">
                  <tr>
                    <th className="px-2 py-1 font-medium">Bank description (example)</th>
                    <th className="px-2 py-1 font-medium">Merchant</th>
                    <th className="px-2 py-1 text-right font-medium">Transactions</th>
                  </tr>
                </thead>
                <tbody>
                  {p.sample.map((s) => (
                    <tr key={s.cleaned} className="border-t border-slate-100 dark:border-slate-800">
                      <td className="max-w-64 truncate px-2 py-1 text-slate-500" title={s.raw}>
                        {s.raw}
                      </td>
                      <td className="px-2 py-1 font-medium">{s.cleaned}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{s.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-slate-500">
              You can rename or merge any of these below afterwards.
            </p>
            {cleanup.error && <Alert>{cleanup.error.message}</Alert>}
            <div className="flex gap-2">
              <Button disabled={cleanup.isPending} onClick={() => cleanup.mutate()}>
                {cleanup.isPending ? "Applying…" : "Apply cleanup"}
              </Button>
              <Button variant="ghost" onClick={() => setShow(false)}>
                Cancel
              </Button>
            </div>
          </>
        )
      )}
    </Card>
  );
}

function PayeeRow({ payee }: { payee: PayeeSummary }) {
  const rename = useRenamePayee();
  const del = useDeletePayee();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(payee.displayName);

  const commit = () => {
    setEditing(false);
    const v = text.trim();
    if (v && v !== payee.displayName) rename.mutate({ id: payee.id, displayName: v });
  };

  return (
    <li className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
      {editing ? (
        <input
          // biome-ignore lint/a11y/noAutofocus: inline rename should focus immediately
          autoFocus
          aria-label="Merchant name"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setEditing(false);
          }}
          className="w-full rounded border border-brand-500 bg-surface px-2 py-0.5 outline-none dark:bg-slate-950"
        />
      ) : (
        <button
          type="button"
          title="Rename (use an existing name to merge)"
          onClick={() => {
            setText(payee.displayName);
            setEditing(true);
          }}
          className="truncate text-left hover:underline"
        >
          {payee.displayName}
        </button>
      )}
      <div className="flex shrink-0 items-center gap-3 text-xs text-slate-500">
        <span className="tabular-nums">{payee.transactionCount.toLocaleString()}</span>
        <button
          type="button"
          onClick={() => del.mutate(payee.id)}
          className="text-red-600 hover:underline"
          title="Transactions go back to showing the bank description"
        >
          Delete
        </button>
      </div>
      {rename.data?.merged && <span className="sr-only">Merged</span>}
    </li>
  );
}

export function PayeesSettings() {
  const payees = usePayees();
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (payees.data ?? []).filter(
      (p) => !needle || p.displayName.toLowerCase().includes(needle),
    );
  }, [payees.data, q]);

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Merchants</h2>
        <p className="text-sm text-slate-500">
          Click a name to rename it. Renaming to a name that already exists merges the two.
        </p>
      </div>
      <CleanupCard />
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={`Search ${payees.data?.length ?? ""} merchants`}
        aria-label="Search merchants"
        className="w-full max-w-md rounded-lg border border-slate-300 bg-surface px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
      />
      {payees.isError && <Alert>Couldn't load merchants.</Alert>}
      <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-surface dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
        {filtered.slice(0, 300).map((p) => (
          <PayeeRow key={p.id} payee={p} />
        ))}
        {filtered.length === 0 && payees.isSuccess && (
          <li className="px-4 py-3 text-sm text-slate-500">No merchants found.</li>
        )}
      </ul>
      {filtered.length > 300 && (
        <p className="text-xs text-slate-500">
          Showing 300 of {filtered.length}. Search to narrow down.
        </p>
      )}
    </section>
  );
}

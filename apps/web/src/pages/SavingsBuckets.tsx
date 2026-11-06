import { formatMoney, type SavingsBucketInput, type SavingsBuckets } from "@muny/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Modal } from "../components/forms.js";
import { Alert, Button } from "../components/ui.js";
import { api } from "../lib/api.js";

/**
 * Categories inside one savings account (e.g. "Vacation"): the
 * bank reports one balance, so you enter each category's balance once and
 * Muny follows the moves it reports for that name.
 */

const fromCents = (c: number | null | undefined) => (c == null ? "" : (c / 100).toFixed(2));
const toCents = (s: string) => {
  const v = s.trim().replace(/[$,]/g, "");
  if (!v) return null;
  if (!/^-?\d+(\.\d{1,2})?$/.test(v)) return Number.NaN;
  const neg = v.startsWith("-");
  const [w = "0", f = ""] = v.replace("-", "").split(".");
  const c = Number(w) * 100 + Number(f.padEnd(2, "0"));
  return neg ? -c : c;
};

interface Row {
  key: string;
  id?: string;
  name: string;
  balance: string;
  goal: string;
}
let seq = 0;

function BucketsForm({
  accountId,
  data,
  onDone,
}: {
  accountId: string;
  data: SavingsBuckets;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [rows, setRows] = useState<Row[]>(() => [
    ...data.buckets.map((b) => ({
      key: b.id,
      id: b.id,
      name: b.name,
      balance: fromCents(b.balanceCents),
      goal: fromCents(b.goalCents),
    })),
    ...(data.buckets.length
      ? []
      : data.suggestions.map((n) => ({ key: `s${++seq}`, name: n, balance: "", goal: "" }))),
  ]);
  const [error, setError] = useState<string | null>(null);
  const set = (key: string, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const out: SavingsBucketInput[] = [];
    for (const r of rows) {
      if (!r.name.trim()) continue;
      const balance = toCents(r.balance);
      const goal = toCents(r.goal);
      if (balance === null || Number.isNaN(balance) || Number.isNaN(goal))
        return setError(`Enter what "${r.name}" holds now, like 1234.56.`);
      out.push({ id: r.id, name: r.name.trim(), balanceCents: balance, goalCents: goal });
    }
    try {
      await api.put(`/api/savings/accounts/${accountId}/buckets`, { buckets: out });
      await qc.invalidateQueries({ queryKey: ["savings-buckets", accountId] });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save");
    }
  };
  const unused = data.suggestions.filter(
    (n) => !rows.some((r) => r.name.trim().toLowerCase() === n.toLowerCase()),
  );
  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      {error && <Alert>{error}</Alert>}
      <p className="text-sm text-slate-600 dark:text-slate-400">
        Your bank reports this account as one balance. Enter what each category holds now (from your
        bank's app); Muny follows the moves it reports for each name from today, and shows the rest
        as unassigned.
      </p>
      <div className="space-y-2">
        {rows.map((r, i) => (
          <div
            key={r.key}
            className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-2"
          >
            <label className="block text-xs">
              {i === 0 && <span className="text-slate-500">Category</span>}
              <input
                aria-label="Category name"
                value={r.name}
                onChange={(e) => set(r.key, { name: e.target.value })}
                className="mt-0.5 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950"
              />
            </label>
            <label className="block text-xs">
              {i === 0 && <span className="text-slate-500">Holds now</span>}
              <input
                aria-label={`${r.name || "Category"}: holds now`}
                inputMode="decimal"
                value={r.balance}
                onChange={(e) => set(r.key, { balance: e.target.value })}
                placeholder="0.00"
                className="mt-0.5 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm tabular-nums dark:border-slate-700 dark:bg-slate-950"
              />
            </label>
            <label className="block text-xs">
              {i === 0 && <span className="text-slate-500">Goal (optional)</span>}
              <input
                aria-label={`${r.name || "Category"}: goal`}
                inputMode="decimal"
                value={r.goal}
                onChange={(e) => set(r.key, { goal: e.target.value })}
                className="mt-0.5 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm tabular-nums dark:border-slate-700 dark:bg-slate-950"
              />
            </label>
            <button
              type="button"
              aria-label={`Remove ${r.name || "category"}`}
              onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
              className="mb-2 text-slate-400 hover:text-red-600"
            >
              <Trash2 aria-hidden="true" className="size-4" />
            </button>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <button
          type="button"
          onClick={() =>
            setRows((rs) => [...rs, { key: `n${++seq}`, name: "", balance: "", goal: "" }])
          }
          className="inline-flex items-center gap-1 text-brand-600 hover:underline dark:text-brand-500"
        >
          <Plus aria-hidden="true" className="size-4" /> Add a category
        </button>
        {unused.map((n) => (
          <button
            key={n}
            type="button"
            onClick={() =>
              setRows((rs) => [...rs, { key: `s${++seq}`, name: n, balance: "", goal: "" }])
            }
            className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs hover:bg-slate-200 dark:bg-slate-800"
          >
            + {n}
          </button>
        ))}
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit">Save</Button>
      </div>
    </form>
  );
}

export function SavingsBucketsSection({ accountId }: { accountId: string }) {
  const q = useQuery({
    queryKey: ["savings-buckets", accountId],
    queryFn: () => api.get<SavingsBuckets>(`/api/savings/accounts/${accountId}/buckets`),
  });
  const [editing, setEditing] = useState(false);
  const d = q.data;
  if (!d) return null;
  const modal = (
    <Modal open={editing} onClose={() => setEditing(false)} title="Categories in this account">
      {editing && <BucketsForm accountId={accountId} data={d} onDone={() => setEditing(false)} />}
    </Modal>
  );
  if (!d.buckets.length)
    return d.suggestions.length ? (
      <div className="mt-4 rounded-xl bg-slate-50 px-4 py-3 text-sm dark:bg-slate-800/40">
        This account has categories ({d.suggestions.join(", ")}).{" "}
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="text-brand-600 hover:underline dark:text-brand-500"
        >
          Show what each holds
        </button>
        {modal}
      </div>
    ) : null;
  return (
    <div className="mt-4 rounded-xl border border-slate-200 p-4 dark:border-slate-800">
      <div className="mb-2 flex items-baseline justify-between">
        <p className="text-sm font-semibold">Categories</p>
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="inline-flex items-center gap-1 text-xs text-brand-600 hover:underline dark:text-brand-500"
        >
          <Pencil aria-hidden="true" className="size-3" /> Edit
        </button>
      </div>
      <ul className="space-y-2 text-sm">
        {d.buckets.map((b) => {
          const pct = b.goalCents ? Math.min(100, (b.balanceCents / b.goalCents) * 100) : null;
          return (
            <li key={b.id}>
              <span className="flex justify-between gap-3">
                <span>{b.name}</span>
                <span className="tabular-nums">
                  {formatMoney(b.balanceCents)}
                  {b.goalCents ? (
                    <span className="text-xs text-slate-500"> of {formatMoney(b.goalCents)}</span>
                  ) : null}
                </span>
              </span>
              {pct !== null && (
                <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
                  <span
                    className="block h-full rounded-full bg-emerald-500"
                    style={{ width: `${pct}%` }}
                  />
                </span>
              )}
            </li>
          );
        })}
        <li className="flex justify-between gap-3 border-t border-slate-100 pt-2 text-slate-500 dark:border-slate-800">
          <span>Unassigned</span>
          <span className="tabular-nums">{formatMoney(d.unassignedCents)}</span>
        </li>
      </ul>
      {d.suggestions.length > 0 && (
        <p className="mt-2 text-xs text-slate-500">
          Also seen: {d.suggestions.join(", ")} (Edit to add).
        </p>
      )}
      {modal}
    </div>
  );
}

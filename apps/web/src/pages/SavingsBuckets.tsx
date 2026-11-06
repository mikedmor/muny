import { formatMoney, type SavingsBucketInput, type SavingsBuckets } from "@muny/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Modal } from "../components/forms.js";
import { Alert, Button, cx } from "../components/ui.js";
import { api } from "../lib/api.js";

/**
 * Categories inside one savings account, the way some banks set them up:
 * the account's own cash keeps a target (e.g. $1,000); extra cash goes to
 * the categories in order, each toward a goal and at most so much a month,
 * and the last can take whatever remains. The bank reports one balance, so
 * you enter what each category holds once and Muny follows its moves.
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
const whole = (c: number) => (c % 100 === 0 ? `$${(c / 100).toLocaleString()}` : formatMoney(c));
const monthName = (ym: string) =>
  new Date(`${ym}-01T00:00:00`).toLocaleDateString(undefined, { month: "short", year: "numeric" });

interface Row {
  key: string;
  id?: string;
  name: string;
  balance: string;
  goal: string;
  cap: string;
  rest: boolean;
  isMain: boolean;
}
let seq = 0;
const input =
  "mt-0.5 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm tabular-nums dark:border-slate-700 dark:bg-slate-950";

function BucketsForm({
  accountId,
  accountName,
  data,
  onDone,
}: {
  accountId: string;
  accountName: string;
  data: SavingsBuckets;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const existingMain = data.buckets.find((b) => b.isMain);
  const [rows, setRows] = useState<Row[]>(() => [
    {
      key: existingMain?.id ?? "main",
      id: existingMain?.id,
      name: existingMain?.name ?? accountName,
      balance: "",
      goal: fromCents(existingMain?.goalCents),
      cap: "",
      rest: false,
      isMain: true,
    },
    ...data.buckets
      .filter((b) => !b.isMain)
      .map((b) => ({
        key: b.id,
        id: b.id,
        name: b.name,
        balance: fromCents(b.balanceCents),
        goal: fromCents(b.goalCents),
        cap: fromCents(b.monthlyCapCents),
        rest: b.fillRemaining,
        isMain: false,
      })),
    ...(data.buckets.some((b) => !b.isMain)
      ? []
      : data.suggestions.map((n) => ({
          key: `s${++seq}`,
          name: n,
          balance: "",
          goal: "",
          cap: "",
          rest: false,
          isMain: false,
        }))),
  ]);
  const [error, setError] = useState<string | null>(null);
  const set = (key: string, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const move = (key: string, by: number) =>
    setRows((rs) => {
      const i = rs.findIndex((r) => r.key === key);
      const j = i + by;
      if (i < 1 || j < 1 || j >= rs.length) return rs; // the main cash stays first
      const out = [...rs];
      [out[i], out[j]] = [out[j] as Row, out[i] as Row];
      return out;
    });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const out: SavingsBucketInput[] = [];
    for (const r of rows) {
      if (!r.name.trim()) continue;
      const balance = r.isMain ? 0 : toCents(r.balance);
      const goal = toCents(r.goal);
      const cap = toCents(r.cap);
      if (balance === null || Number.isNaN(balance))
        return setError(`Enter what "${r.name}" holds now, like 1234.56.`);
      if (Number.isNaN(goal) || Number.isNaN(cap))
        return setError(`Check the amounts for "${r.name}".`);
      out.push({
        id: r.id,
        name: r.name.trim(),
        balanceCents: balance,
        goalCents: r.rest ? null : goal,
        monthlyCapCents: r.isMain ? null : cap,
        fillRemaining: r.rest,
        isMain: r.isMain,
      });
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
  const blank = (): Row => ({
    key: `n${++seq}`,
    name: "",
    balance: "",
    goal: "",
    cap: "",
    rest: false,
    isMain: false,
  });
  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      {error && <Alert>{error}</Alert>}
      <p className="text-sm text-slate-600 dark:text-slate-400">
        Set it up like your bank's plan: the account's own cash keeps a target, extra cash goes to
        the categories in order. Enter what each category holds now (from your bank's app); the main
        cash is the rest of the account. Muny follows each category's moves from today.
      </p>
      <div className="space-y-3">
        {rows.map((r, i) => (
          <div
            key={r.key}
            className={cx(
              "space-y-2 rounded-xl border p-3",
              r.isMain
                ? "border-brand-600/40 bg-brand-50/40 dark:bg-brand-700/10"
                : "border-slate-200 dark:border-slate-800",
            )}
          >
            <div className="flex items-center gap-2">
              <span className="w-5 text-xs text-slate-500 tabular-nums">{i + 1}</span>
              <input
                aria-label="Name"
                value={r.name}
                onChange={(e) => set(r.key, { name: e.target.value })}
                placeholder={r.isMain ? "Main cash" : "Category"}
                className={cx(input, "mt-0 flex-1 font-medium")}
              />
              {!r.isMain && (
                <span className="flex items-center">
                  <button
                    type="button"
                    aria-label={`Move ${r.name || "category"} up`}
                    disabled={i <= 1}
                    onClick={() => move(r.key, -1)}
                    className="p-1 text-slate-400 hover:text-slate-700 disabled:opacity-30"
                  >
                    <ArrowUp aria-hidden="true" className="size-4" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${r.name || "category"} down`}
                    disabled={i === rows.length - 1}
                    onClick={() => move(r.key, 1)}
                    className="p-1 text-slate-400 hover:text-slate-700 disabled:opacity-30"
                  >
                    <ArrowDown aria-hidden="true" className="size-4" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove ${r.name || "category"}`}
                    onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
                    className="p-1 text-slate-400 hover:text-red-600"
                  >
                    <Trash2 aria-hidden="true" className="size-4" />
                  </button>
                </span>
              )}
            </div>
            {r.isMain ? (
              <label className="block max-w-48 pl-7 text-xs">
                <span className="text-slate-500">Keep in cash (target)</span>
                <input
                  inputMode="decimal"
                  value={r.goal}
                  onChange={(e) => set(r.key, { goal: e.target.value })}
                  placeholder="1,000.00"
                  className={input}
                />
              </label>
            ) : (
              <div className="grid gap-2 pl-7 sm:grid-cols-3">
                <label className="block text-xs">
                  <span className="text-slate-500">Holds now</span>
                  <input
                    inputMode="decimal"
                    value={r.balance}
                    onChange={(e) => set(r.key, { balance: e.target.value })}
                    placeholder="0.00"
                    className={input}
                  />
                </label>
                {!r.rest && (
                  <label className="block text-xs">
                    <span className="text-slate-500">Goal</span>
                    <input
                      inputMode="decimal"
                      value={r.goal}
                      onChange={(e) => set(r.key, { goal: e.target.value })}
                      className={input}
                    />
                  </label>
                )}
                <label className="block text-xs">
                  <span className="text-slate-500">Save up to a month</span>
                  <input
                    inputMode="decimal"
                    value={r.cap}
                    onChange={(e) => set(r.key, { cap: e.target.value })}
                    placeholder="No limit"
                    className={input}
                  />
                </label>
                <label className="flex items-center gap-2 text-xs sm:col-span-3">
                  <input
                    type="checkbox"
                    checked={r.rest}
                    onChange={(e) => set(r.key, { rest: e.target.checked })}
                    className="accent-brand-600"
                  />
                  Save all remaining cash (no goal)
                </label>
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <button
          type="button"
          onClick={() => setRows((rs) => [...rs, blank()])}
          className="inline-flex items-center gap-1 text-brand-600 hover:underline dark:text-brand-500"
        >
          <Plus aria-hidden="true" className="size-4" /> Add a category
        </button>
        {unused.map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => setRows((rs) => [...rs, { ...blank(), name: n }])}
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

export function SavingsBucketsSection({
  accountId,
  accountName,
}: {
  accountId: string;
  accountName: string;
}) {
  const q = useQuery({
    queryKey: ["savings-buckets", accountId],
    queryFn: () => api.get<SavingsBuckets>(`/api/savings/accounts/${accountId}/buckets`),
  });
  const [editing, setEditing] = useState(false);
  const d = q.data;
  if (!d) return null;
  const modal = (
    <Modal open={editing} onClose={() => setEditing(false)} title="Categories in this account" wide>
      {editing && (
        <BucketsForm
          accountId={accountId}
          accountName={accountName}
          data={d}
          onDone={() => setEditing(false)}
        />
      )}
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
          Set them up
        </button>
        {modal}
      </div>
    ) : null;
  return (
    <div className="mt-4 rounded-xl border border-slate-200 p-4 dark:border-slate-800">
      <div className="mb-3 flex items-baseline justify-between">
        <p className="text-sm font-semibold">Savings plan</p>
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="inline-flex items-center gap-1 text-xs text-brand-600 hover:underline dark:text-brand-500"
        >
          <Pencil aria-hidden="true" className="size-3" /> Edit plan
        </button>
      </div>
      <ol className="space-y-3 text-sm">
        {d.buckets.map((b, i) => {
          const pct = b.goalCents ? Math.min(100, (b.balanceCents / b.goalCents) * 100) : null;
          const rule = b.fillRemaining
            ? "save all remaining cash"
            : [
                b.goalCents ? whole(b.goalCents) : null,
                b.monthlyCapCents ? `save up to ${whole(b.monthlyCapCents)} a month` : null,
              ]
                .filter(Boolean)
                .join(", ");
          return (
            <li key={b.id} className="flex gap-3">
              <span
                aria-hidden="true"
                className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand-50 text-xs font-medium text-brand-700 dark:bg-brand-700/20 dark:text-brand-500"
              >
                {i + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block">
                  <strong className="tabular-nums">{formatMoney(b.balanceCents)}</strong>
                  {rule && <span className="text-slate-500"> / {rule}</span>}
                </span>
                <span className="block text-xs text-slate-500">
                  {b.name}
                  {b.isMain && " · the account's own cash"}
                  {b.goalMonth && !b.isMain && ` · goal about ${monthName(b.goalMonth)}`}
                </span>
                {pct !== null && (
                  <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
                    <span
                      className="block h-full rounded-full bg-emerald-500"
                      style={{ width: `${pct}%` }}
                    />
                  </span>
                )}
              </span>
            </li>
          );
        })}
        {d.unassignedCents !== 0 && (
          <li className="flex justify-between gap-3 border-t border-slate-100 pt-2 text-slate-500 dark:border-slate-800">
            <span>Not in the plan</span>
            <span className="tabular-nums">{formatMoney(d.unassignedCents)}</span>
          </li>
        )}
      </ol>
      {d.suggestions.length > 0 && (
        <p className="mt-2 text-xs text-slate-500">
          Also seen: {d.suggestions.join(", ")} (Edit plan to add).
        </p>
      )}
      {modal}
    </div>
  );
}

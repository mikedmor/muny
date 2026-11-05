import { type BudgetLine, type BudgetMonth, formatMoney } from "@muny/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Checkbox, MoneyField } from "../components/forms.js";
import { Alert, Button, Card, cx, PageHeader } from "../components/ui.js";
import { api } from "../lib/api.js";
import { keys, useDeleteBudget, useSetBudget } from "../lib/queries.js";

const pad = (n: number) => String(n).padStart(2, "0");
const thisMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
};
const shift = (m: string, n: number) => {
  const [y, mo] = m.split("-").map(Number) as [number, number];
  const t = y * 12 + mo - 1 + n;
  return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`;
};
const label = (m: string) => {
  const [y, mo] = m.split("-").map(Number) as [number, number];
  return new Date(y, mo - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
};

function Bar({ spent, limit }: { spent: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, (spent / limit) * 100) : spent > 0 ? 100 : 0;
  const over = spent > limit;
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
      <div
        className={cx(
          "h-full rounded-full transition-all",
          over ? "bg-red-500" : pct > 85 ? "bg-amber-500" : "bg-emerald-500",
        )}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function EditBudget({
  line,
  month,
  onDone,
}: {
  line: BudgetLine;
  month: string;
  onDone: () => void;
}) {
  const set = useSetBudget();
  const del = useDeleteBudget();
  const suggested = line.averageCents > 0 ? Math.ceil(line.averageCents / 1000) * 1000 : null;
  const [amount, setAmount] = useState<number | null>(line.budgetCents ?? suggested);
  const [rollover, setRollover] = useState(line.rollover);
  return (
    <div className="mt-3 space-y-3 rounded-lg bg-slate-50 p-3 dark:bg-slate-800/50">
      <div className="grid items-end gap-3 sm:grid-cols-2">
        <MoneyField
          label={`Monthly budget from ${label(month)}`}
          cents={amount}
          onChange={(c) => setAmount(c)}
          hint={
            line.averageCents > 0
              ? `You spent ${formatMoney(line.averageCents)}/mo on average over the last 3 months.`
              : undefined
          }
        />
        <Checkbox
          label="Roll over"
          description="Carry what's left (or overspent) into next month."
          checked={rollover}
          onChange={setRollover}
        />
      </div>
      {(set.error || del.error) && <Alert>{(set.error ?? del.error)?.message}</Alert>}
      <div className="flex flex-wrap justify-between gap-2">
        {line.budgetId ? (
          <Button
            variant="ghost"
            className="text-red-600"
            onClick={() => line.budgetId && del.mutate(line.budgetId, { onSuccess: onDone })}
          >
            Remove budget
          </Button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onDone}>
            Cancel
          </Button>
          <Button
            disabled={amount === null || set.isPending}
            onClick={() =>
              amount !== null &&
              set.mutate(
                { categoryId: line.categoryId, amountCents: amount, rollover, fromMonth: month },
                { onSuccess: onDone },
              )
            }
          >
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}

function Line({ line, month }: { line: BudgetLine; month: string }) {
  const [editing, setEditing] = useState(false);
  const limit = (line.budgetCents ?? 0) + line.rolloverCents;
  const left = line.availableCents;
  return (
    <li className="px-4 py-3">
      <button type="button" onClick={() => setEditing((e) => !e)} className="w-full text-left">
        <div className="flex items-baseline justify-between gap-3">
          <span className="truncate font-medium">{line.name}</span>
          <span className="shrink-0 text-sm tabular-nums">
            {formatMoney(line.spentCents)}
            {line.budgetCents !== null && (
              <span className="text-slate-500"> of {formatMoney(limit)}</span>
            )}
          </span>
        </div>
        {line.budgetCents !== null ? (
          <>
            <div className="mt-1.5">
              <Bar spent={line.spentCents} limit={limit} />
            </div>
            <div className="mt-1 flex justify-between text-xs text-slate-500">
              <span>
                {line.rollover && line.rolloverCents !== 0 && (
                  <span className={line.rolloverCents < 0 ? "text-red-600" : "text-emerald-600"}>
                    {line.rolloverCents > 0 ? "+" : "−"}
                    {formatMoney(Math.abs(line.rolloverCents))} rolled over ·{" "}
                  </span>
                )}
                {formatMoney(line.budgetCents)}/mo
              </span>
              <span className={cx(left !== null && left < 0 && "font-medium text-red-600")}>
                {left !== null &&
                  (left >= 0 ? `${formatMoney(left)} left` : `${formatMoney(-left)} over`)}
              </span>
            </div>
          </>
        ) : (
          <p className="mt-0.5 text-xs text-brand-600">Set a budget</p>
        )}
      </button>
      {editing && <EditBudget line={line} month={month} onDone={() => setEditing(false)} />}
    </li>
  );
}

export function BudgetsPage() {
  const [month, setMonth] = useState(thisMonth);
  const [showAll, setShowAll] = useState(false);
  const [editTotal, setEditTotal] = useState(false);
  const q = useQuery({
    queryKey: [...keys.budgets, month],
    queryFn: () => api.get<BudgetMonth>(`/api/budgets/${month}`),
    placeholderData: keepPreviousData,
  });
  const b = q.data;
  const lines = b?.groups.flatMap((g) => g.lines) ?? [];
  const budgeted = lines.filter((l) => l.budgetCents !== null);
  const hiddenCount = lines.filter((l) => l.budgetCents === null && l.spentCents <= 0).length;
  const totalLimit =
    b?.total.budgetCents != null
      ? b.total.budgetCents + b.total.rolloverCents
      : (b?.budgetedCents ?? 0);

  return (
    <>
      <PageHeader
        title="Budgets"
        actions={
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              aria-label="Previous month"
              onClick={() => setMonth((m) => shift(m, -1))}
            >
              ‹
            </Button>
            <span className="min-w-36 text-center font-medium">{label(month)}</span>
            <Button
              variant="ghost"
              aria-label="Next month"
              onClick={() => setMonth((m) => shift(m, 1))}
            >
              ›
            </Button>
          </div>
        }
      />
      {q.isError && <Alert>Couldn't load budgets.</Alert>}
      {b && (
        <div className="space-y-6">
          <Card>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  Spent this month
                </p>
                <p className="text-2xl font-semibold tabular-nums">
                  {formatMoney(b.total.spentCents)}
                  {totalLimit > 0 && (
                    <span className="text-base font-normal text-slate-500">
                      {" "}
                      of {formatMoney(totalLimit)}
                    </span>
                  )}
                </p>
              </div>
              <div className="text-right text-sm text-slate-500">
                <p>Income {formatMoney(b.incomeCents)}</p>
                <p>
                  {b.total.budgetCents != null
                    ? "Total budget"
                    : `Budgeted across ${budgeted.length} categories`}
                  {" · "}
                  <button
                    type="button"
                    className="text-brand-600 underline"
                    onClick={() => setEditTotal((e) => !e)}
                  >
                    {b.total.budgetCents != null ? "edit" : "set a total"}
                  </button>
                </p>
              </div>
            </div>
            {totalLimit > 0 && (
              <div className="mt-3">
                <Bar spent={b.total.spentCents} limit={totalLimit} />
              </div>
            )}
            {editTotal && (
              <EditBudget line={b.total} month={month} onDone={() => setEditTotal(false)} />
            )}
            {b.uncategorizedCents > 0 && (
              <p className="mt-3 text-xs text-amber-700 dark:text-amber-400">
                {formatMoney(b.uncategorizedCents)} of spending has no category.{" "}
                <Link to="/transactions" className="underline">
                  Categorize it
                </Link>{" "}
                so it lands in the right budget.
              </p>
            )}
          </Card>

          {/* Ultrawide: category groups side by side. */}
          <div className="space-y-6 min-[112rem]:grid min-[112rem]:grid-cols-2 min-[112rem]:items-start min-[112rem]:gap-6 min-[112rem]:space-y-0">
            {b.groups.map((g) => {
              const shown = g.lines.filter(
                (l) => showAll || l.budgetCents !== null || l.spentCents > 0,
              );
              if (shown.length === 0) return null;
              return (
                <section key={g.groupId}>
                  <h2 className="mb-2 px-1 text-sm font-semibold uppercase tracking-wide text-slate-500">
                    {g.name}
                  </h2>
                  <ul className="divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
                    {shown.map((l) => (
                      <Line key={l.categoryId} line={l} month={month} />
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
          {hiddenCount > 0 && (
            <Button variant="ghost" onClick={() => setShowAll((s) => !s)}>
              {showAll
                ? "Hide categories with no budget or spending"
                : `Show ${hiddenCount} more categories`}
            </Button>
          )}
        </div>
      )}
    </>
  );
}

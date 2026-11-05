import { type BudgetLine, type BudgetMonth, formatMoney } from "@muny/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment, useState } from "react";
import { Checkbox, MoneyField } from "../components/forms.js";
import { Alert, Button, Card, cx, PageHeader } from "../components/ui.js";
import { CategoryIcon, MerchantAvatar } from "../components/visuals.js";
import { api } from "../lib/api.js";
import { keys, useDeleteBudget, useSetBudget } from "../lib/queries.js";

/**
 * Budgets, laid out like Rocket Money: budget basics (earnings and recurring
 * bills), a category table, and a summary with what's left. Plus a forecast
 * from recurring income and bills: what should still land this month.
 */

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
const label = (
  m: string,
  opts: Intl.DateTimeFormatOptions = { month: "long", year: "numeric" },
) => {
  const [y, mo] = m.split("-").map(Number) as [number, number];
  return new Date(y, mo - 1, 1).toLocaleDateString(undefined, opts);
};
const day = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
const signed = (cents: number) => `${cents < 0 ? "−" : ""}${formatMoney(Math.abs(cents))}`;

/** Progress ring: the arc shows how much of the limit is used. */
function Ring({
  used,
  limit,
  size = 22,
  stroke = 3,
  children,
}: {
  used: number;
  limit: number;
  size?: number;
  stroke?: number;
  children?: React.ReactNode;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = limit > 0 ? Math.min(1, Math.max(0, used / limit)) : used > 0 ? 1 : 0;
  const over = limit > 0 ? used > limit : used > 0;
  const color = over
    ? "stroke-red-500"
    : pct > 0.85
      ? "stroke-amber-500"
      : "stroke-[var(--viz-series-1)]";
  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center"
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} aria-hidden="true" className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          className="stroke-slate-200 dark:stroke-slate-700"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - (over ? 1 : pct))}
          className={color}
        />
      </svg>
      {children && (
        <span className="absolute inset-0 flex flex-col items-center justify-center text-center">
          {children}
        </span>
      )}
    </span>
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
    <div className="space-y-3 rounded-lg bg-slate-50 p-3 dark:bg-slate-800/50">
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

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

const ROW =
  "grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-4 sm:grid-cols-[minmax(0,1fr)_7rem_7rem_7rem_1.5rem]";

function TableHead({ first }: { first: string }) {
  return (
    <div
      className={cx(
        ROW,
        "border-b border-slate-200 px-4 py-2.5 text-xs font-medium text-slate-500 dark:border-slate-800",
      )}
    >
      <span>{first}</span>
      <span className="hidden text-right sm:block">Budgeted</span>
      <span className="text-right">Actual</span>
      <span className="text-right">Remaining</span>
      <span className="hidden sm:block" />
    </div>
  );
}

function Remaining({ cents, muted }: { cents: number | null; muted?: boolean }) {
  if (cents === null) return <span className="text-right text-xs text-brand-600">Set budget</span>;
  return (
    <span
      className={cx(
        "text-right font-medium tabular-nums",
        muted
          ? "text-slate-600 dark:text-slate-300"
          : cents < 0
            ? "text-red-600 dark:text-red-400"
            : "text-emerald-700 dark:text-emerald-400",
      )}
    >
      {signed(cents)}
    </span>
  );
}

function BasicsTable({ b }: { b: BudgetMonth }) {
  const f = b.forecast;
  const past = f.period === "past";
  const expectedIncome = past ? f.incomeSoFarCents : f.projectedIncomeCents;
  const scheduledBills = f.recurringPaidCents + f.recurringDueCents;
  const rows = [
    {
      key: "earnings",
      icon: "💰",
      name: "Earnings",
      note: past
        ? "Income received"
        : f.incomeExpectedCents > 0
          ? `${formatMoney(f.incomeExpectedCents)} more expected from recurring income`
          : `Usually about ${formatMoney(f.incomeAverageCents)}/mo`,
      budgeted: expectedIncome,
      actual: f.incomeSoFarCents,
      remaining: expectedIncome - f.incomeSoFarCents,
      ring: [f.incomeSoFarCents, expectedIncome] as const,
      link: "/recurring",
    },
    {
      key: "bills",
      icon: "🧾",
      name: "Bills & subscriptions",
      note: past
        ? "Recurring charges paid"
        : f.recurringDueCents > 0
          ? `${formatMoney(f.recurringDueCents)} still due this month`
          : "All paid for the month",
      budgeted: scheduledBills,
      actual: f.recurringPaidCents,
      remaining: f.recurringDueCents,
      ring: [f.recurringPaidCents, scheduledBills] as const,
      link: "/recurring",
    },
  ];
  return (
    <Card className="p-0">
      <TableHead first="Budget basics" />
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {rows.map((r) => (
          <li key={r.key} className={cx(ROW, "px-4 py-3")}>
            <span className="flex min-w-0 items-center gap-3">
              <span
                aria-hidden="true"
                className="flex size-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-lg dark:bg-slate-800"
              >
                {r.icon}
              </span>
              <span className="min-w-0">
                <Link to={r.link} className="block truncate font-medium hover:underline">
                  {r.name}
                </Link>
                <span className="block truncate text-xs text-slate-500">{r.note}</span>
              </span>
            </span>
            <span className="hidden text-right tabular-nums text-slate-600 sm:block dark:text-slate-300">
              {formatMoney(r.budgeted)}
            </span>
            <span className="text-right tabular-nums">{formatMoney(r.actual)}</span>
            <Remaining cents={r.remaining} muted />
            <span className="hidden sm:block">
              <Ring used={r.ring[0]} limit={r.ring[1]} />
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function CategoriesTable({ b, month }: { b: BudgetMonth; month: string }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const scheduled = b.forecast.scheduledByCategory;
  const lines = b.groups.flatMap((g) => g.lines.map((l) => ({ ...l, groupName: g.name })));
  const shown = lines.filter(
    (l) =>
      showAll ||
      l.budgetCents !== null ||
      l.spentCents > 0 ||
      (scheduled[l.categoryId ?? ""] ?? 0) > 0,
  );
  const hidden = lines.length - shown.length;
  return (
    <Card className="p-0">
      <TableHead first="Budget categories" />
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {shown.map((l) => {
          const id = l.categoryId ?? "";
          const limit = (l.budgetCents ?? 0) + l.rolloverCents;
          const due = scheduled[id] ?? 0;
          const open = editing === id;
          return (
            <Fragment key={id}>
              <li>
                <button
                  type="button"
                  onClick={() => setEditing(open ? null : id)}
                  aria-expanded={open}
                  className={cx(
                    ROW,
                    "w-full px-4 py-3 text-left hover:bg-slate-50 dark:hover:bg-slate-800/50",
                  )}
                >
                  <span className="flex min-w-0 items-center gap-3">
                    <span
                      aria-hidden="true"
                      className="flex size-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-base dark:bg-slate-800"
                    >
                      <CategoryIcon name={l.name} group={l.groupName} />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{l.name}</span>
                      <span className="block truncate text-xs text-slate-500">
                        {due > 0 && `${formatMoney(due)} more scheduled`}
                        {due > 0 && l.rollover && l.rolloverCents !== 0 && " · "}
                        {l.rollover &&
                          l.rolloverCents !== 0 &&
                          `${signed(l.rolloverCents)} rolled over`}
                        {due === 0 && !(l.rollover && l.rolloverCents !== 0) && (
                          <span className="sm:hidden">
                            {l.budgetCents !== null ? `of ${formatMoney(limit)}` : ""}
                          </span>
                        )}
                      </span>
                    </span>
                  </span>
                  <span className="hidden text-right tabular-nums text-slate-600 sm:block dark:text-slate-300">
                    {l.budgetCents !== null ? formatMoney(limit) : "—"}
                  </span>
                  <span className="text-right tabular-nums">{formatMoney(l.spentCents)}</span>
                  <Remaining cents={l.availableCents} />
                  <span className="hidden sm:block">
                    {l.budgetCents !== null && <Ring used={l.spentCents} limit={limit} />}
                  </span>
                </button>
              </li>
              {open && (
                <li className="px-4 pb-3">
                  <EditBudget line={l} month={month} onDone={() => setEditing(null)} />
                </li>
              )}
            </Fragment>
          );
        })}
      </ul>
      {hidden > 0 && (
        <div className="border-t border-slate-200 px-4 py-2 dark:border-slate-800">
          <Button variant="ghost" onClick={() => setShowAll((s) => !s)}>
            {showAll
              ? "Hide categories with no budget or spending"
              : `Show ${hidden} more categories`}
          </Button>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Summary & forecast
// ---------------------------------------------------------------------------

function SummaryCard({ b, month }: { b: BudgetMonth; month: string }) {
  const [editTotal, setEditTotal] = useState(false);
  const f = b.forecast;
  const budget =
    b.total.budgetCents != null ? b.total.budgetCents + b.total.rolloverCents : b.budgetedCents;
  const spent = b.total.spentCents;
  const leftover = budget - spent;
  const over = budget > 0 && leftover < 0;
  return (
    <Card className="p-0">
      <div className="flex flex-col items-center px-4 pt-6 pb-4">
        <Ring used={spent} limit={budget} size={190} stroke={12}>
          {over && (
            <span
              className="absolute top-3 right-6 flex size-7 items-center justify-center rounded-full bg-amber-500 font-bold text-white"
              aria-hidden="true"
            >
              !
            </span>
          )}
          <span className="text-xs text-slate-500">{budget > 0 ? "Leftover" : "Spent"}</span>
          <span
            className={cx(
              "text-2xl font-semibold tracking-tight tabular-nums",
              over && "text-red-600 dark:text-red-400",
            )}
          >
            {budget > 0 ? signed(leftover) : formatMoney(spent)}
          </span>
          {budget > 0 && <span className="text-xs text-slate-500">of {formatMoney(budget)}</span>}
        </Ring>
        {budget === 0 && (
          <p className="mt-3 text-center text-sm text-slate-500">
            Set a budget on a category, or a total, to see what's left.
          </p>
        )}
      </div>
      <dl className="divide-y divide-slate-100 border-t border-slate-200 text-sm dark:divide-slate-800 dark:border-slate-800">
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <dt className="flex items-center gap-2">
            <span aria-hidden="true" className="w-4 text-center text-slate-400">
              ⊕
            </span>{" "}
            Spending budget
            <button
              type="button"
              onClick={() => setEditTotal((e) => !e)}
              className="text-xs text-brand-600 underline"
            >
              {b.total.budgetCents != null ? "edit total" : "set a total"}
            </button>
          </dt>
          <dd className="font-semibold tabular-nums">{formatMoney(budget)}</dd>
        </div>
        {editTotal && (
          <div className="px-4 py-3">
            <EditBudget line={b.total} month={month} onDone={() => setEditTotal(false)} />
          </div>
        )}
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <dt className="flex items-center gap-2">
            <span aria-hidden="true" className="w-4 text-center text-slate-400">
              ⊖
            </span>{" "}
            Spending
          </dt>
          <dd className="font-semibold tabular-nums">{formatMoney(spent)}</dd>
        </div>
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <dt className="flex items-center gap-2">
            <span aria-hidden="true" className="w-4 text-center text-slate-400">
              ⊜
            </span>{" "}
            Remaining
          </dt>
          <dd
            className={cx(
              "font-semibold tabular-nums",
              leftover < 0
                ? "text-red-600 dark:text-red-400"
                : "text-emerald-700 dark:text-emerald-400",
            )}
          >
            {signed(leftover)}
          </dd>
        </div>
      </dl>
      {b.uncategorizedCents > 0 && (
        <p className="border-t border-slate-200 px-4 py-3 text-xs text-amber-700 dark:border-slate-800 dark:text-amber-400">
          {formatMoney(b.uncategorizedCents)} of spending has no category.{" "}
          <Link to="/transactions" className="underline">
            Categorize it
          </Link>{" "}
          so it lands in the right budget.
        </p>
      )}
      <ForecastBlock b={b} />
    </Card>
  );
}

function ForecastBlock({ b }: { b: BudgetMonth }) {
  const f = b.forecast;
  const past = f.period === "past";
  const rows: [string, string, string?][] = past
    ? [
        ["Income", formatMoney(f.incomeSoFarCents)],
        ["Spending", formatMoney(b.total.spentCents)],
      ]
    : [
        [
          "Income",
          formatMoney(f.projectedIncomeCents),
          f.incomeExpectedCents > 0
            ? `${formatMoney(f.incomeSoFarCents)} so far + ${formatMoney(f.incomeExpectedCents)} expected`
            : `${formatMoney(f.incomeSoFarCents)} so far`,
        ],
        [
          "Spending",
          formatMoney(f.projectedSpendingCents),
          f.recurringDueCents > 0
            ? `${formatMoney(b.total.spentCents)} so far + ${formatMoney(f.recurringDueCents)} in bills still due`
            : `${formatMoney(b.total.spentCents)} so far, no bills left`,
        ],
      ];
  const net = past ? f.incomeSoFarCents - b.total.spentCents : f.projectedLeftoverCents;
  return (
    <div className="border-t border-slate-200 px-4 py-4 dark:border-slate-800">
      <h3 className="text-sm font-semibold">
        {past
          ? `How ${label(b.month, { month: "long" })} ended`
          : `By the end of ${label(b.month, { month: "long" })}`}
      </h3>
      {!past && (
        <p className="mb-2 text-xs text-slate-500">
          From your recurring income and bills. Everyday spending beyond today isn't guessed.
        </p>
      )}
      <dl className="space-y-2 text-sm">
        {rows.map(([k, v, note]) => (
          <div key={k}>
            <div className="flex justify-between gap-3">
              <dt className="text-slate-600 dark:text-slate-300">{k}</dt>
              <dd className="font-medium tabular-nums">{v}</dd>
            </div>
            {note && <p className="text-xs text-slate-500">{note}</p>}
          </div>
        ))}
        <div className="flex justify-between gap-3 border-t border-slate-100 pt-2 dark:border-slate-800">
          <dt className="font-medium">{past ? "Left over" : "Projected left over"}</dt>
          <dd
            className={cx(
              "font-semibold tabular-nums",
              net < 0 ? "text-red-600 dark:text-red-400" : "text-emerald-700 dark:text-emerald-400",
            )}
          >
            {signed(net)}
          </dd>
        </div>
      </dl>
    </div>
  );
}

function StillToCome({ b }: { b: BudgetMonth }) {
  const f = b.forecast;
  if (f.period === "past") return null;
  return (
    <Card className="p-0">
      <div className="px-4 pt-4 pb-2">
        <h3 className="font-semibold">Still to come in {label(b.month, { month: "long" })}</h3>
        <p className="text-xs text-slate-500">Predicted from your recurring charges and income.</p>
      </div>
      <ul className="divide-y divide-slate-100 border-t border-slate-200 text-sm dark:divide-slate-800 dark:border-slate-800">
        {f.scheduled.map((s) => (
          <li key={`${s.seriesId}-${s.date}`} className="flex items-center gap-3 px-4 py-2">
            <MerchantAvatar name={s.name} size="sm" />
            <span className="min-w-0 flex-1">
              <span className="block truncate">{s.name}</span>
              <span className="text-xs text-slate-500">{day(s.date)}</span>
            </span>
            <span
              className={cx(
                "tabular-nums",
                s.amountCents > 0 && "font-medium text-emerald-700 dark:text-emerald-400",
              )}
            >
              {s.amountCents > 0 ? "+" : ""}
              {formatMoney(Math.abs(s.amountCents))}
            </span>
          </li>
        ))}
        {f.scheduled.length === 0 && (
          <li className="px-4 py-3 text-slate-500">Nothing else expected this month.</li>
        )}
      </ul>
      <div className="border-t border-slate-200 px-4 py-2 text-right text-sm dark:border-slate-800">
        <Link to="/recurring" className="text-brand-600 hover:underline">
          All recurring
        </Link>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------

export function BudgetsPage() {
  const [month, setMonth] = useState(thisMonth);
  const q = useQuery({
    queryKey: [...keys.budgets, month],
    queryFn: () => api.get<BudgetMonth>(`/api/budgets/${month}`),
    placeholderData: keepPreviousData,
  });
  const b = q.data;
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
            {month !== thisMonth() && (
              <Button variant="ghost" onClick={() => setMonth(thisMonth())}>
                Today
              </Button>
            )}
          </div>
        }
      />
      {q.isError && <Alert>Couldn't load budgets.</Alert>}
      {b && (
        <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-start min-[112rem]:grid-cols-[minmax(0,1fr)_26rem_26rem]">
          <div className="order-2 space-y-6 lg:order-none">
            <BasicsTable b={b} />
            <CategoriesTable b={b} month={month} />
          </div>
          <div className="order-1 space-y-6 lg:sticky lg:top-6 lg:order-none">
            <SummaryCard b={b} month={month} />
            <div className="min-[112rem]:hidden">
              <StillToCome b={b} />
            </div>
          </div>
          <div className="hidden min-[112rem]:block">
            <StillToCome b={b} />
          </div>
        </div>
      )}
    </>
  );
}

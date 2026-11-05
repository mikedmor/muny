import { formatMoney, type SpendingOverview } from "@muny/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { monthLabel } from "../components/budget.js";
import { ColumnChart, Donut, type DonutSlice } from "../components/charts.js";
import { Alert, Button, Card, cx, PageHeader } from "../components/ui.js";
import { CategoryIcon } from "../components/visuals.js";
import { api } from "../lib/api.js";
import { keys } from "../lib/queries.js";

/**
 * Spending, like Rocket Money's page: income vs spending by month, a category
 * breakdown (with or without bills), a summary and the largest purchases.
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
const monthEnd = (m: string) => {
  const [y, mo] = m.split("-").map(Number) as [number, number];
  return `${m}-${pad(new Date(y, mo, 0).getDate())}`;
};
const day = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: "long", day: "numeric" });
const short = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

/** Top 7 categories get their own validated color; the rest fold into "Other". */
const SLOTS = 7;
const color = (i: number) => (i < SLOTS ? `var(--viz-series-${i + 1})` : "var(--viz-other)");

function Change({ now, before }: { now: number; before: number }) {
  if (before <= 0) return <span className="text-slate-400">—</span>;
  const pct = Math.round(((now - before) / before) * 100);
  if (pct === 0) return <span className="text-slate-500">Same</span>;
  const down = pct < 0;
  return (
    <span
      className={down ? "text-emerald-700 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}
    >
      {down ? "↓" : "↑"} {Math.abs(pct)}%
    </span>
  );
}

export function SpendingPage() {
  const [month, setMonth] = useState(thisMonth);
  const [includeBills, setIncludeBills] = useState(true);
  const q = useQuery({
    queryKey: [...keys.reports, "spending-page", month, includeBills],
    queryFn: () =>
      api.get<SpendingOverview>(`/api/spending?month=${month}&includeBills=${includeBills}`),
    placeholderData: keepPreviousData,
  });
  const d = q.data;
  const prevName = monthLabel(shift(month, -1), { month: "short" });
  const compareLabel = d?.period === "current" ? `vs this point in ${prevName}` : `vs ${prevName}`;

  const slices: DonutSlice[] = [];
  if (d) {
    d.categories.slice(0, SLOTS).forEach((c, i) => {
      if (c.cents > 0)
        slices.push({ key: c.id ?? "none", label: c.name, cents: c.cents, color: color(i) });
    });
    const rest = d.categories.slice(SLOTS).reduce((s, c) => s + Math.max(0, c.cents), 0);
    if (rest > 0) slices.push({ key: "other", label: "Other", cents: rest, color: color(SLOTS) });
  }
  const top3 = d?.largest.reduce((s, l) => s + l.cents, 0) ?? 0;

  return (
    <>
      <PageHeader
        title="Spending"
        actions={
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              aria-label="Previous month"
              onClick={() => setMonth((m) => shift(m, -1))}
            >
              ‹
            </Button>
            <span className="min-w-36 text-center font-medium">{monthLabel(month)}</span>
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
      {q.isError && <Alert>Couldn't load spending.</Alert>}
      {d && (
        <div className="space-y-6">
          <Card>
            <ColumnChart
              ariaLabel="Income and spending by month"
              seriesNames={["Income", "Spending"]}
              selectedKey={month}
              onSelect={setMonth}
              data={d.months.map((m) => ({
                key: m.month,
                label: monthLabel(m.month, { month: "short" }),
                title: monthLabel(m.month),
                values: [m.incomeCents, m.spendingCents],
              }))}
            />
            <p className="mt-1 text-center text-xs text-slate-500">
              Click a month to see its breakdown.
            </p>
          </Card>

          <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
            <div className="min-w-0">
              <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Spending breakdown
              </h2>
              <Card className="p-0">
                <div className="flex justify-end px-4 pt-4">
                  <label className="flex cursor-pointer items-center gap-2 text-sm">
                    Include bills
                    <button
                      type="button"
                      role="switch"
                      aria-checked={includeBills}
                      onClick={() => setIncludeBills((v) => !v)}
                      className={cx(
                        "relative h-6 w-11 rounded-full transition-colors",
                        includeBills ? "bg-brand-600" : "bg-slate-300 dark:bg-slate-700",
                      )}
                    >
                      <span
                        className={cx(
                          "absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition-transform",
                          includeBills && "translate-x-5",
                        )}
                      />
                    </button>
                  </label>
                </div>
                <div className="py-4">
                  <Donut slices={slices} ariaLabel={`Spending by category, ${monthLabel(month)}`}>
                    <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                      Total spend
                    </span>
                    <span className="text-3xl font-semibold tracking-tight tabular-nums">
                      {formatMoney(d.totalCents)}
                    </span>
                    <span className="text-sm font-medium">
                      <Change now={d.totalCents} before={d.compareCents} />
                    </span>
                    <span className="text-xs text-slate-500">{compareLabel}</span>
                  </Donut>
                </div>
                <div className="grid grid-cols-[minmax(0,1fr)_4rem_5.5rem] sm:grid-cols-[minmax(0,1fr)_5rem_5rem_6rem] gap-3 border-y border-slate-200 px-4 py-2.5 text-xs font-medium text-slate-500 dark:border-slate-800">
                  <span>Category</span>
                  <span className="hidden text-right sm:block">% of spend</span>
                  <span className="text-right" title={`Change ${compareLabel}`}>
                    Change
                  </span>
                  <span className="text-right">Amount</span>
                </div>
                <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
                  {d.categories.map((c, i) => {
                    const pct = d.totalCents > 0 ? (Math.max(0, c.cents) / d.totalCents) * 100 : 0;
                    const name = (
                      <span className="flex min-w-0 items-center gap-2.5">
                        <span
                          aria-hidden="true"
                          className="size-2.5 shrink-0 rounded-full"
                          style={{ background: color(i) }}
                        />
                        <CategoryIcon name={c.id ? c.name : null} group={c.groupName} />
                        <span className="truncate">{c.name}</span>
                      </span>
                    );
                    return (
                      <li
                        key={c.id ?? "none"}
                        className="grid grid-cols-[minmax(0,1fr)_4rem_5.5rem] sm:grid-cols-[minmax(0,1fr)_5rem_5rem_6rem] items-center gap-3 px-4 py-2.5"
                      >
                        {c.id ? (
                          <Link
                            to="/categories/$categoryId"
                            params={{ categoryId: c.id }}
                            search={{ month }}
                            className="min-w-0 hover:underline"
                          >
                            {name}
                          </Link>
                        ) : (
                          <Link
                            to="/transactions"
                            search={{
                              categoryId: "uncategorized",
                              from: `${month}-01`,
                              to: monthEnd(month),
                            }}
                            className="min-w-0 hover:underline"
                          >
                            {name}
                          </Link>
                        )}
                        <span className="hidden text-right text-slate-500 tabular-nums sm:block">
                          {pct < 1 && pct > 0 ? "<1" : Math.round(pct)}%
                        </span>
                        <span className="text-right tabular-nums">
                          <Change now={c.cents} before={c.compareCents} />
                        </span>
                        <span className="text-right font-medium tabular-nums">
                          {formatMoney(c.cents)}
                        </span>
                      </li>
                    );
                  })}
                  {d.categories.length === 0 && (
                    <li className="px-4 py-6 text-center text-slate-500">
                      No spending this month yet.
                    </li>
                  )}
                </ul>
              </Card>
            </div>

            <div className="space-y-6">
              <div>
                <h2 className="mb-2 flex justify-between px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <span>Summary</span>
                  <span className="font-normal normal-case">
                    {monthLabel(month, { month: "short" })} 1 –{" "}
                    {monthLabel(month, { month: "short" })}{" "}
                    {d.period === "current"
                      ? Number(new Date().getDate())
                      : Number(monthEnd(month).slice(8))}
                  </span>
                </h2>
                <Card className="p-0">
                  <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
                    <li className="flex items-center justify-between gap-3 px-4 py-3">
                      <span>
                        <span className="block font-medium">Income</span>
                        <span className="text-xs text-slate-500">
                          {d.summary.nextPayday
                            ? `Next payday ${short(d.summary.nextPayday.date)}`
                            : "No more paydays expected this month"}
                        </span>
                      </span>
                      <span className="font-semibold text-emerald-700 tabular-nums dark:text-emerald-400">
                        +{formatMoney(d.summary.incomeCents)}
                      </span>
                    </li>
                    <li className="flex items-center justify-between gap-3 px-4 py-3">
                      <span>
                        <Link to="/recurring" className="block font-medium hover:underline">
                          Bills & subscriptions
                        </Link>
                        <span className="text-xs text-slate-500">
                          {d.summary.billsDueCents > 0
                            ? `${formatMoney(d.summary.billsDueCents)} still due`
                            : "Nothing else due this month"}
                        </span>
                      </span>
                      <span className="font-semibold tabular-nums">
                        {formatMoney(d.summary.billsPaidCents)}
                      </span>
                    </li>
                    <li className="flex items-center justify-between gap-3 px-4 py-3">
                      <span>
                        <span className="block font-medium">
                          Spending{includeBills ? "" : " (without bills)"}
                        </span>
                        <span className="text-xs text-slate-500">
                          {formatMoney(Math.abs(d.totalCents - d.compareCents))}{" "}
                          {d.totalCents <= d.compareCents ? "less" : "more"} than {prevName}
                          {d.period === "current" ? " at this point" : ""}
                        </span>
                      </span>
                      <span className="font-semibold tabular-nums">
                        {formatMoney(d.totalCents)}
                      </span>
                    </li>
                  </ul>
                </Card>
              </div>

              <div>
                <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Largest purchases
                </h2>
                <Card className="p-0">
                  {d.largest.length > 0 && d.totalCents > 0 && (
                    <p className="border-b border-slate-200 px-4 py-3 text-sm text-slate-600 dark:border-slate-800 dark:text-slate-300">
                      Your top {d.largest.length} purchase{d.largest.length === 1 ? "" : "s"} made
                      up {Math.round((top3 / d.totalCents) * 100)}% of your spending this month.
                    </p>
                  )}
                  <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
                    {d.largest.map((l) => (
                      <li key={l.id} className="flex items-center gap-3 px-4 py-2.5">
                        <span
                          aria-hidden="true"
                          className="flex size-9 shrink-0 items-center justify-center rounded-full bg-slate-100 dark:bg-slate-800"
                        >
                          <CategoryIcon name={l.categoryName} group={l.groupName} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{l.name}</span>
                          <span className="text-xs text-slate-500">{day(l.date)}</span>
                        </span>
                        <span className="font-semibold tabular-nums">{formatMoney(l.cents)}</span>
                      </li>
                    ))}
                    {d.largest.length === 0 && (
                      <li className="px-4 py-3 text-slate-500">Nothing yet.</li>
                    )}
                  </ul>
                  <div className="border-t border-slate-200 p-3 dark:border-slate-800">
                    <Link
                      to="/transactions"
                      search={{ from: `${month}-01`, to: monthEnd(month) }}
                      className="block rounded-lg border border-slate-300 py-2 text-center text-sm font-medium hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
                    >
                      See all of {monthLabel(month, { month: "long" })}
                    </Link>
                  </div>
                </Card>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

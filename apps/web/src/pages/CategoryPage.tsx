import {
  BILLS,
  BUDGET_ROWS,
  type BudgetMonth,
  type BudgetRowId,
  type CategoryActivity,
  EARNINGS,
  EVERYTHING_ELSE,
  formatMoney,
  HOME,
  OTHER_SPENDING,
  type Transaction,
  type TransactionPage,
} from "@muny/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { monthLabel, Ring } from "../components/budget.js";
import { CategorySelect } from "../components/CategorySelect.js";
import { ColumnChart } from "../components/charts.js";
import { EditCategoryDialog } from "../components/EditCategory.js";
import { FindSimilar } from "../components/FindSimilar.js";
import { useRuleOffer } from "../components/RuleOffer.js";
import { Alert, Button, Card, cx } from "../components/ui.js";
import { CategoryIcon, MerchantAvatar } from "../components/visuals.js";
import { api } from "../lib/api.js";
import { keys, useCategories, useUpdateRecurring, useUpdateTransaction } from "../lib/queries.js";

/**
 * One category, like Rocket Money's category page: 12 months of spending
 * (click a month), that month's transactions, its budget and a summary.
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
const shortDay = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: "numeric", day: "numeric" });

/** The part of a transaction that belongs to these categories (split-aware). */
function amountIn(t: Transaction, inCategory: (id: string | null) => boolean) {
  if (t.splits.length)
    return t.splits.filter((s) => inCategory(s.categoryId)).reduce((a, s) => a + s.amountCents, 0);
  return t.amountCents;
}

export function CategoryPage() {
  const { categoryId } = useParams({ strict: false }) as { categoryId: string };
  const search = useSearch({ strict: false }) as { month?: string };
  const navigate = useNavigate();
  const month = search.month ?? thisMonth();
  const setMonth = (m: string) =>
    void navigate({
      to: "/categories/$categoryId",
      params: { categoryId },
      search: { month: m },
      replace: true,
    });
  const [end, setEnd] = useState(() => (month > thisMonth() ? month : thisMonth()));
  // Keep the selected month inside the chart window.
  useEffect(() => {
    if (month > end || month <= shift(end, -12)) setEnd(month > thisMonth() ? month : thisMonth());
  }, [month, end]);
  const [sort, setSort] = useState<"date" | "amount">("date");
  const [editing, setEditing] = useState(false);
  const update = useUpdateTransaction();
  const updateSeries = useUpdateRecurring();
  const { offerRule, offerNode, dialog: ruleDialog } = useRuleOffer();
  /** A budget page row (Everything else, Earnings, Bills & subscriptions) rather than a category. */
  const row = (BUDGET_ROWS as readonly string[]).includes(categoryId)
    ? (categoryId as BudgetRowId)
    : null;
  const virtual = row !== null;
  const categories = useCategories();

  const activity = useQuery({
    queryKey: [...keys.reports, "category", categoryId, month, end],
    queryFn: () =>
      api.get<CategoryActivity>(`/api/categories/${categoryId}/activity?month=${month}&end=${end}`),
    placeholderData: keepPreviousData,
  });
  /** Transactions API filter: Everything else is uncategorized spending. */
  const filter =
    row === EVERYTHING_ELSE
      ? "categoryId=uncategorized"
      : row === OTHER_SPENDING
        ? "budgetRow=other"
        : row
          ? `budgetRow=${row}`
          : `categoryId=${categoryId}`;
  const txns = useQuery({
    queryKey: [...keys.transactions, "category", filter, month],
    queryFn: () =>
      api.get<TransactionPage>(
        `/api/transactions?${filter}&from=${month}-01&to=${monthEnd(month)}&limit=200&offset=0`,
      ),
    placeholderData: keepPreviousData,
  });
  /** Which part of a (split) transaction belongs here. */
  const inCategory = useMemo(() => {
    if (row === BILLS) return () => true;
    if (row === HOME) {
      const home = new Set(
        (categories.data ?? [])
          .flatMap((g) => g.categories.filter((c) => c.isHome))
          .map((c) => c.id),
      );
      return (id: string | null) => id !== null && home.has(id);
    }
    if (row === EVERYTHING_ELSE) return (id: string | null) => id === null;
    if (row === OTHER_SPENDING) {
      // Spending categories that aren't bills, and uncategorized.
      const other = new Set(
        (categories.data ?? [])
          .filter((g) => g.kind === "expense")
          .flatMap((g) =>
            g.categories.filter((c) => !c.isBill && !c.isHome && !c.excludeFromBudget),
          )
          .map((c) => c.id),
      );
      return (id: string | null) => id === null || other.has(id);
    }
    if (row === EARNINGS) {
      const income = new Set(
        (categories.data ?? [])
          .filter((g) => g.kind === "income")
          .flatMap((g) => g.categories.map((c) => c.id)),
      );
      return (id: string | null) => id !== null && income.has(id);
    }
    return (id: string | null) => id === categoryId;
  }, [row, categories.data, categoryId]);
  // The budget editor needs the month's full budget line.
  // The month's budget: its line (for the editor) and what's still scheduled.
  const budget = useQuery({
    queryKey: [...keys.budgets, month],
    queryFn: () => api.get<BudgetMonth>(`/api/budgets/${month}`),
  });
  /** Recurring charges or income still expected this month in this category (or row). */
  const scheduled = useMemo(() => {
    const kindOf = new Map(
      (categories.data ?? []).flatMap((g) =>
        g.categories.map(
          (c) => [c.id, { kind: g.kind, excluded: c.excludeFromBudget, home: c.isHome }] as const,
        ),
      ),
    );
    // As the budget counts them: money out in a spending category (or none).
    const spending = (id: string | null) => {
      if (id === null) return true;
      const k = kindOf.get(id);
      return k?.kind === "expense" && !k.excluded;
    };
    const home = (id: string | null) => id !== null && !!kindOf.get(id)?.home;
    return (budget.data?.forecast.scheduled ?? []).filter((s) =>
      row === EARNINGS
        ? s.amountCents > 0
        : row === HOME
          ? s.amountCents < 0 && spending(s.categoryId) && home(s.categoryId)
          : row === BILLS
            ? s.amountCents < 0 && spending(s.categoryId) && !home(s.categoryId)
            : row === EVERYTHING_ELSE
              ? s.amountCents < 0 && s.categoryId === null
              : row === OTHER_SPENDING
                ? false // scheduled charges are recurring bills
                : s.categoryId === categoryId,
    );
  }, [budget.data, categories.data, row, categoryId]);
  /** What the pending rows add to this month (spending out, or income in). */
  const pendingCents = scheduled.reduce(
    (sum, s) => sum + (activity.data?.category.kind === "income" ? s.amountCents : -s.amountCents),
    0,
  );
  const line = budget.data?.groups.flatMap((g) => g.lines).find((l) => l.categoryId === categoryId);

  const a = activity.data;
  const spending = a?.category.kind !== "income";
  const items = useMemo(() => {
    const list = [...(txns.data?.items ?? [])];
    if (sort === "amount")
      list.sort((x, y) => Math.abs(amountIn(y, inCategory)) - Math.abs(amountIn(x, inCategory)));
    return list;
  }, [txns.data, sort, inCategory]);

  const exportUrl = `/api/export/transactions.csv?categoryId=${categoryId}&from=${month}-01&to=${monthEnd(month)}&includeHidden=false`;

  return (
    <>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            to="/budgets"
            aria-label="Back to budgets"
            className="rounded-lg px-2 py-1 text-xl text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            ‹
          </Link>
          <span
            aria-hidden="true"
            className="flex size-11 shrink-0 items-center justify-center rounded-full bg-surface text-xl shadow-sm dark:bg-slate-800"
          >
            <CategoryIcon name={a?.category.name} group={a?.category.groupName} />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-semibold">{a?.category.name ?? "Category"}</h1>
            {a && <p className="text-sm text-slate-500">{a.category.groupName}</p>}
          </div>
          {!virtual && a && (
            <Button
              variant="ghost"
              aria-label="Edit category"
              title="Edit category"
              onClick={() => setEditing(true)}
            >
              ✎
            </Button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* The month, like Budgets: ‹ November 2026 › */}
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              aria-label="Previous month"
              onClick={() => setMonth(shift(month, -1))}
            >
              ‹
            </Button>
            <span className="min-w-36 text-center font-medium">{monthLabel(month)}</span>
            <Button
              variant="ghost"
              aria-label="Next month"
              onClick={() => setMonth(shift(month, 1))}
            >
              ›
            </Button>
            {month !== thisMonth() && (
              <Button variant="ghost" onClick={() => setMonth(thisMonth())}>
                Today
              </Button>
            )}
          </div>
          <a
            hidden={virtual}
            href={exportUrl}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            ⤓ Export
          </a>
        </div>
      </div>
      {activity.isError && <Alert>{activity.error.message}</Alert>}

      {a && (
        <>
          <Card className="mb-6">
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                aria-label="Earlier months"
                onClick={() => setEnd((e) => shift(e, -6))}
              >
                ‹
              </Button>
              <div className="min-w-0 flex-1">
                <ColumnChart
                  ariaLabel={`${a.category.name} ${spending ? "spending" : "income"} by month`}
                  seriesNames={[spending ? "Spent" : "Received"]}
                  selectedKey={month}
                  onSelect={setMonth}
                  data={a.months.map((m) => ({
                    key: m.month,
                    label: monthLabel(m.month, { month: "short" }),
                    title: monthLabel(m.month),
                    values: [Math.max(0, m.cents)],
                    // The selected month once its pending (expected) charges post.
                    ...(m.month === month && pendingCents > 0
                      ? { expected: Math.max(0, m.cents) + pendingCents }
                      : {}),
                  }))}
                />
              </div>
              <Button
                variant="ghost"
                aria-label="Later months"
                disabled={end >= thisMonth()}
                onClick={() =>
                  setEnd((e) => (shift(e, 6) > thisMonth() ? thisMonth() : shift(e, 6)))
                }
              >
                ›
              </Button>
            </div>
            <p className="mt-1 text-center text-xs text-slate-500">
              Click a month to see its transactions.
            </p>
          </Card>

          <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
            <div className="order-2 min-w-0 space-y-3 lg:order-0">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="rounded-full bg-brand-600 px-3 py-1 text-sm font-medium text-on-brand">
                  {monthLabel(month, { month: "long" })} 1 – {monthLabel(month, { month: "long" })}{" "}
                  {Number(monthEnd(month).slice(8))}
                </span>
                <label className="flex items-center gap-2 text-sm">
                  <span className="text-slate-500">Sort by</span>
                  <select
                    value={sort}
                    onChange={(e) => setSort(e.target.value as "date" | "amount")}
                    className="rounded-lg border border-slate-300 bg-surface px-2 py-1 dark:border-slate-700 dark:bg-slate-950"
                  >
                    <option value="date">Date</option>
                    <option value="amount">Amount</option>
                  </select>
                </label>
              </div>
              <Card className="p-0">
                <div className="grid grid-cols-[3rem_minmax(0,1fr)_auto] gap-3 border-b border-slate-200 px-4 py-2.5 text-xs font-medium text-slate-500 dark:border-slate-800">
                  <span>Date</span>
                  <span>Name</span>
                  <span className="text-right">Amount</span>
                </div>
                <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
                  {scheduled.map((s) => (
                    <li
                      key={`${s.seriesId}:${s.date}`}
                      className="grid grid-cols-[3rem_minmax(0,1fr)_auto] items-center gap-3 bg-slate-50/60 px-4 py-2.5 dark:bg-slate-800/30"
                    >
                      <span className="text-slate-500 tabular-nums">{shortDay(s.date)}</span>
                      <span className="flex min-w-0 items-center gap-3">
                        <MerchantAvatar name={s.name} size="sm" />
                        <span className="min-w-0">
                          <span className="block truncate text-slate-600 dark:text-slate-300">
                            {s.name}
                          </span>
                          <span className="flex items-center gap-1.5 text-xs text-slate-500">
                            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                              Pending
                            </span>
                            Expected {shortDay(s.date)} ·
                            <CategorySelect
                              aria-label={`Category for ${s.name}`}
                              value={s.categoryId}
                              onChange={(id) => {
                                updateSeries.mutate({
                                  id: s.seriesId,
                                  categoryId: id,
                                  applyToTransactions: true,
                                });
                                offerRule(
                                  {
                                    id: s.seriesId,
                                    payeeName: s.name,
                                    description: s.name,
                                    rawDescription: s.name,
                                  },
                                  id,
                                );
                              }}
                              className={cx(
                                "max-w-44 truncate rounded border border-transparent px-1 py-0.5 text-left text-xs hover:border-slate-300 dark:hover:border-slate-700",
                                s.categoryId
                                  ? "text-brand-600 dark:text-brand-500"
                                  : "text-amber-600",
                              )}
                            />
                          </span>
                        </span>
                      </span>
                      <span
                        className={cx(
                          "text-right tabular-nums text-slate-500",
                          s.amountCents > 0 && "text-emerald-700/80 dark:text-emerald-400/80",
                        )}
                      >
                        {s.amountCents > 0 ? "+" : ""}
                        {formatMoney(Math.abs(s.amountCents))}
                      </span>
                    </li>
                  ))}
                  {items.map((t) => {
                    const part = amountIn(t, inCategory);
                    const name = t.payeeName ?? t.description;
                    return (
                      <li
                        key={t.id}
                        className="grid grid-cols-[3rem_minmax(0,1fr)_auto] items-center gap-3 px-4 py-2.5"
                      >
                        <span className="text-slate-500 tabular-nums">
                          {shortDay(t.postedDate)}
                        </span>
                        <span className="flex min-w-0 items-center gap-3">
                          <MerchantAvatar name={name} size="sm" />
                          <span className="min-w-0">
                            <span className="block truncate">
                              {name}
                              {t.pending && <span className="text-slate-500"> | Pending</span>}
                            </span>
                            <span className="flex min-w-0 items-center gap-1 text-xs text-slate-500">
                              <span className="truncate">{t.accountName}</span>
                              {t.splits.length > 0 ? (
                                <span className="shrink-0">
                                  · split, {formatMoney(Math.abs(t.amountCents))} total
                                </span>
                              ) : (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <CategorySelect
                                    aria-label={`Category for ${name}`}
                                    value={t.categoryId}
                                    onChange={(id) => {
                                      update.mutate({ id: t.id, categoryId: id });
                                      offerRule(t, id);
                                    }}
                                    className={cx(
                                      "max-w-44 truncate rounded border border-transparent px-1 py-0.5 text-left text-xs hover:border-slate-300 dark:hover:border-slate-700",
                                      t.categoryId
                                        ? "text-brand-600 dark:text-brand-500"
                                        : "text-amber-600",
                                    )}
                                  />
                                </>
                              )}
                            </span>
                          </span>
                        </span>
                        <span
                          className={cx(
                            "flex items-center justify-end gap-1 text-right font-medium tabular-nums",
                            part > 0 && "text-emerald-700 dark:text-emerald-400",
                          )}
                        >
                          <FindSimilar payeeName={t.payeeName} description={t.rawDescription} />
                          {part > 0 ? "+" : ""}
                          {formatMoney(Math.abs(part))}
                        </span>
                      </li>
                    );
                  })}
                  {txns.isSuccess && items.length === 0 && scheduled.length === 0 && (
                    <li className="px-4 py-6 text-center text-slate-500">
                      Nothing in {a.category.name} in {monthLabel(month)}.
                    </li>
                  )}
                </ul>
                {!virtual && (txns.data?.total ?? 0) > items.length && (
                  <div className="border-t border-slate-200 px-4 py-2 text-sm dark:border-slate-800">
                    <Link
                      to="/transactions"
                      search={{ categoryId, from: `${month}-01`, to: monthEnd(month) }}
                      className="text-brand-600 hover:underline"
                    >
                      See all {txns.data?.total} on the Transactions page
                    </Link>
                  </div>
                )}
              </Card>
              {virtual ? (
                <p className="text-sm text-slate-500">
                  {row === EVERYTHING_ELSE
                    ? "Change a transaction's category above to move it out of Everything else."
                    : "Change a transaction's category above if it's in the wrong one."}
                </p>
              ) : (
                <Link
                  to="/transactions"
                  search={{ categoryId, from: `${month}-01`, to: monthEnd(month) }}
                  className="inline-block text-sm text-brand-600 hover:underline"
                >
                  Edit these on the Transactions page
                </Link>
              )}
            </div>

            <div className="order-1 space-y-6 lg:order-0">
              {virtual && (
                <Card className="text-sm text-slate-600 dark:text-slate-300">
                  {row === EVERYTHING_ELSE &&
                    "Everything else is spending with no category. Pick a category for each transaction to move it into that category's budget."}
                  {row === EARNINGS &&
                    "Earnings is money in your income categories (pay, interest, refunds you filed as income). Its budget is the income you've received plus what your recurring income should still bring."}
                  {row === OTHER_SPENDING &&
                    "All other categories is your spending that isn't a bill or a home cost: everything in your spending categories (and uncategorized) except recurring bills, bill categories and home categories. Its budget adds up the budgets of the rest of your categories."}
                  {row === HOME &&
                    "Home & utilities is what keeps your home running: rent or mortgage, power, gas, water, trash, internet and phone. It's everything in your home categories, recurring or not, and those charges don't count again in Bills & subscriptions. Its budget adds up the budgets of your home categories."}
                  {row === BILLS && (
                    <>
                      Bills & subscriptions are charges from the recurring bills and subscriptions
                      Muny found. Manage them on the{" "}
                      <Link to="/recurring" className="text-brand-600 hover:underline">
                        Recurring
                      </Link>{" "}
                      page. Home costs like rent and power count in Home & utilities instead. Its
                      budget adds up the budgets of your bill categories.
                    </>
                  )}
                </Card>
              )}
              {spending && !virtual && (
                <div>
                  <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                    {monthLabel(month, { month: "long" })} budget
                  </h2>
                  <Card className="p-0">
                    {a.budget ? (
                      (() => {
                        const limit = a.budget.budgetCents + a.budget.rolloverCents;
                        const left = a.budget.availableCents;
                        return (
                          <>
                            <div className="flex justify-center px-4 pt-6 pb-4">
                              <Ring used={a.stats.totalCents} limit={limit} size={170} stroke={11}>
                                <span className="text-xs text-slate-500">
                                  {left < 0 ? "Over by" : "Left to spend"}
                                </span>
                                <span
                                  className={cx(
                                    "text-2xl font-semibold tabular-nums",
                                    left < 0 && "text-red-600 dark:text-red-400",
                                  )}
                                >
                                  {formatMoney(Math.abs(left))}
                                </span>
                                <span className="text-xs text-slate-500">
                                  of {formatMoney(limit)}
                                </span>
                              </Ring>
                            </div>
                            <dl className="divide-y divide-slate-100 border-t border-slate-200 text-sm dark:divide-slate-800 dark:border-slate-800">
                              {[
                                ["⊕", "Spending budget", formatMoney(limit), ""],
                                ["⊖", "Current spend", formatMoney(a.stats.totalCents), ""],
                                [
                                  "⊜",
                                  "Remaining",
                                  `${left < 0 ? "−" : ""}${formatMoney(Math.abs(left))}`,
                                  left < 0
                                    ? "text-red-600 dark:text-red-400"
                                    : "text-emerald-700 dark:text-emerald-400",
                                ],
                              ].map(([icon, k, v, cls]) => (
                                <div key={k} className="flex justify-between gap-3 px-4 py-3">
                                  <dt className="flex items-center gap-2">
                                    <span
                                      aria-hidden="true"
                                      className="w-4 text-center text-slate-400"
                                    >
                                      {icon}
                                    </span>
                                    {k}
                                  </dt>
                                  <dd className={cx("font-semibold tabular-nums", cls)}>{v}</dd>
                                </div>
                              ))}
                            </dl>
                          </>
                        );
                      })()
                    ) : (
                      <p className="px-4 py-4 text-sm text-slate-500">
                        No budget for this category.
                      </p>
                    )}
                    <div className="border-t border-slate-200 px-4 py-3 dark:border-slate-800">
                      <Button variant="secondary" onClick={() => setEditing(true)}>
                        {a.budget ? "Edit budget" : "Set a budget"}
                      </Button>
                    </div>
                  </Card>
                </div>
              )}
              <div>
                <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Summary
                </h2>
                <Card className="p-0">
                  <dl className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
                    {[
                      ["Total transactions", String(a.stats.count)],
                      ["Average transaction", formatMoney(a.stats.averageCents)],
                      ["Largest transaction", formatMoney(a.stats.largestCents)],
                      ["Total amount", formatMoney(a.stats.totalCents)],
                    ].map(([k, v]) => (
                      <div key={k} className="flex justify-between gap-3 px-4 py-3">
                        <dt>{k}</dt>
                        <dd className="font-semibold tabular-nums">{v}</dd>
                      </div>
                    ))}
                  </dl>
                </Card>
              </div>
            </div>
          </div>
        </>
      )}
      {offerNode}
      {ruleDialog}
      {!virtual && (
        <EditCategoryDialog
          categoryId={categoryId}
          line={line}
          month={month}
          open={editing}
          onClose={() => setEditing(false)}
          onDeleted={() => {
            setEditing(false);
            void navigate({ to: "/budgets" });
          }}
        />
      )}
    </>
  );
}

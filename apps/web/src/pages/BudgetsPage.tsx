import {
  BILLS,
  type BudgetMonth,
  EARNINGS,
  EVERYTHING_ELSE,
  formatMoney,
  OTHER_SPENDING,
} from "@muny/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { EditBudget, InlineBudget, Ring } from "../components/budget.js";
import { Alert, Button, Card, cx, PageHeader } from "../components/ui.js";
import { CategoryIcon, MerchantAvatar } from "../components/visuals.js";
import { api } from "../lib/api.js";
import {
  keys,
  useCategories,
  useDeleteBudget,
  useSetBudget,
  useUpdateCategory,
} from "../lib/queries.js";

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
const monthEndIso = (m: string) => {
  const [y, mo] = m.split("-").map(Number) as [number, number];
  return `${m}-${pad(new Date(y, mo, 0).getDate())}`;
};
const signed = (cents: number) => `${cents < 0 ? "−" : ""}${formatMoney(Math.abs(cents))}`;

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

const ROW =
  // Phones: name on its own line, the three amounts underneath. Wider: one row.
  "grid grid-cols-3 items-center gap-x-3 gap-y-1.5 sm:gap-x-4 sm:grid-cols-[minmax(0,1fr)_8rem_7rem_7rem_1.5rem]";
const NAME_CELL = "col-span-3 sm:col-span-1";

function TableHead({ first }: { first: string }) {
  return (
    <div
      className={cx(
        ROW,
        "border-b border-slate-200 px-4 py-2.5 text-xs font-medium text-slate-500 dark:border-slate-800",
      )}
    >
      <span className={NAME_CELL}>{first}</span>
      <span className="sm:text-right">Budgeted</span>
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

/** "+ bill category": mark another spending category as a bill. */
function AddBillCategory() {
  const groups = useCategories().data ?? [];
  const update = useUpdateCategory();
  const [open, setOpen] = useState(false);
  const options = groups
    .filter((g) => g.kind === "expense")
    .flatMap((g) =>
      g.categories
        .filter((c) => !c.isBill && !c.excludeFromBudget && !c.hidden)
        .map((c) => ({ ...c, group: g.name })),
    );
  if (!open)
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-brand-600 hover:underline dark:text-brand-500"
      >
        + bill category
      </button>
    );
  return (
    <select
      aria-label="Category to count as a bill"
      // biome-ignore lint/a11y/noAutofocus: opened by a click to pick right away
      autoFocus
      value=""
      onBlur={() => setOpen(false)}
      onChange={(e) => {
        if (e.target.value) update.mutate({ id: e.target.value, isBill: true });
        setOpen(false);
      }}
      className="max-w-48 rounded border border-slate-300 bg-white px-1 py-0.5 text-xs dark:border-slate-700 dark:bg-slate-950"
    >
      <option value="">Count as a bill…</option>
      {options.map((c) => (
        <option key={c.id} value={c.id}>
          {c.group} · {c.name}
        </option>
      ))}
    </select>
  );
}

/**
 * Budget basics, worked out rather than typed in: earnings is the income
 * expected this month; bills and all other categories add up the budgets of
 * the categories below (bill categories, and the rest).
 */
function BasicsTable({ b, month }: { b: BudgetMonth; month: string }) {
  const f = b.forecast;
  const past = f.period === "past";
  const lines = b.groups.flatMap((g) => g.lines);
  const budgeted = (bill: boolean) =>
    lines.filter((l) => l.isBill === bill && l.budgetCents !== null).length;
  const billCount = lines.filter((l) => l.isBill).length;
  const rows = [
    {
      key: "earnings",
      icon: "💰",
      name: "Earnings",
      note: past
        ? "Income received"
        : f.incomeExpectedCents > 0
          ? `${formatMoney(f.incomeSoFarCents)} so far, ${formatMoney(f.incomeExpectedCents)} more expected`
          : `Usually about ${formatMoney(f.incomeAverageCents)}/mo`,
      line: b.income,
      basis: "Income received plus what your recurring income should still bring",
    },
    {
      key: "bills",
      icon: "🧾",
      name: "Bills & subscriptions",
      note: (
        <>
          {budgeted(true)
            ? `Budgets of ${budgeted(true)} bill categor${budgeted(true) === 1 ? "y" : "ies"}`
            : billCount
              ? "Give your bill categories a budget below"
              : "No bill categories yet"}
          {" · "}
          <AddBillCategory />
        </>
      ),
      line: b.bills,
      basis: "Your bill categories' budgets added up",
    },
    {
      key: "other",
      icon: "🛒",
      name: "All other categories",
      note: budgeted(false)
        ? `Budgets of ${budgeted(false)} other categor${budgeted(false) === 1 ? "y" : "ies"}`
        : "Give categories a budget below",
      line: b.other,
      basis: "Your other categories' budgets added up",
    },
  ];
  const pageFor = { earnings: EARNINGS, bills: BILLS, other: OTHER_SPENDING } as const;
  return (
    <Card className="p-0">
      <TableHead first="Budget basics" />
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {rows.map((r) => {
          const target = r.line.budgetCents;
          const actual = r.line.spentCents;
          return (
            <li key={r.key} className={cx(ROW, "px-4 py-3")}>
              <span className={cx(NAME_CELL, "flex min-w-0 items-center gap-3")}>
                <span
                  aria-hidden="true"
                  className="flex size-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-lg dark:bg-slate-800"
                >
                  {r.icon}
                </span>
                <span className="min-w-0">
                  <Link
                    to="/categories/$categoryId"
                    params={{ categoryId: pageFor[r.key as keyof typeof pageFor] }}
                    search={{ month }}
                    className="block truncate font-medium underline-offset-2 hover:underline"
                  >
                    {r.name}
                  </Link>
                  <span className="block truncate text-xs text-slate-500">{r.note}</span>
                </span>
              </span>
              <span
                className="text-slate-600 tabular-nums sm:text-right dark:text-slate-300"
                title={r.basis}
              >
                {target === null ? <span className="text-slate-400">—</span> : formatMoney(target)}
              </span>
              <span className="text-right tabular-nums">{formatMoney(actual)}</span>
              <Remaining
                cents={target === null ? null : target - actual}
                muted={r.key === "earnings"}
              />
              <span className="hidden sm:block">
                {target !== null && <Ring used={actual} limit={target} />}
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function CategoriesTable({ b, month }: { b: BudgetMonth; month: string }) {
  const [showAll, setShowAll] = useState(false);
  const scheduled = b.forecast.scheduledByCategory;
  const updateCategory = useUpdateCategory();
  const lines = b.groups.flatMap((g) => g.lines.map((l) => ({ ...l, groupName: g.name })));
  // Categories with a budget, spending or a scheduled charge this month; the
  // rest until "show more". Uncategorized spending is "Everything else".
  const budgeted = lines.filter((l) => l.budgetCents !== null);
  // Scheduled charges count too: that spending is expected this month.
  const active = lines.filter(
    (l) => l.budgetCents !== null || l.spentCents !== 0 || (scheduled[l.categoryId ?? ""] ?? 0) > 0,
  );
  const quiet = lines.length - active.length;
  const shown = showAll ? lines : active;
  const otherSpent = b.uncategorizedCents;
  return (
    <Card className="p-0">
      <TableHead first="Budget categories" />
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {shown.map((l) => {
          const id = l.categoryId ?? "";
          const limit = (l.budgetCents ?? 0) + l.rolloverCents;
          const due = scheduled[id] ?? 0;
          return (
            <li
              key={id}
              className={cx(ROW, "px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-800/50")}
            >
              <span className={cx(NAME_CELL, "flex min-w-0 items-center gap-3")}>
                <span
                  aria-hidden="true"
                  className="flex size-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-base dark:bg-slate-800"
                >
                  <CategoryIcon name={l.name} group={l.groupName} />
                </span>
                <span className="min-w-0">
                  <Link
                    to="/categories/$categoryId"
                    params={{ categoryId: id }}
                    search={{ month }}
                    className="block truncate font-medium underline-offset-2 hover:underline"
                  >
                    {l.name}
                  </Link>
                  <span className="block truncate text-xs text-slate-500">
                    {l.isBill && (
                      <button
                        type="button"
                        onClick={() => updateCategory.mutate({ id, isBill: false })}
                        title="Counts toward Bills & subscriptions. Click to stop."
                        className="mr-1.5 rounded bg-brand-50 px-1.5 py-px text-[10px] font-medium text-brand-700 hover:bg-brand-100 dark:bg-brand-700/20 dark:text-brand-500"
                      >
                        Bill
                      </button>
                    )}
                    {due > 0 && `${formatMoney(due)} more scheduled`}
                    {due > 0 && l.rollover && l.rolloverCents !== 0 && " · "}
                    {l.rollover &&
                      l.rolloverCents !== 0 &&
                      `${signed(l.rolloverCents)} rolled over`}
                  </span>
                </span>
              </span>
              <InlineBudget line={l} month={month} />
              <span className="text-right tabular-nums">{formatMoney(l.spentCents)}</span>
              <Remaining cents={l.availableCents} />
              <span className="hidden sm:block">
                {l.budgetCents !== null && <Ring used={l.spentCents} limit={limit} />}
              </span>
            </li>
          );
        })}
      </ul>
      {otherSpent !== 0 && (
        <div className={cx(ROW, "border-t border-slate-100 px-4 py-3 dark:border-slate-800")}>
          <span className={cx(NAME_CELL, "flex min-w-0 items-center gap-3")}>
            <span
              aria-hidden="true"
              className="flex size-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-base dark:bg-slate-800"
            >
              ⋯
            </span>
            <span className="min-w-0">
              <Link
                to="/categories/$categoryId"
                params={{ categoryId: EVERYTHING_ELSE }}
                search={{ month }}
                className="block truncate font-medium underline-offset-2 hover:underline"
              >
                Everything else
              </Link>
              <span className="block truncate text-xs text-slate-500">
                Spending with no category
              </span>
            </span>
          </span>
          <span className="text-slate-400 sm:text-right">—</span>
          <span className="text-right tabular-nums">{formatMoney(otherSpent)}</span>
          <span />
          <span className="hidden sm:block" />
        </div>
      )}
      {budgeted.length === 0 && (
        <p className="border-t border-slate-100 px-4 py-4 text-sm text-slate-500 dark:border-slate-800">
          No category budgets yet. Click a category's Budgeted amount to set one.
        </p>
      )}
      {quiet > 0 && (
        <div className="border-t border-slate-200 px-4 py-2 dark:border-slate-800">
          <Button variant="ghost" onClick={() => setShowAll((s) => !s)}>
            {showAll
              ? "Hide categories with no budget, spending or scheduled charges"
              : `Show ${quiet} more categor${quiet === 1 ? "y" : "ies"} (no budget, spending or scheduled charges)`}
          </Button>
        </div>
      )}
    </Card>
  );
}

/** Categories left out of budgets (reimbursements, business costs…), and leaving one out. */
function ExcludedCard({ b }: { b: BudgetMonth }) {
  const groups = useCategories().data ?? [];
  const update = useUpdateCategory();
  const [pick, setPick] = useState("");
  const options = groups
    .filter((g) => g.kind === "expense")
    .flatMap((g) =>
      g.categories.filter((c) => !c.excludeFromBudget).map((c) => ({ ...c, group: g.name })),
    );
  return (
    <Card>
      <p className="font-semibold">Left out of budgets</p>
      <p className="mt-1 text-xs text-slate-500">
        Spending in these categories isn't counted in your budgets, totals or forecast (for example
        reimbursed work expenses). It still shows in Spending and Reports.
      </p>
      {b.excluded.length > 0 && (
        <ul className="mt-3 divide-y divide-slate-100 text-sm dark:divide-slate-800">
          {b.excluded.map((c) => (
            <li key={c.categoryId} className="flex items-center justify-between gap-3 py-2">
              <span className="min-w-0 truncate">
                {c.name}
                <span className="ml-1 text-xs text-slate-500">{c.groupName}</span>
              </span>
              <span className="flex shrink-0 items-center gap-3">
                <span className="tabular-nums text-slate-600 dark:text-slate-300">
                  {formatMoney(c.spentCents)}
                </span>
                <Button
                  variant="ghost"
                  disabled={update.isPending}
                  onClick={() => update.mutate({ id: c.categoryId, excludeFromBudget: false })}
                >
                  Include
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <form
        className="mt-3 flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!pick) return;
          update.mutate({ id: pick, excludeFromBudget: true });
          setPick("");
        }}
      >
        <select
          aria-label="Category to leave out of budgets"
          value={pick}
          onChange={(e) => setPick(e.target.value)}
          className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950"
        >
          <option value="">Leave a category out…</option>
          {options.map((c) => (
            <option key={c.id} value={c.id}>
              {c.group} · {c.name}
            </option>
          ))}
        </select>
        <Button type="submit" variant="secondary" disabled={!pick || update.isPending}>
          Leave out
        </Button>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Summary & forecast
// ---------------------------------------------------------------------------

/**
 * A spending total you set, against what your category budgets add up to: a
 * bar of how much of it the categories plan, what's unassigned (or how far
 * over they go), and one click to follow the categories or match them.
 */
function Allocation({ b, month }: { b: BudgetMonth; month: string }) {
  const set = useSetBudget();
  const del = useDeleteBudget();
  const total = b.total.budgetCents;
  const planned = b.budgetedCents;
  if (total === null || total === planned) return null;
  const over = planned > total;
  const diff = Math.abs(planned - total);
  const width = (v: number) => `${Math.min(100, (v / Math.max(total, planned, 1)) * 100)}%`;
  const busy = set.isPending || del.isPending;
  return (
    <div className="space-y-2 px-4 py-3">
      <div
        className="relative h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700"
        role="img"
        aria-label={`Categories plan ${formatMoney(planned)} of a ${formatMoney(total)} spending budget`}
      >
        <div
          className={cx(
            "absolute inset-y-0 left-0 rounded-full",
            over ? "bg-red-500" : "bg-brand-600",
          )}
          style={{ width: width(planned) }}
        />
        {over && (
          // Where the spending budget ends.
          <div
            className="absolute inset-y-0 w-0.5 bg-white dark:bg-slate-950"
            style={{ left: width(total) }}
          />
        )}
      </div>
      <p className="text-xs text-slate-600 dark:text-slate-300">
        {over ? (
          <>
            Your categories add up to <strong>{formatMoney(planned)}</strong>,{" "}
            <span className="text-red-600 dark:text-red-400">{formatMoney(diff)} more</span> than
            this spending budget.
          </>
        ) : (
          <>
            Your categories plan <strong>{formatMoney(planned)}</strong> of it:{" "}
            <span className="text-amber-700 dark:text-amber-400">{formatMoney(diff)}</span> isn't
            assigned to a category.
          </>
        )}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          disabled={busy || !b.total.budgetId}
          onClick={() => b.total.budgetId && del.mutate(b.total.budgetId)}
        >
          Follow my categories
        </Button>
        <Button
          variant="ghost"
          disabled={busy || planned <= 0}
          onClick={() =>
            set.mutate({
              categoryId: null,
              kind: "spending",
              amountCents: planned,
              rollover: b.total.rollover,
              fromMonth: month,
            })
          }
        >
          Match categories ({formatMoney(planned)})
        </Button>
      </div>
    </div>
  );
}

function SummaryCard({ b, month }: { b: BudgetMonth; month: string }) {
  const [editTotal, setEditTotal] = useState(false);
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
          <dd className="text-right">
            <span className="font-semibold tabular-nums">{formatMoney(budget)}</span>
            {b.total.budgetCents == null && budget > 0 && (
              <span className="block text-[11px] text-slate-500">your categories added up</span>
            )}
          </dd>
        </div>
        <Allocation b={b} month={month} />
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
          <Link
            to="/transactions"
            search={{
              categoryId: "uncategorized",
              from: `${b.month}-01`,
              to: monthEndIso(b.month),
            }}
            className="underline"
          >
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
          <div className="order-2 space-y-6 lg:order-0">
            <BasicsTable b={b} month={month} />
            <CategoriesTable b={b} month={month} />
            <ExcludedCard b={b} />
          </div>
          <div className="order-1 space-y-6 lg:sticky lg:top-6 lg:order-0">
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

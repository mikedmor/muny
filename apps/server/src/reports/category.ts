import type { MunyDb } from "@muny/db";
import {
  BILLS,
  BUDGET_ROWS,
  type BudgetRowId,
  type CategoryActivity,
  EARNINGS,
  EVERYTHING_ELSE,
  HOME,
  OTHER_SPENDING,
} from "@muny/shared";
import { sql } from "drizzle-orm";
import {
  billCharges,
  billsPaidByMonth,
  budgetMonth,
  homeCharges,
  homePaidByMonth,
  otherSpending,
  otherSpentByMonth,
} from "../budgets/service.js";
import {
  addMonths,
  categoryMeta,
  monthEnd,
  monthlyCategoryTotals,
  monthsBetween,
} from "./spending.js";

/**
 * A category's activity: monthly totals for a chart, the budget for the
 * selected month, and count/average/largest for that month. Split parts count
 * toward their own category; hidden transactions and excluded accounts don't.
 */
export function categoryActivity(
  db: MunyDb,
  categoryId: string,
  month: string,
  end: string,
  span = 12,
): CategoryActivity | null {
  const meta = categoryMeta(db).get(categoryId);
  if (!meta) return null;
  const sign = meta.kind === "income" ? 1 : -1;
  const first = addMonths(end, -(span - 1));
  const byMonth = new Map<string, number>();
  for (const t of monthlyCategoryTotals(db, `${first}-01`, monthEnd(end))) {
    if (t.categoryId === categoryId)
      byMonth.set(t.month, (byMonth.get(t.month) ?? 0) + sign * t.cents);
  }

  const parts = db.all<{ cents: number }>(sql`
    select t.amount_cents as cents
      from transactions t join accounts a on a.id = t.account_id
     where t.hidden = 0 and a.exclude_from_reports = 0 and t.category_id = ${categoryId}
       and t.posted_date between ${`${month}-01`} and ${monthEnd(month)}
       and not exists (select 1 from transaction_splits x where x.transaction_id = t.id)
    union all
    select sp.amount_cents as cents
      from transaction_splits sp
      join transactions t on t.id = sp.transaction_id
      join accounts a on a.id = t.account_id
     where t.hidden = 0 and a.exclude_from_reports = 0 and sp.category_id = ${categoryId}
       and t.posted_date between ${`${month}-01`} and ${monthEnd(month)}
  `);
  const amounts = parts.map((p) => sign * Number(p.cents));
  const total = amounts.reduce((s, x) => s + x, 0);

  let budget: CategoryActivity["budget"] = null;
  if (meta.kind === "expense") {
    const line = budgetMonth(db, month)
      .groups.flatMap((g) => g.lines)
      .find((l) => l.categoryId === categoryId);
    if (line && line.budgetCents !== null)
      budget = {
        budgetCents: line.budgetCents,
        rolloverCents: line.rolloverCents,
        availableCents: line.availableCents ?? 0,
      };
  }

  return {
    category: { id: meta.id, name: meta.name, groupName: meta.groupName, kind: meta.kind },
    month,
    months: monthsBetween(first, end).map((m) => ({ month: m, cents: byMonth.get(m) ?? 0 })),
    budget,
    stats: {
      count: amounts.length,
      totalCents: total,
      averageCents: amounts.length ? Math.round(total / amounts.length) : 0,
      largestCents: amounts.length ? Math.max(...amounts) : 0,
    },
  };
}

/** A SQL list of ids; "-" keeps it valid when empty (no id is "-"). */
const idList = (ids: string[]) =>
  sql.join(
    ["-", ...ids].map((id) => sql`${id}`),
    sql`, `,
  );

/** Transactions (or split parts) in a month whose category is in the list, or uncategorized. */
function partsIn(db: MunyDb, month: string, ids: string[] | "uncategorized") {
  const nonSplit =
    ids === "uncategorized"
      ? sql`t.category_id is null and t.transfer_pair_id is null`
      : sql`t.category_id in (${idList(ids)})`;
  const split =
    ids === "uncategorized" ? sql`sp.category_id is null` : sql`sp.category_id in (${idList(ids)})`;
  return db
    .all<{ cents: number }>(sql`
    select t.amount_cents as cents
      from transactions t join accounts a on a.id = t.account_id
     where t.hidden = 0 and a.exclude_from_reports = 0 and a.type <> 'loan'
       and ${nonSplit}
       and t.posted_date between ${`${month}-01`} and ${monthEnd(month)}
       and not exists (select 1 from transaction_splits x where x.transaction_id = t.id)
    union all
    select sp.amount_cents as cents
      from transaction_splits sp
      join transactions t on t.id = sp.transaction_id
      join accounts a on a.id = t.account_id
     where t.hidden = 0 and a.exclude_from_reports = 0 and a.type <> 'loan'
       and ${split}
       and t.posted_date between ${`${month}-01`} and ${monthEnd(month)}
  `)
    .map((p) => Number(p.cents));
}

const BUDGET_ROW_LABELS: Record<BudgetRowId, CategoryActivity["category"]> = {
  [EVERYTHING_ELSE]: {
    id: EVERYTHING_ELSE,
    name: "Everything else",
    groupName: "Spending with no category",
    kind: "expense",
  },
  [EARNINGS]: {
    id: EARNINGS,
    name: "Earnings",
    groupName: "Money in your income categories",
    kind: "income",
  },
  [OTHER_SPENDING]: {
    id: OTHER_SPENDING,
    name: "All other categories",
    groupName: "Spending that isn't a bill or a home cost",
    kind: "expense",
  },
  [HOME]: {
    id: HOME,
    name: "Home & utilities",
    groupName: "Rent, utilities, internet and phone: your home categories",
    kind: "expense",
  },
  [BILLS]: {
    id: BILLS,
    name: "Bills & subscriptions",
    groupName: "Recurring bills and subscriptions, and your bill categories",
    kind: "expense",
  },
};

export const isBudgetRow = (id: string): id is BudgetRowId =>
  (BUDGET_ROWS as readonly string[]).includes(id);

/**
 * A budget page row as a category, matching the row's numbers: Everything
 * else (uncategorized spending), Earnings (income categories) and Bills &
 * subscriptions (charges from recurring bills), month by month.
 */
export function budgetRowActivity(
  db: MunyDb,
  row: BudgetRowId,
  month: string,
  end: string,
  span = 12,
): CategoryActivity {
  const first = addMonths(end, -(span - 1));
  const months = monthsBetween(first, end);
  const byMonth = new Map<string, number>();
  let amounts: number[];
  if (row === OTHER_SPENDING) {
    for (const [m, cents] of otherSpentByMonth(db, months)) byMonth.set(m, cents);
    amounts = otherSpending(db, `${month}-01`, monthEnd(month)).map((c) => c.cents);
  } else if (row === HOME) {
    for (const [m, cents] of homePaidByMonth(db, months)) byMonth.set(m, cents);
    amounts = homeCharges(db, `${month}-01`, monthEnd(month)).map((c) => c.cents);
  } else if (row === BILLS) {
    for (const [m, cents] of billsPaidByMonth(db, months)) byMonth.set(m, cents);
    amounts = billCharges(db, `${month}-01`, monthEnd(month)).map((c) => c.cents);
  } else {
    const meta = categoryMeta(db);
    const income = [...meta.values()].filter((c) => c.kind === "income").map((c) => c.id);
    const sign = row === EARNINGS ? 1 : -1;
    for (const t of monthlyCategoryTotals(db, `${first}-01`, monthEnd(end))) {
      const counts =
        row === EARNINGS
          ? t.categoryId !== null && meta.get(t.categoryId)?.kind === "income"
          : t.categoryId === null;
      if (counts) byMonth.set(t.month, (byMonth.get(t.month) ?? 0) + sign * t.cents);
    }
    amounts = partsIn(db, month, row === EARNINGS ? income : "uncategorized").map((c) => sign * c);
  }
  const total = amounts.reduce((s, x) => s + x, 0);
  return {
    category: BUDGET_ROW_LABELS[row],
    month,
    months: months.map((m) => ({ month: m, cents: byMonth.get(m) ?? 0 })),
    budget: null,
    stats: {
      count: amounts.length,
      totalCents: total,
      averageCents: amounts.length ? Math.round(total / amounts.length) : 0,
      largestCents: amounts.length ? Math.max(...amounts) : 0,
    },
  };
}

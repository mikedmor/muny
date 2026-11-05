import type { MunyDb } from "@muny/db";
import type { CategoryActivity } from "@muny/shared";
import { sql } from "drizzle-orm";
import { budgetMonth } from "../budgets/service.js";
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

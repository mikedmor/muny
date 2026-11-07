import { type MunyDb, schema } from "@muny/db";
import { eq, sql } from "drizzle-orm";

type Db = MunyDb | Parameters<Parameters<MunyDb["transaction"]>[0]>[0];

/**
 * Net amount per (month, category), the basis for budgets and reports.
 *
 * - Split transactions count by their parts.
 * - Hidden transactions and accounts marked "exclude from reports" are left out.
 * - Uncategorized money that's part of a detected transfer is keyed "__transfer"
 *   so callers can drop it.
 * - Amounts are signed (spending negative, refunds positive), so refunds
 *   reduce a category's spending.
 */
export interface MonthCategoryTotal {
  month: string;
  categoryId: string | null;
  cents: number;
}

export const TRANSFER_KEY = "__transfer";

export function monthlyCategoryTotals(
  db: Db,
  fromDate: string,
  toDate: string,
): MonthCategoryTotal[] {
  return categoryTotals(db, fromDate, toDate, 7);
}

/** Same as monthlyCategoryTotals, but `month` holds the day (YYYY-MM-DD). */
export function dailyCategoryTotals(
  db: Db,
  fromDate: string,
  toDate: string,
): MonthCategoryTotal[] {
  return categoryTotals(db, fromDate, toDate, 10);
}

function categoryTotals(
  db: Db,
  fromDate: string,
  toDate: string,
  keyLength: 7 | 10,
): MonthCategoryTotal[] {
  const rows = db.all<{ m: string; c: string | null; s: number }>(sql`
    select substr(t.posted_date, 1, ${keyLength}) as m,
           case when t.category_id is null and t.transfer_pair_id is not null then ${TRANSFER_KEY}
                else t.category_id end as c,
           sum(t.amount_cents) as s
      from transactions t
      join accounts a on a.id = t.account_id
     where t.hidden = 0 and a.exclude_from_reports = 0 and a.type <> 'loan'
       and t.posted_date >= ${fromDate} and t.posted_date <= ${toDate}
       and not exists (select 1 from transaction_splits x where x.transaction_id = t.id)
     group by m, c
    union all
    select substr(t.posted_date, 1, ${keyLength}) as m, sp.category_id as c, sum(sp.amount_cents) as s
      from transaction_splits sp
      join transactions t on t.id = sp.transaction_id
      join accounts a on a.id = t.account_id
     where t.hidden = 0 and a.exclude_from_reports = 0 and a.type <> 'loan'
       and t.posted_date >= ${fromDate} and t.posted_date <= ${toDate}
     group by m, c
  `);
  // Merge the two halves (a month/category can appear in both).
  const merged = new Map<string, MonthCategoryTotal>();
  for (const r of rows) {
    const k = `${r.m}|${r.c ?? ""}`;
    const cur = merged.get(k);
    if (cur) cur.cents += Number(r.s);
    else merged.set(k, { month: r.m, categoryId: r.c, cents: Number(r.s) });
  }
  return [...merged.values()];
}

export interface CategoryMeta {
  id: string;
  name: string;
  groupId: string;
  groupName: string;
  kind: "expense" | "income" | "transfer";
  hidden: boolean;
  excludeFromBudget: boolean;
  isBill: boolean;
  isHome: boolean;
  groupSort: number;
  sort: number;
}

export function categoryMeta(db: Db): Map<string, CategoryMeta> {
  return new Map(
    db
      .select({
        id: schema.categories.id,
        name: schema.categories.name,
        hidden: schema.categories.hidden,
        excludeFromBudget: schema.categories.excludeFromBudget,
        isBill: schema.categories.isBill,
        isHome: schema.categories.isHome,
        sort: schema.categories.sortOrder,
        groupId: schema.categoryGroups.id,
        groupName: schema.categoryGroups.name,
        kind: schema.categoryGroups.kind,
        groupSort: schema.categoryGroups.sortOrder,
      })
      .from(schema.categories)
      .innerJoin(schema.categoryGroups, eq(schema.categoryGroups.id, schema.categories.groupId))
      .all()
      .map((c) => [c.id, c]),
  );
}

/** YYYY-MM helpers */
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const total = y * 12 + (m - 1) + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

export function monthEnd(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
}

export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = from; m <= to && out.length < 1200; m = addMonths(m, 1)) out.push(m);
  return out;
}

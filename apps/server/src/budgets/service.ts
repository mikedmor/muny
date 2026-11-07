import { type MunyDb, newId, schema } from "@muny/db";
import type {
  BudgetForecast,
  BudgetGroup,
  BudgetKind,
  BudgetLine,
  BudgetMonth,
  ScheduledItem,
  SetBudgetInput,
} from "@muny/shared";
import { and, eq, gte, isNotNull, isNull, lt, lte, sql } from "drizzle-orm";
import { localToday } from "../lib/dates.js";
import { listSeries, upcoming } from "../recurring/service.js";
import {
  addMonths,
  categoryMeta,
  monthEnd,
  monthlyCategoryTotals,
  monthsBetween,
  TRANSFER_KEY,
} from "../reports/spending.js";

type Tx = Parameters<Parameters<MunyDb["transaction"]>[0]>[0];
type Db = MunyDb | Tx;

interface StoredBudget {
  id: string;
  categoryId: string | null;
  kind: BudgetKind;
  rollover: boolean;
  startMonth: string;
  amounts: { fromMonth: string; amountCents: number }[];
}

function loadBudgets(db: Db): StoredBudget[] {
  const amounts = db.select().from(schema.budgetAmounts).all();
  return db
    .select()
    .from(schema.budgets)
    .all()
    .map((b) => ({
      id: b.id,
      categoryId: b.categoryId,
      kind: b.kind,
      rollover: b.rollover,
      startMonth: b.startMonth,
      amounts: amounts
        .filter((a) => a.budgetId === b.id)
        .sort((x, y) => x.fromMonth.localeCompare(y.fromMonth)),
    }));
}

/** Budget amount in effect for a month, or null before the budget starts. */
function amountFor(b: StoredBudget, month: string): number | null {
  if (month < b.startMonth) return null;
  let v: number | null = null;
  for (const a of b.amounts) if (a.fromMonth <= month) v = a.amountCents;
  return v;
}

export function budgetMonth(db: Db, month: string): BudgetMonth {
  const cats = categoryMeta(db);
  const budgets = loadBudgets(db);
  const earliest = [
    addMonths(month, -3),
    ...budgets.filter((b) => b.rollover).map((b) => b.startMonth),
  ].sort()[0] as string;
  const totals = monthlyCategoryTotals(db, `${earliest}-01`, monthEnd(month));

  // spent[month][categoryId] = positive spending (expense categories only).
  const spent = new Map<string, Map<string, number>>();
  let income = 0;
  const incomeByMonth = new Map<string, number>();
  let uncategorized = 0;
  const excludedSpent = new Map<string, number>();
  for (const t of totals) {
    if (t.categoryId === TRANSFER_KEY) continue;
    const meta = t.categoryId ? cats.get(t.categoryId) : undefined;
    if (t.categoryId && !meta) continue;
    if (meta?.kind === "transfer") continue;
    if (meta?.excludeFromBudget && t.categoryId) {
      if (t.month === month)
        excludedSpent.set(t.categoryId, (excludedSpent.get(t.categoryId) ?? 0) - t.cents);
      continue;
    }
    if (meta?.kind === "income") {
      if (t.month === month) income += t.cents;
      incomeByMonth.set(t.month, (incomeByMonth.get(t.month) ?? 0) + t.cents);
      continue;
    }
    const key = t.categoryId ?? "";
    const m = spent.get(t.month) ?? new Map<string, number>();
    m.set(key, (m.get(key) ?? 0) - t.cents);
    spent.set(t.month, m);
    if (!t.categoryId && t.month === month) uncategorized -= t.cents;
  }
  const spentIn = (m: string, categoryId: string | null) => {
    const row = spent.get(m);
    if (!row) return 0;
    if (categoryId !== null) return row.get(categoryId) ?? 0;
    let sum = 0;
    for (const v of row.values()) sum += v;
    return sum;
  };

  const prev3 = [1, 2, 3].map((n) => addMonths(month, -n));
  const line = (categoryId: string | null, name: string): BudgetLine => {
    const b = budgets.find((x) => x.categoryId === categoryId && x.kind === "spending");
    const budgetCents = b ? amountFor(b, month) : null;
    const spentCents = spentIn(month, categoryId);
    let rolloverCents = 0;
    if (b?.rollover) {
      for (const m of monthsBetween(b.startMonth, addMonths(month, -1))) {
        rolloverCents += (amountFor(b, m) ?? 0) - spentIn(m, categoryId);
      }
    }
    return {
      categoryId,
      kind: "spending",
      name,
      budgetId: b?.id ?? null,
      budgetCents,
      spentCents,
      rollover: b?.rollover ?? false,
      rolloverCents,
      availableCents: budgetCents === null ? null : budgetCents + rolloverCents - spentCents,
      averageCents: Math.round(prev3.reduce((s, m) => s + spentIn(m, categoryId), 0) / 3),
      historyCents: [...prev3].reverse().map((m) => ({ month: m, cents: spentIn(m, categoryId) })),
    };
  };

  const groups = new Map<string, BudgetGroup & { sort: number }>();
  for (const c of [...cats.values()].sort((a, b) => a.groupSort - b.groupSort || a.sort - b.sort)) {
    if (c.kind !== "expense" || c.excludeFromBudget) continue;
    const l = line(c.id, c.name);
    // Hidden categories only show if they have a budget or spending.
    if (c.hidden && l.budgetCents === null && l.spentCents === 0) continue;
    const g = groups.get(c.groupId) ?? {
      groupId: c.groupId,
      name: c.groupName,
      lines: [],
      sort: c.groupSort,
    };
    g.lines.push(l);
    groups.set(c.groupId, g);
  }
  const groupList = [...groups.values()]
    .sort((a, b) => a.sort - b.sort)
    .map(({ sort: _s, ...g }) => g);
  const budgetedCents = groupList
    .flatMap((g) => g.lines)
    .reduce((s, l) => s + (l.budgetCents ?? 0), 0);

  const total = line(null, "Total spending");

  // Earnings and bills: an optional fixed target; no target = automatic (the forecast).
  const excludedIds = [...cats.values()].filter((c) => c.excludeFromBudget).map((c) => c.id);
  const billsPaid = recurringPaidByMonth(db, [month, ...prev3], excludedIds);
  const basic = (
    kind: "income" | "bills",
    name: string,
    actual: (m: string) => number,
  ): BudgetLine => {
    const b = budgets.find((x) => x.categoryId === null && x.kind === kind);
    const budgetCents = b ? amountFor(b, month) : null;
    const spentCents = actual(month);
    return {
      categoryId: null,
      kind,
      name,
      budgetId: b?.id ?? null,
      budgetCents,
      spentCents,
      rollover: false,
      rolloverCents: 0,
      availableCents: budgetCents === null ? null : budgetCents - spentCents,
      averageCents: Math.round(prev3.reduce((s, m) => s + actual(m), 0) / 3),
      historyCents: [...prev3].reverse().map((m) => ({ month: m, cents: actual(m) })),
    };
  };

  return {
    income: basic("income", "Earnings", (m) => incomeByMonth.get(m) ?? 0),
    bills: basic("bills", "Bills & subscriptions", (m) => billsPaid.get(m) ?? 0),
    forecast: forecastMonth(db, month, {
      spentCents: total.spentCents,
      incomeCents: income,
      incomeAverageCents: Math.round(
        prev3.reduce((s, m) => s + (incomeByMonth.get(m) ?? 0), 0) / 3,
      ),
      isSpending: (categoryId) => {
        if (categoryId === null) return true;
        const c = cats.get(categoryId);
        return c?.kind === "expense" && !c.excludeFromBudget;
      },
    }),
    month,
    total,
    groups: groupList,
    uncategorizedCents: uncategorized,
    incomeCents: income,
    budgetedCents,
    excluded: [...cats.values()]
      .filter((c) => c.excludeFromBudget && c.kind === "expense")
      .sort((a, b) => a.groupSort - b.groupSort || a.sort - b.sort)
      .map((c) => ({
        categoryId: c.id,
        name: c.name,
        groupName: c.groupName,
        spentCents: excludedSpent.get(c.id) ?? 0,
      })),
  };
}

/**
 * The rest of the month from recurring series: income still expected and
 * bills still due (a late bill counts as due today). Past months are final.
 */
function forecastMonth(
  db: Db,
  month: string,
  so: {
    spentCents: number;
    incomeCents: number;
    incomeAverageCents: number;
    isSpending: (categoryId: string | null) => boolean;
  },
  today = localToday(),
): BudgetForecast {
  const thisMonth = today.slice(0, 7);
  const period = month < thisMonth ? "past" : month > thisMonth ? "future" : "current";
  const end = monthEnd(month);
  const series = new Map(listSeries(db, today).map((s) => [s.id, s]));
  const scheduled: ScheduledItem[] =
    period === "past"
      ? []
      : upcoming(db, period === "current" ? today : `${month}-01`, end, today)
          .filter((u) => u.date >= `${month}-01` && u.date <= end)
          .map((u) => ({
            seriesId: u.seriesId,
            name: u.name,
            kind: u.kind,
            date: u.date,
            amountCents: u.amountCents,
            categoryId: series.get(u.seriesId)?.categoryId ?? null,
          }));
  const scheduledByCategory: Record<string, number> = {};
  let due = 0;
  let incomeExpected = 0;
  for (const s of scheduled) {
    if (s.amountCents > 0) {
      incomeExpected += s.amountCents;
      continue;
    }
    if (!so.isSpending(s.categoryId)) continue;
    due -= s.amountCents;
    const k = s.categoryId ?? "";
    scheduledByCategory[k] = (scheduledByCategory[k] ?? 0) - s.amountCents;
  }

  // Recurring charges already paid this month (subscriptions and bills).
  const t = schema.transactions;
  const paid = db
    .select({ cents: t.amountCents, seriesId: t.recurringSeriesId })
    .from(t)
    .where(
      and(
        gte(t.postedDate, `${month}-01`),
        lte(t.postedDate, end),
        eq(t.hidden, false),
        isNotNull(t.recurringSeriesId),
        lt(t.amountCents, 0),
      ),
    )
    .all()
    .filter((r) => {
      const s = series.get(r.seriesId as string);
      return s?.kind !== "income" && so.isSpending(s?.categoryId ?? null);
    })
    .reduce((s, r) => s - r.cents, 0);

  const projectedSpending = so.spentCents + due;
  const projectedIncome = so.incomeCents + incomeExpected;
  return {
    period,
    incomeSoFarCents: so.incomeCents,
    incomeExpectedCents: incomeExpected,
    incomeAverageCents: so.incomeAverageCents,
    recurringPaidCents: paid,
    recurringDueCents: due,
    scheduled: scheduled.sort((a, b) => a.date.localeCompare(b.date)),
    scheduledByCategory,
    projectedSpendingCents: projectedSpending,
    projectedIncomeCents: projectedIncome,
    projectedLeftoverCents: projectedIncome - projectedSpending,
  };
}

/** Categories left out of budgets (their bills don't count either). */
export function excludedCategoryIds(db: Db): string[] {
  return [...categoryMeta(db).values()].filter((c) => c.excludeFromBudget).map((c) => c.id);
}

/** Recurring bills/subscriptions charged per month (positive cents). */
export function recurringPaidByMonth(
  db: Db,
  months: string[],
  excludedCategoryIds: string[] = [],
): Map<string, number> {
  const out = new Map<string, number>();
  if (!months.length) return out;
  const sorted = [...months].sort();
  const rows = db.all<{ m: string; s: number }>(sql`
    select substr(t.posted_date, 1, 7) as m, -sum(t.amount_cents) as s
      from transactions t
      join recurring_series r on r.id = t.recurring_series_id
     where t.hidden = 0 and t.amount_cents < 0 and r.kind <> 'income'
       and (r.category_id is null or r.category_id not in (${sql.join(
         ["-", ...excludedCategoryIds].map((id) => sql`${id}`),
         sql`, `,
       )}))
       and t.posted_date between ${`${sorted[0]}-01`} and ${monthEnd(sorted[sorted.length - 1] as string)}
     group by m
  `);
  for (const r of rows) out.set(r.m, Number(r.s));
  return out;
}

export function setBudget(tx: Tx, input: SetBudgetInput & { fromMonth: string }): string {
  const b = schema.budgets;
  const existing = tx
    .select()
    .from(b)
    .where(
      input.categoryId
        ? eq(b.categoryId, input.categoryId)
        : and(isNull(b.categoryId), eq(b.kind, input.kind ?? "spending")),
    )
    .get();
  let id: string;
  if (!existing) {
    id = newId();
    tx.insert(b)
      .values({
        id,
        categoryId: input.categoryId,
        kind: input.categoryId ? "spending" : (input.kind ?? "spending"),
        rollover: input.rollover ?? false,
        startMonth: input.fromMonth,
      })
      .run();
  } else {
    id = existing.id;
    const patch = {
      ...(input.rollover !== undefined && { rollover: input.rollover }),
      ...(input.fromMonth < existing.startMonth && { startMonth: input.fromMonth }),
    };
    if (Object.keys(patch).length) tx.update(b).set(patch).where(eq(b.id, id)).run();
  }
  tx.insert(schema.budgetAmounts)
    .values({ budgetId: id, fromMonth: input.fromMonth, amountCents: input.amountCents })
    .onConflictDoUpdate({
      target: [schema.budgetAmounts.budgetId, schema.budgetAmounts.fromMonth],
      set: { amountCents: input.amountCents },
    })
    .run();
  return id;
}

/** Delete a budget (all months). */
export function removeBudget(tx: Tx, budgetId: string): boolean {
  return tx.delete(schema.budgets).where(eq(schema.budgets.id, budgetId)).run().changes > 0;
}

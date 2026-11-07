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
import { and, eq, isNull, sql } from "drizzle-orm";
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
      isBill: categoryId ? (cats.get(categoryId)?.isBill ?? false) : false,
      isHome: categoryId ? (cats.get(categoryId)?.isHome ?? false) : false,
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
  const billsPaid = billsPaidByMonth(db, [month, ...prev3]);
  const homePaid = homePaidByMonth(db, [month, ...prev3]);
  const otherSpent = otherSpentByMonth(db, [month, ...prev3]);
  // The basics aren't budgeted by hand: earnings is the income expected this
  // month; bills and all other categories add up their category budgets.
  const basic = (
    kind: "income" | "bills" | "home" | "other",
    name: string,
    actual: (m: string) => number,
    budgetCents: number | null,
  ): BudgetLine => {
    const spentCents = actual(month);
    return {
      categoryId: null,
      kind,
      name,
      budgetId: null,
      budgetCents,
      spentCents,
      rollover: false,
      rolloverCents: 0,
      availableCents: budgetCents === null ? null : budgetCents - spentCents,
      averageCents: Math.round(prev3.reduce((s, m) => s + actual(m), 0) / 3),
      historyCents: [...prev3].reverse().map((m) => ({ month: m, cents: actual(m) })),
      isBill: false,
      isHome: false,
    };
  };
  const categoryLines = groupList.flatMap((g) => g.lines);
  const basicOf = (l: BudgetLine) => (l.isHome ? "home" : l.isBill ? "bills" : "other");
  const sumBudgets = (basic: "bills" | "home" | "other") => {
    const ls = categoryLines.filter((l) => basicOf(l) === basic && l.budgetCents !== null);
    return ls.length ? ls.reduce((s, l) => s + (l.budgetCents ?? 0), 0) : null;
  };
  const forecast = forecastMonth(db, month, {
    spentCents: total.spentCents,
    incomeCents: income,
    incomeAverageCents: Math.round(prev3.reduce((s, m) => s + (incomeByMonth.get(m) ?? 0), 0) / 3),
    isSpending: (categoryId) => {
      if (categoryId === null) return true;
      const c = cats.get(categoryId);
      return c?.kind === "expense" && !c.excludeFromBudget;
    },
  });
  // Earnings: received so far plus what recurring income should still bring (past: received).
  const expectedIncome =
    forecast.period === "past" ? forecast.incomeSoFarCents : forecast.projectedIncomeCents;

  return {
    income: basic("income", "Earnings", (m) => incomeByMonth.get(m) ?? 0, expectedIncome),
    home: basic("home", "Home & utilities", (m) => homePaid.get(m) ?? 0, sumBudgets("home")),
    bills: basic(
      "bills",
      "Bills & subscriptions",
      (m) => billsPaid.get(m) ?? 0,
      sumBudgets("bills"),
    ),
    other: basic(
      "other",
      "All other categories",
      (m) => otherSpent.get(m) ?? 0,
      sumBudgets("other"),
    ),
    forecast,
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

  // Bills already paid this month (recurring charges and bill categories).
  const paid = billCharges(db, `${month}-01`, end).reduce((s, c) => s + c.cents, 0);

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

/** SQL: recurring bills and subscriptions (not income; category not left out of budgets). */
export const BILL_SERIES = sql`(select r.id from recurring_series r
  where r.kind <> 'income'
    and (r.category_id is null or r.category_id not in (select id from categories where exclude_from_budget = 1)))`;

/** SQL: categories that count as Home & utilities (and aren't left out of budgets). */
export const HOME_CATEGORIES = sql`(select id from categories where is_home = 1 and exclude_from_budget = 0)`;

/** SQL: categories that count as bills (not home costs, not left out of budgets). */
export const BILL_CATEGORIES = sql`(select id from categories where is_bill = 1 and is_home = 0 and exclude_from_budget = 0)`;

/**
 * SQL: transaction `t` has nothing in a home category (itself or a split part).
 * A recurring charge counts as a bill only then: the rent is a home cost even
 * though it repeats.
 */
const NOT_HOME = sql`(coalesce(t.category_id, '-') not in ${HOME_CATEGORIES}
  and not exists (select 1 from transaction_splits h where h.transaction_id = t.id and h.category_id in ${HOME_CATEGORIES}))`;

/**
 * Bill charges between two dates (positive cents): charges from recurring
 * bills and subscriptions, and anything in a bill category (split parts
 * included). A transaction counts once.
 */
/**
 * The overall budget for a month. With no overall budget set, it's the category
 * budgets added up, the same figure the Overview shows.
 */
export function overallBudget(b: BudgetMonth): {
  budgetCents: number | null;
  availableCents: number | null;
} {
  const budget = b.total.budgetCents ?? (b.budgetedCents > 0 ? b.budgetedCents : null);
  return {
    budgetCents: budget,
    availableCents:
      b.total.budgetCents !== null || budget === null
        ? b.total.availableCents
        : budget + b.total.rolloverCents - b.total.spentCents,
  };
}

export function billCharges(
  db: Db,
  from: string,
  to: string,
): { id: string; date: string; cents: number }[] {
  return db
    .all<{ id: string; date: string; cents: number }>(sql`
      select t.id as id, t.posted_date as date, -t.amount_cents as cents
        from transactions t join accounts a on a.id = t.account_id
       where t.hidden = 0 and a.exclude_from_reports = 0 and a.type <> 'loan'
         and t.posted_date between ${from} and ${to}
         and ((t.amount_cents < 0 and t.recurring_series_id in ${BILL_SERIES} and ${NOT_HOME})
           or (t.category_id in ${BILL_CATEGORIES}
               and not exists (select 1 from transaction_splits x where x.transaction_id = t.id)))
      union all
      select t.id as id, t.posted_date as date, -sp.amount_cents as cents
        from transaction_splits sp
        join transactions t on t.id = sp.transaction_id
        join accounts a on a.id = t.account_id
       where t.hidden = 0 and a.exclude_from_reports = 0 and a.type <> 'loan'
         and t.posted_date between ${from} and ${to}
         and sp.category_id in ${BILL_CATEGORIES}
         and not (t.amount_cents < 0 and coalesce(t.recurring_series_id, '-') in ${BILL_SERIES} and ${NOT_HOME})
    `)
    .map((r) => ({ ...r, cents: Number(r.cents) }));
}

/** SQL: spending categories that count in budgets (not income or transfers, not left out). */
const SPENDING_CATEGORIES = sql`(select c.id from categories c join category_groups g on g.id = c.group_id
  where g.kind = 'expense' and c.exclude_from_budget = 0)`;

/**
 * Spending that isn't a bill ("All other categories", positive cents): what
 * budgets count as spending (spending categories and uncategorized) minus
 * bill charges (recurring bills, bill categories). Split parts count alone.
 */
export function otherSpending(
  db: Db,
  from: string,
  to: string,
): { id: string; date: string; cents: number }[] {
  return db
    .all<{ id: string; date: string; cents: number }>(sql`
      select t.id as id, t.posted_date as date, -t.amount_cents as cents
        from transactions t join accounts a on a.id = t.account_id
       where t.hidden = 0 and a.exclude_from_reports = 0 and a.type <> 'loan'
         and t.posted_date between ${from} and ${to}
         and not exists (select 1 from transaction_splits x where x.transaction_id = t.id)
         and (t.category_id in ${SPENDING_CATEGORIES}
           or (t.category_id is null and t.transfer_pair_id is null))
         and coalesce(t.category_id, '-') not in ${BILL_CATEGORIES}
         and coalesce(t.category_id, '-') not in ${HOME_CATEGORIES}
         and not (t.amount_cents < 0 and coalesce(t.recurring_series_id, '-') in ${BILL_SERIES})
      union all
      select t.id as id, t.posted_date as date, -sp.amount_cents as cents
        from transaction_splits sp
        join transactions t on t.id = sp.transaction_id
        join accounts a on a.id = t.account_id
       where t.hidden = 0 and a.exclude_from_reports = 0 and a.type <> 'loan'
         and t.posted_date between ${from} and ${to}
         and (sp.category_id in ${SPENDING_CATEGORIES} or sp.category_id is null)
         and coalesce(sp.category_id, '-') not in ${BILL_CATEGORIES}
         and coalesce(sp.category_id, '-') not in ${HOME_CATEGORIES}
         and not (t.amount_cents < 0 and coalesce(t.recurring_series_id, '-') in ${BILL_SERIES} and ${NOT_HOME})
    `)
    .map((r) => ({ ...r, cents: Number(r.cents) }));
}

/** Spending that isn't a bill, per month (positive cents), for the months given. */
export function otherSpentByMonth(db: Db, months: string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (!months.length) return out;
  const sorted = [...months].sort();
  for (const c of otherSpending(db, `${sorted[0]}-01`, monthEnd(sorted.at(-1) as string))) {
    const m = c.date.slice(0, 7);
    out.set(m, (out.get(m) ?? 0) + c.cents);
  }
  return out;
}

/** Home & utilities charges between two dates (positive cents): anything in a home category. */
export function homeCharges(
  db: Db,
  from: string,
  to: string,
): { id: string; date: string; cents: number }[] {
  return db
    .all<{ id: string; date: string; cents: number }>(sql`
      select t.id as id, t.posted_date as date, -t.amount_cents as cents
        from transactions t join accounts a on a.id = t.account_id
       where t.hidden = 0 and a.exclude_from_reports = 0 and a.type <> 'loan'
         and t.posted_date between ${from} and ${to}
         and t.category_id in ${HOME_CATEGORIES}
         and not exists (select 1 from transaction_splits x where x.transaction_id = t.id)
      union all
      select t.id as id, t.posted_date as date, -sp.amount_cents as cents
        from transaction_splits sp
        join transactions t on t.id = sp.transaction_id
        join accounts a on a.id = t.account_id
       where t.hidden = 0 and a.exclude_from_reports = 0 and a.type <> 'loan'
         and t.posted_date between ${from} and ${to}
         and sp.category_id in ${HOME_CATEGORIES}
    `)
    .map((r) => ({ ...r, cents: Number(r.cents) }));
}

/** Home & utilities per month (positive cents), for the months given. */
export function homePaidByMonth(db: Db, months: string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (!months.length) return out;
  const sorted = [...months].sort();
  for (const c of homeCharges(db, `${sorted[0]}-01`, monthEnd(sorted.at(-1) as string))) {
    const m = c.date.slice(0, 7);
    out.set(m, (out.get(m) ?? 0) + c.cents);
  }
  return out;
}

/** Bills paid per month (positive cents), for the months given. */
export function billsPaidByMonth(db: Db, months: string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (!months.length) return out;
  const sorted = [...months].sort();
  for (const c of billCharges(db, `${sorted[0]}-01`, monthEnd(sorted.at(-1) as string))) {
    const m = c.date.slice(0, 7);
    out.set(m, (out.get(m) ?? 0) + c.cents);
  }
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

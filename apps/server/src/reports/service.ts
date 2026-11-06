import { cleanPayeeName } from "@muny/core";
import { type MunyDb, schema } from "@muny/db";
import {
  LIABILITY_TYPES,
  type MonthlyReport,
  type MonthTotals,
  type NetWorthPoint,
  type NetWorthReport,
  type Overview,
  type SpendingGroupBy,
  type SpendingItem,
  type SpendingReport,
} from "@muny/shared";
import { and, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { budgetMonth } from "../budgets/service.js";
import { listAccounts } from "../ledger/accounts.js";
import { localToday } from "../lib/dates.js";
import { listSeries, merchantKey, upcoming } from "../recurring/service.js";
import {
  addMonths,
  categoryMeta,
  dailyCategoryTotals,
  monthEnd,
  monthlyCategoryTotals,
  monthsBetween,
  TRANSFER_KEY,
} from "./spending.js";

type Db = MunyDb;

function addDays(iso: string, n: number) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Spending breakdown
// ---------------------------------------------------------------------------

export function spendingReport(
  db: Db,
  from: string,
  to: string,
  by: SpendingGroupBy,
  categoryId?: string,
): SpendingReport {
  const cats = categoryMeta(db);
  const isSpending = (c: string | null) => (c ? cats.get(c)?.kind === "expense" : true);

  if (by !== "merchant") {
    const sums = new Map<string, SpendingItem>();
    for (const t of monthlyCategoryTotals(db, from, to)) {
      if (t.categoryId === TRANSFER_KEY || !isSpending(t.categoryId)) continue;
      const meta = t.categoryId ? cats.get(t.categoryId) : undefined;
      const id = by === "group" ? (meta?.groupId ?? null) : t.categoryId;
      const k = id ?? "";
      const cur = sums.get(k) ?? {
        id,
        name:
          by === "group" ? (meta?.groupName ?? "Uncategorized") : (meta?.name ?? "Uncategorized"),
        cents: 0,
        count: 0,
        ...(by === "category" && meta ? { groupName: meta.groupName } : {}),
      };
      cur.cents -= t.cents;
      sums.set(k, cur);
    }
    const items = [...sums.values()].filter((i) => i.cents > 0).sort((a, b) => b.cents - a.cents);
    return { from, to, by, totalCents: items.reduce((s, i) => s + i.cents, 0), items };
  }

  // By merchant: walk transactions (split parts count toward their own categories).
  const t = schema.transactions;
  const rows = db
    .select({
      id: t.id,
      amountCents: t.amountCents,
      categoryId: t.categoryId,
      transferPairId: t.transferPairId,
      raw: t.rawDescription,
      payee: schema.payees.displayName,
    })
    .from(t)
    .innerJoin(schema.accounts, eq(schema.accounts.id, t.accountId))
    .leftJoin(schema.payees, eq(schema.payees.id, t.payeeId))
    .where(
      and(
        eq(t.hidden, false),
        eq(schema.accounts.excludeFromReports, false),
        gte(t.postedDate, from),
        lte(t.postedDate, to),
      ),
    )
    .all();
  const splits = new Map<string, { categoryId: string | null; amountCents: number }[]>();
  for (const s of db.select().from(schema.transactionSplits).all()) {
    splits.set(s.transactionId, [...(splits.get(s.transactionId) ?? []), s]);
  }
  const sums = new Map<string, SpendingItem>();
  for (const r of rows) {
    const parts = splits.get(r.id) ?? [{ categoryId: r.categoryId, amountCents: r.amountCents }];
    let cents = 0;
    for (const p of parts) {
      if (!isSpending(p.categoryId)) continue;
      if (!p.categoryId && r.transferPairId) continue;
      if (categoryId && p.categoryId !== (categoryId === "uncategorized" ? null : categoryId))
        continue;
      cents -= p.amountCents;
    }
    if (cents === 0) continue;
    const key = merchantKey(r.payee, r.raw);
    const cur = sums.get(key) ?? {
      id: key,
      name: r.payee ?? cleanPayeeName(r.raw) ?? key,
      cents: 0,
      count: 0,
    };
    cur.cents += cents;
    cur.count++;
    sums.set(key, cur);
  }
  const items = [...sums.values()].filter((i) => i.cents > 0).sort((a, b) => b.cents - a.cents);
  return { from, to, by, totalCents: items.reduce((s, i) => s + i.cents, 0), items };
}

// ---------------------------------------------------------------------------
// Monthly totals (trends, cash flow)
// ---------------------------------------------------------------------------

export function monthlyReport(db: Db, fromMonth: string, toMonth: string): MonthlyReport {
  const cats = categoryMeta(db);
  const months = new Map<string, MonthTotals>(
    monthsBetween(fromMonth, toMonth).map((m) => [
      m,
      { month: m, incomeCents: 0, spendingCents: 0, byCategory: {} },
    ]),
  );
  for (const t of monthlyCategoryTotals(db, `${fromMonth}-01`, monthEnd(toMonth))) {
    const m = months.get(t.month);
    if (!m || t.categoryId === TRANSFER_KEY) continue;
    const meta = t.categoryId ? cats.get(t.categoryId) : undefined;
    if (meta?.kind === "transfer") continue;
    if (meta?.kind === "income") {
      m.incomeCents += t.cents;
      continue;
    }
    const k = t.categoryId ?? "";
    m.byCategory[k] = (m.byCategory[k] ?? 0) - t.cents;
    m.spendingCents -= t.cents;
  }
  return {
    months: [...months.values()],
    categories: [...cats.values()]
      .filter((c) => c.kind === "expense")
      .sort((a, b) => a.groupSort - b.groupSort || a.sort - b.sort)
      .map((c) => ({ id: c.id, name: c.name, groupName: c.groupName })),
  };
}

// ---------------------------------------------------------------------------
// Net worth over time
// ---------------------------------------------------------------------------

/**
 * Balance of every account at each date. Accounts with transactions are
 * walked back from today's balance (balance then = balance now - everything
 * posted since). Accounts without transactions (a house, a car) use their
 * value history (balance snapshots), else their current value.
 */
/** Balances as of a past date: walk transactions back from today, or use snapshots. */
export function balanceHistory(db: Db, includeExcluded = false) {
  const accounts = listAccounts(db).filter((a) => includeExcluded || !a.excludeFromReports);
  const t = schema.transactions;
  const txns = db
    .select({ accountId: t.accountId, date: t.postedDate, cents: t.amountCents })
    .from(t)
    .where(eq(t.pending, false))
    .all();
  const byAccount = new Map<string, { date: string; cents: number }[]>();
  for (const x of txns) byAccount.set(x.accountId, [...(byAccount.get(x.accountId) ?? []), x]);
  const snaps = new Map<string, { date: string; cents: number }[]>();
  for (const s of db
    .select()
    .from(schema.balanceSnapshots)
    .orderBy(schema.balanceSnapshots.date)
    .all()) {
    snaps.set(s.accountId, [
      ...(snaps.get(s.accountId) ?? []),
      { date: s.date, cents: s.balanceCents },
    ]);
  }

  const balanceAt = (accountId: string, now: number, date: string): number => {
    const list = byAccount.get(accountId);
    if (list?.length)
      return now - list.filter((x) => x.date > date).reduce((s, x) => s + x.cents, 0);
    const sn = snaps.get(accountId);
    if (sn?.length) {
      let v = sn[0]?.cents ?? now;
      for (const s of sn) if (s.date <= date) v = s.cents;
      return v;
    }
    return now;
  };

  return { accounts, balanceAt };
}

export function netWorthReport(db: Db, dates: string[]): NetWorthReport {
  const { accounts, balanceAt } = balanceHistory(db);
  const points: NetWorthPoint[] = dates.map((date) => {
    let assets = 0;
    let debts = 0;
    for (const a of accounts) {
      const b = balanceAt(a.id, a.balanceCents, date);
      if (LIABILITY_TYPES.has(a.type) || b < 0) debts -= b;
      else assets += b;
    }
    return { date, assetsCents: assets, debtsCents: debts, netCents: assets - debts };
  });
  const byTypeMap = new Map<string, number>();
  for (const a of accounts) byTypeMap.set(a.type, (byTypeMap.get(a.type) ?? 0) + a.balanceCents);
  return { points, byType: [...byTypeMap].map(([type, cents]) => ({ type, cents })) };
}

/** Month-end dates for the last `months` months, plus today. */
export function netWorthDates(months: number, today = localToday()): string[] {
  const thisMonth = today.slice(0, 7);
  const out = monthsBetween(addMonths(thisMonth, -months), addMonths(thisMonth, -1)).map(monthEnd);
  out.push(today);
  return out;
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

/**
 * Running spending total for each day from `from` to `to` (inclusive), using
 * the same rules as spendingReport (expense categories + uncategorized, refunds
 * reduce it, transfers and hidden items left out).
 */
export function cumulativeDailySpending(db: Db, from: string, to: string): number[] {
  const cats = categoryMeta(db);
  const perDay = new Map<string, number>();
  for (const t of dailyCategoryTotals(db, from, to)) {
    if (t.categoryId === TRANSFER_KEY) continue;
    if (t.categoryId && cats.get(t.categoryId)?.kind !== "expense") continue;
    perDay.set(t.month, (perDay.get(t.month) ?? 0) - t.cents);
  }
  const out: number[] = [];
  let run = 0;
  for (let d = from; d <= to && out.length < 400; d = addDays(d, 1)) {
    run += perDay.get(d) ?? 0;
    out.push(run);
  }
  return out;
}

/**
 * The same running total split by category: the largest `top` categories
 * (by the period's total) each get their own series, the rest are "Other".
 * At every day the series add up to cumulativeDailySpending's total.
 */
export function cumulativeDailyByCategory(
  db: Db,
  from: string,
  to: string,
  top = 6,
): { id: string | null; name: string; daily: number[] }[] {
  const cats = categoryMeta(db);
  const perCat = new Map<string, Map<string, number>>(); // category -> day -> spent
  const totals = new Map<string, number>();
  for (const t of dailyCategoryTotals(db, from, to)) {
    if (t.categoryId === TRANSFER_KEY) continue;
    if (t.categoryId && cats.get(t.categoryId)?.kind !== "expense") continue;
    const k = t.categoryId ?? "";
    const m = perCat.get(k) ?? new Map<string, number>();
    m.set(t.month, (m.get(t.month) ?? 0) - t.cents);
    perCat.set(k, m);
    totals.set(k, (totals.get(k) ?? 0) - t.cents);
  }
  const ranked = [...totals].sort((a, b) => b[1] - a[1]);
  const keep = new Set(ranked.slice(0, ranked.length > top + 1 ? top : top + 1).map(([k]) => k));
  const days: string[] = [];
  for (let d = from; d <= to && days.length < 400; d = addDays(d, 1)) days.push(d);
  const run = (spentOn: (day: string) => number) => {
    let total = 0;
    return days.map((d) => {
      total += spentOn(d);
      return total;
    });
  };
  const out = [...keep].map((k) => ({
    id: k || null,
    name: k ? (cats.get(k)?.name ?? "Unknown") : "Uncategorized",
    daily: run((d) => perCat.get(k)?.get(d) ?? 0),
  }));
  const rest = [...perCat.keys()].filter((k) => !keep.has(k));
  if (rest.length)
    out.push({
      id: "other",
      name: "Other",
      daily: run((d) => rest.reduce((t, k) => t + (perCat.get(k)?.get(d) ?? 0), 0)),
    });
  return out;
}

const CASH_TYPES: ReadonlySet<string> = new Set(["checking", "cash", "savings"]);

/** Cash in checking & savings on each date (same accounts as the dashboard headline). */
export function cashTrend(db: Db, dates: string[]): { date: string; cents: number }[] {
  // Match the Accounts card, which shows every visible account.
  const { accounts, balanceAt } = balanceHistory(db, true);
  const cash = accounts.filter((a) => !a.hidden && CASH_TYPES.has(a.type));
  return dates.map((date) => ({
    date,
    cents: cash.reduce((sum, a) => sum + balanceAt(a.id, a.balanceCents, date), 0),
  }));
}

export function overview(db: Db, today = localToday()): Overview {
  const month = today.slice(0, 7);
  const lastMonth = addMonths(month, -1);
  const day = Number(today.slice(8));
  const lastMonthEnd = monthEnd(lastMonth);
  const sameDayLastMonth = `${lastMonth}-${String(Math.min(day, Number(lastMonthEnd.slice(8)))).padStart(2, "0")}`;
  const monthAgo = addDays(today, -30);

  const nw = netWorthReport(db, [monthAgo, today]);
  const mtd = spendingReport(db, `${month}-01`, today, "category");
  const lastSpan = spendingReport(db, `${lastMonth}-01`, sameDayLastMonth, "category");
  const lastFull = spendingReport(db, `${lastMonth}-01`, lastMonthEnd, "category");
  const monthly = monthlyReport(db, month, month).months[0];
  const b = budgetMonth(db, month);
  const anyBudget = b.total.budgetCents !== null || b.budgetedCents > 0;

  const t = schema.transactions;
  const uncategorized = db
    .select({ n: sql<number>`count(*)` })
    .from(t)
    .where(
      and(
        isNull(t.categoryId),
        eq(t.hidden, false),
        isNull(t.transferPairId),
        gte(t.postedDate, addDays(today, -90)),
        sql`not exists (select 1 from transaction_splits s where s.transaction_id = ${t.id})`,
      ),
    )
    .get();
  const login = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.connections)
    .where(sql`${schema.connections.status} in ('reauth_required', 'error', 'pending_setup')`)
    .get();
  const newRecurring = listSeries(db, today).filter(
    (s) => s.status === "detected" && s.active,
  ).length;

  return {
    today,
    netWorth: {
      nowCents: nw.points[1]?.netCents ?? 0,
      monthAgoCents: listAccounts(db).length ? (nw.points[0]?.netCents ?? null) : null,
    },
    spending: {
      monthToDateCents: mtd.totalCents,
      lastMonthSameDayCents: lastSpan.totalCents,
      lastMonthTotalCents: lastFull.totalCents,
      thisMonthDaily: cumulativeDailySpending(db, `${month}-01`, today),
      thisMonthByCategory: cumulativeDailyByCategory(db, `${month}-01`, today),
      lastMonthDaily: cumulativeDailySpending(db, `${lastMonth}-01`, lastMonthEnd),
      daysInMonth: Number(monthEnd(month).slice(8)),
    },
    incomeMonthToDateCents: monthly?.incomeCents ?? 0,
    budget: anyBudget
      ? { budgetCents: b.total.budgetCents ?? b.budgetedCents, spentCents: b.total.spentCents }
      : null,
    upcoming: upcoming(db, today, addDays(today, 7), today)
      .filter((u) => u.amountCents < 0)
      .slice(0, 8)
      .map((u) => ({
        seriesId: u.seriesId,
        name: u.name,
        date: u.date,
        amountCents: u.amountCents,
      })),
    topCategories: mtd.items.slice(0, 6).map((i) => ({
      id: i.id,
      name: i.name,
      cents: i.cents,
      groupName: i.groupName ?? null,
    })),
    topMerchants: spendingReport(db, `${month}-01`, today, "merchant")
      .items.slice(0, 6)
      .map((i) => ({ name: i.name, cents: i.cents, count: i.count })),
    cashFlow: monthlyReport(db, addMonths(month, -5), month).months.map((m) => ({
      month: m.month,
      incomeCents: m.incomeCents,
      spendingCents: m.spendingCents,
    })),
    // Weekly points over the last 26 weeks, ending today.
    cashTrend: cashTrend(
      db,
      Array.from({ length: 27 }, (_, i) => addDays(today, (i - 26) * 7)),
    ),
    attention: {
      uncategorized: Number(uncategorized?.n ?? 0),
      connectionsNeedingLogin: Number(login?.n ?? 0),
      newRecurring,
    },
  };
}

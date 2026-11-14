import { addDaysIso, cleanPayeeName } from "@muny/core";
import { type MunyDb, schema } from "@muny/db";
import type { ReviewItem, YearReview } from "@muny/shared";
import { and, eq, gte, lt, lte, ne, sql } from "drizzle-orm";
import { cryptoTax } from "../crypto/tax.js";
import { stockTaxReport } from "../invest/tax.js";
import { localToday } from "../lib/dates.js";
import { listSeries } from "../recurring/service.js";
import { monthlyReport, netWorthReport, spendingReport } from "./service.js";
import {
  categoryMeta,
  dailyCategoryTotals,
  monthEnd,
  monthsBetween,
  TRANSFER_KEY,
} from "./spending.js";

/**
 * A year in review (D-092), from the same numbers as Reports and Spending:
 * earned, spent and kept, month by month; net worth and debt from the start
 * of the year; where the money went; the regulars and the big ones; bills and
 * subscriptions started, cancelled and raised; and a few facts. Read-only.
 */

export function yearInReview(db: MunyDb, year: number, today = localToday()): YearReview {
  const from = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  const to = today < yearEnd ? today : yearEnd;
  const partial = to < yearEnd;
  const toMonth = to.slice(0, 7);
  const prevFrom = `${year - 1}-01-01`;
  const prevTo = `${year - 1}${to.slice(4)}`;

  const first = db
    .select({ d: sql<string | null>`min(${schema.transactions.postedDate})` })
    .from(schema.transactions)
    .get()?.d;

  // Earned and spent, month by month.
  const monthly = monthlyReport(db, `${year}-01`, toMonth);
  const months = monthly.months
    .filter((m) => !first || m.month >= first.slice(0, 7))
    .map((m) => ({
      month: m.month,
      earnedCents: m.incomeCents,
      spentCents: m.spendingCents,
    }));
  const earnedCents = months.reduce((s, m) => s + m.earnedCents, 0);
  const spentCents = months.reduce((s, m) => s + m.spentCents, 0);
  const prev = monthlyReport(db, `${year - 1}-01`, `${year - 1}${toMonth.slice(4)}`).months;
  const hadLastYear = !!first && first <= prevTo;
  const lastYear = hadLastYear
    ? {
        earnedCents: prev.reduce((s, m) => s + m.incomeCents, 0),
        spentCents: prev.reduce((s, m) => s + m.spendingCents, 0),
      }
    : null;
  // Only months that are over, and that Muny has from the start.
  const full = months.filter(
    (m) => monthEnd(m.month) <= today && (!first || first <= `${m.month}-01`) && m.spentCents > 0,
  );
  const byCost = [...full].sort((a, b) => a.spentCents - b.spentCents);
  const lightest = byCost[0];
  const heaviest = byCost.at(-1);

  // Net worth and debt from the start of the year.
  const dates = [`${year - 1}-12-31`, ...monthsBetween(`${year}-01`, toMonth).map(monthEnd)]
    .map((d) => (d > to ? to : d))
    .filter((d, i, a) => a.indexOf(d) === i);
  const nw = netWorthReport(db, dates).points;
  const known = (d: string) => !!first && first <= d;
  const startPoint = nw[0] && known(nw[0].date) ? nw[0] : null;
  const endPoint = nw.at(-1) ?? null;

  // Where it went, with last year's same span beside each.
  const cats = spendingReport(db, from, to, "category");
  const prevCats = new Map(
    spendingReport(db, prevFrom, prevTo, "category").items.map((i) => [i.id ?? "", i.cents]),
  );
  const categories: ReviewItem[] = cats.items.slice(0, 10).map((i) => ({
    id: i.id,
    name: i.name,
    cents: i.cents,
    lastYearCents: hadLastYear ? (prevCats.get(i.id ?? "") ?? 0) : null,
  }));
  const merch = spendingReport(db, from, to, "merchant").items;
  const merchants: ReviewItem[] = merch.slice(0, 10).map((i) => ({
    name: i.name,
    cents: i.cents,
    count: i.count,
  }));
  const regularRow = [...merch].sort((a, b) => b.count - a.count || b.cents - a.cents)[0];
  const regular = regularRow
    ? { name: regularRow.name, cents: regularRow.cents, count: regularRow.count }
    : null;

  // The biggest single purchases (spending categories, no transfers).
  const meta = categoryMeta(db);
  const t = schema.transactions;
  const big = db
    .select({
      date: t.postedDate,
      cents: t.amountCents,
      raw: t.rawDescription,
      payee: schema.payees.displayName,
      categoryId: t.categoryId,
      transferPairId: t.transferPairId,
      seriesId: t.recurringSeriesId,
    })
    .from(t)
    .innerJoin(schema.accounts, eq(schema.accounts.id, t.accountId))
    .leftJoin(schema.payees, eq(schema.payees.id, t.payeeId))
    .where(
      and(
        eq(t.hidden, false),
        eq(t.pending, false),
        eq(schema.accounts.excludeFromReports, false),
        ne(schema.accounts.type, "loan"),
        gte(t.postedDate, from),
        lte(t.postedDate, to),
        lt(t.amountCents, 0),
      ),
    )
    .orderBy(t.amountCents)
    .limit(200)
    .all()
    // One-offs: bills and subscriptions are listed below.
    .filter(
      (x) =>
        !x.seriesId &&
        (x.categoryId ? meta.get(x.categoryId)?.kind === "expense" : !x.transferPairId),
    )
    .slice(0, 5)
    .map((x) => ({
      date: x.date,
      name: x.payee ?? cleanPayeeName(x.raw) ?? x.raw,
      cents: -x.cents,
      category: x.categoryId ? (meta.get(x.categoryId)?.name ?? null) : null,
    }));

  // Bills and subscriptions.
  const series = listSeries(db, today);
  const inYear = (d: string | null) => !!d && d >= from && d <= to;
  const monthlyOf = (s: (typeof series)[number]) => Math.abs(s.monthlyCents);
  const paidCents = -Number(
    db
      .select({ s: sql<number>`coalesce(sum(${t.amountCents}), 0)` })
      .from(t)
      .where(
        and(
          sql`${t.recurringSeriesId} is not null`,
          lt(t.amountCents, 0),
          gte(t.postedDate, from),
          lte(t.postedDate, to),
          eq(t.hidden, false),
        ),
      )
      .get()?.s ?? 0,
  );
  const recurring = {
    paidCents,
    started: series
      .filter((s) => s.kind !== "income" && s.status !== "ignored" && inYear(s.firstDate))
      // Seen in the first weeks of Muny's history, it was probably there before.
      .filter((s) => !first || s.firstDate > addDaysIso(first, 45))
      .sort((a, b) => a.firstDate.localeCompare(b.firstDate))
      .map((s) => ({ name: s.name, date: s.firstDate, monthlyCents: monthlyOf(s) })),
    cancelled: series
      .filter(
        (s) =>
          s.kind !== "income" && s.status === "cancelled" && inYear(s.cancelledAt ?? s.lastDate),
      )
      .map((s) => ({
        name: s.name,
        date: s.cancelledAt ?? s.lastDate,
        monthlyCents: monthlyOf(s),
      })),
    priceIncreases: series
      .filter(
        (s) =>
          s.priceChange &&
          inYear(s.priceChange.date) &&
          Math.abs(s.priceChange.toCents) > Math.abs(s.priceChange.fromCents),
      )
      .map((s) => ({
        name: s.name,
        date: s.priceChange?.date as string,
        fromCents: Math.abs(s.priceChange?.fromCents ?? 0),
        toCents: Math.abs(s.priceChange?.toCents ?? 0),
      })),
  };

  // Facts, from spending day by day.
  const perDay = new Map<string, number>();
  for (const d of dailyCategoryTotals(db, from, to)) {
    if (d.categoryId === TRANSFER_KEY) continue;
    const kind = d.categoryId ? meta.get(d.categoryId)?.kind : "expense";
    if (kind !== "expense") continue;
    perDay.set(d.month, (perDay.get(d.month) ?? 0) - d.cents);
  }
  const start = first && first > from ? first : from;
  let noSpendDays = 0;
  let streak = 0;
  let longest = 0;
  const weekday = [0, 0, 0, 0, 0, 0, 0];
  let biggestDay: { date: string; cents: number } | null = null;
  for (
    let d = new Date(`${start}T00:00:00Z`);
    d.toISOString().slice(0, 10) <= to;
    d.setUTCDate(d.getUTCDate() + 1)
  ) {
    const iso = d.toISOString().slice(0, 10);
    const cents = perDay.get(iso) ?? 0;
    if (cents <= 0) {
      noSpendDays++;
      streak++;
      longest = Math.max(longest, streak);
    } else {
      streak = 0;
      weekday[d.getUTCDay()] = (weekday[d.getUTCDay()] ?? 0) + cents;
      if (!biggestDay || cents > biggestDay.cents) biggestDay = { date: iso, cents };
    }
  }
  const busiest = weekday.some((w) => w > 0) ? weekday.indexOf(Math.max(...weekday)) : null;
  const transactions = Number(
    db
      .select({ n: sql<number>`count(*)` })
      .from(t)
      .where(and(eq(t.hidden, false), gte(t.postedDate, from), lte(t.postedDate, to)))
      .get()?.n ?? 0,
  );

  // Investing, if there's any.
  let investing: YearReview["investing"] = null;
  try {
    const s = stockTaxReport(db, year, today);
    const realized = (r: typeof s.realized) =>
      r.short.profitCents +
      r.short.lossCents +
      r.long.profitCents +
      r.long.lossCents +
      r.unknown.profitCents +
      r.unknown.lossCents;
    const stockGainsCents = realized(s.realized);
    const hasWallets = !!db
      .select({ id: schema.cryptoWallets.id })
      .from(schema.cryptoWallets)
      .get();
    const cryptoGainsCents = hasWallets
      ? cryptoTax(db, { from: Date.UTC(year, 0, 1), to: Date.parse(`${to}T23:59:59Z`) }).summary
          .realizedCents
      : 0;
    if (s.accounts.length || hasWallets)
      investing = { dividendsCents: s.dividendsCents, stockGainsCents, cryptoGainsCents };
  } catch {
    investing = null;
  }

  return {
    year,
    from,
    to,
    partial,
    dataFrom: first ?? null,
    earnedCents,
    spentCents,
    keptCents: earnedCents - spentCents,
    savingsRatePct:
      earnedCents > 0 ? Math.round(((earnedCents - spentCents) / earnedCents) * 1000) / 10 : null,
    lastYear,
    months,
    lightestMonth: lightest ? { month: lightest.month, cents: lightest.spentCents } : null,
    heaviestMonth:
      heaviest && heaviest !== lightest
        ? { month: heaviest.month, cents: heaviest.spentCents }
        : null,
    netWorth: {
      startCents: startPoint?.netCents ?? null,
      endCents: endPoint?.netCents ?? null,
      debtStartCents: startPoint?.debtsCents ?? null,
      debtEndCents: endPoint?.debtsCents ?? null,
      points: nw.filter((p) => known(p.date)).map((p) => ({ date: p.date, cents: p.netCents })),
    },
    categories,
    merchants,
    regular,
    biggest: big,
    recurring,
    facts: {
      transactions,
      noSpendDays,
      longestNoSpendStreak: longest,
      busiestWeekday: busiest,
      biggestDay,
    },
    investing,
  };
}

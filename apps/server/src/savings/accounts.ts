import { type MunyDb, schema } from "@muny/db";
import type { SavingsAccountInfo, SavingsAccountMonth, SavingsAccountsReport } from "@muny/shared";
import { and, eq, inArray } from "drizzle-orm";
import { listAccounts } from "../ledger/accounts.js";
import { localToday } from "../lib/dates.js";
import { balanceHistory } from "../reports/service.js";
import { addMonths, monthEnd } from "../reports/spending.js";

/**
 * Savings accounts (D-038): balances over time, interest earned, the rate
 * actually earned, and how much is being added each month. Interest is money
 * in that's categorized "Interest & Dividends" or that the bank describes as
 * interest.
 */

const INTEREST_TEXT =
  /\binterest\b|\bint\.? ?(paid|earned|pymt|payment|credit)|\bdividend\b|\bapy\b/i;

export function isInterest(t: {
  amountCents: number;
  category: string | null;
  description: string;
}): boolean {
  return (
    t.amountCents > 0 &&
    (t.category === "Interest & Dividends" || INTEREST_TEXT.test(t.description))
  );
}

const daysBefore = (d: string, n: number) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() - n);
  return x.toISOString().slice(0, 10);
};

export function savingsAccountsReport(db: MunyDb, today = localToday()): SavingsAccountsReport {
  const accounts = listAccounts(db).filter((a) => a.type === "savings" && !a.hidden);
  if (!accounts.length)
    return {
      totalBalanceCents: 0,
      interestYtdCents: 0,
      interest12Cents: 0,
      blendedApyBps: null,
      accounts: [],
    };
  const ids = accounts.map((a) => a.id);
  const apyOf = new Map(
    db
      .select({
        id: schema.accounts.id,
        apyBps: schema.accounts.apyBps,
        planMonthlyCents: schema.accounts.planMonthlyCents,
        planRateBps: schema.accounts.planRateBps,
      })
      .from(schema.accounts)
      .where(inArray(schema.accounts.id, ids))
      .all()
      .map((r) => [r.id, r]),
  );
  const t = schema.transactions;
  const txns = db
    .select({
      accountId: t.accountId,
      date: t.postedDate,
      amountCents: t.amountCents,
      description: t.rawDescription,
      category: schema.categories.name,
    })
    .from(t)
    .leftJoin(schema.categories, eq(schema.categories.id, t.categoryId))
    .where(and(inArray(t.accountId, ids), eq(t.pending, false), eq(t.hidden, false)))
    .all();
  const { balanceAt } = balanceHistory(db, true);

  const thisMonth = today.slice(0, 7);
  const monthsBack = Array.from({ length: 24 }, (_, i) => addMonths(thisMonth, i - 23));
  const yearAgo = daysBefore(today, 365);
  const monthAgo = daysBefore(today, 30);

  const list: SavingsAccountInfo[] = accounts.map((a) => {
    const mine = txns.filter((x) => x.accountId === a.id);
    const interest = mine.filter(isInterest);
    const sumSince = (from: (d: string) => boolean) =>
      interest.filter((x) => from(x.date)).reduce((s, x) => s + x.amountCents, 0);
    const months: SavingsAccountMonth[] = monthsBack.map((m) => {
      const inMonth = mine.filter((x) => x.date.startsWith(m));
      const other = inMonth.filter((x) => !isInterest(x));
      return {
        month: m,
        balanceCents: balanceAt(a.id, a.balanceCents, m === thisMonth ? today : monthEnd(m)),
        interestCents: inMonth.filter(isInterest).reduce((s, x) => s + x.amountCents, 0),
        depositsCents: other
          .filter((x) => x.amountCents > 0)
          .reduce((s, x) => s + x.amountCents, 0),
        withdrawalsCents: other
          .filter((x) => x.amountCents < 0)
          .reduce((s, x) => s + x.amountCents, 0),
      };
    });
    const last12 = sumSince((d) => d > yearAgo);
    // The rate earned: the year's interest over the average balance in the months it covers.
    const firstInterest = interest
      .filter((x) => x.date > yearAgo)
      .map((x) => x.date)
      .sort()[0];
    let earnedApyBps: number | null = null;
    if (firstInterest && last12 > 0) {
      const covered = months.filter((m) => m.month >= firstInterest.slice(0, 7));
      const avg = covered.reduce((s, m) => s + m.balanceCents, 0) / Math.max(1, covered.length);
      const share = Math.max(1, covered.length) / 12;
      if (avg > 0) earnedApyBps = Math.round((last12 / avg / share) * 10000);
    }
    const recent = months.slice(-12);
    const net = recent.reduce((s, m) => s + m.depositsCents + m.withdrawalsCents, 0);
    const active = recent.filter(
      (m) => m.balanceCents !== 0 || m.depositsCents || m.withdrawalsCents,
    ).length;
    return {
      id: a.id,
      name: a.name,
      institutionName: a.institutionName,
      mask: a.mask,
      balanceCents: a.balanceCents,
      apyBps: apyOf.get(a.id)?.apyBps ?? null,
      plan:
        apyOf.get(a.id)?.planMonthlyCents != null
          ? {
              monthlyCents: apyOf.get(a.id)?.planMonthlyCents as number,
              rateBps: apyOf.get(a.id)?.planRateBps ?? null,
            }
          : null,
      earnedApyBps,
      interest: {
        last30Cents: sumSince((d) => d > monthAgo),
        ytdCents: sumSince((d) => d.startsWith(today.slice(0, 4))),
        last12Cents: last12,
        allTimeCents: interest.reduce((s, x) => s + x.amountCents, 0),
      },
      lastInterestDate:
        interest
          .map((x) => x.date)
          .sort()
          .at(-1) ?? null,
      avgMonthlyContributionCents: Math.round(net / Math.max(1, active)),
      months,
    };
  });

  const total = list.reduce((s, a) => s + a.balanceCents, 0);
  const rate = (a: SavingsAccountInfo) => a.apyBps ?? a.earnedApyBps;
  const rated = list.filter((a) => rate(a) !== null && a.balanceCents > 0);
  const ratedTotal = rated.reduce((s, a) => s + a.balanceCents, 0);
  return {
    totalBalanceCents: total,
    interestYtdCents: list.reduce((s, a) => s + a.interest.ytdCents, 0),
    interest12Cents: list.reduce((s, a) => s + a.interest.last12Cents, 0),
    blendedApyBps: ratedTotal
      ? Math.round(rated.reduce((s, a) => s + a.balanceCents * (rate(a) as number), 0) / ratedTotal)
      : null,
    accounts: list.sort((a, b) => b.balanceCents - a.balanceCents),
  };
}

/** Set (or clear) the APY you entered for a savings account. */
export function setAccountApy(db: MunyDb, id: string, apyBps: number | null): boolean {
  const r = db
    .update(schema.accounts)
    .set({ apyBps })
    .where(and(eq(schema.accounts.id, id), eq(schema.accounts.type, "savings")))
    .run();
  return r.changes > 0;
}

/** Save (or clear, with null) a savings plan: monthly deposit and the rate to project with. */
export function setSavingsPlan(
  db: MunyDb,
  id: string,
  plan: { monthlyCents: number; rateBps: number | null } | null,
): boolean {
  const r = db
    .update(schema.accounts)
    .set({ planMonthlyCents: plan?.monthlyCents ?? null, planRateBps: plan?.rateBps ?? null })
    .where(and(eq(schema.accounts.id, id), eq(schema.accounts.type, "savings")))
    .run();
  return r.changes > 0;
}

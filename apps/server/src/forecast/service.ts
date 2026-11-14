import { addDaysIso, addInterval } from "@muny/core";
import { type MunyDb, schema } from "@muny/db";
import { type BalanceForecast, FORECAST_ACCOUNT_TYPES, type ForecastItem } from "@muny/shared";
import { and, eq, gte, inArray, isNotNull, lt } from "drizzle-orm";
import { accountAlerts } from "../alerts/accounts.js";
import { cardsReport } from "../cards/service.js";
import { listAccounts } from "../ledger/accounts.js";
import { localToday } from "../lib/dates.js";
import { upcoming } from "../recurring/service.js";

/**
 * Where an account's balance is headed (D-090), day by day:
 *
 *   today's balance + pending transactions
 *   + recurring bills, subscriptions and income charged to this account
 *   − credit card payments made from it (this statement, then what you usually pay)
 *   − everyday spending: the last 90 days' average from this account, without
 *     recurring charges, card payments, money coming in, and the largest 5% of
 *     charges (one-offs like a repair).
 *
 * Read-only. An estimate: anything you haven't done before won't be in it.
 */

const LOOKBACK = 90;

/** The accounts worth forecasting: checking, savings and cash you can see. */
function forecastable(db: MunyDb) {
  return listAccounts(db).filter(
    (a) => !a.hidden && (FORECAST_ACCOUNT_TYPES as readonly string[]).includes(a.type),
  );
}

/** The checking account with the most activity lately: the one most people mean. */
function defaultAccount(db: MunyDb, ids: string[], today: string): string | null {
  if (!ids.length) return null;
  const t = schema.transactions;
  const counts = new Map<string, number>();
  for (const r of db
    .select({ accountId: t.accountId })
    .from(t)
    .where(and(inArray(t.accountId, ids), gte(t.postedDate, addDaysIso(today, -LOOKBACK))))
    .all())
    counts.set(r.accountId, (counts.get(r.accountId) ?? 0) + 1);
  return [...ids].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0))[0] ?? null;
}

export function balanceForecast(
  db: MunyDb,
  opts: { accountId?: string | null; days?: number } = {},
  today = localToday(),
): BalanceForecast {
  const days = Math.min(Math.max(opts.days ?? 60, 7), 120);
  const end = addDaysIso(today, days);
  const all = forecastable(db);
  const checking = all.filter((a) => a.type === "checking").map((a) => a.id);
  const id =
    opts.accountId && all.some((a) => a.id === opts.accountId)
      ? opts.accountId
      : (defaultAccount(db, checking.length ? checking : all.map((a) => a.id), today) ?? null);
  const acct = all.find((a) => a.id === id) ?? null;
  const accounts = all.map((a) => ({ id: a.id, name: a.name, type: a.type }));
  if (!acct)
    return {
      today,
      days,
      account: null,
      accounts,
      startCents: 0,
      pendingCents: 0,
      dailySpendCents: 0,
      points: [],
      items: [],
      lowest: { date: today, balanceCents: 0 },
      thresholdCents: null,
      firstBelow: null,
      endCents: 0,
    };

  const t = schema.transactions;
  const items: ForecastItem[] = [];

  // Pending transactions aren't in the balance yet; they land today.
  const pending = db
    .select({ amountCents: t.amountCents })
    .from(t)
    .where(and(eq(t.accountId, acct.id), eq(t.pending, true), eq(t.hidden, false)))
    .all();
  const pendingCents = pending.reduce((s, p) => s + p.amountCents, 0);
  if (pending.length)
    items.push({
      date: today,
      name: `${pending.length} pending transaction${pending.length === 1 ? "" : "s"}`,
      amountCents: pendingCents,
      kind: "pending",
      estimate: false,
      ref: null,
    });

  // Credit card payments from this account.
  const cards = cardsReport(db, today).cards;
  const cardPaymentTxns = new Set(cards.flatMap((c) => c.payments.map((p) => p.transactionId)));
  for (const c of cards) {
    const from =
      c.paymentFromAccountId ??
      (() => {
        const names = new Map<string, number>();
        for (const p of c.payments)
          if (p.fromAccountName)
            names.set(p.fromAccountName, (names.get(p.fromAccountName) ?? 0) + 1);
        const top = [...names].sort((a, b) => b[1] - a[1])[0]?.[0];
        return all.find((a) => a.name === top)?.id ?? null;
      })();
    if (from !== acct.id) continue;
    const recent = c.payments.slice(0, 3);
    const usual = recent.length
      ? Math.round(recent.reduce((s, p) => s + p.amountCents, 0) / recent.length)
      : null;
    const paidThisCycle =
      !!c.statementDate && !!c.lastPayment && c.lastPayment.date >= c.statementDate;
    let due = c.dueDate;
    if (!due && c.paymentDay && usual) {
      const d = Math.min(c.paymentDay, 28);
      due = `${today.slice(0, 8)}${String(d).padStart(2, "0")}`;
      if (due < today) due = addInterval(due, "monthly");
    }
    if (!due) continue;
    let first = true;
    for (let i = 0; i < 6; i++) {
      const date = addInterval(due, "monthly", i);
      if (date > end) break;
      const current = first && c.dueDate === due;
      first = false;
      if (current && paidThisCycle) continue;
      const amount = current
        ? (c.paymentAmountCents ?? c.statementBalanceCents ?? usual)
        : (c.paymentAmountCents ?? usual);
      if (!amount || amount <= 0) continue;
      items.push({
        date: date < today ? today : date,
        name: `${c.name} payment`,
        amountCents: -amount,
        kind: "card",
        estimate: !current || (c.paymentAmountCents === null && c.statementBalanceCents === null),
        ref: c.accountId,
      });
    }
  }

  // Recurring bills and income on this account; a series that's really a card payment is counted above.
  const seriesAccount = new Map(
    db
      .select({ id: schema.recurringSeries.id, accountId: schema.recurringSeries.accountId })
      .from(schema.recurringSeries)
      .all()
      .map((s) => [s.id, s.accountId]),
  );
  const cardSeries = new Set(
    cardPaymentTxns.size
      ? db
          .select({ s: t.recurringSeriesId })
          .from(t)
          .where(and(inArray(t.id, [...cardPaymentTxns]), isNotNull(t.recurringSeriesId)))
          .all()
          .map((r) => r.s as string)
      : [],
  );
  for (const u of upcoming(db, today, end, today, false)) {
    if (seriesAccount.get(u.seriesId) !== acct.id || cardSeries.has(u.seriesId)) continue;
    items.push({
      date: u.date,
      name: u.name,
      amountCents: u.amountCents,
      kind: u.kind === "income" ? "income" : u.kind,
      estimate: false,
      ref: u.seriesId,
    });
  }

  // Everyday spending: what's left of the last 90 days' money out.
  const since = addDaysIso(today, -LOOKBACK);
  const out = db
    .select({ id: t.id, amountCents: t.amountCents, date: t.postedDate })
    .from(t)
    .where(
      and(
        eq(t.accountId, acct.id),
        eq(t.pending, false),
        eq(t.hidden, false),
        gte(t.postedDate, since),
        lt(t.postedDate, today),
        lt(t.amountCents, 0),
      ),
    )
    .all()
    .filter((x) => !cardPaymentTxns.has(x.id));
  const linked = new Set(
    out.length
      ? db
          .select({ id: t.id })
          .from(t)
          .where(
            and(
              inArray(
                t.id,
                out.map((x) => x.id),
              ),
              isNotNull(t.recurringSeriesId),
            ),
          )
          .all()
          .map((r) => r.id)
      : [],
  );
  const everyday = out.filter((x) => !linked.has(x.id)).map((x) => -x.amountCents);
  everyday.sort((a, b) => a - b);
  // One-offs: among the largest 5%, those more than three times the typical charge.
  const median = everyday[Math.floor(everyday.length / 2)] ?? 0;
  const cut = everyday.length - Math.floor(everyday.length * 0.05);
  const keep = everyday.filter((v, i) => i < cut || v <= median * 3);
  const firstDate = out.reduce((m, x) => (x.date < m ? x.date : m), today);
  const span = Math.max(
    14,
    Math.min(LOOKBACK, Math.round((Date.parse(today) - Date.parse(firstDate)) / 86_400_000)),
  );
  const dailySpendCents = Math.round(keep.reduce((s, v) => s + v, 0) / span);

  items.sort((a, b) => a.date.localeCompare(b.date) || a.amountCents - b.amountCents);

  // Day by day: today gets pending and anything overdue; spending starts tomorrow.
  const startCents = acct.balanceCents + pendingCents;
  const byDay = new Map<string, number>();
  for (const it of items)
    if (it.kind !== "pending") byDay.set(it.date, (byDay.get(it.date) ?? 0) + it.amountCents);
  const points: BalanceForecast["points"] = [];
  let bal = startCents;
  for (let i = 0; i <= days; i++) {
    const date = addDaysIso(today, i);
    if (i > 0) bal -= dailySpendCents;
    bal += byDay.get(date) ?? 0;
    points.push({ date, balanceCents: bal });
  }
  const lowest = points.reduce(
    (m, p) => (p.balanceCents < m.balanceCents ? p : m),
    points[0] as {
      date: string;
      balanceCents: number;
    },
  );
  const thresholdCents = accountAlerts(db).get(acct.id)?.lowBalanceCents ?? null;
  const floor = thresholdCents ?? 0;
  const firstBelow = points.find((p) => p.balanceCents < floor) ?? null;
  return {
    today,
    days,
    account: { id: acct.id, name: acct.name, type: acct.type, balanceCents: acct.balanceCents },
    accounts,
    startCents,
    pendingCents,
    dailySpendCents,
    points,
    items,
    lowest,
    thresholdCents,
    firstBelow,
    endCents: points.at(-1)?.balanceCents ?? startCents,
  };
}

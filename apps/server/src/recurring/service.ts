import {
  addInterval,
  cleanPayeeName,
  detectRecurring,
  monthlyCents,
  normalizeDescription,
  type RecurringInput,
  type RecurringInterval,
} from "@muny/core";
import { type MunyDb, newId, schema } from "@muny/db";
import type {
  RecurringKind,
  RecurringScanResult,
  RecurringSeries,
  UpcomingCharge,
} from "@muny/shared";
import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { localToday } from "../lib/dates.js";

type Tx = Parameters<Parameters<MunyDb["transaction"]>[0]>[0];
type Db = MunyDb | Tx;

const DAYS: Record<RecurringInterval, number> = {
  weekly: 7,
  biweekly: 14,
  monthly: 30.44,
  quarterly: 91.31,
  semiannual: 182.62,
  annual: 365.25,
};
const dayNum = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;
const grace = (i: RecurringInterval) => DAYS[i] * 1.5 + 7;

/** Merchant key for a transaction: its merchant name, else a cleaned description. */
export function merchantKey(payee: string | null, raw: string): string {
  return (payee ?? cleanPayeeName(raw) ?? normalizeDescription(raw)).toLowerCase().trim();
}

const BILL_WORDS =
  /rent|mortgage|insurance|loan|electric|water|sewer|trash|gas & heating|internet|phone|utilit|bill|auto payment|tax/i;

function kindFor(
  direction: "out" | "in",
  fixedAmount: boolean,
  categoryName: string | null | undefined,
): RecurringKind {
  if (direction === "in") return "income";
  return !fixedAmount || BILL_WORDS.test(categoryName ?? "") ? "bill" : "subscription";
}

interface Row {
  id: string;
  accountId: string;
  postedDate: string;
  amountCents: number;
  rawDescription: string;
  payee: string | null;
  payeeId: string | null;
  categoryId: string | null;
  categoryName: string | null;
  recurringSeriesId: string | null;
}

/** Transactions that can be part of a recurring series (no transfers, hidden or pending). */
function loadRows(db: Db): Row[] {
  const t = schema.transactions;
  return db
    .select({
      id: t.id,
      accountId: t.accountId,
      postedDate: t.postedDate,
      amountCents: t.amountCents,
      rawDescription: t.rawDescription,
      payee: schema.payees.displayName,
      payeeId: t.payeeId,
      categoryId: t.categoryId,
      categoryName: schema.categories.name,
      recurringSeriesId: t.recurringSeriesId,
    })
    .from(t)
    .innerJoin(schema.accounts, eq(schema.accounts.id, t.accountId))
    .leftJoin(schema.payees, eq(schema.payees.id, t.payeeId))
    .leftJoin(schema.categories, eq(schema.categories.id, t.categoryId))
    .leftJoin(schema.categoryGroups, eq(schema.categoryGroups.id, schema.categories.groupId))
    .where(
      and(
        eq(t.pending, false),
        eq(t.hidden, false),
        // A bank's withdrawal that only paid for a PayPal purchase: the purchase recurs.
        isNull(t.fundsTransactionId),
        sql`${schema.accounts.type} <> 'loan'`,
        or(
          isNull(t.transferPairId),
          and(
            sql`${schema.categoryGroups.kind} is not null`,
            sql`${schema.categoryGroups.kind} <> 'transfer'`,
          ),
        ),
        or(isNull(schema.categoryGroups.kind), sql`${schema.categoryGroups.kind} <> 'transfer'`),
      ),
    )
    .all();
}

/**
 * Loan accounts' own entries (interest charged, payments received) aren't
 * bills or income: the payment from checking is the bill. Series detected
 * there (not ones you confirmed) are removed.
 */
function dropLoanSeries(tx: Tx) {
  const s = schema.recurringSeries;
  const loanIds = tx
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(eq(schema.accounts.type, "loan"))
    .all()
    .map((a) => a.id);
  if (!loanIds.length) return;
  const stale = tx
    .select({ id: s.id })
    .from(s)
    .where(and(inArray(s.accountId, loanIds), eq(s.status, "detected"), eq(s.userModified, false)))
    .all()
    .map((x) => x.id);
  if (!stale.length) return;
  tx.update(schema.transactions)
    .set({ recurringSeriesId: null })
    .where(inArray(schema.transactions.recurringSeriesId, stale))
    .run();
  tx.delete(s).where(inArray(s.id, stale)).run();
}

/**
 * Funding (a bank's withdrawal to PayPal for a PayPal purchase) never belongs
 * to a recurring series: the purchase does. Detach it; a series left with no
 * charges was only ever that funding (a duplicate of the purchase's series),
 * so it goes (or, if you edited it, is ignored).
 */
function dropFundingSeries(tx: Tx) {
  const s = schema.recurringSeries;
  const t = schema.transactions;
  const hit = [
    ...new Set(
      tx
        .select({ id: t.recurringSeriesId })
        .from(t)
        .where(and(isNotNull(t.fundsTransactionId), isNotNull(t.recurringSeriesId)))
        .all()
        .map((r) => r.id as string),
    ),
  ];
  if (!hit.length) return;
  tx.update(t)
    .set({ recurringSeriesId: null })
    .where(and(isNotNull(t.fundsTransactionId), inArray(t.recurringSeriesId, hit)))
    .run();
  const left = new Set(
    tx
      .select({ id: t.recurringSeriesId })
      .from(t)
      .where(inArray(t.recurringSeriesId, hit))
      .all()
      .map((r) => r.id as string),
  );
  const empty = tx
    .select({ id: s.id, userModified: s.userModified })
    .from(s)
    .where(inArray(s.id, hit))
    .all()
    .filter((x) => !left.has(x.id));
  const drop = empty.filter((x) => !x.userModified).map((x) => x.id);
  const ignore = empty.filter((x) => x.userModified).map((x) => x.id);
  if (drop.length) tx.delete(s).where(inArray(s.id, drop)).run();
  if (ignore.length) tx.update(s).set({ status: "ignored" }).where(inArray(s.id, ignore)).run();
}

const near = (a: number, b: number, pct: number) => Math.abs(a - b) <= Math.max(a, b) * pct;

/** Words too common in bank descriptions to say two merchants are the same. */
const COMMON_WORDS = new Set(
  "payment payments online mobile bank card credit debit transfer deposit loan loans service services purchase from with bill autopay auto recurring monthly corp company inc llc the and orig name entry descr trace".split(
    " ",
  ),
);

/** Distinctive words of a merchant key (4+ letters, not boilerplate). */
function keyWords(key: string): Set<string> {
  return new Set(
    key
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((w) => w.length >= 4 && !COMMON_WORDS.has(w)),
  );
}

/**
 * Detect recurring series across the whole ledger and reconcile with what's
 * stored: update known series, add new ones, link member transactions.
 * Ignored series stay ignored; user-edited fields are kept.
 */
export function rescanRecurring(tx: Tx, today = localToday()): RecurringScanResult {
  dropLoanSeries(tx);
  dropFundingSeries(tx);
  const rows = loadRows(tx);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const input: RecurringInput[] = rows.map((r) => ({
    id: r.id,
    key: merchantKey(r.payee, r.rawDescription),
    date: r.postedDate,
    amountCents: r.amountCents,
    accountId: r.accountId,
  }));
  const keyOf = new Map(input.map((i) => [i.id, i.key]));
  const candidates = detectRecurring(input, today);
  const s = schema.recurringSeries;
  const t = schema.transactions;
  const existing = tx.select().from(s).all();
  const touched = new Set<string>();
  const result: RecurringScanResult = { created: 0, updated: 0, linked: 0 };

  const link = (seriesId: string, ids: string[]) => {
    for (let i = 0; i < ids.length; i += 500) {
      result.linked += tx
        .update(t)
        .set({ recurringSeriesId: seriesId })
        .where(
          and(
            inArray(t.id, ids.slice(i, i + 500)),
            or(isNull(t.recurringSeriesId), sql`${t.recurringSeriesId} <> ${seriesId}`),
          ),
        )
        .run().changes;
    }
  };

  for (const c of candidates) {
    const match = existing.find(
      (e) =>
        !touched.has(e.id) &&
        e.matchKey === c.key &&
        e.direction === c.direction &&
        near(e.anchorCents, c.anchorCents, 0.3),
    );
    const latest = byId.get(c.transactionIds[c.transactionIds.length - 1] ?? "");
    if (match) {
      touched.add(match.id);
      if (match.status === "ignored") continue;
      tx.update(s)
        .set({
          anchorCents: c.anchorCents,
          firstDate: c.firstDate < match.firstDate ? c.firstDate : match.firstDate,
          lastDate: c.lastDate,
          lastAmountCents: c.lastAmountCents,
          accountId: c.accountId,
          ...(match.userModified
            ? {}
            : {
                interval: c.interval,
                expectedAmountCents: c.expectedAmountCents,
                fixedAmount: c.fixedAmount,
                categoryId: latest?.categoryId ?? match.categoryId,
                // Categories often arrive after detection (rules, edits); keep the type in step.
                kind: kindFor(c.direction, c.fixedAmount, latest?.categoryName),
              }),
        })
        .where(eq(s.id, match.id))
        .run();
      link(match.id, c.transactionIds);
      result.updated++;
      continue;
    }
    // Only start tracking things that are still running, or ended within the last two years.
    if (!c.active && dayNum(today) - dayNum(c.lastDate) > 730) continue;
    // A yearly charge that varies is plausible for taxes or insurance, not for
    // (say) an annual vacation; only track those when the category says bill.
    if (
      !c.fixedAmount &&
      (c.interval === "annual" || c.interval === "semiannual") &&
      !BILL_WORDS.test(latest?.categoryName ?? "")
    )
      continue;
    const kind = kindFor(c.direction, c.fixedAmount, latest?.categoryName);
    const id = newId();
    tx.insert(s)
      .values({
        id,
        name: (latest?.payee ?? cleanPayeeName(latest?.rawDescription ?? "") ?? c.key).slice(
          0,
          100,
        ),
        matchKey: c.key,
        direction: c.direction,
        anchorCents: c.anchorCents,
        kind,
        interval: c.interval,
        expectedAmountCents: c.expectedAmountCents,
        fixedAmount: c.fixedAmount,
        firstDate: c.firstDate,
        lastDate: c.lastDate,
        lastAmountCents: c.lastAmountCents,
        accountId: c.accountId,
        payeeId: latest?.payeeId ?? null,
        categoryId: latest?.categoryId ?? null,
      })
      .run();
    touched.add(id);
    link(id, c.transactionIds);
    result.created++;
  }

  // Attach newer charges detection didn't group with a series: manual series,
  // too few charges yet, or the same bill under a different description (a
  // bank sync often words it differently from the imported history, e.g.
  // "Citizens Mtg" vs "ORIG CO NAME:CITIZENS ... DESCR:MTG").
  const linkedNow = new Set(
    tx
      .select({ id: t.id })
      .from(t)
      .where(sql`${t.recurringSeriesId} is not null`)
      .all()
      .map((r) => r.id),
  );
  const claimed = new Set<string>();
  for (const e of tx.select().from(s).all()) {
    if (e.status === "ignored") continue;
    const words = keyWords(e.matchKey);
    const minGap = DAYS[e.interval as RecurringInterval] * 0.5;
    const newer = rows
      .filter((r) => {
        if (r.postedDate <= e.lastDate || claimed.has(r.id)) return false;
        if (r.recurringSeriesId !== null && r.recurringSeriesId !== e.id) return false;
        if (r.recurringSeriesId === null && linkedNow.has(r.id)) return false;
        if ((r.amountCents < 0 ? "out" : "in") !== e.direction) return false;
        const key = keyOf.get(r.id) ?? "";
        if (key === e.matchKey) return near(Math.abs(r.amountCents), e.anchorCents, 0.3);
        // Different wording: demand much more agreement before calling it the same bill.
        return (
          r.accountId === e.accountId &&
          dayNum(r.postedDate) - dayNum(e.lastDate) >= minGap &&
          (near(Math.abs(r.amountCents), e.anchorCents, 0.1) ||
            near(Math.abs(r.amountCents), Math.abs(e.lastAmountCents), 0.1)) &&
          [...keyWords(key)].some((w) => words.has(w))
        );
      })
      .sort((a, b) => a.postedDate.localeCompare(b.postedDate));
    for (const r of newer) claimed.add(r.id);
    const last = newer[newer.length - 1];
    if (!last) continue;
    tx.update(s)
      .set({
        lastDate: last.postedDate,
        lastAmountCents: last.amountCents,
        accountId: last.accountId,
      })
      .where(eq(s.id, e.id))
      .run();
    link(
      e.id,
      newer.map((r) => r.id),
    );
    result.updated++;
  }
  return result;
}

/** Create a series by hand from one transaction ("this is a subscription"). */
export function createFromTransaction(
  tx: Tx,
  txnId: string,
  interval: RecurringInterval,
  kind: RecurringKind | undefined,
): string | null {
  const row = loadRows(tx).find((r) => r.id === txnId);
  if (!row) return null;
  const id = newId();
  tx.insert(schema.recurringSeries)
    .values({
      id,
      name: (row.payee ?? cleanPayeeName(row.rawDescription) ?? row.rawDescription).slice(0, 100),
      matchKey: merchantKey(row.payee, row.rawDescription),
      direction: row.amountCents < 0 ? "out" : "in",
      anchorCents: Math.abs(row.amountCents),
      kind: kind ?? (row.amountCents > 0 ? "income" : "subscription"),
      status: "confirmed",
      interval,
      expectedAmountCents: row.amountCents,
      fixedAmount: true,
      firstDate: row.postedDate,
      lastDate: row.postedDate,
      lastAmountCents: row.amountCents,
      accountId: row.accountId,
      payeeId: row.payeeId,
      categoryId: row.categoryId,
      source: "manual",
      userModified: true,
    })
    .run();
  tx.update(schema.transactions)
    .set({ recurringSeriesId: id })
    .where(eq(schema.transactions.id, txnId))
    .run();
  // Pick up earlier/later charges of the same thing.
  rescanRecurring(tx);
  return id;
}

/** Stored series + computed fields (next date, monthly cost, lateness...). */
export function listSeries(db: Db, today = localToday(), id?: string): RecurringSeries[] {
  const s = schema.recurringSeries;
  const rows = db
    .select({
      s,
      accountName: schema.accounts.name,
      categoryName: schema.categories.name,
      count: sql<number>`(select count(*) from transactions x where x.recurring_series_id = "recurring_series"."id")`,
    })
    .from(s)
    .leftJoin(schema.accounts, eq(schema.accounts.id, s.accountId))
    .leftJoin(schema.categories, eq(schema.categories.id, s.categoryId))
    .where(id ? eq(s.id, id) : undefined)
    .all();

  // Price history for fixed-price series: last two distinct amounts.
  const ids = rows.map((r) => r.s.id);
  const history = new Map<string, { date: string; cents: number }[]>();
  if (ids.length) {
    for (const r of db
      .select({
        sid: schema.transactions.recurringSeriesId,
        date: schema.transactions.postedDate,
        cents: schema.transactions.amountCents,
      })
      .from(schema.transactions)
      .where(inArray(schema.transactions.recurringSeriesId, ids))
      .orderBy(schema.transactions.postedDate)
      .all()) {
      const k = r.sid as string;
      history.set(k, [...(history.get(k) ?? []), { date: r.date, cents: r.cents }]);
    }
  }

  const t = dayNum(today);
  return rows.map(({ s: r, accountName, categoryName, count }) => {
    const interval = r.interval as RecurringInterval;
    const next = addInterval(r.lastDate, interval);
    const sinceLast = t - dayNum(r.lastDate);
    const active = sinceLast <= grace(interval) && r.status !== "cancelled";
    let priceChange: RecurringSeries["priceChange"] = null;
    const h = history.get(r.id) ?? [];
    if (r.fixedAmount && h.length >= 2) {
      const last = h[h.length - 1] as { date: string; cents: number };
      for (let i = h.length - 2; i >= 0; i--) {
        const prev = h[i] as { date: string; cents: number };
        if (prev.cents !== last.cents) {
          // Only a real price change, not a one-off (the change must have stuck).
          const firstAtNew = h[i + 1] as { date: string; cents: number };
          // Only recent changes are news.
          if (t - dayNum(firstAtNew.date) <= 365)
            priceChange = { fromCents: prev.cents, toCents: last.cents, date: firstAtNew.date };
          break;
        }
      }
    }
    return {
      id: r.id,
      name: r.name,
      kind: r.kind,
      status: r.status,
      interval,
      expectedAmountCents: r.expectedAmountCents,
      fixedAmount: r.fixedAmount,
      monthlyCents: monthlyCents(r.expectedAmountCents, interval),
      annualCents: monthlyCents(r.expectedAmountCents, interval) * 12,
      firstDate: r.firstDate,
      lastDate: r.lastDate,
      lastAmountCents: r.lastAmountCents,
      nextDate: next,
      active,
      late: active && next < today,
      chargedAfterCancel: r.status === "cancelled" && !!r.cancelledAt && r.lastDate > r.cancelledAt,
      accountId: r.accountId,
      accountName,
      categoryId: r.categoryId,
      categoryName,
      source: r.source,
      cancelledAt: r.cancelledAt,
      notes: r.notes,
      transactionCount: Number(count),
      priceChange,
    };
  });
}

/** Expected charges between two dates for active, non-ignored, non-cancelled series. */
export function upcoming(db: Db, from: string, to: string, today = localToday()): UpcomingCharge[] {
  const out: UpcomingCharge[] = [];
  for (const s of listSeries(db, today)) {
    if (!s.active || s.status === "ignored" || s.status === "cancelled") continue;
    // A late charge is still expected; show it on today.
    const dates: string[] = s.nextDate < today ? [today] : [];
    for (let i = 1; i <= 400; i++) {
      const d = addInterval(s.lastDate, s.interval, i);
      if (d < today) continue;
      if (d > to) break;
      dates.push(d);
    }
    for (const date of dates.filter((d) => d >= from && d <= to))
      out.push({
        seriesId: s.id,
        name: s.name,
        kind: s.kind,
        date,
        amountCents: s.expectedAmountCents,
        accountName: s.accountName,
      });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
}

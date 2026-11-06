import { type MunyDb, newId, schema } from "@muny/db";
import {
  amortizedPayment,
  applyPayments,
  type CreateLenderLoansInput,
  type CreateLoanInput,
  type LenderFeeInput,
  type LenderPayment,
  type LenderPaymentInput,
  type Loan,
  type LoanDetailsInput,
  type LoanFee,
  type LoanKind,
  type LoanPaymentRow,
  type LoanStatement,
  type LoanStatementPreview,
  type LoansReport,
  payoff,
  splitBackward,
} from "@muny/shared";
import { and, eq, inArray, lt, ne, sql } from "drizzle-orm";
import { listAccounts } from "../ledger/accounts.js";
import { localToday } from "../lib/dates.js";
import type { LoanTerms } from "../sync/types.js";
import { parseLoanStatement, pdfLines } from "./statements.js";

/**
 * Loans (D-040, D-042). Every loan account gets a card: what you owe, the
 * rate, the payment, when it'll be paid off, and your payments.
 *
 * Payments toward a loan are the ones paired with money arriving in it
 * (synced loans) and the ones matching its payment words (and amount, when
 * set). Loans sharing the same words with no amount set share each payment,
 * in proportion to their monthly payments (one payment covering several
 * student loans). Synced loans keep the lender's balance; for loans Muny
 * tracks itself, the balance is worked out from the payments at its rate.
 */

type Db = MunyDb;
type Details = typeof schema.loanDetails.$inferSelect;

const SYNCED = new Set(["plaid", "teller", "paypal"]);

const addMonths = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
};

function detailsOf(db: Db, ids: string[]) {
  if (!ids.length) return new Map<string, Details>();
  return new Map(
    db
      .select()
      .from(schema.loanDetails)
      .where(inArray(schema.loanDetails.accountId, ids))
      .all()
      .map((d) => [d.accountId, d]),
  );
}

interface RawPayment {
  id: string;
  date: string;
  amountCents: number;
  description: string;
  fromAccountName: string;
}

/** Near an amount: within a dollar or 1%. */
const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(100, Math.round(b * 0.01));

/** Days of the month between two days, going around the month end (the 30th and the 2nd are 3 apart). */
const dayGap = (a: number, b: number) => {
  const d = Math.abs(a - b);
  return Math.min(d, 31 - d);
};
/** Payments within this many days of the due day count (banks post a few days either side). */
const DUE_WINDOW = 6;

/** The amounts a loan's payments are matched to: today's, then earlier ones (the payment changed). */
const amountsOf = (d: Details | undefined): number[] =>
  d?.paymentAmountCents ? [d.paymentAmountCents, ...(d.pastPaymentAmounts ?? [])] : [];

/** Outgoing transactions (not from loan accounts) whose description or payee contains the words. */
function byWords(db: Db, words: string | null | undefined) {
  const w = words?.trim();
  if (!w) return [];
  const t = schema.transactions;
  const a = schema.accounts;
  return db
    .select({
      id: t.id,
      date: t.postedDate,
      amountCents: t.amountCents,
      description: t.rawDescription,
      from: a.name,
      mask: a.mask,
    })
    .from(t)
    .innerJoin(a, eq(a.id, t.accountId))
    .leftJoin(schema.payees, eq(schema.payees.id, t.payeeId))
    .where(
      and(
        ne(a.type, "loan"),
        eq(t.pending, false),
        lt(t.amountCents, 0),
        sql`(instr(lower(${t.rawDescription}), lower(${w})) > 0 or instr(lower(coalesce(${schema.payees.displayName}, '')), lower(${w})) > 0)`,
      ),
    )
    .all();
}

/** A lender's yearly fee payments (any of the words, at least the fee amount), newest first. */
function feesFor(db: Db, words: string[], min: number, since: string): LoanFee[] {
  const out = new Map<string, LoanFee>();
  for (const w of words)
    for (const r of byWords(db, w))
      if (r.date >= since && -r.amountCents >= min)
        out.set(r.id, {
          transactionId: r.id,
          date: r.date,
          amountCents: -r.amountCents,
          fromAccountName: r.mask ? `${r.from} ••${r.mask}` : r.from,
        });
  return [...out.values()].sort((x, y) => y.date.localeCompare(x.date));
}

/** How loans are grouped by lender (and a lender's fee is found). */
export const lenderKeyOf = (name: string | null | undefined) => name?.trim().toLowerCase() || null;

/** The next fee date: the entered one rolled forward a year at a time, else a year after the last. */
function expectedFeeDate(entered: string | null, last: string | undefined, today: string) {
  let d = entered ?? (last ? addMonths(last, 12) : null);
  // A due date that's passed: the one after it (the fee was likely paid then).
  while (entered && d && d < today) d = addMonths(d, 12);
  return d;
}

/** Payments toward a loan, oldest first (whole payments; sharing happens later). */
function paymentsFor(
  db: Db,
  accountId: string,
  d: Details | undefined,
  since: string,
  /** The lender's yearly fee: payments of at least this much aren't loan payments. */
  feeMin: number | null = null,
): RawPayment[] {
  const t = schema.transactions;
  const a = schema.accounts;
  const loanSide = db
    .select({ pair: t.transferPairId })
    .from(t)
    .where(and(eq(t.accountId, accountId), sql`${t.transferPairId} is not null`))
    .all()
    .map((r) => r.pair as string);
  const out = new Map<string, RawPayment>();
  const add = (r: {
    id: string;
    date: string;
    amountCents: number;
    description: string;
    from: string;
    mask: string | null;
  }) => {
    if (r.date < since || r.amountCents >= 0) return;
    const amount = -r.amountCents;
    // The yearly fee isn't a loan payment.
    if (feeMin && amount >= feeMin) return;
    const amounts = amountsOf(d);
    if (amounts.length && !amounts.some((x) => near(amount, x))) return;
    out.set(r.id, {
      id: r.id,
      date: r.date,
      amountCents: amount,
      description: r.description,
      // The paying account, with its last 4 when known.
      fromAccountName: r.mask ? `${r.from} ••${r.mask}` : r.from,
    });
  };
  const cols = {
    id: t.id,
    date: t.postedDate,
    amountCents: t.amountCents,
    description: t.rawDescription,
    from: a.name,
    mask: a.mask,
  };
  if (loanSide.length)
    for (const r of db
      .select(cols)
      .from(t)
      .innerJoin(a, eq(a.id, t.accountId))
      .where(and(inArray(t.id, loanSide), eq(t.pending, false)))
      .all())
      add(r);
  for (const r of byWords(db, d?.paymentMatch)) add(r);
  const list = [...out.values()].sort((x, y) => x.date.localeCompare(y.date));
  const due = d?.nextDueDate ? Number(d.nextDueDate.slice(8, 10)) : null;
  if (!due) return list;
  const onTime = list.filter((p) => dayGap(Number(p.date.slice(8, 10)), due) <= DUE_WINDOW);
  return onTime.length ? onTime : list;
}

/** The usual payment: the middle of the last three. */
function usualPayment(list: { amountCents: number }[]): number | null {
  const last = list
    .slice(-3)
    .map((p) => p.amountCents)
    .sort((a, b) => a - b);
  return last.length ? (last[Math.floor(last.length / 2)] ?? null) : null;
}

/**
 * Loans that share payments: the same payment words and no amount set. Each
 * gets a share of every payment, by its monthly payment (else equally).
 */
function shares(
  details: Map<string, Details>,
  names: Map<string, string>,
  /** Loans paid through a lender's payments (split by their parts instead). */
  skip: Set<string> = new Set(),
) {
  const groups = new Map<string, Details[]>();
  for (const d of details.values()) {
    const w = d.paymentMatch?.trim().toLowerCase();
    if (!w || d.paymentAmountCents || skip.has(d.accountId)) continue;
    groups.set(w, [...(groups.get(w) ?? []), d]);
  }
  const out = new Map<string, { share: number; others: string[] }>();
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const weights = list.map((d) => d.monthlyPaymentCents ?? d.minimumPaymentCents ?? 0);
    const total = weights.reduce((s, w) => s + w, 0);
    list.forEach((d, i) => {
      out.set(d.accountId, {
        share: total > 0 ? (weights[i] ?? 0) / total : 1 / list.length,
        others: list.filter((x) => x !== d).map((x) => names.get(x.accountId) ?? ""),
      });
    });
  }
  return out;
}

/** Principal and interest of a mortgage payment, from its original amount, rate and term. */
function principalInterest(d: Details | undefined): number | null {
  if (!d?.originalPrincipalCents || d.aprBps == null || !d.termMonths) return null;
  return amortizedPayment(d.originalPrincipalCents, d.aprBps, d.termMonths);
}

/** The next date on any of these days of the month, from today. */
function nextDayOn(days: number[], today: string): string | null {
  const dates = days.map((day) => {
    for (let m = 0; m < 2; m++) {
      const base = addMonths(`${today.slice(0, 7)}-01`, m);
      const last = new Date(
        Date.UTC(Number(base.slice(0, 4)), Number(base.slice(5, 7)), 0),
      ).getUTCDate();
      const d = `${base.slice(0, 8)}${String(Math.min(day, last)).padStart(2, "0")}`;
      if (d >= today) return d;
    }
    return null;
  });
  return dates.filter((d): d is string => !!d).sort()[0] ?? null;
}

type Acct = ReturnType<typeof listAccounts>[number];

/** Lender payments (one payment, several loans): what each loan gets of each payment found. */
function lenderPaymentParts(
  db: Db,
  accounts: Acct[],
  details: Map<string, Details>,
  keyOf: (a: Acct) => string | null,
  feeOf: Map<string, { minCents: number }>,
  since: string,
) {
  const rows = db.select().from(schema.lenderPayments).all();
  const ids = new Set(accounts.map((a) => a.id));
  const loans = new Set<string>();
  const others = new Map<string, Set<string>>();
  const monthly = new Map<string, number>();
  const dueDays = new Map<string, number[]>();
  const live = rows
    .map((row) => {
      const parts = Object.entries(row.parts ?? {}).filter(([id, c]) => ids.has(id) && c > 0);
      return { row, parts, total: parts.reduce((t, [, c]) => t + c, 0) };
    })
    .filter((x) => x.parts.length && x.total > 0);
  for (const { row, parts } of live)
    for (const [id, c] of parts) {
      loans.add(id);
      monthly.set(id, (monthly.get(id) ?? 0) + c);
      if (row.dueDay) dueDays.set(id, [...(dueDays.get(id) ?? []), row.dueDay]);
      const o = others.get(id) ?? new Set<string>();
      for (const [x] of parts) if (x !== id) o.add(x);
      others.set(id, o);
    }

  // Candidates for each, and the best fit for each payment.
  const cands = new Map<string, RawPayment[]>();
  const owner = new Map<string, { id: string; fit: number }>();
  for (const { row, parts, total } of live) {
    const words = row.paymentMatch?.trim()
      ? [row.paymentMatch.trim()]
      : [
          ...new Set(
            accounts
              .filter((a) => keyOf(a) === row.lenderKey || parts.some(([id]) => id === a.id))
              .map((a) => details.get(a.id)?.paymentMatch?.trim().toLowerCase())
              .filter((w): w is string => !!w),
          ),
        ];
    const feeMin = feeOf.get(row.lenderKey)?.minCents ?? null;
    const list = new Map<string, RawPayment>();
    for (const w of words)
      for (const t of byWords(db, w)) {
        const amount = -t.amountCents;
        const day = Number(t.date.slice(8, 10));
        if (t.date < since || (feeMin && amount >= feeMin) || !near(amount, total)) continue;
        if ((row.startDate && t.date < row.startDate) || (row.endDate && t.date > row.endDate))
          continue;
        if (row.dueDay && dayGap(day, row.dueDay) > DUE_WINDOW) continue;
        list.set(t.id, {
          id: t.id,
          date: t.date,
          amountCents: amount,
          description: t.description,
          fromAccountName: t.mask ? `${t.from} ••${t.mask}` : t.from,
        });
      }
    cands.set(row.id, [...list.values()]);
    for (const p of list.values()) {
      const fit =
        Math.abs(p.amountCents - total) / total +
        (row.dueDay ? dayGap(Number(p.date.slice(8, 10)), row.dueDay) / 31 : 0);
      const cur = owner.get(p.id);
      if (!cur || fit < cur.fit) owner.set(p.id, { id: row.id, fit });
    }
  }

  // Split each payment by the parts (the last loan takes the rounding).
  const out = new Map<string, (RawPayment & { total: number })[]>();
  const claimed = new Set<string>();
  const list: LenderPayment[] = [];
  for (const { row, parts, total } of live) {
    const mine = (cands.get(row.id) ?? [])
      .filter((p) => owner.get(p.id)?.id === row.id)
      .sort((x, y) => x.date.localeCompare(y.date));
    for (const p of mine) {
      claimed.add(p.id);
      let left = p.amountCents;
      parts.forEach(([id, c], i) => {
        const part = i === parts.length - 1 ? left : Math.round((p.amountCents * c) / total);
        left -= part;
        out.set(id, [...(out.get(id) ?? []), { ...p, amountCents: part, total: p.amountCents }]);
      });
    }
    list.push({
      id: row.id,
      lenderKey: row.lenderKey,
      paymentMatch: row.paymentMatch,
      dueDay: row.dueDay,
      startDate: row.startDate,
      endDate: row.endDate,
      parts: Object.fromEntries(parts),
      totalCents: total,
      foundCount: mine.length,
      lastDate: mine.at(-1)?.date ?? null,
    });
  }
  for (const v of out.values()) v.sort((x, y) => x.date.localeCompare(y.date));
  return { loans, others, monthly, dueDays, parts: out, claimed, list };
}

export function loansReport(db: Db, today = localToday()): LoansReport {
  const all = listAccounts(db);
  const accounts = all.filter((a) => a.type === "loan" && !a.hidden);
  const details = detailsOf(
    db,
    accounts.map((a) => a.id),
  );
  const connOf = new Map(
    db
      .select({ id: schema.accounts.id, connectionId: schema.accounts.connectionId })
      .from(schema.accounts)
      .all()
      .map((r) => [r.id, r.connectionId]),
  );
  const year = today.slice(0, 4);
  const twoYearsAgo = addMonths(today, -24);
  const feeRows = db.select().from(schema.lenderFees).all();
  const feeOf = new Map(feeRows.map((f) => [f.lenderKey, f]));
  const keyOf = (a: (typeof accounts)[number]) =>
    lenderKeyOf(details.get(a.id)?.lender ?? a.institutionName);
  const nameOf = new Map(accounts.map((a) => [a.id, a.name]));

  // Payments covering several of a lender's loans: each found payment goes to the
  // best-fitting one (amount, then day), then is split across its loans by their parts.
  const sched = lenderPaymentParts(db, accounts, details, keyOf, feeOf, twoYearsAgo);
  // What statements say was applied to each loan (exact), and the latest statement date.
  const stmtRows = new Map<string, (typeof schema.loanStatementPayments.$inferSelect)[]>();
  for (const x of db.select().from(schema.loanStatementPayments).all())
    stmtRows.set(x.accountId, [...(stmtRows.get(x.accountId) ?? []), x]);
  const lastStatement = (id: string) =>
    (stmtRows.get(id) ?? []).reduce<string | null>(
      (m, x) => (!m || x.statementDate > m ? x.statementDate : m),
      null,
    );
  const shared = shares(details, nameOf, sched.loans);

  // Every loan's payments, then each payment that several loans could claim
  // (one lender, similar amounts) goes to the closest fit by amount and due day.
  const found = new Map<string, RawPayment[]>();
  for (const a of accounts) {
    const d = details.get(a.id);
    const start =
      d?.source === "manual" && d.startDate && d.startDate < twoYearsAgo
        ? d.startDate
        : twoYearsAgo;
    const k = keyOf(a);
    found.set(a.id, paymentsFor(db, a.id, d, start, (k && feeOf.get(k)?.minCents) || null));
  }
  const fit = (accountId: string, p: RawPayment) => {
    const d = details.get(accountId);
    const amounts = amountsOf(d);
    const amount = amounts.length
      ? Math.min(...amounts.map((x) => Math.abs(p.amountCents - x) / x))
      : 0;
    const day = d?.nextDueDate
      ? dayGap(Number(p.date.slice(8, 10)), Number(d.nextDueDate.slice(8, 10))) / 31
      : 0;
    return amount + day;
  };
  const owner = new Map<string, string>();
  for (const [accountId, list] of found)
    for (const p of list) {
      // Shared payments (no amount set) are split, not claimed.
      if (!details.get(accountId)?.paymentAmountCents) continue;
      const cur = owner.get(p.id);
      if (!cur || fit(accountId, p) < fit(cur, p)) owner.set(p.id, accountId);
    }
  const claimedElsewhere = (paymentId: string, accountId: string) => {
    const o = owner.get(paymentId);
    return o !== undefined && o !== accountId && !!details.get(accountId)?.paymentAmountCents;
  };

  const loans: Loan[] = accounts.map((a) => {
    const d = details.get(a.id);
    const connected = SYNCED.has(a.provider);
    const manual = !connected && d?.source === "manual";
    const startDate = manual ? (d?.startDate ?? null) : null;
    const share = shared.get(a.id);
    const viaLender = sched.loans.has(a.id);
    const whole = (found.get(a.id) ?? []).filter(
      (p) => !claimedElsewhere(p.id, a.id) && !sched.claimed.has(p.id),
    );
    // This loan's part of each payment.
    // Payments up to the latest statement come from the statement instead (exact).
    const stmtUntil = lastStatement(a.id);
    const raw: (RawPayment & { total: number | null })[] = (
      viaLender
        ? (sched.parts.get(a.id) ?? [])
        : whole.map((p) => ({
            ...p,
            total: share ? p.amountCents : null,
            amountCents: share ? Math.round(p.amountCents * share.share) : p.amountCents,
          }))
    ).filter((p) => !stmtUntil || p.date > stmtUntil);
    const apr = d?.aprBps ?? null;
    const pi = d?.kind === "mortgage" ? principalInterest(d) : null;
    const monthly =
      d?.monthlyPaymentCents ?? (viaLender ? (sched.monthly.get(a.id) ?? null) : usualPayment(raw));
    const escrowOf = (amount: number) => (pi !== null ? Math.max(0, amount - pi) : 0);

    let balance = Math.abs(a.balanceCents);
    let rows: LoanPaymentRow[] = raw.map((p) => ({
      transactionId: p.id,
      date: p.date,
      amountCents: p.amountCents,
      totalCents: p.total,
      escrowCents: pi !== null ? escrowOf(p.amountCents) : null,
      interestCents: null,
      principalCents: null,
      description: p.description,
      fromAccountName: p.fromAccountName,
    }));
    let interestThisYear: number | null = null;
    let splitEstimated = false;

    if (manual && d?.startBalanceCents != null && startDate) {
      const counted = raw
        .map((p, i) => ({ p, i }))
        .filter(({ p }) => p.date >= startDate && p.amountCents - escrowOf(p.amountCents) > 0);
      const r = applyPayments(
        d.startBalanceCents,
        apr ?? 0,
        startDate,
        counted.map(({ p }) => ({
          date: p.date,
          amountCents: p.amountCents - escrowOf(p.amountCents),
        })),
        today,
      );
      balance = r.balanceCents;
      const byIndex = new Map<number, { interestCents: number; principalCents: number }>();
      counted.forEach(({ i }, k) => {
        const x = r.payments[k];
        if (x) byIndex.set(i, x);
      });
      // Payments before the "as of" date: work their split back from what you owed then (estimates).
      const earlier = raw
        .map((p, i) => ({ p, i }))
        .filter(({ p }) => p.date < startDate)
        .reverse();
      if (apr !== null && earlier.length) {
        const split = splitBackward(
          d.startBalanceCents,
          apr,
          earlier.map(({ p }) => ({
            date: p.date,
            amountCents: p.amountCents - escrowOf(p.amountCents),
          })),
          d.kind === "mortgage",
        );
        earlier.forEach(({ i }, k) => {
          const x = split[k];
          if (x) byIndex.set(i, x);
        });
        splitEstimated = true;
      }
      rows = rows.map((p, i) => {
        const x = byIndex.get(i);
        return x ? { ...p, interestCents: x.interestCents, principalCents: x.principalCents } : p;
      });
    } else if (apr !== null && rows.length) {
      // Work the split back from the lender's balance today (estimates).
      const newest = [...rows].reverse();
      const split = splitBackward(
        balance,
        apr,
        newest.map((p) => ({ date: p.date, amountCents: p.amountCents - (p.escrowCents ?? 0) })),
        // Mortgages charge interest monthly on the balance; other loans by the day.
        d?.kind === "mortgage",
      );
      const byId = new Map(newest.map((p, i) => [p.transactionId, split[i]]));
      rows = rows.map((p) => {
        const x = byId.get(p.transactionId);
        return x ? { ...p, interestCents: x.interestCents, principalCents: x.principalCents } : p;
      });
      splitEstimated = true;
    }
    rows = [
      ...rows,
      ...(stmtRows.get(a.id) ?? []).map((x) => ({
        transactionId: `stmt:${x.id}`,
        date: x.date,
        amountCents: x.amountCents,
        totalCents: null,
        escrowCents: null,
        interestCents: x.interestCents,
        principalCents: x.principalCents,
        description: "From your statement",
        fromAccountName: "From your statement",
      })),
    ].sort((x, y) => x.date.localeCompare(y.date));
    const paidInterest = rows.filter((p) => p.date.startsWith(year) && p.interestCents !== null);
    if (paidInterest.length)
      interestThisYear = paidInterest.reduce((s, p) => s + (p.interestCents ?? 0), 0);

    // Payoff at the principal-and-interest part of the payment.
    const payingDown = pi ?? monthly;
    const plan = apr !== null && payingDown ? payoff(balance, apr, payingDown) : null;

    // Mortgage insurance: 20% equity on the original value to ask, 22% when it ends.
    let pmi: Loan["pmi"] = null;
    if (d?.kind === "mortgage" && d.originalValueCents) {
      const v = d.originalValueCents;
      const when = (target: number) => {
        if (balance <= target) return today;
        const i = plan?.balances.findIndex((b) => b <= target) ?? -1;
        return i >= 0 ? addMonths(today, i) : null;
      };
      pmi = {
        monthlyCents: d.pmiMonthlyCents ?? null,
        equityPct: Math.max(0, ((v - balance) / v) * 100),
        requestDate: when(Math.round(v * 0.8)),
        autoEndDate: when(Math.round(v * 0.78)),
      };
    }
    const prop = d?.propertyAccountId ? all.find((x) => x.id === d.propertyAccountId) : undefined;
    const last = rows.at(-1);
    return {
      accountId: a.id,
      name: a.name,
      institutionName: a.institutionName,
      mask: a.mask,
      kind: (d?.kind ?? "other") as LoanKind,
      lender: d?.lender ?? a.institutionName,
      source: manual ? "manual" : "plaid",
      connected,
      connectionId: connected && a.provider === "plaid" ? (connOf.get(a.id) ?? null) : null,
      balanceCents: balance,
      aprBps: apr,
      monthlyPaymentCents: monthly,
      minimumPaymentCents: d?.minimumPaymentCents ?? null,
      principalInterestCents: pi,
      escrowCents: pi !== null && monthly !== null ? Math.max(0, monthly - pi) : null,
      nextDueDate:
        d?.nextDueDate ??
        nextDayOn(sched.dueDays.get(a.id) ?? [], today) ??
        (last ? addMonths(last.date, 1) : null),
      originalPrincipalCents: d?.originalPrincipalCents ?? null,
      originationDate: d?.originationDate ?? null,
      termMonths: d?.termMonths ?? null,
      paymentMatch: d?.paymentMatch ?? null,
      paymentAmountCents: d?.paymentAmountCents ?? null,
      pastPaymentAmounts: d?.pastPaymentAmounts ?? [],
      startBalanceCents: manual ? (d?.startBalanceCents ?? null) : null,
      startDate,
      originalValueCents: d?.originalValueCents ?? null,
      pmiMonthlyCents: d?.pmiMonthlyCents ?? null,
      propertyAccountId: d?.propertyAccountId ?? null,
      sharedWith: viaLender
        ? [...(sched.others.get(a.id) ?? [])].map((id) => nameOf.get(id) ?? "")
        : (share?.others ?? []),
      splitEstimated,
      paidOffPct:
        d?.originalPrincipalCents && d.originalPrincipalCents > 0
          ? Math.max(
              0,
              Math.min(
                100,
                ((d.originalPrincipalCents - balance) / d.originalPrincipalCents) * 100,
              ),
            )
          : null,
      interestThisYearCents: interestThisYear,
      lastPayment: last ? { date: last.date, amountCents: last.amountCents } : null,
      payments: rows.filter((p) => p.date >= twoYearsAgo).reverse(),
      payoffMonths: plan?.months ?? null,
      payoffDate: plan?.months != null ? addMonths(today, plan.months) : null,
      interestRemainingCents: plan?.months != null ? plan.totalInterestCents : null,
      pmi,
      property: prop
        ? {
            accountId: prop.id,
            name: prop.name,
            valueCents: prop.balanceCents,
            equityCents: prop.balanceCents - balance,
            loanToValuePct: prop.balanceCents > 0 ? (balance / prop.balanceCents) * 100 : null,
          }
        : null,
    };
  });
  const upcoming = loans
    .filter((l) => l.nextDueDate && l.nextDueDate >= today && l.balanceCents > 0)
    .sort((a, b) => (a.nextDueDate as string).localeCompare(b.nextDueDate as string))[0];
  return {
    totalOwedCents: loans.reduce((s, l) => s + l.balanceCents, 0),
    monthlyPaymentsCents: loans
      .filter((l) => l.balanceCents > 0)
      .reduce((s, l) => s + (l.monthlyPaymentCents ?? 0), 0),
    nextDue: upcoming
      ? {
          accountId: upcoming.accountId,
          name: upcoming.name,
          date: upcoming.nextDueDate as string,
          amountCents: upcoming.monthlyPaymentCents,
        }
      : null,
    loans: loans.sort((a, b) => b.balanceCents - a.balanceCents),
    lenderPayments: sched.list,
    lenderFees: feeRows.map((f) => {
      // The fee's own words, else the words of the lender's loans.
      const words = f.paymentMatch?.trim()
        ? [f.paymentMatch.trim()]
        : [
            ...new Set(
              accounts
                .filter((a) => keyOf(a) === f.lenderKey)
                .map((a) => details.get(a.id)?.paymentMatch?.trim().toLowerCase())
                .filter((w): w is string => !!w),
            ),
          ];
      const fees = feesFor(db, words, f.minCents, twoYearsAgo);
      return {
        lenderKey: f.lenderKey,
        lender: f.lender,
        paymentMatch: f.paymentMatch,
        minCents: f.minCents,
        nextDueDate: f.nextDueDate,
        expectedDate: expectedFeeDate(f.nextDueDate, fees[0]?.date, today),
        fees,
      };
    }),
  };
}

/**
 * Keep manual loans' balances on their accounts (net worth, Accounts) in step
 * with the payments found so far, and repair synced loans that were saved as
 * manual. Runs at startup and after syncs and imports.
 */
export function refreshManualLoans(db: Db, today = localToday()) {
  const rows = db
    .select({ d: schema.loanDetails, provider: schema.connections.provider })
    .from(schema.loanDetails)
    .innerJoin(schema.accounts, eq(schema.accounts.id, schema.loanDetails.accountId))
    .leftJoin(schema.connections, eq(schema.connections.id, schema.accounts.connectionId))
    .all();
  for (const { d, provider } of rows) {
    if (provider && SYNCED.has(provider)) {
      // The lender reports this balance; Muny doesn't track it.
      if (d.source === "manual" || d.startBalanceCents !== null)
        db.update(schema.loanDetails)
          .set({ source: "plaid", startBalanceCents: null, startDate: null })
          .where(eq(schema.loanDetails.accountId, d.accountId))
          .run();
    }
  }
  if (!rows.some(({ d, provider }) => !(provider && SYNCED.has(provider)) && d.source === "manual"))
    return;
  const report = loansReport(db, today);
  for (const { d, provider } of rows) {
    if (provider && SYNCED.has(provider)) continue;
    if (d.source !== "manual" || d.startBalanceCents == null || !d.startDate) continue;
    const owed = report.loans.find((l) => l.accountId === d.accountId)?.balanceCents;
    if (owed === undefined) continue;
    db.update(schema.accounts)
      .set({ currentBalanceCents: -owed, balanceSource: "reported" })
      .where(eq(schema.accounts.id, d.accountId))
      .run();
    db.insert(schema.balanceSnapshots)
      .values({ accountId: d.accountId, date: today, balanceCents: -owed })
      .onConflictDoUpdate({
        target: [schema.balanceSnapshots.accountId, schema.balanceSnapshots.date],
        set: { balanceCents: -owed, estimated: false },
      })
      .run();
  }
}

const clean = (input: LoanDetailsInput) =>
  Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));

export function createManualLoan(db: Db, input: CreateLoanInput, today = localToday()): string {
  const id = newId();
  db.insert(schema.accounts)
    .values({
      id,
      name: input.name.trim().slice(0, 100),
      institutionName: input.lender?.trim() || null,
      type: "loan",
      balanceSource: "reported",
      currentBalanceCents: -Math.abs(input.startBalanceCents),
    })
    .run();
  db.insert(schema.loanDetails)
    .values({
      accountId: id,
      ...clean(input),
      kind: input.kind ?? "other",
      startBalanceCents: Math.abs(input.startBalanceCents),
      startDate: input.startDate ?? today,
      source: "manual",
    })
    .run();
  refreshManualLoans(db, today);
  return id;
}

export function updateLoan(db: Db, accountId: string, input: LoanDetailsInput): boolean {
  const acc = db
    .select({ type: schema.accounts.type, provider: schema.connections.provider })
    .from(schema.accounts)
    .leftJoin(schema.connections, eq(schema.connections.id, schema.accounts.connectionId))
    .where(eq(schema.accounts.id, accountId))
    .get();
  if (acc?.type !== "loan") return false;
  const synced = !!acc.provider && SYNCED.has(acc.provider);
  const patch = clean(input);
  // A synced loan's balance comes from the lender: never a start balance.
  if (synced) {
    delete patch.startBalanceCents;
    delete patch.startDate;
  }
  // A new payment amount: keep matching the old one, so earlier payments stay with this loan.
  const before = db
    .select({
      amount: schema.loanDetails.paymentAmountCents,
      past: schema.loanDetails.pastPaymentAmounts,
    })
    .from(schema.loanDetails)
    .where(eq(schema.loanDetails.accountId, accountId))
    .get();
  const next = patch.paymentAmountCents as number | null | undefined;
  if (next !== undefined || patch.pastPaymentAmounts !== undefined) {
    const past = [
      ...(before?.amount && next && before.amount !== next ? [before.amount] : []),
      ...((patch.pastPaymentAmounts as number[] | null | undefined) ?? before?.past ?? []),
    ];
    const current = next === undefined ? before?.amount : next;
    patch.pastPaymentAmounts = [...new Set(past)].filter((x) => x !== current).slice(0, 12);
  }
  const source = synced ? "plaid" : "manual";
  db.insert(schema.loanDetails)
    .values({ accountId, ...patch, source })
    .onConflictDoUpdate({ target: schema.loanDetails.accountId, set: { ...patch, source } })
    .run();
  refreshManualLoans(db);
  return true;
}

/** Store the lender's terms for a connection's loan accounts (what it reports wins). */
export function applyLoanTerms(db: Db, connectionId: string, terms: LoanTerms[]) {
  const linked = db
    .select({ id: schema.accounts.id, ref: schema.accounts.providerAccountRef })
    .from(schema.accounts)
    .where(and(eq(schema.accounts.connectionId, connectionId), eq(schema.accounts.type, "loan")))
    .all();
  const idOf = new Map(linked.filter((a) => a.ref).map((a) => [a.ref as string, a.id]));
  for (const t of terms) {
    const accountId = idOf.get(t.accountRef);
    if (!accountId) continue;
    const { accountRef: _, monthlyPaymentCents, ...rest } = t;
    const patch = Object.fromEntries(
      Object.entries({ ...rest, minimumPaymentCents: monthlyPaymentCents }).filter(
        ([, v]) => v !== null,
      ),
    );
    db.insert(schema.loanDetails)
      .values({ accountId, ...patch, source: "plaid" })
      .onConflictDoUpdate({
        target: schema.loanDetails.accountId,
        set: { ...patch, source: "plaid" },
      })
      .run();
  }
}

/** Set (or replace) a lender's yearly fee. */
export function setLenderFee(db: Db, input: LenderFeeInput) {
  const lenderKey = lenderKeyOf(input.lender);
  if (!lenderKey) throw new Error("Name the lender");
  const row = {
    lender: input.lender.trim(),
    paymentMatch: input.paymentMatch?.trim() || null,
    minCents: input.minCents,
    nextDueDate: input.nextDueDate ?? null,
  };
  db.insert(schema.lenderFees)
    .values({ lenderKey, ...row })
    .onConflictDoUpdate({
      target: schema.lenderFees.lenderKey,
      set: { ...row, updatedAt: new Date() },
    })
    .run();
  refreshManualLoans(db);
  return lenderKey;
}

export function removeLenderFee(db: Db, lender: string): boolean {
  const lenderKey = lenderKeyOf(lender);
  if (!lenderKey) return false;
  const n = db
    .delete(schema.lenderFees)
    .where(eq(schema.lenderFees.lenderKey, lenderKey))
    .run().changes;
  refreshManualLoans(db);
  return n > 0;
}

/** Replace a lender's payments (each covering several of its loans). */
export function setLenderPayments(db: Db, lender: string, payments: LenderPaymentInput[]) {
  const lenderKey = lenderKeyOf(lender);
  if (!lenderKey) throw new Error("Name the lender");
  const loanIds = new Set(
    db
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(eq(schema.accounts.type, "loan"))
      .all()
      .map((a) => a.id),
  );
  db.delete(schema.lenderPayments).where(eq(schema.lenderPayments.lenderKey, lenderKey)).run();
  for (const p of payments) {
    const parts = Object.fromEntries(
      Object.entries(p.parts).filter(([id, c]) => loanIds.has(id) && c > 0),
    );
    if (!Object.keys(parts).length) continue;
    db.insert(schema.lenderPayments)
      .values({
        id: newId(),
        lenderKey,
        paymentMatch: p.paymentMatch?.trim() || null,
        dueDay: p.dueDay ?? null,
        startDate: p.startDate ?? null,
        endDate: p.endDate ?? null,
        parts,
      })
      .run();
  }
  refreshManualLoans(db);
}

/** Several loans from one lender at once, and the payments that cover them. */
export function createLenderLoans(
  db: Db,
  input: CreateLenderLoansInput,
  today = localToday(),
): string[] {
  const ids = input.loans.map((l, i) => {
    const monthly = input.payments.reduce((t, p) => t + (p.parts[String(i)] ?? 0), 0);
    return createManualLoan(
      db,
      {
        name: l.name,
        kind: input.kind ?? "other",
        lender: input.lender.trim(),
        paymentMatch: input.paymentMatch?.trim() || null,
        startBalanceCents: l.startBalanceCents,
        startDate: input.startDate ?? today,
        aprBps: l.aprBps ?? null,
        nextDueDate: l.nextDueDate ?? null,
        monthlyPaymentCents: monthly || null,
      },
      today,
    );
  });
  if (input.payments.length)
    setLenderPayments(
      db,
      input.lender,
      input.payments.map((p) => ({
        paymentMatch: p.paymentMatch,
        dueDay: p.dueDay,
        parts: Object.fromEntries(
          Object.entries(p.parts)
            .map(([i, c]) => [ids[Number(i)] ?? "", c] as const)
            .filter(([id]) => id),
        ),
      })),
    );
  return ids;
}

/** Read a statement PDF and guess which of the lender's loans each group is. */
export async function previewStatement(
  db: Db,
  lender: string,
  pdf: Uint8Array,
): Promise<LoanStatementPreview | null> {
  let statement: LoanStatement | null = null;
  try {
    statement = parseLoanStatement(await pdfLines(pdf));
  } catch {
    return null;
  }
  if (!statement) return null;
  const key = lenderKeyOf(lender);
  const loans = loansReport(db).loans.filter((l) => lenderKeyOf(l.lender) === key);
  const matches: Record<string, string> = {};
  for (const g of statement.groups) {
    const code = new RegExp(`(^|[^A-Z0-9])${g.name}([^A-Z0-9]|$)`, "i");
    matches[g.name] = loans.find((l) => code.test(l.name))?.accountId ?? "new";
  }
  return { statement, matches };
}

/**
 * Bring each loan in line with the statement: rate, regular payment, due date,
 * original amount, and what you owe on the statement date (principal plus
 * interest built up), from which Muny keeps counting. What was applied since
 * the last statement is kept as an exact payment. "new" adds the group as a loan.
 */
export function applyStatement(
  db: Db,
  lender: string,
  statement: LoanStatement,
  mapping: Record<string, string>,
): string[] {
  const touched: string[] = [];
  for (const g of statement.groups) {
    const target = mapping[g.name];
    if (!target || target === "skip") continue;
    const owed = (g.principalCents ?? 0) + (g.accruedInterestCents ?? 0);
    const terms = {
      kind: "student" as const,
      lender: lender.trim(),
      aprBps: g.aprBps,
      monthlyPaymentCents: g.monthlyPaymentCents,
      nextDueDate: g.dueDate,
      originalPrincipalCents: g.originalPrincipalCents,
      originationDate: g.firstDisbursed,
      startBalanceCents: owed,
      startDate: statement.statementDate,
    };
    const clean = Object.fromEntries(Object.entries(terms).filter(([, v]) => v !== null));
    let id = target;
    if (target === "new") {
      id = createManualLoan(db, {
        ...clean,
        name: `Group ${g.name}`,
        startBalanceCents: owed,
      });
    } else if (!updateLoan(db, target, clean)) continue;
    if (g.paidCents && g.paidCents > 0) {
      const row = {
        date: statement.lastPayment?.date ?? statement.statementDate,
        amountCents: g.paidCents,
        interestCents: g.paidInterestCents ?? 0,
        principalCents: g.paidPrincipalCents ?? g.paidCents - (g.paidInterestCents ?? 0),
      };
      db.insert(schema.loanStatementPayments)
        .values({ id: newId(), accountId: id, statementDate: statement.statementDate, ...row })
        .onConflictDoUpdate({
          target: [
            schema.loanStatementPayments.accountId,
            schema.loanStatementPayments.statementDate,
          ],
          set: row,
        })
        .run();
    }
    touched.push(id);
  }
  refreshManualLoans(db);
  return touched;
}

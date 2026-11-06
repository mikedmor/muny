import { type MunyDb, newId, schema } from "@muny/db";
import {
  amortizedPayment,
  applyPayments,
  type CreateLoanInput,
  type Loan,
  type LoanDetailsInput,
  type LoanKind,
  type LoanPaymentRow,
  type LoansReport,
  payoff,
  splitBackward,
} from "@muny/shared";
import { and, eq, inArray, lt, ne, sql } from "drizzle-orm";
import { listAccounts } from "../ledger/accounts.js";
import { localToday } from "../lib/dates.js";
import type { LoanTerms } from "../sync/types.js";

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

/** Payments toward a loan, oldest first (whole payments; sharing happens later). */
function paymentsFor(
  db: Db,
  accountId: string,
  d: Details | undefined,
  since: string,
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
    if (d?.paymentAmountCents && !near(amount, d.paymentAmountCents)) return;
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
  const words = d?.paymentMatch?.trim();
  if (words)
    for (const r of db
      .select(cols)
      .from(t)
      .innerJoin(a, eq(a.id, t.accountId))
      .leftJoin(schema.payees, eq(schema.payees.id, t.payeeId))
      .where(
        and(
          ne(a.type, "loan"),
          eq(t.pending, false),
          lt(t.amountCents, 0),
          sql`(instr(lower(${t.rawDescription}), lower(${words})) > 0 or instr(lower(coalesce(${schema.payees.displayName}, '')), lower(${words})) > 0)`,
        ),
      )
      .all())
      add(r);
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
function shares(details: Map<string, Details>, names: Map<string, string>) {
  const groups = new Map<string, Details[]>();
  for (const d of details.values()) {
    const w = d.paymentMatch?.trim().toLowerCase();
    if (!w || d.paymentAmountCents) continue;
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
  const shared = shares(details, new Map(accounts.map((a) => [a.id, a.name])));
  const year = today.slice(0, 4);
  const twoYearsAgo = addMonths(today, -24);

  // Every loan's payments, then each payment that several loans could claim
  // (one lender, similar amounts) goes to the closest fit by amount and due day.
  const found = new Map<string, RawPayment[]>();
  for (const a of accounts) {
    const d = details.get(a.id);
    const start =
      d?.source === "manual" && d.startDate && d.startDate < twoYearsAgo
        ? d.startDate
        : twoYearsAgo;
    found.set(a.id, paymentsFor(db, a.id, d, start));
  }
  const fit = (accountId: string, p: RawPayment) => {
    const d = details.get(accountId);
    const amount = d?.paymentAmountCents
      ? Math.abs(p.amountCents - d.paymentAmountCents) / d.paymentAmountCents
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
    const whole = (found.get(a.id) ?? []).filter((p) => !claimedElsewhere(p.id, a.id));
    // This loan's part of each payment.
    const raw = whole.map((p) => ({
      ...p,
      total: share ? p.amountCents : null,
      amountCents: share ? Math.round(p.amountCents * share.share) : p.amountCents,
    }));
    const apr = d?.aprBps ?? null;
    const pi = d?.kind === "mortgage" ? principalInterest(d) : null;
    const monthly = d?.monthlyPaymentCents ?? usualPayment(raw);
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
      const byIndex = new Map(counted.map(({ i }, k) => [i, r.payments[k]]));
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
    const last = raw.at(-1);
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
      nextDueDate: d?.nextDueDate ?? (last ? addMonths(last.date, 1) : null),
      originalPrincipalCents: d?.originalPrincipalCents ?? null,
      originationDate: d?.originationDate ?? null,
      termMonths: d?.termMonths ?? null,
      paymentMatch: d?.paymentMatch ?? null,
      paymentAmountCents: d?.paymentAmountCents ?? null,
      startBalanceCents: manual ? (d?.startBalanceCents ?? null) : null,
      startDate,
      originalValueCents: d?.originalValueCents ?? null,
      pmiMonthlyCents: d?.pmiMonthlyCents ?? null,
      propertyAccountId: d?.propertyAccountId ?? null,
      sharedWith: share?.others ?? [],
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

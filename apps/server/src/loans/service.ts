import { type MunyDb, newId, schema } from "@muny/db";
import {
  applyPayments,
  type CreateLoanInput,
  type Loan,
  type LoanDetailsInput,
  type LoanKind,
  type LoanPaymentRow,
  type LoansReport,
  payoff,
} from "@muny/shared";
import { and, eq, inArray, lt, ne, sql } from "drizzle-orm";
import { listAccounts } from "../ledger/accounts.js";
import { localToday } from "../lib/dates.js";
import type { LoanTerms } from "../sync/types.js";

/**
 * Loans (D-040). Every loan account gets a card: what you owe, the rate, the
 * payment, when it'll be paid off, and your payments. Payments are the ones
 * paired with money arriving in the loan (synced loans) and the ones matching
 * the loan's payment words (any loan). A manual loan's balance is worked out
 * from those payments at its rate, and kept on the account for net worth.
 */

type Db = MunyDb;

const addMonths = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
};

function detailsOf(db: Db, ids: string[]) {
  if (!ids.length) return new Map<string, typeof schema.loanDetails.$inferSelect>();
  return new Map(
    db
      .select()
      .from(schema.loanDetails)
      .where(inArray(schema.loanDetails.accountId, ids))
      .all()
      .map((d) => [d.accountId, d]),
  );
}

/** Payments toward a loan, oldest first. */
function paymentsFor(
  db: Db,
  accountId: string,
  match: string | null,
  since: string,
): { id: string; date: string; amountCents: number; description: string }[] {
  const t = schema.transactions;
  const loanSide = db
    .select({ pair: t.transferPairId })
    .from(t)
    .where(and(eq(t.accountId, accountId), sql`${t.transferPairId} is not null`))
    .all()
    .map((r) => r.pair as string);
  const out = new Map<
    string,
    { id: string; date: string; amountCents: number; description: string }
  >();
  const add = (r: { id: string; date: string; amountCents: number; description: string }) => {
    if (r.date >= since && r.amountCents < 0) out.set(r.id, { ...r, amountCents: -r.amountCents });
  };
  if (loanSide.length)
    for (const r of db
      .select({
        id: t.id,
        date: t.postedDate,
        amountCents: t.amountCents,
        description: t.rawDescription,
      })
      .from(t)
      .where(and(inArray(t.id, loanSide), eq(t.pending, false)))
      .all())
      add(r);
  const words = match?.trim();
  if (words)
    for (const r of db
      .select({
        id: t.id,
        date: t.postedDate,
        amountCents: t.amountCents,
        description: t.rawDescription,
      })
      .from(t)
      .innerJoin(schema.accounts, eq(schema.accounts.id, t.accountId))
      .leftJoin(schema.payees, eq(schema.payees.id, t.payeeId))
      .where(
        and(
          ne(schema.accounts.type, "loan"),
          eq(t.pending, false),
          lt(t.amountCents, 0),
          sql`(instr(lower(${t.rawDescription}), lower(${words})) > 0 or instr(lower(coalesce(${schema.payees.displayName}, '')), lower(${words})) > 0)`,
        ),
      )
      .all())
      add(r);
  return [...out.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** The usual payment: the middle of the last three. */
function usualPayment(list: { amountCents: number }[]): number | null {
  const last = list
    .slice(-3)
    .map((p) => p.amountCents)
    .sort((a, b) => a - b);
  return last.length ? (last[Math.floor(last.length / 2)] ?? null) : null;
}

export function loansReport(db: Db, today = localToday()): LoansReport {
  const accounts = listAccounts(db).filter((a) => a.type === "loan" && !a.hidden);
  const details = detailsOf(
    db,
    accounts.map((a) => a.id),
  );
  const year = today.slice(0, 4);
  const twoYearsAgo = addMonths(today, -24);
  const loans: Loan[] = accounts.map((a) => {
    const d = details.get(a.id);
    const manual = d?.source === "manual";
    const startDate = d?.startDate ?? null;
    const raw = paymentsFor(
      db,
      a.id,
      d?.paymentMatch ?? null,
      manual && startDate ? startDate : twoYearsAgo,
    );
    const apr = d?.aprBps ?? null;
    // Debts are negative balances; what you owe is the positive amount.
    let balance = Math.abs(a.balanceCents);
    let rows: LoanPaymentRow[] = raw.map((p) => ({
      transactionId: p.id,
      date: p.date,
      amountCents: p.amountCents,
      interestCents: null,
      principalCents: null,
      description: p.description,
    }));
    let interestThisYear: number | null = null;
    if (manual && d?.startBalanceCents != null && startDate) {
      const r = applyPayments(d.startBalanceCents, apr ?? 0, startDate, raw, today);
      balance = r.balanceCents;
      const byDate = new Map(r.payments.map((p) => [`${p.date}|${p.amountCents}`, p]));
      rows = rows.map((p) => {
        const x = byDate.get(`${p.date}|${p.amountCents}`);
        return x ? { ...p, interestCents: x.interestCents, principalCents: x.principalCents } : p;
      });
      interestThisYear = r.payments
        .filter((p) => p.date.startsWith(year))
        .reduce((s, p) => s + p.interestCents, 0);
    } else {
      // Interest the lender charged this year (the loan's own charges).
      const t = schema.transactions;
      const charged = db
        .select({ s: sql<number>`coalesce(sum(${t.amountCents}), 0)` })
        .from(t)
        .where(
          and(
            eq(t.accountId, a.id),
            lt(t.amountCents, 0),
            sql`${t.transferPairId} is null`,
            sql`substr(${t.postedDate}, 1, 4) = ${year}`,
          ),
        )
        .get()?.s;
      interestThisYear = charged ? -Number(charged) : null;
    }
    const monthly = d?.monthlyPaymentCents ?? usualPayment(raw);
    const plan = apr !== null && monthly ? payoff(balance, apr, monthly) : null;
    const last = raw.at(-1);
    return {
      accountId: a.id,
      name: a.name,
      institutionName: a.institutionName,
      mask: a.mask,
      kind: (d?.kind ?? "other") as LoanKind,
      lender: d?.lender ?? a.institutionName,
      source: manual ? "manual" : "plaid",
      connected: (a.provider === "plaid" || a.provider === "teller") && !manual,
      balanceCents: balance,
      aprBps: apr,
      monthlyPaymentCents: monthly,
      nextDueDate: d?.nextDueDate ?? (last ? addMonths(last.date, 1) : null),
      originalPrincipalCents: d?.originalPrincipalCents ?? null,
      originationDate: d?.originationDate ?? null,
      termMonths: d?.termMonths ?? null,
      paymentMatch: d?.paymentMatch ?? null,
      startBalanceCents: d?.startBalanceCents ?? null,
      startDate,
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
 * with the payments found so far. Runs at startup and after syncs and imports.
 */
export function refreshManualLoans(db: Db, today = localToday()) {
  const manual = db
    .select()
    .from(schema.loanDetails)
    .where(eq(schema.loanDetails.source, "manual"))
    .all();
  for (const d of manual) {
    if (d.startBalanceCents == null || !d.startDate) continue;
    const raw = paymentsFor(db, d.accountId, d.paymentMatch, d.startDate);
    const owed = applyPayments(d.startBalanceCents, d.aprBps ?? 0, d.startDate, raw).balanceCents;
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
    .select({ type: schema.accounts.type })
    .from(schema.accounts)
    .where(eq(schema.accounts.id, accountId))
    .get();
  if (acc?.type !== "loan") return false;
  const patch = clean(input);
  db.insert(schema.loanDetails)
    .values({ accountId, ...patch })
    .onConflictDoUpdate({ target: schema.loanDetails.accountId, set: patch })
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
    const { accountRef: _, ...rest } = t;
    const patch = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== null));
    db.insert(schema.loanDetails)
      .values({ accountId, ...patch, source: "plaid" })
      .onConflictDoUpdate({
        target: schema.loanDetails.accountId,
        set: { ...patch, source: "plaid" },
      })
      .run();
  }
}

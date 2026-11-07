import { type MunyDb, schema } from "@muny/db";
import type { StatementStatus } from "@muny/shared";
import { and, eq, isNotNull, isNull } from "drizzle-orm";

/**
 * Which statements each account has: every statement Muny knows of (stored
 * PDFs with a date, loan statements read, a card's newest statement), the
 * newest one, and the monthly ones that should exist but aren't in Muny.
 */

/** Days after a statement's date before Muny expects to have it. */
const GRACE_DAYS = 5;
/** Missing months listed at most (older gaps are rarely worth chasing). */
const MAX_MISSING = 24;

const monthOf = (iso: string) => iso.slice(0, 7);

/** The same day n months on (clamped to the month's last day). */
export function addMonthsIso(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const first = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(d, last));
  return first.toISOString().slice(0, 10);
}

const addDays = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** The status for one account's statement dates (any order, repeats fine). */
export function statusFor(
  accountId: string,
  dates: string[],
  today: string,
): StatementStatus | null {
  const sorted = [...new Set(dates.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort();
  const lastDate = sorted.at(-1);
  if (!lastDate) return null;
  const have = new Set(sorted.map(monthOf));
  // Months from the first statement through the newest that should be out by now.
  let through = lastDate;
  for (let k = 1; k < 600; k++) {
    const next = addMonthsIso(lastDate, k);
    if (addDays(next, GRACE_DAYS) > today) break;
    through = next;
  }
  const missingMonths: string[] = [];
  for (let m = `${monthOf(sorted[0] as string)}-01`; monthOf(m) <= monthOf(through); ) {
    if (!have.has(monthOf(m))) missingMonths.push(monthOf(m));
    m = addMonthsIso(m, 1);
  }
  let nextDate = addMonthsIso(lastDate, 1);
  while (addDays(nextDate, GRACE_DAYS) <= today) nextDate = addMonthsIso(nextDate, 1);
  return {
    accountId,
    lastDate,
    count: have.size,
    nextDate,
    missing: missingMonths.length,
    missingMonths: missingMonths.slice(-MAX_MISSING),
  };
}

export function statementStatus(
  db: MunyDb,
  today = new Date().toISOString().slice(0, 10),
): StatementStatus[] {
  const byAccount = new Map<string, string[]>();
  const add = (id: string | null, date: string | null) => {
    if (!id || !date) return;
    byAccount.set(id, [...(byAccount.get(id) ?? []), date]);
  };
  for (const d of db
    .select({ id: schema.documents.accountId, date: schema.documents.documentDate })
    .from(schema.documents)
    .where(isNotNull(schema.documents.accountId))
    .all())
    add(d.id, d.date);
  for (const p of db
    .select({
      id: schema.loanStatementPayments.accountId,
      date: schema.loanStatementPayments.statementDate,
    })
    .from(schema.loanStatementPayments)
    .all())
    add(p.id, p.date);
  for (const c of db
    .select({ id: schema.cardDetails.accountId, date: schema.cardDetails.statementDate })
    .from(schema.cardDetails)
    .all())
    add(c.id, c.date);
  return [...byAccount]
    .map(([id, dates]) => statusFor(id, dates, today))
    .filter((s): s is StatementStatus => s !== null);
}

/**
 * Statements kept before they were tied to accounts: a card statement goes to
 * the card it's filed under (by name), a loan statement to its lender's loan
 * when the lender has just one. Returns how many were linked.
 */
export function linkStatementDocuments(db: MunyDb): number {
  const accounts = db
    .select({
      id: schema.accounts.id,
      name: schema.accounts.name,
      type: schema.accounts.type,
      institution: schema.accounts.institutionName,
      lender: schema.loanDetails.lender,
    })
    .from(schema.accounts)
    .leftJoin(schema.loanDetails, eq(schema.loanDetails.accountId, schema.accounts.id))
    .all();
  const key = (s: string | null | undefined) => s?.trim().toLowerCase() ?? "";
  const only = <T>(xs: T[]) => (xs.length === 1 ? xs[0] : undefined);
  let linked = 0;
  for (const d of db
    .select({
      id: schema.documents.id,
      kind: schema.documents.kind,
      lender: schema.documents.lender,
    })
    .from(schema.documents)
    .where(and(isNull(schema.documents.accountId), isNotNull(schema.documents.lender)))
    .all()) {
    const want = key(d.lender);
    const acc =
      d.kind === "card_statement"
        ? only(accounts.filter((a) => a.type === "credit" && key(a.name) === want))
        : d.kind === "loan_statement"
          ? only(
              accounts.filter(
                (a) => a.type === "loan" && key(a.lender ?? a.institution ?? a.name) === want,
              ),
            )
          : undefined;
    if (!acc) continue;
    db.update(schema.documents)
      .set({ accountId: acc.id })
      .where(eq(schema.documents.id, d.id))
      .run();
    linked++;
  }
  return linked;
}

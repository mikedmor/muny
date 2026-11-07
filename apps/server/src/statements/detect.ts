import { type MunyDb, schema } from "@muny/db";
import type { CardStatement, SingleLoanStatement, StatementPreview } from "@muny/shared";
import { parseCardStatement } from "../cards/service.js";
import { parseLoanStatement, parseSingleLoanStatement } from "../loans/statements.js";
import { applyTemplates, firstValue } from "./templates.js";

/**
 * Read any statement PDF (already split into lines) and suggest what it is:
 * a card, one loan, several loans, or something Muny can't read (still kept
 * in Documents with a date you give). The account is picked by the last 4
 * digits printed on it.
 */

const EMPTY_CARD: CardStatement = {
  closingDate: null,
  dueDate: null,
  newBalanceCents: null,
  minimumPaymentCents: null,
  creditLimitCents: null,
  aprBps: null,
  previousBalanceCents: null,
  paymentsCents: null,
  interestYtd: null,
  minimumOnly: null,
  transactions: [],
};

const EMPTY_LOAN: SingleLoanStatement = {
  statementDate: null,
  dueDate: null,
  balanceCents: null,
  aprBps: null,
  paymentCents: null,
  lastPayment: null,
  interestYtdCents: null,
};

/** Every "ending in 1234" style number on a statement, in order. */
export function masksIn(text: string): string[] {
  return [
    ...text.matchAll(
      /(?:ending in|ending|last 4(?: digits)?|x{3,}|\*{3,}|account number:?[\s\dx*-]*?)\s*(\d{4})\b/gi,
    ),
  ].map((m) => m[1] as string);
}

/** The account (any type) whose last 4 digits are on the statement. */
export function accountForText(db: MunyDb, text: string) {
  const ends = masksIn(text);
  if (!ends.length) return { account: null, mask: null };
  const accounts = db
    .select({ id: schema.accounts.id, mask: schema.accounts.mask, type: schema.accounts.type })
    .from(schema.accounts)
    .all();
  for (const m of ends) {
    const a = accounts.find((x) => x.mask === m);
    if (a) return { account: a, mask: m };
  }
  return { account: null, mask: ends[0] as string };
}

/** A date to suggest for a statement Muny can't read: the one after a statement-date label. */
export function guessDate(lines: string[]): string | null {
  const label =
    /(?:statement (?:date|closing date|period)|closing date|period ending|ending date|through)\b/i;
  for (const line of lines) {
    const m = label.exec(line);
    if (!m) continue;
    const tail = line.slice(m.index + m[0].length);
    // A period "10/01/26 - 10/31/26": its end.
    const dates = [
      ...tail.matchAll(/\d{1,2}\/\d{1,2}\/\d{2,4}|[A-Z][a-z]{2,8}\.? \d{1,2},? \d{4}/g),
    ];
    const v = firstValue("date", dates.at(-1)?.[0] ?? "");
    if (typeof v === "string") return v;
  }
  return null;
}

const filled = (o: object, keys: string[]) =>
  keys.filter((k) => (o as Record<string, unknown>)[k] != null).length;

export function detectStatement(db: MunyDb, rows: string[][]): StatementPreview {
  const lines = rows.map((l) => l.join(" "));
  const text = lines.join("\n");
  const { account, mask } = accountForText(db, text);
  const base = { accountId: account?.id ?? null, mask, lines: lines.slice(0, 600) };

  const groups = parseLoanStatement(rows);
  if (groups && groups.groups.length > 1)
    return {
      ...base,
      kind: "groups",
      date: guessDate(lines),
      card: EMPTY_CARD,
      loan: EMPTY_LOAN,
      groups: groups.groups.map((g) => g.name),
      templates: [],
    };

  const card = parseCardStatement(text) ?? { ...EMPTY_CARD, transactions: [] };
  const loan = parseSingleLoanStatement(text) ?? { ...EMPTY_LOAN };
  const cardTemplates = applyTemplates(db, "card", lines, card);
  const loanTemplates = applyTemplates(db, "loan", lines, loan);

  // The account's type decides; then statements you taught Muny; then what read best.
  let kind: StatementPreview["kind"];
  if (account?.type === "credit") kind = "card";
  else if (account?.type === "loan") kind = "loan";
  else if (account) kind = "unknown";
  else if (cardTemplates.length && !loanTemplates.length) kind = "card";
  else if (loanTemplates.length && !cardTemplates.length) kind = "loan";
  else {
    const c =
      filled(card, ["newBalanceCents", "minimumPaymentCents", "closingDate", "creditLimitCents"]) +
      (card.transactions.length ? 1 : 0) +
      (/credit (?:limit|line)|purchases?\b/i.test(text) ? 1 : 0);
    const l =
      filled(loan, ["balanceCents", "statementDate", "paymentCents", "lastPayment"]) +
      (/\b(?:principal|escrow|mortgage|loan)\b/i.test(text) ? 1 : 0);
    kind = Math.max(c, l) < 2 ? "unknown" : c >= l ? "card" : "loan";
  }
  return {
    ...base,
    kind,
    date:
      (kind === "card" ? card.closingDate : kind === "loan" ? loan.statementDate : null) ??
      guessDate(lines),
    card,
    loan,
    groups: [],
    templates: kind === "card" ? cardTemplates : kind === "loan" ? loanTemplates : [],
  };
}

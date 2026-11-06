/** Credit cards (Credit cards page). Money is integer cents; rates are hundredths of a percent. */

export interface CardPayment {
  transactionId: string;
  date: string;
  amountCents: number;
  /** The account it was paid from, when Muny paired it. */
  fromAccountName: string | null;
}

export interface CreditCard {
  accountId: string;
  name: string;
  institutionName: string | null;
  mask: string | null;
  issuer: string | null;
  /** Synced through a bank connection. */
  connected: boolean;
  /** The connection, when its card details could be added through it (Plaid). */
  connectionId: string | null;
  /** What you owe now (positive). */
  balanceCents: number;
  creditLimitCents: number | null;
  availableCents: number | null;
  /** Balance as a share of the limit. */
  utilizationPct: number | null;
  aprBps: number | null;
  statementBalanceCents: number | null;
  statementDate: string | null;
  minimumPaymentCents: number | null;
  dueDate: string | null;
  lastPayment: { date: string; amountCents: number } | null;
  /** Spent on it since the last statement closed. */
  spentSinceStatementCents: number;
  /** Interest charged this year (transactions that look like interest charges). */
  interestThisYearCents: number;
  /** Payments to it, newest first (a year). */
  payments: CardPayment[];
  source: "plaid" | "statement" | "manual" | null;
  /** Words your payments to it use in your other accounts. */
  paymentMatch: string | null;
  /** Only payments of about this much (null: any, e.g. paying the statement balance). */
  paymentAmountCents: number | null;
  /** Paid around this day of the month. */
  paymentDay: number | null;
  /** Only payments from this account. */
  paymentFromAccountId: string | null;
  /** From the statement's minimum payment warning (null when not read). */
  minimumOnly: { months: number; totalCents: number } | null;
  /** What you owed, the last recorded each month (two years), oldest first; the last is today's. */
  history: { date: string; balanceCents: number }[];
}

export interface CardsReport {
  totalOwedCents: number;
  totalLimitCents: number;
  /** Total owed as a share of the total limit (cards with a limit). */
  utilizationPct: number | null;
  nextDue: { accountId: string; name: string; date: string; amountCents: number | null } | null;
  interestThisYearCents: number;
  cards: CreditCard[];
}

export interface CardDetailsInput {
  issuer?: string | null;
  creditLimitCents?: number | null;
  aprBps?: number | null;
  statementBalanceCents?: number | null;
  statementDate?: string | null;
  minimumPaymentCents?: number | null;
  dueDate?: string | null;
  paymentMatch?: string | null;
  paymentAmountCents?: number | null;
  paymentDay?: number | null;
  paymentFromAccountId?: string | null;
}

/** What Muny read from a card statement PDF. */
export interface CardStatement {
  closingDate: string | null;
  dueDate: string | null;
  newBalanceCents: number | null;
  minimumPaymentCents: number | null;
  creditLimitCents: number | null;
  aprBps: number | null;
  previousBalanceCents: number | null;
  paymentsCents: number | null;
  /** Interest charged so far in the statement's year. */
  interestYtd: { year: number; cents: number } | null;
  /** The statement's minimum payment warning: how long and how much in total at the minimum. */
  minimumOnly: { months: number; totalCents: number } | null;
  /** Transactions listed on it (charges negative, payments and credits positive). */
  transactions: { date: string; description: string; amountCents: number }[];
}

export interface CardStatementPreview {
  statement: CardStatement;
  /** The card whose last 4 digits appear on it, if any. */
  accountId: string | null;
  /** The statement's text, line by line (for teaching Muny its layout). */
  lines: string[];
  /** Templates you taught that were used on it. */
  templates: string[];
}

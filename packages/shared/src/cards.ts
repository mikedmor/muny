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
}

export interface CardStatementPreview {
  statement: CardStatement;
  /** The card whose last 4 digits appear on it, if any. */
  accountId: string | null;
}

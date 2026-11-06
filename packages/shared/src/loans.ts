/** Loans (D-040). Money is integer cents; rates are hundredths of a percent (649 = 6.49%). */

export const LOAN_KINDS = [
  "student",
  "mortgage",
  "auto",
  "personal",
  "credit_line",
  "other",
] as const;
export type LoanKind = (typeof LOAN_KINDS)[number];

export const LOAN_KIND_LABELS: Record<LoanKind, string> = {
  student: "Student loan",
  mortgage: "Mortgage",
  auto: "Auto loan",
  personal: "Personal loan",
  credit_line: "Line of credit",
  other: "Loan",
};

export interface LoanPaymentRow {
  transactionId: string;
  date: string;
  /** What you paid (positive). */
  amountCents: number;
  /** Worked out for loans whose balance Muny tracks; null otherwise. */
  interestCents: number | null;
  principalCents: number | null;
  description: string;
}

export interface Loan {
  accountId: string;
  name: string;
  institutionName: string | null;
  mask: string | null;
  kind: LoanKind;
  lender: string | null;
  /** plaid: the lender reports the balance (and maybe the terms); manual: Muny works it out from your payments. */
  source: "plaid" | "manual";
  /** Synced through a bank connection. */
  connected: boolean;
  /** What you owe now (positive). */
  balanceCents: number;
  aprBps: number | null;
  /** The payment you entered or the lender reports, else your usual payment. */
  monthlyPaymentCents: number | null;
  nextDueDate: string | null;
  originalPrincipalCents: number | null;
  originationDate: string | null;
  termMonths: number | null;
  paymentMatch: string | null;
  startBalanceCents: number | null;
  startDate: string | null;
  /** Share of the original amount paid off, 0–100 (when the original is known). */
  paidOffPct: number | null;
  interestThisYearCents: number | null;
  lastPayment: { date: string; amountCents: number } | null;
  /** Newest first, up to two years. */
  payments: LoanPaymentRow[];
  /** At the monthly payment and rate; null when unknown or never. */
  payoffMonths: number | null;
  payoffDate: string | null;
  interestRemainingCents: number | null;
}

export interface LoansReport {
  totalOwedCents: number;
  monthlyPaymentsCents: number;
  nextDue: { accountId: string; name: string; date: string; amountCents: number | null } | null;
  loans: Loan[];
}

export interface LoanDetailsInput {
  kind?: LoanKind;
  lender?: string | null;
  aprBps?: number | null;
  monthlyPaymentCents?: number | null;
  nextDueDate?: string | null;
  originalPrincipalCents?: number | null;
  originationDate?: string | null;
  termMonths?: number | null;
  paymentMatch?: string | null;
  /** Manual loans: what you owed on startDate. */
  startBalanceCents?: number | null;
  startDate?: string | null;
}

export interface CreateLoanInput extends LoanDetailsInput {
  name: string;
  /** What you owe on startDate (defaults to today). */
  startBalanceCents: number;
}

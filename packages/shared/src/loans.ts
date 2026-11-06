/** Loans (D-040, D-042). Money is integer cents; rates are hundredths of a percent (649 = 6.49%). */

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
  /** The part of the payment that went to this loan (positive). */
  amountCents: number;
  /** The whole payment, when it's shared with other loans. */
  totalCents: number | null;
  /** Escrow (taxes and insurance) in a mortgage payment. */
  escrowCents: number | null;
  interestCents: number | null;
  principalCents: number | null;
  description: string;
  /** The account the payment came out of. */
  fromAccountName: string;
}

export interface Loan {
  accountId: string;
  name: string;
  institutionName: string | null;
  mask: string | null;
  kind: LoanKind;
  lender: string | null;
  /** plaid: the lender reports the balance; manual: Muny works it out from your payments. */
  source: "plaid" | "manual";
  /** Synced through a bank connection (the balance comes from the lender). */
  connected: boolean;
  /** The connection, when the lender's loan details could be added through it. */
  connectionId: string | null;
  /** What you owe now (positive). */
  balanceCents: number;
  aprBps: number | null;
  /** What you usually pay (entered, else your recent payments). */
  monthlyPaymentCents: number | null;
  /** The lowest payment due (from the lender, or entered). */
  minimumPaymentCents: number | null;
  /** Mortgages: principal and interest of the payment (from the original amount, rate and term). */
  principalInterestCents: number | null;
  /** Mortgages: the rest of the payment (taxes, insurance, PMI). */
  escrowCents: number | null;
  nextDueDate: string | null;
  originalPrincipalCents: number | null;
  originationDate: string | null;
  termMonths: number | null;
  paymentMatch: string | null;
  paymentAmountCents: number | null;
  startBalanceCents: number | null;
  startDate: string | null;
  originalValueCents: number | null;
  pmiMonthlyCents: number | null;
  propertyAccountId: string | null;
  /** Other loans sharing the same payments (each gets its share). */
  sharedWith: string[];
  /** Interest/principal in the payments are estimates worked back from today's balance. */
  splitEstimated: boolean;
  paidOffPct: number | null;
  interestThisYearCents: number | null;
  lastPayment: { date: string; amountCents: number } | null;
  /** Newest first, up to two years. */
  payments: LoanPaymentRow[];
  payoffMonths: number | null;
  payoffDate: string | null;
  interestRemainingCents: number | null;
  /** Mortgage insurance: equity on the original value and when it can end. */
  pmi: {
    monthlyCents: number | null;
    equityPct: number;
    /** When equity reaches 20% (you can ask to cancel). */
    requestDate: string | null;
    /** When it reaches 22% (it ends by law). */
    autoEndDate: string | null;
  } | null;
  /** The home (or other asset) this loan pays for. */
  property: {
    accountId: string;
    name: string;
    valueCents: number;
    equityCents: number;
    loanToValuePct: number | null;
  } | null;
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
  minimumPaymentCents?: number | null;
  nextDueDate?: string | null;
  originalPrincipalCents?: number | null;
  originationDate?: string | null;
  termMonths?: number | null;
  paymentMatch?: string | null;
  paymentAmountCents?: number | null;
  /** Manual loans: what you owed on startDate. */
  startBalanceCents?: number | null;
  startDate?: string | null;
  originalValueCents?: number | null;
  pmiMonthlyCents?: number | null;
  propertyAccountId?: string | null;
}

export interface CreateLoanInput extends LoanDetailsInput {
  name: string;
  /** What you owe on startDate (defaults to today). */
  startBalanceCents: number;
}

// ---------------------------------------------------------------------------
// Assets (Assets page): a home, a car; their value over time.
// ---------------------------------------------------------------------------

export const ASSET_KINDS = ["home", "vehicle", "other"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export const ASSET_KIND_LABELS: Record<AssetKind, string> = {
  home: "Home",
  vehicle: "Vehicle",
  other: "Other",
};

export interface Asset {
  accountId: string;
  name: string;
  kind: AssetKind;
  valueCents: number;
  purchasePriceCents: number | null;
  purchaseDate: string | null;
  address: string | null;
  /** Value over time (your updates), oldest first. */
  history: { date: string; valueCents: number }[];
  /** Loans that pay for it, and what you own after them. */
  loans: { accountId: string; name: string; balanceCents: number }[];
  /** What you entered as owed when no loan is linked (0 = paid off; null = not set). */
  owedCents: number | null;
  equityCents: number;
}

export interface AssetInput {
  name?: string;
  kind?: AssetKind;
  valueCents?: number;
  purchasePriceCents?: number | null;
  purchaseDate?: string | null;
  address?: string | null;
  /** Owed on it when no loan is linked (0 = paid off; null clears). */
  owedCents?: number | null;
}

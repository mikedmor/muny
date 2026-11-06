import type { CryptoUsage } from "./crypto.js";

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

export interface LoanFee {
  transactionId: string;
  date: string;
  amountCents: number;
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
  /** Earlier payment amounts still matched (the payment changed). */
  pastPaymentAmounts: number[];
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
  /** What you owed after each payment (two years), oldest first; the last is today's balance. */
  history: { date: string; balanceCents: number }[];
  /** The newest statement imported for it (YYYY-MM-DD), if any. */
  statementDate: string | null;
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

/** A lender's yearly fee (dues, maintenance): one per lender, not per loan. */
export interface LenderFee {
  /** The lender's name, trimmed and lowercased (how loans are grouped). */
  lenderKey: string;
  lender: string;
  /** Words in the fee payments (null: the lender's loans' words). */
  paymentMatch: string | null;
  /** Payments of at least this much are the fee. */
  minCents: number;
  /** As entered (null when not known). */
  nextDueDate: string | null;
  /** The next one expected: the entered date (rolled to this year or next), else a year after the last. */
  expectedDate: string | null;
  /** Fee payments found, newest first (two years). */
  fees: LoanFee[];
}

/** A payment covering several of a lender's loans, split by each loan's part. */
export interface LenderPayment {
  id: string;
  lenderKey: string;
  /** Words in the payment (null: the lender's loans' words). */
  paymentMatch: string | null;
  /** Day of the month it's usually paid (null: any day). */
  dueDay: number | null;
  /** Only payments from / until these dates (YYYY-MM-DD; null: open), when the split changed. */
  startDate: string | null;
  endDate: string | null;
  /** Each loan's part (loan account id → cents); the payment is about their total. */
  parts: Record<string, number>;
  totalCents: number;
  /** Payments found for it (two years), and the latest. */
  foundCount: number;
  lastDate: string | null;
}

export interface LenderPaymentInput {
  paymentMatch?: string | null;
  dueDay?: number | null;
  startDate?: string | null;
  endDate?: string | null;
  parts: Record<string, number>;
}

/** Several loans from one lender at once, with the payments that cover them. */
export interface CreateLenderLoansInput {
  lender: string;
  kind?: LoanKind;
  /** Words in the payments (shared by the loans). */
  paymentMatch?: string | null;
  /** The date the balances are from. */
  startDate?: string | null;
  loans: {
    name: string;
    startBalanceCents: number;
    aprBps?: number | null;
    nextDueDate?: string | null;
  }[];
  /** Payments covering them: parts by the loan's index in `loans`. */
  payments: {
    paymentMatch?: string | null;
    dueDay?: number | null;
    parts: Record<string, number>;
  }[];
}

export interface LenderFeeInput {
  lender: string;
  paymentMatch?: string | null;
  minCents: number;
  nextDueDate?: string | null;
}

export interface LoansReport {
  totalOwedCents: number;
  monthlyPaymentsCents: number;
  nextDue: { accountId: string; name: string; date: string; amountCents: number | null } | null;
  loans: Loan[];
  lenderFees: LenderFee[];
  lenderPayments: LenderPayment[];
  /** Lenders whose payments are split like a federal servicer does, from their statements. */
  servicerLenders: string[];
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
  pastPaymentAmounts?: number[] | null;
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
  vehicle: {
    year: number | null;
    make: string | null;
    model: string | null;
    mileage: number | null;
    vin: string | null;
  };
  /** Where the value came from, and when it was last looked up. */
  valueSource: "manual" | "apillow" | "carapi" | null;
  valueCheckedAt: number | null;
  /** Details from the last lookup (homes: beds, baths, square feet, last sale, taxes). */
  details: AssetDetails | null;
}

export interface AssetDetails {
  bedrooms?: number | null;
  bathrooms?: number | null;
  livingArea?: number | null;
  lotSize?: number | null;
  yearBuilt?: number | null;
  propertyType?: string | null;
  rentZestimateCents?: number | null;
  lastSoldPriceCents?: number | null;
  lastSoldDate?: string | null;
  annualTaxCents?: number | null;
  taxRatePct?: number | null;
  zillowUrl?: string | null;
  /** Why there's no estimate (e.g. the home is listed for sale). */
  note?: string | null;
}

/** Automatic values (opt-in): whether each service's key is set. */
export interface AssetValuationSettings {
  apillow: boolean;
  carapi: boolean;
  /** Requests so far against Muny's caps (which sit under each service's free plan). */
  usage: CryptoUsage[];
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
  vehicleYear?: number | null;
  vehicleMake?: string | null;
  vehicleModel?: string | null;
  mileage?: number | null;
  vin?: string | null;
}

// ---------------------------------------------------------------------------
// Loan statements (PDF import): each group's exact figures from the servicer.
// ---------------------------------------------------------------------------

export interface LoanStatementGroup {
  /** The servicer's group code, e.g. "AC". */
  name: string;
  aprBps: number | null;
  originalPrincipalCents: number | null;
  firstDisbursed: string | null;
  /** Principal owed (as of the statement). */
  principalCents: number | null;
  /** Interest built up but not yet paid, on the statement date. */
  accruedInterestCents: number | null;
  monthlyPaymentCents: number | null;
  paymentsLeft: number | null;
  /** Applied to it since the last statement. */
  paidCents: number | null;
  paidInterestCents: number | null;
  paidPrincipalCents: number | null;
  amountDueCents: number | null;
  dueDate: string | null;
}

export interface LoanStatement {
  statementDate: string;
  lastPayment: { date: string; amountCents: number } | null;
  groups: LoanStatementGroup[];
}

/** A statement read, with the loan each group most likely is ("new" = add it). */
export interface LoanStatementPreview {
  statement: LoanStatement;
  matches: Record<string, string>;
}

/** A document kept in Muny (Insights → Documents). */
export interface DocumentInfo {
  id: string;
  kind: "loan_statement" | "other";
  name: string;
  mime: string;
  sizeBytes: number;
  lender: string | null;
  /** Loan statements: the statement date. */
  documentDate: string | null;
  notes: string | null;
  createdAt: number;
}

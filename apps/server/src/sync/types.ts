import type { AccountType } from "@muny/shared";

/**
 * Bank sync provider interface. Providers translate their API into these
 * shapes using Muny's conventions:
 *  - amounts are integer cents, negative = money out of the account;
 *  - balances are signed the same way, so a credit card you owe $50 on is -5000.
 */

export interface ProviderAccount {
  /** Provider's stable account id. */
  ref: string;
  name: string;
  type: AccountType;
  /** Last 4 digits only. */
  mask: string | null;
  currency: string;
  /** Current (ledger) balance, Muny sign convention; null if unknown. */
  balanceCents: number | null;
  /** Credit cards: the credit limit, when the provider reports it. */
  creditLimitCents?: number | null;
}

/** A credit card's statement and terms from the provider (Plaid liabilities). */
export interface CardTerms {
  accountRef: string;
  aprBps: number | null;
  minimumPaymentCents: number | null;
  dueDate: string | null;
  statementBalanceCents: number | null;
  statementDate: string | null;
  lastPaymentCents: number | null;
  lastPaymentDate: string | null;
  /** The credit limit (from the account balances). */
  creditLimitCents?: number | null;
}

export interface ProviderTransaction {
  ref: string;
  accountRef: string;
  postedDate: string;
  authorizedDate: string | null;
  amountCents: number;
  currency: string;
  description: string;
  /** Provider's cleaned merchant name, if any. */
  merchantName: string | null;
  pending: boolean;
  /** For a posted transaction: the ref of the pending one it replaces. */
  pendingRef: string | null;
  /** Muny default category name suggested by the provider's categorization. */
  categoryHint: string | null;
}

export interface SyncResult {
  added: ProviderTransaction[];
  modified: ProviderTransaction[];
  removed: string[];
  /** New cursor to store (cursor-based providers). */
  cursor: string | null;
  /**
   * Window-based providers (no cursor) return every transaction since this
   * date; pending transactions inside the window that weren't returned are
   * treated as removed.
   */
  windowFrom?: string;
}

export interface ConnectionInfo {
  institutionName: string | null;
  /** Provider-side id of the login (Plaid item_id, Teller enrollment id). */
  providerRef: string | null;
  accounts: ProviderAccount[];
}

/** A loan's terms as the lender reports them (D-040). */
export interface LoanTerms {
  accountRef: string;
  kind: "student" | "mortgage";
  aprBps: number | null;
  monthlyPaymentCents: number | null;
  nextDueDate: string | null;
  originalPrincipalCents: number | null;
  originationDate: string | null;
  termMonths: number | null;
  lender: string | null;
}

/** Holdings and investment history from a brokerage login (D-034). */
export interface InvestmentSync {
  holdings: {
    accountRef: string;
    symbol: string;
    name: string;
    type: "equity" | "etf" | "mutual_fund" | "bond" | "option" | "cash" | "other";
    quantity: string;
    price: string | null;
    valueCents: number;
    costBasisCents: number | null;
  }[];
  txns: {
    ref: string;
    accountRef: string;
    date: string;
    type:
      | "buy"
      | "sell"
      | "dividend"
      | "interest"
      | "split"
      | "transfer_in"
      | "transfer_out"
      | "deposit"
      | "withdrawal"
      | "fee"
      | "tax"
      | "other";
    symbol: string | null;
    name: string | null;
    quantity: string | null;
    price: string | null;
    /** Cash effect, Muny sign: negative for a buy. */
    amountCents: number;
    feesCents: number;
    description: string;
  }[];
}

export interface Provider<Creds> {
  readonly id: "plaid" | "teller" | "paypal" | "simplefin";
  getAccounts(creds: Creds): Promise<ConnectionInfo>;
  syncTransactions(creds: Creds, cursor: string | null): Promise<SyncResult>;
  /**
   * Holdings and investment history, for logins linked for investments; null
   * otherwise. `since`: only history from this date (null: as far back as offered).
   */
  syncInvestments?(creds: Creds, since: string | null): Promise<InvestmentSync | null>;
  /** Loan terms (rate, payment, due date) for the login's loans; null when not available. */
  liabilities?(creds: Creds): Promise<LoanTerms[] | null>;
  /** Credit card statements and rates (when the login shares them). */
  cardLiabilities?(creds: Creds): Promise<CardTerms[] | null>;
  /** Revoke access at the provider (best effort). */
  remove(creds: Creds): Promise<void>;
}

export type ProviderErrorCode =
  | "reauth_required"
  | "rate_limited"
  | "not_ready"
  | "config"
  | "provider_error";

/** Errors safe to show the user and store in connections.last_error. Never contain secrets. */
export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
  ) {
    super(message);
  }
}

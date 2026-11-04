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

export interface Provider<Creds> {
  readonly id: "plaid" | "teller";
  getAccounts(creds: Creds): Promise<ConnectionInfo>;
  syncTransactions(creds: Creds, cursor: string | null): Promise<SyncResult>;
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

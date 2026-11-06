import type { Account, AccountType } from "./ledger.js";

export type SyncProvider = "plaid" | "teller" | "paypal" | "simplefin";

export type ConnectionStatus =
  | "pending_setup"
  | "active"
  | "error"
  | "reauth_required"
  | "disabled";

export interface SyncConfigStatus {
  /** MUNY_SECRET_KEY is set (required to store bank credentials). */
  secretKey: boolean;
  intervalHours: number;
  plaid:
    | { configured: false }
    | {
        configured: true;
        env: "sandbox" | "production";
        oauth: boolean;
        /**
         * Plaid logins Muny has created (removed ones still count on Plaid's
         * Trial plan), and the plan's limit: 20 on the Trial plan, or what you
         * set for a paid plan (custom).
         */
        logins: { used: number; limit: number; custom: boolean };
      };
  teller:
    | { configured: false }
    | {
        configured: true;
        env: "sandbox" | "development" | "production";
        /** Public application id, needed by Teller Connect in the browser. */
        applicationId: string;
        certificate: boolean;
      };
}

export interface ConnectionSummary {
  id: string;
  provider: SyncProvider;
  institutionName: string | null;
  status: ConnectionStatus;
  lastSyncAt: number | null;
  lastError: string | null;
  ignoredAccounts: number;
  /** Teller enrollment id, needed to reconnect through Teller Connect. */
  tellerEnrollmentId: string | null;
  accounts: Account[];
}

/** An account at the bank, offered for linking to a Muny account. */
export interface LinkableAccount {
  ref: string;
  name: string;
  mask: string | null;
  type: AccountType;
  balanceCents: number | null;
  /** Existing Muny account that looks like the same account. */
  match: { id: string; name: string } | null;
}

export interface LinkStart {
  connectionId: string;
  institutionName: string | null;
  accounts: LinkableAccount[];
}

export interface SyncSummary {
  added: number;
  updated: number;
  adopted: number;
  removed: number;
  accountsCreated: number;
  rulesApplied: number;
}

export interface LinkResult {
  ok: true;
  summary: SyncSummary | null;
  syncError?: string;
}

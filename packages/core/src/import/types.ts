import type { AccountType } from "@muny/shared";

/** An account described by an import file. */
export interface ParsedAccount {
  /** Stable key within the file, used to link transactions to accounts. */
  key: string;
  name: string;
  institutionName: string | null;
  /** Last digits only. */
  mask: string | null;
  type: AccountType;
}

/** A transaction normalized from any import format. */
export interface ParsedTransaction {
  accountKey: string;
  /** Source line/record number, for error reporting. */
  line: number;
  postedDate: string;
  authorizedDate: string | null;
  /** Signed cents: negative = money out of the account. */
  amountCents: number;
  rawDescription: string;
  /** User-chosen merchant name, if the source had one. */
  payeeName: string | null;
  categoryName: string | null;
  notes: string | null;
  tags: string[];
  hidden: boolean;
  /** Bank-provided unique id (OFX FITID) when available. */
  providerTxnRef: string | null;
}

export interface ParseIssue {
  line: number;
  message: string;
}

export interface ParseResult {
  format: string;
  accounts: ParsedAccount[];
  transactions: ParsedTransaction[];
  errors: ParseIssue[];
}

/** Normalize a description for dedupe hashing. */
export function normalizeDescription(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

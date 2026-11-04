import type { AccountType } from "./ledger.js";

export type ImportFormat = "rocket_money" | "csv" | "ofx";

export interface ImportRequest {
  filename: string;
  /** File contents as text. */
  content: string;
  /** Defaults to auto-detection. */
  format?: ImportFormat;
}

export interface ImportPreviewAccount {
  key: string;
  name: string;
  institutionName: string | null;
  mask: string | null;
  type: AccountType;
  transactionCount: number;
  firstDate: string | null;
  lastDate: string | null;
  /** Existing Muny account this matches, if any. */
  match: { id: string; name: string } | null;
}

export interface ImportPreview {
  format: ImportFormat;
  accounts: ImportPreviewAccount[];
  transactionCount: number;
  /** Rows already in Muny (by dedupe hash) for matched accounts. */
  duplicateCount: number;
  firstDate: string | null;
  lastDate: string | null;
  /** Category names in the file that don't exist yet and will be created. */
  newCategories: string[];
  errors: { line: number; message: string }[];
  errorCount: number;
}

/** Per file-account target: an existing account id, "new" to create, or "skip". */
export type AccountTarget = string | "new" | "skip";

export interface ImportCommitRequest extends ImportRequest {
  accountMap: Record<string, AccountTarget>;
}

export interface ImportResult {
  batchId: string;
  imported: number;
  duplicates: number;
  skipped: number;
  failed: number;
  accountsCreated: number;
  categoriesCreated: number;
}

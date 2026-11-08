import type { AccountType } from "./ledger.js";

export type ImportFormat = "rocket_money" | "csv" | "ofx";

export const DATE_FORMATS = ["YYYY-MM-DD", "MM/DD/YYYY", "DD/MM/YYYY", "YYYYMMDD"] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

/** A row filter: keep rows whose column value is (or isn't) one of `values` (case-insensitive). */
export interface CsvFilter {
  column: string;
  op: "in" | "notIn";
  values: string[];
}

/**
 * How to read a single-account bank CSV. Either `amount` (signed) or
 * `debit`/`credit` (two unsigned columns) must be set.
 */
export interface CsvMapping {
  date: string;
  dateFormat: DateFormat;
  description: string;
  /** Used when `description` is empty on a row. */
  descriptionFallback?: string;
  amount?: string;
  /** Flip the sign of `amount` (for banks that export spending as positive). */
  negate?: boolean;
  debit?: string;
  credit?: string;
  /** Optional: transaction/authorized date when `date` is the posting date. */
  authorizedDate?: string;
  category?: string;
  notes?: string;
  filters?: CsvFilter[];
}

export interface CsvPresetInfo {
  id: string;
  label: string;
  institutionName: string | null;
  accountType: AccountType;
}

export interface ImportRequest {
  filename: string;
  /** File contents as text. */
  content: string;
  /** Defaults to auto-detection. */
  format?: ImportFormat;
  /** Column mapping for bank CSVs; defaults to the detected preset or a best guess. */
  csv?: CsvMapping;
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
  /** Balance reported by the file (OFX ledger balance), if any. */
  statementBalance: { cents: number; asOf: string } | null;
}

/** Extra preview info for bank CSVs so the UI can show/edit the column mapping. */
export interface CsvPreviewInfo {
  headers: string[];
  /** First few data rows, for the mapping screen. */
  sample: string[][];
  preset: CsvPresetInfo | null;
  /** The mapping used, or null if columns couldn't be guessed. */
  mapping: CsvMapping | null;
}

export interface ImportPreview {
  format: ImportFormat;
  accounts: ImportPreviewAccount[];
  transactionCount: number;
  /** Rows already in Muny for matched accounts (same file re-imported, or same date + amount). */
  duplicateCount: number;
  firstDate: string | null;
  lastDate: string | null;
  /** Category names in the file that don't exist yet and will be created. */
  newCategories: string[];
  errors: { line: number; message: string }[];
  errorCount: number;
  csv: CsvPreviewInfo | null;
}

/** Per file-account target: an existing account id, "new" to create, or "skip". */
export type AccountTarget = string | "new" | "skip";

export interface ImportCommitRequest extends ImportRequest {
  accountMap: Record<string, AccountTarget>;
  /** File account keys whose statement balance should be applied. */
  applyBalances?: string[];
}

export interface ImportResult {
  batchId: string;
  imported: number;
  duplicates: number;
  skipped: number;
  failed: number;
  accountsCreated: number;
  categoriesCreated: number;
  balancesUpdated: number;
  /** Imported transactions changed by your rules. */
  rulesApplied: number;
}

/** What a file dropped on the Import page is, and so which importer reads it. */
export interface ImportFileKind {
  kind: "transactions" | "brokerage" | "crypto";
  /** e.g. "Rocket Money export", "Fidelity export". */
  label: string;
}

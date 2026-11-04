/**
 * Transaction rules: "when a transaction matches these conditions, do these
 * actions". Rules run on newly imported transactions automatically and can
 * be applied to existing ones on demand (with a dry-run preview first).
 */

export const TEXT_OPS = ["contains", "equals", "startsWith", "endsWith"] as const;
export type TextOp = (typeof TEXT_OPS)[number];

export const TEXT_OP_LABELS: Record<TextOp, string> = {
  contains: "contains",
  equals: "is",
  startsWith: "starts with",
  endsWith: "ends with",
};

export const AMOUNT_OPS = ["eq", "gte", "lte"] as const;
export type AmountOp = (typeof AMOUNT_OPS)[number];

export const AMOUNT_OP_LABELS: Record<AmountOp, string> = {
  eq: "is",
  gte: "is at least",
  lte: "is at most",
};

export type RuleCondition =
  /** Bank's original description text (case-insensitive). */
  | { field: "description"; op: TextOp; value: string }
  /** Cleaned merchant name (case-insensitive). */
  | { field: "payee"; op: TextOp; value: string }
  /** Size of the amount, ignoring direction, in cents. */
  | { field: "amount"; op: AmountOp; value: number }
  /** Money out (spending) or in (income, refunds). */
  | { field: "direction"; value: "out" | "in" }
  | { field: "account"; value: string };

export type RuleAction =
  | { type: "setCategory"; categoryId: string }
  | { type: "setPayee"; name: string }
  | { type: "addTag"; name: string }
  | { type: "hide" };

export interface RuleDefinition {
  match: "all" | "any";
  conditions: RuleCondition[];
  actions: RuleAction[];
}

export interface Rule extends RuleDefinition {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
}

export interface RuleInput extends RuleDefinition {
  name: string;
  enabled?: boolean;
}

export interface RulePreviewRequest extends RuleDefinition {
  /** Also change transactions whose category/payee you set by hand. */
  includeEdited?: boolean;
}

export interface RulePreview {
  /** Transactions matching the conditions. */
  matched: number;
  /** Of those, how many the actions would actually change. */
  wouldChange: number;
  /** Matching transactions that are skipped because you edited them by hand. */
  skippedEdited: number;
  sample: {
    id: string;
    postedDate: string;
    description: string;
    amountCents: number;
    categoryName: string | null;
  }[];
}

export interface RuleApplyResult {
  changed: number;
}

export interface PayeeSummary {
  id: string;
  displayName: string;
  transactionCount: number;
}

export interface PayeeCleanupPreview {
  /** Transactions without a payee that would get one. */
  transactions: number;
  /** Distinct payee names that would be used. */
  payees: number;
  sample: { raw: string; cleaned: string; count: number }[];
}

export interface BackupInfo {
  name: string;
  sizeBytes: number;
  createdAt: number;
}

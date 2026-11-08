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
  | { type: "hide" }
  /** Count matching transactions as this recurring series, whatever the bank calls the merchant. */
  | { type: "setRecurring"; seriesId: string };

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

/** A rule, with how many transactions it matches. */
export interface RuleWithCount extends Rule {
  matchedCount: number;
}

export interface RuleInput extends RuleDefinition {
  name: string;
  enabled?: boolean;
}

export interface RulePreviewRequest extends RuleDefinition {
  /** Also change transactions whose category/payee you set by hand. */
  includeEdited?: boolean;
  /** How many matching transactions to list (default 10). */
  limit?: number;
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

/** An existing rule that covers the same transactions as one being made or edited. */
export interface RuleOverlap {
  rule: Rule;
  /** Same conditions (wording and case aside): it's the same rule. */
  identical: boolean;
  /** Transactions both rules match. */
  sharedCount: number;
  /** How many the new rule matches in all. */
  newCount: number;
  /** Where they disagree on the same transactions, e.g. "sets the category to Dining". */
  conflicts: string[];
}

/** Two of your rules that are the same, or that file the same transactions differently. */
export interface RuleConflict {
  /** Higher in the list (wins on category and merchant name when both are on). */
  firstId: string;
  secondId: string;
  /** Same conditions: one of them is a duplicate. */
  identical: boolean;
  /** Transactions both match. */
  sharedCount: number;
  /** What the second would do differently, e.g. "sets the category to Dining". */
  conflicts: string[];
  /** What the first would do differently (the same disagreement, seen from the second). */
  firstConflicts: string[];
}

/**
 * Two rules that can be one: `removeId` goes, and `keepId` (keeping its name
 * and place in the list) takes on the conditions of `conditionsFrom` and the
 * actions of both. Only offered when every transaction comes out as before.
 */
export interface RuleCombine {
  keepId: string;
  removeId: string;
  conditionsFrom: string;
  actions: RuleAction[];
  /** Transactions both rules match. */
  sharedCount: number;
}

/** Everything the Rules page needs to show how the rules are doing. */
export interface RuleReview {
  /** Transactions each rule matches, by rule id. */
  counts: Record<string, number>;
  /** Rules Muny made by itself (for a recurring series). */
  automaticIds: string[];
  /** Pairs that can be combined into one rule. */
  combine: RuleCombine[];
  /** Duplicates, and rules that file the same transactions differently. */
  conflicts: RuleConflict[];
}

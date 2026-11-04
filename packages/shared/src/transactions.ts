/** Transaction API DTOs. Amounts are signed integer cents (negative = money out). */

export interface TransactionSplit {
  id: string;
  categoryId: string | null;
  categoryName: string | null;
  amountCents: number;
  notes: string | null;
}

export interface Tag {
  id: string;
  name: string;
  color: string | null;
}

export interface Transaction {
  id: string;
  accountId: string;
  accountName: string;
  postedDate: string;
  amountCents: number;
  currency: string;
  /** Payee display name if set, else the bank's raw description. */
  description: string;
  rawDescription: string;
  payeeId: string | null;
  payeeName: string | null;
  categoryId: string | null;
  categoryName: string | null;
  categoryGroupName: string | null;
  notes: string | null;
  pending: boolean;
  hidden: boolean;
  /** Manually entered (editable date/amount) vs imported/synced. */
  manual: boolean;
  transferPairId: string | null;
  /** Account on the other side of a detected transfer. */
  transferAccountName: string | null;
  tags: Tag[];
  splits: TransactionSplit[];
}

export interface TransactionPage {
  items: Transaction[];
  total: number;
  /** Sum of amountCents across all matching rows (not just this page). */
  sumCents: number;
  offset: number;
  limit: number;
}

export interface TransactionQuery {
  q?: string;
  accountId?: string;
  /** Category id, or "uncategorized". */
  categoryId?: string;
  tagId?: string;
  from?: string;
  to?: string;
  /** "exclude" (default), "include" or "only". */
  hidden?: "exclude" | "include" | "only";
  offset?: number;
  limit?: number;
}

export interface CreateTransactionInput {
  accountId: string;
  postedDate: string;
  amountCents: number;
  description: string;
  categoryId?: string | null;
  notes?: string | null;
}

export interface UpdateTransactionInput {
  postedDate?: string;
  amountCents?: number;
  /** Set the payee by display name (created if new); null clears it. */
  payeeName?: string | null;
  categoryId?: string | null;
  notes?: string | null;
  hidden?: boolean;
  /** Replace tags by name (created if new). */
  tags?: string[];
}

export interface SplitInput {
  categoryId: string | null;
  amountCents: number;
  notes?: string | null;
}

export interface BulkUpdateInput {
  ids: string[];
  set: { categoryId?: string | null; hidden?: boolean; addTag?: string };
}

export interface TransferPreview {
  /** New transfer pairs detection would make. */
  pairs: number;
  sample: { date: string; amountCents: number; from: string; to: string; description: string }[];
}

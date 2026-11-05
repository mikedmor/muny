/** Transaction filters live in the URL so links (to-dos, budgets) can pre-filter. */
export interface TransactionSearch {
  q?: string;
  accountId?: string;
  categoryId?: string;
  tagId?: string;
  from?: string;
  to?: string;
  hidden?: "include" | "only";
}

const TXN_KEYS = ["q", "accountId", "categoryId", "tagId", "from", "to"] as const;

export function validateTransactionSearch(s: Record<string, unknown>): TransactionSearch {
  const out: TransactionSearch = {};
  for (const k of TXN_KEYS) {
    const v = s[k];
    if (typeof v === "string" && v.trim() && v.length <= 200) out[k] = v.trim();
  }
  if (s.hidden === "include" || s.hidden === "only") out.hidden = s.hidden;
  return out;
}

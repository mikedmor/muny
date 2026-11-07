import type { Transaction } from "@muny/shared";
import { Plus, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useCategories } from "../lib/queries.js";
import { CreateRuleDialog } from "./RuleDialogs.js";
import type { RuleDraft } from "./RuleEditor.js";

/**
 * After you change a transaction's category: "Changed category to X  + Rule",
 * which opens a new rule for transactions like it. Used wherever categories
 * are changed (Transactions, category pages).
 */

/** What a rule offer needs from a transaction (or a recurring charge). */
export type RuleSource = Pick<Transaction, "id" | "payeeName" | "description" | "rawDescription">;

/** A new rule for transactions like this one (name contains it; the category, when set). */
export function ruleDraftFor(txn: RuleSource, categoryId: string | null): RuleDraft {
  return {
    name: txn.payeeName ?? txn.description,
    match: "all",
    conditions: [
      txn.payeeName
        ? { field: "payee", op: "contains", value: txn.payeeName }
        : { field: "description", op: "contains", value: txn.rawDescription },
    ],
    actions: categoryId ? [{ type: "setCategory", categoryId }] : [],
  };
}

/** Bottom right after a category change: "Changed category to X  + Rule". */
function RuleOffer({
  categoryName,
  onRule,
  onDismiss,
}: {
  categoryName: string;
  onRule: () => void;
  onDismiss: () => void;
}) {
  useEffect(() => {
    const id = setTimeout(onDismiss, 9000);
    return () => clearTimeout(id);
  }, [onDismiss]);
  return (
    <div
      role="status"
      className="fixed right-4 bottom-4 z-50 flex items-center gap-3 rounded-xl bg-surface py-2.5 pr-2.5 pl-4 text-sm shadow-lg ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-700"
    >
      <span className="font-medium text-emerald-700 dark:text-emerald-400">
        Changed category to {categoryName}
      </span>
      <button
        type="button"
        onClick={onRule}
        className="inline-flex items-center gap-1 rounded-full border border-slate-900 px-3 py-1 text-xs font-medium hover:bg-slate-100 dark:border-slate-200 dark:hover:bg-slate-800"
      >
        <Plus aria-hidden="true" className="size-3.5" /> Rule
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="text-slate-400 hover:text-slate-700"
      >
        <X aria-hidden="true" className="size-4" />
      </button>
    </div>
  );
}

/**
 * The rule offer for a page: call `offerRule(txn, categoryId)` after a category
 * change; render `offerNode` (the toast) and `dialog` (the rule editor).
 */
export function useRuleOffer(): {
  offerRule: (txn: RuleSource, categoryId: string | null) => void;
  offerNode: ReactNode;
  dialog: ReactNode;
} {
  const categories = useCategories();
  const [offer, setOffer] = useState<{ txn: RuleSource; categoryId: string } | null>(null);
  const [draft, setDraft] = useState<RuleDraft | null>(null);
  const offerRule = useCallback((txn: RuleSource, categoryId: string | null) => {
    setOffer(categoryId ? { txn, categoryId } : null);
  }, []);
  const dismiss = useCallback(() => setOffer(null), []);
  const name = offer
    ? categories.data?.flatMap((g) => g.categories).find((c) => c.id === offer.categoryId)?.name
    : undefined;
  const offerNode =
    offer && name ? (
      <RuleOffer
        key={`${offer.txn.id}:${offer.categoryId}`}
        categoryName={name}
        onDismiss={dismiss}
        onRule={() => {
          setDraft(ruleDraftFor(offer.txn, offer.categoryId));
          setOffer(null);
        }}
      />
    ) : null;
  const dialog = <CreateRuleDialog open={!!draft} onClose={() => setDraft(null)} initial={draft} />;
  return { offerRule, offerNode, dialog };
}

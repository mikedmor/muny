import { type BudgetLine, type Category, formatMoney } from "@muny/shared";
import { type FormEvent, useState } from "react";
import {
  useCategories,
  useCategoryUsage,
  useDeleteBudget,
  useDeleteCategory,
  useSetBudget,
  useUpdateCategory,
} from "../lib/queries.js";
import { monthLabel } from "./budget.js";
import { CategorySelect } from "./CategorySelect.js";
import { Checkbox, Modal, MoneyField, SelectField } from "./forms.js";
import { Alert, Button } from "./ui.js";

/**
 * Everything about one category in one dialog: name, group, its budget
 * (amount and rollover), whether it's a bill, counted in budgets, hidden, and
 * deleting it (moving what uses it elsewhere).
 */
export function EditCategoryDialog({
  categoryId,
  line,
  month,
  open,
  onClose,
  onDeleted,
}: {
  categoryId: string;
  /** Its budget line this month (spending categories). */
  line: BudgetLine | undefined;
  month: string;
  open: boolean;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const categories = useCategories();
  const groups = categories.data ?? [];
  const category = groups.flatMap((g) => g.categories).find((c) => c.id === categoryId);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={category ? `Edit ${category.name}` : "Edit category"}
    >
      {open && category && (
        <EditCategoryForm
          key={`${category.id}:${line?.budgetId ?? ""}`}
          category={category}
          line={line}
          month={month}
          onClose={onClose}
          onDeleted={onDeleted}
        />
      )}
    </Modal>
  );
}

function EditCategoryForm({
  category,
  line,
  month,
  onClose,
  onDeleted,
}: {
  category: Category;
  line: BudgetLine | undefined;
  month: string;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const categories = useCategories();
  const groups = categories.data ?? [];
  const update = useUpdateCategory();
  const setBudget = useSetBudget();
  const delBudget = useDeleteBudget();
  const [deleting, setDeleting] = useState(false);

  const [name, setName] = useState(category.name);
  const [groupId, setGroupId] = useState(category.groupId);
  const [isBill, setIsBill] = useState(category.isBill);
  const [inBudget, setInBudget] = useState(!category.excludeFromBudget);
  const [hidden, setHidden] = useState(category.hidden);
  const [amount, setAmount] = useState<number | null>(line?.budgetCents ?? null);
  const [rollover, setRollover] = useState(line?.rollover ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const spending = groups.find((g) => g.id === groupId)?.kind === "expense";

  if (deleting)
    return (
      <DeleteCategoryForm
        category={category}
        onCancel={() => setDeleting(false)}
        onDone={onDeleted}
      />
    );

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError("Name is required");
    setBusy(true);
    setError(null);
    try {
      const patch: Parameters<typeof update.mutateAsync>[0] = { id: category.id };
      if (name.trim() !== category.name) patch.name = name.trim();
      if (groupId !== category.groupId) patch.groupId = groupId;
      if (isBill !== category.isBill) patch.isBill = isBill;
      if (inBudget === category.excludeFromBudget) patch.excludeFromBudget = !inBudget;
      if (hidden !== category.hidden) patch.hidden = hidden;
      if (Object.keys(patch).length > 1) await update.mutateAsync(patch);
      if (line && spending) {
        if (amount === null) {
          if (line.budgetId) await delBudget.mutateAsync(line.budgetId);
        } else if (amount !== line.budgetCents || rollover !== line.rollover)
          await setBudget.mutateAsync({
            categoryId: category.id,
            amountCents: amount,
            rollover,
            fromMonth: month,
          });
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="block text-sm font-medium text-slate-700 dark:text-slate-300">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
          />
        </label>
        <SelectField label="Group" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
              {g.kind === "income" ? " (income)" : g.kind === "transfer" ? " (transfers)" : ""}
            </option>
          ))}
        </SelectField>
      </div>

      {spending && line && (
        <fieldset className="space-y-3 rounded-lg bg-slate-50 p-3 dark:bg-slate-800/50">
          <legend className="sr-only">Budget</legend>
          <MoneyField
            label={`Monthly budget from ${monthLabel(month)}`}
            cents={amount}
            onChange={setAmount}
            hint={`${
              line.averageCents > 0
                ? `You spent ${formatMoney(line.averageCents)}/mo on average over the last 3 months. `
                : ""
            }Leave it empty for no budget.`}
          />
          <Checkbox
            label="Roll over"
            description="Carry what's left (or overspent) into next month."
            checked={rollover}
            onChange={setRollover}
          />
        </fieldset>
      )}

      <div className="space-y-3">
        {spending && (
          <>
            <Checkbox
              label="Bill or subscription"
              description="Count it in Bills & subscriptions instead of All other categories."
              checked={isBill}
              onChange={setIsBill}
            />
            <Checkbox
              label="Count in budgets"
              description="Off leaves its spending out of budgets, totals and the forecast (it still shows in Spending and Reports)."
              checked={inBudget}
              onChange={setInBudget}
            />
          </>
        )}
        <Checkbox
          label="Hide"
          description="Keep it on existing transactions, but don't offer it for new ones."
          checked={hidden}
          onChange={setHidden}
        />
      </div>

      {error && <Alert>{error}</Alert>}
      <div className="flex flex-wrap justify-between gap-2 border-t border-slate-200 pt-4 dark:border-slate-800">
        <Button
          type="button"
          variant="ghost"
          className="text-red-600"
          onClick={() => setDeleting(true)}
        >
          Delete category…
        </Button>
        <div className="flex gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </form>
  );
}

/** Delete a category, moving what uses it to another (or leaving it uncategorized). */
export function DeleteCategoryForm({
  category,
  onDone,
  onCancel = onDone,
}: {
  category: Category;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const del = useDeleteCategory();
  const usage = useCategoryUsage(category.id);
  const [reassignTo, setReassignTo] = useState<string | null>(null);
  const u = usage.data;
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const used = u
    ? [
        u.transactions && plural(u.transactions, "transaction"),
        u.splits && plural(u.splits, "split part"),
        u.recurring && plural(u.recurring, "recurring charge"),
        u.payees && plural(u.payees, "payee default"),
        u.rules && plural(u.rules, "rule"),
        u.budget && "a budget",
      ].filter(Boolean)
    : [];
  return (
    <div className="space-y-4">
      <p className="text-sm">
        Delete <strong>{category.name}</strong>?{" "}
        {usage.isLoading
          ? "Checking what uses it…"
          : used.length
            ? `It's used by ${used.join(", ")}.`
            : "Nothing uses it."}
      </p>
      {used.length > 0 && (
        <div className="space-y-1">
          <span className="block text-sm font-medium">Move them to</span>
          <CategorySelect
            value={reassignTo}
            onChange={setReassignTo}
            emptyLabel="Uncategorized"
            aria-label="Move them to"
            filter={(c) => c.id !== category.id}
          />
          <p className="text-xs text-slate-500">
            {reassignTo
              ? `Transactions, recurring charges, payee defaults and rules switch over${u?.budget ? "; the budget moves too unless that category already has one" : ""}.`
              : `They'll be left uncategorized${u?.rules ? `; rules stop setting a category${u.rulesOnlySetting ? ` (${plural(u.rulesOnlySetting, "rule")} that only did that will be deleted)` : ""}` : ""}${u?.budget ? "; its budget is removed" : ""}.`}
          </p>
        </div>
      )}
      {del.error && <Alert>{del.error.message}</Alert>}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="danger"
          disabled={del.isPending || usage.isLoading}
          onClick={() =>
            del.mutate(
              { id: category.id, reassignTo: reassignTo ?? undefined },
              { onSuccess: onDone },
            )
          }
        >
          {reassignTo ? "Move and delete" : "Delete"}
        </Button>
      </div>
    </div>
  );
}

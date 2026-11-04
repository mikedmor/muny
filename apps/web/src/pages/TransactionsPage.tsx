import {
  formatMoney,
  type Transaction,
  type TransactionQuery,
  toDecimalString,
} from "@muny/shared";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { CategorySelect } from "../components/CategorySelect.js";
import { Checkbox, Modal, MoneyField, SelectField } from "../components/forms.js";
import { type RuleDraft, RuleEditor } from "../components/RuleEditor.js";
import { Alert, Button, Card, cx, Field, PageHeader } from "../components/ui.js";
import { ApiError } from "../lib/api.js";
import {
  useAccounts,
  useBulkUpdate,
  useCreateTransaction,
  useDeleteTransaction,
  useSetSplits,
  useTags,
  useTransactions,
  useUpdateTransaction,
} from "../lib/queries.js";

const selectClass =
  "rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950";

function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const h = setTimeout(() => setV(value), ms);
    return () => clearTimeout(h);
  }, [value, ms]);
  return v;
}

function formatDay(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y ?? 0, (m ?? 1) - 1, d ?? 1).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function Amount({ cents, className }: { cents: number; className?: string }) {
  return (
    <span
      className={cx(
        "tabular-nums",
        cents > 0 && "text-emerald-600 dark:text-emerald-400",
        className,
      )}
    >
      {cents > 0 ? "+" : ""}
      {formatMoney(cents)}
    </span>
  );
}

const today = () => new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD

export function TransactionsPage() {
  const accounts = useAccounts();
  const tags = useTags();
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<Omit<TransactionQuery, "q" | "offset" | "limit">>({});
  const q = useDebounced(search.trim());
  const query = useMemo(() => ({ ...filters, q: q || undefined }), [filters, q]);
  const txns = useTransactions(query);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Transaction | "new" | null>(null);

  // Clear selection when the result set changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on query change only
  useEffect(() => setSelected(new Set()), [query]);

  const items = txns.data?.pages.flatMap((p) => p.items) ?? [];
  const first = txns.data?.pages[0];
  const byDay = useMemo(() => {
    const groups: { day: string; items: Transaction[] }[] = [];
    for (const t of items) {
      const last = groups[groups.length - 1];
      if (last?.day === t.postedDate) last.items.push(t);
      else groups.push({ day: t.postedDate, items: [t] });
    }
    return groups;
  }, [items]);

  const setFilter = <K extends keyof typeof filters>(k: K, v: (typeof filters)[K]) =>
    setFilters((f) => ({ ...f, [k]: v || undefined }));
  const activeFilters = Object.values(filters).some(Boolean) || q;

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <>
      <PageHeader
        title="Transactions"
        actions={
          <Button onClick={() => setOpen("new")} disabled={!accounts.data?.length}>
            Add transaction
          </Button>
        }
      />

      {/* Filters */}
      <div className="mb-4 flex flex-wrap gap-2">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search merchant, notes or amount"
          aria-label="Search transactions"
          className={cx(selectClass, "min-w-0 flex-1 basis-56")}
        />
        <select
          aria-label="Account"
          value={filters.accountId ?? ""}
          onChange={(e) => setFilter("accountId", e.target.value)}
          className={selectClass}
        >
          <option value="">All accounts</option>
          {accounts.data?.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <CategorySelect
          aria-label="Category"
          value={filters.categoryId ?? null}
          onChange={(v) => setFilter("categoryId", v ?? undefined)}
          emptyLabel="All categories"
          extraOptions={[{ value: "uncategorized", label: "Uncategorized" }]}
          className={selectClass}
        />
        {(tags.data?.length ?? 0) > 0 && (
          <select
            aria-label="Tag"
            value={filters.tagId ?? ""}
            onChange={(e) => setFilter("tagId", e.target.value)}
            className={selectClass}
          >
            <option value="">All tags</option>
            {tags.data?.map((t) => (
              <option key={t.id} value={t.id}>
                #{t.name}
              </option>
            ))}
          </select>
        )}
        <input
          type="date"
          aria-label="From date"
          value={filters.from ?? ""}
          onChange={(e) => setFilter("from", e.target.value)}
          className={selectClass}
        />
        <input
          type="date"
          aria-label="To date"
          value={filters.to ?? ""}
          onChange={(e) => setFilter("to", e.target.value)}
          className={selectClass}
        />
        <select
          aria-label="Hidden transactions"
          value={filters.hidden ?? "exclude"}
          onChange={(e) =>
            setFilter(
              "hidden",
              e.target.value === "exclude" ? undefined : (e.target.value as "include"),
            )
          }
          className={selectClass}
        >
          <option value="exclude">Without hidden</option>
          <option value="include">Including hidden</option>
          <option value="only">Hidden only</option>
        </select>
        {activeFilters && (
          <Button
            variant="ghost"
            onClick={() => {
              setFilters({});
              setSearch("");
            }}
          >
            Clear
          </Button>
        )}
      </div>

      {first && (
        <p className="mb-3 text-sm text-slate-500">
          {first.total.toLocaleString()} transaction{first.total === 1 ? "" : "s"} · net{" "}
          <Amount cents={first.sumCents} className="font-medium" />
        </p>
      )}

      {selected.size > 0 && <BulkBar ids={[...selected]} onDone={() => setSelected(new Set())} />}

      {txns.isError && <Alert>Couldn't load transactions.</Alert>}

      {txns.isSuccess && items.length === 0 && (
        <Card className="text-center text-sm text-slate-500">
          {activeFilters
            ? "No transactions match these filters."
            : "No transactions yet. Import a file or add one manually."}
        </Card>
      )}

      <div className={cx("space-y-4", txns.isPlaceholderData && "opacity-60")}>
        {byDay.map((group) => (
          <section key={group.day}>
            <h2 className="mb-1 px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
              {formatDay(group.day)}
            </h2>
            <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
              {group.items.map((t) => (
                <TransactionRow
                  key={t.id}
                  txn={t}
                  selected={selected.has(t.id)}
                  onToggle={() => toggle(t.id)}
                  onOpen={() => setOpen(t)}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>

      {txns.hasNextPage && (
        <div className="mt-6 text-center">
          <Button
            variant="secondary"
            onClick={() => txns.fetchNextPage()}
            disabled={txns.isFetchingNextPage}
          >
            {txns.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}

      <Modal
        open={open !== null}
        onClose={() => setOpen(null)}
        title={open === "new" ? "Add transaction" : "Transaction"}
      >
        {open === "new" && <NewTransactionForm onDone={() => setOpen(null)} />}
        {open && open !== "new" && (
          <TransactionDetail key={open.id} txn={open} onDone={() => setOpen(null)} />
        )}
      </Modal>
    </>
  );
}

function TransactionRow({
  txn,
  selected,
  onToggle,
  onOpen,
}: {
  txn: Transaction;
  selected: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const update = useUpdateTransaction();
  const isSplit = txn.splits.length > 0;
  return (
    <li
      className={cx(
        "flex items-center gap-3 px-3 py-2",
        selected && "bg-brand-50 dark:bg-brand-700/10",
      )}
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggle}
        aria-label={`Select ${txn.description}`}
        className="size-4 shrink-0 accent-brand-600"
      />
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
        <p
          className={cx(
            "truncate text-sm font-medium",
            txn.hidden && "text-slate-400 line-through",
          )}
        >
          {txn.description}
          {txn.pending && <span className="ml-2 text-xs font-normal text-amber-600">pending</span>}
        </p>
        <p className="truncate text-xs text-slate-500">
          {txn.accountName}
          {txn.notes && ` · ${txn.notes}`}
          {txn.tags.map((t) => ` #${t.name}`).join("")}
        </p>
      </button>
      <div className="hidden w-48 shrink-0 sm:block">
        {isSplit ? (
          <button type="button" onClick={onOpen} className="text-xs text-slate-500 underline">
            Split ({txn.splits.length})
          </button>
        ) : (
          <CategorySelect
            aria-label={`Category for ${txn.description}`}
            value={txn.categoryId}
            onChange={(categoryId) => update.mutate({ id: txn.id, categoryId })}
            className={cx(
              "w-full truncate rounded-md border border-transparent bg-transparent px-1 py-1 text-xs hover:border-slate-300 dark:hover:border-slate-700",
              !txn.categoryId && "text-amber-600",
            )}
          />
        )}
      </div>
      <button type="button" onClick={onOpen} className="shrink-0 text-right text-sm font-medium">
        <Amount cents={txn.amountCents} />
      </button>
    </li>
  );
}

function BulkBar({ ids, onDone }: { ids: string[]; onDone: () => void }) {
  const bulk = useBulkUpdate();
  const [tag, setTag] = useState("");
  return (
    <div className="sticky top-16 z-10 mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-brand-500/40 bg-brand-50 px-3 py-2 text-sm md:top-2 dark:bg-slate-900">
      <span className="font-medium">{ids.length} selected</span>
      <CategorySelect
        aria-label="Set category for selected"
        value={null}
        emptyLabel="Set category…"
        onChange={(categoryId) =>
          categoryId && bulk.mutate({ ids, set: { categoryId } }, { onSuccess: onDone })
        }
        className={selectClass}
      />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (tag.trim()) bulk.mutate({ ids, set: { addTag: tag.trim() } }, { onSuccess: onDone });
        }}
        className="flex gap-1"
      >
        <input
          value={tag}
          onChange={(e) => setTag(e.target.value)}
          placeholder="Add tag"
          aria-label="Add tag to selected"
          className={cx(selectClass, "w-28")}
        />
      </form>
      <Button
        variant="secondary"
        onClick={() => bulk.mutate({ ids, set: { hidden: true } }, { onSuccess: onDone })}
      >
        Hide
      </Button>
      <Button
        variant="secondary"
        onClick={() => bulk.mutate({ ids, set: { hidden: false } }, { onSuccess: onDone })}
      >
        Unhide
      </Button>
      <Button variant="ghost" onClick={onDone}>
        Cancel
      </Button>
      {bulk.error && <span className="text-red-600">{bulk.error.message}</span>}
    </div>
  );
}

function NewTransactionForm({ onDone }: { onDone: () => void }) {
  const accounts = useAccounts();
  const create = useCreateTransaction();
  const [accountId, setAccountId] = useState(accounts.data?.[0]?.id ?? "");
  const [postedDate, setDate] = useState(today());
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState<number | null>(null);
  const [isIncome, setIsIncome] = useState(false);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const fields = create.error instanceof ApiError ? create.error.fieldErrors() : {};

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (amount === null) return;
    const abs = Math.abs(amount);
    create.mutate(
      {
        accountId,
        postedDate,
        description,
        amountCents: isIncome ? abs : -abs,
        categoryId,
        notes: notes || null,
      },
      { onSuccess: onDone },
    );
  };

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      {create.error && !Object.keys(fields).length && <Alert>{create.error.message}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          label="Account"
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
        >
          {accounts.data?.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </SelectField>
        <Field
          label="Date"
          type="date"
          value={postedDate}
          onChange={(e) => setDate(e.target.value)}
          error={fields.postedDate}
        />
      </div>
      <Field
        label="Description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        error={fields.description}
        placeholder="e.g. Farmers market"
      />
      <div className="grid items-end gap-4 sm:grid-cols-2">
        <MoneyField
          label="Amount"
          cents={amount}
          onChange={(c) => setAmount(c)}
          error={fields.amountCents}
        />
        <div className="flex rounded-lg border border-slate-300 p-1 text-sm dark:border-slate-700">
          {(["Expense", "Income"] as const).map((label) => (
            <button
              key={label}
              type="button"
              onClick={() => setIsIncome(label === "Income")}
              className={cx(
                "flex-1 rounded-md py-1",
                (label === "Income") === isIncome && "bg-brand-600 text-white",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div>
        <span className="block text-sm font-medium text-slate-700 dark:text-slate-300">
          Category
        </span>
        <CategorySelect
          aria-label="Category"
          value={categoryId}
          onChange={setCategoryId}
          className={cx(selectClass, "mt-1 w-full")}
        />
      </div>
      <Field
        label="Notes"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Optional"
      />
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={create.isPending || amount === null || !accountId}>
          Add
        </Button>
      </div>
    </form>
  );
}

function TransactionDetail({ txn, onDone }: { txn: Transaction; onDone: () => void }) {
  const update = useUpdateTransaction();
  const remove = useDeleteTransaction();
  const [payeeName, setPayeeName] = useState(txn.payeeName ?? "");
  const [categoryId, setCategoryId] = useState(txn.categoryId);
  const [notes, setNotes] = useState(txn.notes ?? "");
  const [tags, setTags] = useState(txn.tags.map((t) => t.name).join(", "));
  const [hidden, setHidden] = useState(txn.hidden);
  const [postedDate, setDate] = useState(txn.postedDate);
  const [amount, setAmount] = useState<number | null>(txn.amountCents);
  const [splitting, setSplitting] = useState(txn.splits.length > 0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [ruleDraft, setRuleDraft] = useState<RuleDraft | null>(null);
  const fields = update.error instanceof ApiError ? update.error.fieldErrors() : {};

  const save = (e: FormEvent) => {
    e.preventDefault();
    update.mutate(
      {
        id: txn.id,
        payeeName: payeeName.trim() || null,
        ...(txn.splits.length === 0 && !splitting ? { categoryId } : {}),
        notes: notes.trim() || null,
        tags: tags
          .split(",")
          .map((t) => t.trim().replace(/^#/, ""))
          .filter(Boolean),
        hidden,
        ...(txn.manual ? { postedDate, amountCents: amount ?? txn.amountCents } : {}),
      },
      { onSuccess: onDone },
    );
  };

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4 rounded-lg bg-slate-50 p-3 dark:bg-slate-800/50">
        <div className="min-w-0">
          <p className="truncate font-medium">{txn.description}</p>
          <p className="truncate text-xs text-slate-500" title="Original bank description">
            {txn.rawDescription}
          </p>
          <p className="text-xs text-slate-500">
            {txn.accountName} · {formatDay(txn.postedDate)}
          </p>
        </div>
        <Amount cents={txn.amountCents} className="text-lg font-semibold" />
      </div>

      <form onSubmit={save} className="space-y-4" noValidate>
        {update.error && !Object.keys(fields).length && <Alert>{update.error.message}</Alert>}
        <Field
          label="Merchant name"
          value={payeeName}
          onChange={(e) => setPayeeName(e.target.value)}
          placeholder={txn.rawDescription}
          hint="Shown instead of the bank's description."
        />
        {txn.manual && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Date"
              type="date"
              value={postedDate}
              onChange={(e) => setDate(e.target.value)}
            />
            <MoneyField
              label="Amount (negative = spending)"
              cents={amount}
              onChange={(c) => setAmount(c)}
            />
          </div>
        )}
        {!splitting && (
          <div>
            <div className="flex items-baseline justify-between">
              <span className="block text-sm font-medium text-slate-700 dark:text-slate-300">
                Category
              </span>
              <button
                type="button"
                onClick={() => setSplitting(true)}
                className="text-xs text-brand-600 hover:underline"
              >
                Split transaction
              </button>
            </div>
            <CategorySelect
              aria-label="Category"
              value={categoryId}
              onChange={setCategoryId}
              className={cx(selectClass, "mt-1 w-full")}
            />
          </div>
        )}
        <Field label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
        <Field
          label="Tags"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="e.g. homelab, reimbursable"
          hint="Comma-separated."
        />
        <Checkbox
          label="Hide transaction"
          description="Excluded from totals, budgets and reports."
          checked={hidden}
          onChange={setHidden}
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          {confirmDelete ? (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-red-600">Delete permanently?</span>
              <Button variant="danger" onClick={() => remove.mutate(txn.id, { onSuccess: onDone })}>
                Delete
              </Button>
              <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button variant="ghost" className="text-red-600" onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          )}
          <div className="flex gap-2">
            <Button
              variant="ghost"
              title="Make a rule for transactions like this one"
              onClick={() =>
                setRuleDraft({
                  name: txn.payeeName ?? txn.description,
                  match: "all",
                  conditions: [
                    txn.payeeName
                      ? { field: "payee", op: "equals", value: txn.payeeName }
                      : { field: "description", op: "contains", value: txn.rawDescription },
                  ],
                  actions: categoryId
                    ? [{ type: "setCategory", categoryId }]
                    : [{ type: "setCategory", categoryId: "" }],
                })
              }
            >
              Create rule
            </Button>
            <Button variant="secondary" onClick={onDone}>
              Close
            </Button>
            <Button type="submit" disabled={update.isPending}>
              Save
            </Button>
          </div>
        </div>
      </form>

      {splitting && <SplitEditor txn={txn} onCancel={() => setSplitting(false)} />}

      {ruleDraft && (
        <div className="border-t border-slate-200 pt-4 dark:border-slate-800">
          <h3 className="mb-3 text-sm font-semibold">New rule</h3>
          <RuleEditor initial={ruleDraft} onDone={() => setRuleDraft(null)} />
        </div>
      )}
    </div>
  );
}

interface SplitRow {
  key: number;
  categoryId: string | null;
  /** Positive magnitude in cents; sign follows the transaction. */
  cents: number | null;
  notes: string;
}

function SplitEditor({ txn, onCancel }: { txn: Transaction; onCancel: () => void }) {
  const setSplits = useSetSplits();
  const sign = txn.amountCents < 0 ? -1 : 1;
  const total = Math.abs(txn.amountCents);
  const [rows, setRows] = useState<SplitRow[]>(() =>
    txn.splits.length
      ? txn.splits.map((s, i) => ({
          key: i,
          categoryId: s.categoryId,
          cents: Math.abs(s.amountCents),
          notes: s.notes ?? "",
        }))
      : [
          { key: 0, categoryId: txn.categoryId, cents: total, notes: "" },
          { key: 1, categoryId: null, cents: 0, notes: "" },
        ],
  );
  const allocated = rows.reduce((s, r) => s + (r.cents ?? 0), 0);
  const remaining = total - allocated;

  const patch = (key: number, p: Partial<SplitRow>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)));

  return (
    <div className="space-y-3 border-t border-slate-200 pt-4 dark:border-slate-800">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold">Split</h3>
        <span className={cx("text-xs", remaining === 0 ? "text-emerald-600" : "text-amber-600")}>
          {remaining === 0 ? "Fully allocated" : `${toDecimalString(remaining)} left to allocate`}
        </span>
      </div>
      {rows.map((r) => (
        <div key={r.key} className="grid grid-cols-[1fr_8rem_auto] items-end gap-2">
          <CategorySelect
            aria-label="Split category"
            value={r.categoryId}
            onChange={(categoryId) => patch(r.key, { categoryId })}
            className={selectClass}
          />
          <MoneyField label="" cents={r.cents} onChange={(c) => patch(r.key, { cents: c })} />
          <button
            type="button"
            aria-label="Remove split"
            disabled={rows.length <= 2}
            onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
            className="mb-2 px-2 text-slate-400 hover:text-red-600 disabled:opacity-30"
          >
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() =>
          setRows((rs) => [
            ...rs,
            {
              key: Math.max(...rs.map((x) => x.key)) + 1,
              categoryId: null,
              cents: Math.max(remaining, 0),
              notes: "",
            },
          ])
        }
        className="text-sm text-brand-600 hover:underline"
      >
        + Add split
      </button>
      {setSplits.error && <Alert>{setSplits.error.message}</Alert>}
      <div className="flex flex-wrap justify-end gap-2">
        {txn.splits.length > 0 && (
          <Button
            variant="ghost"
            onClick={() => setSplits.mutate({ id: txn.id, splits: [] }, { onSuccess: onCancel })}
          >
            Remove split
          </Button>
        )}
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          disabled={remaining !== 0 || setSplits.isPending}
          onClick={() =>
            setSplits.mutate({
              id: txn.id,
              splits: rows
                .filter((r) => (r.cents ?? 0) !== 0)
                .map((r) => ({
                  categoryId: r.categoryId,
                  amountCents: sign * (r.cents ?? 0),
                  notes: r.notes || null,
                })),
            })
          }
        >
          Save split
        </Button>
      </div>
    </div>
  );
}

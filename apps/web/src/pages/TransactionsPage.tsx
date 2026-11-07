import {
  formatMoney,
  INTERVAL_LABELS,
  INTERVALS,
  type Interval,
  type RuleWithCount,
  type Transaction,
  type TransactionQuery,
  toDecimalString,
} from "@muny/shared";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import {
  CalendarDays,
  ChevronDown,
  ChevronRight,
  EyeOff,
  type LucideIcon,
  Plus,
  Repeat,
  Split,
  Tag,
  Trash2,
  Wand2,
  X,
} from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { CategorySelect } from "../components/CategorySelect.js";
import { FindSimilar } from "../components/FindSimilar.js";
import { Modal, MoneyField, SelectField } from "../components/forms.js";
import { CreateRuleDialog, RulesAppliedDialog } from "../components/RuleDialogs.js";
import type { RuleDraft } from "../components/RuleEditor.js";
import { ruleDraftFor, useRuleOffer } from "../components/RuleOffer.js";
import { Alert, Button, Card, cx, Field, PageHeader } from "../components/ui.js";
import { ApiError, api } from "../lib/api.js";
import {
  useAccounts,
  useBulkUpdate,
  useCreateRecurring,
  useCreateTransaction,
  useDeleteTransaction,
  useNotTransfer,
  useSetSplits,
  useTags,
  useTransactions,
  useUpdateTransaction,
} from "../lib/queries.js";
import type { TransactionSearch } from "../lib/search.js";

const selectClass =
  "rounded-lg border border-slate-300 bg-surface px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950";

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

/** "MAIN ACCOUNT → PayPal · paid Oct 19": where a PayPal purchase's money came from. */
function fundedLabel(txn: Transaction) {
  const f = txn.fundedFrom;
  if (!f) return null;
  const from = f.accountName
    ? `${f.accountName} → ${txn.accountName}`
    : `${txn.accountName} (bank)`;
  const [, m, d] = f.date.split("-").map(Number);
  const when =
    f.date === txn.postedDate
      ? ""
      : ` · paid ${new Date(2000, (m ?? 1) - 1, d ?? 1).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
  return from + when;
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

/** Drop empty values so the URL stays short. */
function clean<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== "")) as T;
}

export function TransactionsPage() {
  const accounts = useAccounts();
  const tags = useTags();
  // Filters live in the URL (?categoryId=…&from=…) so links can pre-filter and
  // back/forward and bookmarks work. The search box is local while typing.
  const urlSearch = useSearch({ strict: false }) as TransactionSearch;
  const navigate = useNavigate();
  const { q: urlQ, ...urlFilters } = urlSearch;
  // Stable identity per distinct filter set (effects below depend on it).
  const filterKey = JSON.stringify(urlFilters);
  const filters = useMemo(
    () => JSON.parse(filterKey) as Omit<TransactionQuery, "q" | "offset" | "limit">,
    [filterKey],
  );
  const setFilters = (next: Omit<TransactionQuery, "q" | "offset" | "limit">) =>
    void navigate({
      to: "/transactions",
      search: clean({ ...(next as TransactionSearch), q: urlQ }),
      replace: true,
    });
  const [search, setSearchState] = useState(urlQ ?? "");
  // Only what you type goes back into the URL. A change that came from the
  // URL (a magnifying glass, a link) must never be written back: in the
  // render it arrives, the box and its debounced value still hold the old
  // search, and writing that would undo the link.
  const typed = useRef(false);
  /** The last search this page put in the URL itself (not a link). */
  const pushed = useRef<string | undefined>(urlQ);
  const setSearch = (v: string) => {
    typed.current = true;
    setSearchState(v);
  };
  useEffect(() => {
    if (urlQ === pushed.current) return; // our own update: keep what's being typed
    pushed.current = urlQ;
    typed.current = false;
    setSearchState(urlQ ?? "");
  }, [urlQ]);
  const q = useDebounced(search.trim());
  useEffect(() => {
    if (!typed.current) return;
    if (q !== search.trim()) return; // still typing
    typed.current = false;
    if ((q || undefined) === urlQ) return;
    pushed.current = q || undefined;
    void navigate({
      to: "/transactions",
      search: clean({ ...(filters as TransactionSearch), q: q || undefined }),
      replace: true,
    });
  }, [q, search, urlQ, filters, navigate]);
  const query = useMemo(() => ({ ...filters, q: q || undefined }), [filters, q]);
  const txns = useTransactions(query);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Transaction | "new" | null>(null);
  // After a category change: offer a rule for transactions like it.
  const { offerRule, offerNode, dialog: ruleDialog } = useRuleOffer();

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
    setFilters({ ...filters, [k]: v || undefined });
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
            <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-surface dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
              {group.items.map((t) => (
                <TransactionRow
                  key={t.id}
                  txn={t}
                  selected={selected.has(t.id)}
                  onToggle={() => toggle(t.id)}
                  onOpen={() => setOpen(t)}
                  onCategoryChanged={offerRule}
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
        bare={open !== null && open !== "new"}
      >
        {open === "new" && <NewTransactionForm onDone={() => setOpen(null)} />}
        {open && open !== "new" && (
          <TransactionDetail
            key={open.id}
            txn={items.find((t) => t.id === open.id) ?? open}
            onDone={() => setOpen(null)}
            onCategoryChanged={offerRule}
            offer={offerNode}
          />
        )}
      </Modal>
      {!(open && open !== "new") && offerNode}
      {ruleDialog}
    </>
  );
}

function TransactionRow({
  txn,
  selected,
  onToggle,
  onOpen,
  onCategoryChanged,
}: {
  txn: Transaction;
  selected: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onCategoryChanged: (txn: Transaction, categoryId: string | null) => void;
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
          {fundedLabel(txn) ?? txn.accountName}
          {txn.transferAccountName &&
            ` ${txn.amountCents < 0 ? "→" : "←"} ${txn.transferAccountName}`}
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
            onChange={(categoryId) => {
              update.mutate({ id: txn.id, categoryId });
              onCategoryChanged(txn, categoryId);
            }}
            className={cx(
              "w-full truncate rounded-md border border-transparent bg-transparent px-1 py-1 text-xs hover:border-slate-300 dark:hover:border-slate-700",
              !txn.categoryId && "text-amber-600",
            )}
          />
        )}
      </div>
      <FindSimilar payeeName={txn.payeeName} description={txn.rawDescription} />
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
                (label === "Income") === isIncome && "bg-brand-600 text-on-brand",
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

/** One row in the dialog's Actions column. */
function ActionRow({
  icon: Icon,
  title,
  subtitle,
  onClick,
  trailing,
  danger,
  children,
}: {
  icon: LucideIcon;
  title: string;
  subtitle?: ReactNode;
  onClick?: () => void;
  trailing?: ReactNode;
  danger?: boolean;
  children?: ReactNode;
}) {
  const body = (
    <>
      <Icon
        aria-hidden="true"
        className={cx("mt-0.5 size-4 shrink-0", danger ? "text-red-500" : "text-brand-600")}
      />
      <span className="min-w-0 flex-1">
        <span
          className={cx("block text-sm font-medium", danger && "text-red-600 dark:text-red-400")}
        >
          {title}
        </span>
        {subtitle && <span className="block truncate text-xs text-slate-500">{subtitle}</span>}
      </span>
      {trailing}
    </>
  );
  return (
    <div className="px-4 py-3">
      {onClick ? (
        <button
          type="button"
          onClick={onClick}
          className="-m-2 flex w-[calc(100%+1rem)] items-start gap-3 rounded-lg p-2 text-left hover:bg-slate-100 dark:hover:bg-slate-800"
        >
          {body}
        </button>
      ) : (
        <div className="flex items-start gap-3">{body}</div>
      )}
      {children}
    </div>
  );
}

function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cx(
        "relative h-5 w-9 shrink-0 rounded-full transition-colors",
        checked ? "bg-brand-600" : "bg-slate-300 dark:bg-slate-700",
      )}
    >
      <span
        className={cx(
          "absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow transition-transform",
          checked && "translate-x-4",
        )}
      />
    </button>
  );
}

function RecurringAction({ txn }: { txn: Transaction }) {
  const create = useCreateRecurring();
  const [open, setOpen] = useState(false);
  const [interval, setRepeat] = useState<Interval>("monthly");
  if (txn.recurringName)
    return (
      <ActionRow
        icon={Repeat}
        title="Recurring"
        subtitle={
          <Link to="/recurring" className="hover:underline">
            {txn.recurringName}
          </Link>
        }
      />
    );
  if (txn.pending || txn.transferPairId) return null;
  return (
    <ActionRow
      icon={Repeat}
      title="Recurring"
      subtitle="Not recurring"
      onClick={() => setOpen((o) => !o)}
      trailing={
        <ChevronDown
          aria-hidden="true"
          className={cx("mt-0.5 size-4 text-slate-400 transition-transform", open && "rotate-180")}
        />
      }
    >
      {open && (
        <div className="mt-3 flex flex-wrap items-center gap-2 pl-7 text-xs">
          <select
            aria-label="Repeats"
            value={interval}
            onChange={(e) => setRepeat(e.target.value as Interval)}
            className="rounded-md border border-slate-300 bg-surface px-2 py-1 dark:border-slate-700 dark:bg-slate-950"
          >
            {INTERVALS.map((i) => (
              <option key={i} value={i}>
                {INTERVAL_LABELS[i]}
              </option>
            ))}
          </select>
          <Button
            className="px-2.5 py-1 text-xs"
            disabled={create.isPending}
            onClick={() =>
              create.mutate(
                { transactionId: txn.id, interval },
                { onSuccess: () => setOpen(false) },
              )
            }
          >
            Mark recurring
          </Button>
          {create.error && <span className="text-red-600">{create.error.message}</span>}
        </div>
      )}
    </ActionRow>
  );
}

/** Edits save as you go: switches and pickers at once, text when you leave the field. */
function TransactionDetail({
  txn,
  onDone,
  onCategoryChanged,
  offer,
}: {
  txn: Transaction;
  onDone: () => void;
  onCategoryChanged: (txn: Transaction, categoryId: string | null) => void;
  /** The "make a rule?" offer, shown inside this dialog while it's open. */
  offer: ReactNode;
}) {
  const update = useUpdateTransaction();
  const remove = useDeleteTransaction();
  const notTransfer = useNotTransfer();
  const accounts = useAccounts();
  const account = accounts.data?.find((a) => a.id === txn.accountId);
  const [payeeName, setPayeeName] = useState(txn.payeeName ?? "");
  const [categoryId, setCategoryId] = useState(txn.categoryId);
  const [notes, setNotes] = useState(txn.notes ?? "");
  const [tags, setTags] = useState(txn.tags.map((t) => t.name).join(", "));
  const [hidden, setHidden] = useState(txn.hidden);
  const [postedDate, setDate] = useState(txn.postedDate);
  const [amount, setAmount] = useState<number | null>(txn.amountCents);
  const [panel, setPanel] = useState<"split" | null>(txn.splits.length > 0 ? "split" : null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [creatingRule, setCreatingRule] = useState<RuleDraft | null>(null);
  const [rulesOpen, setRulesOpen] = useState(false);
  const txnRules = useQuery({
    queryKey: ["rules", "for", txn.id],
    queryFn: () => api.get<RuleWithCount[]>(`/api/transactions/${txn.id}/rules`),
  });
  const ruleCount = txnRules.data?.length ?? 0;
  const [saved, setSaved] = useState(false);

  const patch = (input: Omit<Parameters<typeof update.mutate>[0], "id">) =>
    update.mutate({ id: txn.id, ...input }, { onSuccess: () => setSaved(true) });
  const tagList = (s: string) =>
    s
      .split(",")
      .map((t) => t.trim().replace(/^#/, ""))
      .filter(Boolean);

  const isSplit = txn.splits.length > 0;
  const shownAmount = txn.manual && amount !== null ? amount : txn.amountCents;

  return (
    <div className="flex max-h-[calc(100dvh-2rem)] flex-col">
      {/* Header: date and links */}
      <div className="flex items-center gap-2 border-b border-slate-200 px-5 py-4 dark:border-slate-800">
        {txn.manual ? (
          <label className="flex items-center gap-2 rounded-full border border-slate-300 px-3 py-1.5 text-sm font-medium dark:border-slate-700">
            <CalendarDays aria-hidden="true" className="size-4 text-slate-400" />
            <span className="sr-only">Date</span>
            <input
              type="date"
              value={postedDate}
              onChange={(e) => {
                setDate(e.target.value);
                if (e.target.value) patch({ postedDate: e.target.value });
              }}
              className="bg-transparent outline-none"
            />
          </label>
        ) : (
          <span className="flex items-center gap-2 rounded-full border border-slate-300 px-3 py-1.5 text-sm font-medium dark:border-slate-700">
            <CalendarDays aria-hidden="true" className="size-4 text-slate-400" />
            {formatDay(txn.postedDate)}
          </span>
        )}
        {txn.pending && (
          <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
            Pending
          </span>
        )}
        <span className="ml-auto text-xs text-slate-400" aria-live="polite">
          {update.isPending ? "Saving…" : saved ? "Saved" : ""}
        </span>
        {txn.recurringSeriesId && (
          <Link
            to="/recurring"
            className="hidden rounded-full border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-100 sm:block dark:border-slate-700 dark:hover:bg-slate-800"
          >
            See recurring
          </Link>
        )}
        <button
          type="button"
          onClick={onDone}
          aria-label="Close"
          className="rounded-full p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800"
        >
          <X aria-hidden="true" className="size-5" />
        </button>
      </div>

      <div className="min-h-0 overflow-y-auto">
        <div className="grid md:grid-cols-[minmax(0,1fr)_17rem]">
          {/* Left: what it is */}
          <div className="space-y-4 p-6">
            {update.error && <Alert>{update.error.message}</Alert>}
            <input
              aria-label="Merchant name"
              title="Shown instead of the bank's description"
              value={payeeName}
              placeholder={txn.rawDescription}
              onChange={(e) => setPayeeName(e.target.value)}
              onBlur={() => {
                if (payeeName.trim() !== (txn.payeeName ?? ""))
                  patch({ payeeName: payeeName.trim() || null });
              }}
              className="-mx-2 w-[calc(100%+1rem)] truncate rounded-lg border border-transparent bg-transparent px-2 py-1 text-xl font-semibold placeholder:text-slate-900 hover:border-slate-300 focus:border-brand-500 focus:outline-none dark:placeholder:text-slate-100 dark:hover:border-slate-700"
            />
            <div>
              <Amount cents={shownAmount} className="text-3xl font-bold tracking-tight" />
              {txn.manual && (
                // biome-ignore lint/a11y/noStaticElementInteractions: saves the amount when its field loses focus
                <div
                  className="mt-2 max-w-48"
                  onBlur={() => {
                    if (amount !== null && amount !== txn.amountCents)
                      patch({ amountCents: amount });
                  }}
                >
                  <MoneyField
                    label="Amount (negative = spending)"
                    cents={amount}
                    onChange={(c) => setAmount(c)}
                  />
                </div>
              )}
            </div>
            {isSplit ? (
              <button
                type="button"
                onClick={() => setPanel("split")}
                className="rounded-full bg-slate-100 px-3 py-1.5 text-sm dark:bg-slate-800"
              >
                Split into {txn.splits.length} categories
              </button>
            ) : (
              <CategorySelect
                aria-label="Category"
                value={categoryId}
                onChange={(id) => {
                  setCategoryId(id);
                  patch({ categoryId: id });
                  onCategoryChanged(txn, id);
                }}
                className={cx(
                  "max-w-full rounded-full border border-slate-200 bg-slate-50 py-1 pr-3 pl-1.5 text-sm hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700",
                  !categoryId && "text-amber-600",
                )}
              />
            )}
            {txn.transferAccountName && (
              <p className="flex flex-wrap items-center gap-2 text-sm">
                <span className="rounded-full bg-sky-100 px-2.5 py-1 text-xs text-sky-800 dark:bg-sky-900/40 dark:text-sky-300">
                  Transfer {txn.amountCents < 0 ? "to" : "from"} {txn.transferAccountName}
                </span>
                <button
                  type="button"
                  onClick={() => notTransfer.mutate(txn.id)}
                  className="text-xs text-slate-500 underline hover:text-slate-700"
                >
                  Not a transfer
                </button>
              </p>
            )}
            <textarea
              aria-label="Notes"
              value={notes}
              placeholder="Add a note…"
              rows={3}
              onChange={(e) => setNotes(e.target.value)}
              onBlur={() => {
                if (notes.trim() !== (txn.notes ?? "")) patch({ notes: notes.trim() || null });
              }}
              className="w-full resize-none rounded-xl border border-transparent bg-slate-100 px-4 py-3 text-sm placeholder:text-slate-400 focus:border-brand-500 focus:outline-none dark:bg-slate-800/70"
            />
            <label className="flex items-center gap-2 rounded-xl bg-slate-100 px-4 py-2.5 text-sm focus-within:ring-1 focus-within:ring-brand-500 dark:bg-slate-800/70">
              <Tag aria-hidden="true" className="size-4 shrink-0 text-slate-400" />
              <span className="sr-only">Tags (comma-separated)</span>
              <input
                value={tags}
                placeholder="Add tags, e.g. homelab, reimbursable"
                onChange={(e) => setTags(e.target.value)}
                onBlur={() => {
                  const next = tagList(tags);
                  if (next.join(",") !== txn.tags.map((t) => t.name).join(","))
                    patch({ tags: next });
                }}
                className="min-w-0 flex-1 bg-transparent placeholder:text-slate-400 focus:outline-none"
              />
            </label>
          </div>

          {/* Right: actions */}
          <div className="border-t border-slate-200 md:border-t-0 md:border-l dark:border-slate-800">
            <p className="px-4 pt-4 pb-1 text-[11px] font-semibold tracking-wider text-slate-400 uppercase">
              Actions
            </p>
            <div className="divide-y divide-slate-200 dark:divide-slate-800">
              <ActionRow
                icon={EyeOff}
                title="Hide transaction"
                subtitle="Left out of totals and reports"
                trailing={
                  <Switch
                    label="Hide transaction"
                    checked={hidden}
                    onChange={(v) => {
                      setHidden(v);
                      patch({ hidden: v });
                    }}
                  />
                }
              />
              <RecurringAction txn={txn} />
              <ActionRow
                icon={Split}
                title="Split"
                subtitle={isSplit ? `${txn.splits.length} categories` : "Across categories"}
                onClick={() => setPanel(panel === "split" ? null : "split")}
                trailing={
                  <ChevronDown
                    aria-hidden="true"
                    className={cx(
                      "mt-0.5 size-4 text-slate-400 transition-transform",
                      panel === "split" && "rotate-180",
                    )}
                  />
                }
              />
              <ActionRow
                icon={Wand2}
                title={ruleCount ? "Rules" : "Add rule"}
                subtitle={
                  ruleCount
                    ? ruleCount === 1
                      ? "Active"
                      : `${ruleCount} active`
                    : "For transactions like this"
                }
                onClick={() =>
                  ruleCount ? setRulesOpen(true) : setCreatingRule(ruleDraftFor(txn, categoryId))
                }
                trailing={
                  ruleCount ? (
                    <ChevronRight aria-hidden="true" className="mt-0.5 size-4 text-slate-400" />
                  ) : (
                    <Plus aria-hidden="true" className="mt-0.5 size-4 text-slate-400" />
                  )
                }
              />
              <ActionRow
                icon={Trash2}
                title="Delete"
                danger
                onClick={confirmDelete ? undefined : () => setConfirmDelete(true)}
              >
                {confirmDelete && (
                  <div className="mt-2 flex items-center gap-2 pl-7 text-xs">
                    <span className="text-red-600">Delete permanently?</span>
                    <Button
                      variant="danger"
                      className="px-2.5 py-1 text-xs"
                      onClick={() => remove.mutate(txn.id, { onSuccess: onDone })}
                    >
                      Delete
                    </Button>
                    <Button
                      variant="ghost"
                      className="px-2 py-1 text-xs"
                      onClick={() => setConfirmDelete(false)}
                    >
                      Cancel
                    </Button>
                  </div>
                )}
              </ActionRow>
            </div>
          </div>
        </div>

        {panel === "split" && (
          <div className="border-t border-slate-200 p-6 dark:border-slate-800">
            <SplitEditor txn={txn} onCancel={() => setPanel(null)} />
          </div>
        )}

        {/* Footer: where it came from */}
        <div className="space-y-1.5 bg-slate-50 px-6 py-4 text-center font-mono text-xs dark:bg-slate-950/60">
          <p className="text-slate-700 uppercase dark:text-slate-300">
            {[txn.accountName, account?.institutionName, account?.mask ? `••${account.mask}` : null]
              .filter(Boolean)
              .join("  |  ")}
          </p>
          <p className="flex items-center justify-center gap-1 break-words text-slate-500 uppercase">
            {txn.rawDescription}
            <FindSimilar
              payeeName={txn.payeeName}
              description={txn.rawDescription}
              onFind={onDone}
            />
          </p>
          {txn.fundedFrom && (
            <p className="border-t border-slate-200 pt-1.5 text-slate-500 dark:border-slate-800">
              Paid through {txn.accountName}
              {txn.fundedFrom.accountName ? ` from ${txn.fundedFrom.accountName}` : ""} on{" "}
              {formatDay(txn.fundedFrom.date)}
              <span className="block break-words uppercase">{txn.fundedFrom.description}</span>
            </p>
          )}
        </div>
      </div>
      {offer}
      <RulesAppliedDialog
        open={rulesOpen}
        onClose={() => setRulesOpen(false)}
        transactionId={txn.id}
        newDraft={ruleDraftFor(txn, categoryId)}
      />
      <CreateRuleDialog
        open={!!creatingRule}
        onClose={() => setCreatingRule(null)}
        initial={creatingRule}
      />
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

import {
  AMOUNT_OP_LABELS,
  type AmountOp,
  formatMoney,
  MoneyParseError,
  parseAmount,
  type RuleAction,
  type RuleCondition,
  type RuleOverlap,
  type RulePreview,
  type RuleWithCount,
  TEXT_OP_LABELS,
  type TextOp,
  toDecimalString,
} from "@muny/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ArrowLeft, Plus, X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { api } from "../lib/api.js";
import { useAccounts, useApplyRule, useCategories, useSaveRule } from "../lib/queries.js";
import { CategorySelect } from "./CategorySelect.js";
import { Modal } from "./forms.js";
import { type RuleDraft, RuleEditor } from "./RuleEditor.js";
import { Alert, Button, cx } from "./ui.js";

/**
 * Rules the Rocket Money way: "Create a rule" in two steps (how it finds
 * transactions, with the matches listed live; then what it does), and "Rules
 * applied" for a transaction. Rules with conditions this can't show (several
 * names, "any of") open in the full editor.
 */

const ctl =
  "w-full rounded-lg border border-slate-300 bg-surface px-2.5 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950";

interface Simple {
  name: { on: boolean; field: "payee" | "description"; op: TextOp; value: string };
  amount: { on: boolean; op: AmountOp; cents: number };
  direction: { on: boolean; value: "out" | "in" };
  account: { on: boolean; id: string };
  category: { on: boolean; id: string | null };
  rename: { on: boolean; value: string };
  tag: { on: boolean; value: string };
  hide: boolean;
}

/** A draft the simple dialog can show, or null (open the full editor instead). */
function toSimple(d: RuleDraft): Simple | null {
  if (d.match !== "all" && d.conditions.length > 1) return null;
  const count = (f: RuleCondition["field"]) => d.conditions.filter((c) => c.field === f).length;
  if (count("payee") + count("description") > 1 || count("amount") > 1) return null;
  if (count("direction") > 1 || count("account") > 1) return null;
  const s: Simple = {
    name: { on: false, field: "description", op: "contains", value: "" },
    amount: { on: false, op: "eq", cents: 0 },
    direction: { on: false, value: "out" },
    account: { on: false, id: "" },
    category: { on: false, id: null },
    rename: { on: false, value: "" },
    tag: { on: false, value: "" },
    hide: false,
  };
  for (const c of d.conditions) {
    if (c.field === "payee" || c.field === "description")
      s.name = { on: true, field: c.field, op: c.op, value: c.value };
    else if (c.field === "amount") s.amount = { on: true, op: c.op, cents: c.value };
    else if (c.field === "direction") s.direction = { on: true, value: c.value };
    else if (c.field === "account") s.account = { on: true, id: c.value };
  }
  const kinds = d.actions.map((a) => a.type);
  if (new Set(kinds).size !== kinds.length) return null;
  for (const a of d.actions) {
    if (a.type === "setCategory") s.category = { on: true, id: a.categoryId || null };
    else if (a.type === "setPayee") s.rename = { on: true, value: a.name };
    else if (a.type === "addTag") s.tag = { on: true, value: a.name };
    else if (a.type === "hide") s.hide = true;
  }
  return s;
}

function conditionsOf(s: Simple): RuleCondition[] {
  const out: RuleCondition[] = [];
  if (s.name.on && s.name.value.trim())
    out.push({ field: s.name.field, op: s.name.op, value: s.name.value.trim() });
  if (s.amount.on) out.push({ field: "amount", op: s.amount.op, value: s.amount.cents });
  if (s.direction.on) out.push({ field: "direction", value: s.direction.value });
  if (s.account.on && s.account.id) out.push({ field: "account", value: s.account.id });
  return out;
}

function actionsOf(s: Simple): RuleAction[] {
  const out: RuleAction[] = [];
  if (s.category.on && s.category.id) out.push({ type: "setCategory", categoryId: s.category.id });
  if (s.rename.on && s.rename.value.trim())
    out.push({ type: "setPayee", name: s.rename.value.trim() });
  if (s.tag.on && s.tag.value.trim()) out.push({ type: "addTag", name: s.tag.value.trim() });
  if (s.hide) out.push({ type: "hide" });
  return out;
}

function useDebounced<T>(value: T, ms = 350): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

function AmountInput({ cents, onChange }: { cents: number; onChange: (c: number) => void }) {
  const [text, setText] = useState(cents ? toDecimalString(cents) : "");
  const [bad, setBad] = useState(false);
  return (
    <input
      aria-label="Amount"
      inputMode="decimal"
      placeholder="0.00"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        try {
          onChange(Math.abs(parseAmount(e.target.value || "0")));
          setBad(false);
        } catch (err) {
          if (!(err instanceof MoneyParseError)) throw err;
          setBad(true);
        }
      }}
      className={cx(ctl, "tabular-nums", bad && "border-red-500")}
    />
  );
}

/** A card with a checkbox that opens its fields (like Rocket Money's). */
function OptionCard({
  title,
  icon,
  on,
  onToggle,
  children,
}: {
  title: string;
  icon?: ReactNode;
  on: boolean;
  onToggle: (v: boolean) => void;
  children?: ReactNode;
}) {
  return (
    <div className="rounded-2xl bg-surface shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
      <label className="flex cursor-pointer items-center gap-3 px-4 py-3 text-sm font-medium">
        {icon}
        <span className="flex-1">{title}</span>
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => onToggle(e.target.checked)}
          className="size-4 accent-brand-600"
        />
      </label>
      {on && children && (
        <div className="space-y-2 border-t border-slate-100 px-4 py-3 dark:border-slate-800">
          {children}
        </div>
      )}
    </div>
  );
}

const shortDay = (iso: string) => {
  const [, m, d] = iso.split("-");
  return `${Number(m)}/${Number(d)}`;
};

/** The transactions a rule finds, listed live. */
function Matches({ preview, ready }: { preview: RulePreview | undefined; ready: boolean }) {
  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3 text-xs font-semibold tracking-wide text-slate-500 uppercase dark:border-slate-800">
        <span>Transactions</span>
        {ready && preview && (
          <span className="text-brand-700 dark:text-brand-500">
            {preview.matched.toLocaleString()} matched
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!ready ? (
          <p className="px-5 py-6 text-sm text-slate-500">
            Choose how the rule finds transactions to see them here.
          </p>
        ) : !preview ? (
          <p className="px-5 py-6 text-sm text-slate-500">Finding…</p>
        ) : preview.matched === 0 ? (
          <p className="px-5 py-6 text-sm text-slate-500">No transactions match yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
            {preview.sample.map((t) => (
              <li key={t.id} className="flex items-center gap-3 px-5 py-2.5">
                <span className="w-11 shrink-0 text-slate-500 tabular-nums">
                  {shortDay(t.postedDate)}
                </span>
                <span className="min-w-0 flex-1 truncate">{t.description}</span>
                <span className="hidden w-36 truncate text-xs text-slate-500 sm:block">
                  {t.categoryName ?? "Uncategorized"}
                </span>
                <span className="w-24 shrink-0 text-right tabular-nums">
                  {formatMoney(t.amountCents)}
                </span>
              </li>
            ))}
            {preview.matched > preview.sample.length && (
              <li className="px-5 py-2.5 text-xs text-slate-500">
                and {(preview.matched - preview.sample.length).toLocaleString()} more
              </li>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}

/** "Create a rule" (or edit one): how it finds transactions, then what it does. */
export function CreateRuleDialog({
  open,
  onClose,
  initial,
}: {
  open: boolean;
  onClose: () => void;
  initial: RuleDraft | null;
}) {
  // "Edit this rule instead" (a duplicate or conflicting rule): switch to it.
  const [instead, setInstead] = useState<RuleDraft | null>(null);
  useEffect(() => {
    if (!open) setInstead(null);
  }, [open]);
  const current = instead ?? initial;
  const simple = current ? toSimple(current) : null;
  return (
    <Modal open={open} onClose={onClose} title={current?.id ? "Edit rule" : "Create a rule"} bare>
      {open && current && simple && (
        <RuleSteps
          key={current.id ?? "new"}
          initial={current}
          start={simple}
          onDone={onClose}
          onEditInstead={setInstead}
        />
      )}
      {open && current && !simple && (
        <div className="p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold">Edit rule</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded-full p-1.5 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <X aria-hidden="true" className="size-5" />
            </button>
          </div>
          <RuleEditor initial={current} onDone={onClose} />
        </div>
      )}
    </Modal>
  );
}

/**
 * Before saving: existing rules with the same conditions, or that cover the
 * same transactions (and what they'd do differently), each with "Edit this
 * rule instead".
 */
function OverlapWarning({
  def,
  exceptId,
  onEdit,
}: {
  def: { match: "all" | "any"; conditions: RuleCondition[]; actions: RuleAction[] };
  exceptId?: string;
  onEdit: (rule: RuleDraft) => void;
}) {
  const body = useDebounced({ ...def, exceptId, limit: 1 });
  const q = useQuery({
    queryKey: ["rules", "overlaps", body],
    queryFn: () => api.post<RuleOverlap[]>("/api/rules/overlaps", body),
    enabled: body.conditions.length > 0,
    placeholderData: keepPreviousData,
    retry: false,
  });
  const list = (q.data ?? []).slice(0, 3);
  if (!list.length) return null;
  return (
    <div
      role="status"
      className="space-y-2 border-b border-amber-200 bg-amber-50 px-6 py-3 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200"
    >
      {list.map((o) => (
        <div key={o.rule.id} className="flex flex-wrap items-center justify-between gap-2">
          <span className="min-w-0">
            {o.identical ? (
              <>
                You already have this rule: <strong>{o.rule.name}</strong>
              </>
            ) : (
              <>
                <strong>{o.rule.name}</strong> also matches {o.sharedCount} of the {o.newCount}{" "}
                transaction{o.newCount === 1 ? "" : "s"} this one does
              </>
            )}
            {o.conflicts.length > 0 && <> and {o.conflicts.join(" and ")}</>}
            {!o.rule.enabled && " (it's turned off)"}.
          </span>
          <Button variant="secondary" onClick={() => onEdit(o.rule)}>
            Edit this rule instead
          </Button>
        </div>
      ))}
      {list.some((o) => o.conflicts.length > 0) && (
        <p className="text-xs">When rules disagree, the one higher in Settings → Rules wins.</p>
      )}
    </div>
  );
}

function RuleSteps({
  initial,
  start,
  onDone,
  onEditInstead,
}: {
  initial: RuleDraft;
  start: Simple;
  onDone: () => void;
  onEditInstead?: (rule: RuleDraft) => void;
}) {
  const accounts = useAccounts();
  const save = useSaveRule();
  const apply = useApplyRule();
  const [s, setS] = useState(start);
  const [step, setStep] = useState<"find" | "do">("find");
  const [name, setName] = useState(initial.name ?? "");
  const [applyNow, setApplyNow] = useState(!initial.id);
  const [includeEdited, setIncludeEdited] = useState(false);
  const set = <K extends keyof Simple>(k: K, v: Partial<Simple[K]> | Simple[K]) =>
    setS((x) => ({
      ...x,
      [k]: typeof v === "object" && v !== null ? { ...(x[k] as object), ...v } : v,
    }));

  const conditions = conditionsOf(s);
  const actions = actionsOf(s);
  const def = useDebounced({ match: "all" as const, conditions, actions: [], limit: 100 });
  const preview = useQuery({
    queryKey: ["rules", "preview", "dialog", def],
    queryFn: () => api.post<RulePreview>("/api/rules/preview", def),
    enabled: def.conditions.length > 0,
    placeholderData: keepPreviousData,
    retry: false,
  });

  const autoName =
    s.name.on && s.name.value.trim()
      ? s.name.value.trim()
      : s.account.on
        ? (accounts.data?.find((a) => a.id === s.account.id)?.name ?? "Rule")
        : "Rule";
  const submit = () => {
    if (!conditions.length || !actions.length) return;
    save.mutate(
      {
        id: initial.id,
        name: (name.trim() || autoName).slice(0, 100),
        match: "all",
        conditions,
        actions,
      },
      {
        onSuccess: (rule) => {
          if (applyNow) apply.mutate({ id: rule.id, includeEdited }, { onSuccess: onDone });
          else onDone();
        },
      },
    );
  };

  return (
    <div className="flex max-h-[calc(100dvh-2rem)] flex-col">
      <div className="flex items-center gap-3 border-b border-slate-200 px-6 py-4 dark:border-slate-800">
        {step === "do" && (
          <button
            type="button"
            onClick={() => setStep("find")}
            aria-label="Back"
            className="rounded-full p-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <ArrowLeft aria-hidden="true" className="size-5" />
          </button>
        )}
        <h2 className="flex-1 text-xl font-semibold">
          {initial.id ? "Edit rule" : "Create a rule"}
        </h2>
        {step === "find" ? (
          <Button
            className="rounded-full px-5"
            disabled={!conditions.length}
            onClick={() => setStep("do")}
          >
            Continue
          </Button>
        ) : (
          <Button
            className="rounded-full px-5"
            disabled={!actions.length || save.isPending || apply.isPending}
            onClick={submit}
          >
            {save.isPending || apply.isPending
              ? "Saving…"
              : initial.id
                ? "Save rule"
                : "Create rule"}
          </Button>
        )}
        <button
          type="button"
          onClick={onDone}
          aria-label="Close"
          className="rounded-full p-1.5 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
        >
          <X aria-hidden="true" className="size-5" />
        </button>
      </div>

      {onEditInstead && !save.isPending && !save.isSuccess && (
        <OverlapWarning
          def={{ match: "all", conditions, actions }}
          exceptId={initial.id}
          onEdit={onEditInstead}
        />
      )}
      <div className="grid min-h-0 flex-1 md:grid-cols-[20rem_minmax(0,1fr)]">
        <div className="min-h-0 space-y-3 overflow-y-auto bg-slate-50 p-4 dark:bg-slate-950/50">
          {step === "find" ? (
            <>
              <p className="text-sm text-slate-600 dark:text-slate-400">
                First, set up how your rule finds transactions. You can match by name, amount and
                account.
              </p>
              <OptionCard
                title="Match on name"
                on={s.name.on}
                onToggle={(on) => set("name", { on })}
              >
                <select
                  aria-label="Which name"
                  value={s.name.field}
                  onChange={(e) =>
                    set("name", { field: e.target.value as "payee" | "description" })
                  }
                  className={ctl}
                >
                  <option value="description">Bank description</option>
                  <option value="payee">Merchant name</option>
                </select>
                <select
                  aria-label="How it matches"
                  value={s.name.op}
                  onChange={(e) => set("name", { op: e.target.value as TextOp })}
                  className={ctl}
                >
                  {Object.entries(TEXT_OP_LABELS).map(([k, label]) => (
                    <option key={k} value={k}>
                      {label.charAt(0).toUpperCase() + label.slice(1)}
                    </option>
                  ))}
                </select>
                <span className="relative block">
                  <input
                    aria-label="Name"
                    value={s.name.value}
                    onChange={(e) => set("name", { value: e.target.value })}
                    placeholder="e.g. netflix"
                    className={cx(ctl, "pr-8")}
                  />
                  {s.name.value && (
                    <button
                      type="button"
                      aria-label="Clear"
                      onClick={() => set("name", { value: "" })}
                      className="absolute inset-y-0 right-2 text-slate-400 hover:text-slate-700"
                    >
                      <X aria-hidden="true" className="size-4" />
                    </button>
                  )}
                </span>
              </OptionCard>
              <OptionCard
                title="Match on amount"
                on={s.amount.on}
                onToggle={(on) => set("amount", { on })}
              >
                <select
                  aria-label="Amount is"
                  value={s.amount.op}
                  onChange={(e) => set("amount", { op: e.target.value as AmountOp })}
                  className={ctl}
                >
                  {Object.entries(AMOUNT_OP_LABELS).map(([k, label]) => (
                    <option key={k} value={k}>
                      {label.charAt(0).toUpperCase() + label.slice(1)}
                    </option>
                  ))}
                </select>
                <AmountInput
                  cents={s.amount.cents}
                  onChange={(cents) => set("amount", { cents })}
                />
              </OptionCard>
              <OptionCard
                title="Money in or out"
                on={s.direction.on}
                onToggle={(on) => set("direction", { on })}
              >
                <select
                  aria-label="Direction"
                  value={s.direction.value}
                  onChange={(e) => set("direction", { value: e.target.value as "out" | "in" })}
                  className={ctl}
                >
                  <option value="out">Money out (spending)</option>
                  <option value="in">Money in (income, refunds)</option>
                </select>
              </OptionCard>
              <OptionCard
                title="Filter by account"
                on={s.account.on}
                onToggle={(on) => set("account", { on })}
              >
                <select
                  aria-label="Account"
                  value={s.account.id}
                  onChange={(e) => set("account", { id: e.target.value })}
                  className={ctl}
                >
                  <option value="">Choose an account…</option>
                  {accounts.data?.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                      {a.mask ? ` ••${a.mask}` : ""}
                    </option>
                  ))}
                </select>
              </OptionCard>
            </>
          ) : (
            <>
              <p className="text-sm text-slate-600 dark:text-slate-400">
                Then choose what it does to these transactions.
              </p>
              <OptionCard
                title="Set the category"
                on={s.category.on}
                onToggle={(on) => set("category", { on })}
              >
                <CategorySelect
                  aria-label="Category"
                  value={s.category.id}
                  onChange={(id) => set("category", { id })}
                  emptyLabel="Choose a category…"
                  className={ctl}
                />
              </OptionCard>
              <OptionCard
                title="Rename the merchant"
                on={s.rename.on}
                onToggle={(on) => set("rename", { on })}
              >
                <input
                  aria-label="New merchant name"
                  value={s.rename.value}
                  onChange={(e) => set("rename", { value: e.target.value })}
                  className={ctl}
                />
              </OptionCard>
              <OptionCard title="Add a tag" on={s.tag.on} onToggle={(on) => set("tag", { on })}>
                <input
                  aria-label="Tag"
                  value={s.tag.value}
                  onChange={(e) => set("tag", { value: e.target.value })}
                  placeholder="e.g. reimbursable"
                  className={ctl}
                />
              </OptionCard>
              <OptionCard
                title="Ignore from everything"
                on={s.hide}
                onToggle={(v) => set("hide", v)}
              />
              <label className="block text-sm">
                <span className="font-medium text-slate-700 dark:text-slate-300">Rule name</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={autoName}
                  className={cx(ctl, "mt-1")}
                />
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={applyNow}
                  onChange={(e) => setApplyNow(e.target.checked)}
                  className="mt-0.5 size-4 accent-brand-600"
                />
                <span>
                  Also change the {preview.data?.matched.toLocaleString() ?? ""} matching
                  transactions
                  <span className="block text-xs text-slate-500">
                    New transactions always run your rules.
                  </span>
                </span>
              </label>
              {applyNow && (
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={includeEdited}
                    onChange={(e) => setIncludeEdited(e.target.checked)}
                    className="mt-0.5 size-4 accent-brand-600"
                  />
                  <span>Including ones I changed by hand</span>
                </label>
              )}
              {(save.error || apply.error) && <Alert>{(save.error ?? apply.error)?.message}</Alert>}
            </>
          )}
        </div>
        <div className="min-h-[24rem] border-t border-slate-200 md:border-t-0 md:border-l dark:border-slate-800">
          <Matches preview={preview.data} ready={def.conditions.length > 0} />
        </div>
      </div>
    </div>
  );
}

/** A rule in a sentence: "Name contains NETFLIX · Amount is $15.99". */
function RuleSummary({ rule }: { rule: RuleWithCount }) {
  const accounts = useAccounts();
  const parts = rule.conditions.map((c, i) => {
    const sep = i > 0 ? (rule.match === "all" ? " and " : " or ") : "";
    const em = (t: string) => <strong className="text-brand-700 dark:text-brand-500">{t}</strong>;
    if (c.field === "payee" || c.field === "description")
      return (
        // biome-ignore lint/suspicious/noArrayIndexKey: conditions have no identity
        <span key={i}>
          {sep}
          {c.field === "payee" ? "Merchant" : "Name"} {TEXT_OP_LABELS[c.op]} {em(c.value)}
        </span>
      );
    if (c.field === "amount")
      return (
        // biome-ignore lint/suspicious/noArrayIndexKey: conditions have no identity
        <span key={i}>
          {sep}
          Amount {AMOUNT_OP_LABELS[c.op]} {em(formatMoney(c.value))}
        </span>
      );
    if (c.field === "direction")
      return (
        // biome-ignore lint/suspicious/noArrayIndexKey: conditions have no identity
        <span key={i}>
          {sep}
          {em(c.value === "out" ? "Money out" : "Money in")}
        </span>
      );
    return (
      // biome-ignore lint/suspicious/noArrayIndexKey: conditions have no identity
      <span key={i}>
        {sep}
        Account is {em(accounts.data?.find((a) => a.id === c.value)?.name ?? "an account")}
      </span>
    );
  });
  return <p className="text-sm">{parts}</p>;
}

function ActionChips({ actions }: { actions: RuleAction[] }) {
  const cats = useCategories();
  const catName = (id: string) =>
    cats.data?.flatMap((g) => g.categories).find((c) => c.id === id)?.name ?? "a category";
  return (
    <div className="flex flex-wrap gap-1.5">
      {actions.map((a, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: actions have no identity
          key={i}
          className="rounded-full bg-slate-100 px-2.5 py-1 text-xs dark:bg-slate-800"
        >
          {a.type === "setCategory"
            ? `Category: ${catName(a.categoryId)}`
            : a.type === "setPayee"
              ? `Rename to ${a.name}`
              : a.type === "addTag"
                ? `Tag #${a.name}`
                : "Ignore from everything"}
        </span>
      ))}
    </div>
  );
}

/** The rules that apply to a transaction, and a way to add one. */
export function RulesAppliedDialog({
  open,
  onClose,
  transactionId,
  newDraft,
}: {
  open: boolean;
  onClose: () => void;
  transactionId: string;
  /** What "Add rule" starts from. */
  newDraft: RuleDraft;
}) {
  const rules = useQuery({
    queryKey: ["rules", "for", transactionId],
    queryFn: () => api.get<RuleWithCount[]>(`/api/transactions/${transactionId}/rules`),
    enabled: open,
  });
  const [editing, setEditing] = useState<RuleDraft | null>(null);
  return (
    <>
      <Modal open={open && !editing} onClose={onClose} title="Rules applied" bare>
        {open && (
          <div className="flex max-h-[calc(100dvh-2rem)] flex-col">
            <div className="flex items-center gap-3 border-b border-slate-200 px-6 py-4 dark:border-slate-800">
              <h2 className="flex-1 text-xl font-semibold">Rules applied</h2>
              <Button className="rounded-full px-4" onClick={() => setEditing(newDraft)}>
                <Plus aria-hidden="true" className="mr-1 inline size-4" /> Add rule
              </Button>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="rounded-full p-1.5 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X aria-hidden="true" className="size-5" />
              </button>
            </div>
            <div className="min-h-0 space-y-3 overflow-y-auto bg-slate-50 p-6 dark:bg-slate-950/50">
              {rules.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
              {rules.data?.length === 0 && (
                <p className="text-sm text-slate-500">No rules apply to this transaction.</p>
              )}
              {rules.data?.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setEditing(r)}
                  className="block w-full space-y-2 rounded-2xl bg-surface p-5 text-left shadow-sm ring-1 ring-slate-200 hover:ring-brand-500 dark:bg-slate-900 dark:ring-slate-800"
                >
                  <span className="flex items-baseline justify-between gap-3">
                    <RuleSummary rule={r} />
                    {!r.enabled && <span className="text-xs text-slate-500">Off</span>}
                  </span>
                  <span className="block text-xs text-slate-500">
                    {r.matchedCount.toLocaleString()} matching transaction
                    {r.matchedCount === 1 ? "" : "s"}
                  </span>
                  <ActionChips actions={r.actions} />
                </button>
              ))}
            </div>
          </div>
        )}
      </Modal>
      <CreateRuleDialog
        open={!!editing}
        onClose={() => {
          setEditing(null);
          void rules.refetch();
        }}
        initial={editing}
      />
    </>
  );
}

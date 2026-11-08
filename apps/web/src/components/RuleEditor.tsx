import {
  AMOUNT_OP_LABELS,
  type AmountOp,
  formatMoney,
  MoneyParseError,
  parseAmount,
  type Rule,
  type RuleAction,
  type RuleCondition,
  type RuleDefinition,
  type RulePreview,
  TEXT_OP_LABELS,
  type TextOp,
  toDecimalString,
} from "@muny/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { api } from "../lib/api.js";
import { useAccounts, useApplyRule, useRecurring, useSaveRule } from "../lib/queries.js";
import { CategorySelect } from "./CategorySelect.js";
import { Checkbox } from "./forms.js";
import { Alert, Button, cx, Field } from "./ui.js";

const ctl =
  "rounded-lg border border-slate-300 bg-surface px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950";

type CondField = RuleCondition["field"];
const FIELD_LABELS: Record<CondField, string> = {
  payee: "Merchant",
  description: "Bank description",
  amount: "Amount",
  direction: "Direction",
  account: "Account",
};

const ACTION_LABELS: Record<RuleAction["type"], string> = {
  setCategory: "Set category",
  setPayee: "Rename merchant to",
  addTag: "Add tag",
  hide: "Hide transaction",
  setRecurring: "Count as recurring",
};

function blankCondition(field: CondField): RuleCondition {
  switch (field) {
    case "payee":
    case "description":
      return { field, op: "contains", value: "" };
    case "amount":
      return { field, op: "eq", value: 0 };
    case "direction":
      return { field, value: "out" };
    case "account":
      return { field, value: "" };
  }
}

function blankAction(type: RuleAction["type"]): RuleAction {
  switch (type) {
    case "setCategory":
      return { type, categoryId: "" };
    case "setPayee":
    case "addTag":
      return { type, name: "" };
    case "hide":
      return { type };
    case "setRecurring":
      return { type, seriesId: "" };
  }
}

function conditionValid(c: RuleCondition) {
  if (c.field === "payee" || c.field === "description") return c.value.trim() !== "";
  if (c.field === "account") return c.value !== "";
  if (c.field === "amount") return c.value >= 0;
  return true;
}

function actionValid(a: RuleAction) {
  if (a.type === "setCategory") return a.categoryId !== "";
  if (a.type === "setPayee" || a.type === "addTag") return a.name.trim() !== "";
  if (a.type === "setRecurring") return a.seriesId !== "";
  return true;
}

function useDebounced<T>(value: T, ms = 400): T {
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
          onChange(Math.abs(parseAmount(e.target.value)));
          setBad(false);
        } catch (err) {
          if (!(err instanceof MoneyParseError)) throw err;
          setBad(true);
        }
      }}
      className={cx(ctl, "w-28 tabular-nums", bad && "border-red-500")}
    />
  );
}

export type RuleDraft = Partial<Pick<Rule, "id" | "name" | "enabled">> & RuleDefinition;

export function RuleEditor({ initial, onDone }: { initial: RuleDraft; onDone: () => void }) {
  const accounts = useAccounts();
  const recurring = useRecurring();
  const save = useSaveRule();
  const apply = useApplyRule();
  const [name, setName] = useState(initial.name ?? "");
  const [match, setMatch] = useState(initial.match);
  const [conditions, setConditions] = useState<RuleCondition[]>(initial.conditions);
  const [actions, setActions] = useState<RuleAction[]>(initial.actions);
  const [applyNow, setApplyNow] = useState(!initial.id);
  const [includeEdited, setIncludeEdited] = useState(false);

  const valid =
    conditions.length > 0 &&
    actions.length > 0 &&
    conditions.every(conditionValid) &&
    actions.every(actionValid);
  const def = useDebounced({ match, conditions, actions, includeEdited });
  const preview = useQuery({
    queryKey: ["rules", "preview", def],
    queryFn: () => api.post<RulePreview>("/api/rules/preview", def),
    enabled:
      def.conditions.length > 0 &&
      def.conditions.every(conditionValid) &&
      def.actions.length > 0 &&
      def.actions.every(actionValid),
    placeholderData: keepPreviousData,
    retry: false,
  });

  const setCond = (i: number, c: RuleCondition) =>
    setConditions((cs) => cs.map((x, j) => (j === i ? c : x)));
  const setAct = (i: number, a: RuleAction) =>
    setActions((as) => as.map((x, j) => (j === i ? a : x)));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid || !name.trim()) return;
    save.mutate(
      { id: initial.id, name: name.trim(), match, conditions, actions },
      {
        onSuccess: (rule) => {
          if (applyNow) apply.mutate({ id: rule.id, includeEdited }, { onSuccess: onDone });
          else onDone();
        },
      },
    );
  };

  const p = preview.data;
  return (
    <form onSubmit={submit} className="space-y-5" noValidate>
      <Field label="Rule name" value={name} onChange={(e) => setName(e.target.value)} required />

      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
          When a transaction matches
          <select
            aria-label="Match"
            value={match}
            onChange={(e) => setMatch(e.target.value as "all" | "any")}
            className={ctl}
          >
            <option value="all">all</option>
            <option value="any">any</option>
          </select>
          of:
        </div>
        {conditions.map((c, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity
          <div key={i} className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Field"
              value={c.field}
              onChange={(e) => setCond(i, blankCondition(e.target.value as CondField))}
              className={ctl}
            >
              {Object.entries(FIELD_LABELS).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
            {(c.field === "payee" || c.field === "description") && (
              <>
                <select
                  aria-label="Operator"
                  value={c.op}
                  onChange={(e) => setCond(i, { ...c, op: e.target.value as TextOp })}
                  className={ctl}
                >
                  {Object.entries(TEXT_OP_LABELS).map(([k, label]) => (
                    <option key={k} value={k}>
                      {label}
                    </option>
                  ))}
                </select>
                <input
                  aria-label="Text"
                  value={c.value}
                  onChange={(e) => setCond(i, { ...c, value: e.target.value })}
                  className={cx(ctl, "min-w-0 flex-1 basis-40")}
                  placeholder="e.g. netflix"
                />
              </>
            )}
            {c.field === "amount" && (
              <>
                <select
                  aria-label="Operator"
                  value={c.op}
                  onChange={(e) => setCond(i, { ...c, op: e.target.value as AmountOp })}
                  className={ctl}
                >
                  {Object.entries(AMOUNT_OP_LABELS).map(([k, label]) => (
                    <option key={k} value={k}>
                      {label}
                    </option>
                  ))}
                </select>
                <AmountInput cents={c.value} onChange={(value) => setCond(i, { ...c, value })} />
              </>
            )}
            {c.field === "direction" && (
              <select
                aria-label="Direction"
                value={c.value}
                onChange={(e) => setCond(i, { ...c, value: e.target.value as "out" | "in" })}
                className={ctl}
              >
                <option value="out">is money out (spending)</option>
                <option value="in">is money in (income, refunds)</option>
              </select>
            )}
            {c.field === "account" && (
              <select
                aria-label="Account"
                value={c.value}
                onChange={(e) => setCond(i, { ...c, value: e.target.value })}
                className={cx(ctl, "min-w-0 flex-1 basis-40")}
              >
                <option value="">Choose an account…</option>
                {accounts.data?.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              aria-label="Remove condition"
              onClick={() => setConditions((cs) => cs.filter((_, j) => j !== i))}
              className="px-1 text-slate-400 hover:text-red-600"
            >
              ✕
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => setConditions((cs) => [...cs, blankCondition("payee")])}
          className="text-sm text-brand-600 hover:underline"
        >
          + Add condition
        </button>
      </section>

      <section className="space-y-2">
        <p className="text-sm font-medium">Then:</p>
        {actions.map((a, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity
          <div key={i} className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Action"
              value={a.type}
              onChange={(e) => setAct(i, blankAction(e.target.value as RuleAction["type"]))}
              className={ctl}
            >
              {Object.entries(ACTION_LABELS).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
            {a.type === "setCategory" && (
              <CategorySelect
                aria-label="Category"
                value={a.categoryId || null}
                onChange={(categoryId) => setAct(i, { ...a, categoryId: categoryId ?? "" })}
                emptyLabel="Choose a category…"
                className={cx(ctl, "min-w-0 flex-1 basis-40")}
              />
            )}
            {a.type === "setRecurring" && (
              <select
                aria-label="Recurring charge"
                value={a.seriesId}
                onChange={(e) => setAct(i, { ...a, seriesId: e.target.value })}
                className={cx(ctl, "min-w-0 flex-1 basis-40")}
              >
                <option value="">Choose a recurring charge or income…</option>
                {(recurring.data ?? [])
                  .filter((x) => x.status !== "ignored" && (x.active || x.id === a.seriesId))
                  .sort((x, y) => x.name.localeCompare(y.name))
                  .map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name} · {formatMoney(Math.abs(x.expectedAmountCents))}
                      {x.accountName ? ` · ${x.accountName}` : ""}
                    </option>
                  ))}
              </select>
            )}
            {(a.type === "setPayee" || a.type === "addTag") && (
              <input
                aria-label={a.type === "addTag" ? "Tag" : "Merchant name"}
                value={a.name}
                onChange={(e) => setAct(i, { ...a, name: e.target.value })}
                className={cx(ctl, "min-w-0 flex-1 basis-40")}
              />
            )}
            <button
              type="button"
              aria-label="Remove action"
              onClick={() => setActions((as) => as.filter((_, j) => j !== i))}
              className="px-1 text-slate-400 hover:text-red-600"
            >
              ✕
            </button>
          </div>
        ))}
        {actions.filter((a) => a.type === "setRecurring").length > 1 && (
          <p className="text-xs text-slate-500">
            Each transaction goes to the recurring charge on its own account (the closest in amount
            when several share an account), as with a paycheck split across accounts.
          </p>
        )}
        <button
          type="button"
          onClick={() => setActions((as) => [...as, blankAction("setCategory")])}
          className="text-sm text-brand-600 hover:underline"
        >
          + Add action
        </button>
      </section>

      <section className="rounded-lg bg-slate-50 p-3 text-sm dark:bg-slate-800/50">
        {!valid ? (
          <p className="text-slate-500">Fill in the conditions and actions to see what matches.</p>
        ) : preview.isError ? (
          <p className="text-red-600">{preview.error.message}</p>
        ) : !p ? (
          <p className="text-slate-500">Checking…</p>
        ) : (
          <>
            <p>
              Matches <strong>{p.matched.toLocaleString()}</strong> existing transaction
              {p.matched === 1 ? "" : "s"}
              {p.matched > 0 && (
                <>
                  ; would change <strong>{p.wouldChange.toLocaleString()}</strong>
                </>
              )}
              .
              {p.skippedEdited > 0 && (
                <span className="text-slate-500">
                  {" "}
                  {p.skippedEdited.toLocaleString()} you edited by hand are left alone.
                </span>
              )}
            </p>
            {p.sample.length > 0 && (
              <ul className="mt-2 divide-y divide-slate-200 text-xs dark:divide-slate-700">
                {p.sample.map((s) => (
                  <li key={s.id} className="flex justify-between gap-3 py-1">
                    <span className="truncate">
                      <span className="text-slate-500">{s.postedDate}</span> {s.description}
                      {s.categoryName && (
                        <span className="text-slate-500"> · {s.categoryName}</span>
                      )}
                    </span>
                    <span className="tabular-nums">{formatMoney(s.amountCents)}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      <div className="space-y-2">
        <Checkbox
          label={
            initial.id
              ? "Apply to existing transactions now"
              : "Also apply to existing transactions"
          }
          description="New imports always run your rules."
          checked={applyNow}
          onChange={setApplyNow}
        />
        {applyNow && (
          <Checkbox
            label="Include transactions I categorized by hand"
            description="Includes everything imported from Rocket Money with a category."
            checked={includeEdited}
            onChange={setIncludeEdited}
          />
        )}
      </div>

      {(save.error || apply.error) && <Alert>{(save.error ?? apply.error)?.message}</Alert>}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onDone}>
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={!valid || !name.trim() || save.isPending || apply.isPending}
        >
          {initial.id ? "Save rule" : "Create rule"}
        </Button>
      </div>
    </form>
  );
}

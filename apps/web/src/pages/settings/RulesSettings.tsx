import {
  AMOUNT_OP_LABELS,
  formatMoney,
  type Rule,
  type RuleAction,
  type RuleCondition,
  TEXT_OP_LABELS,
  toDecimalString,
} from "@muny/shared";
import { useState } from "react";
import { Checkbox, Modal } from "../../components/forms.js";
import { type RuleDraft, RuleEditor } from "../../components/RuleEditor.js";
import { Alert, Button, Card, cx } from "../../components/ui.js";
import {
  useAccounts,
  useApplyRule,
  useApplyTransfers,
  useCategories,
  useDeleteRule,
  useMoveRule,
  useRules,
  useToggleRule,
  useTransferPreview,
} from "../../lib/queries.js";

const NEW_RULE: RuleDraft = {
  match: "all",
  conditions: [{ field: "payee", op: "contains", value: "" }],
  actions: [{ type: "setCategory", categoryId: "" }],
};

function useDescribe() {
  const categories = useCategories();
  const accounts = useAccounts();
  const catName = (id: string) =>
    categories.data?.flatMap((g) => g.categories).find((c) => c.id === id)?.name ?? "?";
  const accName = (id: string) => accounts.data?.find((a) => a.id === id)?.name ?? "?";
  const cond = (c: RuleCondition) => {
    switch (c.field) {
      case "payee":
        return `merchant ${TEXT_OP_LABELS[c.op]} "${c.value}"`;
      case "description":
        return `description ${TEXT_OP_LABELS[c.op]} "${c.value}"`;
      case "amount":
        return `amount ${AMOUNT_OP_LABELS[c.op]} $${toDecimalString(c.value)}`;
      case "direction":
        return c.value === "out" ? "money out" : "money in";
      case "account":
        return `account is ${accName(c.value)}`;
    }
  };
  const act = (a: RuleAction) => {
    switch (a.type) {
      case "setCategory":
        return `category → ${catName(a.categoryId)}`;
      case "setPayee":
        return `merchant → "${a.name}"`;
      case "addTag":
        return `tag #${a.name}`;
      case "hide":
        return "hide";
    }
  };
  return (r: Rule) => ({
    when: r.conditions.map(cond).join(r.match === "all" ? " and " : " or "),
    actions: r.actions.map(act).join(", "),
  });
}

function TransfersCard() {
  const [show, setShow] = useState(false);
  const preview = useTransferPreview(show);
  const apply = useApplyTransfers();
  const p = preview.data;
  return (
    <Card className="space-y-3">
      <div>
        <h3 className="font-semibold">Transfers between your accounts</h3>
        <p className="text-sm text-slate-500">
          Money moving between your own accounts (to savings, credit card payments) is linked
          automatically on import and sync, so it isn't counted as spending or income. This finds
          ones in your existing history. Transactions you filed under a spending category yourself
          are left alone.
        </p>
      </div>
      {apply.data ? (
        <p className="text-sm">Linked {apply.data.paired.toLocaleString()} transfers.</p>
      ) : !show ? (
        <Button variant="secondary" onClick={() => setShow(true)}>
          Find transfers
        </Button>
      ) : !p ? (
        <p className="text-sm text-slate-500">Looking…</p>
      ) : p.pairs === 0 ? (
        <p className="text-sm">No new transfers found.</p>
      ) : (
        <>
          <p className="text-sm">
            Found <strong>{p.pairs.toLocaleString()}</strong> transfers. Most recent:
          </p>
          <ul className="max-h-60 divide-y divide-slate-100 overflow-auto rounded-lg border border-slate-200 text-xs dark:divide-slate-800 dark:border-slate-800">
            {p.sample.map((s) => (
              <li
                key={`${s.date}-${s.from}-${s.amountCents}-${s.description}`}
                className="flex justify-between gap-3 px-2 py-1"
              >
                <span className="truncate">
                  <span className="text-slate-500">{s.date}</span> {s.from} → {s.to}
                </span>
                <span className="tabular-nums">{formatMoney(s.amountCents)}</span>
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <Button disabled={apply.isPending} onClick={() => apply.mutate()}>
              Link them
            </Button>
            <Button variant="ghost" onClick={() => setShow(false)}>
              Cancel
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

export function RulesSettings() {
  const rules = useRules();
  const toggle = useToggleRule();
  const move = useMoveRule();
  const del = useDeleteRule();
  const run = useApplyRule();
  const describe = useDescribe();
  const [editing, setEditing] = useState<RuleDraft | null>(null);
  const [includeEdited, setIncludeEdited] = useState(false);
  const list = rules.data ?? [];

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Rules</h2>
          <p className="text-sm text-slate-500">
            Rules run on every import, top to bottom. For category and merchant name, the first
            matching rule wins. They never change transactions you edited by hand unless you ask.
          </p>
        </div>
        <Button onClick={() => setEditing(NEW_RULE)}>New rule</Button>
      </div>

      {rules.isError && <Alert>Couldn't load rules.</Alert>}
      {list.length === 0 && rules.isSuccess && (
        <Card className="text-sm text-slate-500">
          No rules yet. Create one here, or open a transaction and choose "Create rule".
        </Card>
      )}

      {list.length > 0 && (
        <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
          {list.map((r, i) => {
            const d = describe(r);
            return (
              <li key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <input
                  type="checkbox"
                  aria-label={`Enable ${r.name}`}
                  checked={r.enabled}
                  onChange={(e) => toggle.mutate({ id: r.id, enabled: e.target.checked })}
                  className="size-4 accent-brand-600"
                />
                <div className={cx("min-w-0 flex-1", !r.enabled && "opacity-50")}>
                  <p className="font-medium">{r.name}</p>
                  <p className="text-xs text-slate-500">
                    When {d.when} → {d.actions}
                  </p>
                </div>
                <div className="flex w-full items-center justify-end gap-1 text-sm sm:w-auto">
                  <button
                    type="button"
                    aria-label="Move up"
                    disabled={i === 0}
                    onClick={() => move.mutate({ id: r.id, direction: "up" })}
                    className="rounded px-2 py-1 hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-slate-800"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label="Move down"
                    disabled={i === list.length - 1}
                    onClick={() => move.mutate({ id: r.id, direction: "down" })}
                    className="rounded px-2 py-1 hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-slate-800"
                  >
                    ↓
                  </button>
                  <Button variant="ghost" onClick={() => setEditing(r)}>
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    className="text-red-600"
                    onClick={() => {
                      if (
                        window.confirm(
                          `Delete the rule "${r.name}"? Transactions keep their current values.`,
                        )
                      )
                        del.mutate(r.id);
                    }}
                  >
                    Delete
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {list.some((r) => r.enabled) && (
        <Card className="space-y-3">
          <p className="text-sm">Run all enabled rules on the transactions already in Muny.</p>
          <Checkbox
            label="Include transactions I categorized by hand"
            description="Includes everything imported from Rocket Money with a category."
            checked={includeEdited}
            onChange={setIncludeEdited}
          />
          <div className="flex items-center gap-3">
            <Button
              variant="secondary"
              disabled={run.isPending}
              onClick={() => run.mutate({ includeEdited })}
            >
              {run.isPending ? "Running…" : "Run all rules now"}
            </Button>
            {run.data && (
              <span className="text-sm text-slate-500">
                {run.data.changed.toLocaleString()} transaction{run.data.changed === 1 ? "" : "s"}{" "}
                changed
              </span>
            )}
          </div>
        </Card>
      )}

      <TransfersCard />

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing?.id ? "Edit rule" : "New rule"}
      >
        {editing && <RuleEditor initial={editing} onDone={() => setEditing(null)} />}
      </Modal>
    </section>
  );
}

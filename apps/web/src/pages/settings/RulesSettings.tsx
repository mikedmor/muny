import {
  AMOUNT_OP_LABELS,
  formatMoney,
  type Rule,
  type RuleAction,
  type RuleCombine,
  type RuleCondition,
  type RuleConflict,
  type RuleReview,
  TEXT_OP_LABELS,
  toDecimalString,
} from "@muny/shared";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Merge, Search, Sparkles, Trash2, TriangleAlert } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Checkbox, Modal } from "../../components/forms.js";
import { type RuleDraft, RuleEditor } from "../../components/RuleEditor.js";
import { Alert, Button, Card, cx } from "../../components/ui.js";
import { api } from "../../lib/api.js";
import {
  keys,
  useAccounts,
  useApplyRule,
  useApplyTransfers,
  useCategories,
  useCombineRules,
  useDeleteRule,
  useMoveRule,
  useRecurring,
  useRules,
  useToggleRule,
  useTransferPreview,
} from "../../lib/queries.js";

const NEW_RULE: RuleDraft = {
  match: "all",
  conditions: [{ field: "payee", op: "contains", value: "" }],
  actions: [{ type: "setCategory", categoryId: "" }],
};

/** Plain-words pieces of a rule: one per condition, one per action. */
function useDescribe() {
  const categories = useCategories();
  const accounts = useAccounts();
  const recurring = useRecurring();
  const seriesName = (id: string) =>
    recurring.data?.find((x) => x.id === id)?.name ?? "a removed recurring charge";
  const catName = (id: string) =>
    categories.data?.flatMap((g) => g.categories).find((c) => c.id === id)?.name ?? "?";
  const accName = (id: string) => accounts.data?.find((a) => a.id === id)?.name ?? "?";
  const cond = (c: RuleCondition) => {
    switch (c.field) {
      case "payee":
        return `merchant ${TEXT_OP_LABELS[c.op]} “${c.value}”`;
      case "description":
        return `description ${TEXT_OP_LABELS[c.op]} “${c.value}”`;
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
        return `category: ${catName(a.categoryId)}`;
      case "setPayee":
        return `rename to “${a.name}”`;
      case "addTag":
        return `tag #${a.name}`;
      case "hide":
        return "hide";
      case "setRecurring":
        return `recurring: ${seriesName(a.seriesId)}`;
    }
  };
  return (r: Pick<Rule, "match" | "conditions" | "actions">) => ({
    when: r.conditions.map(cond),
    joiner: r.match === "all" ? "and" : "or",
    does: r.actions.map(act),
  });
}

function Chips({ items, joiner }: { items: string[]; joiner?: string }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      {items.map((t, i) => (
        <span key={t} className="flex items-center gap-1">
          {i > 0 && joiner && <span className="text-[11px] text-slate-400">{joiner}</span>}
          <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-300">
            {t}
          </span>
        </span>
      ))}
    </span>
  );
}

function RuleSummary({ rule }: { rule: Pick<Rule, "match" | "conditions" | "actions"> }) {
  const d = useDescribe()(rule);
  return (
    <div className="mt-1 space-y-1">
      <div className="flex items-start gap-2">
        <span className="w-9 shrink-0 pt-0.5 text-[11px] font-medium uppercase tracking-wide text-slate-400">
          When
        </span>
        <Chips items={d.when} joiner={d.joiner} />
      </div>
      <div className="flex items-start gap-2">
        <span className="w-9 shrink-0 pt-0.5 text-[11px] font-medium uppercase tracking-wide text-slate-400">
          Then
        </span>
        <Chips items={d.does} />
      </div>
    </div>
  );
}

function Toggle({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cx(
        "relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600",
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

const iconButton =
  "rounded p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800 disabled:opacity-30 disabled:hover:bg-transparent dark:hover:bg-slate-800 dark:hover:text-slate-200";

type Filter = "all" | "category" | "recurring" | "automatic" | "off";

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

/** Rules that need a look: pairs that can be one rule, and rules that clash. */
function NeedsAttention({
  list,
  combine,
  conflicts,
  onEdit,
}: {
  list: Rule[];
  combine: RuleCombine[];
  conflicts: RuleConflict[];
  onEdit: (r: Rule) => void;
}) {
  const run = useCombineRules();
  const del = useDeleteRule();
  // A clash a Combine row already settles isn't listed twice.
  const settled = new Set(combine.flatMap((c) => [c.removeId, `${c.keepId}|${c.removeId}`]));
  const open = conflicts.filter(
    (c) =>
      !settled.has(c.firstId) &&
      !settled.has(c.secondId) &&
      !settled.has(`${c.firstId}|${c.secondId}`) &&
      !settled.has(`${c.secondId}|${c.firstId}`),
  );
  const byId = new Map(list.map((r) => [r.id, r]));
  const name = (id: string) => byId.get(id)?.name ?? "a rule";
  const total = combine.length + open.length;
  if (!total) return null;
  const quote = (s: string) => <span className="font-medium">“{s}”</span>;
  const rows: { key: string; text: ReactNode; preview?: ReactNode; fix: ReactNode }[] = [
    ...combine.map((c) => {
      const keep = byId.get(c.keepId);
      const src = byId.get(c.conditionsFrom);
      return {
        key: `c-${c.keepId}-${c.removeId}`,
        text: (
          <>
            {quote(name(c.keepId))} and {quote(name(c.removeId))} match the same{" "}
            {c.sharedCount.toLocaleString()} transaction{c.sharedCount === 1 ? "" : "s"} and do one
            job between them. Combined, {quote(name(c.keepId))} does both, and nothing is filed
            differently.
          </>
        ),
        preview:
          keep && src ? (
            <RuleSummary
              rule={{ match: src.match, conditions: src.conditions, actions: c.actions }}
            />
          ) : null,
        fix: (
          <Button
            variant="secondary"
            className="px-3 py-1.5"
            disabled={run.isPending}
            onClick={() => run.mutate({ keepId: c.keepId, removeId: c.removeId })}
          >
            <Merge className="size-4" aria-hidden="true" />
            Combine
          </Button>
        ),
      };
    }),
    ...open.map((c) => {
      const [first, second] = [byId.get(c.firstId), byId.get(c.secondId)];
      return {
        key: `x-${c.firstId}-${c.secondId}`,
        text: c.identical ? (
          <>
            {quote(name(c.firstId))} and {quote(name(c.secondId))} have the same conditions. Keep
            one: {quote(name(c.firstId))} runs first.
          </>
        ) : (
          <>
            {quote(name(c.firstId))} and {quote(name(c.secondId))} both match{" "}
            {c.sharedCount.toLocaleString()} transaction{c.sharedCount === 1 ? "" : "s"} but file
            them differently ({c.conflicts.join(", ")}). {quote(name(c.firstId))} wins because it's
            higher in the list.
          </>
        ),
        fix: (
          <span className="flex flex-wrap gap-1">
            {c.identical && second ? (
              <Button
                variant="secondary"
                className="px-3 py-1.5"
                disabled={del.isPending}
                onClick={() => del.mutate(second.id)}
              >
                <Trash2 className="size-4" aria-hidden="true" />
                Delete the lower one
              </Button>
            ) : (
              <>
                {first && (
                  <Button variant="ghost" className="px-3 py-1.5" onClick={() => onEdit(first)}>
                    Edit the higher one
                  </Button>
                )}
                {second && (
                  <Button variant="ghost" className="px-3 py-1.5" onClick={() => onEdit(second)}>
                    Edit the lower one
                  </Button>
                )}
              </>
            )}
          </span>
        ),
      };
    }),
  ];
  return (
    <section
      aria-labelledby="rules-attention"
      className="rounded-xl border border-amber-200 bg-amber-50/60 dark:border-amber-900/50 dark:bg-amber-950/20"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 pt-3">
        <h3
          id="rules-attention"
          className="flex items-center gap-2 text-sm font-semibold text-amber-900 dark:text-amber-200"
        >
          <TriangleAlert className="size-4" aria-hidden="true" />
          {total === 1 ? "1 thing to tidy up" : `${total} things to tidy up`}
        </h3>
        {combine.length > 1 && (
          <Button
            className="px-3 py-1.5"
            disabled={run.isPending}
            onClick={() => run.mutate({ all: true })}
          >
            {run.isPending ? "Combining…" : `Combine all ${combine.length}`}
          </Button>
        )}
      </div>
      <ul className="divide-y divide-amber-200/70 dark:divide-amber-900/40">
        {rows.map((r) => (
          <li key={r.key} className="flex flex-wrap items-start gap-3 px-4 py-3 text-sm">
            <div className="min-w-0 flex-1 text-slate-700 dark:text-slate-300">
              <p>{r.text}</p>
              {r.preview}
            </div>
            {r.fix}
          </li>
        ))}
      </ul>
      {run.isError && (
        <p className="px-4 pb-3 text-sm text-red-600">
          Couldn't combine them. The rules may have changed; the list is up to date now.
        </p>
      )}
    </section>
  );
}

export function RulesSettings() {
  const rules = useRules();
  const toggle = useToggleRule();
  const move = useMoveRule();
  const del = useDeleteRule();
  const run = useApplyRule();
  const [editing, setEditing] = useState<RuleDraft | null>(null);
  const [includeEdited, setIncludeEdited] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const describe = useDescribe();
  const list = rules.data ?? [];
  const review = useQuery({
    queryKey: [...keys.rules, "review"],
    queryFn: () => api.get<RuleReview>("/api/rules/review"),
    enabled: list.length > 0,
  });
  const automatic = new Set(review.data?.automaticIds ?? []);
  const conflicts = review.data?.conflicts ?? [];
  const nameOf = new Map(list.map((r) => [r.id, r.name]));
  const issuesFor = (id: string) =>
    conflicts
      .filter((c) => c.firstId === id || c.secondId === id)
      .map((c) => {
        const other = nameOf.get(c.firstId === id ? c.secondId : c.firstId) ?? "another rule";
        return c.identical ? `Same conditions as “${other}”` : `Clashes with “${other}”`;
      });

  const places = (r: Rule) => r.actions.some((a) => a.type === "setRecurring");
  const files = (r: Rule) => r.actions.some((a) => a.type !== "setRecurring");
  const filters: { id: Filter; label: string; test: (r: Rule) => boolean }[] = [
    { id: "all", label: "All", test: () => true },
    { id: "category", label: "Filing", test: files },
    { id: "recurring", label: "Recurring", test: places },
    { id: "automatic", label: "Made by Muny", test: (r) => automatic.has(r.id) },
    { id: "off", label: "Off", test: (r) => !r.enabled },
  ];
  const q = query.trim().toLowerCase();
  const active = filters.find((f) => f.id === filter) ?? filters[0];
  const shown = list.filter((r) => {
    if (!active?.test(r)) return false;
    if (!q) return true;
    const d = describe(r);
    return [r.name, ...d.when, ...d.does].some((t) => t.toLowerCase().includes(q));
  });
  // Order only means something in the whole list.
  const canMove = filter === "all" && !q;

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="max-w-2xl">
          <h2 className="text-lg font-semibold">Rules</h2>
          <p className="text-sm text-slate-500">
            Rules file transactions as they arrive: category, merchant name, tags, and which
            recurring charge they belong to. They run top to bottom, and for category and name the
            first match wins. Transactions you edited by hand keep your changes.
          </p>
        </div>
        <Button onClick={() => setEditing(NEW_RULE)}>New rule</Button>
      </div>

      {rules.isError && <Alert>Couldn't load rules.</Alert>}
      {review.data && (
        <NeedsAttention
          list={list}
          combine={review.data.combine}
          conflicts={conflicts}
          onEdit={setEditing}
        />
      )}

      {list.length === 0 && rules.isSuccess && (
        <Card className="text-sm text-slate-500">
          No rules yet. Create one here, or open a transaction and choose "Create rule".
        </Card>
      )}

      {list.length > 0 && (
        <Card className="p-0">
          <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
            <label className="relative min-w-48 flex-1">
              <span className="sr-only">Search rules</span>
              <Search
                className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-slate-400"
                aria-hidden="true"
              />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by name, merchant, category…"
                className="w-full rounded-lg border border-slate-300 bg-surface py-1.5 pr-3 pl-8 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/30 dark:border-slate-700 dark:bg-slate-950"
              />
            </label>
            <div role="tablist" aria-label="Show" className="flex flex-wrap gap-1">
              {filters.map((f) => {
                const n = list.filter(f.test).length;
                if (f.id !== "all" && n === 0) return null;
                return (
                  <button
                    key={f.id}
                    type="button"
                    role="tab"
                    aria-selected={filter === f.id}
                    onClick={() => setFilter(f.id)}
                    className={cx(
                      "rounded-full px-3 py-1 text-xs font-medium",
                      filter === f.id
                        ? "bg-brand-600 text-on-brand"
                        : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700",
                    )}
                  >
                    {f.label} <span className="tabular-nums opacity-70">{n}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {shown.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-slate-500">No rules match.</p>
          ) : (
            <ul className="divide-y divide-slate-200 dark:divide-slate-800">
              {shown.map((r) => {
                const i = list.indexOf(r);
                const count = review.data?.counts[r.id];
                return (
                  <li key={r.id} className="flex items-start gap-3 px-4 py-3">
                    <Toggle
                      checked={r.enabled}
                      label={`${r.enabled ? "Turn off" : "Turn on"} ${r.name}`}
                      onChange={(enabled) => toggle.mutate({ id: r.id, enabled })}
                    />
                    <div className={cx("min-w-0 flex-1", !r.enabled && "opacity-50")}>
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <button
                          type="button"
                          onClick={() => setEditing(r)}
                          className="text-left font-medium hover:text-brand-600 hover:underline dark:hover:text-brand-500"
                        >
                          {r.name}
                        </button>
                        {automatic.has(r.id) && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-medium text-brand-700 dark:bg-brand-950/40 dark:text-brand-300">
                            <Sparkles className="size-3" aria-hidden="true" />
                            Made by Muny
                          </span>
                        )}
                        {count !== undefined && (
                          <span className="text-xs text-slate-500 tabular-nums">
                            {count === 0
                              ? "matches nothing yet"
                              : `${count.toLocaleString()} transaction${count === 1 ? "" : "s"}`}
                          </span>
                        )}
                      </div>
                      <RuleSummary rule={r} />
                      {issuesFor(r.id).map((text) => (
                        <p
                          key={text}
                          className="mt-1 flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400"
                        >
                          <TriangleAlert className="size-3" aria-hidden="true" />
                          {text}
                        </p>
                      ))}
                    </div>
                    <div className="flex shrink-0 items-center">
                      {canMove && (
                        <>
                          <button
                            type="button"
                            aria-label={`Move ${r.name} up`}
                            disabled={i === 0 || move.isPending}
                            onClick={() => move.mutate({ id: r.id, direction: "up" })}
                            className={iconButton}
                          >
                            <ArrowUp className="size-4" aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            aria-label={`Move ${r.name} down`}
                            disabled={i === list.length - 1 || move.isPending}
                            onClick={() => move.mutate({ id: r.id, direction: "down" })}
                            className={iconButton}
                          >
                            <ArrowDown className="size-4" aria-hidden="true" />
                          </button>
                        </>
                      )}
                      <button
                        type="button"
                        aria-label={`Delete ${r.name}`}
                        className={cx(iconButton, "hover:text-red-600 dark:hover:text-red-400")}
                        onClick={() => {
                          if (
                            window.confirm(
                              `Delete the rule “${r.name}”? Transactions keep their current values.`,
                            )
                          )
                            del.mutate(r.id);
                        }}
                      >
                        <Trash2 className="size-4" aria-hidden="true" />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      )}

      {list.some((r) => r.enabled) && (
        <Card className="space-y-3">
          <div>
            <h3 className="font-semibold">Run rules on past transactions</h3>
            <p className="text-sm text-slate-500">
              New rules apply to what arrives from now on. This applies all rules that are on to the
              transactions already in Muny.
            </p>
          </div>
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

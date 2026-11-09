import { type MunyDb, newId, schema } from "@muny/db";
import {
  type AgentProposal,
  type AgentScope,
  DIY_STATUSES,
  formatMoney,
  type ProposalChange,
  type ProposalDecision,
  type ProposalList,
  RECURRING_STATUSES,
  type RuleAction,
  SAVING_KINDS,
} from "@muny/shared";
import { and, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/plugin.js";
import { budgetMonth, setBudget } from "../budgets/service.js";
import { bulkUpdateTransactions, loadTransactions } from "../ledger/transactions.js";
import { audit } from "../lib/audit.js";
import { badRequest, HttpError, parse } from "../lib/http.js";
import { listSeries, rescanRecurring, setSeriesStatus } from "../recurring/service.js";
import { categoryMeta } from "../reports/spending.js";
import {
  applyPlans,
  ConditionSchema,
  createRule,
  evaluateRules,
  previewOf,
  validateReferences,
} from "../rules/service.js";
import { createDiy } from "../savings/routes.js";
import { createSaving, listSavings, verifySavings } from "../savings/service.js";
import { describeChange } from "../undo/track.js";
import { defineTool, dryRunField, type Tool, ToolError } from "./registry.js";

/**
 * Changes to financial data from an assistant never apply directly. A tool works
 * out exactly what would change and files it here; a person approves it in the
 * inbox. Approval runs the same preview again against today's data, and refuses if
 * what would change is no longer what was shown. The summaries and changes people
 * read are written by this code from the data, never by the assistant: only its
 * optional reason is its own words, and that's labelled as such.
 */

const EXPIRES_MS = 30 * 86_400_000;
const MAX_PENDING_PER_TOKEN = 200;
const MAX_IDS = 500;

interface Preview {
  summary: string;
  changes: ProposalChange[];
  warnings?: string[];
}

interface ProposalKind<S extends z.ZodObject = z.ZodObject> {
  tool: string;
  scope: AgentScope;
  description: string;
  input: S;
  /** The preview must still match on approval. Off where it only samples what's there. */
  strict: boolean;
  /** Filled in when it's proposed, so approving later means the same thing. */
  prepare?: (input: z.infer<S>, today: string) => z.infer<S>;
  preview: (db: MunyDb, input: z.infer<S>, today: string) => Preview;
  apply: (db: MunyDb, input: z.infer<S>, today: string) => unknown;
}

const kind = <S extends z.ZodObject>(k: ProposalKind<S>) => k as unknown as ProposalKind;

/** A category by name, "Group / Name" or id, with a message an assistant can act on. */
function resolveCategory(db: MunyDb, ref: string) {
  const cats = [...categoryMeta(db).values()];
  const byId = cats.find((c) => c.id === ref);
  if (byId) return byId;
  const key = ref.trim().toLowerCase();
  const hits = cats.filter(
    (c) => c.name.toLowerCase() === key || `${c.groupName} / ${c.name}`.toLowerCase() === key,
  );
  const only = hits[0];
  if (!only) throw new ToolError("invalid", `There's no category called "${ref}".`);
  if (hits.length > 1)
    throw new ToolError(
      "invalid",
      `More than one category is called "${ref}": ${hits
        .map((c) => `${c.groupName} / ${c.name}`)
        .join(", ")}.`,
    );
  return only;
}

function loadAll(db: MunyDb, ids: string[]) {
  const unique = [...new Set(ids)];
  const rows = loadTransactions(db, unique);
  if (rows.length !== unique.length)
    throw new ToolError(
      "invalid",
      `${unique.length - rows.length} of those transactions don't exist. Ids come from search_transactions.`,
    );
  return rows;
}

const txnLabel = (t: { postedDate: string; description: string; amountCents: number }) =>
  `${t.postedDate} · ${t.description} · ${formatMoney(t.amountCents)}`;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const ids = z.array(z.string().min(1).max(64)).min(1).max(MAX_IDS);

const KINDS: ProposalKind[] = [
  kind({
    tool: "categorize_transactions",
    scope: "write:annotations",
    description:
      'Propose moving transactions to a category. transaction_ids come from search_transactions. Category by name, or "Group / Name" if two share a name.',
    strict: true,
    input: z.object({ transaction_ids: ids, category: z.string().min(1).max(120) }),
    preview: (db, { transaction_ids, category }) => {
      const cat = resolveCategory(db, category);
      const rows = loadAll(db, transaction_ids);
      const moved = rows.filter((t) => t.categoryId !== cat.id || t.splits.length > 0);
      const splits = moved.filter((t) => t.splits.length > 0).length;
      return {
        summary: `Put ${plural(moved.length, "transaction")} in ${cat.name}`,
        changes: moved.map((t) => ({
          label: txnLabel(t),
          from: t.splits.length ? "Split" : (t.categoryName ?? "Uncategorized"),
          to: cat.name,
        })),
        ...(splits
          ? { warnings: [`This replaces the split on ${plural(splits, "transaction")}.`] }
          : {}),
      };
    },
    apply: (db, { transaction_ids, category }) => {
      const cat = resolveCategory(db, category);
      return bulkUpdateTransactions(db, transaction_ids, { categoryId: cat.id });
    },
  }),
  kind({
    tool: "tag_transactions",
    scope: "write:annotations",
    description: "Propose adding a tag to transactions.",
    strict: true,
    input: z.object({ transaction_ids: ids, tag: z.string().trim().min(1).max(40) }),
    preview: (db, { transaction_ids, tag }) => {
      const rows = loadAll(db, transaction_ids);
      const tagged = new Set(
        db
          .select({ id: schema.transactionTags.transactionId, name: schema.tags.name })
          .from(schema.transactionTags)
          .innerJoin(schema.tags, eq(schema.tags.id, schema.transactionTags.tagId))
          .where(inArray(schema.transactionTags.transactionId, transaction_ids))
          .all()
          .filter((r) => r.name.toLowerCase() === tag.toLowerCase())
          .map((r) => r.id),
      );
      const add = rows.filter((t) => !tagged.has(t.id));
      return {
        summary: `Tag ${plural(add.length, "transaction")} "${tag}"`,
        changes: add.map((t) => ({ label: txnLabel(t), to: tag })),
      };
    },
    apply: (db, { transaction_ids, tag }) =>
      bulkUpdateTransactions(db, transaction_ids, { addTag: tag }),
  }),
  kind({
    tool: "add_transaction_note",
    scope: "write:annotations",
    description: "Propose setting the note on one transaction, replacing any note it has.",
    strict: true,
    input: z.object({
      transaction_id: z.string().min(1).max(64),
      note: z.string().trim().max(1000),
    }),
    preview: (db, { transaction_id, note }) => {
      const [t] = loadAll(db, [transaction_id]);
      if (!t) throw new ToolError("not_found", "There's no such transaction.");
      return {
        summary: `Add a note to ${t.description}`,
        changes: t.notes === note ? [] : [{ label: txnLabel(t), from: t.notes, to: note }],
      };
    },
    apply: (db, { transaction_id, note }) => {
      db.update(schema.transactions)
        .set({ notes: note || null })
        .where(eq(schema.transactions.id, transaction_id))
        .run();
      return { updated: 1 };
    },
  }),
  kind({
    tool: "confirm_subscription",
    scope: "write:annotations",
    description:
      "Propose confirming a detected recurring charge, ignoring it (it isn't recurring, and its charges go back to being ordinary), or marking it cancelled. series_id comes from list_subscriptions.",
    strict: true,
    input: z.object({
      series_id: z.string().min(1).max(64),
      status: z.enum(RECURRING_STATUSES).exclude(["detected"]),
    }),
    preview: (db, { series_id, status }, today) => {
      const s = listSeries(db, today, series_id)[0];
      if (!s) throw new ToolError("not_found", "There's no such recurring charge.");
      const verb = { confirmed: "Confirm", ignored: "Ignore", cancelled: "Mark as cancelled:" }[
        status
      ];
      return {
        summary: `${verb} ${s.name}`,
        changes:
          s.status === status
            ? []
            : [
                {
                  label: `${s.name} · ${formatMoney(Math.abs(s.monthlyCents))} a month`,
                  from: s.status,
                  to: status,
                },
              ],
      };
    },
    apply: (db, { series_id, status }) => {
      setSeriesStatus(db, series_id, status);
      return { status };
    },
  }),
  kind({
    tool: "create_rule",
    scope: "write:rules",
    description:
      "Propose a rule for transactions: when they match the conditions, do the actions. Conditions: { field: description | payee, op: contains | equals | startsWith | endsWith, value }, { field: amount, op: eq | gte | lte, value: cents }, { field: direction, value: out | in }, { field: account, value: account name }. Actions: { type: setCategory, category }, { type: setPayee, name }, { type: addTag, name }, { type: hide }. apply_to_existing also changes matching transactions you already have; hand-edited ones are skipped.",
    strict: false,
    input: z.object({
      name: z.string().trim().min(1).max(100),
      match: z.enum(["all", "any"]).default("all"),
      conditions: z.array(z.looseObject({})).min(1).max(20),
      actions: z
        .array(
          z.discriminatedUnion("type", [
            z.object({ type: z.literal("setCategory"), category: z.string().min(1).max(120) }),
            z.object({ type: z.literal("setPayee"), name: z.string().trim().min(1).max(100) }),
            z.object({ type: z.literal("addTag"), name: z.string().trim().min(1).max(40) }),
            z.object({ type: z.literal("hide") }),
          ]),
        )
        .min(1)
        .max(10),
      apply_to_existing: z.boolean().default(false),
    }),
    preview: (db, input) => {
      const def = ruleDefinition(db, input);
      const p = previewOf(evaluateRules(db, [def]), 25);
      const doing = input.actions
        .map((a) =>
          a.type === "setCategory"
            ? `category: ${resolveCategory(db, a.category).name}`
            : a.type === "setPayee"
              ? `merchant: ${a.name}`
              : a.type === "addTag"
                ? `tag: ${a.name}`
                : "hidden",
        )
        .join(", ");
      return {
        summary: `New rule "${input.name}" (${doing}). Matches ${plural(p.matched, "transaction")} today${
          input.apply_to_existing
            ? `, and would change ${p.wouldChange} of them now`
            : "; existing ones stay as they are"
        }`,
        // Without apply_to_existing these only show what it matches: they won't change.
        changes: p.sample.map((s) => ({
          label: `${s.postedDate} · ${s.description} · ${formatMoney(s.amountCents)}`,
          ...(input.apply_to_existing
            ? { from: s.categoryName ?? "Uncategorized", to: doing }
            : {}),
        })),
        warnings: input.actions.some((a) => a.type === "hide")
          ? ["Hidden transactions are left out of budgets and reports."]
          : [],
      };
    },
    apply: (db, input) => {
      const def = ruleDefinition(db, input);
      const rule = createRule(db, { ...def, name: input.name });
      if (!input.apply_to_existing) return { ruleId: rule.id, changed: 0 };
      const changed = db.transaction((tx) => {
        const n = applyPlans(tx, evaluateRules(tx, [rule], {}).plans);
        if (n) rescanRecurring(tx);
        return n;
      });
      return { ruleId: rule.id, changed };
    },
  }),
  kind({
    tool: "set_budget",
    scope: "write:setup",
    description:
      "Propose a monthly budget, from this month on. A category's budget, or with no category the overall total. amount_cents is integer cents.",
    strict: true,
    input: z.object({
      category: z.string().min(1).max(120).optional(),
      amount_cents: z.number().int().min(0).max(100_000_000_000),
      from_month: z
        .string()
        .regex(/^\d{4}-\d{2}$/)
        .optional(),
    }),
    prepare: (input, today) => ({ ...input, from_month: input.from_month ?? today.slice(0, 7) }),
    preview: (db, { category, amount_cents, from_month }, today) => {
      const month = from_month ?? today.slice(0, 7);
      const b = budgetMonth(db, month);
      const cat = category ? resolveCategory(db, category) : null;
      if (cat && cat.kind !== "expense")
        throw new ToolError("invalid", "Budgets are for spending categories.");
      const line = cat
        ? b.groups.flatMap((g) => g.lines).find((l) => l.categoryId === cat.id)
        : b.total;
      const current = line?.budgetCents ?? null;
      const name = cat?.name ?? "Total spending";
      return {
        summary: `Budget ${formatMoney(amount_cents)} a month for ${name}, from ${month}`,
        changes:
          current === amount_cents
            ? []
            : [
                {
                  label: name,
                  from: current === null ? "No budget" : formatMoney(current),
                  to: formatMoney(amount_cents),
                },
              ],
      };
    },
    apply: (db, { category, amount_cents, from_month }, today) => {
      const cat = category ? resolveCategory(db, category) : null;
      const id = db.transaction((tx) =>
        setBudget(tx, {
          categoryId: cat?.id ?? null,
          amountCents: amount_cents,
          fromMonth: from_month ?? today.slice(0, 7),
        }),
      );
      return { budgetId: id };
    },
  }),
  kind({
    tool: "propose_savings_action",
    scope: "write:plans",
    description:
      "Propose recording a saving: a subscription cancelled, downgraded, negotiated or replaced. With series_id (from list_subscriptions) the cost comes from it; otherwise give name and before_monthly_cents. Records what you did or plan; it can't cancel anything for real. mark_series_cancelled also marks the recurring charge cancelled in Muny.",
    strict: false,
    input: z.object({
      kind: z.enum(SAVING_KINDS),
      series_id: z.string().min(1).max(64).optional(),
      name: z.string().trim().max(100).optional(),
      before_monthly_cents: z.number().int().min(0).optional(),
      after_monthly_cents: z.number().int().min(0).optional(),
      effective_date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      notes: z.string().trim().max(1000).optional(),
      mark_series_cancelled: z.boolean().default(false),
    }),
    preview: (db, input, today) => {
      const series = input.series_id ? listSeries(db, today, input.series_id)[0] : undefined;
      if (input.series_id && !series)
        throw new ToolError("not_found", "There's no such recurring charge.");
      if (!series && (!input.name || input.before_monthly_cents === undefined))
        throw new ToolError("invalid", "Give a series_id, or a name and before_monthly_cents.");
      const before = input.before_monthly_cents ?? Math.abs(series?.monthlyCents ?? 0);
      const after =
        input.after_monthly_cents ??
        (input.kind === "cancelled" || input.kind === "replaced" ? 0 : before);
      const name = input.name ?? series?.name ?? "";
      return {
        summary: `Record a saving: ${name} ${input.kind}, saving ${formatMoney(before - after)} a month`,
        changes: [
          {
            label: name,
            from: `${formatMoney(before)} a month`,
            to: `${formatMoney(after)} a month`,
          },
          ...(series && input.mark_series_cancelled && series.status !== "cancelled"
            ? [{ label: `${series.name} in Recurring`, from: series.status, to: "cancelled" }]
            : []),
        ],
      };
    },
    apply: (db, input, today) => {
      const id = createSaving(
        db,
        {
          kind: input.kind,
          ...(input.series_id ? { seriesId: input.series_id } : {}),
          ...(input.name ? { name: input.name } : {}),
          ...(input.before_monthly_cents !== undefined
            ? { beforeMonthlyCents: input.before_monthly_cents }
            : {}),
          ...(input.after_monthly_cents !== undefined
            ? { afterMonthlyCents: input.after_monthly_cents }
            : {}),
          ...(input.effective_date ? { effectiveDate: input.effective_date } : {}),
          ...(input.notes ? { notes: input.notes } : {}),
          cancelSeries: input.mark_series_cancelled,
        },
        today,
      );
      verifySavings(db, today);
      return { saving: listSavings(db, today).find((s) => s.id === id)?.name };
    },
  }),
  kind({
    tool: "create_replacement_plan",
    scope: "write:plans",
    description:
      "Propose a plan to replace a paid service with a self-hosted or DIY alternative. find_alternatives suggests some.",
    strict: false,
    input: z.object({
      service_name: z.string().trim().min(1).max(100),
      alternative: z.string().trim().min(1).max(100),
      series_id: z.string().min(1).max(64).optional(),
      status: z.enum(DIY_STATUSES).exclude(["cancelled"]).default("idea"),
      effort: z.enum(["low", "medium", "high"]).optional(),
      running_monthly_cents: z.number().int().min(0).optional(),
      notes: z.string().trim().max(1000).optional(),
    }),
    preview: (db, input, today) => {
      if (input.series_id && !listSeries(db, today, input.series_id)[0])
        throw new ToolError("not_found", "There's no such recurring charge.");
      return {
        summary: `Plan to replace ${input.service_name} with ${input.alternative}`,
        changes: [{ label: input.service_name, to: input.alternative }],
      };
    },
    apply: (db, input) => ({
      id: createDiy(db, {
        serviceName: input.service_name,
        alternative: input.alternative,
        ...(input.series_id ? { seriesId: input.series_id } : {}),
        status: input.status,
        ...(input.effort ? { effort: input.effort } : {}),
        ...(input.running_monthly_cents !== undefined
          ? { runningMonthlyCents: input.running_monthly_cents }
          : {}),
        ...(input.notes ? { notes: input.notes } : {}),
      }),
    }),
  }),
];

const KIND_BY_TOOL = new Map(KINDS.map((k) => [k.tool, k]));

/** A rule from what an assistant wrote: names where the app stores ids. */
function ruleDefinition(
  db: MunyDb,
  input: {
    match: "all" | "any";
    conditions: Record<string, unknown>[];
    actions: (
      | { type: "setCategory"; category: string }
      | { type: "setPayee"; name: string }
      | { type: "addTag"; name: string }
      | { type: "hide" }
    )[];
  },
) {
  const accounts = db
    .select({ id: schema.accounts.id, name: schema.accounts.name })
    .from(schema.accounts)
    .all();
  const conditions = input.conditions.map((raw) => {
    if (raw.field !== "account") return ConditionSchema.parse(raw);
    const hit = accounts.find(
      (a) => a.id === raw.value || a.name.toLowerCase() === String(raw.value).toLowerCase(),
    );
    if (!hit) throw new ToolError("invalid", `There's no account called "${String(raw.value)}".`);
    return ConditionSchema.parse({ field: "account", value: hit.id });
  });
  const actions: RuleAction[] = input.actions.map((a) =>
    a.type === "setCategory"
      ? { type: "setCategory", categoryId: resolveCategory(db, a.category).id }
      : a,
  );
  const def = { match: input.match, conditions, actions };
  validateReferences(db, def);
  return def;
}

const p = schema.agentProposals;

function toApi(r: typeof p.$inferSelect): AgentProposal {
  return {
    id: r.id,
    tool: r.tool,
    tokenName: r.tokenName,
    status: r.status,
    summary: r.summary,
    reason: r.reason,
    changes: r.changes as ProposalChange[],
    warnings: r.warnings as string[],
    createdAt: r.createdAt.getTime(),
    decidedAt: r.decidedAt?.getTime() ?? null,
    result: r.result,
  };
}

function expireOld(db: MunyDb, now = Date.now()) {
  db.update(p)
    .set({ status: "expired", decidedAt: new Date(now) })
    .where(and(eq(p.status, "pending"), lt(p.createdAt, new Date(now - EXPIRES_MS))))
    .run();
}

/** One heads-up an hour per token at most, and it says nothing about your money. */
function notifyOwner(db: MunyDb, tokenId: string, tokenName: string) {
  const rule = db
    .select({ enabled: schema.alertRules.enabled })
    .from(schema.alertRules)
    .where(eq(schema.alertRules.type, "agent_proposal"))
    .get();
  if (rule && !rule.enabled) return;
  db.insert(schema.notifications)
    .values({
      id: newId(),
      ruleType: "agent_proposal",
      dedupeKey: `agent_proposal:${tokenId}:${new Date().toISOString().slice(0, 13)}`,
      severity: "info",
      title: "An assistant has changes for you to approve",
      body: `${tokenName} suggested changes. They won't happen unless you approve them.`,
      link: "/alerts#inbox",
    })
    .onConflictDoNothing({ target: schema.notifications.dedupeKey })
    .run();
}

/** Who's asking: an API token, or Muny's own built-in AI (no token). */
interface Source {
  tokenId: string | null;
  tokenName: string;
}

/** The name Muny's built-in AI files suggestions under. */
export const MUNY_AI = "Muny AI";

function file(
  db: MunyDb,
  source: Source,
  k: ProposalKind,
  input: Record<string, unknown>,
  preview: Preview,
  reason: string | undefined,
) {
  expireOld(db);
  const waiting = db
    .select()
    .from(p)
    .where(
      and(
        // No token means Muny's own AI, or a token since removed: the name tells them apart.
        source.tokenId
          ? eq(p.tokenId, source.tokenId)
          : and(isNull(p.tokenId), eq(p.tokenName, source.tokenName)),
        eq(p.status, "pending"),
      ),
    )
    .all();
  // An assistant retrying shouldn't fill the inbox with copies.
  const same = waiting.find(
    (w) => w.tool === k.tool && JSON.stringify(w.input) === JSON.stringify(input),
  );
  if (same) return same;
  if (waiting.length >= MAX_PENDING_PER_TOKEN)
    throw new ToolError(
      "conflict",
      `${source.tokenName} has ${MAX_PENDING_PER_TOKEN} changes waiting already. Go through the inbox first.`,
    );
  const row = db
    .insert(p)
    .values({
      id: newId(),
      tokenId: source.tokenId,
      tokenName: source.tokenName,
      tool: k.tool,
      input,
      summary: preview.summary.slice(0, 300),
      reason: reason ?? null,
      changes: preview.changes,
      warnings: preview.warnings ?? [],
    })
    .returning()
    .get();
  notifyOwner(db, source.tokenId ?? "muny-ai", row.tokenName);
  return row;
}

/**
 * File a suggestion from Muny itself (the optional built-in AI): the same
 * preview, checks and inbox as an assistant's, under the name "Muny AI".
 */
export function fileFromMuny(
  db: MunyDb,
  today: string,
  tool: string,
  input: Record<string, unknown>,
  reason: string,
): { filed: boolean; summary: string } {
  const k = KINDS.find((x) => x.tool === tool);
  if (!k) throw new Error(`Unknown proposal ${tool}`);
  const parsed = (k.input as z.ZodType).parse(input) as Record<string, unknown>;
  const prepared = k.prepare ? k.prepare(parsed as never, today) : parsed;
  const preview = k.preview(db, prepared as never, today);
  if (k.strict && preview.changes.length === 0) return { filed: false, summary: preview.summary };
  file(
    db,
    { tokenId: null, tokenName: MUNY_AI },
    k,
    prepared as Record<string, unknown>,
    preview,
    reason,
  );
  return { filed: true, summary: preview.summary };
}

/** The tools that file proposals. None of them change anything on their own. */
export const PROPOSAL_TOOLS: Tool[] = KINDS.map((k) =>
  defineTool({
    name: k.tool,
    description: `${k.description} Nothing changes until a person approves it in Muny's inbox. dry_run (the default) shows what would change; dry_run: false files it for approval. list_proposals shows what happened.`,
    scope: k.scope,
    write: true,
    input: (k.input as z.ZodObject).extend({
      reason: z
        .string()
        .trim()
        .max(500)
        .optional()
        .describe("Why you're suggesting it. Shown to the person, as your words."),
      dry_run: dryRunField,
    }),
    run: (ctx, raw) => {
      const { dry_run, reason, ...rest } = raw as Record<string, unknown> & {
        dry_run: boolean;
        reason?: string;
      };
      const input = k.prepare ? k.prepare(rest as never, ctx.today) : rest;
      const preview = k.preview(ctx.db, input as never, ctx.today);
      if (dry_run)
        return { dryRun: true, ...preview, note: "Pass dry_run: false to send this for approval." };
      // A rule or plan is new whatever it touches today; only these can already be so.
      if (k.strict && preview.changes.length === 0)
        return {
          filed: false,
          ...preview,
          note: "It's already that way, so there's nothing to approve.",
        };
      const token = ctx.db
        .select({ name: schema.apiTokens.name })
        .from(schema.apiTokens)
        .where(eq(schema.apiTokens.id, ctx.agent.tokenId))
        .get();
      const row = file(
        ctx.db,
        { tokenId: ctx.agent.tokenId, tokenName: token?.name ?? "An assistant" },
        k,
        input as Record<string, unknown>,
        preview,
        reason,
      );
      return {
        filed: true,
        id: row.id,
        status: row.status,
        ...preview,
        note: "Waiting in Muny's inbox. It won't happen unless the person approves it.",
      };
    },
  }),
);

export const listProposalsTool = defineTool({
  name: "list_proposals",
  description:
    "What this token has suggested and what became of it: pending, approved, rejected, expired or failed, and why.",
  scope: null,
  input: z.object({}),
  run: (ctx) => {
    expireOld(ctx.db);
    return ctx.db
      .select()
      .from(p)
      .where(eq(p.tokenId, ctx.agent.tokenId))
      .orderBy(desc(p.createdAt))
      .limit(50)
      .all()
      .map((r) => {
        const { changes: _c, warnings: _w, ...rest } = toApi(r);
        return rest;
      });
  },
});

function reject(db: MunyDb, row: typeof p.$inferSelect, userId: string) {
  return db
    .update(p)
    .set({ status: "rejected", decidedBy: userId, decidedAt: new Date() })
    .where(and(eq(p.id, row.id), eq(p.status, "pending")))
    .returning()
    .get();
}

/** Approve: check it still means what was shown, then run it. */
function approve(db: MunyDb, row: typeof p.$inferSelect, userId: string, today: string) {
  const k = KIND_BY_TOOL.get(row.tool);
  const finish = (status: "approved" | "failed", result: string) =>
    db
      .update(p)
      .set({ status, result, decidedBy: userId, decidedAt: new Date() })
      .where(and(eq(p.id, row.id), eq(p.status, "pending")))
      .returning()
      .get();
  if (!k) return finish("failed", "Muny doesn't know how to do this any more.");
  try {
    const input = k.input.parse(row.input);
    if (k.strict) {
      const now = k.preview(db, input as never, today);
      if (JSON.stringify(now.changes) !== JSON.stringify(row.changes))
        return finish(
          "failed",
          "Things changed since this was suggested, so it wasn't applied. Nothing was changed. Ask the assistant to suggest it again.",
        );
    }
    const out = k.apply(db, input as never, today);
    return finish("approved", `Applied. ${JSON.stringify(out)}`);
  } catch (e) {
    const message =
      e instanceof ToolError || e instanceof HttpError
        ? e.message
        : "It couldn't be applied, and nothing was changed.";
    return finish("failed", message);
  }
}

const DecideBody = z
  .object({
    ids: z.array(z.string().min(1).max(64)).min(1).max(500),
    decision: z.enum(["approve", "reject"]),
  })
  .strict();

export function registerProposalRoutes(app: FastifyInstance, db: MunyDb, today: () => string) {
  app.get("/api/proposals", async (req): Promise<ProposalList> => {
    requireUser(req);
    expireOld(db);
    const all = db.select().from(p).orderBy(desc(p.createdAt)).limit(300).all().map(toApi);
    return {
      pending: all.filter((x) => x.status === "pending"),
      recent: all.filter((x) => x.status !== "pending").slice(0, 50),
    };
  });

  /** Viewers can't reach this: it isn't one of the writes they're allowed. */
  app.post("/api/proposals/decide", async (req): Promise<ProposalDecision[]> => {
    const user = requireUser(req);
    const { ids: chosen, decision } = parse(DecideBody, req.body);
    expireOld(db);
    const rows = db.select().from(p).where(inArray(p.id, chosen)).all();
    if (rows.length !== new Set(chosen).size) throw badRequest("Some of those no longer exist");
    const verb = decision === "approve" ? "Approved" : "Rejected";
    describeChange(
      db,
      rows.length === 1 ? `${verb} “${rows[0]?.summary}”` : `${verb} ${rows.length} inbox items`,
    );
    return rows.map((row) => {
      // Already decided (or expired): stays as it is.
      const done =
        row.status !== "pending"
          ? row
          : ((decision === "approve"
              ? approve(db, row, user.id, today())
              : reject(db, row, user.id)) ?? row);
      if (row.status === "pending")
        audit(db, {
          actorType: "user",
          actorId: user.id,
          action: `proposal.${decision}`,
          entityType: "agent_proposal",
          entityId: row.id,
          details: { tool: row.tool, tokenId: row.tokenId, status: done.status },
        });
      return { id: done.id, status: done.status, result: done.result };
    });
  });
}

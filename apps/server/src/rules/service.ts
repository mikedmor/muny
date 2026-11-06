import { applyRules, type RuleFacts, type RuleTarget, ruleMatches } from "@muny/core";
import { type MunyDb, newId, schema } from "@muny/db";
import {
  AMOUNT_OPS,
  type Rule,
  type RuleDefinition,
  type RulePreview,
  type RuleWithCount,
  TEXT_OPS,
} from "@muny/shared";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { upsertPayee, upsertTag } from "../ledger/transactions.js";
import { badRequest, notFound } from "../lib/http.js";

type Tx = Parameters<Parameters<MunyDb["transaction"]>[0]>[0];
type Db = MunyDb | Tx;

const text = z.string().trim().min(1, "Enter a value").max(200);
const id = z.string().min(1).max(64);

export const ConditionSchema = z.discriminatedUnion("field", [
  z.object({ field: z.literal("description"), op: z.enum(TEXT_OPS), value: text }),
  z.object({ field: z.literal("payee"), op: z.enum(TEXT_OPS), value: text }),
  z.object({
    field: z.literal("amount"),
    op: z.enum(AMOUNT_OPS),
    value: z.number().int().min(0).safe(),
  }),
  z.object({ field: z.literal("direction"), value: z.enum(["out", "in"]) }),
  z.object({ field: z.literal("account"), value: id }),
]);

export const ActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("setCategory"), categoryId: id }),
  z.object({ type: z.literal("setPayee"), name: z.string().trim().min(1).max(100) }),
  z.object({ type: z.literal("addTag"), name: z.string().trim().min(1).max(40) }),
  z.object({ type: z.literal("hide") }),
]);

export const DefinitionSchema = z.object({
  match: z.enum(["all", "any"]).default("all"),
  conditions: z.array(ConditionSchema).min(1, "Add at least one condition").max(10),
  actions: z.array(ActionSchema).min(1, "Add at least one action").max(10),
});

export function validateReferences(db: Db, def: RuleDefinition) {
  for (const a of def.actions) {
    if (a.type !== "setCategory") continue;
    const c = db
      .select({ id: schema.categories.id })
      .from(schema.categories)
      .where(eq(schema.categories.id, a.categoryId))
      .get();
    if (!c) throw badRequest("Unknown category in rule action", { categoryId: a.categoryId });
  }
  for (const c of def.conditions) {
    if (c.field !== "account") continue;
    const a = db
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(eq(schema.accounts.id, c.value))
      .get();
    if (!a) throw badRequest("Unknown account in rule condition", { accountId: c.value });
  }
}

function toRule(r: typeof schema.rules.$inferSelect): Rule {
  const cond = r.conditions as { match?: "all" | "any"; items?: RuleDefinition["conditions"] };
  return {
    id: r.id,
    name: r.name,
    enabled: r.enabled,
    priority: r.priority,
    match: cond.match ?? "all",
    conditions: cond.items ?? [],
    actions: r.actions as RuleDefinition["actions"],
  };
}

export function listRules(db: Db): Rule[] {
  return db
    .select()
    .from(schema.rules)
    .orderBy(asc(schema.rules.priority), asc(schema.rules.createdAt), asc(schema.rules.id))
    .all()
    .map(toRule);
}

export function getRule(db: Db, ruleId: string): Rule {
  const r = db.select().from(schema.rules).where(eq(schema.rules.id, ruleId)).get();
  if (!r) throw notFound("Rule not found");
  return toRule(r);
}

export function storeDefinition(def: RuleDefinition) {
  return { conditions: { match: def.match, items: def.conditions }, actions: def.actions };
}

export function createRule(db: Db, input: RuleDefinition & { name: string; enabled?: boolean }) {
  validateReferences(db, input);
  const max = db
    .select({ m: sql<number>`coalesce(max(${schema.rules.priority}), 0)` })
    .from(schema.rules)
    .get();
  const ruleId = newId();
  db.insert(schema.rules)
    .values({
      id: ruleId,
      name: input.name,
      enabled: input.enabled ?? true,
      priority: Number(max?.m ?? 0) + 10,
      ...storeDefinition(input),
    })
    .run();
  return getRule(db, ruleId);
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

interface Candidate {
  id: string;
  facts: RuleFacts;
  current: RuleTarget;
  userModified: boolean;
  hasSplits: boolean;
  postedDate: string;
  categoryName: string | null;
}

/** Load what rules need for the given transactions (or all of them). */
function loadCandidates(db: Db, ids?: string[]): Candidate[] {
  if (ids && ids.length === 0) return [];
  const t = schema.transactions;
  const rows = db
    .select({
      id: t.id,
      accountId: t.accountId,
      rawDescription: t.rawDescription,
      amountCents: t.amountCents,
      categoryId: t.categoryId,
      hidden: t.hidden,
      userModified: t.userModified,
      postedDate: t.postedDate,
      payee: schema.payees.displayName,
      categoryName: schema.categories.name,
      hasSplits: sql<number>`exists (select 1 from ${schema.transactionSplits} s where s.transaction_id = ${t.id})`,
    })
    .from(t)
    .leftJoin(schema.payees, eq(schema.payees.id, t.payeeId))
    .leftJoin(schema.categories, eq(schema.categories.id, t.categoryId))
    .where(ids ? inArray(t.id, ids) : undefined)
    .all();

  const tagRows = db
    .select({ txnId: schema.transactionTags.transactionId, name: schema.tags.name })
    .from(schema.transactionTags)
    .innerJoin(schema.tags, eq(schema.tags.id, schema.transactionTags.tagId))
    .where(ids ? inArray(schema.transactionTags.transactionId, ids) : undefined)
    .all();
  const tagsBy = new Map<string, string[]>();
  for (const r of tagRows) tagsBy.set(r.txnId, [...(tagsBy.get(r.txnId) ?? []), r.name]);

  return rows.map((r) => ({
    id: r.id,
    facts: {
      description: r.rawDescription,
      payee: r.payee,
      amountCents: r.amountCents,
      accountId: r.accountId,
    },
    current: {
      categoryId: r.categoryId,
      payeeName: r.payee,
      tags: tagsBy.get(r.id) ?? [],
      hidden: r.hidden,
    },
    userModified: r.userModified,
    hasSplits: Boolean(r.hasSplits),
    postedDate: r.postedDate,
    categoryName: r.categoryName,
  }));
}

export interface Plan {
  candidate: Candidate;
  next: RuleTarget;
}

export interface Evaluation {
  matched: Candidate[];
  plans: Plan[];
  skippedEdited: number;
}

/**
 * Work out what `rules` would change. Transactions whose category or payee
 * you set by hand are skipped unless `includeEdited`; split transactions keep
 * their category (it lives in the splits).
 */
export function evaluateRules(
  db: Db,
  rules: RuleDefinition[],
  opts: { includeEdited?: boolean; ids?: string[] } = {},
): Evaluation {
  const matched: Candidate[] = [];
  const plans: Plan[] = [];
  let skippedEdited = 0;
  if (rules.length === 0) return { matched, plans, skippedEdited };
  for (const c of loadCandidates(db, opts.ids)) {
    const r = applyRules(rules, c.facts, c.current);
    if (r.matched === 0) continue;
    matched.push(c);
    if (c.userModified && !opts.includeEdited) {
      skippedEdited++;
      continue;
    }
    const next = c.hasSplits ? { ...r.next, categoryId: c.current.categoryId } : r.next;
    const changed =
      next.categoryId !== c.current.categoryId ||
      (next.payeeName ?? "").toLowerCase() !== (c.current.payeeName ?? "").toLowerCase() ||
      next.hidden !== c.current.hidden ||
      next.tags.length !== c.current.tags.length;
    if (changed) plans.push({ candidate: c, next });
  }
  return { matched, plans, skippedEdited };
}

/** The enabled and disabled rules whose conditions match one transaction, with how many each matches. */
export function rulesForTransaction(db: Db, transactionId: string): RuleWithCount[] | null {
  const c = loadCandidates(db, [transactionId])[0];
  if (!c) return null;
  return listRules(db)
    .filter((r) => ruleMatches(r, c.facts))
    .map((r) => ({
      ...r,
      matchedCount: evaluateRules(db, [r], { includeEdited: true }).matched.length,
    }));
}

export function previewOf(e: Evaluation, limit = 10): RulePreview {
  return {
    matched: e.matched.length,
    wouldChange: e.plans.length,
    skippedEdited: e.skippedEdited,
    sample: [...e.matched]
      .sort((a, b) => b.postedDate.localeCompare(a.postedDate))
      .slice(0, limit)
      .map((c) => ({
        id: c.id,
        postedDate: c.postedDate,
        description: c.facts.payee ?? c.facts.description,
        amountCents: c.facts.amountCents,
        categoryName: c.categoryName,
      })),
  };
}

/** Write planned changes. Doesn't mark transactions as user-modified. */
export function applyPlans(tx: Tx, plans: Plan[]): number {
  const t = schema.transactions;
  const payeeCache = new Map<string, string>();
  const tagCache = new Map<string, string>();
  for (const { candidate: c, next } of plans) {
    const update: Partial<typeof t.$inferInsert> = {};
    if (next.categoryId !== c.current.categoryId) update.categoryId = next.categoryId;
    if (next.hidden !== c.current.hidden) update.hidden = next.hidden;
    if (
      next.payeeName &&
      next.payeeName.toLowerCase() !== (c.current.payeeName ?? "").toLowerCase()
    ) {
      const k = next.payeeName.toLowerCase();
      const pid = payeeCache.get(k) ?? upsertPayee(tx, next.payeeName);
      payeeCache.set(k, pid);
      update.payeeId = pid;
    }
    if (Object.keys(update).length) tx.update(t).set(update).where(eq(t.id, c.id)).run();
    for (const name of next.tags.slice(c.current.tags.length)) {
      const k = name.toLowerCase();
      const tagId = tagCache.get(k) ?? upsertTag(tx, name);
      tagCache.set(k, tagId);
      tx.insert(schema.transactionTags)
        .values({ transactionId: c.id, tagId })
        .onConflictDoNothing()
        .run();
    }
  }
  return plans.length;
}

/** Run all enabled rules on the given (newly imported) transactions. */
export function runRulesOn(tx: Tx, ids: string[]): number {
  const rules = listRules(tx).filter((r) => r.enabled);
  if (rules.length === 0 || ids.length === 0) return 0;
  let changed = 0;
  // Chunk to stay under SQLite's bound-parameter limit.
  for (let i = 0; i < ids.length; i += 500) {
    changed += applyPlans(tx, evaluateRules(tx, rules, { ids: ids.slice(i, i + 500) }).plans);
  }
  return changed;
}

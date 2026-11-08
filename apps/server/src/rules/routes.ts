import { type MunyDb, schema } from "@muny/db";
import type { RuleApplyResult } from "@muny/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/plugin.js";
import { audit } from "../lib/audit.js";
import { notFound, parse } from "../lib/http.js";
import { DECLINED_RULE_SERIES, rescanRecurring } from "../recurring/service.js";
import {
  applyPlans,
  combineRules,
  createRule,
  DefinitionSchema,
  evaluateRules,
  getRule,
  listRules,
  previewOf,
  ruleConflicts,
  ruleOverlaps,
  ruleReview,
  rulesForTransaction,
  storeDefinition,
  validateReferences,
} from "./service.js";

const IdParams = z.object({ id: z.string().min(1).max(64) });
const CombineBody = z.union([
  z.object({ keepId: z.string().min(1).max(64), removeId: z.string().min(1).max(64) }),
  z.object({ all: z.literal(true) }),
]);
const name = z.string().trim().min(1, "Name is required").max(100);

const CreateBody = DefinitionSchema.extend({ name, enabled: z.boolean().optional() });
const UpdateBody = z
  .object({
    name: name.optional(),
    enabled: z.boolean().optional(),
    match: z.enum(["all", "any"]).optional(),
    conditions: DefinitionSchema.shape.conditions.optional(),
    actions: DefinitionSchema.shape.actions.optional(),
  })
  .refine((b) => Object.keys(b).length > 0, "Nothing to update");
// Previews can leave out the actions (what a rule would match, before choosing what it does).
const PreviewBody = DefinitionSchema.extend({
  actions: DefinitionSchema.shape.actions.element.array().max(10),
  includeEdited: z.boolean().optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
const ApplyBody = z.object({ includeEdited: z.boolean().optional() });
const MoveBody = z.object({
  direction: z.enum(["up", "down"]),
  /** Move past this rule (the next one shown) instead of the next one in the whole list. */
  pastId: z.string().min(1).max(64).optional(),
});

/** Series a rule's "Count as recurring" action points at. */
const seriesOf = (r: { actions: { type: string; seriesId?: string }[] }) =>
  r.actions.filter((a) => a.type === "setRecurring" && a.seriesId).map((a) => a.seriesId as string);

/** The person took "Count as recurring" off this rule: don't put it back automatically. */
function rememberDeclined(
  db: MunyDb,
  before: { id: string; actions: { type: string; seriesId?: string }[] },
  after: { actions: { type: string; seriesId?: string }[] },
) {
  const kept = new Set(seriesOf(after));
  const removed = seriesOf(before).filter((sid) => !kept.has(sid));
  if (!removed.length) return;
  const row = db
    .select({ value: schema.appSettings.value })
    .from(schema.appSettings)
    .where(eq(schema.appSettings.key, DECLINED_RULE_SERIES))
    .get();
  const list = Array.isArray(row?.value) ? (row.value as string[]) : [];
  const next = [
    ...new Set([...list, ...removed.flatMap((sid) => [`${before.id}:${sid}`, `auto:${sid}`])]),
  ].slice(-500);
  db.insert(schema.appSettings)
    .values({ key: DECLINED_RULE_SERIES, value: next })
    .onConflictDoUpdate({ target: schema.appSettings.key, set: { value: next } })
    .run();
}

/** Does this rule place transactions in a recurring series? */
const placesRecurring = (r: { actions: { type: string }[] }) =>
  r.actions.some((a) => a.type === "setRecurring");

export function registerRuleRoutes(app: FastifyInstance, db: MunyDb) {
  const log = (userId: string, action: string, entityId?: string, details?: unknown) =>
    audit(db, {
      actorType: "user",
      actorId: userId,
      action,
      entityType: "rule",
      entityId,
      details,
    });

  app.get("/api/rules", async () => listRules(db));

  /** Duplicate rules, and rules that file the same transactions differently. */
  app.get("/api/rules/conflicts", async (req) => {
    requireUser(req);
    return ruleConflicts(db);
  });

  /** Match counts, automatic rules, rules that can be combined, and clashes. */
  app.get("/api/rules/review", async (req) => {
    requireUser(req);
    return ruleReview(db);
  });

  /** Combine a pair of rules the review offered (or every such pair). */
  app.post("/api/rules/combine", async (req) => {
    const user = requireUser(req);
    const body = parse(CombineBody, req.body);
    const done = db.transaction((tx) => {
      const out = combineRules(tx, "keepId" in body ? body : undefined);
      if (out.length) rescanRecurring(tx);
      return out;
    });
    if ("keepId" in body && !done.length) throw notFound("Those rules can no longer be combined");
    for (const c of done) log(user.id, "rule.combine", c.keepId, { removed: c.removeId });
    return { combined: done.length };
  });

  app.post("/api/rules", async (req, reply) => {
    const user = requireUser(req);
    const rule = createRule(db, parse(CreateBody, req.body));
    if (placesRecurring(rule)) db.transaction((tx) => rescanRecurring(tx));
    log(user.id, "rule.create", rule.id);
    return reply.code(201).send(rule);
  });

  app.patch("/api/rules/:id", async (req) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    const body = parse(UpdateBody, req.body);
    const current = getRule(db, id);
    const def = {
      match: body.match ?? current.match,
      conditions: body.conditions ?? current.conditions,
      actions: body.actions ?? current.actions,
    };
    validateReferences(db, def);
    db.update(schema.rules)
      .set({
        ...(body.name !== undefined && { name: body.name }),
        ...(body.enabled !== undefined && { enabled: body.enabled }),
        ...storeDefinition(def),
      })
      .where(eq(schema.rules.id, id))
      .run();
    const updated = getRule(db, id);
    rememberDeclined(db, current, updated);
    if (placesRecurring(current) || placesRecurring(updated))
      db.transaction((tx) => rescanRecurring(tx));
    log(user.id, "rule.update", id, { fields: Object.keys(body) });
    return updated;
  });

  app.delete("/api/rules/:id", async (req) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    const gone = getRule(db, id);
    db.delete(schema.rules).where(eq(schema.rules.id, id)).run();
    rememberDeclined(db, gone, { actions: [] });
    // Its charges go back to being matched by name.
    if (placesRecurring(gone)) db.transaction((tx) => rescanRecurring(tx));
    log(user.id, "rule.delete", id);
    return { ok: true };
  });

  /** Swap priority with the neighbour above/below. */
  app.post("/api/rules/:id/move", async (req) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    const { direction, pastId } = parse(MoveBody, req.body);
    db.transaction((tx) => {
      const rules = listRules(tx);
      const i = rules.findIndex((r) => r.id === id);
      if (i === -1) return;
      const order = rules.map((r) => r.id);
      if (pastId) {
        // Take it out and put it just above (up) or below (down) that rule.
        if (pastId === id || !order.includes(pastId)) return;
        order.splice(i, 1);
        const k = order.indexOf(pastId);
        order.splice(direction === "up" ? k : k + 1, 0, id);
      } else {
        const j = direction === "up" ? i - 1 : i + 1;
        if (j < 0 || j >= rules.length) return;
        [order[i], order[j]] = [order[j] as string, order[i] as string];
      }
      // Renumber everything so equal priorities can't make the swap a no-op.
      order.forEach((rid, n) => {
        tx.update(schema.rules)
          .set({ priority: (n + 1) * 10 })
          .where(eq(schema.rules.id, rid))
          .run();
      });
    });
    // Order decides which rule wins when two place the same charge.
    if (listRules(db).some(placesRecurring)) db.transaction((tx) => rescanRecurring(tx));
    log(user.id, "rule.move", id, { direction });
    return listRules(db);
  });

  /** Dry run: what would this definition match and change? Nothing is written. */
  app.post("/api/rules/preview", async (req) => {
    const body = parse(PreviewBody, req.body);
    validateReferences(db, body);
    return previewOf(evaluateRules(db, [body], { includeEdited: body.includeEdited }), body.limit);
  });

  /** Existing rules covering the same transactions (or with the same conditions), and conflicts. */
  app.post("/api/rules/overlaps", async (req) => {
    requireUser(req);
    const body = parse(
      PreviewBody.extend({ exceptId: z.string().min(1).max(64).optional() }),
      req.body,
    );
    return ruleOverlaps(db, body, body.exceptId);
  });

  /** The rules that match a transaction (enabled or not), for its Rules panel. */
  app.get("/api/transactions/:id/rules", async (req) => {
    requireUser(req);
    const { id } = parse(IdParams, req.params);
    const list = rulesForTransaction(db, id);
    if (!list) throw notFound("Transaction not found");
    return list;
  });

  /** Apply one rule to existing transactions. */
  app.post("/api/rules/:id/apply", async (req): Promise<RuleApplyResult> => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    const { includeEdited } = parse(ApplyBody, req.body ?? {});
    const rule = getRule(db, id);
    const changed = db.transaction((tx) => {
      const changed = applyPlans(tx, evaluateRules(tx, [rule], { includeEdited }).plans);
      if (changed) rescanRecurring(tx); // categories feed recurring types
      return changed;
    });
    log(user.id, "rule.apply", id, { changed, includeEdited: !!includeEdited });
    return { changed };
  });

  /** Apply all enabled rules (in priority order) to existing transactions. */
  app.post("/api/rules/run", async (req): Promise<RuleApplyResult> => {
    const user = requireUser(req);
    const { includeEdited } = parse(ApplyBody, req.body ?? {});
    const changed = db.transaction((tx) => {
      const rules = listRules(tx).filter((r) => r.enabled);
      const changed = applyPlans(tx, evaluateRules(tx, rules, { includeEdited }).plans);
      if (changed) rescanRecurring(tx);
      return changed;
    });
    log(user.id, "rule.run_all", undefined, { changed, includeEdited: !!includeEdited });
    return { changed };
  });
}

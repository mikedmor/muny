import { type MunyDb, schema } from "@muny/db";
import type { RuleApplyResult } from "@muny/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/plugin.js";
import { audit } from "../lib/audit.js";
import { parse } from "../lib/http.js";
import {
  applyPlans,
  createRule,
  DefinitionSchema,
  evaluateRules,
  getRule,
  listRules,
  previewOf,
  storeDefinition,
  validateReferences,
} from "./service.js";

const IdParams = z.object({ id: z.string().min(1).max(64) });
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
const PreviewBody = DefinitionSchema.extend({ includeEdited: z.boolean().optional() });
const ApplyBody = z.object({ includeEdited: z.boolean().optional() });
const MoveBody = z.object({ direction: z.enum(["up", "down"]) });

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

  app.post("/api/rules", async (req, reply) => {
    const user = requireUser(req);
    const rule = createRule(db, parse(CreateBody, req.body));
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
    log(user.id, "rule.update", id, { fields: Object.keys(body) });
    return getRule(db, id);
  });

  app.delete("/api/rules/:id", async (req) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    getRule(db, id);
    db.delete(schema.rules).where(eq(schema.rules.id, id)).run();
    log(user.id, "rule.delete", id);
    return { ok: true };
  });

  /** Swap priority with the neighbour above/below. */
  app.post("/api/rules/:id/move", async (req) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    const { direction } = parse(MoveBody, req.body);
    db.transaction((tx) => {
      const rules = listRules(tx);
      const i = rules.findIndex((r) => r.id === id);
      if (i === -1) return;
      const j = direction === "up" ? i - 1 : i + 1;
      if (j < 0 || j >= rules.length) return;
      // Renumber everything so equal priorities can't make the swap a no-op.
      const order = rules.map((r) => r.id);
      [order[i], order[j]] = [order[j] as string, order[i] as string];
      order.forEach((rid, n) => {
        tx.update(schema.rules)
          .set({ priority: (n + 1) * 10 })
          .where(eq(schema.rules.id, rid))
          .run();
      });
    });
    log(user.id, "rule.move", id, { direction });
    return listRules(db);
  });

  /** Dry run: what would this definition match and change? Nothing is written. */
  app.post("/api/rules/preview", async (req) => {
    const body = parse(PreviewBody, req.body);
    validateReferences(db, body);
    return previewOf(evaluateRules(db, [body], { includeEdited: body.includeEdited }));
  });

  /** Apply one rule to existing transactions. */
  app.post("/api/rules/:id/apply", async (req): Promise<RuleApplyResult> => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    const { includeEdited } = parse(ApplyBody, req.body ?? {});
    const rule = getRule(db, id);
    const changed = db.transaction((tx) =>
      applyPlans(tx, evaluateRules(tx, [rule], { includeEdited }).plans),
    );
    log(user.id, "rule.apply", id, { changed, includeEdited: !!includeEdited });
    return { changed };
  });

  /** Apply all enabled rules (in priority order) to existing transactions. */
  app.post("/api/rules/run", async (req): Promise<RuleApplyResult> => {
    const user = requireUser(req);
    const { includeEdited } = parse(ApplyBody, req.body ?? {});
    const changed = db.transaction((tx) => {
      const rules = listRules(tx).filter((r) => r.enabled);
      return applyPlans(tx, evaluateRules(tx, rules, { includeEdited }).plans);
    });
    log(user.id, "rule.run_all", undefined, { changed, includeEdited: !!includeEdited });
    return { changed };
  });
}

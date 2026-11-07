import { type MunyDb, schema } from "@muny/db";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/plugin.js";
import { audit } from "../lib/audit.js";
import { localToday } from "../lib/dates.js";
import { badRequest, notFound, parse } from "../lib/http.js";
import { budgetMonth, removeBudget, setBudget } from "./service.js";

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use YYYY-MM");

const SetBody = z.object({
  categoryId: z.string().min(1).max(64).nullable(),
  /** "spending" only: a category's budget, or (no category) the total spending budget. */
  kind: z.enum(["spending", "income", "bills", "other"]).optional(),
  amountCents: z.number().int().min(0).max(1_000_000_000),
  rollover: z.boolean().optional(),
  fromMonth: month.optional(),
});

export function registerBudgetRoutes(app: FastifyInstance, db: MunyDb) {
  const log = (userId: string, action: string, entityId?: string, details?: unknown) =>
    audit(db, {
      actorType: "user",
      actorId: userId,
      action,
      entityType: "budget",
      entityId,
      details,
    });

  app.get("/api/budgets/:month", async (req) => {
    const p = parse(z.object({ month }), req.params);
    return budgetMonth(db, p.month);
  });

  /** Create or change a budget. The amount applies from `fromMonth` (default: this month) on. */
  app.put("/api/budgets", async (req) => {
    const user = requireUser(req);
    const body = parse(SetBody, req.body);
    // Budget basics are worked out (expected income; category budgets added up).
    if (body.kind && body.kind !== "spending")
      throw badRequest(
        "Earnings, bills and all other categories are worked out from your income and category budgets",
      );
    if (body.categoryId) {
      const c = db
        .select({ kind: schema.categoryGroups.kind })
        .from(schema.categories)
        .innerJoin(schema.categoryGroups, eq(schema.categoryGroups.id, schema.categories.groupId))
        .where(eq(schema.categories.id, body.categoryId))
        .get();
      if (!c) throw badRequest("Unknown category");
      if (c.kind !== "expense") throw badRequest("Budgets are for spending categories");
    }
    const fromMonth = body.fromMonth ?? localToday().slice(0, 7);
    const id = db.transaction((tx) => setBudget(tx, { ...body, fromMonth }));
    log(user.id, "budget.set", id, {
      categoryId: body.categoryId,
      kind: body.kind ?? "spending",
      amountCents: body.amountCents,
      fromMonth,
    });
    return budgetMonth(db, fromMonth);
  });

  app.delete("/api/budgets/:id", async (req) => {
    const user = requireUser(req);
    const { id } = parse(z.object({ id: z.string().min(1).max(64) }), req.params);
    if (!db.transaction((tx) => removeBudget(tx, id))) throw notFound("Budget not found");
    log(user.id, "budget.delete", id);
    return { ok: true };
  });
}

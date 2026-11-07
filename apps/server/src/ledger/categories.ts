import { type MunyDb, newId, schema } from "@muny/db";
import type { CategoryGroup, CategoryUsage } from "@muny/shared";
import { and, asc, count, eq, ne, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/plugin.js";
import { audit } from "../lib/audit.js";
import { conflict, notFound, parse } from "../lib/http.js";
import { rescanRecurring } from "../recurring/service.js";

const name = z.string().trim().min(1, "Name is required").max(60);
const IdParams = z.object({ id: z.string().min(1).max(64) });

const GroupCreate = z.object({
  name,
  kind: z.enum(["expense", "income", "transfer"]).default("expense"),
});
const GroupUpdate = z.object({
  name: name.optional(),
  kind: z.enum(["expense", "income", "transfer"]).optional(),
  sortOrder: z.number().int().optional(),
});
const CategoryCreate = z.object({
  groupId: z.string().min(1),
  name,
  icon: z.string().max(16).nullish(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullish(),
});
const CategoryUpdate = CategoryCreate.partial().extend({
  hidden: z.boolean().optional(),
  excludeFromBudget: z.boolean().optional(),
  isBill: z.boolean().optional(),
  isHome: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

/** SQL: something uses the category in the outer query (`categories`). */
const IN_USE = sql.raw(`exists(select 1 from transactions x where x.category_id = categories.id)
  or exists(select 1 from transaction_splits x where x.category_id = categories.id)
  or exists(select 1 from recurring_series x where x.category_id = categories.id)
  or exists(select 1 from payees x where x.default_category_id = categories.id)
  or exists(select 1 from budgets x where x.category_id = categories.id)
  or exists(select 1 from rules x where instr(x.actions, '"' || categories.id || '"') > 0)`);

export function listCategoryGroups(db: MunyDb): CategoryGroup[] {
  const groups = db
    .select()
    .from(schema.categoryGroups)
    .orderBy(asc(schema.categoryGroups.sortOrder), asc(schema.categoryGroups.name))
    .all();
  const t = schema.transactions;
  const cats = db
    .select({
      category: schema.categories,
      n: sql<number>`(select count(*) from ${t} where ${t.categoryId} = ${schema.categories.id})`,
      used: sql<number>`(${IN_USE})`,
    })
    .from(schema.categories)
    .orderBy(asc(schema.categories.sortOrder), asc(schema.categories.name))
    .all();
  return groups.map((g) => ({
    id: g.id,
    name: g.name,
    kind: g.kind,
    sortOrder: g.sortOrder,
    categories: cats
      .filter((c) => c.category.groupId === g.id)
      .map(({ category: c, n, used }) => ({
        id: c.id,
        groupId: c.groupId,
        name: c.name,
        icon: c.icon,
        color: c.color,
        hidden: c.hidden,
        excludeFromBudget: c.excludeFromBudget,
        isBill: c.isBill,
        isHome: c.isHome,
        sortOrder: c.sortOrder,
        transactionCount: Number(n),
        unused: !used,
      })),
  }));
}

function assertGroup(db: MunyDb, id: string) {
  const g = db.select().from(schema.categoryGroups).where(eq(schema.categoryGroups.id, id)).get();
  if (!g) throw notFound("Category group not found");
  return g;
}

function assertCategory(db: MunyDb, id: string) {
  const c = db.select().from(schema.categories).where(eq(schema.categories.id, id)).get();
  if (!c) throw notFound("Category not found");
  return c;
}

function assertUniqueName(db: MunyDb, groupId: string, catName: string, exceptId?: string) {
  const dup = db
    .select({ id: schema.categories.id })
    .from(schema.categories)
    .where(
      and(
        eq(schema.categories.groupId, groupId),
        sql`lower(${schema.categories.name}) = lower(${catName})`,
        exceptId ? ne(schema.categories.id, exceptId) : undefined,
      ),
    )
    .get();
  if (dup) throw conflict(`"${catName}" already exists in this group`);
}

export function registerCategoryRoutes(app: FastifyInstance, db: MunyDb) {
  const log = (userId: string, action: string, entityId: string, details?: unknown) =>
    audit(db, {
      actorType: "user",
      actorId: userId,
      action,
      entityType: "category",
      entityId,
      details,
    });

  app.get("/api/categories", async () => listCategoryGroups(db));

  app.post("/api/category-groups", async (req, reply) => {
    const user = requireUser(req);
    const body = parse(GroupCreate, req.body);
    const exists = db
      .select({ id: schema.categoryGroups.id })
      .from(schema.categoryGroups)
      .where(sql`lower(${schema.categoryGroups.name}) = lower(${body.name})`)
      .get();
    if (exists) throw conflict(`Group "${body.name}" already exists`);
    const max = db
      .select({ m: sql<number>`coalesce(max(${schema.categoryGroups.sortOrder}), -1)` })
      .from(schema.categoryGroups)
      .get();
    const id = newId();
    db.insert(schema.categoryGroups)
      .values({ id, name: body.name, kind: body.kind, sortOrder: Number(max?.m ?? -1) + 1 })
      .run();
    log(user.id, "category_group.create", id, { name: body.name });
    return reply.code(201).send({ id });
  });

  app.patch("/api/category-groups/:id", async (req) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    const body = parse(GroupUpdate, req.body);
    assertGroup(db, id);
    db.update(schema.categoryGroups).set(body).where(eq(schema.categoryGroups.id, id)).run();
    log(user.id, "category_group.update", id, body);
    return { ok: true };
  });

  app.delete("/api/category-groups/:id", async (req) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    const g = assertGroup(db, id);
    const n =
      db
        .select({ n: count() })
        .from(schema.categories)
        .where(eq(schema.categories.groupId, id))
        .get()?.n ?? 0;
    if (n > 0) throw conflict("Move or delete this group's categories first");
    db.delete(schema.categoryGroups).where(eq(schema.categoryGroups.id, id)).run();
    log(user.id, "category_group.delete", id, { name: g.name });
    return { ok: true };
  });

  app.post("/api/categories", async (req, reply) => {
    const user = requireUser(req);
    const body = parse(CategoryCreate, req.body);
    assertGroup(db, body.groupId);
    assertUniqueName(db, body.groupId, body.name);
    const max = db
      .select({ m: sql<number>`coalesce(max(${schema.categories.sortOrder}), -1)` })
      .from(schema.categories)
      .where(eq(schema.categories.groupId, body.groupId))
      .get();
    const id = newId();
    db.insert(schema.categories)
      .values({
        id,
        groupId: body.groupId,
        name: body.name,
        icon: body.icon ?? null,
        color: body.color ?? null,
        sortOrder: Number(max?.m ?? -1) + 1,
      })
      .run();
    log(user.id, "category.create", id, { name: body.name });
    return reply.code(201).send({ id });
  });

  app.patch("/api/categories/:id", async (req) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    const body = parse(CategoryUpdate, req.body);
    const current = assertCategory(db, id);
    const groupId = body.groupId ?? current.groupId;
    if (body.groupId) assertGroup(db, body.groupId);
    if (body.name || body.groupId) assertUniqueName(db, groupId, body.name ?? current.name, id);
    // A category is a home cost or a bill, never both: each would count it once more.
    const patch = {
      ...body,
      ...(body.isHome && { isBill: false }),
      ...(body.isBill && { isHome: false }),
    };
    db.update(schema.categories).set(patch).where(eq(schema.categories.id, id)).run();
    log(user.id, "category.update", id, patch);
    return { ok: true };
  });

  /** Delete every category nothing uses. */
  app.post("/api/categories/delete-unused", async (req) => {
    const user = requireUser(req);
    const gone = db.transaction((tx) =>
      tx
        .select({ id: schema.categories.id, name: schema.categories.name })
        .from(schema.categories)
        .where(sql`not (${IN_USE})`)
        .all()
        .map((c) => {
          tx.delete(schema.categories).where(eq(schema.categories.id, c.id)).run();
          return c;
        }),
    );
    for (const c of gone) log(user.id, "category.delete", c.id, { name: c.name, unused: true });
    return { deleted: gone.length };
  });

  /** What deleting a category touches, for the confirm dialog. */
  app.get("/api/categories/:id/usage", async (req) => {
    requireUser(req);
    const { id } = parse(IdParams, req.params);
    assertCategory(db, id);
    return categoryUsage(db, id);
  });

  /**
   * Delete a category. Everything that used it (transactions, split parts,
   * recurring series, payee defaults, rules, its budget) moves to `reassignTo`,
   * or is left uncategorized.
   */
  app.delete("/api/categories/:id", async (req) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    const { reassignTo } = parse(z.object({ reassignTo: z.string().min(1).optional() }), req.query);
    const c = assertCategory(db, id);
    if (reassignTo === id) throw conflict("Can't reassign to the category being deleted");
    if (reassignTo) assertCategory(db, reassignTo);
    const moved = db.transaction((tx) => {
      const out = deleteCategory(tx, id, reassignTo ?? null);
      rescanRecurring(tx);
      return out;
    });
    log(user.id, "category.delete", id, { name: c.name, reassignTo: reassignTo ?? null, ...moved });
    return { ok: true, ...moved };
  });
}

type Tx = Parameters<Parameters<MunyDb["transaction"]>[0]>[0];

/** Rules whose actions set this category. */
function rulesSetting(db: MunyDb | Tx, id: string) {
  return db
    .select()
    .from(schema.rules)
    .all()
    .filter((r) =>
      (r.actions as { type: string; categoryId?: string }[]).some(
        (a) => a.type === "setCategory" && a.categoryId === id,
      ),
    );
}

export function categoryUsage(db: MunyDb | Tx, id: string): CategoryUsage {
  const n = (table: "transactions" | "transaction_splits" | "recurring_series", col: string) =>
    Number(
      db.get<{ n: number }>(
        sql`select count(*) as n from ${sql.raw(table)} where ${sql.raw(col)} = ${id}`,
      )?.n ?? 0,
    );
  const rules = rulesSetting(db, id);
  return {
    transactions: n("transactions", "category_id"),
    splits: n("transaction_splits", "category_id"),
    recurring: n("recurring_series", "category_id"),
    payees: Number(
      db
        .select({ n: count() })
        .from(schema.payees)
        .where(eq(schema.payees.defaultCategoryId, id))
        .get()?.n ?? 0,
    ),
    rules: rules.length,
    rulesOnlySetting: rules.filter((r) => (r.actions as unknown[]).length === 1).length,
    budget: !!db
      .select({ id: schema.budgets.id })
      .from(schema.budgets)
      .where(eq(schema.budgets.categoryId, id))
      .get(),
  };
}

/**
 * Move everything off a category (to `to`, or to no category) and delete it.
 * Rules: the setCategory action points at `to`; with no `to` it's dropped, and
 * a rule that did nothing else is deleted. Budget: moves to `to` if it has none.
 */
export function deleteCategory(tx: Tx, id: string, to: string | null) {
  const usage = categoryUsage(tx, id);
  const t = schema.transactions;
  tx.update(t).set({ categoryId: to }).where(eq(t.categoryId, id)).run();
  tx.update(schema.transactionSplits)
    .set({ categoryId: to })
    .where(eq(schema.transactionSplits.categoryId, id))
    .run();
  tx.update(schema.recurringSeries)
    .set({ categoryId: to })
    .where(eq(schema.recurringSeries.categoryId, id))
    .run();
  tx.update(schema.payees)
    .set({ defaultCategoryId: to })
    .where(eq(schema.payees.defaultCategoryId, id))
    .run();
  let rulesDeleted = 0;
  for (const r of rulesSetting(tx, id)) {
    const actions = (r.actions as { type: string; categoryId?: string }[]).flatMap((a) =>
      a.type === "setCategory" && a.categoryId === id
        ? to
          ? [{ ...a, categoryId: to }]
          : []
        : [a],
    );
    if (actions.length === 0) {
      tx.delete(schema.rules).where(eq(schema.rules.id, r.id)).run();
      rulesDeleted++;
    } else tx.update(schema.rules).set({ actions }).where(eq(schema.rules.id, r.id)).run();
  }
  let budgetMoved = false;
  if (to && usage.budget) {
    const has = tx
      .select({ id: schema.budgets.id })
      .from(schema.budgets)
      .where(eq(schema.budgets.categoryId, to))
      .get();
    if (!has) {
      tx.update(schema.budgets)
        .set({ categoryId: to })
        .where(eq(schema.budgets.categoryId, id))
        .run();
      budgetMoved = true;
    }
  }
  tx.delete(schema.categories).where(eq(schema.categories.id, id)).run();
  return { ...usage, rulesDeleted, budgetMoved };
}

import { type MunyDb, schema } from "@muny/db";
import { INTERVALS, RECURRING_KINDS, RECURRING_STATUSES } from "@muny/shared";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/plugin.js";
import { loadTransactions } from "../ledger/transactions.js";
import { audit } from "../lib/audit.js";
import { localToday } from "../lib/dates.js";
import { badRequest, notFound, parse } from "../lib/http.js";
import { createFromTransaction, listSeries, rescanRecurring, upcoming } from "./service.js";

const IdParams = z.object({ id: z.string().min(1).max(64) });
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const interval = z.enum(INTERVALS as [string, ...string[]]);

const UpdateBody = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    kind: z.enum(RECURRING_KINDS).optional(),
    status: z.enum(RECURRING_STATUSES).optional(),
    interval: interval.optional(),
    expectedAmountCents: z.number().int().safe().optional(),
    categoryId: z.string().max(64).nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
    /** With categoryId: also file its charges there (not split ones or transfers). */
    applyToTransactions: z.boolean().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, "Nothing to update");

const CreateBody = z.object({
  transactionId: z.string().min(1).max(64),
  interval,
  kind: z.enum(RECURRING_KINDS).optional(),
});

function addDays(iso: string, n: number) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function registerRecurringRoutes(app: FastifyInstance, db: MunyDb) {
  const s = schema.recurringSeries;
  const log = (userId: string, action: string, entityId?: string, details?: unknown) =>
    audit(db, {
      actorType: "user",
      actorId: userId,
      action,
      entityType: "recurring",
      entityId,
      details,
    });
  const get = (id: string) => {
    const r = listSeries(db, localToday(), id)[0];
    if (!r) throw notFound("Recurring item not found");
    return r;
  };

  app.get("/api/recurring", async () => listSeries(db));

  app.get("/api/recurring/upcoming", async (req) => {
    const today = localToday();
    const q = parse(z.object({ from: isoDate.optional(), to: isoDate.optional() }), req.query);
    const from = q.from ?? today;
    const to = q.to ?? addDays(from, 30);
    if (to < from || to > addDays(from, 400))
      throw badRequest("Choose a range of at most 400 days");
    return upcoming(db, from, to, today, true);
  });

  app.get("/api/recurring/:id/transactions", async (req) => {
    const { id } = parse(IdParams, req.params);
    get(id);
    const ids = db
      .select({ id: schema.transactions.id })
      .from(schema.transactions)
      .where(eq(schema.transactions.recurringSeriesId, id))
      .orderBy(schema.transactions.postedDate)
      .all()
      .map((r) => r.id)
      .reverse();
    return loadTransactions(db, ids);
  });

  app.post("/api/recurring/rescan", async (req) => {
    const user = requireUser(req);
    const r = db.transaction((tx) => rescanRecurring(tx));
    log(user.id, "recurring.rescan", undefined, r);
    return r;
  });

  app.post("/api/recurring", async (req, reply) => {
    const user = requireUser(req);
    const body = parse(CreateBody, req.body);
    const id = db.transaction((tx) =>
      createFromTransaction(tx, body.transactionId, body.interval as never, body.kind),
    );
    if (!id)
      throw badRequest("That transaction can't be recurring (pending, hidden or a transfer)");
    log(user.id, "recurring.create", id);
    return reply.code(201).send(get(id));
  });

  app.patch("/api/recurring/:id", async (req) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    const { applyToTransactions, ...body } = parse(UpdateBody, req.body);
    const current = get(id);
    if (body.categoryId) {
      const c = db
        .select({ id: schema.categories.id })
        .from(schema.categories)
        .where(eq(schema.categories.id, body.categoryId))
        .get();
      if (!c) throw badRequest("Unknown category");
    }
    const edits = ["name", "kind", "interval", "expectedAmountCents", "categoryId"].some(
      (k) => k in body,
    );
    db.update(s)
      .set({
        ...body,
        interval: body.interval as never,
        ...(edits ? { userModified: true } : {}),
        ...(body.status === "cancelled" && current.status !== "cancelled"
          ? { cancelledAt: localToday() }
          : {}),
        ...(body.status && body.status !== "cancelled" ? { cancelledAt: null } : {}),
      })
      .where(eq(s.id, id))
      .run();
    // Ignoring detaches its charges so they read as ordinary transactions.
    if (body.status === "ignored") {
      db.update(schema.transactions)
        .set({ recurringSeriesId: null })
        .where(eq(schema.transactions.recurringSeriesId, id))
        .run();
    }
    if (applyToTransactions && "categoryId" in body) {
      const t = schema.transactions;
      db.update(t)
        .set({ categoryId: body.categoryId ?? null, userModified: true })
        .where(
          and(
            eq(t.recurringSeriesId, id),
            isNull(t.transferPairId),
            sql`not exists (select 1 from transaction_splits x where x.transaction_id = ${t.id})`,
          ),
        )
        .run();
    }
    log(user.id, "recurring.update", id, {
      fields: Object.keys(body),
      status: body.status,
      applyToTransactions,
    });
    return get(id);
  });

  /** Manually created series can be deleted; detected ones are ignored instead (or they'd come back). */
  app.delete("/api/recurring/:id", async (req) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    const current = get(id);
    if (current.source !== "manual")
      throw badRequest("Detected items can't be deleted; mark them as ignored instead.");
    db.delete(s).where(eq(s.id, id)).run();
    log(user.id, "recurring.delete", id);
    return { ok: true };
  });
}

import { type MunyDb, newId, schema } from "@muny/db";
import type { Trial } from "@muny/shared";
import { desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/plugin.js";
import { audit } from "../lib/audit.js";
import { localToday } from "../lib/dates.js";
import { badRequest, notFound, parse } from "../lib/http.js";

/**
 * Free trials: entered by hand (a trial has no charge yet, so there's nothing
 * to detect). The "trial ending" alert reminds you before endDate.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const TrialBody = z.object({
  name: z.string().trim().min(1, "Name the service").max(100),
  startDate: isoDate,
  endDate: isoDate,
  priceCents: z.number().int().min(0).max(100_000_000).nullable().optional(),
  interval: z.enum(["weekly", "monthly", "quarterly", "annual"]).nullable().optional(),
  status: z.enum(["active", "cancelled", "kept"]).optional(),
  cancelInfo: z.string().trim().max(500).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});
const IdParams = z.object({ id: z.string().min(1).max(64) });

const dayNum = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;

export function listTrials(db: MunyDb, today = localToday()): Trial[] {
  return db
    .select()
    .from(schema.trials)
    .orderBy(desc(schema.trials.endDate))
    .all()
    .map((r) => ({
      id: r.id,
      name: r.name,
      startDate: r.startDate,
      endDate: r.endDate,
      priceCents: r.priceCents,
      interval: r.interval,
      status: r.status,
      cancelInfo: r.cancelInfo,
      notes: r.notes,
      daysLeft: Math.round(dayNum(r.endDate) - dayNum(today)),
    }));
}

export function registerTrialRoutes(app: FastifyInstance, db: MunyDb) {
  const t = schema.trials;
  const log = (userId: string, action: string, entityId: string) =>
    audit(db, { actorType: "user", actorId: userId, action, entityType: "trial", entityId });
  const get = (id: string) => listTrials(db).find((x) => x.id === id);

  app.get("/api/trials", async () => listTrials(db));

  app.post("/api/trials", async (req, reply) => {
    const user = requireUser(req);
    const body = parse(TrialBody, req.body);
    if (body.endDate < body.startDate) throw badRequest("The trial ends before it starts");
    const id = newId();
    db.insert(t)
      .values({
        id,
        name: body.name,
        startDate: body.startDate,
        endDate: body.endDate,
        priceCents: body.priceCents ?? null,
        interval: body.interval ?? null,
        status: body.status ?? "active",
        cancelInfo: body.cancelInfo || null,
        notes: body.notes || null,
      })
      .run();
    log(user.id, "trial.create", id);
    reply.code(201);
    return get(id);
  });

  app.patch("/api/trials/:id", async (req) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    const body = parse(TrialBody.partial(), req.body);
    const row = db.select().from(t).where(eq(t.id, id)).get();
    if (!row) throw notFound("Trial not found");
    if ((body.endDate ?? row.endDate) < (body.startDate ?? row.startDate))
      throw badRequest("The trial ends before it starts");
    db.update(t)
      .set({
        ...body,
        ...(body.cancelInfo !== undefined ? { cancelInfo: body.cancelInfo || null } : {}),
        ...(body.notes !== undefined ? { notes: body.notes || null } : {}),
      })
      .where(eq(t.id, id))
      .run();
    log(user.id, "trial.update", id);
    return get(id);
  });

  app.delete("/api/trials/:id", async (req) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    if (db.delete(t).where(eq(t.id, id)).run().changes === 0) throw notFound("Trial not found");
    log(user.id, "trial.delete", id);
    return { ok: true };
  });
}

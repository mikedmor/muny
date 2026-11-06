import { type MunyDb, newId, schema } from "@muny/db";
import { DIY_STATUSES, INFRA_KINDS, SAVING_KINDS } from "@muny/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/plugin.js";
import { audit } from "../lib/audit.js";
import { badRequest, notFound, parse } from "../lib/http.js";
import { savingsAccountsReport, setAccountApy, setSavingsPlan } from "./accounts.js";
import { bucketsFor, setBuckets, setPlanMode } from "./buckets.js";
import {
  alternativeSuggestions,
  createSaving,
  listDiy,
  listInfra,
  listSavings,
  onDiyStatus,
  savingsSummary,
  verifySavings,
} from "./service.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const cents = z.number().int().min(0).max(1_000_000_000);
const IdParams = z.object({ id: z.string().min(1).max(64) });
const note = z.string().trim().max(2000).nullable().optional();

const SavingBody = z.object({
  kind: z.enum(SAVING_KINDS),
  name: z.string().trim().max(100).optional(),
  seriesId: z.string().max(64).nullable().optional(),
  beforeMonthlyCents: cents.optional(),
  afterMonthlyCents: cents.optional(),
  effectiveDate: isoDate.optional(),
  notes: note,
  cancelSeries: z.boolean().optional(),
});

const DiyBody = z.object({
  serviceName: z.string().trim().min(1, "Name the service you're replacing").max(100),
  seriesId: z.string().max(64).nullable().optional(),
  alternative: z.string().trim().min(1, "Name the alternative").max(100),
  status: z.enum(DIY_STATUSES).optional(),
  effort: z.enum(["low", "medium", "high"]).nullable().optional(),
  runningMonthlyCents: cents.optional(),
  notes: note,
});

const InfraBody = z
  .object({
    name: z.string().trim().min(1, "Name it").max(100),
    kind: z.enum(INFRA_KINDS),
    amountCents: cents.nullable().optional(),
    period: z.enum(["monthly", "annual", "once"]).nullable().optional(),
    amortizeMonths: z.number().int().min(1).max(240).nullable().optional(),
    watts: z.number().int().min(1).max(10_000).nullable().optional(),
    priceDeciCentsPerKwh: z.number().int().min(1).max(10_000).nullable().optional(),
    startDate: isoDate,
    endDate: isoDate.nullable().optional(),
    notes: note,
  })
  .refine(
    (c) =>
      c.kind === "power"
        ? !!c.watts && !!c.priceDeciCentsPerKwh
        : c.amountCents != null && !!c.period,
    { message: "Enter watts and price for power, or an amount and how often for other costs" },
  );

export function registerSavingsRoutes(app: FastifyInstance, db: MunyDb) {
  const log = (userId: string, action: string, entityId?: string, details?: unknown) =>
    audit(db, {
      actorType: "user",
      actorId: userId,
      action,
      entityType: "saving",
      entityId,
      details,
    });

  app.get("/api/savings/accounts", async () => savingsAccountsReport(db));

  app.put("/api/savings/accounts/:id/apy", async (req) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    const { apyBps } = parse(
      z.object({ apyBps: z.number().int().min(0).max(5000).nullable() }),
      req.body,
    );
    if (!setAccountApy(db, id, apyBps)) throw notFound("Savings account not found");
    log(user.id, "savings.apy", id, { apyBps });
    return { ok: true };
  });

  // Categories inside an account, with what each holds.
  app.get("/api/savings/accounts/:id/buckets", async (req) => {
    const { id } = parse(IdParams, req.params);
    const b = bucketsFor(db, id);
    if (!b) throw notFound("Savings account not found");
    return b;
  });

  app.put("/api/savings/accounts/:id/buckets", async (req) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    const cents = z.number().int().min(-100_000_000_000).max(100_000_000_000);
    const body = parse(
      z.object({
        buckets: z
          .array(
            z.object({
              id: z.string().max(64).optional(),
              name: z.string().trim().min(1, "Name each category").max(60),
              balanceCents: cents,
              goalCents: cents.min(0).nullable().optional(),
              monthlyCapCents: cents.min(0).nullable().optional(),
              fillRemaining: z.boolean().optional(),
              isMain: z.boolean().optional(),
            }),
          )
          .refine((l) => l.filter((b) => b.isMain).length <= 1, "Only one main cash")
          .max(30),
        mode: z.enum(["moves", "split"]).optional(),
      }),
      req.body,
    );
    if (!setBuckets(db, id, body.buckets)) throw notFound("Savings account not found");
    if (body.mode) setPlanMode(db, id, body.mode);
    log(user.id, "savings.buckets", id, { count: body.buckets.length });
    return bucketsFor(db, id);
  });

  app.put("/api/savings/accounts/:id/plan", async (req) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    const body = parse(
      z.object({
        monthlyCents: z.number().int().min(0).max(100_000_000).nullable(),
        rateBps: z.number().int().min(0).max(5000).nullable().optional(),
      }),
      req.body,
    );
    const plan =
      body.monthlyCents === null
        ? null
        : { monthlyCents: body.monthlyCents, rateBps: body.rateBps ?? null };
    if (!setSavingsPlan(db, id, plan)) throw notFound("Savings account not found");
    log(user.id, "savings.plan", id, plan);
    return { ok: true };
  });

  app.get("/api/savings", async () => listSavings(db));
  app.get("/api/savings/summary", async () => savingsSummary(db));
  app.get("/api/savings/alternatives", async () => alternativeSuggestions(db));

  app.post("/api/savings", async (req, reply) => {
    const user = requireUser(req);
    const body = parse(SavingBody, req.body);
    if (!body.seriesId && !body.name)
      throw badRequest("Name the saving or pick a recurring charge");
    if (!body.seriesId && body.beforeMonthlyCents === undefined)
      throw badRequest("Enter what it cost per month before");
    let id: string;
    try {
      id = createSaving(db, body);
    } catch (err) {
      throw notFound(err instanceof Error ? err.message : "Not found");
    }
    verifySavings(db);
    log(user.id, "saving.create", id, { kind: body.kind });
    reply.code(201);
    return listSavings(db).find((s) => s.id === id);
  });

  app.patch("/api/savings/:id", async (req) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(100).optional(),
        beforeMonthlyCents: cents.optional(),
        afterMonthlyCents: cents.optional(),
        effectiveDate: isoDate.optional(),
        notes: note,
        /** Confirm or reset by hand (for savings with no recurring charge to check). */
        status: z.enum(["projected", "verified", "failed"]).optional(),
      }),
      req.body,
    );
    const changes = db
      .update(schema.savings)
      .set({
        ...body,
        ...(body.status
          ? {
              statusNote: body.status === "verified" ? "Confirmed by you" : null,
              verifiedAt: new Date(),
            }
          : {}),
      })
      .where(eq(schema.savings.id, id))
      .run().changes;
    if (!changes) throw notFound("Saving not found");
    log(user.id, "saving.update", id);
    return listSavings(db).find((s) => s.id === id);
  });

  app.delete("/api/savings/:id", async (req) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    if (db.delete(schema.savings).where(eq(schema.savings.id, id)).run().changes === 0)
      throw notFound("Saving not found");
    log(user.id, "saving.delete", id);
    return { ok: true };
  });

  app.post("/api/savings/verify", async (req) => {
    requireUser(req);
    return { changed: verifySavings(db) };
  });

  // --- DIY projects ---------------------------------------------------------------

  app.get("/api/diy", async () => listDiy(db));

  app.post("/api/diy", async (req, reply) => {
    const user = requireUser(req);
    const body = parse(DiyBody, req.body);
    const id = newId();
    db.insert(schema.diyProjects)
      .values({
        id,
        serviceName: body.serviceName,
        seriesId: body.seriesId ?? null,
        alternative: body.alternative,
        status: body.status ?? "idea",
        effort: body.effort ?? null,
        runningMonthlyCents: body.runningMonthlyCents ?? 0,
        notes: body.notes || null,
      })
      .run();
    onDiyStatus(db, id);
    log(user.id, "diy.create", id);
    reply.code(201);
    return listDiy(db).find((p) => p.id === id);
  });

  app.patch("/api/diy/:id", async (req) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    const body = parse(DiyBody.partial(), req.body);
    const changes = db
      .update(schema.diyProjects)
      .set({ ...body, ...(body.notes !== undefined ? { notes: body.notes || null } : {}) })
      .where(eq(schema.diyProjects.id, id))
      .run().changes;
    if (!changes) throw notFound("Project not found");
    onDiyStatus(db, id);
    log(user.id, "diy.update", id, { status: body.status });
    return listDiy(db).find((p) => p.id === id);
  });

  app.delete("/api/diy/:id", async (req) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    if (db.delete(schema.diyProjects).where(eq(schema.diyProjects.id, id)).run().changes === 0)
      throw notFound("Project not found");
    log(user.id, "diy.delete", id);
    return { ok: true };
  });

  // --- Self-hosting costs ---------------------------------------------------------

  app.get("/api/infra", async () => listInfra(db));

  app.post("/api/infra", async (req, reply) => {
    const user = requireUser(req);
    const body = parse(InfraBody, req.body);
    const id = newId();
    db.insert(schema.infraCosts)
      .values({ id, ...body, notes: body.notes || null })
      .run();
    log(user.id, "infra.create", id, { kind: body.kind });
    reply.code(201);
    return listInfra(db).find((c) => c.id === id);
  });

  app.put("/api/infra/:id", async (req) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    const body = parse(InfraBody, req.body);
    const changes = db
      .update(schema.infraCosts)
      .set({
        amountCents: null,
        period: null,
        amortizeMonths: null,
        watts: null,
        priceDeciCentsPerKwh: null,
        endDate: null,
        ...body,
        notes: body.notes || null,
      })
      .where(eq(schema.infraCosts.id, id))
      .run().changes;
    if (!changes) throw notFound("Cost not found");
    log(user.id, "infra.update", id);
    return listInfra(db).find((c) => c.id === id);
  });

  app.delete("/api/infra/:id", async (req) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    if (db.delete(schema.infraCosts).where(eq(schema.infraCosts.id, id)).run().changes === 0)
      throw notFound("Cost not found");
    log(user.id, "infra.delete", id);
    return { ok: true };
  });
}

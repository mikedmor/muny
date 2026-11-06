import { type MunyDb, schema } from "@muny/db";
import { DEFAULT_LOAN_PLAN, LOAN_KINDS, type LoanPlanSettings } from "@muny/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/plugin.js";
import { audit } from "../lib/audit.js";
import { notFound, parse } from "../lib/http.js";
import {
  createManualLoan,
  loansReport,
  removeLenderFee,
  setLenderFee,
  updateLoan,
} from "./service.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const cents = z.number().int().min(0).max(100_000_000_000);
const Details = z.object({
  kind: z.enum(LOAN_KINDS).optional(),
  lender: z.string().trim().max(100).nullable().optional(),
  aprBps: z.number().int().min(0).max(10_000).nullable().optional(),
  monthlyPaymentCents: cents.nullable().optional(),
  nextDueDate: isoDate.nullable().optional(),
  originalPrincipalCents: cents.nullable().optional(),
  originationDate: isoDate.nullable().optional(),
  termMonths: z.number().int().min(1).max(600).nullable().optional(),
  paymentMatch: z.string().trim().max(80).nullable().optional(),
  startBalanceCents: cents.nullable().optional(),
  startDate: isoDate.nullable().optional(),
  paymentAmountCents: cents.nullable().optional(),
  pastPaymentAmounts: z.array(cents).max(12).nullable().optional(),
  minimumPaymentCents: cents.nullable().optional(),
  originalValueCents: cents.nullable().optional(),
  pmiMonthlyCents: cents.nullable().optional(),
  propertyAccountId: z.string().max(64).nullable().optional(),
});
const Fee = z.object({
  lender: z.string().trim().min(1, "Name the lender").max(100),
  paymentMatch: z.string().trim().max(80).nullable().optional(),
  minCents: cents.min(1, "Enter the fee amount"),
  nextDueDate: isoDate.nullable().optional(),
});
const id = z.string().min(1).max(64);
const Plan = z.object({
  strategy: z.enum(["avalanche", "snowball", "custom"]),
  extraCents: cents.max(10_000_000),
  order: z.array(id).max(100),
  minimumsOnly: z.boolean(),
  excluded: z.array(id).max(100),
  included: z.array(id).max(100),
  debtFreeBy: isoDate.nullable(),
  targets: z.record(id, isoDate).refine((t) => Object.keys(t).length <= 100),
});
const PLAN_KEY = "loans.plan";

/** The saved payoff plan, with defaults for anything missing. */
function readPlan(db: MunyDb): LoanPlanSettings {
  const row = db
    .select()
    .from(schema.appSettings)
    .where(eq(schema.appSettings.key, PLAN_KEY))
    .get();
  return { ...DEFAULT_LOAN_PLAN, ...((row?.value ?? {}) as Partial<LoanPlanSettings>) };
}

const Create = Details.extend({
  name: z.string().trim().min(1, "Name the loan").max(100),
  startBalanceCents: cents,
});

export function registerLoanRoutes(app: FastifyInstance, db: MunyDb) {
  const log = (userId: string, action: string, entityId?: string, details?: unknown) =>
    audit(db, {
      actorType: "user",
      actorId: userId,
      action,
      entityType: "loan",
      entityId,
      details,
    });

  app.get("/api/loans", async (req) => {
    requireUser(req);
    return loansReport(db);
  });

  app.post("/api/loans", async (req) => {
    const user = requireUser(req);
    const body = parse(Create, req.body);
    const id = db.transaction((tx) => createManualLoan(tx as unknown as MunyDb, body));
    log(user.id, "loan.create", id, { kind: body.kind });
    return { accountId: id };
  });

  // The payoff plan (goals and order for paying loans off): settings only, nothing is paid.
  app.get("/api/loans/plan", async (req) => {
    requireUser(req);
    return readPlan(db);
  });

  app.put("/api/loans/plan", async (req) => {
    const user = requireUser(req);
    const value = parse(Plan, req.body);
    db.insert(schema.appSettings)
      .values({ key: PLAN_KEY, value })
      .onConflictDoUpdate({ target: schema.appSettings.key, set: { value } })
      .run();
    log(user.id, "loan.plan.update");
    return value;
  });

  // A lender's yearly fee (dues, maintenance): one per lender.
  app.put("/api/loans/lender-fees", async (req) => {
    const user = requireUser(req);
    const body = parse(Fee, req.body);
    const key = db.transaction((tx) => setLenderFee(tx as unknown as MunyDb, body));
    log(user.id, "loan.lender_fee.set", key);
    return { ok: true };
  });

  app.delete("/api/loans/lender-fees", async (req) => {
    const user = requireUser(req);
    const { lender } = parse(z.object({ lender: z.string().trim().min(1).max(100) }), req.query);
    if (!db.transaction((tx) => removeLenderFee(tx as unknown as MunyDb, lender)))
      throw notFound("No yearly fee for that lender");
    log(user.id, "loan.lender_fee.remove", lender.toLowerCase());
    return { ok: true };
  });

  app.patch("/api/loans/:accountId", async (req) => {
    const user = requireUser(req);
    const { accountId } = parse(z.object({ accountId: z.string().min(1).max(64) }), req.params);
    const body = parse(Details, req.body);
    if (!db.transaction((tx) => updateLoan(tx as unknown as MunyDb, accountId, body)))
      throw notFound("Loan not found");
    log(user.id, "loan.update", accountId, Object.keys(body));
    return { ok: true };
  });
}

import { type MunyDb, schema } from "@muny/db";
import { DEFAULT_LOAN_PLAN, LOAN_KINDS, type LoanPlanSettings } from "@muny/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/plugin.js";
import { saveDocument } from "../documents/service.js";
import { audit } from "../lib/audit.js";
import { badRequest, notFound, parse } from "../lib/http.js";
import {
  applyStatement,
  createLenderLoans,
  createManualLoan,
  loansReport,
  previewStatement,
  removeLenderFee,
  setLenderFee,
  setLenderPayments,
  setServicerSplit,
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
  rollover: z.boolean().default(true),
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

const dueDay = z.number().int().min(1).max(31).nullable().optional();
const words = z.string().trim().max(80).nullable().optional();
const parts = z
  .record(z.string().min(1).max(64), cents.min(1))
  .refine(
    (p) => Object.keys(p).length >= 1 && Object.keys(p).length <= 30,
    "Give each payment its loans",
  );
const LenderPayments = z.object({
  lender: z.string().trim().min(1, "Name the lender").max(100),
  payments: z
    .array(
      z.object({
        paymentMatch: words,
        dueDay,
        startDate: isoDate.nullable().optional(),
        endDate: isoDate.nullable().optional(),
        parts,
      }),
    )
    .max(24),
});
const Batch = z.object({
  lender: z.string().trim().min(1, "Name the lender").max(100),
  kind: z.enum(LOAN_KINDS).optional(),
  paymentMatch: words,
  startDate: isoDate.nullable().optional(),
  loans: z
    .array(
      z.object({
        name: z.string().trim().min(1, "Name each loan").max(100),
        startBalanceCents: cents,
        aprBps: z.number().int().min(0).max(10_000).nullable().optional(),
        nextDueDate: isoDate.nullable().optional(),
      }),
    )
    .min(1)
    .max(30),
  payments: z.array(z.object({ paymentMatch: words, dueDay, parts })).max(12),
});

const money = z.number().int().min(-100_000_000_000).max(100_000_000_000).nullable();
const Statement = z.object({
  statementDate: isoDate,
  lastPayment: z.object({ date: isoDate, amountCents: cents }).nullable(),
  groups: z
    .array(
      z.object({
        name: z.string().regex(/^[A-Z0-9]{1,4}$/),
        aprBps: z.number().int().min(0).max(10_000).nullable(),
        originalPrincipalCents: money,
        firstDisbursed: isoDate.nullable(),
        principalCents: money,
        accruedInterestCents: money,
        monthlyPaymentCents: money,
        paymentsLeft: z.number().int().min(0).max(1000).nullable(),
        paidCents: money,
        paidInterestCents: money,
        paidPrincipalCents: money,
        amountDueCents: money,
        dueDate: isoDate.nullable(),
      }),
    )
    .min(1)
    .max(30),
});

const Create = Details.extend({
  name: z.string().trim().min(1, "Name the loan").max(100),
  startBalanceCents: cents,
});

export function registerLoanRoutes(
  app: FastifyInstance,
  db: MunyDb,
  /** For keeping imported statements encrypted (Documents). */
  secret?: Buffer,
) {
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

  // Several loans from one lender, and the payments that cover them.
  app.post("/api/loans/batch", async (req) => {
    const user = requireUser(req);
    const body = parse(Batch, req.body);
    const ids = db.transaction((tx) => createLenderLoans(tx as unknown as MunyDb, body));
    for (const id of ids) log(user.id, "loan.create", id, { kind: body.kind });
    return { accountIds: ids };
  });

  // A lender's payments, each covering several of its loans (replaces them all).
  app.put("/api/loans/lender-payments", async (req) => {
    const user = requireUser(req);
    const body = parse(LenderPayments, req.body);
    db.transaction((tx) => setLenderPayments(tx as unknown as MunyDb, body.lender, body.payments));
    log(user.id, "loan.lender_payments.set", body.lender.toLowerCase());
    return { ok: true };
  });

  // Statements (PDF): read one, then bring the lender's loans in line with it.
  // The PDF is read in memory only; nothing of it is stored or logged.
  app.post("/api/loans/statements/preview", async (req) => {
    requireUser(req);
    const body = parse(
      z.object({
        lender: z.string().trim().min(1).max(100),
        pdfBase64: z.string().min(10).max(14_000_000, "The PDF is too large (10 MB max)"),
      }),
      req.body,
    );
    const bytes = new Uint8Array(Buffer.from(body.pdfBase64, "base64"));
    if (bytes[0] !== 0x25 || bytes[1] !== 0x50) throw badRequest("That isn't a PDF.");
    const preview = await previewStatement(db, body.lender, bytes);
    if (!preview)
      throw badRequest(
        "Couldn't read loan groups from that PDF. It needs the statement's account snapshot page.",
      );
    return preview;
  });

  app.post("/api/loans/statements/apply", async (req) => {
    const user = requireUser(req);
    const body = parse(
      z.object({
        lender: z.string().trim().min(1).max(100),
        statement: Statement,
        mapping: z.record(z.string().max(4), z.string().min(1).max(64)),
        /** The PDF, to keep under Documents. */
        pdfBase64: z.string().min(10).max(14_000_000).optional(),
        fileName: z.string().trim().max(200).optional(),
      }),
      req.body,
    );
    if (body.pdfBase64) {
      const bytes = Buffer.from(body.pdfBase64, "base64");
      if (bytes.subarray(0, 4).toString("latin1") === "%PDF")
        saveDocument(db, secret, {
          name: body.fileName || `${body.lender} statement ${body.statement.statementDate}.pdf`,
          mime: "application/pdf",
          bytes,
          kind: "loan_statement",
          lender: body.lender,
          documentDate: body.statement.statementDate,
        });
    }
    const ids = db.transaction((tx) =>
      applyStatement(tx as unknown as MunyDb, body.lender, body.statement, body.mapping),
    );
    log(user.id, "loan.statement.apply", body.lender.toLowerCase(), {
      statementDate: body.statement.statementDate,
      loans: ids.length,
    });
    return { accountIds: ids };
  });

  // How a lender's payments are split: like a servicer (from statements) or by set amounts.
  app.put("/api/loans/lender-split", async (req) => {
    const user = requireUser(req);
    const body = parse(
      z.object({
        lender: z.string().trim().min(1).max(100),
        mode: z.enum(["servicer", "parts"]),
      }),
      req.body,
    );
    db.transaction((tx) =>
      setServicerSplit(tx as unknown as MunyDb, body.lender, body.mode === "servicer"),
    );
    log(user.id, "loan.lender_split.set", body.lender.toLowerCase(), { mode: body.mode });
    return { ok: true };
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

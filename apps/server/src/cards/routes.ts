import type { MunyDb } from "@muny/db";
import type { CardStatementPreview } from "@muny/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/plugin.js";
import { saveDocument } from "../documents/service.js";
import { linkTransfersFor } from "../ledger/transfers.js";
import { audit } from "../lib/audit.js";
import { badRequest, notFound, parse } from "../lib/http.js";
import { pdfLines } from "../loans/statements.js";
import { runRulesOn } from "../rules/service.js";
import {
  addStatementTransactions,
  applyCardStatement,
  cardForText,
  cardsReport,
  parseCardStatement,
  updateCard,
} from "./service.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const cents = z.number().int().min(0).max(100_000_000_000);
const Details = z.object({
  issuer: z.string().trim().max(100).nullable().optional(),
  creditLimitCents: cents.nullable().optional(),
  aprBps: z.number().int().min(0).max(10_000).nullable().optional(),
  statementBalanceCents: z
    .number()
    .int()
    .min(-100_000_000_000)
    .max(100_000_000_000)
    .nullable()
    .optional(),
  statementDate: isoDate.nullable().optional(),
  minimumPaymentCents: cents.nullable().optional(),
  dueDate: isoDate.nullable().optional(),
  paymentMatch: z.string().trim().max(80).nullable().optional(),
});
const Statement = z.object({
  closingDate: isoDate.nullable(),
  dueDate: isoDate.nullable(),
  newBalanceCents: z.number().int().min(-100_000_000_000).max(100_000_000_000).nullable(),
  minimumPaymentCents: cents.nullable(),
  creditLimitCents: cents.nullable(),
  aprBps: z.number().int().min(0).max(10_000).nullable(),
  previousBalanceCents: z.number().int().min(-100_000_000_000).max(100_000_000_000).nullable(),
  paymentsCents: cents.nullable(),
  interestYtd: z.object({ year: z.number().int().min(1990).max(2100), cents }).nullable(),
  minimumOnly: z
    .object({ months: z.number().int().min(0).max(1200), totalCents: cents })
    .nullable(),
  transactions: z
    .array(
      z.object({
        date: isoDate,
        description: z.string().trim().min(1).max(200),
        amountCents: z.number().int().min(-100_000_000_000).max(100_000_000_000),
      }),
    )
    .max(2000),
});
const pdf = z.string().min(10).max(14_000_000, "The PDF is too large (10 MB max)");

export function registerCardRoutes(app: FastifyInstance, db: MunyDb, secret?: Buffer) {
  const log = (userId: string, action: string, entityId?: string) =>
    audit(db, { actorType: "user", actorId: userId, action, entityType: "card", entityId });

  app.get("/api/cards", async (req) => {
    requireUser(req);
    return cardsReport(db);
  });

  app.patch("/api/cards/:accountId", async (req) => {
    const user = requireUser(req);
    const { accountId } = parse(z.object({ accountId: z.string().min(1).max(64) }), req.params);
    if (!updateCard(db, accountId, parse(Details, req.body))) throw notFound("Card not found");
    log(user.id, "card.update", accountId);
    return { ok: true };
  });

  // Statement PDFs: read in memory; the card number is only used to pick the card.
  app.post("/api/cards/statements/preview", async (req): Promise<CardStatementPreview> => {
    requireUser(req);
    const body = parse(z.object({ pdfBase64: pdf }), req.body);
    const bytes = new Uint8Array(Buffer.from(body.pdfBase64, "base64"));
    if (bytes[0] !== 0x25 || bytes[1] !== 0x50) throw badRequest("That isn't a PDF.");
    let text = "";
    try {
      text = (await pdfLines(bytes)).map((l) => l.join(" ")).join("\n");
    } catch {
      throw badRequest("Couldn't read that PDF.");
    }
    const statement = parseCardStatement(text);
    if (!statement)
      throw badRequest("Couldn't find a balance or due date in that PDF. Is it a card statement?");
    return { statement, accountId: cardForText(db, text) };
  });

  app.post("/api/cards/statements/apply", async (req) => {
    const user = requireUser(req);
    const body = parse(
      z.object({
        accountId: z.string().min(1).max(64),
        statement: Statement,
        pdfBase64: pdf.optional(),
        fileName: z.string().trim().max(200).optional(),
        cardName: z.string().trim().max(100).optional(),
        /** Add the statement's transactions to the card (those not there yet). */
        addTransactions: z.boolean().default(true),
      }),
      req.body,
    );
    if (
      !db.transaction((tx) =>
        applyCardStatement(tx as unknown as MunyDb, body.accountId, body.statement),
      )
    )
      throw notFound("Card not found");
    if (body.addTransactions && body.statement.transactions.length)
      db.transaction((tx) => {
        const ids = addStatementTransactions(
          tx as unknown as MunyDb,
          body.accountId,
          body.statement.transactions,
        );
        runRulesOn(tx, ids);
        linkTransfersFor(tx, ids);
      });
    if (body.pdfBase64) {
      const bytes = Buffer.from(body.pdfBase64, "base64");
      if (bytes.subarray(0, 4).toString("latin1") === "%PDF")
        saveDocument(db, secret, {
          name: body.fileName || `Card statement ${body.statement.closingDate ?? ""}.pdf`,
          mime: "application/pdf",
          bytes,
          kind: "card_statement",
          lender: body.cardName ?? null,
          documentDate: body.statement.closingDate,
        });
    }
    log(user.id, "card.statement.apply", body.accountId);
    return { ok: true };
  });
}

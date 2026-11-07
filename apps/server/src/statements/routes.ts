import { type MunyDb, schema } from "@muny/db";
import type { StatementPreview, StatementStatus } from "@muny/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/plugin.js";
import { saveDocument } from "../documents/service.js";
import { audit } from "../lib/audit.js";
import { badRequest, notFound, parse } from "../lib/http.js";
import { pdfLines } from "../loans/statements.js";
import { detectStatement } from "./detect.js";
import { statementStatus } from "./status.js";
import { deleteTemplate, listTemplates, saveTemplate } from "./templates.js";

/**
 * Statement templates (how to read statements the built-in readers miss).
 * Plain JSON in and out, so an assistant can set them up through the API too.
 */

const Body = z.object({
  kind: z.enum(["card", "loan"]),
  name: z.string().trim().min(1, "Name it").max(100),
  matchText: z.string().trim().min(3, "Give text that's on these statements").max(200),
  fields: z
    .record(z.string().max(40), z.object({ label: z.string().trim().max(120) }))
    .refine((f) => Object.keys(f).length <= 20),
});
const IdParams = z.object({ id: z.string().min(1).max(64) });
const pdf = z.string().min(10).max(14_000_000, "The PDF is too large (10 MB max)");
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

function pdfBytes(base64: string) {
  const bytes = Buffer.from(base64, "base64");
  if (bytes.subarray(0, 4).toString("latin1") !== "%PDF") throw badRequest("That isn't a PDF.");
  return bytes;
}

export function registerStatementTemplateRoutes(
  app: FastifyInstance,
  db: MunyDb,
  secret: Buffer | undefined,
) {
  const log = (userId: string, action: string, entityId?: string) =>
    audit(db, {
      actorType: "user",
      actorId: userId,
      action,
      entityType: "statement_template",
      entityId,
    });

  /** Each account's newest statement and the monthly ones missing. */
  app.get("/api/statements/status", async (req): Promise<StatementStatus[]> => {
    requireUser(req);
    return statementStatus(db);
  });

  /** Any statement PDF: what it is and which account it's for (read in memory). */
  app.post("/api/statements/preview", async (req): Promise<StatementPreview> => {
    requireUser(req);
    const body = parse(z.object({ pdfBase64: pdf }), req.body);
    const bytes = new Uint8Array(pdfBytes(body.pdfBase64));
    let rows: string[][];
    try {
      rows = await pdfLines(bytes);
    } catch {
      throw badRequest("Couldn't read that PDF.");
    }
    return detectStatement(db, rows);
  });

  /** Keep a statement in Documents for an account without reading it. */
  app.post("/api/accounts/:id/statements", async (req) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    const body = parse(
      z.object({
        pdfBase64: pdf,
        fileName: z.string().trim().max(200).optional(),
        statementDate: isoDate,
      }),
      req.body,
    );
    const acc = db
      .select({
        name: schema.accounts.name,
        type: schema.accounts.type,
        institution: schema.accounts.institutionName,
        lender: schema.loanDetails.lender,
      })
      .from(schema.accounts)
      .leftJoin(schema.loanDetails, eq(schema.loanDetails.accountId, schema.accounts.id))
      .where(eq(schema.accounts.id, id))
      .get();
    if (!acc) throw notFound("Account not found");
    const doc = saveDocument(db, secret, {
      name: body.fileName || `${acc.name} statement ${body.statementDate}.pdf`,
      mime: "application/pdf",
      bytes: pdfBytes(body.pdfBase64),
      kind:
        acc.type === "credit" ? "card_statement" : acc.type === "loan" ? "loan_statement" : "other",
      lender:
        acc.type === "credit"
          ? acc.name
          : acc.type === "loan"
            ? (acc.lender ?? acc.institution ?? acc.name)
            : null,
      folder: `Statements / ${acc.name}`,
      documentDate: body.statementDate,
      accountId: id,
    });
    audit(db, {
      actorType: "user",
      actorId: user.id,
      action: "statement.store",
      entityType: "document",
      entityId: doc.id,
    });
    return doc;
  });

  app.get("/api/statement-templates", async (req) => {
    requireUser(req);
    const { kind } = parse(z.object({ kind: z.enum(["card", "loan"]).optional() }), req.query);
    return listTemplates(db, kind);
  });

  app.post("/api/statement-templates", async (req) => {
    const user = requireUser(req);
    const t = saveTemplate(db, parse(Body, req.body));
    log(user.id, "statement_template.create", t.id);
    return t;
  });

  app.put("/api/statement-templates/:id", async (req) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    if (!listTemplates(db).some((t) => t.id === id)) throw notFound("Template not found");
    const t = saveTemplate(db, parse(Body, req.body), id);
    log(user.id, "statement_template.update", id);
    return t;
  });

  app.delete("/api/statement-templates/:id", async (req) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    if (!deleteTemplate(db, id)) throw notFound("Template not found");
    log(user.id, "statement_template.delete", id);
    return { ok: true };
  });
}

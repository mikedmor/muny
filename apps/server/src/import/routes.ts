import type { MunyDb } from "@muny/db";
import { DATE_FORMATS } from "@muny/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/plugin.js";
import { audit } from "../lib/audit.js";
import { parse } from "../lib/http.js";
import { detectImportFile } from "./detect.js";
import { commitImport, previewImport } from "./service.js";

const MAX_CONTENT = 20 * 1024 * 1024; // 20 MB of text

const column = z.string().trim().min(1).max(100);
const optColumn = z
  .string()
  .trim()
  .max(100)
  .optional()
  .transform((v) => v || undefined);

const CsvMapping = z
  .object({
    date: column,
    dateFormat: z.enum(DATE_FORMATS),
    description: column,
    descriptionFallback: optColumn,
    amount: optColumn,
    negate: z.boolean().optional(),
    debit: optColumn,
    credit: optColumn,
    authorizedDate: optColumn,
    category: optColumn,
    notes: optColumn,
    filters: z
      .array(
        z.object({
          column,
          op: z.enum(["in", "notIn"]),
          values: z.array(z.string().max(100)).max(20),
        }),
      )
      .max(10)
      .optional(),
  })
  .refine((m) => m.amount || m.debit || m.credit, {
    message: "Choose an amount column, or debit/credit columns",
  });

const ImportBody = z.object({
  filename: z.string().trim().min(1).max(255),
  content: z.string().min(1, "The file is empty").max(MAX_CONTENT, "File is too large (20 MB max)"),
  format: z.enum(["rocket_money", "csv", "ofx"]).optional(),
  csv: CsvMapping.optional(),
});

const CommitBody = ImportBody.extend({
  accountMap: z.record(z.string(), z.string().min(1).max(64)),
  applyBalances: z.array(z.string().max(64)).max(100).optional(),
});

export function registerImportRoutes(app: FastifyInstance, db: MunyDb) {
  /** Which importer a text file belongs to (nothing is saved). */
  app.post("/api/import/detect", async (req) => {
    requireUser(req);
    const body = parse(
      z.object({ content: z.string().max(20_000_000), filename: z.string().max(300).optional() }),
      req.body,
    );
    return detectImportFile(body.content, body.filename);
  });

  app.post("/api/import/preview", async (req) => {
    requireUser(req);
    return previewImport(db, parse(ImportBody, req.body));
  });

  app.post("/api/import/commit", async (req) => {
    const user = requireUser(req);
    const body = parse(CommitBody, req.body);
    const result = commitImport(db, body, user.id);
    // Never log file contents; only the summary.
    audit(db, {
      actorType: "user",
      actorId: user.id,
      action: "import.commit",
      entityType: "import_batch",
      entityId: result.batchId,
      details: { filename: body.filename, ...result },
    });
    return result;
  });
}

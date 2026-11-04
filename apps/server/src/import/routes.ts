import type { MunyDb } from "@muny/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/plugin.js";
import { audit } from "../lib/audit.js";
import { parse } from "../lib/http.js";
import { commitImport, previewImport } from "./service.js";

const MAX_CONTENT = 20 * 1024 * 1024; // 20 MB of text

const ImportBody = z.object({
  filename: z.string().trim().min(1).max(255),
  content: z.string().min(1, "The file is empty").max(MAX_CONTENT, "File is too large (20 MB max)"),
  format: z.enum(["rocket_money", "csv", "ofx"]).optional(),
});

const CommitBody = ImportBody.extend({
  accountMap: z.record(z.string(), z.string().min(1).max(64)),
});

export function registerImportRoutes(app: FastifyInstance, db: MunyDb) {
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

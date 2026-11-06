import type { MunyDb } from "@muny/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/plugin.js";
import { audit } from "../lib/audit.js";
import { badRequest, parse } from "../lib/http.js";
import { importInvestFile, investSummary, listInvestTxns, previewInvestImport } from "./service.js";

const Content = z.string().min(1, "The file is empty").max(20_000_000);
const PreviewBody = z.object({ content: Content });
const CommitBody = z.object({
  content: Content,
  /** File account ref → Muny account id, or "new"; leave one out to skip it. */
  targets: z.record(z.string().max(200), z.string().min(1).max(64)),
});
const TxnQuery = z.object({
  accountId: z.string().max(64).optional(),
  before: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

export function registerInvestRoutes(app: FastifyInstance, db: MunyDb) {
  const readable = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : "Couldn't read the file");
    }
  };

  app.get("/api/invest/summary", async (req) => {
    requireUser(req);
    return investSummary(db);
  });

  app.get("/api/invest/transactions", async (req) => {
    requireUser(req);
    return listInvestTxns(db, parse(TxnQuery, req.query));
  });

  app.post("/api/invest/import/preview", async (req) => {
    requireUser(req);
    const body = parse(PreviewBody, req.body);
    return readable(() => previewInvestImport(db, body.content));
  });

  app.post("/api/invest/import/commit", async (req) => {
    const user = requireUser(req);
    const body = parse(CommitBody, req.body);
    const res = readable(() =>
      db.transaction((tx) => importInvestFile(tx, body.content, body.targets)),
    );
    audit(db, {
      actorType: "user",
      actorId: user.id,
      action: "invest.import",
      entityType: "investment",
      details: res,
    });
    return res;
  });
}

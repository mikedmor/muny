import { type MunyDb, schema } from "@muny/db";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/plugin.js";
import { BudgetError } from "../crypto/budget.js";
import { audit } from "../lib/audit.js";
import { badRequest, parse } from "../lib/http.js";
import { backfillInvestHistory, type HistoryDeps } from "./history.js";
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

export function registerInvestRoutes(app: FastifyInstance, db: MunyDb, deps: HistoryDeps = {}) {
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

  /** Fill in value history from trades and past closes (fetches ticker prices; opt-in by pressing the button). */
  app.post("/api/invest/history/backfill", async (req) => {
    const user = requireUser(req);
    try {
      const res = await backfillInvestHistory(db, deps);
      audit(db, {
        actorType: "user",
        actorId: user.id,
        action: "invest.backfill",
        entityType: "investment",
        details: { accounts: res.accounts, tickers: res.tickers, points: res.points },
      });
      return res;
    } catch (e) {
      if (e instanceof BudgetError) throw badRequest(e.message);
      throw e;
    }
  });

  app.get("/api/invest/securities/:id/prices", async (req) => {
    requireUser(req);
    const { id } = parse(z.object({ id: z.string().min(1).max(64) }), req.params);
    const p = schema.securityPrices;
    return db
      .select({ date: p.date, close: p.close })
      .from(p)
      .where(eq(p.securityId, id))
      .orderBy(p.date)
      .all();
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

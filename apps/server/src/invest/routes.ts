import { type MunyDb, schema } from "@muny/db";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/plugin.js";
import { BudgetError } from "../crypto/budget.js";
import { audit } from "../lib/audit.js";
import { badRequest, parse } from "../lib/http.js";
import { backfillInvestHistory, type HistoryDeps } from "./history.js";
import { getInvestSettings, logoFor, setInvestSettings } from "./logos.js";
import { marketIntraday, marketOverview } from "./market.js";
import {
  importInvestFile,
  investSummary,
  listInvestTxns,
  previewInvestImport,
  setHoldingCost,
} from "./service.js";
import {
  addToWatchlist,
  listWatchlist,
  refreshWatchlist,
  removeFromWatchlist,
} from "./watchlist.js";

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

  // --- Watch list -----------------------------------------------------------

  app.get("/api/invest/watchlist", async (req) => {
    requireUser(req);
    return listWatchlist(db);
  });

  app.post("/api/invest/watchlist", async (req) => {
    const user = requireUser(req);
    const { symbol } = parse(z.object({ symbol: z.string().trim().min(1).max(12) }), req.body);
    try {
      const id = await addToWatchlist(db, deps, symbol);
      audit(db, {
        actorType: "user",
        actorId: user.id,
        action: "invest.watch.add",
        entityType: "security",
        entityId: id,
      });
      return { securityId: id };
    } catch (e) {
      throw badRequest(e instanceof Error ? e.message : "Couldn't add it");
    }
  });

  app.delete("/api/invest/watchlist/:id", async (req) => {
    const user = requireUser(req);
    const { id } = parse(z.object({ id: z.string().min(1).max(64) }), req.params);
    removeFromWatchlist(db, id);
    audit(db, {
      actorType: "user",
      actorId: user.id,
      action: "invest.watch.remove",
      entityType: "security",
      entityId: id,
    });
    return { ok: true };
  });

  /** Called by the page when the list is stale: at most once a day. */
  app.post("/api/invest/watchlist/refresh", async (req) => {
    requireUser(req);
    return refreshWatchlist(db, deps);
  });

  /** What you paid for a holding (for brokers that don't report it); null clears it. */
  app.put("/api/invest/holdings/:accountId/:securityId/cost", async (req) => {
    const user = requireUser(req);
    const { accountId, securityId } = parse(
      z.object({ accountId: z.string().min(1).max(64), securityId: z.string().min(1).max(64) }),
      req.params,
    );
    const body = parse(
      z.object({
        totalCents: z.number().int().min(0).max(100_000_000_000).optional(),
        perShare: z
          .string()
          .regex(/^\d{1,9}(\.\d{1,6})?$/, "Enter a price like 12.34")
          .optional(),
        clear: z.boolean().optional(),
      }),
      req.body,
    );
    const input = body.clear
      ? null
      : body.totalCents !== undefined
        ? { totalCents: body.totalCents }
        : body.perShare !== undefined
          ? { perShare: body.perShare }
          : undefined;
    if (input === undefined) throw badRequest("Enter what you paid");
    if (!setHoldingCost(db, accountId, securityId, input))
      throw badRequest("That account doesn't hold this");
    audit(db, {
      actorType: "user",
      actorId: user.id,
      action: "invest.cost",
      entityType: "security",
      entityId: securityId,
      details: { accountId, cleared: input === null },
    });
    return { ok: true };
  });

  // --- Settings, logos and the market overview (opt-in) ------------------------

  app.get("/api/invest/settings", async (req) => {
    requireUser(req);
    return getInvestSettings(db);
  });

  app.put("/api/invest/settings", async (req) => {
    const user = requireUser(req);
    const body = parse(
      z.object({ logos: z.boolean().optional(), market: z.boolean().optional() }),
      req.body,
    );
    const next = setInvestSettings(db, body);
    audit(db, {
      actorType: "user",
      actorId: user.id,
      action: "invest.settings",
      entityType: "settings",
      details: body,
    });
    return next;
  });

  app.get("/api/invest/logo/:symbol", async (req, reply) => {
    requireUser(req);
    const { symbol } = parse(z.object({ symbol: z.string().min(1).max(12) }), req.params);
    const img = await logoFor(db, deps, symbol.toUpperCase());
    if (!img) return reply.code(404).header("cache-control", "private, max-age=3600").send();
    return reply
      .header("content-type", img.type)
      .header("cache-control", "private, max-age=604800")
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'; sandbox")
      .send(img.body);
  });

  app.get("/api/invest/market", async (req) => {
    requireUser(req);
    if (!getInvestSettings(db).market) throw badRequest("Turn on the market overview first");
    return marketOverview(db, deps);
  });

  app.get("/api/invest/market/intraday", async (req) => {
    requireUser(req);
    if (!getInvestSettings(db).market) throw badRequest("Turn on the market overview first");
    const { symbol } = parse(z.object({ symbol: z.string().min(1).max(8) }), req.query);
    try {
      return await marketIntraday(db, deps, symbol);
    } catch (e) {
      throw badRequest(e instanceof Error ? e.message : "Couldn't load it");
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

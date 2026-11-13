import { type MunyDb, schema } from "@muny/db";
import { INVEST_TXN_TYPES, TAX_TREATMENTS } from "@muny/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/plugin.js";
import { BudgetError } from "../crypto/budget.js";
import { audit } from "../lib/audit.js";
import { badRequest, parse } from "../lib/http.js";
import { describeChange } from "../undo/track.js";
import {
  DocError,
  deleteB1099,
  form8949Csv,
  listB1099,
  readB1099File,
  saveB1099,
  setB1099Summary,
} from "./b1099.js";
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
import { STOCK_SYMBOL, stockPage } from "./stock.js";
import { reconcileReport, stockTaxReport } from "./tax.js";
import {
  addInvestTxn,
  deleteInvestTxn,
  pageInvestTxns,
  setTaxTreatment,
  TxnError,
} from "./txns.js";
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

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Year = z.object({ year: z.coerce.number().int().min(2000).max(2100) });
const Id = z.object({ id: z.string().min(1).max(64) });
const Shares = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,10})?$/, "Enter a number of shares like 10 or 2.5");
const TxnPageQuery = z.object({
  accountId: z.string().max(64).optional(),
  securityId: z.string().max(64).optional(),
  type: z.enum(INVEST_TXN_TYPES).optional(),
  from: Day.optional(),
  to: Day.optional(),
  q: z.string().max(100).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
const NewTxn = z.object({
  accountId: z.string().min(1).max(64),
  type: z.enum(INVEST_TXN_TYPES),
  date: Day,
  symbol: z
    .string()
    .trim()
    .regex(/^[A-Za-z][A-Za-z0-9.-]{0,9}$/, "Enter a ticker like VTI")
    .optional(),
  quantity: Shares.optional(),
  price: z
    .string()
    .regex(/^\d{1,9}(\.\d{1,6})?$/, "Enter a price like 12.34")
    .optional(),
  totalCents: z.number().int().min(0).max(100_000_000_000).optional(),
  feesCents: z.number().int().min(0).max(100_000_000).optional(),
  description: z.string().max(200).optional(),
});
const Cents = z.number().int().min(-1e13).max(1e13);
const Totals = z.object({
  proceedsCents: Cents,
  costCents: Cents,
  washCents: Cents,
  gainCents: Cents,
  count: z.number().int().min(0).max(1e6).default(0),
});
const SummaryBody = z.object({
  summary: z.partialRecord(z.enum(["A", "B", "C", "D", "E", "F", "?"]), Totals),
});
const DocBody = z.object({
  accountId: z.string().min(1).max(64),
  filename: z.string().min(1).max(200),
  contentType: z.string().max(100),
  base64: z.string().min(1).max(15_000_000),
});

export interface InvestDeps extends HistoryDeps {
  secretKey?: Buffer;
}

export function registerInvestRoutes(app: FastifyInstance, db: MunyDb, deps: InvestDeps = {}) {
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
      z.object({
        logos: z.boolean().optional(),
        market: z.boolean().optional(),
        details: z.boolean().optional(),
      }),
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

  /** One stock's page; ?refresh=1 fetches the live details again. */
  app.get("/api/invest/stock/:symbol", async (req) => {
    requireUser(req);
    const { symbol } = parse(
      z.object({
        symbol: z
          .string()
          .transform((s) => s.trim().toUpperCase())
          .pipe(z.string().regex(STOCK_SYMBOL, "That isn't a ticker")),
      }),
      req.params,
    );
    const { refresh } = parse(z.object({ refresh: z.string().optional() }), req.query);
    return stockPage(db, deps, symbol, { refresh: !!refresh });
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

  // --- Taxes (D-088) -------------------------------------------------------------

  app.get("/api/invest/tax/:year", async (req) => {
    requireUser(req);
    return stockTaxReport(db, parse(Year, req.params).year);
  });

  app.get("/api/invest/reconcile", async (req) => {
    requireUser(req);
    return reconcileReport(db);
  });

  app.put("/api/invest/accounts/:id/tax-treatment", async (req) => {
    const user = requireUser(req);
    const { id } = parse(Id, req.params);
    const { treatment } = parse(
      z.object({ treatment: z.enum(TAX_TREATMENTS).nullable() }),
      req.body,
    );
    if (!setTaxTreatment(db, id, treatment)) throw badRequest("That isn't an investment account");
    describeChange(db, "Changed how an account is taxed");
    audit(db, {
      actorType: "user",
      actorId: user.id,
      action: "invest.tax_treatment",
      entityType: "account",
      entityId: id,
      details: { treatment },
    });
    return { ok: true };
  });

  // --- Transactions ----------------------------------------------------------------

  app.get("/api/invest/txns", async (req) => {
    requireUser(req);
    return pageInvestTxns(db, parse(TxnPageQuery, req.query));
  });

  app.post("/api/invest/txns", async (req) => {
    const user = requireUser(req);
    const body = parse(NewTxn, req.body);
    try {
      const res = addInvestTxn(db, body);
      describeChange(
        db,
        `Added a ${body.type.replace("_", " ")}${body.symbol ? ` of ${body.symbol.toUpperCase()}` : ""}`,
      );
      audit(db, {
        actorType: "user",
        actorId: user.id,
        action: "invest.txn_add",
        entityType: "investment",
        entityId: res.id,
        details: { type: body.type, accountId: body.accountId },
      });
      return res;
    } catch (e) {
      if (e instanceof TxnError) throw badRequest(e.message);
      throw e;
    }
  });

  app.delete("/api/invest/txns/:id", async (req) => {
    const user = requireUser(req);
    const { id } = parse(Id, req.params);
    const res = deleteInvestTxn(db, id);
    if (res === "ok") describeChange(db, "Deleted a stock transaction");
    if (res === "missing") throw badRequest("That transaction is gone");
    if (res === "synced")
      throw badRequest(
        "This came from your broker's sync and would only come back. Fix it at the broker.",
      );
    audit(db, {
      actorType: "user",
      actorId: user.id,
      action: "invest.txn_delete",
      entityType: "investment",
      entityId: id,
    });
    return { ok: true };
  });

  // --- 1099-B forms ----------------------------------------------------------------

  app.get("/api/invest/tax/:year/docs", async (req) => {
    requireUser(req);
    return listB1099(db, parse(Year, req.params).year);
  });

  app.post("/api/invest/tax/:year/docs", async (req) => {
    const user = requireUser(req);
    const { year } = parse(Year, req.params);
    const body = parse(DocBody, req.body);
    try {
      const res = await saveB1099(db, deps.secretKey, { ...body, year });
      describeChange(db, `Added a ${year} 1099-B`);
      audit(db, {
        actorType: "user",
        actorId: user.id,
        action: "invest.b1099_upload",
        entityType: "account",
        entityId: body.accountId,
        details: { year },
      });
      return res;
    } catch (e) {
      if (e instanceof DocError) throw badRequest(e.message);
      throw e;
    }
  });

  app.get("/api/invest/tax/docs/:id/file", async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(Id, req.params);
    let file: ReturnType<typeof readB1099File>;
    try {
      file = readB1099File(db, deps.secretKey, id);
    } catch (e) {
      throw badRequest(e instanceof Error ? e.message : "Couldn't open the file");
    }
    if (!file) throw badRequest("That form is gone");
    audit(db, {
      actorType: "user",
      actorId: user.id,
      action: "invest.b1099_view",
      entityType: "document",
      entityId: id,
    });
    return reply
      .header("content-type", file.contentType)
      .header("content-disposition", `inline; filename="${file.filename.replace(/"/g, "")}"`)
      .header("x-content-type-options", "nosniff")
      .send(file.body);
  });

  app.put("/api/invest/tax/docs/:id/summary", async (req) => {
    const user = requireUser(req);
    const { id } = parse(Id, req.params);
    const { summary } = parse(SummaryBody, req.body);
    if (!setB1099Summary(db, id, summary)) throw badRequest("That form is gone");
    describeChange(db, "Entered 1099-B totals");
    audit(db, {
      actorType: "user",
      actorId: user.id,
      action: "invest.b1099_summary",
      entityType: "document",
      entityId: id,
    });
    return { ok: true };
  });

  app.delete("/api/invest/tax/docs/:id", async (req) => {
    const user = requireUser(req);
    const { id } = parse(Id, req.params);
    if (!deleteB1099(db, id)) throw badRequest("That form is gone");
    describeChange(db, "Deleted a 1099-B");
    audit(db, {
      actorType: "user",
      actorId: user.id,
      action: "invest.b1099_delete",
      entityType: "document",
      entityId: id,
    });
    return { ok: true };
  });

  app.get("/api/invest/tax/:year/8949.csv", async (req, reply) => {
    const user = requireUser(req);
    const { year } = parse(Year, req.params);
    audit(db, {
      actorType: "user",
      actorId: user.id,
      action: "invest.export_8949",
      entityType: "investment",
      details: { year },
    });
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="stocks-form-8949-${year}.csv"`)
      .send(form8949Csv(db, year));
  });
}

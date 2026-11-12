import type { MunyDb } from "@muny/db";
import {
  type LiveKey,
  type LiveQuote,
  type LiveSettings,
  liveKey,
  PRICE_ALERT_CONDITIONS,
  PRICE_ALERT_LABELS,
} from "@muny/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AlertDeps } from "../alerts/service.js";
import { requireOwner, requireUser } from "../auth/plugin.js";
import { audit } from "../lib/audit.js";
import { badRequest, HttpError, notFound, parse } from "../lib/http.js";
import {
  alertKeys,
  checkPriceAlerts,
  deletePriceAlert,
  listPriceAlerts,
  savePriceAlert,
} from "./alerts.js";
import { type LiveHub, parseKeys } from "./hub.js";
import { LiveSetupError, readLive, updateLive } from "./settings.js";

/**
 * Live prices (a stream to open pages) and price alerts. Reading prices is
 * for anyone signed in; the Finnhub key is the owner's to change.
 */

const SymbolParam = z
  .string()
  .trim()
  .transform((s) => s.toUpperCase())
  .pipe(z.string().regex(/^\^?[A-Z0-9][A-Z0-9.-]{0,14}$/, "That isn't a ticker or coin"));

export function registerLiveRoutes(
  app: FastifyInstance,
  db: MunyDb,
  hub: LiveHub,
  deps: { secretKey: Buffer | undefined; alerts: AlertDeps },
) {
  const settings = (): LiveSettings => {
    const s = readLive(db);
    return {
      stocks: s.stocks,
      crypto: s.crypto,
      hasFinnhubKey: !!s.finnhubKeyEnc,
      canStoreKey: !!deps.secretKey,
      yahooEveryMinutes: hub.yahooMinutes(),
      lastError: hub.lastError,
    };
  };
  const refreshAlertKeys = () => hub.setAlertKeys(alertKeys(db));
  refreshAlertKeys();
  // Every price is checked against the alerts on it.
  hub.subscribe((q) => checkPriceAlerts(db, q, deps.alerts));

  app.get("/api/live", async (req) => {
    requireUser(req);
    return settings();
  });

  app.put("/api/live", async (req) => {
    const user = requireOwner(req);
    const body = parse(
      z.object({
        stocks: z.boolean().optional(),
        crypto: z.boolean().optional(),
        finnhubKey: z.string().max(200).nullable().optional(),
      }),
      req.body,
    );
    try {
      updateLive(db, deps.secretKey, body);
    } catch (err) {
      if (err instanceof LiveSetupError) throw new HttpError(409, err.message);
      throw err;
    }
    audit(db, {
      actorType: "user",
      actorId: user.id,
      action: "live.settings",
      entityType: "settings",
      // Never the key itself.
      details: {
        stocks: body.stocks,
        crypto: body.crypto,
        finnhubKey:
          body.finnhubKey === undefined ? undefined : body.finnhubKey ? "changed" : "removed",
      },
    });
    void hub.sync();
    return settings();
  });

  /** The latest prices Muny has for these, without waiting for new ones. */
  app.get("/api/live/quotes", async (req): Promise<LiveQuote[]> => {
    requireUser(req);
    const { keys } = parse(z.object({ keys: z.string().max(4000).default("") }), req.query);
    return parseKeys(keys).flatMap((k) => hub.quotes.get(k) ?? []);
  });

  /**
   * Server-sent events: each new price for these, while the page is open.
   * Starts with the prices already known.
   */
  app.get("/api/live/stream", async (req, reply) => {
    requireUser(req);
    const { keys } = parse(z.object({ keys: z.string().max(4000).default("") }), req.query);
    const list = parseKeys(keys);
    const wanted = new Set<LiveKey>(list);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const send = (q: LiveQuote) => res.write(`data: ${JSON.stringify(q)}\n\n`);
    res.write(`event: ready\ndata: ${JSON.stringify(settings())}\n\n`);
    for (const k of list) {
      const q = hub.quotes.get(k);
      if (q) send(q);
    }
    const stopListening = hub.subscribe((q) => {
      if (wanted.has(q.key)) send(q);
    });
    const unwatch = hub.watch(list);
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    ping.unref?.();
    req.raw.on("close", () => {
      clearInterval(ping);
      stopListening();
      unwatch();
    });
  });

  // --- Price alerts ---------------------------------------------------------

  const Input = z.object({
    kind: z.enum(["stock", "crypto"]),
    symbol: SymbolParam,
    condition: z.enum(PRICE_ALERT_CONDITIONS),
    value: z.number().positive().max(1e12).nullable().optional(),
    note: z.string().trim().max(200).nullable().optional(),
    repeat: z.boolean().optional(),
    enabled: z.boolean().optional(),
    /** The price you see now, for "since now" alerts when Muny has none yet. */
    basePrice: z.number().positive().max(1e12).nullable().optional(),
  });

  const check = (b: z.infer<typeof Input>) => {
    const meta = PRICE_ALERT_LABELS[b.condition];
    if (meta.unit && (b.value === null || b.value === undefined))
      throw badRequest(meta.unit === "price" ? "Give a price." : "Give a percent.");
    if (meta.stocksOnly && b.kind !== "stock") throw badRequest("That's for stocks only.");
    if (meta.unit === "percent" && (b.value as number) > 1000)
      throw badRequest("That's too big a percent.");
  };

  app.get("/api/price-alerts", async (req) => {
    requireUser(req);
    const q = parse(
      z.object({ kind: z.enum(["stock", "crypto"]).optional(), symbol: SymbolParam.optional() }),
      req.query,
    );
    return listPriceAlerts(db, q.kind && q.symbol ? liveKey(q.kind, q.symbol) : undefined);
  });

  app.post("/api/price-alerts", async (req) => {
    requireUser(req);
    const body = parse(Input, req.body);
    check(body);
    const now = hub.quotes.get(liveKey(body.kind, body.symbol));
    const basePrice =
      now?.price ?? body.basePrice ?? (body.kind === "stock" ? hub.storedClose(body.symbol) : null);
    if ((body.condition === "move_up" || body.condition === "move_down") && !basePrice)
      throw badRequest("Muny doesn't have a price for it yet to measure the move from.");
    const a = savePriceAlert(db, { ...body, basePrice });
    refreshAlertKeys();
    // Already true? Say so now rather than at the next price.
    if (now) checkPriceAlerts(db, now, deps.alerts);
    return listPriceAlerts(db, liveKey(a.kind, a.symbol)).find((x) => x.id === a.id) ?? a;
  });

  app.put("/api/price-alerts/:id", async (req) => {
    requireUser(req);
    const { id } = parse(z.object({ id: z.string().min(1).max(64) }), req.params);
    if (!listPriceAlerts(db).some((a) => a.id === id)) throw notFound("Alert not found");
    const body = parse(Input, req.body);
    check(body);
    const a = savePriceAlert(db, body, id);
    refreshAlertKeys();
    return a;
  });

  app.delete("/api/price-alerts/:id", async (req) => {
    requireUser(req);
    const { id } = parse(z.object({ id: z.string().min(1).max(64) }), req.params);
    if (!deletePriceAlert(db, id)) throw notFound("Alert not found");
    refreshAlertKeys();
    return { ok: true };
  });
}

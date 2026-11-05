import { normDec } from "@muny/core";
import { type MunyDb, newId, schema } from "@muny/db";
import type { CryptoTxnType } from "@muny/shared";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/plugin.js";
import { audit } from "../lib/audit.js";
import { badRequest, notFound, parse } from "../lib/http.js";
import {
  getCryptoSettings,
  type PriceDeps,
  priceState,
  refreshPrices,
  saveCryptoSettings,
} from "./prices.js";
import {
  createWallet,
  cryptoOverview,
  importKoinly,
  listTxns,
  listWallets,
  previewKoinly,
} from "./service.js";

const IdParams = z.object({ id: z.string().min(1).max(64) });
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const asset = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9.\-_]{1,20}$/, "Use a ticker like BTC");
const amount = z
  .string()
  .trim()
  .refine((s) => {
    try {
      return normDec(s) !== "0" && !normDec(s).startsWith("-");
    } catch {
      return false;
    }
  }, "Enter a positive amount");
const CSV_MAX = 20 * 1024 * 1024;

export function registerCryptoRoutes(app: FastifyInstance, db: MunyDb, priceDeps: PriceDeps) {
  const log = (userId: string, action: string, entityId?: string, details?: unknown) =>
    audit(db, {
      actorType: "user",
      actorId: userId,
      action,
      entityType: "crypto",
      entityId,
      details,
    });

  app.get("/api/crypto/overview", async () => {
    const st = priceState(db);
    return cryptoOverview(db, {
      pricesEnabled: getCryptoSettings(db).pricesEnabled,
      pricesUpdatedAt: st.updatedAt,
      change24h: st.change24h,
    });
  });

  // --- Wallets ---------------------------------------------------------------

  app.get("/api/crypto/wallets", async () => listWallets(db));

  app.post("/api/crypto/wallets", async (req, reply) => {
    const user = requireUser(req);
    const body = parse(
      z.object({
        name: z.string().trim().min(1, "Name the wallet").max(80),
        kind: z.enum(["blockchain", "exchange", "manual"]),
        chain: z.string().trim().max(20).nullable().optional(),
      }),
      req.body,
    );
    const id = createWallet(db, body);
    log(user.id, "crypto.wallet_add", id, { kind: body.kind });
    reply.code(201);
    return listWallets(db).find((x) => x.id === id);
  });

  app.patch("/api/crypto/wallets/:id", async (req) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    const body = parse(z.object({ name: z.string().trim().min(1).max(80).optional() }), req.body);
    const n = db
      .update(schema.cryptoWallets)
      .set(body)
      .where(eq(schema.cryptoWallets.id, id))
      .run().changes;
    if (!n) throw notFound("Wallet not found");
    log(user.id, "crypto.wallet_update", id);
    return listWallets(db).find((x) => x.id === id);
  });

  app.delete("/api/crypto/wallets/:id", async (req) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    // Transactions cascade; transfer partners in other wallets are unlinked (set null).
    const n = db.delete(schema.cryptoWallets).where(eq(schema.cryptoWallets.id, id)).run().changes;
    if (!n) throw notFound("Wallet not found");
    log(user.id, "crypto.wallet_delete", id);
    return { ok: true };
  });

  // --- Transactions ------------------------------------------------------------

  app.get("/api/crypto/txns", async (req) => {
    const q = parse(
      z.object({
        walletId: z.string().max(64).optional(),
        asset: z.string().max(20).optional(),
        type: z.enum(["deposit", "withdrawal", "trade", "transfer"]).optional(),
        label: z.string().max(30).optional(),
        from: isoDate.optional(),
        to: isoDate.optional(),
        offset: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(500).default(50),
      }),
      req.query,
    );
    return listTxns(db, q);
  });

  /** Add a transaction by hand. */
  app.post("/api/crypto/txns", async (req, reply) => {
    const user = requireUser(req);
    const body = parse(
      z.object({
        walletId: z.string().min(1).max(64),
        at: z.number().int().min(946_684_800_000).max(4_102_444_800_000),
        type: z.enum(["deposit", "withdrawal", "trade"]),
        label: z.string().trim().max(30).nullable().optional(),
        sentAsset: asset.nullable().optional(),
        sentAmount: amount.nullable().optional(),
        receivedAsset: asset.nullable().optional(),
        receivedAmount: amount.nullable().optional(),
        feeAsset: asset.nullable().optional(),
        feeAmount: amount.nullable().optional(),
        valueCents: z.number().int().min(0).max(1e13).nullable().optional(),
        description: z.string().trim().max(500).nullable().optional(),
      }),
      req.body,
    );
    const needSent = body.type !== "deposit";
    const needReceived = body.type !== "withdrawal";
    if (needSent && !(body.sentAsset && body.sentAmount)) throw badRequest("Enter what was sent");
    if (needReceived && !(body.receivedAsset && body.receivedAmount))
      throw badRequest("Enter what was received");
    if (!!body.feeAsset !== !!body.feeAmount)
      throw badRequest("Enter both the fee amount and coin");
    const wallet = db
      .select({ id: schema.cryptoWallets.id })
      .from(schema.cryptoWallets)
      .where(eq(schema.cryptoWallets.id, body.walletId))
      .get();
    if (!wallet) throw notFound("Wallet not found");
    const id = newId();
    db.insert(schema.cryptoTxns)
      .values({
        id,
        walletId: body.walletId,
        at: body.at,
        type: body.type as CryptoTxnType,
        label: body.label || null,
        sentAsset: needSent ? (body.sentAsset ?? null) : null,
        sentAmount: needSent && body.sentAmount ? normDec(body.sentAmount) : null,
        receivedAsset: needReceived ? (body.receivedAsset ?? null) : null,
        receivedAmount: needReceived && body.receivedAmount ? normDec(body.receivedAmount) : null,
        feeAsset: body.feeAsset ?? null,
        feeAmount: body.feeAmount ? normDec(body.feeAmount) : null,
        valueCents: body.valueCents ?? null,
        description: body.description || null,
        externalId: `manual:${id}`,
        source: "manual",
      })
      .run();
    log(user.id, "crypto.txn_add", id);
    reply.code(201);
    return { id };
  });

  /** Relabel or describe a transaction (amounts of synced/imported ones aren't editable). */
  app.patch("/api/crypto/txns/:id", async (req) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    const body = parse(
      z.object({
        label: z.string().trim().max(30).nullable().optional(),
        description: z.string().trim().max(500).nullable().optional(),
      }),
      req.body,
    );
    const n = db
      .update(schema.cryptoTxns)
      .set({
        ...(body.label !== undefined ? { label: body.label || null } : {}),
        ...(body.description !== undefined ? { description: body.description || null } : {}),
        userModified: true,
      })
      .where(eq(schema.cryptoTxns.id, id))
      .run().changes;
    if (!n) throw notFound("Transaction not found");
    log(user.id, "crypto.txn_update", id);
    return { ok: true };
  });

  app.delete("/api/crypto/txns/:id", async (req) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    const n = db
      .delete(schema.cryptoTxns)
      .where(and(eq(schema.cryptoTxns.id, id), eq(schema.cryptoTxns.source, "manual")))
      .run().changes;
    if (!n) throw badRequest("Only transactions you added by hand can be deleted");
    log(user.id, "crypto.txn_delete", id);
    return { ok: true };
  });

  // --- Import ------------------------------------------------------------------

  const ImportBody = z.object({
    format: z.literal("koinly"),
    content: z.string().min(1).max(CSV_MAX),
  });
  const parseOr400 = <T>(fn: () => T) => {
    try {
      return fn();
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : "Couldn't read the file");
    }
  };

  app.post("/api/crypto/import/preview", async (req) => {
    requireUser(req);
    const body = parse(ImportBody, req.body);
    return parseOr400(() => previewKoinly(db, body.content));
  });

  app.post("/api/crypto/import/commit", async (req) => {
    const user = requireUser(req);
    const body = parse(ImportBody, req.body);
    const res = parseOr400(() => db.transaction((tx) => importKoinly(tx, body.content)));
    log(user.id, "crypto.import", undefined, {
      format: body.format,
      imported: res.imported,
      duplicates: res.duplicates,
    });
    return res;
  });

  // --- Settings & prices --------------------------------------------------------

  app.get("/api/crypto/settings", async () => ({ ...getCryptoSettings(db), ...priceState(db) }));

  app.put("/api/crypto/settings", async (req) => {
    const user = requireUser(req);
    const body = parse(
      z.object({
        pricesEnabled: z.boolean().optional(),
        assetIds: z
          .record(
            asset,
            z
              .string()
              .trim()
              .regex(/^[a-z0-9-]{1,80}$/),
          )
          .optional(),
        apiKey: z.string().trim().max(200).nullable().optional(),
      }),
      req.body,
    );
    try {
      saveCryptoSettings(db, body, priceDeps.secretKey);
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : "Couldn't save");
    }
    log(user.id, "crypto.settings", undefined, { pricesEnabled: body.pricesEnabled });
    if (body.pricesEnabled)
      void refreshPrices(db, { ...priceDeps, delayMs: priceDeps.delayMs ?? 2500 }).catch(() => {});
    return { ...getCryptoSettings(db), ...priceState(db) };
  });

  app.post("/api/crypto/prices/refresh", async (req) => {
    requireUser(req);
    if (!getCryptoSettings(db).pricesEnabled) throw badRequest("Turn on prices first");
    try {
      return await refreshPrices(db, priceDeps);
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : "Price update failed");
    }
  });
}

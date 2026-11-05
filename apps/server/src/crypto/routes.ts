import { CHAINS, type ChainKey, normDec } from "@muny/core";
import { type MunyDb, newId, schema } from "@muny/db";
import type { CryptoTxnType } from "@muny/shared";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/plugin.js";
import { audit } from "../lib/audit.js";
import { badRequest, notFound, parse } from "../lib/http.js";
import { usage } from "./budget.js";
import {
  getCryptoSettings,
  type PriceDeps,
  priceState,
  pricesDue,
  pricesRefreshing,
  refreshPrices,
  saveCryptoSettings,
} from "./prices.js";
import {
  addAdjustment,
  addOpeningBalance,
  linkTransfer,
  mergeWallets,
  moveCrossChain,
  reconcileReport,
  removeDuplicates,
  removeRows,
} from "./reconcile.js";
import {
  createWallet,
  cryptoOverview,
  importKoinly,
  listTxns,
  listWallets,
  previewKoinly,
} from "./service.js";
import {
  isSyncing,
  removeWalletSource,
  SyncError,
  setWalletSource,
  syncAll,
  syncMany,
  syncWallet,
  walletsDue,
} from "./sync.js";

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
const chainKey = z.enum(Object.keys(CHAINS) as [ChainKey, ...ChainKey[]]);
const SourceBody = z.object({ chain: chainKey, source: z.string().trim().min(10).max(200) });

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

  const bg = { ...priceDeps, delayMs: priceDeps.delayMs ?? 1500 };
  const quiet = (p: Promise<unknown>) => void p.catch(() => {});
  /**
   * No timers: when someone opens the crypto pages, refresh what is due today
   * (prices once per day, each synced wallet once per day) in the background.
   */
  const daily = () => {
    const due = walletsDue(db);
    if (due.length && !isSyncing())
      quiet(
        (async () => {
          await syncMany(db, due, bg);
          // After syncing (new coins may need prices); a same-day repeat only fills gaps.
          if (pricesDue(db)) await refreshPrices(db, bg);
        })(),
      );
    else if (pricesDue(db)) quiet(refreshPrices(db, bg));
  };

  app.get("/api/crypto/overview", async () => {
    daily();
    const st = priceState(db);
    const synced = db
      .select({ at: sql<number | null>`max(${schema.cryptoWallets.lastSyncAt})` })
      .from(schema.cryptoWallets)
      .where(eq(schema.cryptoWallets.status, "ok"))
      .get();
    return {
      ...cryptoOverview(db, {
        pricesEnabled: getCryptoSettings(db).pricesEnabled,
        pricesUpdatedAt: st.updatedAt,
        change24h: st.change24h,
        mcap: st.mcap ?? {},
      }),
      pricesRefreshing: pricesRefreshing(),
      syncing: isSyncing(),
      walletsSyncedAt: synced?.at ?? null,
    };
  });

  // --- Wallets ---------------------------------------------------------------

  app.get("/api/crypto/wallets", async () => {
    daily();
    return listWallets(db);
  });

  const syncErr = (fn: () => void) => {
    try {
      fn();
    } catch (err) {
      throw badRequest(err instanceof SyncError ? err.message : "Couldn't save the address");
    }
  };

  /** Sync this wallet from a public address / xpub (opt-in; stored encrypted). */
  app.put("/api/crypto/wallets/:id/source", async (req) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    const body = parse(SourceBody, req.body);
    syncErr(() => setWalletSource(db, id, body, priceDeps.secretKey));
    log(user.id, "crypto.wallet_source", id, { chain: body.chain });
    quiet(syncWallet(db, id, bg).then(() => refreshPrices(db, bg)));
    return listWallets(db).find((x) => x.id === id);
  });

  app.delete("/api/crypto/wallets/:id/source", async (req) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    removeWalletSource(db, id);
    log(user.id, "crypto.wallet_source_remove", id);
    return listWallets(db).find((x) => x.id === id);
  });

  app.post("/api/crypto/wallets/:id/sync", async (req) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    try {
      // Paced (but quicker than background syncs) to stay inside rate limits.
      const res = await syncWallet(db, id, { ...priceDeps, delayMs: priceDeps.delayMs ?? 500 });
      log(user.id, "crypto.wallet_sync", id, res);
      if (res.added) quiet(refreshPrices(db, bg));
      return res;
    } catch (err) {
      throw badRequest(err instanceof SyncError ? err.message : "Sync failed");
    }
  });

  /** Sync every wallet (runs in the background; poll the wallets list). */
  app.post("/api/crypto/sync", async (req, reply) => {
    const user = requireUser(req);
    log(user.id, "crypto.sync_all");
    if (!isSyncing())
      quiet(syncAll(db, bg).then((r) => (r.added ? refreshPrices(db, bg) : undefined)));
    reply.code(202);
    return { started: true };
  });

  app.post("/api/crypto/wallets", async (req, reply) => {
    const user = requireUser(req);
    const body = parse(
      z.object({
        name: z.string().trim().min(1, "Name the wallet").max(80),
        kind: z.enum(["blockchain", "exchange", "manual"]),
        chain: z.string().trim().max(20).nullable().optional(),
        /** Optional address / xpub to sync from (needs a chain). */
        source: z.string().trim().min(10).max(200).optional(),
      }),
      req.body,
    );
    let src: z.infer<typeof SourceBody> | null = null;
    if (body.source) {
      const c = chainKey.safeParse(body.chain);
      if (!c.success) throw badRequest("Pick the blockchain for this address");
      const info = CHAINS[c.data];
      // Validate before creating anything.
      if (!info.validate(body.source))
        throw badRequest(`That doesn't look like a ${info.name} address (${info.accepts})`);
      if (!priceDeps.secretKey)
        throw badRequest("Set MUNY_SECRET_KEY first: the address is stored encrypted.");
      src = { chain: c.data, source: body.source };
    }
    const id = createWallet(db, { name: body.name, kind: body.kind, chain: body.chain });
    if (src) {
      const source = src;
      syncErr(() => setWalletSource(db, id, source, priceDeps.secretKey));
      quiet(syncWallet(db, id, bg).then(() => refreshPrices(db, bg)));
    }
    log(user.id, "crypto.wallet_add", id, { kind: body.kind, synced: !!src });
    reply.code(201);
    return listWallets(db).find((x) => x.id === id);
  });

  app.patch("/api/crypto/wallets/:id", async (req) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(80).optional(),
        syncEnabled: z.boolean().optional(),
      }),
      req.body,
    );
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

  // --- Reconcile ---------------------------------------------------------------

  app.get("/api/crypto/reconcile", async () => reconcileReport(db, priceDeps.secretKey));

  const fix = <T>(fn: () => T) => {
    try {
      return fn();
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : "Couldn't apply that fix");
    }
  };

  /** Merge wallets that sync the same address into one. */
  app.post("/api/crypto/reconcile/merge", async (req) => {
    const user = requireUser(req);
    const body = parse(
      z.object({
        into: z.string().min(1).max(64),
        from: z.array(z.string().min(1).max(64)).min(1).max(20),
      }),
      req.body,
    );
    const res = fix(() => mergeWallets(db, body.into, body.from));
    log(user.id, "crypto.reconcile_merge", body.into, { from: body.from.length, ...res });
    return res;
  });

  app.post("/api/crypto/reconcile/duplicates", async (req) => {
    const user = requireUser(req);
    const body = parse(z.object({ walletId: z.string().min(1).max(64) }), req.body);
    const res = removeDuplicates(db, body.walletId);
    log(user.id, "crypto.reconcile_duplicates", body.walletId, res);
    return res;
  });

  app.post("/api/crypto/reconcile/link", async (req) => {
    const user = requireUser(req);
    const body = parse(
      z.object({ walletId: z.string().min(1).max(64), txnId: z.string().min(1).max(64) }),
      req.body,
    );
    const res = fix(() => linkTransfer(db, body.walletId, body.txnId));
    log(user.id, "crypto.reconcile_link", body.walletId, { txnId: body.txnId });
    return res;
  });

  /** Move swap proceeds to the wallet they arrived in (one or many). */
  app.post("/api/crypto/reconcile/crosschain", async (req) => {
    const user = requireUser(req);
    const body = parse(
      z.object({
        moves: z
          .array(
            z.object({
              txnId: z.string().min(1).max(64),
              toTxnId: z.string().min(1).max(64).nullable(),
              toWalletId: z.string().min(1).max(64),
            }),
          )
          .min(1)
          .max(500),
      }),
      req.body,
    );
    const res = fix(() => body.moves.map((m) => moveCrossChain(db, m.txnId, m)));
    log(user.id, "crypto.reconcile_crosschain", undefined, { count: res.length });
    return { moved: res.length };
  });

  app.post("/api/crypto/reconcile/remove", async (req) => {
    const user = requireUser(req);
    const body = parse(
      z.object({
        walletId: z.string().min(1).max(64),
        txnIds: z.array(z.string().min(1).max(64)).min(1).max(20),
      }),
      req.body,
    );
    const res = removeRows(db, body.walletId, body.txnIds);
    log(user.id, "crypto.reconcile_remove", body.walletId, res);
    return res;
  });

  app.post("/api/crypto/reconcile/adjust", async (req) => {
    const user = requireUser(req);
    const body = parse(
      z.object({ walletId: z.string().min(1).max(64), asset, amount, staking: z.boolean() }),
      req.body,
    );
    const res = addAdjustment(db, body);
    log(user.id, "crypto.reconcile_adjust", body.walletId, {
      asset: body.asset,
      staking: body.staking,
    });
    return res;
  });

  app.post("/api/crypto/reconcile/opening", async (req) => {
    const user = requireUser(req);
    const body = parse(
      z.object({
        walletId: z.string().min(1).max(64),
        asset,
        amount,
        at: z.number().int().min(0).max(4_102_444_800_000),
      }),
      req.body,
    );
    const res = fix(() => addOpeningBalance(db, body));
    log(user.id, "crypto.reconcile_opening", body.walletId, { asset: body.asset });
    return res;
  });

  // --- Import ------------------------------------------------------------------

  const ImportBody = z.object({
    format: z.literal("koinly"),
    content: z.string().min(1).max(CSV_MAX),
    /** Koinly wallet name → Muny wallet id, or "new". */
    mapping: z.record(z.string().max(120), z.string().min(1).max(64)).optional(),
    replace: z.boolean().optional(),
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
    const res = parseOr400(() =>
      db.transaction((tx) =>
        importKoinly(tx, body.content, { mapping: body.mapping, replace: body.replace }),
      ),
    );
    log(user.id, "crypto.import", undefined, {
      format: body.format,
      imported: res.imported,
      duplicates: res.duplicates,
      replaced: res.replaced,
    });
    return res;
  });

  // --- Settings & prices --------------------------------------------------------

  const settingsView = () => ({ ...getCryptoSettings(db), ...priceState(db), usage: usage(db) });
  app.get("/api/crypto/settings", async () => settingsView());

  app.put("/api/crypto/settings", async (req) => {
    const user = requireUser(req);
    const body = parse(
      z.object({
        pricesEnabled: z.boolean().optional(),
        provider: z.enum(["defillama", "coingecko"]).optional(),
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
        blockscoutKey: z.string().trim().max(200).nullable().optional(),
        hiddenAssets: z.array(asset).max(500).optional(),
        servers: z
          .partialRecord(
            chainKey,
            z
              .string()
              .trim()
              .max(200)
              .regex(
                /^(https?:\/\/[^\s/]+(\/\S*)?)?$/,
                "Enter a URL like https://blockbook.example",
              ),
          )
          .optional(),
      }),
      req.body,
    );
    if (body.servers)
      body.servers = Object.fromEntries(
        Object.entries(body.servers).filter(([, v]) => v),
      ) as typeof body.servers;
    try {
      saveCryptoSettings(db, body, priceDeps.secretKey);
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : "Couldn't save");
    }
    log(user.id, "crypto.settings", undefined, {
      pricesEnabled: body.pricesEnabled,
      provider: body.provider,
    });
    if (body.pricesEnabled || body.provider) quiet(refreshPrices(db, bg));
    return settingsView();
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

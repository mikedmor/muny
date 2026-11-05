import { CHAINS, type ChainKey, type SyncedTxn, sourceHint } from "@muny/core";
import { type MunyDb, newId, schema } from "@muny/db";
import type { CryptoSyncResult } from "@muny/shared";
import { and, eq, sql } from "drizzle-orm";
import { decryptJson, encryptJson } from "../lib/crypto.js";
import type { BudgetProvider } from "./budget.js";
import { algorand } from "./chains/algorand.js";
import { blockbook } from "./chains/blockbook.js";
import { blockcypher, unsupported } from "./chains/blockcypher.js";
import { blockscout } from "./chains/blockscout.js";
import { cardano } from "./chains/cardano.js";
import { cosmos } from "./chains/cosmos.js";
import {
  type Adapter,
  type Cursor,
  makeCtx,
  type SyncDeps,
  SyncError,
  safeText,
} from "./chains/ctx.js";
import { esplora } from "./chains/esplora.js";
import { sia } from "./chains/sia.js";
import { stellar } from "./chains/stellar.js";
import { tron } from "./chains/tron.js";
import { binanceus } from "./exchanges/binanceus.js";
import { coinbase } from "./exchanges/coinbase.js";
import { gemini } from "./exchanges/gemini.js";
import { type ExchangeAdapter, type ExchangeCreds, makeExchangeCtx } from "./exchanges/http.js";
import { kraken } from "./exchanges/kraken.js";
import { closeAmountsSql, normHash, normHashSql } from "./match.js";
import { getCryptoSettings } from "./prices.js";

export { type SyncDeps, SyncError };

/**
 * Wallet sync from public blockchain data. Each chain has an adapter in
 * ./chains (one per provider); this file stores the results.
 * Providers: Blockscout (EVM chains), Koios (Cardano), AlgoNode (Algorand),
 * Horizon (Stellar), mempool.space/litecoinspace (Bitcoin, Litecoin), BlockCypher
 * (Dogecoin), a Cosmos Hub REST node and TronGrid.
 *
 * Privacy: syncing sends the wallet's address or extended public key to that
 * service. It is opt-in per wallet; the source is stored encrypted and never
 * logged. An xpub reveals the wallet's whole history, never funds.
 *
 * Incremental: the cursor stores the highest synced block, and the next sync
 * asks only for transactions from that block on. Rows are keyed by txid, so
 * overlap is harmless.
 */

type Db = MunyDb | Parameters<Parameters<MunyDb["transaction"]>[0]>[0];

const ADAPTERS: Record<(typeof CHAINS)[ChainKey]["provider"], Adapter> = {
  esplora,
  blockcypher,
  none: unsupported,
  blockbook,
  siascan: sia,
  blockscout,
  koios: cardano,
  algonode: algorand,
  horizon: stellar,
  cosmos,
  trongrid: tron,
};
const BUDGET: Record<(typeof CHAINS)[ChainKey]["provider"], BudgetProvider> = {
  esplora: "esplora",
  blockcypher: "blockcypher",
  none: "blockcypher",
  blockbook: "blockbook",
  siascan: "siascan",
  blockscout: "blockscout",
  koios: "koios",
  algonode: "algonode",
  horizon: "horizon",
  cosmos: "cosmos",
  trongrid: "trongrid",
};

const sleep = (ms?: number) => (ms ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

const w = schema.cryptoWallets;
const t = schema.cryptoTxns;
export function readCursor(raw: string | null): Cursor | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as Cursor;
    return typeof c.height === "number" ? c : null;
  } catch {
    return null;
  }
}

/** Attach (or replace) the address/xpub a wallet syncs from. */
export function setWalletSource(
  db: MunyDb,
  walletId: string,
  input: { chain: ChainKey; source: string },
  secretKey: Buffer | undefined,
) {
  if (!secretKey)
    throw new SyncError("Set MUNY_SECRET_KEY first: the address is stored encrypted.");
  const chain = CHAINS[input.chain];
  const source = input.source.trim();
  if (!chain.validate(source))
    throw new SyncError(`That doesn't look like a ${chain.name} ${chain.accepts}`);
  const n = db
    .update(w)
    .set({
      kind: "blockchain",
      chain: input.chain,
      sourceEnc: encryptJson(secretKey, source),
      sourceHint: sourceHint(source),
      syncEnabled: true,
      status: "never",
      lastError: null,
      syncCursor: null,
    })
    .where(eq(w.id, walletId))
    .run().changes;
  if (!n) throw new SyncError("Wallet not found");
}

export function removeWalletSource(db: MunyDb, walletId: string) {
  db.update(w)
    .set({
      sourceEnc: null,
      sourceHint: null,
      syncEnabled: false,
      syncCursor: null,
      status: "never",
    })
    .where(eq(w.id, walletId))
    .run();
}

const syncing = new Set<string>();
/** Wallets waiting their turn in a sync-all / daily run. */
const queued = new Set<string>();
/** Syncing now, or (for the whole app) any run still in progress. */
export const isSyncing = (walletId?: string) =>
  walletId ? syncing.has(walletId) : syncing.size > 0 || queued.size > 0;
export const isQueued = (walletId: string) => queued.has(walletId) && !syncing.has(walletId);

/** True when an imported row in this wallet already covers the synced movement. */
function coveredByImport(db: Db, walletId: string, s: SyncedTxn): boolean {
  if (
    s.txHash &&
    db.get(sql`
      select 1 from crypto_txns
       where wallet_id = ${walletId} and source <> 'sync'
         and ${normHashSql("tx_hash")} = ${normHash(s.txHash)}`)
  )
    return true;
  const asset = s.receivedAsset ?? s.sentAsset;
  const amount = s.receivedAmount ?? s.sentAmount;
  if (!asset || !amount) return false;
  const [ac, am] = s.receivedAmount
    ? ["received_asset", "received_amount"]
    : ["sent_asset", "sent_amount"];
  return !!db.get(sql`
    select 1 from crypto_txns
     where wallet_id = ${walletId} and source <> 'sync'
       and abs(at - ${s.at}) <= ${2 * 3_600_000}
       and ${sql.raw(ac)} = ${asset}
       and ${closeAmountsSql(am, `'${amount.replace(/[^0-9.]/g, "")}'`)}`);
}

/** Link sends and receives between own wallets that share a transaction hash. */
export function pairTransfers(db: MunyDb) {
  const rows = db.all<{ a: string; b: string }>(sql`
    select o.id as a, i.id as b
      from crypto_txns o join crypto_txns i
        on ${normHashSql("o.tx_hash")} = ${normHashSql("i.tx_hash")} and o.wallet_id <> i.wallet_id
     where o.tx_hash is not null and o.transfer_pair_id is null and i.transfer_pair_id is null
       and o.type = 'withdrawal' and i.type = 'deposit'
       and o.sent_asset = i.received_asset
  `);
  const used = new Set<string>();
  for (const r of rows) {
    if (used.has(r.a) || used.has(r.b)) continue;
    used.add(r.a);
    used.add(r.b);
    db.update(t)
      .set({ type: "transfer", label: null, transferPairId: r.b })
      .where(eq(t.id, r.a))
      .run();
    db.update(t)
      .set({ type: "transfer", label: null, transferPairId: r.a })
      .where(eq(t.id, r.b))
      .run();
  }
  return used.size / 2;
}

/** Sync one wallet. Throws SyncError (message is safe to show). */
export async function syncWallet(
  db: MunyDb,
  walletId: string,
  deps: SyncDeps,
): Promise<CryptoSyncResult> {
  const wallet = db.select().from(w).where(eq(w.id, walletId)).get();
  if (!wallet) throw new SyncError("Wallet not found");
  if (
    !wallet.sourceEnc ||
    (wallet.chain ? !(wallet.chain in CHAINS) : !canSyncExchange(wallet.exchange))
  )
    throw new SyncError("This wallet has no address or exchange key to sync from");
  if (!deps.secretKey) throw new SyncError("MUNY_SECRET_KEY is not set");
  if (syncing.has(walletId)) return { added: 0, duplicates: 0 };
  syncing.add(walletId);
  const startedAt = Date.now();
  const record = (
    status: "ok" | "error",
    added: number,
    duplicates: number,
    message: string | null,
  ) =>
    db
      .insert(schema.cryptoSyncRuns)
      .values({
        id: newId(),
        walletId,
        startedAt,
        finishedAt: Date.now(),
        status,
        added,
        duplicates,
        message,
      })
      .run();
  try {
    const { notice, ...res } = await runSync(db, wallet, deps);
    record("ok", res.added, res.duplicates, notice);
    // A notice (status ok) is shown under the wallet, like an error but calmer.
    db.update(w)
      .set({ status: "ok", lastError: notice, lastSyncAt: new Date() })
      .where(eq(w.id, walletId))
      .run();
    return res;
  } catch (err) {
    // Unexpected errors: show what happened, minus anything address-like.
    const msg =
      err instanceof SyncError
        ? err.message
        : `Sync failed: ${safeText(err instanceof Error ? err.message : err) || "unknown error"}`;
    db.update(w)
      .set({ status: "error", lastError: msg, lastSyncAt: new Date() })
      .where(eq(w.id, walletId))
      .run();
    record("error", 0, 0, msg);
    throw err instanceof SyncError ? err : new SyncError(msg);
  } finally {
    syncing.delete(walletId);
  }
}

/** A chain context (budgeted HTTP, decrypted source) for one synced wallet. */
export function walletCtx(db: MunyDb, wallet: typeof w.$inferSelect, deps: SyncDeps) {
  if (!wallet.sourceEnc || !wallet.chain || !(wallet.chain in CHAINS) || !deps.secretKey)
    throw new SyncError("This wallet has no address to sync from");
  const chain = CHAINS[wallet.chain as ChainKey];
  return makeCtx(
    {
      db,
      chain,
      source: decryptJson<string>(deps.secretKey, wallet.sourceEnc),
      cursor: readCursor(wallet.syncCursor),
      override: getCryptoSettings(db).servers[chain.key] ?? "",
      deps,
    },
    BUDGET[chain.provider],
  );
}

/** Exchanges Muny syncs with a read-only API key (catalog keys in CRYPTO_EXCHANGES). */
const EXCHANGES: Record<
  string,
  { adapter: ExchangeAdapter; budget: BudgetProvider; label: string }
> = {
  coinbase: { adapter: coinbase, budget: "coinbase", label: "Coinbase" },
  kraken: { adapter: kraken, budget: "kraken", label: "Kraken" },
  gemini: { adapter: gemini, budget: "gemini", label: "Gemini" },
  binance_us: { adapter: binanceus, budget: "binanceus", label: "Binance US" },
};
export const canSyncExchange = (key: string | null | undefined) => !!key && key in EXCHANGES;

/** Run an exchange wallet's adapter (its encrypted key is decrypted only here). */
function fetchExchange(db: MunyDb, wallet: typeof w.$inferSelect, deps: SyncDeps) {
  const ex = wallet.exchange ? EXCHANGES[wallet.exchange] : undefined;
  if (!ex || !wallet.sourceEnc || !deps.secretKey)
    throw new SyncError("This wallet has no exchange API key to sync with");
  const knownAssets = db
    .all<{ a: string }>(
      sql`select distinct a from (select sent_asset as a from crypto_txns where wallet_id = ${wallet.id}
        union select received_asset from crypto_txns where wallet_id = ${wallet.id}
        union select fee_asset from crypto_txns where wallet_id = ${wallet.id}) where a is not null`,
    )
    .map((r) => r.a);
  const ctx = makeExchangeCtx(
    {
      db,
      creds: decryptJson<ExchangeCreds>(deps.secretKey, wallet.sourceEnc),
      cursor: readCursor(wallet.syncCursor),
      deps,
      knownAssets,
    },
    ex.budget,
    ex.label,
  );
  return ex.adapter(ctx);
}

/** Attach (or replace) the read-only API key an exchange wallet syncs with. */
export function setExchangeKey(
  db: MunyDb,
  walletId: string,
  input: { exchange: string; key: string; secret: string; passphrase?: string },
  secretKey: Buffer | undefined,
) {
  if (!secretKey)
    throw new SyncError("Set MUNY_SECRET_KEY first: the API key is stored encrypted.");
  if (!canSyncExchange(input.exchange)) throw new SyncError("Muny can't sync that exchange");
  const creds: ExchangeCreds = {
    key: input.key.trim(),
    secret: input.secret.trim(),
    ...(input.passphrase ? { passphrase: input.passphrase.trim() } : {}),
  };
  if (!creds.key || !creds.secret) throw new SyncError("Paste both the key and the secret");
  const n = db
    .update(w)
    .set({
      kind: "exchange",
      exchange: input.exchange,
      chain: null,
      sourceEnc: encryptJson(secretKey, creds),
      sourceHint: `API key …${creds.key.replace(/\s+/g, "").slice(-4)}`,
      syncEnabled: true,
      status: "never",
      lastError: null,
      syncCursor: null,
    })
    .where(eq(w.id, walletId))
    .run().changes;
  if (!n) throw new SyncError("Wallet not found");
}

/** Fetch a wallet's whole history from its chain service or exchange without storing anything. */
export async function fetchFullHistory(db: MunyDb, walletId: string, deps: SyncDeps) {
  const wallet = db.select().from(w).where(eq(w.id, walletId)).get();
  if (!wallet) throw new SyncError("Wallet not found");
  if (!wallet.chain) return fetchExchange(db, { ...wallet, syncCursor: null }, deps);
  const ctx = walletCtx(db, { ...wallet, syncCursor: null }, deps);
  return ADAPTERS[CHAINS[wallet.chain as ChainKey].provider](ctx);
}

/** Wallets whose staking rewards come from an import instead of the chain. */
const REWARDS_FROM_IMPORT = "crypto.rewards_from_import";
export function rewardsFromImport(db: MunyDb): Set<string> {
  const v = db
    .select()
    .from(schema.appSettings)
    .where(eq(schema.appSettings.key, REWARDS_FROM_IMPORT))
    .get()?.value as string[] | undefined;
  return new Set(v ?? []);
}
export function setRewardsFromImport(db: MunyDb, walletId: string, on: boolean) {
  const s = rewardsFromImport(db);
  if (on) s.add(walletId);
  else s.delete(walletId);
  const value = [...s];
  db.insert(schema.appSettings)
    .values({ key: REWARDS_FROM_IMPORT, value })
    .onConflictDoUpdate({ target: schema.appSettings.key, set: { value } })
    .run();
}

/**
 * Synced wallets on the blockchain's version of their history ("Use the
 * blockchain's version" in Reconcile): a Koinly import adds its tags and
 * values to the synced rows instead of bringing its own rows back.
 */
const CHAIN_VERSION = "crypto.chain_version";
export function chainVersion(db: MunyDb): Set<string> {
  const v = db
    .select()
    .from(schema.appSettings)
    .where(eq(schema.appSettings.key, CHAIN_VERSION))
    .get()?.value as string[] | undefined;
  return new Set(v ?? []);
}
export function setChainVersion(db: MunyDb, walletId: string, on: boolean) {
  const s = chainVersion(db);
  if (on) s.add(walletId);
  else s.delete(walletId);
  const value = [...s];
  db.insert(schema.appSettings)
    .values({ key: CHAIN_VERSION, value })
    .onConflictDoUpdate({ target: schema.appSettings.key, set: { value } })
    .run();
}

/** Providers that report the other address of a transaction. */
const ADDRESS_PROVIDERS = new Set(["blockscout", "esplora", "blockcypher"]);
const ADDRESSES_FILLED = "crypto.addresses_filled";
function idSetting(db: MunyDb, key: string): Set<string> {
  const v = db.select().from(schema.appSettings).where(eq(schema.appSettings.key, key)).get()
    ?.value as string[] | undefined;
  return new Set(v ?? []);
}
function addToIdSetting(db: MunyDb, key: string, id: string) {
  const value = [...idSetting(db, key).add(id)];
  db.insert(schema.appSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: schema.appSettings.key, set: { value } })
    .run();
}

async function runSync(
  db: MunyDb,
  wallet: typeof w.$inferSelect,
  deps: SyncDeps,
): Promise<CryptoSyncResult & { notice: string | null }> {
  const chain = wallet.chain ? CHAINS[wallet.chain as ChainKey] : null;
  // Rows synced before addresses were kept: read the whole history once more
  // to fill them in (a few requests, once per wallet).
  const backfill =
    !!chain &&
    ADDRESS_PROVIDERS.has(chain.provider) &&
    !idSetting(db, ADDRESSES_FILLED).has(wallet.id) &&
    !!db
      .select({ id: t.id })
      .from(t)
      .where(
        and(
          eq(t.walletId, wallet.id),
          sql`${t.counterparty} is null and ${t.txHash} is not null`,
          sql`(${t.sentAsset} is null) <> (${t.receivedAsset} is null)`,
        ),
      )
      .get();
  // Re-reading everything must not bring back rows removed in Reconcile:
  // only what happened after the last sync is new.
  const syncedUntil = backfill
    ? Math.max(
        wallet.lastSyncAt?.getTime() ?? 0,
        Number(
          db.get<{ m: number | null }>(
            sql`select max(at) as m from crypto_txns where wallet_id = ${wallet.id} and source = 'sync'`,
          )?.m ?? 0,
        ),
      )
    : 0;
  const fetched = chain
    ? await ADAPTERS[chain.provider](
        walletCtx(db, backfill ? { ...wallet, syncCursor: null } : wallet, deps),
      )
    : await fetchExchange(db, wallet, deps);
  const { height, balances, pos, notice } = fetched;
  // Rewards already counted from an import (the user chose that version).
  const mapped = rewardsFromImport(db).has(wallet.id)
    ? fetched.mapped.filter((m) => m.label !== "staking")
    : fetched.mapped;

  let added = 0;
  let duplicates = 0;
  db.transaction((tx) => {
    for (const s of mapped) {
      const exists = tx
        .select({ id: t.id })
        .from(t)
        .where(and(eq(t.walletId, wallet.id), eq(t.externalId, s.externalId)))
        .get();
      if (exists || coveredByImport(tx, wallet.id, s)) {
        if (s.counterparty && s.txHash) {
          const a = s.receivedAsset ?? s.sentAsset;
          tx.run(sql`update crypto_txns set counterparty = ${s.counterparty}
            where wallet_id = ${wallet.id} and counterparty is null
              and ${normHashSql("tx_hash")} = ${normHash(s.txHash)}
              and ${s.receivedAsset ? sql`received_asset = ${a} and sent_asset is null` : sql`sent_asset = ${a} and received_asset is null`}`);
        }
        if (!backfill || !exists) duplicates++;
        continue;
      }
      if (backfill && s.at <= syncedUntil) continue;
      tx.insert(t)
        .values({
          id: newId(),
          walletId: wallet.id,
          at: s.at,
          type: s.type,
          sentAsset: s.sentAsset,
          sentAmount: s.sentAmount,
          receivedAsset: s.receivedAsset,
          receivedAmount: s.receivedAmount,
          feeAsset: s.feeAsset,
          feeAmount: s.feeAmount,
          label: s.label ?? null,
          txHash: s.txHash || null,
          counterparty: s.counterparty ?? null,
          externalId: s.externalId,
          source: "sync",
        })
        .run();
      added++;
    }
  });
  if (added) pairTransfers(db);
  if (backfill) addToIdSetting(db, ADDRESSES_FILLED, wallet.id);
  const next: Cursor = { height, balances, ...(pos ? { pos } : {}) };
  db.update(w)
    .set({ syncCursor: JSON.stringify(next) })
    .where(eq(w.id, wallet.id))
    .run();
  return { added, duplicates, notice: notice ?? null };
}

/** Sync every wallet with sync on, one at a time. Errors are kept per wallet. */
export async function syncAll(db: MunyDb, deps: SyncDeps): Promise<CryptoSyncResult> {
  const ids = db
    .select({ id: w.id })
    .from(w)
    .where(and(eq(w.syncEnabled, true), eq(w.archived, false), sql`${w.sourceEnc} is not null`))
    .all()
    .map((r) => r.id);
  return syncMany(db, ids, deps);
}

/**
 * Sync these wallets one after another. All of them show as queued until
 * their turn is over, so the app keeps showing progress between wallets.
 */
export async function syncMany(
  db: MunyDb,
  ids: string[],
  deps: SyncDeps,
): Promise<CryptoSyncResult> {
  const todo = ids.filter((id) => !queued.has(id));
  for (const id of todo) queued.add(id);
  const total = { added: 0, duplicates: 0 };
  try {
    for (const id of todo) {
      try {
        const r = await syncWallet(db, id, deps);
        total.added += r.added;
        total.duplicates += r.duplicates;
      } catch {
        // Recorded on the wallet (status/lastError).
      } finally {
        queued.delete(id);
      }
      await sleep(deps.delayMs);
    }
  } finally {
    for (const id of todo) queued.delete(id);
  }
  return total;
}

/** Wallets due a daily sync: never synced, or last tried on an earlier local day. */
export function walletsDue(db: MunyDb, now = new Date()): string[] {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return db
    .select({ id: w.id, last: w.lastSyncAt })
    .from(w)
    .where(and(eq(w.syncEnabled, true), eq(w.archived, false), sql`${w.sourceEnc} is not null`))
    .all()
    .filter((r) => !r.last || r.last.getTime() < start)
    .map((r) => r.id);
}

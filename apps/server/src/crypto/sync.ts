import { CHAINS, type ChainKey, type SyncedTxn, sourceHint } from "@muny/core";
import { type MunyDb, newId, schema } from "@muny/db";
import type { CryptoSyncResult } from "@muny/shared";
import { and, eq, ne, sql } from "drizzle-orm";
import { decryptJson, encryptJson } from "../lib/crypto.js";
import type { BudgetProvider } from "./budget.js";
import { algorand } from "./chains/algorand.js";
import { blockbook } from "./chains/blockbook.js";
import { blockscout } from "./chains/blockscout.js";
import { cardano } from "./chains/cardano.js";
import { type Adapter, type Cursor, makeCtx, type SyncDeps, SyncError } from "./chains/ctx.js";
import { stellar } from "./chains/stellar.js";
import { getCryptoSettings } from "./prices.js";

export { type SyncDeps, SyncError };

/**
 * Wallet sync from public blockchain data. Each chain has an adapter in
 * ./chains (one per provider); this file stores the results.
 * Providers: Blockscout (EVM chains), Koios (Cardano), AlgoNode (Algorand),
 * Horizon (Stellar), Blockbook (Bitcoin-like chains, on a server you provide).
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
  "blockbook-utxo": blockbook,
  blockscout,
  koios: cardano,
  algonode: algorand,
  horizon: stellar,
};
const BUDGET: Record<(typeof CHAINS)[ChainKey]["provider"], BudgetProvider> = {
  "blockbook-utxo": "blockbook",
  blockscout: "blockscout",
  koios: "koios",
  algonode: "algonode",
  horizon: "horizon",
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
export const isSyncing = (walletId?: string) =>
  walletId ? syncing.has(walletId) : syncing.size > 0;

/** True when an imported row in this wallet already covers the synced movement. */
function coveredByImport(db: Db, walletId: string, s: SyncedTxn): boolean {
  const near = and(
    eq(t.walletId, walletId),
    ne(t.source, "sync"),
    sql`abs(${t.at} - ${s.at}) <= ${2 * 3_600_000}`,
  );
  const byHash =
    s.txHash &&
    db
      .select({ id: t.id })
      .from(t)
      .where(
        and(
          eq(t.walletId, walletId),
          ne(t.source, "sync"),
          sql`lower(${t.txHash}) = ${s.txHash.toLowerCase()}`,
        ),
      )
      .get();
  if (byHash) return true;
  const asset = s.receivedAsset ?? s.sentAsset;
  const amount = s.receivedAmount ?? s.sentAmount;
  if (!asset || !amount) return false;
  return !!db
    .select({ id: t.id })
    .from(t)
    .where(
      and(
        near,
        s.receivedAmount
          ? and(eq(t.receivedAsset, asset), eq(t.receivedAmount, amount))
          : and(eq(t.sentAsset, asset), eq(t.sentAmount, amount)),
      ),
    )
    .get();
}

/** Link sends and receives between own wallets that share a transaction hash. */
export function pairTransfers(db: MunyDb) {
  const rows = db.all<{ a: string; b: string }>(sql`
    select o.id as a, i.id as b
      from crypto_txns o join crypto_txns i
        on lower(o.tx_hash) = lower(i.tx_hash) and o.wallet_id <> i.wallet_id
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
  if (!wallet.sourceEnc || !wallet.chain || !(wallet.chain in CHAINS))
    throw new SyncError("This wallet has no address to sync from");
  if (!deps.secretKey) throw new SyncError("MUNY_SECRET_KEY is not set");
  if (syncing.has(walletId)) return { added: 0, duplicates: 0 };
  syncing.add(walletId);
  try {
    const res = await runSync(db, wallet, deps);
    db.update(w)
      .set({ status: "ok", lastError: null, lastSyncAt: new Date() })
      .where(eq(w.id, walletId))
      .run();
    return res;
  } catch (err) {
    const msg = err instanceof SyncError ? err.message : "Sync failed";
    db.update(w)
      .set({ status: "error", lastError: msg, lastSyncAt: new Date() })
      .where(eq(w.id, walletId))
      .run();
    throw err instanceof SyncError ? err : new SyncError(msg);
  } finally {
    syncing.delete(walletId);
  }
}

async function runSync(
  db: MunyDb,
  wallet: typeof w.$inferSelect,
  deps: SyncDeps,
): Promise<CryptoSyncResult> {
  const chain = CHAINS[wallet.chain as ChainKey];
  const source = decryptJson<string>(deps.secretKey as Buffer, wallet.sourceEnc as string);
  const cursor = readCursor(wallet.syncCursor);
  const ctx = makeCtx(
    {
      db,
      chain,
      source,
      cursor,
      override: getCryptoSettings(db).servers[chain.key] ?? "",
      deps,
    },
    BUDGET[chain.provider],
  );
  const { mapped, height, balances, pos } = await ADAPTERS[chain.provider](ctx);

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
        duplicates++;
        continue;
      }
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
          externalId: s.externalId,
          source: "sync",
        })
        .run();
      added++;
    }
  });
  if (added) pairTransfers(db);
  const next: Cursor = { height, balances, ...(pos ? { pos } : {}) };
  db.update(w)
    .set({ syncCursor: JSON.stringify(next) })
    .where(eq(w.id, wallet.id))
    .run();
  return { added, duplicates };
}

/** Sync every wallet with sync on, one at a time. Errors are kept per wallet. */
export async function syncAll(db: MunyDb, deps: SyncDeps): Promise<CryptoSyncResult> {
  const ids = db
    .select({ id: w.id })
    .from(w)
    .where(and(eq(w.syncEnabled, true), sql`${w.sourceEnc} is not null`))
    .all();
  const total = { added: 0, duplicates: 0 };
  for (const { id } of ids) {
    try {
      const r = await syncWallet(db, id, deps);
      total.added += r.added;
      total.duplicates += r.duplicates;
    } catch {
      // Recorded on the wallet (status/lastError).
    }
    await sleep(deps.delayMs);
  }
  return total;
}

/** Wallets due a daily sync: never synced, or last tried on an earlier local day. */
export function walletsDue(db: MunyDb, now = new Date()): string[] {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return db
    .select({ id: w.id, last: w.lastSyncAt })
    .from(w)
    .where(and(eq(w.syncEnabled, true), sql`${w.sourceEnc} is not null`))
    .all()
    .filter((r) => !r.last || r.last.getTime() < start)
    .map((r) => r.id);
}

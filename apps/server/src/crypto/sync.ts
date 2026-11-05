import {
  type BbTx,
  CHAINS,
  type ChainKey,
  fromBaseUnits,
  isExtendedKey,
  mapEthTx,
  mapUtxoTx,
  type SyncedTxn,
  sourceHint,
} from "@muny/core";
import { type MunyDb, newId, schema } from "@muny/db";
import type { CryptoSyncResult } from "@muny/shared";
import { and, eq, ne, sql } from "drizzle-orm";
import { decryptJson, encryptJson } from "../lib/crypto.js";
import { BudgetError, budgeted } from "./budget.js";
import { getCryptoSettings } from "./prices.js";

/**
 * Wallet sync from public blockchain data (Blockbook API v2).
 *
 * Privacy: syncing sends the wallet's address or extended public key to the
 * Blockbook server (Trezor's public servers by default, or one you host). It
 * is opt-in per wallet; the source is stored encrypted and never logged. An
 * xpub reveals the wallet's whole history to whoever holds it, never funds.
 *
 * Incremental: the cursor stores the highest synced block, and the next sync
 * asks only for transactions from that block on. Rows are keyed by txid, so
 * overlap is harmless.
 */

type Db = MunyDb | Parameters<Parameters<MunyDb["transaction"]>[0]>[0];

const w = schema.cryptoWallets;
const t = schema.cryptoTxns;
const PAGE_SIZE = 1000;
const MAX_PAGES = 50;

export interface SyncDeps {
  secretKey: Buffer | undefined;
  fetch?: typeof fetch;
  /** Pause between pages (politeness). */
  delayMs?: number;
}

interface Cursor {
  height: number;
  balances: { asset: string; amount: string }[];
}

interface BbPage {
  page?: number;
  totalPages?: number;
  balance?: string;
  transactions?: BbTx[];
  tokens?: { type?: string; symbol?: string; decimals?: number; balance?: string }[];
}

export class SyncError extends Error {}

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

const sleep = (ms?: number) => (ms ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

async function getPage(url: string, f: typeof fetch): Promise<BbPage> {
  const host = new URL(url).host;
  let res: Response;
  try {
    res = await f(url, {
      headers: { accept: "application/json", "user-agent": "Muny (self-hosted)" },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    if (err instanceof BudgetError) throw new SyncError(err.message);
    // Never include the URL: it contains the address.
    throw new SyncError(`Couldn't reach ${host}`);
  }
  if (res.status === 429) throw new SyncError(`${host} rate limit hit; try again later`);
  if (res.status === 400) throw new SyncError(`${host} didn't accept this address or key`);
  if (!res.ok) throw new SyncError(`${host} answered HTTP ${res.status}`);
  return (await res.json()) as BbPage;
}

/** True when an imported row in this wallet already covers the synced movement. */
function coveredByImport(db: Db, walletId: string, s: SyncedTxn): boolean {
  const near = and(
    eq(t.walletId, walletId),
    ne(t.source, "sync"),
    sql`abs(${t.at} - ${s.at}) <= ${2 * 3_600_000}`,
  );
  const byHash = db
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
  const server = (getCryptoSettings(db).servers[chain.key] || chain.server).replace(/\/+$/, "");
  const f = budgeted(db, "blockbook", deps.fetch);
  const cursor = readCursor(wallet.syncCursor);
  const xpub = isExtendedKey(source);
  const path = xpub ? "xpub" : "address";
  const from = cursor ? `&from=${cursor.height}` : "";

  const txs: BbTx[] = [];
  let first: BbPage | null = null;
  for (let page = 1; ; page++) {
    if (page > MAX_PAGES) throw new SyncError("Too many transactions to sync in one go");
    const data = await getPage(
      `${server}/api/v2/${path}/${encodeURIComponent(source)}?details=txs&page=${page}&pageSize=${PAGE_SIZE}${from}`,
      f,
    );
    first ??= data;
    txs.push(...(data.transactions ?? []));
    if (!data.totalPages || page >= data.totalPages) break;
    await sleep(deps.delayMs);
  }

  const mine = source.toLowerCase();
  const mapped: SyncedTxn[] = [];
  let height = cursor?.height ?? 0;
  for (const tx of txs) {
    if (tx.blockHeight > height) height = tx.blockHeight;
    if (chain.provider === "blockbook-eth") mapped.push(...mapEthTx(tx, source));
    else {
      const m = mapUtxoTx(tx, chain.asset, chain.decimals, (a) => a.toLowerCase() === mine);
      if (m) mapped.push(m);
    }
  }

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
          txHash: s.txHash,
          externalId: s.externalId,
          source: "sync",
        })
        .run();
      added++;
    }
  });
  if (added) pairTransfers(db);

  // What the chain says the wallet holds now (shown next to the computed balance).
  const balances: Cursor["balances"] = [];
  if (first?.balance !== undefined)
    balances.push({ asset: chain.asset, amount: fromBaseUnits(first.balance, chain.decimals) });
  if (chain.provider === "blockbook-eth")
    for (const tk of first?.tokens ?? []) {
      const sym = (tk.symbol ?? "").trim().toUpperCase();
      if ((tk.type && tk.type !== "ERC20") || !sym || sym.length > 20) continue;
      const amount = fromBaseUnits(tk.balance, tk.decimals ?? 18);
      if (amount !== "0") balances.push({ asset: sym, amount });
    }
  const next: Cursor = { height, balances };
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

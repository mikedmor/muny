import {
  type BbTx,
  CHAINS,
  type ChainKey,
  type EsInternal,
  type EsTokenTx,
  type EsTx,
  fromBaseUnits,
  isExtendedKey,
  mapEvmHistory,
  mapUtxoTx,
  plausibleSymbol,
  type SyncedTxn,
  sourceHint,
} from "@muny/core";
import { type MunyDb, newId, schema } from "@muny/db";
import type { CryptoSyncResult } from "@muny/shared";
import { and, eq, ne, sql } from "drizzle-orm";
import { decryptJson, encryptJson } from "../lib/crypto.js";
import { BudgetError, budgeted } from "./budget.js";
import { BLOCKSCOUT_KEY, getCryptoSettings } from "./prices.js";

/**
 * Wallet sync from public blockchain data.
 * - EVM chains: Blockscout's Etherscan-compatible account API (txlist,
 *   txlistinternal, tokentx, balance, tokenlist). With a free API key, one
 *   endpoint (api.blockscout.com) serves every chain; without one, each
 *   chain's public instance (e.g. eth.blockscout.com) is used.
 * - Bitcoin-like chains: Blockbook API v2 on a server you run or rent
 *   (Trezor's public servers refuse third-party apps).
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

const w = schema.cryptoWallets;
const t = schema.cryptoTxns;
const PAGE_SIZE = 1000;
const MAX_PAGES = 50;
const BLOCKSCOUT_API = "https://api.blockscout.com";

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

async function getJson<T>(
  url: string,
  f: typeof fetch,
  headers: Record<string, string> = {},
): Promise<T> {
  const host = new URL(url).host;
  let res: Response;
  try {
    res = await f(url, {
      headers: { accept: "application/json", "user-agent": "Muny (self-hosted)", ...headers },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    if (err instanceof BudgetError) throw new SyncError(err.message);
    // Never include the URL: it contains the address.
    throw new SyncError(`Couldn't reach ${host}`);
  }
  if (res.status === 429) throw new SyncError(`${host} rate limit hit; try again later`);
  if (res.status === 400) throw new SyncError(`${host} didn't accept this address or key`);
  if (res.status === 401 || res.status === 403)
    throw new SyncError(
      `${host} refused the request (HTTP ${res.status}). Check the API key or server in Crypto → Settings.`,
    );
  if (!res.ok) throw new SyncError(`${host} answered HTTP ${res.status}`);
  return (await res.json()) as T;
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

interface Fetched {
  mapped: SyncedTxn[];
  height: number;
  balances: Cursor["balances"];
}

async function fetchBlockbook(
  db: MunyDb,
  chainKey: ChainKey,
  source: string,
  cursor: Cursor | null,
  deps: SyncDeps,
): Promise<Fetched> {
  const chain = CHAINS[chainKey];
  const server = (getCryptoSettings(db).servers[chain.key] || chain.server).replace(/\/+$/, "");
  if (!server)
    throw new SyncError(
      `${chain.name} needs a Blockbook server: add one in Crypto → Settings → Wallet sync servers.`,
    );
  const f = budgeted(db, "blockbook", deps.fetch);
  const path = isExtendedKey(source) ? "xpub" : "address";
  const from = cursor ? `&from=${cursor.height}` : "";
  const txs: BbTx[] = [];
  let first: BbPage | null = null;
  for (let page = 1; ; page++) {
    if (page > MAX_PAGES) throw new SyncError("Too many transactions to sync in one go");
    const data = await getJson<BbPage>(
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
    const m = mapUtxoTx(tx, chain.asset, chain.decimals, (x) => x.toLowerCase() === mine);
    if (m) mapped.push(m);
  }
  const balances: Cursor["balances"] = [];
  if (first?.balance !== undefined)
    balances.push({ asset: chain.asset, amount: fromBaseUnits(first.balance, chain.decimals) });
  return { mapped, height, balances };
}

interface EsResponse<T> {
  status?: string;
  message?: string;
  result?: T[] | string;
}

/** Etherscan-compatible account API on Blockscout. */
async function fetchBlockscout(
  db: MunyDb,
  chainKey: ChainKey,
  address: string,
  cursor: Cursor | null,
  deps: SyncDeps,
): Promise<Fetched> {
  const chain = CHAINS[chainKey];
  const override = getCryptoSettings(db).servers[chain.key]?.replace(/\/+$/, "");
  const enc = db
    .select()
    .from(schema.appSettings)
    .where(eq(schema.appSettings.key, BLOCKSCOUT_KEY))
    .get()?.value as string | undefined;
  const key = !override && enc && deps.secretKey ? decryptJson<string>(deps.secretKey, enc) : null;
  // The key goes in a header, never in the URL.
  const base = override
    ? `${override}/api`
    : key
      ? `${BLOCKSCOUT_API}/${chain.chainId}/api`
      : `${chain.server}/api`;
  const headers: Record<string, string> = key ? { authorization: `Bearer ${key}` } : {};
  const f = budgeted(db, "blockscout", deps.fetch);
  const host = new URL(base).host;
  const call = async <T>(params: Record<string, string | number>): Promise<T[] | string> => {
    const q = new URLSearchParams({ module: "account", address, ...params } as Record<
      string,
      string
    >);
    const r = await getJson<EsResponse<T>>(`${base}?${q}`, f, headers);
    await sleep(deps.delayMs);
    if (r.status === "1" || Array.isArray(r.result)) return r.result ?? [];
    if (/^no (transactions|token|records)/i.test(r.message ?? "") || /^no /i.test(String(r.result)))
      return [];
    // Error text from the service; drop anything that looks like an address.
    const why = String(typeof r.result === "string" ? r.result : (r.message ?? "error"))
      .replace(/0x[0-9a-fA-F]{6,}/g, "…")
      .slice(0, 120);
    throw new SyncError(`${host}: ${why}`);
  };
  /** All rows of a list from `start` on, oldest first, paging by block. */
  const list = async <T extends { blockNumber: string }>(action: string): Promise<T[]> => {
    const out: T[] = [];
    const seen = new Set<string>();
    let start = cursor?.height ?? 0;
    for (let round = 0; round < MAX_PAGES; round++) {
      const rows = await call<T>({
        action,
        startblock: start,
        sort: "asc",
        page: 1,
        offset: PAGE_SIZE,
      });
      if (typeof rows === "string") return out;
      for (const r of rows) {
        const k = JSON.stringify(r);
        if (!seen.has(k)) {
          seen.add(k);
          out.push(r);
        }
      }
      if (rows.length < PAGE_SIZE) return out;
      const last = Number(rows[rows.length - 1]?.blockNumber ?? start);
      // A single block with more rows than a page can't be paged by block.
      if (last <= start) throw new SyncError("Too many transactions in one block to sync");
      start = last;
    }
    throw new SyncError("Too many transactions to sync in one go");
  };

  const txs = await list<EsTx>("txlist");
  const internals = await list<EsInternal>("txlistinternal");
  const tokens = await list<EsTokenTx>("tokentx");
  const { txns, maxBlock } = mapEvmHistory(
    address,
    { asset: chain.asset, decimals: chain.decimals },
    { txs, internals, tokens },
  );

  const balances: Cursor["balances"] = [];
  const bal = await call<never>({ action: "balance" });
  if (typeof bal === "string" && /^\d+$/.test(bal))
    balances.push({ asset: chain.asset, amount: fromBaseUnits(bal, chain.decimals) });
  const held = await call<{ balance?: string; decimals?: string; symbol?: string; type?: string }>({
    action: "tokenlist",
  });
  if (Array.isArray(held))
    for (const tk of held) {
      const sym = plausibleSymbol(tk.symbol);
      if (!sym || (tk.type && !/20/.test(tk.type))) continue;
      const amount = fromBaseUnits(tk.balance, Number(tk.decimals ?? 18) || 0);
      if (amount !== "0") balances.push({ asset: sym, amount });
    }
  return { mapped: txns, height: Math.max(cursor?.height ?? 0, maxBlock), balances };
}

async function runSync(
  db: MunyDb,
  wallet: typeof w.$inferSelect,
  deps: SyncDeps,
): Promise<CryptoSyncResult> {
  const chainKey = wallet.chain as ChainKey;
  const source = decryptJson<string>(deps.secretKey as Buffer, wallet.sourceEnc as string);
  const cursor = readCursor(wallet.syncCursor);
  const { mapped, height, balances } =
    CHAINS[chainKey].provider === "blockscout"
      ? await fetchBlockscout(db, chainKey, source, cursor, deps)
      : await fetchBlockbook(db, chainKey, source, cursor, deps);

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

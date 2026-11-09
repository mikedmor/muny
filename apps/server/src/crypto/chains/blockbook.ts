import { type BbTx, fromBaseUnits, isExtendedKey, mapUtxoTx, type SyncedTxn } from "@muny/core";
import { type Adapter, SyncError } from "./ctx.js";

/**
 * Any Blockbook server (Trezor's open-source indexer) for UTXO coins that have
 * no free public service Muny can use, Zcash first. There's no default
 * server: set one in Settings → API (e.g. a free GetBlock Blockbook
 * endpoint, or your own). Handles a single transparent address or an xpub
 * (Blockbook marks the wallet's own inputs and outputs).
 */

const PAGE = 1000;
const MAX_PAGES = 50;

interface BbPage {
  page?: number;
  totalPages?: number;
  balance?: string;
  transactions?: BbTx[];
}

export const blockbook: Adapter = async (ctx) => {
  const base = ctx.override.replace(/\/+$/, "");
  if (!base)
    return {
      mapped: [],
      height: ctx.cursor?.height ?? 0,
      balances: ctx.cursor?.balances ?? [],
      notice: `${ctx.chain.name} syncs through a Blockbook server, and there's no free public one Muny can use. Set one in Settings → API → Wallet sync servers (e.g. a free GetBlock Blockbook endpoint), then sync again.`,
    };
  const xpub = isExtendedKey(ctx.source);
  const path = `${base}/api/v2/${xpub ? "xpub" : "address"}/${ctx.source}`;
  const from = ctx.cursor?.height ? ctx.cursor.height : 0;
  const txs: BbTx[] = [];
  let balance = "0";
  for (let page = 1; page <= MAX_PAGES; page++) {
    const q = new URLSearchParams({ details: "txs", page: String(page), pageSize: String(PAGE) });
    if (xpub) q.set("tokens", "used");
    if (from) q.set("from", String(from));
    const r = await ctx.get<BbPage>(`${path}?${q}`);
    if (page === 1) balance = r.balance ?? "0";
    txs.push(...(r.transactions ?? []));
    if (!r.totalPages || page >= r.totalPages) break;
    if (page === MAX_PAGES) throw new SyncError("Too many transactions to sync in one go");
  }
  const own = (a: string) => a === ctx.source;
  const mapped: SyncedTxn[] = [];
  let height = ctx.cursor?.height ?? 0;
  for (const tx of txs) {
    const m = mapUtxoTx(tx, ctx.chain.asset, ctx.chain.decimals, xpub ? undefined : own);
    if (m) mapped.push(m);
    if (tx.blockHeight > height) height = tx.blockHeight;
  }
  return {
    mapped,
    height,
    balances: [{ asset: ctx.chain.asset, amount: fromBaseUnits(balance, ctx.chain.decimals) }],
  };
};

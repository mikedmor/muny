import { type BbTx, fromBaseUnits, isExtendedKey, mapUtxoTx, type SyncedTxn } from "@muny/core";
import { type Adapter, SyncError } from "./ctx.js";

/** Bitcoin-like chains on a Blockbook server (API v2) the user runs or rents. */

const PAGE_SIZE = 1000;
const MAX_PAGES = 50;

interface BbPage {
  totalPages?: number;
  balance?: string;
  transactions?: BbTx[];
}

export const blockbook: Adapter = async (ctx) => {
  const { chain, source, cursor } = ctx;
  const server = (ctx.override || chain.server).replace(/\/+$/, "");
  if (!server)
    throw new SyncError(
      `${chain.name} needs a Blockbook server: add one in Crypto → Settings → Wallet sync servers.`,
    );
  const path = isExtendedKey(source) ? "xpub" : "address";
  const from = cursor ? `&from=${cursor.height}` : "";
  const txs: BbTx[] = [];
  let first: BbPage | null = null;
  for (let page = 1; ; page++) {
    if (page > MAX_PAGES) throw new SyncError("Too many transactions to sync in one go");
    const data = await ctx.get<BbPage>(
      `${server}/api/v2/${path}/${encodeURIComponent(source)}?details=txs&page=${page}&pageSize=${PAGE_SIZE}${from}`,
    );
    first ??= data;
    txs.push(...(data.transactions ?? []));
    if (!data.totalPages || page >= data.totalPages) break;
  }
  const mine = source.toLowerCase();
  const mapped: SyncedTxn[] = [];
  let height = cursor?.height ?? 0;
  for (const tx of txs) {
    if (tx.blockHeight > height) height = tx.blockHeight;
    const m = mapUtxoTx(tx, chain.asset, chain.decimals, (x) => x.toLowerCase() === mine);
    if (m) mapped.push(m);
  }
  const balances =
    first?.balance !== undefined
      ? [{ asset: chain.asset, amount: fromBaseUnits(first.balance, chain.decimals) }]
      : [];
  return { mapped, height, balances };
};

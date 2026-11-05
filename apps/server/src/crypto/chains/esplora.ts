import {
  type BbTx,
  fromBaseUnits,
  HdAccount,
  type HdCoin,
  isExtendedKey,
  mapUtxoTx,
  type SyncedTxn,
} from "@muny/core";
import { type Adapter, type ChainCtx, SyncError } from "./ctx.js";

/**
 * Bitcoin and Litecoin through Esplora APIs (mempool.space, litecoinspace.org;
 * free, no key; a self-hosted mempool works too). An extended public key is
 * expanded locally into addresses (receive + change, until 20 unused in a
 * row); only the addresses are looked up, never the key.
 *
 * Incremental: the cursor keeps each address's transaction count (by
 * derivation path, not by address), so only addresses with new activity are
 * fetched, and only their new transactions.
 */

const DEFAULT: Partial<Record<string, string>> = {
  btc: "https://mempool.space/api",
  ltc: "https://litecoinspace.org/api",
};
const GAP = 20;
const MAX_INDEX = 1000;
const PAGE = 25;

interface AddrInfo {
  chain_stats?: { funded_txo_sum: number; spent_txo_sum: number; tx_count: number };
}
interface ETx {
  txid: string;
  fee?: number;
  status?: { confirmed?: boolean; block_height?: number; block_time?: number };
  vin?: { prevout?: { scriptpubkey_address?: string; value?: number } | null }[];
  vout?: { scriptpubkey_address?: string; value?: number }[];
}

export const toBbTx = (t: ETx): BbTx => ({
  txid: t.txid,
  blockHeight: t.status?.confirmed ? (t.status.block_height ?? 0) : -1,
  blockTime: t.status?.block_time ?? 0,
  fees: String(t.fee ?? 0),
  vin: (t.vin ?? []).map((v) => ({
    addresses: v.prevout?.scriptpubkey_address ? [v.prevout.scriptpubkey_address] : [],
    value: String(v.prevout?.value ?? 0),
  })),
  vout: (t.vout ?? []).map((v) => ({
    addresses: v.scriptpubkey_address ? [v.scriptpubkey_address] : [],
    value: String(v.value ?? 0),
  })),
});

/**
 * Walk an extended key's receive and change chains until GAP unused addresses
 * in a row. `used` reports which of a batch of addresses have activity.
 */
export async function scanHd(
  ctx: ChainCtx,
  coin: HdCoin,
  check: (path: string, address: string) => Promise<boolean>,
): Promise<Map<string, string>> {
  const acct = new HdAccount(ctx.source, coin);
  const found = new Map<string, string>(); // path → address (used or not)
  for (const chain of [0, 1] as const) {
    let unused = 0;
    for (let i = 0; unused < GAP; i++) {
      if (i > MAX_INDEX) throw new SyncError("Too many addresses to scan");
      const path = `${chain}/${i}`;
      const a = acct.address(chain, i);
      found.set(path, a);
      unused = (await check(path, a)) ? 0 : unused + 1;
    }
  }
  return found;
}

export const esplora: Adapter = async (ctx) => {
  const { chain } = ctx;
  const base = (ctx.override || DEFAULT[chain.key] || "").replace(/\/+$/, "");
  if (!base) throw new SyncError(`No ${chain.name} service configured`);
  const prev = ctx.cursor?.pos ?? {};
  const pos: Record<string, number> = {};
  const info = new Map<string, AddrInfo>();
  const check = async (path: string, a: string) => {
    const r = await ctx.get<AddrInfo>(`${base}/address/${a}`);
    info.set(path, r);
    return (r.chain_stats?.tx_count ?? 0) > 0;
  };
  const addresses = isExtendedKey(ctx.source)
    ? await scanHd(ctx, chain.key as HdCoin, check)
    : new Map([["a", ctx.source]]);
  if (!isExtendedKey(ctx.source)) await check("a", ctx.source);

  // New transactions of addresses whose count went up.
  const txs = new Map<string, ETx>();
  for (const [path, a] of addresses) {
    const count = info.get(path)?.chain_stats?.tx_count ?? 0;
    pos[path] = count;
    let want = count - Number(prev[path] ?? 0);
    let last: string | undefined;
    while (want > 0) {
      const page = await ctx.get<ETx[]>(`${base}/address/${a}/txs/chain${last ? `/${last}` : ""}`);
      for (const t of page) txs.set(t.txid, t);
      want -= page.length;
      last = page[page.length - 1]?.txid;
      if (page.length < PAGE || !last) break;
    }
  }
  // Only keep counts for used addresses (unused ones are re-derived each time).
  for (const k of Object.keys(pos)) if (!pos[k]) delete pos[k];

  const own = new Set(addresses.values());
  const mapped: SyncedTxn[] = [];
  let height = ctx.cursor?.height ?? 0;
  for (const t of txs.values()) {
    const bb = toBbTx(t);
    if (bb.blockHeight > height) height = bb.blockHeight;
    const m = mapUtxoTx(bb, chain.asset, chain.decimals, (x) => own.has(x));
    if (m) mapped.push(m);
  }
  let sat = 0n;
  for (const r of info.values())
    sat += BigInt(r.chain_stats?.funded_txo_sum ?? 0) - BigInt(r.chain_stats?.spent_txo_sum ?? 0);
  const balances = [{ asset: chain.asset, amount: fromBaseUnits(sat.toString(), chain.decimals) }];
  return { mapped, height, balances, pos };
};

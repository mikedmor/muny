import { type BbTx, fromBaseUnits, isExtendedKey, mapUtxoTx, type SyncedTxn } from "@muny/core";
import { type Adapter, SyncError } from "./ctx.js";
import { scanHd } from "./esplora.js";

/**
 * Dogecoin through BlockCypher (free, no key: a few requests a second, about
 * 100 an hour). An extended public key is expanded locally into addresses;
 * only the addresses are looked up. Counts are kept per derivation path so
 * only addresses with new activity are fetched.
 */

const API = "https://api.blockcypher.com/v1/doge/main";
const PAGE = 50;

interface Balance {
  n_tx?: number;
  final_balance?: number;
}
interface CyTx {
  hash: string;
  block_height?: number;
  confirmed?: string;
  fees?: number;
  inputs?: { addresses?: string[] | null; output_value?: number }[];
  outputs?: { addresses?: string[] | null; value?: number }[];
}

const toBbTx = (t: CyTx): BbTx => ({
  txid: t.hash,
  blockHeight: t.confirmed && (t.block_height ?? -1) >= 0 ? (t.block_height as number) : -1,
  blockTime: t.confirmed ? Math.floor(Date.parse(t.confirmed) / 1000) : 0,
  fees: String(t.fees ?? 0),
  vin: (t.inputs ?? []).map((v) => ({
    addresses: v.addresses ?? [],
    value: String(v.output_value ?? 0),
  })),
  vout: (t.outputs ?? []).map((v) => ({
    addresses: v.addresses ?? [],
    value: String(v.value ?? 0),
  })),
});

export const blockcypher: Adapter = async (ctx) => {
  const { chain } = ctx;
  const base = (ctx.override || API).replace(/\/+$/, "");
  const prev = ctx.cursor?.pos ?? {};
  const pos: Record<string, number> = {};
  const info = new Map<string, Balance>();
  const check = async (path: string, a: string) => {
    const r = await ctx.get<Balance>(`${base}/addrs/${a}/balance`);
    info.set(path, r);
    return (r.n_tx ?? 0) > 0;
  };
  const xpub = isExtendedKey(ctx.source);
  const addresses = xpub ? await scanHd(ctx, "doge", check) : new Map([["a", ctx.source]]);
  if (!xpub) await check("a", ctx.source);

  const txs = new Map<string, CyTx>();
  for (const [path, a] of addresses) {
    const count = info.get(path)?.n_tx ?? 0;
    if (count) pos[path] = count;
    let want = count - Number(prev[path] ?? 0);
    let before: number | undefined;
    for (let n = 0; want > 0; n++) {
      if (n > 40) throw new SyncError("Too many transactions to sync in one go");
      const r = await ctx.get<{ txs?: CyTx[]; hasMore?: boolean }>(
        `${base}/addrs/${a}/full?limit=${PAGE}${before ? `&before=${before}` : ""}`,
      );
      let fresh = 0;
      for (const t of r.txs ?? [])
        if (!txs.has(t.hash)) {
          txs.set(t.hash, t);
          fresh++;
        }
      want -= fresh;
      const heights = (r.txs ?? []).map((t) => t.block_height ?? 0).filter((h) => h > 0);
      if (!r.hasMore || fresh === 0 || !heights.length) break;
      // Next page: blocks at or below the lowest one seen (overlap is de-duplicated).
      before = Math.min(...heights) + 1;
    }
  }

  const own = new Set(addresses.values());
  const mapped: SyncedTxn[] = [];
  let height = ctx.cursor?.height ?? 0;
  for (const t of txs.values()) {
    const bb = toBbTx(t);
    if (bb.blockHeight > height) height = bb.blockHeight;
    const m = mapUtxoTx(bb, chain.asset, chain.decimals, (x) => own.has(x));
    if (m) mapped.push(m);
  }
  let units = 0n;
  for (const r of info.values()) units += BigInt(r.final_balance ?? 0);
  return {
    mapped,
    height,
    balances: [{ asset: chain.asset, amount: fromBaseUnits(units.toString(), chain.decimals) }],
    pos,
  };
};

/** Coins without a free public service yet: keep imported history, explain. */
export const unsupported: Adapter = async (ctx) => ({
  mapped: [],
  height: ctx.cursor?.height ?? 0,
  balances: [],
  notice: `${ctx.chain.name} isn't synced automatically yet: there's no free public ${ctx.chain.name} service. Its imported history stays as it is.`,
});

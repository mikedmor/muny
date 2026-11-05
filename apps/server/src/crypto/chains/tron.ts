import {
  Deltas,
  fromBaseUnits,
  movementsToTxns,
  plausibleSymbol,
  type SyncedTxn,
  tronToHex,
} from "@muny/core";
import { type Adapter, SyncError } from "./ctx.js";

/**
 * TRON through TronGrid (free, no key): TRX transfers, TRC-10 tokens (e.g. the
 * original BTT) and TRC-20 tokens. Fees are the TRX burned by transactions
 * the account sent. Frozen (staked) TRX is still yours: the on-chain check
 * adds it to the liquid balance. Voting rewards aren't itemised yet.
 */

const GRID = "https://api.trongrid.io";
const TRX = 6;
const PAGE = 200;

interface Tx {
  txID: string;
  blockNumber?: number;
  block_timestamp: number;
  ret?: { contractRet?: string; fee?: number }[];
  raw_data?: {
    contract?: {
      type: string;
      parameter?: {
        value?: {
          owner_address?: string;
          to_address?: string;
          amount?: number;
          asset_name?: string;
        };
      };
    }[];
  };
}
interface Trc20 {
  transaction_id: string;
  block_timestamp: number;
  from: string;
  to: string;
  value: string;
  type?: string;
  token_info?: { symbol?: string; decimals?: number };
}
interface Page<T> {
  data?: T[];
  meta?: { fingerprint?: string };
  success?: boolean;
}

export const tron: Adapter = async (ctx) => {
  const base = (ctx.override || GRID).replace(/\/+$/, "");
  const me = ctx.source;
  const meHex = tronToHex(me).toLowerCase();
  const since = Number(ctx.cursor?.pos?.ts ?? 0);
  const list = async <T>(path: string) => {
    const out: T[] = [];
    let fingerprint: string | undefined;
    for (let n = 0; n < 100; n++) {
      const q = new URLSearchParams({
        limit: String(PAGE),
        order_by: "block_timestamp,asc",
        only_confirmed: "true",
      });
      if (since) q.set("min_timestamp", String(since));
      if (fingerprint) q.set("fingerprint", fingerprint);
      const r = await ctx.get<Page<T>>(`${base}/v1/accounts/${me}/${path}?${q}`);
      out.push(...(r.data ?? []));
      fingerprint = r.meta?.fingerprint;
      if (!fingerprint || (r.data ?? []).length < PAGE) return out;
    }
    throw new SyncError("Too many transactions to sync in one go");
  };
  const txs = await list<Tx>("transactions");
  const trc20 = await list<Trc20>("transactions/trc20");

  // TRC-10 token names (cached for this sync).
  const trc10 = new Map<string, { sym: string | null; precision: number }>();
  const token10 = async (id: string) => {
    let t = trc10.get(id);
    if (!t) {
      const r = await ctx.get<{ data?: { abbr?: string; precision?: number }[] }>(
        `${base}/v1/assets/${encodeURIComponent(id)}`,
      );
      t = { sym: plausibleSymbol(r.data?.[0]?.abbr), precision: r.data?.[0]?.precision ?? 0 };
      trc10.set(id, t);
    }
    return t;
  };

  const groups = new Map<string, { at: number; d: Deltas; fee: string }>();
  const group = (id: string, at: number) => {
    let g = groups.get(id);
    if (!g) {
      g = { at, d: new Deltas(), fee: "0" };
      groups.set(id, g);
    }
    return g;
  };
  let lastTs = since;
  const hex = (s?: string) => (s ?? "").toLowerCase();
  for (const tx of txs) {
    lastTs = Math.max(lastTs, tx.block_timestamp);
    const g = group(tx.txID, tx.block_timestamp);
    const c = tx.raw_data?.contract?.[0];
    const v = c?.parameter?.value;
    const ok = (tx.ret?.[0]?.contractRet ?? "SUCCESS") === "SUCCESS";
    const fromMe = hex(v?.owner_address) === meHex;
    if (fromMe && tx.ret?.[0]?.fee) g.fee = fromBaseUnits(String(tx.ret[0].fee), TRX);
    if (!ok || !v) continue;
    const toMe = hex(v.to_address) === meHex;
    if (c?.type === "TransferContract" && v.amount) {
      const amt = fromBaseUnits(String(v.amount), TRX);
      if (fromMe && !toMe) g.d.add("TRX", amt, -1);
      if (toMe && !fromMe) g.d.add("TRX", amt, 1);
    }
    if (c?.type === "TransferAssetContract" && v.amount && v.asset_name) {
      const t = await token10(v.asset_name);
      if (!t.sym) continue;
      const amt = fromBaseUnits(String(v.amount), t.precision);
      if (fromMe && !toMe) g.d.add(t.sym, amt, -1);
      if (toMe && !fromMe) g.d.add(t.sym, amt, 1);
    }
  }
  for (const t of trc20) {
    lastTs = Math.max(lastTs, t.block_timestamp);
    if (t.type && t.type !== "Transfer") continue;
    const sym = plausibleSymbol(t.token_info?.symbol);
    if (!sym) continue;
    const g = group(t.transaction_id, t.block_timestamp);
    const amt = fromBaseUnits(t.value, t.token_info?.decimals ?? 0);
    if (t.from === me && t.to !== me) g.d.add(sym, amt, -1);
    if (t.to === me && t.from !== me) g.d.add(sym, amt, 1);
  }

  const mapped: SyncedTxn[] = [];
  for (const [id, g] of groups)
    mapped.push(
      ...movementsToTxns({
        externalId: `trx:${id}`,
        at: g.at,
        txHash: id,
        deltas: g.d.toStrings(),
        fee: { asset: "TRX", amount: g.fee },
      }),
    );

  const acct = await ctx.get<
    Page<{
      balance?: number;
      frozen?: { frozen_balance?: number }[];
      frozenV2?: { amount?: number }[];
      account_resource?: { frozen_balance_for_energy?: { frozen_balance?: number } };
      assetV2?: { key: string; value: number }[];
      trc20?: Record<string, string>[];
    }>
  >(`${base}/v1/accounts/${me}`);
  const a = acct.data?.[0];
  const balances = [];
  if (a) {
    let sun = BigInt(a.balance ?? 0);
    for (const f of a.frozen ?? []) sun += BigInt(f.frozen_balance ?? 0);
    for (const f of a.frozenV2 ?? []) sun += BigInt(f.amount ?? 0);
    sun += BigInt(a.account_resource?.frozen_balance_for_energy?.frozen_balance ?? 0);
    balances.push({ asset: "TRX", amount: fromBaseUnits(sun.toString(), TRX) });
    for (const t of a.assetV2 ?? []) {
      if (!t.value) continue;
      const info = await token10(t.key);
      if (info.sym)
        balances.push({ asset: info.sym, amount: fromBaseUnits(String(t.value), info.precision) });
    }
  }
  // Resume just after the newest transaction seen.
  return { mapped, height: 0, balances, pos: { ts: lastTs ? lastTs + 1 : 0 } };
};

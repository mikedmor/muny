import { fromFixed, isZeroDec, SCALE, toFixed } from "./decimal.js";

/**
 * Blockbook (API v2) transactions → Muny crypto transactions, from the
 * wallet's point of view. Pure functions; the network client lives in the
 * server. Amounts arrive as integer strings in the smallest unit
 * (satoshi/wei) and become exact decimal strings.
 */

export interface BbVio {
  addresses?: string[] | null;
  value?: string;
  isOwn?: boolean;
}
export interface BbTokenTransfer {
  from: string;
  to: string;
  contract: string;
  symbol?: string;
  name?: string;
  decimals: number;
  value?: string;
  standard?: string;
}
export interface BbTx {
  txid: string;
  blockHeight: number;
  blockTime: number;
  value?: string;
  valueIn?: string;
  fees?: string;
  vin: BbVio[];
  vout: BbVio[];
  tokenTransfers?: BbTokenTransfer[];
  ethereumSpecific?: { status: number };
}

export interface SyncedTxn {
  externalId: string;
  at: number;
  type: "deposit" | "withdrawal" | "trade";
  sentAsset: string | null;
  sentAmount: string | null;
  receivedAsset: string | null;
  receivedAmount: string | null;
  feeAsset: string | null;
  feeAmount: string | null;
  txHash: string;
}

/** "12345" satoshi with 8 decimals → "0.00012345". */
export function fromBaseUnits(units: string | undefined, decimals: number): string {
  if (!units || units === "0") return "0";
  const neg = units.startsWith("-");
  const digits = (neg ? units.slice(1) : units).replace(/^0+/, "") || "0";
  const big = BigInt(digits) * 10n ** BigInt(SCALE - decimals);
  return fromFixed(neg ? -big : big);
}

const sum = (xs: string[]) => fromFixed(xs.reduce((s, x) => s + toFixed(x), 0n));
const minus = (a: string, b: string) => fromFixed(toFixed(a) - toFixed(b));
const positive = (a: string) => toFixed(a) > 0n;

/**
 * Bitcoin-like (UTXO) transaction. `isOwn` marks this wallet's inputs and
 * outputs (Blockbook sets it for xpubs; for a single address we compare).
 */
export function mapUtxoTx(
  tx: BbTx,
  asset: string,
  decimals: number,
  own?: (addr: string) => boolean,
): SyncedTxn | null {
  if (tx.blockHeight < 0) return null; // unconfirmed: wait for a block
  const mine = (v: BbVio) => v.isOwn ?? (own ? (v.addresses ?? []).some(own) : false);
  const ownIn = sum(tx.vin.filter(mine).map((v) => fromBaseUnits(v.value, decimals)));
  const ownOut = sum(tx.vout.filter(mine).map((v) => fromBaseUnits(v.value, decimals)));
  const fee = fromBaseUnits(tx.fees, decimals);
  const base = {
    externalId: `bb:${tx.txid}`,
    at: tx.blockTime * 1000,
    txHash: tx.txid,
    receivedAsset: null,
    receivedAmount: null,
    sentAsset: null,
    sentAmount: null,
    feeAsset: null,
    feeAmount: null,
  };
  if (!positive(ownIn)) {
    if (!positive(ownOut)) return null; // not ours
    return { ...base, type: "deposit", receivedAsset: asset, receivedAmount: ownOut };
  }
  // We spent: what left to others = ownIn − ownOut − fee.
  const sent = minus(minus(ownIn, ownOut), fee);
  return {
    ...base,
    type: "withdrawal",
    sentAsset: positive(sent) ? asset : null,
    sentAmount: positive(sent) ? sent : null,
    feeAsset: positive(fee) ? asset : null,
    feeAmount: positive(fee) ? fee : null,
  };
}

/**
 * Ethereum transaction for `address`: ETH value, token transfers and gas.
 * One out + one in → a trade (a swap); otherwise one Muny transaction per
 * movement, the fee on the first.
 */
export function mapEthTx(tx: BbTx, address: string): SyncedTxn[] {
  if (tx.blockHeight < 0) return [];
  const me = address.toLowerCase();
  const from = (tx.vin[0]?.addresses?.[0] ?? "").toLowerCase();
  const to = (tx.vout[0]?.addresses?.[0] ?? "").toLowerCase();
  const failed = tx.ethereumSpecific?.status === 0;
  const outs: { asset: string; amount: string }[] = [];
  const ins: { asset: string; amount: string }[] = [];
  const eth = fromBaseUnits(tx.value, 18);
  if (!failed && positive(eth)) {
    if (from === me && to !== me) outs.push({ asset: "ETH", amount: eth });
    if (to === me && from !== me) ins.push({ asset: "ETH", amount: eth });
  }
  if (!failed)
    for (const t of tx.tokenTransfers ?? []) {
      if (t.standard && t.standard !== "ERC20") continue; // NFTs: not tracked yet
      const sym = (t.symbol ?? "").trim().toUpperCase();
      if (!sym || sym.length > 20) continue;
      const amt = fromBaseUnits(t.value, t.decimals ?? 18);
      if (!positive(amt)) continue;
      const tf = t.from.toLowerCase();
      const tt = t.to.toLowerCase();
      if (tf === me && tt !== me) outs.push({ asset: sym, amount: amt });
      if (tt === me && tf !== me) ins.push({ asset: sym, amount: amt });
    }
  // We pay gas only when we sent the transaction.
  const fee = from === me ? fromBaseUnits(tx.fees, 18) : "0";
  const base = {
    at: tx.blockTime * 1000,
    txHash: tx.txid,
    feeAsset: positive(fee) ? "ETH" : null,
    feeAmount: positive(fee) ? fee : null,
  };
  const empty = { sentAsset: null, sentAmount: null, receivedAsset: null, receivedAmount: null };
  if (outs.length === 1 && ins.length === 1) {
    const [o, i] = [
      outs[0] as { asset: string; amount: string },
      ins[0] as { asset: string; amount: string },
    ];
    return [
      {
        ...base,
        externalId: `bb:${tx.txid}`,
        type: "trade",
        sentAsset: o.asset,
        sentAmount: o.amount,
        receivedAsset: i.asset,
        receivedAmount: i.amount,
      },
    ];
  }
  const parts: SyncedTxn[] = [
    ...outs.map((o) => ({
      ...empty,
      type: "withdrawal" as const,
      sentAsset: o.asset,
      sentAmount: o.amount,
    })),
    ...ins.map((i) => ({
      ...empty,
      type: "deposit" as const,
      receivedAsset: i.asset,
      receivedAmount: i.amount,
    })),
  ].map((p, n) => ({
    ...base,
    ...p,
    externalId: n === 0 ? `bb:${tx.txid}` : `bb:${tx.txid}:${n}`,
    // The fee belongs to one row only.
    ...(n > 0 ? { feeAsset: null, feeAmount: null } : {}),
  }));
  // A failed or contract-only call we sent still costs gas.
  if (parts.length === 0 && base.feeAmount)
    return [{ ...base, ...empty, externalId: `bb:${tx.txid}`, type: "withdrawal" }];
  return parts.filter(
    (p) => !isZeroDec(p.sentAmount) || !isZeroDec(p.receivedAmount) || p.feeAmount,
  );
}

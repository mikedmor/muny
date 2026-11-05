import { fromFixed, SCALE, toFixed } from "./decimal.js";

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
  /** e.g. "staking" for rewards. */
  label?: string | null;
  /** The other address: who sent a deposit, or where a withdrawal went. */
  counterparty?: string | null;
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
  const firstOther = (vs: BbVio[]) =>
    vs.find((v) => !mine(v) && v.addresses?.length)?.addresses?.[0] ?? null;
  if (!positive(ownIn)) {
    if (!positive(ownOut)) return null; // not ours
    return {
      ...base,
      type: "deposit",
      receivedAsset: asset,
      receivedAmount: ownOut,
      counterparty: firstOther(tx.vin),
    };
  }
  // We spent: what left to others = ownIn − ownOut − fee.
  const sent = minus(minus(ownIn, ownOut), fee);
  return {
    ...base,
    type: "withdrawal",
    sentAsset: positive(sent) ? asset : null,
    sentAmount: positive(sent) ? sent : null,
    counterparty: positive(sent) ? firstOther(tx.vout) : null,
    feeAsset: positive(fee) ? asset : null,
    feeAmount: positive(fee) ? fee : null,
  };
}

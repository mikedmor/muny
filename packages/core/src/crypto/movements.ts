import type { SyncedTxn } from "./blockbook.js";
import { fromFixed, toFixed } from "./decimal.js";

/**
 * Net asset movements of one on-chain transaction (from the wallet's point of
 * view) → Muny transactions. One asset out + one in is a trade; otherwise one
 * transaction per asset, with the fee on the first. A transaction with only a
 * fee (a failed call, a staking action) becomes a fee-only withdrawal.
 */
export interface MovementGroup {
  /** externalId prefix + id, e.g. "ada:" + tx hash. */
  externalId: string;
  at: number;
  txHash: string | null;
  /** Signed decimal amounts per asset: positive in, negative out. */
  deltas: Map<string, string>;
  fee?: { asset: string; amount: string } | null;
  /** Label for incoming rows (e.g. "staking" for rewards). */
  label?: string | null;
}

export class Deltas {
  readonly map = new Map<string, bigint>();
  add(asset: string, amount: string, sign: 1 | -1 = 1) {
    const v = toFixed(amount);
    if (v === 0n) return this;
    this.map.set(asset, (this.map.get(asset) ?? 0n) + (sign === 1 ? v : -v));
    return this;
  }
  toStrings(): Map<string, string> {
    return new Map([...this.map].map(([a, v]) => [a, fromFixed(v)]));
  }
}

export function movementsToTxns(g: MovementGroup): SyncedTxn[] {
  const ins: { asset: string; amount: string }[] = [];
  const outs: { asset: string; amount: string }[] = [];
  for (const [asset, amount] of g.deltas) {
    const v = toFixed(amount);
    if (v > 0n) ins.push({ asset, amount: fromFixed(v) });
    if (v < 0n) outs.push({ asset, amount: fromFixed(-v) });
  }
  const hasFee = !!g.fee && toFixed(g.fee.amount) > 0n;
  const base = {
    at: g.at,
    txHash: g.txHash ?? "",
    feeAsset: hasFee ? (g.fee?.asset ?? null) : null,
    feeAmount: hasFee ? (g.fee?.amount ?? null) : null,
  };
  const empty = { sentAsset: null, sentAmount: null, receivedAsset: null, receivedAmount: null };
  const [o] = outs;
  const [i] = ins;
  if (outs.length === 1 && ins.length === 1 && o && i)
    return [
      {
        ...base,
        externalId: g.externalId,
        type: "trade",
        sentAsset: o.asset,
        sentAmount: o.amount,
        receivedAsset: i.asset,
        receivedAmount: i.amount,
      },
    ];
  const parts = [
    ...outs.map((m) => ({
      ...empty,
      type: "withdrawal" as const,
      sentAsset: m.asset,
      sentAmount: m.amount,
    })),
    ...ins.map((m) => ({
      ...empty,
      type: "deposit" as const,
      receivedAsset: m.asset,
      receivedAmount: m.amount,
      label: g.label ?? null,
    })),
  ];
  if (parts.length === 0)
    return hasFee ? [{ ...base, ...empty, externalId: g.externalId, type: "withdrawal" }] : [];
  return parts.map((p, n) => ({
    ...base,
    ...p,
    externalId: n === 0 ? g.externalId : `${g.externalId}:${n}`,
    ...(n > 0 ? { feeAsset: null, feeAmount: null } : {}),
  }));
}

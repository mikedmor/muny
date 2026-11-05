import { toFixed, valueCents } from "./decimal.js";

/**
 * Cost basis of what you hold now: FIFO across all wallets (a "universal"
 * pool, Koinly's default for the US). This is the first piece of the tax
 * engine: it answers "what did my current coins cost?" so holdings can show
 * cost, gains and ROI.
 *
 * - Acquisitions: deposits (income included, at their value when received),
 *   what a trade received, and transfers in from outside (unpaired).
 * - Disposals: withdrawals, what a trade sent, transfers out to outside
 *   (unpaired), and fees.
 * - Transfers between your own wallets (paired) move nothing in the pool.
 *
 * Values come from the transaction (e.g. Koinly's USD value), else the daily
 * price that day, else the lot's cost is unknown (counted as 0 and flagged).
 * Amounts are exact (fixed-point); cents are integers.
 */

export interface CostTxn {
  at: number;
  type: "deposit" | "withdrawal" | "trade" | "transfer";
  sentAsset: string | null;
  sentAmount: string | null;
  receivedAsset: string | null;
  receivedAmount: string | null;
  feeAsset: string | null;
  feeAmount: string | null;
  /** USD value of the transaction at the time (cents). */
  valueCents: number | null;
  /** Paired with another of your wallets (a move inside the pool). */
  paired: boolean;
}

export interface CostResult {
  /** Amount still held (from lots; can differ from balances when history is missing). */
  amount: bigint;
  costCents: number;
  /** Some held lots have no known cost. */
  missing: boolean;
}

interface Lot {
  amount: bigint;
  /** Cost in cents × 1e18 / amount isn't stored; keep the lot's total cost. */
  cost: bigint;
  known: boolean;
}

export function fifoCostBasis(
  txns: CostTxn[],
  opts: {
    /** Assets not tracked (fiat). */
    skip: Set<string>;
    /** Value in cents of `amount` of `asset` on that day, if a price is known. */
    valueAt: (asset: string, amount: string, at: number) => number | null;
  },
): Map<string, CostResult> {
  const lots = new Map<string, Lot[]>();
  const acquire = (asset: string | null, amount: string | null, cents: number | null) => {
    if (!asset || !amount || opts.skip.has(asset)) return;
    const a = toFixed(amount);
    if (a <= 0n) return;
    const q = lots.get(asset) ?? [];
    q.push({ amount: a, cost: BigInt(Math.max(0, Math.round(cents ?? 0))), known: cents !== null });
    lots.set(asset, q);
  };
  const dispose = (asset: string | null, amount: string | null) => {
    if (!asset || !amount || opts.skip.has(asset)) return;
    let left = toFixed(amount);
    const q = lots.get(asset) ?? [];
    while (left > 0n && q.length) {
      const lot = q[0] as Lot;
      if (lot.amount <= left) {
        left -= lot.amount;
        q.shift();
      } else {
        // Keep the remaining share of the lot's cost.
        lot.cost = (lot.cost * (lot.amount - left)) / lot.amount;
        lot.amount -= left;
        left = 0n;
      }
    }
    lots.set(asset, q);
  };
  const sorted = [...txns].sort((a, b) => a.at - b.at);
  for (const t of sorted) {
    if (t.type === "trade") {
      // The received coins cost what the trade was worth (or what was sent).
      const cents =
        t.valueCents ??
        (t.sentAsset && t.sentAmount
          ? opts.skip.has(t.sentAsset)
            ? valueCents(t.sentAmount, "1")
            : opts.valueAt(t.sentAsset, t.sentAmount, t.at)
          : null) ??
        (t.receivedAsset && t.receivedAmount
          ? opts.valueAt(t.receivedAsset, t.receivedAmount, t.at)
          : null);
      dispose(t.sentAsset, t.sentAmount);
      acquire(t.receivedAsset, t.receivedAmount, cents);
    } else if (!t.paired) {
      if (t.receivedAsset && t.receivedAmount)
        acquire(
          t.receivedAsset,
          t.receivedAmount,
          t.valueCents ?? opts.valueAt(t.receivedAsset, t.receivedAmount, t.at),
        );
      dispose(t.sentAsset, t.sentAmount);
    }
    dispose(t.feeAsset, t.feeAmount);
  }
  const out = new Map<string, CostResult>();
  for (const [asset, q] of lots) {
    const amount = q.reduce((s, l) => s + l.amount, 0n);
    if (amount <= 0n) continue;
    out.set(asset, {
      amount,
      costCents: Number(q.reduce((s, l) => s + l.cost, 0n)),
      missing: q.some((l) => !l.known),
    });
  }
  return out;
}

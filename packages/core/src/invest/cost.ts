/**
 * Cost basis of what's held, worked out from trades (first in, first out):
 * buys add lots at what they cost (fees included), sales take the oldest
 * shares first, and splits add shares at no cost. Shares that arrived with
 * no known cost (a transfer in) make the result unknown.
 */
import { fromFixed, mulFixed, toFixed } from "../crypto/decimal.js";

export interface InvestCostTxn {
  date: string;
  type: string;
  quantity: string | null;
  /** Cash effect (negative for a buy). */
  amountCents: number;
}

export function fifoCost(txns: InvestCostTxn[]): { quantity: string; costCents: number } | null {
  const lots: { q: bigint; cost: bigint }[] = []; // cost in cents × 10^18 / share-units (kept as total)
  const ONE = toFixed(1);
  for (const t of [...txns].sort((a, b) => a.date.localeCompare(b.date))) {
    if (!t.quantity) continue;
    const q = toFixed(t.quantity);
    if (q <= 0n) continue;
    if (t.type === "buy") lots.push({ q, cost: BigInt(Math.max(0, -t.amountCents)) * ONE });
    else if (t.type === "split") lots.push({ q, cost: 0n });
    else if (t.type === "transfer_in") return null;
    else if (t.type === "sell" || t.type === "transfer_out") {
      let left = q;
      while (left > 0n && lots.length) {
        const lot = lots[0] as { q: bigint; cost: bigint };
        if (lot.q <= left) {
          left -= lot.q;
          lots.shift();
        } else {
          const part = (lot.cost * left) / lot.q;
          lot.cost -= part;
          lot.q -= left;
          left = 0n;
        }
      }
      if (left > 0n) return null; // sold more than the history bought
    }
  }
  const quantity = lots.reduce((s, l) => s + l.q, 0n);
  const cost = lots.reduce((s, l) => s + l.cost, 0n);
  return { quantity: fromFixed(quantity), costCents: Number((cost + ONE / 2n) / ONE) };
}

/** Do two share counts match (allowing rounding in the last places)? */
export function sameShares(a: string, b: string): boolean {
  const d = toFixed(a) - toFixed(b);
  const tol = mulFixed(toFixed(b) < 0n ? -toFixed(b) : toFixed(b), toFixed("0.0001"));
  return (d < 0n ? -d : d) <= (tol > toFixed("0.000001") ? tol : toFixed("0.000001"));
}

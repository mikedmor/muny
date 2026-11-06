import { fromFixed, toFixed, valueCents } from "./decimal.js";

/**
 * The tax ledger: FIFO lots across all wallets (a "universal" pool, Koinly's
 * US default) with their acquisition dates, so every disposal has a realized
 * gain split into short term (held a year or less) and long term, and what's
 * still held can be split the same way.
 *
 * Rules (Koinly's US defaults):
 * - Trades dispose of what was sent (proceeds: the trade's value) and acquire
 *   what was received (cost: the same value). Fiat isn't tracked.
 * - Deposits from outside are acquisitions at their value; income-tagged ones
 *   (reward, staking, mining, airdrop, income, fee refund) are also income.
 * - Withdrawals to outside leave the pool without a gain, except "cost"
 *   (spent: sold at its value, also an expense) and "lost" (sold for nothing).
 *   Gifts and donations leave without a gain.
 * - Network and trading fees are small disposals of the fee coin at its value.
 * - Transfers between your own wallets (paired) change nothing.
 * Values come from the transaction, else the daily price, else unknown (0,
 * flagged). Amounts are exact (fixed-point); cents are integers.
 */

export interface TaxTxn {
  id?: string;
  at: number;
  type: "deposit" | "withdrawal" | "trade" | "transfer";
  label: string | null;
  sentAsset: string | null;
  sentAmount: string | null;
  receivedAsset: string | null;
  receivedAmount: string | null;
  feeAsset: string | null;
  feeAmount: string | null;
  valueCents: number | null;
  feeValueCents?: number | null;
  /** Paired with another of your wallets (a move inside the pool). */
  paired: boolean;
}

export interface TaxLot {
  amount: bigint;
  /** The lot's total cost in cents. */
  cost: bigint;
  acquiredAt: number;
  known: boolean;
}

export type Term = "short" | "long";

export interface Gain {
  at: number;
  asset: string;
  amount: string;
  proceedsCents: number;
  costCents: number;
  gainCents: number;
  term: Term;
  kind: "trade" | "cost" | "lost" | "fee";
  /** Part of the amount had no purchase history (cost counted as 0). */
  missingCost: boolean;
}

export interface Flow {
  at: number;
  kind: "in" | "out" | "income" | "expense" | "fee";
  asset: string;
  valueCents: number | null;
}

export const INCOME_LABELS = new Set([
  "reward",
  "staking",
  "mining",
  "airdrop",
  "income",
  "fee_refund",
]);

/** Held for more than one year (by the calendar) when disposed at `at`. */
export function isLongTerm(acquiredAt: number, at: number): boolean {
  const d = new Date(acquiredAt);
  const year = Date.UTC(
    d.getUTCFullYear() + 1,
    d.getUTCMonth(),
    d.getUTCDate(),
    d.getUTCHours(),
    d.getUTCMinutes(),
    d.getUTCSeconds(),
  );
  return at > year;
}

/** When a lot bought at `acquiredAt` becomes long term. */
export function longTermFrom(acquiredAt: number): number {
  const d = new Date(acquiredAt);
  return (
    Date.UTC(
      d.getUTCFullYear() + 1,
      d.getUTCMonth(),
      d.getUTCDate(),
      d.getUTCHours(),
      d.getUTCMinutes(),
      d.getUTCSeconds(),
    ) + 1
  );
}

export function taxLedger(
  txns: TaxTxn[],
  opts: {
    /** Assets not tracked (fiat). */
    skip: Set<string>;
    /** Value in cents of `amount` of `asset` on that day, if a price is known. */
    valueAt: (asset: string, amount: string, at: number) => number | null;
    /** Moments (ascending) to report the total cost of everything held at (the cost line). */
    snapshots?: number[];
    /**
     * Which lot goes first: oldest (FIFO, the default), newest (LIFO), or the
     * one that cost the most per coin (HIFO).
     */
    method?: "fifo" | "lifo" | "hifo";
  },
): { lots: Map<string, TaxLot[]>; gains: Gain[]; flows: Flow[]; costAt: number[] } {
  const lots = new Map<string, TaxLot[]>();
  // Total cost of all lots held, kept as lots come and go.
  let held = 0n;
  const snaps = opts.snapshots ?? [];
  const costAt: number[] = [];
  const snapUntil = (at: number) => {
    while (costAt.length < snaps.length && (snaps[costAt.length] as number) < at)
      costAt.push(Number(held));
  };
  const gains: Gain[] = [];
  const flows: Flow[] = [];
  const value = (asset: string | null, amount: string | null, at: number) =>
    !asset || !amount
      ? null
      : opts.skip.has(asset)
        ? valueCents(amount, "1")
        : opts.valueAt(asset, amount, at);

  const acquire = (
    asset: string | null,
    amount: string | null,
    cents: number | null,
    at: number,
  ) => {
    if (!asset || !amount || opts.skip.has(asset)) return;
    const a = toFixed(amount);
    if (a <= 0n) return;
    const q = lots.get(asset) ?? [];
    const cost = BigInt(Math.max(0, Math.round(cents ?? 0)));
    held += cost;
    q.push({ amount: a, cost, acquiredAt: at, known: cents !== null });
    lots.set(asset, q);
  };

  /** The lot to take from next, by the chosen method. */
  const pick = (q: TaxLot[]): number => {
    if (opts.method === "lifo") return q.length - 1;
    if (opts.method !== "hifo") return 0;
    let best = 0;
    for (let i = 1; i < q.length; i++) {
      const a = q[i] as TaxLot;
      const b = q[best] as TaxLot;
      // Cost per coin, compared without division: a.cost/a.amount > b.cost/b.amount.
      if (a.cost * b.amount > b.cost * a.amount) best = i;
    }
    return best;
  };

  /** Take `amount` out of the pool by the chosen method; returns the pieces taken. */
  const take = (asset: string, amount: bigint) => {
    const q = lots.get(asset) ?? [];
    const pieces: { amount: bigint; cost: bigint; acquiredAt: number; known: boolean }[] = [];
    let left = amount;
    while (left > 0n && q.length) {
      const i = pick(q);
      const lot = q[i] as TaxLot;
      if (lot.amount <= left) {
        pieces.push({ ...lot });
        left -= lot.amount;
        q.splice(i, 1);
      } else {
        const cost = (lot.cost * left) / lot.amount;
        pieces.push({ amount: left, cost, acquiredAt: lot.acquiredAt, known: lot.known });
        lot.cost -= cost;
        lot.amount -= left;
        left = 0n;
      }
    }
    for (const x of pieces) held -= x.cost;
    // More left than the pool had: purchase history is missing (cost 0, short term).
    if (left > 0n) pieces.push({ amount: left, cost: 0n, acquiredAt: Number.NaN, known: false });
    lots.set(asset, q);
    return pieces;
  };

  /** A taxable disposal: realized gain per term, proceeds shared by amount. */
  const dispose = (
    asset: string | null,
    amount: string | null,
    proceeds: number | null,
    at: number,
    kind: Gain["kind"],
  ) => {
    if (!asset || !amount || opts.skip.has(asset)) return;
    const total = toFixed(amount);
    if (total <= 0n) return;
    const pieces = take(asset, total);
    const p = BigInt(Math.max(0, Math.round(proceeds ?? 0)));
    const byTerm = new Map<
      Term,
      { amount: bigint; cost: bigint; proceeds: bigint; missing: boolean }
    >();
    for (const x of pieces) {
      const term: Term =
        Number.isFinite(x.acquiredAt) && isLongTerm(x.acquiredAt, at) ? "long" : "short";
      const g = byTerm.get(term) ?? { amount: 0n, cost: 0n, proceeds: 0n, missing: false };
      g.amount += x.amount;
      g.cost += x.cost;
      g.proceeds += (p * x.amount) / total;
      g.missing ||= !x.known;
      byTerm.set(term, g);
    }
    for (const [term, g] of byTerm)
      gains.push({
        at,
        asset,
        amount: fromFixed(g.amount),
        proceedsCents: Number(g.proceeds),
        costCents: Number(g.cost),
        gainCents: Number(g.proceeds - g.cost),
        term,
        kind,
        missingCost: g.missing,
      });
  };

  /** Leaves the pool without a gain (a withdrawal to outside, a gift). */
  const remove = (asset: string | null, amount: string | null) => {
    if (!asset || !amount || opts.skip.has(asset)) return;
    const a = toFixed(amount);
    if (a > 0n) take(asset, a);
  };

  for (const t of [...txns].sort((a, b) => a.at - b.at)) {
    snapUntil(t.at);
    if (t.type === "trade") {
      const cents =
        t.valueCents ??
        value(t.sentAsset, t.sentAmount, t.at) ??
        value(t.receivedAsset, t.receivedAmount, t.at);
      dispose(t.sentAsset, t.sentAmount, cents, t.at, "trade");
      acquire(t.receivedAsset, t.receivedAmount, cents, t.at);
    } else if (!t.paired) {
      if (t.receivedAsset && t.receivedAmount) {
        const cents = t.valueCents ?? value(t.receivedAsset, t.receivedAmount, t.at);
        acquire(t.receivedAsset, t.receivedAmount, cents, t.at);
        if (!opts.skip.has(t.receivedAsset))
          flows.push({
            at: t.at,
            kind: INCOME_LABELS.has(t.label ?? "") ? "income" : "in",
            asset: t.receivedAsset,
            valueCents: cents,
          });
      }
      if (t.sentAsset && t.sentAmount) {
        const cents = t.valueCents ?? value(t.sentAsset, t.sentAmount, t.at);
        if (t.label === "cost") dispose(t.sentAsset, t.sentAmount, cents, t.at, "cost");
        else if (t.label === "lost") dispose(t.sentAsset, t.sentAmount, 0, t.at, "lost");
        else remove(t.sentAsset, t.sentAmount);
        if (!opts.skip.has(t.sentAsset))
          flows.push({
            at: t.at,
            kind: t.label === "cost" ? "expense" : "out",
            asset: t.sentAsset,
            valueCents: cents,
          });
      }
    }
    if (t.feeAsset && t.feeAmount && !opts.skip.has(t.feeAsset)) {
      const cents = t.feeValueCents ?? value(t.feeAsset, t.feeAmount, t.at);
      dispose(t.feeAsset, t.feeAmount, cents, t.at, "fee");
      flows.push({ at: t.at, kind: "fee", asset: t.feeAsset, valueCents: cents });
    }
  }
  snapUntil(Number.POSITIVE_INFINITY);
  return { lots, gains, flows, costAt };
}

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
  /** The wallet it happened in (for per-wallet reports and Form 8949 boxes). */
  walletId?: string;
  /** The other side of a transfer between your wallets (its id). */
  pairId?: string | null;
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
  /** Earliest and latest acquisition of the coins sold (Form 8949 says "Various" when they differ). */
  acquiredAt: number | null;
  acquiredLast: number | null;
  walletId: string | null;
}

export interface Flow {
  at: number;
  /** "gift": gifts, donations and lost coins (at their value when they left). */
  kind: "in" | "out" | "income" | "expense" | "fee" | "gift";
  asset: string;
  valueCents: number | null;
  label: string | null;
  amount: string | null;
  walletId: string | null;
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
    /**
     * US rules (Rev. Proc. 2024-28): one pool across wallets until this moment
     * (Jan 1, 2025), then the pool's lots are assigned to the wallets holding
     * the coins (oldest lots first, the biggest holder first) and each wallet
     * keeps its own lots; transfers between your wallets carry them along.
     * Unset: one pool throughout.
     */
    perWalletFrom?: number;
  },
): { lots: Map<string, TaxLot[]>; gains: Gain[]; flows: Flow[]; costAt: number[] } {
  /** Pools: by coin, or by wallet and coin once tracking is per wallet. */
  const lots = new Map<string, TaxLot[]>();
  let perWallet = false;
  const pk = (asset: string, walletId: string | null | undefined) =>
    perWallet ? `${walletId ?? ""}|${asset}` : asset;
  /** Every wallet's balance of each coin as the history goes (for the allocation). */
  const bal = new Map<string, bigint>();
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
    walletId: string | null | undefined,
  ) => {
    if (!asset || !amount || opts.skip.has(asset)) return;
    const a = toFixed(amount);
    if (a <= 0n) return;
    const key = pk(asset, walletId);
    const q = lots.get(key) ?? [];
    const cost = BigInt(Math.max(0, Math.round(cents ?? 0)));
    held += cost;
    q.push({ amount: a, cost, acquiredAt: at, known: cents !== null });
    lots.set(key, q);
  };

  /**
   * Jan 1, 2025 (US): assign the pool's lots to the wallets that hold the
   * coins, oldest lots first, the biggest holder first. Lots beyond what the
   * wallets hold (incomplete history) are dropped.
   */
  const allocate = () => {
    const pooled = [...lots];
    lots.clear();
    perWallet = true;
    for (const [asset, q] of pooled) {
      const holders = [...bal]
        .filter(([k, v]) => k.endsWith(`|${asset}`) && v > 0n)
        .map(([k, v]) => ({ walletId: k.slice(0, k.length - asset.length - 1), need: v }))
        .sort((a, b) =>
          b.need > a.need ? 1 : b.need < a.need ? -1 : a.walletId.localeCompare(b.walletId),
        );
      const src = q.map((l) => ({ ...l }));
      for (const h of holders) {
        const mine: TaxLot[] = [];
        while (h.need > 0n && src.length) {
          const l = src[0] as TaxLot;
          if (l.amount <= h.need) {
            mine.push(l);
            h.need -= l.amount;
            src.shift();
          } else {
            const cost = (l.cost * h.need) / l.amount;
            mine.push({ amount: h.need, cost, acquiredAt: l.acquiredAt, known: l.known });
            l.cost -= cost;
            l.amount -= h.need;
            h.need = 0n;
          }
        }
        if (mine.length) lots.set(`${h.walletId}|${asset}`, mine);
      }
    }
    held = 0n;
    for (const q of lots.values()) for (const l of q) held += l.cost;
  };

  /** Transfers between your wallets (per-wallet tracking): lots travel with the coins. */
  type Piece = { amount: bigint; cost: bigint; acquiredAt: number; known: boolean };
  const pendingOut = new Map<string, { pieces: Piece[]; sent: bigint }>();
  const pendingIn = new Map<
    string,
    { walletId: string | undefined; asset: string; amount: bigint; at: number }
  >();
  const deliver = (
    pieces: Piece[],
    sent: bigint,
    to: { walletId: string | undefined; asset: string; amount: bigint; at: number },
  ) => {
    const key = pk(to.asset, to.walletId);
    const q = lots.get(key) ?? [];
    for (const p of pieces) {
      // What arrived (less any fee taken on the way), with the cost carried over.
      const amount = sent > 0n ? (p.amount * to.amount) / sent : 0n;
      if (amount <= 0n) continue;
      const known = Number.isFinite(p.acquiredAt) && p.known;
      q.push({
        amount,
        cost: p.cost,
        acquiredAt: Number.isFinite(p.acquiredAt) ? p.acquiredAt : to.at,
        known,
      });
      held += p.cost;
    }
    q.sort((a, b) => a.acquiredAt - b.acquiredAt);
    lots.set(key, q);
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

  /** Take `amount` out of a pool by the chosen method; returns the pieces taken. */
  const take = (key: string, amount: bigint) => {
    const q = lots.get(key) ?? [];
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
    lots.set(key, q);
    return pieces;
  };

  /** A taxable disposal: realized gain per term, proceeds shared by amount. */
  const dispose = (
    asset: string | null,
    amount: string | null,
    proceeds: number | null,
    at: number,
    kind: Gain["kind"],
    walletId: string | null,
  ) => {
    if (!asset || !amount || opts.skip.has(asset)) return;
    const total = toFixed(amount);
    if (total <= 0n) return;
    const pieces = take(pk(asset, walletId), total);
    const p = BigInt(Math.max(0, Math.round(proceeds ?? 0)));
    const byTerm = new Map<
      Term,
      {
        amount: bigint;
        cost: bigint;
        proceeds: bigint;
        missing: boolean;
        first: number | null;
        last: number | null;
      }
    >();
    for (const x of pieces) {
      const term: Term =
        Number.isFinite(x.acquiredAt) && isLongTerm(x.acquiredAt, at) ? "long" : "short";
      const g = byTerm.get(term) ?? {
        amount: 0n,
        cost: 0n,
        proceeds: 0n,
        missing: false,
        first: null,
        last: null,
      };
      if (Number.isFinite(x.acquiredAt)) {
        g.first = g.first === null ? x.acquiredAt : Math.min(g.first, x.acquiredAt);
        g.last = g.last === null ? x.acquiredAt : Math.max(g.last, x.acquiredAt);
      }
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
        acquiredAt: g.first,
        acquiredLast: g.last,
        walletId,
      });
  };

  /** Leaves the pool without a gain (a withdrawal to outside, a gift). */
  const remove = (
    asset: string | null,
    amount: string | null,
    walletId: string | null | undefined,
  ) => {
    if (!asset || !amount || opts.skip.has(asset)) return;
    const a = toFixed(amount);
    if (a > 0n) take(pk(asset, walletId), a);
  };

  for (const t of [...txns].sort((a, b) => a.at - b.at)) {
    snapUntil(t.at);
    if (!perWallet && opts.perWalletFrom !== undefined && t.at >= opts.perWalletFrom) allocate();
    if (t.type === "trade") {
      const cents =
        t.valueCents ??
        value(t.sentAsset, t.sentAmount, t.at) ??
        value(t.receivedAsset, t.receivedAmount, t.at);
      dispose(t.sentAsset, t.sentAmount, cents, t.at, "trade", t.walletId ?? null);
      acquire(t.receivedAsset, t.receivedAmount, cents, t.at, t.walletId);
    } else if (t.paired && perWallet) {
      // A move between your wallets: the lots go along (no gain).
      if (t.sentAsset && t.sentAmount && !opts.skip.has(t.sentAsset)) {
        const sent = toFixed(t.sentAmount);
        const pieces = take(pk(t.sentAsset, t.walletId), sent);
        const waiting = t.id ? pendingIn.get(t.id) : undefined;
        if (waiting && t.id) {
          pendingIn.delete(t.id);
          deliver(pieces, sent, waiting);
        } else if (t.pairId) pendingOut.set(t.pairId, { pieces, sent });
      }
      if (t.receivedAsset && t.receivedAmount && !opts.skip.has(t.receivedAsset)) {
        const to = {
          walletId: t.walletId,
          asset: t.receivedAsset,
          amount: toFixed(t.receivedAmount),
          at: t.at,
        };
        const out = t.id ? pendingOut.get(t.id) : undefined;
        if (out && t.id) {
          pendingOut.delete(t.id);
          deliver(out.pieces, out.sent, to);
        } else if (t.pairId) pendingIn.set(t.pairId, to);
      }
    } else if (!t.paired) {
      if (t.receivedAsset && t.receivedAmount) {
        const cents = t.valueCents ?? value(t.receivedAsset, t.receivedAmount, t.at);
        acquire(t.receivedAsset, t.receivedAmount, cents, t.at, t.walletId);
        if (!opts.skip.has(t.receivedAsset))
          flows.push({
            at: t.at,
            kind: INCOME_LABELS.has(t.label ?? "") ? "income" : "in",
            asset: t.receivedAsset,
            valueCents: cents,
            label: t.label,
            amount: t.receivedAmount,
            walletId: t.walletId ?? null,
          });
      }
      if (t.sentAsset && t.sentAmount) {
        const cents = t.valueCents ?? value(t.sentAsset, t.sentAmount, t.at);
        if (t.label === "cost")
          dispose(t.sentAsset, t.sentAmount, cents, t.at, "cost", t.walletId ?? null);
        else if (t.label === "lost")
          dispose(t.sentAsset, t.sentAmount, 0, t.at, "lost", t.walletId ?? null);
        else remove(t.sentAsset, t.sentAmount, t.walletId);
        if (!opts.skip.has(t.sentAsset))
          flows.push({
            at: t.at,
            kind:
              t.label === "cost"
                ? "expense"
                : t.label === "gift" || t.label === "donation" || t.label === "lost"
                  ? "gift"
                  : "out",
            asset: t.sentAsset,
            valueCents: cents,
            label: t.label,
            amount: t.sentAmount,
            walletId: t.walletId ?? null,
          });
      }
    }
    if (t.feeAsset && t.feeAmount && !opts.skip.has(t.feeAsset)) {
      const cents = t.feeValueCents ?? value(t.feeAsset, t.feeAmount, t.at);
      dispose(t.feeAsset, t.feeAmount, cents, t.at, "fee", t.walletId ?? null);
      flows.push({
        at: t.at,
        kind: "fee",
        asset: t.feeAsset,
        valueCents: cents,
        label: null,
        amount: t.feeAmount,
        walletId: t.walletId ?? null,
      });
    }
    const move = (asset: string | null, amount: string | null, sign: 1n | -1n) => {
      if (!asset || !amount || opts.skip.has(asset)) return;
      const k = `${t.walletId ?? ""}|${asset}`;
      bal.set(k, (bal.get(k) ?? 0n) + sign * toFixed(amount));
    };
    move(t.receivedAsset, t.receivedAmount, 1n);
    move(t.sentAsset, t.sentAmount, -1n);
    move(t.feeAsset, t.feeAmount, -1n);
  }
  // History ends before the switch but today is after it: assign the lots now.
  if (!perWallet && opts.perWalletFrom !== undefined && Date.now() >= opts.perWalletFrom)
    allocate();
  snapUntil(Number.POSITIVE_INFINITY);
  // Lots by coin (across wallets once tracking is per wallet), oldest first.
  const byAsset = new Map<string, TaxLot[]>();
  for (const [key, q] of lots) {
    const asset = perWallet ? key.slice(key.indexOf("|") + 1) : key;
    byAsset.set(asset, [...(byAsset.get(asset) ?? []), ...q]);
  }
  if (perWallet) for (const q of byAsset.values()) q.sort((a, b) => a.acquiredAt - b.acquiredAt);
  return { lots: byAsset, gains, flows, costAt };
}

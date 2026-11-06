/**
 * Rebuild an investment account's daily value from what it holds today and
 * its trades: walking back from today, each trade is undone (a buy removes
 * its shares and returns its cash), and each day's shares are valued at that
 * day's close. Prices are split-adjusted (as quote services report them), so
 * shares are counted in today's units: a split before a trade scales that
 * trade's shares.
 */
import { divFixed, fromFixed, mulFixed, toFixed, valueCents } from "../crypto/decimal.js";

export interface HistoryTxn {
  date: string;
  type: string;
  securityId: string | null;
  /** Shares in the units of the day (positive). */
  quantity: string | null;
  /** Cash effect in cents (negative for a buy). */
  amountCents: number;
}

export interface HistoryInput {
  /** Today's shares per security (cash excluded). */
  holdings: { securityId: string; quantity: string }[];
  /** Today's cash. */
  cashCents: number;
  txns: HistoryTxn[];
  /** Daily closes (decimal strings, split-adjusted) per security, by date. */
  prices: Map<string, Map<string, string>>;
  /** First and last day to value (YYYY-MM-DD). */
  from: string;
  to: string;
}

const ADDS = new Set(["buy", "transfer_in"]);
const REMOVES = new Set(["sell", "transfer_out"]);

function* days(from: string, to: string) {
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end) {
    yield d.toISOString().slice(0, 10);
    d.setUTCDate(d.getUTCDate() + 1);
  }
}

/** Each day's value in cents, oldest first. */
export function reconstructValues(input: HistoryInput): { date: string; valueCents: number }[] {
  return reconstructParts(input).map(({ date, valueCents }) => ({ date, valueCents }));
}

/** Each day's value, and how much of it each security was (cash is the rest). */
export function reconstructParts(
  input: HistoryInput,
): { date: string; valueCents: number; bySecurity: Map<string, number> }[] {
  const all = [...days(input.from, input.to)];
  // State as of the end of each day, walking back from today.
  const qty = new Map<string, bigint>(); // today's units
  const factor = new Map<string, bigint>(); // today's units per share of the day (fixed point)
  const ONE = toFixed(1);
  for (const h of input.holdings) qty.set(h.securityId, toFixed(h.quantity));
  let cash = input.cashCents;

  const byDate = new Map<string, HistoryTxn[]>();
  for (const t of input.txns) byDate.set(t.date, [...(byDate.get(t.date) ?? []), t]);

  // Forward-fill closes: the last close on or before a day (or the first one after, early on).
  const priceOn = new Map<string, (date: string) => string | null>();
  for (const [id, m] of input.prices) {
    const dates = [...m.keys()].sort();
    priceOn.set(id, (date) => {
      let lo = 0;
      let hi = dates.length - 1;
      let best: string | null = null;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const d = dates[mid] as string;
        if (d <= date) {
          best = d;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      const key = best ?? dates[0];
      return key ? (m.get(key) ?? null) : null;
    });
  }

  const out: { date: string; valueCents: number; bySecurity: Map<string, number> }[] = [];
  for (let i = all.length - 1; i >= 0; i--) {
    const date = all[i] as string;
    let value = Math.max(0, cash);
    const bySecurity = new Map<string, number>();
    for (const [id, q] of qty) {
      if (q <= 0n) continue;
      const p = priceOn.get(id)?.(date);
      if (!p) continue;
      const v = valueCents(fromFixed(q), p);
      bySecurity.set(id, v);
      value += v;
    }
    out.push({ date, valueCents: value, bySecurity });
    // Undo this day's transactions to get the end of the previous day.
    for (const t of byDate.get(date) ?? []) {
      cash -= t.amountCents;
      if (!t.securityId || !t.quantity) continue;
      const id = t.securityId;
      const f = factor.get(id) ?? ONE;
      const shares = mulFixed(toFixed(t.quantity), f); // in today's units
      const cur = qty.get(id) ?? 0n;
      if (t.type === "split") {
        // Before the split there were fewer shares of the day; today's units don't change.
        const actualAfter = divFixed(cur, f);
        const actualBefore = actualAfter - toFixed(t.quantity);
        if (actualBefore > 0n) factor.set(id, mulFixed(f, divFixed(actualAfter, actualBefore)));
      } else if (ADDS.has(t.type)) qty.set(id, cur - shares);
      else if (REMOVES.has(t.type)) qty.set(id, cur + shares);
    }
  }
  return out.reverse();
}

/**
 * Stock tax lots from trades, first in, first out, one account and security
 * at a time (sales happen within an account):
 *
 * - a buy opens a lot at what it cost (fees included) on its date;
 * - a split adds shares to every open lot in proportion, keeping each lot's
 *   cost and purchase date (that's how a split works for taxes);
 * - shares that arrive by transfer open a lot with no known cost or date;
 * - a sale takes the oldest shares first and becomes one disposal per
 *   holding period (Form 8949 has separate parts for short and long term);
 *   selling more than the history explains takes shares of unknown cost;
 * - shares transferred out just leave.
 *
 * Exact fixed-point throughout (18 decimals, like the crypto ledger). Wash
 * sales are estimated separately (estimateWashSales), across all accounts.
 */
import type { TaxTerm } from "@muny/shared";
import { fromFixed, toFixed } from "../crypto/decimal.js";

export interface LotTxn {
  id: string;
  accountId: string;
  securityId: string;
  /** YYYY-MM-DD */
  date: string;
  type: string;
  quantity: string | null;
  /** Cash effect: negative for a buy, positive for a sale. */
  amountCents: number;
}

const ONE = toFixed(1);

export interface OpenLot {
  /** The buy that opened it, if any. */
  txnId: string | null;
  accountId: string;
  securityId: string;
  /** YYYY-MM-DD, null when unknown. */
  acquired: string | null;
  q: bigint;
  /** Cost in cents × 10^18, null when unknown. */
  cost: bigint | null;
}

export interface Disposal {
  txnId: string;
  accountId: string;
  securityId: string;
  date: string;
  term: TaxTerm;
  q: bigint;
  proceedsCents: number;
  costCents: number | null;
  /** One purchase date, or null (unknown, or several: see `various`). */
  acquired: string | null;
  various: boolean;
  /** Buys whose shares this sale used (they can't also be its wash sale replacement). */
  usedBuys: string[];
}

export const lotKey = (accountId: string, securityId: string) => `${accountId}|${securityId}`;

/** YYYY-MM-DD plus n days. */
export function addDaysIso(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * The first day a sale counts as long term: held more than one year, counted
 * from the day after purchase. Bought 2025-03-10 → long term from 2026-03-11.
 */
export function longTermDate(acquired: string): string {
  const [y, m, d] = acquired.split("-").map(Number) as [number, number, number];
  // The anniversary (Feb 29 → Mar 1 in a non-leap year), then one more day.
  const anniversary = new Date(Date.UTC(y + 1, m - 1, d)).toISOString().slice(0, 10);
  return addDaysIso(anniversary, 1);
}

export function termOn(acquired: string | null, date: string): TaxTerm {
  if (!acquired) return "unknown";
  return date >= longTermDate(acquired) ? "long" : "short";
}

export const roundCents = (fixedCents: bigint) =>
  Number((fixedCents + (fixedCents >= 0n ? ONE / 2n : -ONE / 2n)) / ONE);

const RANK: Record<string, number> = {
  split: 0,
  buy: 1,
  transfer_in: 2,
  sell: 3,
  transfer_out: 4,
};

interface Piece {
  txnId: string | null;
  acquired: string | null;
  q: bigint;
  cost: bigint | null;
}

/** Take `q` shares from the front of `lots`; anything not covered comes back with no cost or date. */
function take(lots: OpenLot[], q: bigint): Piece[] {
  const out: Piece[] = [];
  let left = q;
  while (left > 0n && lots.length) {
    const lot = lots[0] as OpenLot;
    if (lot.q <= left) {
      out.push({ txnId: lot.txnId, acquired: lot.acquired, q: lot.q, cost: lot.cost });
      left -= lot.q;
      lots.shift();
    } else {
      const part = lot.cost === null ? null : (lot.cost * left) / lot.q;
      out.push({ txnId: lot.txnId, acquired: lot.acquired, q: left, cost: part });
      if (lot.cost !== null && part !== null) lot.cost -= part;
      lot.q -= left;
      left = 0n;
    }
  }
  if (left > 0n) out.push({ txnId: null, acquired: null, q: left, cost: null });
  return out;
}

export interface LotRun {
  /** Open lots per lotKey(account, security), oldest first. */
  open: Map<string, OpenLot[]>;
  /** Every sale, split by holding period, in date order. */
  disposals: Disposal[];
}

export function runStockLots(txns: LotTxn[]): LotRun {
  const open = new Map<string, OpenLot[]>();
  const disposals: Disposal[] = [];
  const sorted = txns
    .filter((t) => t.type in RANK && t.quantity && toFixed(t.quantity) > 0n)
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        (RANK[a.type] ?? 9) - (RANK[b.type] ?? 9) ||
        a.id.localeCompare(b.id),
    );
  for (const t of sorted) {
    const key = lotKey(t.accountId, t.securityId);
    const lots = open.get(key) ?? [];
    open.set(key, lots);
    const q = toFixed(t.quantity as string);
    if (t.type === "buy") {
      lots.push({
        txnId: t.id,
        accountId: t.accountId,
        securityId: t.securityId,
        acquired: t.date,
        q,
        cost: BigInt(Math.max(0, -t.amountCents)) * ONE,
      });
    } else if (t.type === "transfer_in") {
      lots.push({
        txnId: t.id,
        accountId: t.accountId,
        securityId: t.securityId,
        acquired: null,
        q,
        cost: null,
      });
    } else if (t.type === "split") {
      const held = lots.reduce((s, l) => s + l.q, 0n);
      if (held === 0n) {
        lots.push({
          txnId: null,
          accountId: t.accountId,
          securityId: t.securityId,
          acquired: null,
          q,
          cost: null,
        });
        continue;
      }
      // Every lot grows in proportion; the last one takes the rounding.
      let given = 0n;
      lots.forEach((l, i) => {
        const add = i === lots.length - 1 ? q - given : (q * l.q) / held;
        given += add;
        l.q += add;
      });
    } else if (t.type === "transfer_out") {
      take(lots, q);
    } else if (t.type === "sell") {
      const pieces = take(lots, q);
      const proceeds = BigInt(Math.max(0, t.amountCents));
      const groups: { term: TaxTerm; ps: Piece[] }[] = [];
      for (const term of ["short", "long", "unknown"] as const) {
        const ps = pieces.filter((p) => termOn(p.acquired, t.date) === term);
        if (ps.length) groups.push({ term, ps });
      }
      let given = 0n;
      groups.forEach(({ term, ps }, i) => {
        const gq = ps.reduce((s, p) => s + p.q, 0n);
        const share = i === groups.length - 1 ? proceeds - given : (proceeds * gq) / q;
        given += share;
        const known = ps.every((p) => p.cost !== null);
        const dates = new Set(ps.map((p) => p.acquired));
        const only = dates.size === 1 ? ([...dates][0] ?? null) : null;
        disposals.push({
          txnId: t.id,
          accountId: t.accountId,
          securityId: t.securityId,
          date: t.date,
          term,
          q: gq,
          proceedsCents: Number(share),
          costCents: known ? roundCents(ps.reduce((s, p) => s + (p.cost ?? 0n), 0n)) : null,
          acquired: only,
          various: dates.size > 1,
          usedBuys: ps.map((p) => p.txnId).filter((x): x is string => !!x),
        });
      });
    }
  }
  return { open, disposals };
}

export interface WashBuy {
  txnId: string;
  accountId: string;
  securityId: string;
  date: string;
  quantity: string;
}

export interface WashResult {
  /** Disallowed loss in cents (positive), per disposal (same order). */
  cents: number[];
  /** The account of the first replacement purchase, per disposal (null when none). */
  replacementAccount: (string | null)[];
}

/**
 * Wash sales, estimated: a sale at a loss with the same security bought within
 * 30 days before or after it, in any account (IRAs included). The part of the
 * loss matching the replacement shares is disallowed. Each purchase replaces
 * shares once, earliest sales first; the shares a sale itself sold don't count.
 * Brokers only see their own accounts, so this can find more than the 1099-B.
 */
export function estimateWashSales(disposals: Disposal[], buys: WashBuy[]): WashResult {
  const left = new Map(buys.map((b) => [b.txnId, toFixed(b.quantity)]));
  const bySec = new Map<string, WashBuy[]>();
  for (const b of buys) bySec.set(b.securityId, [...(bySec.get(b.securityId) ?? []), b]);
  for (const list of bySec.values()) list.sort((a, b) => a.date.localeCompare(b.date));
  const cents: number[] = disposals.map(() => 0);
  const replacementAccount: (string | null)[] = disposals.map(() => null);
  const order = disposals
    .map((d, i) => ({ d, i }))
    .sort((a, b) => a.d.date.localeCompare(b.d.date));
  for (const { d, i } of order) {
    if (d.costCents === null) continue;
    const loss = d.costCents - d.proceedsCents;
    if (loss <= 0) continue;
    const from = addDaysIso(d.date, -30);
    const to = addDaysIso(d.date, 30);
    const used = new Set(d.usedBuys);
    let need = d.q;
    let matched = 0n;
    for (const b of bySec.get(d.securityId) ?? []) {
      if (need <= 0n) break;
      if (b.date < from || b.date > to || used.has(b.txnId) || b.txnId === d.txnId) continue;
      const avail = left.get(b.txnId) ?? 0n;
      if (avail <= 0n) continue;
      const use = avail < need ? avail : need;
      left.set(b.txnId, avail - use);
      need -= use;
      matched += use;
      replacementAccount[i] ??= b.accountId;
    }
    if (matched > 0n) cents[i] = Number((BigInt(loss) * matched + d.q / 2n) / d.q);
  }
  return { cents, replacementAccount };
}

/** Shares as a decimal string. */
export const lotShares = (q: bigint) => fromFixed(q);
/** A lot's cost in whole cents (null when unknown). */
export const lotCostCents = (l: { cost: bigint | null }) =>
  l.cost === null ? null : roundCents(l.cost);

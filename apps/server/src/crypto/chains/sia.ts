import { Deltas, fromBaseUnits, movementsToTxns, type SyncedTxn } from "@muny/core";
import type { Adapter, ChainCtx } from "./ctx.js";

/**
 * Siacoin through SiaScan's public explorer API (api.siascan.com, the Sia
 * Foundation's `explored`): each address's events, newest first, 500 a page.
 * A Sia wallet uses many addresses, so a wallet can list several (separated
 * by commas or spaces); events touching more than one count once. Amounts are
 * in hastings (10^24 per SC). Siafunds aren't tracked.
 */

const SIASCAN = "https://api.siascan.com";
const PAGE = 500;
const HASTINGS = 24;

interface Out {
  address: string;
  value: string;
}
interface Event {
  id: string;
  index: { height: number };
  type: string;
  timestamp: string;
  data: {
    siacoinElement?: { siacoinOutput: Out };
    transaction?: {
      siacoinInputs?: Out[];
      siacoinOutputs?: { siacoinOutput: Out }[];
      minerFees?: string[];
    };
    siacoinInputs?: { parent: { siacoinOutput: Out } }[];
    siacoinOutputs?: ({ siacoinOutput: Out } | Out)[];
    minerFee?: string;
  };
}

export const siaAddresses = (source: string) => [
  ...new Set(
    source
      .split(/[\s,;]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  ),
];

/** Hastings (24 decimals) → SC; Muny keeps 18 decimals (anything smaller is dust). */
export function hastingsToSc(hastings: string): string {
  const digits = (hastings || "0").replace(/^0+/, "") || "0";
  if (!/^\d+$/.test(digits)) return "0";
  const trimmed =
    digits.length > HASTINGS - 18 ? digits.slice(0, digits.length - (HASTINGS - 18)) : "0";
  return fromBaseUnits(trimmed, 18);
}

/**
 * Who a transaction paid, and how much (v1 or v2 transaction): to find the
 * wallet's other addresses from imported deposits.
 */
export async function siaTxnOutputs(
  ctx: Pick<ChainCtx, "get" | "override">,
  id: string,
): Promise<{ address: string; amount: string }[]> {
  const base = (ctx.override || SIASCAN).replace(/\/+$/, "");
  const txid = id.replace(/^(txn:|0x)/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(txid)) return [];
  type Tx = { siacoinOutputs?: ({ siacoinOutput: Out } | Out)[] };
  let tx: Tx | null = null;
  for (const path of [`transactions/${txid}`, `v2/transactions/${txid}`]) {
    try {
      tx = await ctx.get<Tx>(`${base}/${path}`);
      break;
    } catch {
      // Not that version: try the other.
    }
  }
  return (tx?.siacoinOutputs ?? []).map((o) => {
    const out = "siacoinOutput" in o ? o.siacoinOutput : o;
    return { address: out.address.toLowerCase(), amount: hastingsToSc(out.value) };
  });
}

export const sia: Adapter = async (ctx) => {
  const base = (ctx.override || SIASCAN).replace(/\/+$/, "");
  const mine = new Set(siaAddresses(ctx.source));
  const since = ctx.cursor?.height ?? 0;
  const events = new Map<string, Event>();
  let height = since;
  for (const addr of mine) {
    for (let offset = 0; ; offset += PAGE) {
      const page = await ctx.get<Event[]>(
        `${base}/addresses/${addr}/events?limit=${PAGE}&offset=${offset}`,
      );
      let older = false;
      for (const e of page ?? []) {
        // Newest first: stop at what the last sync already saw.
        if (e.index.height <= since) {
          older = true;
          break;
        }
        events.set(e.id, e);
        height = Math.max(height, e.index.height);
      }
      if (older || (page ?? []).length < PAGE) break;
    }
  }

  const sc = hastingsToSc;
  const mapped: SyncedTxn[] = [];
  for (const e of events.values()) {
    const d = new Deltas();
    let fee: string | null = null;
    const payout = e.data.siacoinElement?.siacoinOutput;
    if (payout) {
      if (mine.has(payout.address)) d.add("SC", sc(payout.value));
    } else {
      const v1 = e.data.transaction;
      const ins: Out[] = v1
        ? (v1.siacoinInputs ?? [])
        : (e.data.siacoinInputs ?? []).map((i) => i.parent.siacoinOutput);
      const outs: Out[] = (v1 ? (v1.siacoinOutputs ?? []) : (e.data.siacoinOutputs ?? [])).map(
        (o) => ("siacoinOutput" in o ? o.siacoinOutput : o),
      );
      const spent = ins.filter((i) => mine.has(i.address));
      for (const i of spent) d.add("SC", sc(i.value), -1);
      for (const o of outs) if (mine.has(o.address)) d.add("SC", sc(o.value));
      // Whoever spent pays the fee: it's part of what left, shown separately.
      const fees = v1 ? (v1.minerFees ?? []) : e.data.minerFee ? [e.data.minerFee] : [];
      if (spent.length && fees.length) {
        const f = new Deltas();
        for (const x of fees) f.add("SC", sc(x));
        fee = f.toStrings().get("SC") ?? null;
        if (fee) d.add("SC", fee, 1);
      }
    }
    mapped.push(
      ...movementsToTxns({
        externalId: `sc:${e.id}`,
        at: Date.parse(e.timestamp),
        txHash: e.id,
        deltas: d.toStrings(),
        fee: fee ? { asset: "SC", amount: fee } : null,
        // Payouts: block rewards (mining), or host / siafund / foundation income.
        label: payout ? (/miner/i.test(e.type) ? "mining" : "income") : null,
      }),
    );
  }

  let total = new Deltas();
  for (const addr of mine) {
    const b = await ctx.get<{ unspentSiacoins: string; immatureSiacoins?: string }>(
      `${base}/addresses/${addr}/balance`,
    );
    total = total.add("SC", sc(b.unspentSiacoins)).add("SC", sc(b.immatureSiacoins ?? "0"));
  }
  return {
    mapped,
    height,
    balances: [{ asset: "SC", amount: total.toStrings().get("SC") ?? "0" }],
  };
};

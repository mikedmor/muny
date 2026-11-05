import {
  Deltas,
  fromBaseUnits,
  movementsToTxns,
  plausibleSymbol,
  type SyncedTxn,
} from "@muny/core";
import { type Adapter, SyncError } from "./ctx.js";

/**
 * Algorand through AlgoNode's free public indexer (no key): ALGO payments,
 * Algorand Standard Assets (tokens), payments from smart contracts (inner
 * transactions) and the old participation rewards (label "staking").
 */

const INDEXER = "https://mainnet-idx.algonode.cloud";
const ALGO = 6;
const PAGE = 1000;

interface AlgoTxn {
  id?: string;
  "confirmed-round"?: number;
  "round-time"?: number;
  sender: string;
  fee?: number;
  "tx-type"?: string;
  "payment-transaction"?: {
    receiver: string;
    amount: number;
    "close-remainder-to"?: string;
    "close-amount"?: number;
  };
  "asset-transfer-transaction"?: {
    "asset-id": number;
    amount: number;
    receiver: string;
    "close-to"?: string;
    "close-amount"?: number;
    sender?: string;
  };
  "sender-rewards"?: number;
  "receiver-rewards"?: number;
  "close-rewards"?: number;
  "inner-txns"?: AlgoTxn[];
}

export const algorand: Adapter = async (ctx) => {
  const base = (ctx.override || INDEXER).replace(/\/+$/, "");
  const me = ctx.source;
  const minRound = ctx.cursor ? ctx.cursor.height + 1 : 0;
  const txns: AlgoTxn[] = [];
  let next: string | undefined;
  for (let round = 0; ; round++) {
    if (round > 50) throw new SyncError("Too many transactions to sync in one go");
    const q = new URLSearchParams({ limit: String(PAGE) });
    if (minRound) q.set("min-round", String(minRound));
    if (next) q.set("next", next);
    const page = await ctx.get<{ transactions?: AlgoTxn[]; "next-token"?: string }>(
      `${base}/v2/accounts/${me}/transactions?${q}`,
    );
    txns.push(...(page.transactions ?? []));
    next = page["next-token"];
    if (!next || (page.transactions ?? []).length < PAGE) break;
  }

  // Token names and decimals (one lookup per token, cached for this sync).
  const assets = new Map<number, { sym: string | null; decimals: number }>();
  const asset = async (id: number) => {
    let a = assets.get(id);
    if (!a) {
      const r = await ctx.get<{
        asset?: { params?: { decimals?: number; "unit-name"?: string } };
      }>(`${base}/v2/assets/${id}`);
      a = {
        sym: plausibleSymbol(r.asset?.params?.["unit-name"]),
        decimals: r.asset?.params?.decimals ?? 0,
      };
      assets.set(id, a);
    }
    return a;
  };

  const mapped: SyncedTxn[] = [];
  let height = ctx.cursor?.height ?? 0;
  for (const top of txns) {
    const r = top["confirmed-round"] ?? 0;
    if (r > height) height = r;
    const d = new Deltas();
    const rewards = new Deltas();
    let fee = "0";
    const walk = async (t: AlgoTxn) => {
      const pay = t["payment-transaction"];
      const axfer = t["asset-transfer-transaction"];
      if (t.sender === me && t.fee) fee = fromBaseUnits(String(t.fee), ALGO);
      if (pay) {
        const amt = fromBaseUnits(String(pay.amount), ALGO);
        if (t.sender === me) d.add("ALGO", amt, -1);
        if (pay.receiver === me) d.add("ALGO", amt, 1);
        const close = fromBaseUnits(String(pay["close-amount"] ?? 0), ALGO);
        if (pay["close-remainder-to"]) {
          if (t.sender === me) d.add("ALGO", close, -1);
          if (pay["close-remainder-to"] === me) d.add("ALGO", close, 1);
        }
      }
      if (axfer) {
        const a = await asset(axfer["asset-id"]);
        if (a.sym) {
          const from = axfer.sender ?? t.sender; // clawback sender
          const amt = fromBaseUnits(String(axfer.amount), a.decimals);
          if (from === me) d.add(a.sym, amt, -1);
          if (axfer.receiver === me) d.add(a.sym, amt, 1);
          const close = fromBaseUnits(String(axfer["close-amount"] ?? 0), a.decimals);
          if (axfer["close-to"]) {
            if (from === me) d.add(a.sym, close, -1);
            if (axfer["close-to"] === me) d.add(a.sym, close, 1);
          }
        }
      }
      // Legacy participation rewards paid out with this transaction.
      if (t.sender === me && t["sender-rewards"])
        rewards.add("ALGO", fromBaseUnits(String(t["sender-rewards"]), ALGO));
      if (pay?.receiver === me && t["receiver-rewards"])
        rewards.add("ALGO", fromBaseUnits(String(t["receiver-rewards"]), ALGO));
      for (const inner of t["inner-txns"] ?? []) await walk(inner);
    };
    await walk(top);
    // (Amounts above exclude the fee: it's charged on top, its own column.)
    const at = (top["round-time"] ?? 0) * 1000;
    const id = top.id ?? `${r}`;
    mapped.push(
      ...movementsToTxns({
        externalId: `algo:${id}`,
        at,
        txHash: top.id ?? null,
        deltas: d.toStrings(),
        fee: { asset: "ALGO", amount: fee },
      }),
      ...movementsToTxns({
        externalId: `algo:${id}:reward`,
        at,
        txHash: null,
        deltas: rewards.toStrings(),
        label: "staking",
      }),
    );
  }

  const acct = await ctx.get<{
    account?: { amount?: number; assets?: { "asset-id": number; amount: number }[] };
  }>(`${base}/v2/accounts/${me}?exclude=created-assets,created-apps,apps-local-state`);
  const balances = [];
  if (acct.account?.amount !== undefined)
    balances.push({ asset: "ALGO", amount: fromBaseUnits(String(acct.account.amount), ALGO) });
  for (const h of acct.account?.assets ?? []) {
    if (!h.amount) continue;
    const a = await asset(h["asset-id"]);
    if (a.sym) balances.push({ asset: a.sym, amount: fromBaseUnits(String(h.amount), a.decimals) });
  }
  return { mapped, height, balances };
};

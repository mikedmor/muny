import { Deltas, fromBaseUnits, movementsToTxns, type SyncedTxn } from "@muny/core";
import { type Adapter, SyncError } from "./ctx.js";

/**
 * Cosmos Hub (ATOM) through a public REST (LCD) node (no key).
 *
 * Staking: ATOM moved into or out of the staking pools is still yours, so
 * those transfers are ignored and the computed balance includes delegated and
 * unbonding ATOM (the on-chain check adds them up the same way). Rewards paid
 * by the distribution module are income (label "staking"). Fees come from the
 * transaction, not from the fee collector transfer.
 *
 * Public nodes may prune old transactions; imported history fills the gap.
 * They also refuse height-range queries, so searches run newest first.
 */

// cosmos.directory spreads requests over many public nodes, some of which keep history.
const LCD = "https://rest.cosmos.directory/cosmoshub";
const DENOM = "uatom";
const DECIMALS = 6;
const PAGE = 100;
const MODULES = {
  feeCollector: "cosmos17xpfvakm2amg962yls6f84z3kell8c5lserqta",
  bonded: "cosmos1fl48vsnmsdzcv85q5d2q4z5ajdha8yu34mf0eh",
  notBonded: "cosmos1tygms3xhhs3yv487phx3dw4a95jn7t7lpm470r",
  distribution: "cosmos1jv65s3grqf6v6jl3dp4t6c9t9rk99cd88lyufl",
};
const STAKING_POOLS = new Set([MODULES.bonded, MODULES.notBonded]);

interface Attr {
  key: string;
  value: string;
}
interface TxResponse {
  height: string;
  txhash: string;
  timestamp: string;
  code?: number;
  events?: { type: string; attributes: Attr[] }[];
  tx?: { auth_info?: { fee?: { amount?: { denom: string; amount: string }[] } } };
}

/** "123uatom,5ibc/…" → uatom amount. */
const atomIn = (amount: string) => {
  for (const part of amount.split(",")) {
    const m = /^(\d+)(.+)$/.exec(part.trim());
    if (m && m[2] === DENOM) return m[1] as string;
  }
  return null;
};

export const cosmos: Adapter = async (ctx) => {
  const base = (ctx.override || LCD).replace(/\/+$/, "");
  const me = ctx.source;
  // Public nodes refuse height ranges, so search newest first and stop at the
  // last synced block.
  const after = ctx.cursor?.height ?? 0;
  const search = async (filter: string) => {
    const out: TxResponse[] = [];
    for (let page = 1; page <= 100; page++) {
      const q = new URLSearchParams({
        query: `${filter}='${me}'`,
        page: String(page),
        limit: String(PAGE),
        order_by: "ORDER_BY_DESC",
      });
      const r = await ctx.get<{ tx_responses?: TxResponse[]; total?: string }>(
        `${base}/cosmos/tx/v1beta1/txs?${q}`,
      );
      const rows = r.tx_responses ?? [];
      const fresh = rows.filter((t) => Number(t.height) > after);
      out.push(...fresh);
      if (rows.length < PAGE || fresh.length < rows.length) return out;
    }
    throw new SyncError("Too many transactions to sync in one go");
  };
  const sent = await search("message.sender");
  const received = await search("transfer.recipient");
  const all = new Map<string, { tx: TxResponse; mine: boolean }>();
  for (const tx of received) all.set(tx.txhash, { tx, mine: false });
  for (const tx of sent) all.set(tx.txhash, { tx, mine: true });

  const mapped: SyncedTxn[] = [];
  let height = ctx.cursor?.height ?? 0;
  for (const { tx, mine } of all.values()) {
    const h = Number(tx.height);
    if (h > height) height = h;
    const d = new Deltas();
    const rewards = new Deltas();
    if (!tx.code)
      for (const ev of tx.events ?? []) {
        if (ev.type !== "transfer") continue;
        const get = (k: string) => ev.attributes.find((a) => a.key === k)?.value ?? "";
        const recipient = get("recipient");
        const sender = get("sender");
        const amt = atomIn(get("amount"));
        if (!amt) continue;
        const atom = fromBaseUnits(amt, DECIMALS);
        if (recipient === me && sender !== me) {
          if (STAKING_POOLS.has(sender)) continue;
          if (sender === MODULES.distribution) rewards.add("ATOM", atom);
          else d.add("ATOM", atom);
        }
        if (sender === me && recipient !== me) {
          if (STAKING_POOLS.has(recipient) || recipient === MODULES.feeCollector) continue;
          d.add("ATOM", atom, -1);
        }
      }
    const feeUatom = mine
      ? atomIn((tx.tx?.auth_info?.fee?.amount ?? []).map((c) => `${c.amount}${c.denom}`).join(","))
      : null;
    const at = Date.parse(tx.timestamp);
    mapped.push(
      ...movementsToTxns({
        externalId: `atom:${tx.txhash}`,
        at,
        txHash: tx.txhash,
        deltas: d.toStrings(),
        fee: feeUatom ? { asset: "ATOM", amount: fromBaseUnits(feeUatom, DECIMALS) } : null,
      }),
      ...movementsToTxns({
        externalId: `atom:${tx.txhash}:reward`,
        at,
        txHash: null,
        deltas: rewards.toStrings(),
        label: "staking",
      }),
    );
  }

  // Liquid + delegated + unbonding ATOM.
  let total = 0n;
  const bank = await ctx.get<{ balances?: { denom: string; amount: string }[] }>(
    `${base}/cosmos/bank/v1beta1/balances/${me}`,
  );
  total += BigInt(bank.balances?.find((b) => b.denom === DENOM)?.amount ?? "0");
  const del = await ctx.get<{ delegation_responses?: { balance?: { amount: string } }[] }>(
    `${base}/cosmos/staking/v1beta1/delegations/${me}`,
  );
  for (const r of del.delegation_responses ?? []) total += BigInt(r.balance?.amount ?? "0");
  const unb = await ctx.get<{ unbonding_responses?: { entries?: { balance: string }[] }[] }>(
    `${base}/cosmos/staking/v1beta1/delegators/${me}/unbonding_delegations`,
  );
  for (const r of unb.unbonding_responses ?? [])
    for (const e of r.entries ?? []) total += BigInt(e.balance ?? "0");
  return {
    mapped,
    height,
    balances: [{ asset: "ATOM", amount: fromBaseUnits(total.toString(), DECIMALS) }],
    notice:
      (ctx.cursor?.height ?? 0) === 0 && all.size === 0 && total > 0n
        ? "The Cosmos node returned no transactions for this address: public nodes often keep only recent history. Your imported history stays; Reconcile can add what's missing."
        : undefined,
  };
};

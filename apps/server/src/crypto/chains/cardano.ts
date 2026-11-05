import { Deltas, fromBaseUnits, movementsToTxns, type SyncedTxn } from "@muny/core";
import { type Adapter, SyncError } from "./ctx.js";

/**
 * Cardano through Koios (free public API, no key). A stake address (stake1…)
 * covers every address of the wallet; a payment address (addr1…) is resolved
 * to its stake address when it has one.
 *
 * Staking rewards are income when earned (per epoch, label "staking").
 * Withdrawing rewards only moves them into the wallet, so withdrawals are not
 * income again. The computed balance then matches Cardano's total balance
 * (UTxOs + unwithdrawn rewards). Native tokens are not tracked yet.
 */

const KOIOS = "https://api.koios.rest/api/v1";
/** The public tier limits request bodies to 1 KB: about 10 hashes per call. */
const HASHES_PER_CALL = 10;
const PAGE = 1000;
const ADA = 6;
// Shelley epochs are 5 days; epoch 208 began 2020-07-29T21:44:51Z.
const epochStart = (e: number) => (1_596_059_091 + (e - 208) * 432_000) * 1000;

interface TxRef {
  tx_hash: string;
  block_height: number;
  block_time: number;
}
interface Io {
  payment_addr?: { bech32?: string } | null;
  stake_addr?: string | null;
  value: string;
}
interface TxInfo {
  tx_hash: string;
  block_height: number;
  tx_timestamp: number;
  fee: string;
  inputs?: Io[];
  outputs?: Io[];
  withdrawals?: { amount: string; stake_addr: string }[] | null;
}
interface Reward {
  earned_epoch: number;
  spendable_epoch: number;
  amount: string;
  type: string;
  pool_id?: string | null;
}

export const cardano: Adapter = async (ctx) => {
  const base = (ctx.override || KOIOS).replace(/\/+$/, "");
  let stake = ctx.source.startsWith("stake1") ? ctx.source : null;
  const addr = stake ? null : ctx.source;
  if (addr) {
    const info = await ctx.post<{ stake_address?: string | null }[]>(`${base}/address_info`, {
      _addresses: [addr],
    });
    stake = info[0]?.stake_address ?? null;
  }
  const after = ctx.cursor?.height ?? 0;

  // Transaction list (newest positions only).
  const refs: TxRef[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = stake
      ? await ctx.get<TxRef[]>(
          `${base}/account_txs?_stake_address=${encodeURIComponent(stake)}&_after_block_height=${after}&offset=${offset}&limit=${PAGE}`,
        )
      : await ctx.post<TxRef[]>(`${base}/address_txs?offset=${offset}&limit=${PAGE}`, {
          _addresses: [addr],
          _after_block_height: after,
        });
    refs.push(...page);
    if (page.length < PAGE) break;
    if (offset > 50 * PAGE) throw new SyncError("Too many transactions to sync in one go");
  }

  const mine = (io: Io) => (stake ? io.stake_addr === stake : io.payment_addr?.bech32 === addr);
  const lovelace = (s: string) => fromBaseUnits(s, ADA);
  const mapped: SyncedTxn[] = [];
  let height = after;
  const hashes = [...new Set(refs.map((r) => r.tx_hash))];
  for (let i = 0; i < hashes.length; i += HASHES_PER_CALL) {
    const infos = await ctx.post<TxInfo[]>(`${base}/tx_info`, {
      _tx_hashes: hashes.slice(i, i + HASHES_PER_CALL),
      _inputs: true,
      _withdrawals: true,
    });
    for (const tx of infos) {
      if (tx.block_height > height) height = tx.block_height;
      const d = new Deltas();
      let paid = false;
      for (const io of tx.inputs ?? [])
        if (mine(io)) {
          d.add("ADA", lovelace(io.value), -1);
          paid = true;
        }
      for (const io of tx.outputs ?? []) if (mine(io)) d.add("ADA", lovelace(io.value), 1);
      // Withdrawn rewards were counted when earned: they don't leave or arrive.
      for (const w of tx.withdrawals ?? [])
        if (stake && w.stake_addr === stake) d.add("ADA", lovelace(w.amount), -1);
      // The fee is its own column, not part of what was sent.
      if (paid) d.add("ADA", lovelace(tx.fee), 1);
      mapped.push(
        ...movementsToTxns({
          externalId: `ada:${tx.tx_hash}`,
          at: tx.tx_timestamp * 1000,
          txHash: tx.tx_hash,
          deltas: d.toStrings(),
          fee: paid ? { asset: "ADA", amount: lovelace(tx.fee) } : null,
        }),
      );
    }
  }

  const balances = [];
  if (stake) {
    // Rewards: all of them each time (cheap: one call); rows are keyed by epoch.
    const now = Date.now();
    const rewards = await ctx.post<Reward[]>(`${base}/account_reward_history`, {
      _stake_addresses: [stake],
    });
    for (const r of rewards) {
      const at = epochStart(r.spendable_epoch);
      if (at > now) continue;
      mapped.push({
        externalId: `ada:reward:${r.earned_epoch}:${r.type}:${r.pool_id ?? ""}`,
        at,
        type: "deposit",
        label: "staking",
        sentAsset: null,
        sentAmount: null,
        receivedAsset: "ADA",
        receivedAmount: lovelace(r.amount),
        feeAsset: null,
        feeAmount: null,
        txHash: "",
      });
    }
    const acct = await ctx.post<{ total_balance?: string }[]>(`${base}/account_info`, {
      _stake_addresses: [stake],
    });
    if (acct[0]?.total_balance)
      balances.push({ asset: "ADA", amount: lovelace(acct[0].total_balance) });
  } else {
    const info = await ctx.post<{ balance?: string }[]>(`${base}/address_info`, {
      _addresses: [addr],
    });
    if (info[0]?.balance) balances.push({ asset: "ADA", amount: lovelace(info[0].balance) });
  }
  return { mapped: mapped.filter((t) => t.receivedAmount !== "0"), height, balances };
};

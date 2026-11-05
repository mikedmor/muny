import { fromBaseUnits, HdAccount, type HdCoin, isExtendedKey, type SyncedTxn } from "@muny/core";
import { type Adapter, SyncError } from "./ctx.js";

/**
 * Dogecoin and Zcash (transparent) through Blockchair's free API (no key).
 * Up to 100 addresses are looked up in one call; an extended public key is
 * expanded locally into addresses (receive + change, 20 unused in a row).
 *
 * Blockchair reports each transaction's net balance change for the whole
 * address set, so transfers between the wallet's own addresses cancel out.
 * The fee is not separate: what was sent includes it.
 */

const SLUG: Partial<Record<string, string>> = { doge: "dogecoin", zec: "zcash" };
const GAP = 20;
const MAX_ADDRESSES = 100;
const PAGE = 100;

interface Dash {
  data?: {
    set?: { balance?: number | string; transaction_count?: number };
    addresses?: Record<
      string,
      { output_count?: number; transaction_count?: number; received?: number | string }
    >;
    transactions?: {
      block_id: number;
      hash: string;
      time: string;
      balance_change: number | string;
    }[];
  };
}

const used = (a?: {
  output_count?: number;
  transaction_count?: number;
  received?: number | string;
}) =>
  !!a &&
  ((a.output_count ?? 0) > 0 || (a.transaction_count ?? 0) > 0 || Number(a.received ?? 0) > 0);

export const blockchair: Adapter = async (ctx) => {
  const { chain } = ctx;
  const slug = SLUG[chain.key];
  const base = (ctx.override || (slug ? `https://api.blockchair.com/${slug}` : "")).replace(
    /\/+$/,
    "",
  );
  if (!base) throw new SyncError(`No ${chain.name} service configured`);
  const dash = (addrs: string[], offset = 0) =>
    ctx.get<Dash>(
      `${base}/dashboards/addresses/${addrs.join(",")}?transaction_details=true&limit=${PAGE},0&offset=${offset},0`,
    );

  // The wallet's addresses (an xpub is expanded in batches of 20 per chain).
  let addrs: string[];
  if (isExtendedKey(ctx.source)) {
    const acct = new HdAccount(ctx.source, chain.key as HdCoin);
    const keep: string[] = [];
    for (const c of [0, 1] as const) {
      for (let start = 0; ; start += GAP) {
        const batch = Array.from({ length: GAP }, (_, i) => acct.address(c, start + i));
        const r = await dash(batch);
        const hit = batch.filter((a) => used(r.data?.addresses?.[a]));
        keep.push(...hit);
        // A whole batch unused = 20 unused in a row: the end of this chain.
        if (hit.length === 0) break;
        if (keep.length > MAX_ADDRESSES)
          throw new SyncError("This wallet has more addresses than Muny can sync in one go");
      }
    }
    addrs = keep.length ? keep : [acct.address(0, 0)];
  } else addrs = [ctx.source];

  // Transactions, newest first, until we reach what we've already seen.
  const known = Number(ctx.cursor?.pos?.count ?? 0);
  const rows: NonNullable<NonNullable<Dash["data"]>["transactions"]> = [];
  let first: Dash | null = null;
  for (let offset = 0; offset < 100 * PAGE; offset += PAGE) {
    const r = await dash(addrs, offset);
    first ??= r;
    const page = r.data?.transactions ?? [];
    rows.push(...page);
    const total = r.data?.set?.transaction_count ?? 0;
    if (page.length < PAGE || rows.length >= total - known) break;
  }

  const mapped: SyncedTxn[] = [];
  let height = ctx.cursor?.height ?? 0;
  for (const t of rows) {
    if (t.block_id > height) height = t.block_id;
    if (t.block_id < 0) continue; // unconfirmed
    const change = BigInt(String(t.balance_change));
    if (change === 0n) continue;
    const amount = fromBaseUnits((change < 0n ? -change : change).toString(), chain.decimals);
    const at = Date.parse(`${t.time.replace(" ", "T")}Z`);
    mapped.push({
      externalId: `bc:${t.hash}`,
      at,
      type: change > 0n ? "deposit" : "withdrawal",
      sentAsset: change < 0n ? chain.asset : null,
      sentAmount: change < 0n ? amount : null,
      receivedAsset: change > 0n ? chain.asset : null,
      receivedAmount: change > 0n ? amount : null,
      feeAsset: null,
      feeAmount: null,
      txHash: t.hash,
    });
  }
  const bal = first?.data?.set?.balance;
  const balances =
    bal !== undefined
      ? [{ asset: chain.asset, amount: fromBaseUnits(String(bal), chain.decimals) }]
      : [];
  return {
    mapped,
    height,
    balances,
    pos: { count: first?.data?.set?.transaction_count ?? 0 },
  };
};

import {
  Deltas,
  fromBaseUnits,
  movementsToTxns,
  normDec,
  plausibleSymbol,
  type SyncedTxn,
} from "@muny/core";
import { type Adapter, SyncError } from "./ctx.js";

/**
 * Stellar through Horizon (stellar.org's free public API, no key).
 *
 * Balance changes come from the account's effects (credits, debits, trades,
 * account creation), grouped per operation; fees come from the transactions
 * the account paid for. Amounts are already decimals (7 places).
 */

const HORIZON = "https://horizon.stellar.org";
const PAGE = 200;
const MAX_PAGES = 100;

interface Effect {
  id: string;
  paging_token: string;
  type: string;
  created_at: string;
  amount?: string;
  asset_type?: string;
  asset_code?: string;
  starting_balance?: string;
  sold_amount?: string;
  sold_asset_type?: string;
  sold_asset_code?: string;
  bought_amount?: string;
  bought_asset_type?: string;
  bought_asset_code?: string;
}
interface Tx {
  hash: string;
  paging_token: string;
  created_at: string;
  ledger: number;
  fee_account?: string;
  source_account: string;
  fee_charged?: string;
}
interface Page<T> {
  _embedded?: { records?: T[] };
}

const assetOf = (type: string | undefined, code: string | undefined) =>
  type === "native" ? "XLM" : plausibleSymbol(code);
const STROOP = 7;

export const stellar: Adapter = async (ctx) => {
  const base = (ctx.override || HORIZON).replace(/\/+$/, "");
  const me = ctx.source;
  const pos = { ...(ctx.cursor?.pos ?? {}) };

  /** Every record after the stored paging token, oldest first. */
  const all = async <T extends { paging_token: string }>(path: string, key: string) => {
    const out: T[] = [];
    let cursor = String(pos[key] ?? "");
    for (let n = 0; n < MAX_PAGES; n++) {
      const q = new URLSearchParams({ order: "asc", limit: String(PAGE) });
      if (cursor) q.set("cursor", cursor);
      const page = await ctx.get<Page<T>>(`${base}/accounts/${me}/${path}?${q}`);
      const rows = page._embedded?.records ?? [];
      out.push(...rows);
      if (rows.length) cursor = (rows[rows.length - 1] as T).paging_token;
      if (rows.length < PAGE) {
        if (cursor) pos[key] = cursor;
        return out;
      }
    }
    throw new SyncError("Too many transactions to sync in one go");
  };

  let effects: Effect[];
  try {
    effects = await all<Effect>("effects", "effects");
  } catch (err) {
    // Horizon has no history for accounts that were closed (merged into another)
    // or never funded. That's not a sync failure.
    if (err instanceof SyncError && /HTTP 404/.test(err.message))
      return {
        mapped: [],
        height: ctx.cursor?.height ?? 0,
        balances: [{ asset: "XLM", amount: "0" }],
        notice:
          "Stellar has no history for this account: it was closed (merged into another account) or never funded. If you moved its XLM elsewhere, import that history or add the wallet that received it.",
      };
    throw err;
  }
  const txs = await all<Tx>("transactions", "txs");

  // Group effects by operation (an effect id is "<operation id>-<n>").
  const ops = new Map<string, { at: number; d: Deltas }>();
  for (const e of effects) {
    const op = e.id.split("-")[0] as string;
    const g = ops.get(op) ?? { at: Date.parse(e.created_at), d: new Deltas() };
    ops.set(op, g);
    if (e.type === "account_created" && e.starting_balance)
      g.d.add("XLM", normDec(e.starting_balance), 1);
    if ((e.type === "account_credited" || e.type === "account_debited") && e.amount) {
      const a = assetOf(e.asset_type, e.asset_code);
      if (a) g.d.add(a, normDec(e.amount), e.type === "account_credited" ? 1 : -1);
    }
    if (e.type === "trade") {
      const sold = assetOf(e.sold_asset_type, e.sold_asset_code);
      const bought = assetOf(e.bought_asset_type, e.bought_asset_code);
      if (sold && e.sold_amount) g.d.add(sold, normDec(e.sold_amount), -1);
      if (bought && e.bought_amount) g.d.add(bought, normDec(e.bought_amount), 1);
    }
  }
  const mapped: SyncedTxn[] = [];
  for (const [op, g] of ops)
    mapped.push(
      ...movementsToTxns({
        externalId: `xlm:op:${op}`,
        at: g.at,
        txHash: null,
        deltas: g.d.toStrings(),
      }),
    );
  // Fees this account paid (one row per transaction).
  let height = ctx.cursor?.height ?? 0;
  for (const tx of txs) {
    if (tx.ledger > height) height = tx.ledger;
    if ((tx.fee_account ?? tx.source_account) !== me || !tx.fee_charged) continue;
    const fee = fromBaseUnits(tx.fee_charged, STROOP);
    mapped.push(
      ...movementsToTxns({
        externalId: `xlm:fee:${tx.hash}`,
        at: Date.parse(tx.created_at),
        txHash: tx.hash,
        deltas: new Map(),
        fee: { asset: "XLM", amount: fee },
      }),
    );
  }

  // A merged (closed) account has no balances left.
  const acct = await ctx
    .get<{ balances?: { balance: string; asset_type: string; asset_code?: string }[] }>(
      `${base}/accounts/${me}`,
    )
    .catch((err) => {
      if (err instanceof SyncError && /HTTP 404/.test(err.message)) return { balances: [] };
      throw err;
    });
  const balances = [];
  for (const b of acct.balances ?? []) {
    const a = assetOf(b.asset_type, b.asset_code);
    if (a && normDec(b.balance) !== "0") balances.push({ asset: a, amount: normDec(b.balance) });
  }
  return { mapped, height, balances, pos };
};

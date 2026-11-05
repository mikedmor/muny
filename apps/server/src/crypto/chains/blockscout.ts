import {
  type EsInternal,
  type EsTokenTx,
  type EsTx,
  fromBaseUnits,
  mapEvmHistory,
  plausibleSymbol,
} from "@muny/core";
import { schema } from "@muny/db";
import { eq } from "drizzle-orm";
import { decryptJson } from "../../lib/crypto.js";
import { BLOCKSCOUT_KEY } from "../prices.js";
import { type Adapter, type Cursor, SyncError, safeText } from "./ctx.js";

/**
 * EVM chains through Blockscout's Etherscan-compatible account API. With a
 * free key (sent as a header) one endpoint serves every chain; without one,
 * each chain's public instance is used.
 */

const API = "https://api.blockscout.com";
const PAGE_SIZE = 1000;
const MAX_ROUNDS = 50;

interface EsResponse<T> {
  status?: string;
  message?: string;
  result?: T[] | string;
}

export const blockscout: Adapter = async (ctx) => {
  const { chain, source: address, cursor } = ctx;
  const override = ctx.override.replace(/\/+$/, "");
  const enc = ctx.db
    .select()
    .from(schema.appSettings)
    .where(eq(schema.appSettings.key, BLOCKSCOUT_KEY))
    .get()?.value as string | undefined;
  const key =
    !override && enc && ctx.deps.secretKey ? decryptJson<string>(ctx.deps.secretKey, enc) : null;
  const base = override
    ? `${override}/api`
    : key
      ? `${API}/${chain.chainId}/api`
      : `${chain.server}/api`;
  const headers: Record<string, string> = key ? { authorization: `Bearer ${key}` } : {};
  const host = new URL(base).host;

  const call = async <T>(params: Record<string, string | number>): Promise<T[] | string> => {
    const q = new URLSearchParams({ module: "account", address });
    for (const [k, v] of Object.entries(params)) q.set(k, String(v));
    const r = await ctx.get<EsResponse<T>>(`${base}?${q}`, headers);
    if (r.status === "1" || Array.isArray(r.result)) return r.result ?? [];
    if (/^no /i.test(r.message ?? "") || /^no /i.test(String(r.result))) return [];
    throw new SyncError(
      `${host}: ${safeText(typeof r.result === "string" ? r.result : r.message)}`,
    );
  };
  /** All rows of a list from the cursor on, oldest first, paging by block. */
  const list = async <T extends { blockNumber: string }>(action: string): Promise<T[]> => {
    const out: T[] = [];
    const seen = new Set<string>();
    let start = cursor?.height ?? 0;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const rows = await call<T>({
        action,
        startblock: start,
        sort: "asc",
        page: 1,
        offset: PAGE_SIZE,
      });
      if (typeof rows === "string") return out;
      for (const r of rows) {
        const k = JSON.stringify(r);
        if (!seen.has(k)) {
          seen.add(k);
          out.push(r);
        }
      }
      if (rows.length < PAGE_SIZE) return out;
      const last = Number(rows[rows.length - 1]?.blockNumber ?? start);
      if (last <= start) throw new SyncError("Too many transactions in one block to sync");
      start = last;
    }
    throw new SyncError("Too many transactions to sync in one go");
  };

  const txs = await list<EsTx>("txlist");
  const internals = await list<EsInternal>("txlistinternal");
  const tokens = await list<EsTokenTx>("tokentx");
  const { txns, maxBlock } = mapEvmHistory(
    address,
    { asset: chain.asset, decimals: chain.decimals },
    { txs, internals, tokens },
  );

  const balances: Cursor["balances"] = [];
  const bal = await call<never>({ action: "balance" });
  if (typeof bal === "string" && /^\d+$/.test(bal))
    balances.push({ asset: chain.asset, amount: fromBaseUnits(bal, chain.decimals) });
  const held = await call<{ balance?: string; decimals?: string; symbol?: string; type?: string }>({
    action: "tokenlist",
  });
  if (Array.isArray(held))
    for (const tk of held) {
      const sym = plausibleSymbol(tk.symbol);
      if (!sym || (tk.type && !/20/.test(tk.type))) continue;
      const amount = fromBaseUnits(tk.balance, Number(tk.decimals ?? 18) || 0);
      if (amount !== "0") balances.push({ asset: sym, amount });
    }
  return { mapped: txns, height: Math.max(cursor?.height ?? 0, maxBlock), balances };
};

import {
  Deltas,
  type EsInternal,
  type EsTokenTx,
  type EsTx,
  fromBaseUnits,
  mapEvmHistory,
  plausibleSymbol,
  SUPERSEDED_TOKENS,
} from "@muny/core";
import { schema } from "@muny/db";
import { eq } from "drizzle-orm";
import { decryptJson } from "../../lib/crypto.js";
import { assertPublicUrl } from "../../lib/net-guard.js";
import { BLOCKSCOUT_KEY } from "../prices.js";
import {
  type Adapter,
  type ChainCtx,
  type Cursor,
  type NftHeld,
  SyncError,
  safeText,
} from "./ctx.js";

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

/** Where to reach Blockscout for this chain, and the key header if one is saved. */
function endpoint(ctx: ChainCtx) {
  const override = ctx.override.replace(/\/+$/, "");
  const enc = ctx.db
    .select()
    .from(schema.appSettings)
    .where(eq(schema.appSettings.key, BLOCKSCOUT_KEY))
    .get()?.value as string | undefined;
  const key =
    !override && enc && ctx.deps.secretKey ? decryptJson<string>(ctx.deps.secretKey, enc) : null;
  const root = override || (key ? `${API}/${ctx.chain.chainId}` : ctx.chain.server);
  const headers: Record<string, string> = key ? { authorization: `Bearer ${key}` } : {};
  return { root, headers };
}

interface BalanceHistoryPage {
  items?: { transaction_hash?: string | null; block_timestamp?: string; delta?: string }[];
  next_page_params?: Record<string, string | number> | null;
}

export interface ChainBalanceChange {
  txHash: string | null;
  at: number;
  /** Change in the native coin's balance (decimal string). */
  delta: string;
}

/**
 * Every change to the address's native-coin balance, as the chain records it
 * (Blockscout's coin balance history), newest first. Used to pinpoint which
 * transaction Muny records differently.
 */
export async function balanceChanges(ctx: ChainCtx): Promise<ChainBalanceChange[]> {
  const { root, headers } = endpoint(ctx);
  const out: ChainBalanceChange[] = [];
  let next: Record<string, string | number> | null = null;
  for (let page = 0; page < 40; page++) {
    const params: [string, string][] = Object.entries(next ?? {}).map(([k, v]) => [k, String(v)]);
    const q: string = params.length ? `?${new URLSearchParams(params)}` : "";
    const r: BalanceHistoryPage = await ctx.get<BalanceHistoryPage>(
      `${root}/api/v2/addresses/${ctx.source}/coin-balance-history${q}`,
      headers,
    );
    for (const i of r.items ?? [])
      out.push({
        txHash: i.transaction_hash ?? null,
        at: Date.parse(i.block_timestamp ?? "") || 0,
        delta: fromBaseUnits(i.delta ?? "0", ctx.chain.decimals),
      });
    next = r.next_page_params ?? null;
    if (!next) return out;
  }
  throw new SyncError("Too much balance history to compare in one go");
}

interface NftPage {
  items?: {
    id?: string;
    token_type?: string;
    value?: string;
    image_url?: string | null;
    metadata?: { name?: string; image?: string } | null;
    token?: { address_hash?: string; address?: string; name?: string | null; type?: string };
  }[];
  next_page_params?: Record<string, string | number> | null;
}

/** NFTs (ERC-721 / ERC-1155) the address holds now; null when the service can't say. */
export async function heldNfts(ctx: ChainCtx): Promise<NftHeld[] | null> {
  // Blockscout's key-based API answers this with 402 (a paid feature); the
  // chain's public site has it for free.
  const root = (ctx.override || ctx.chain.server).replace(/\/+$/, "");
  const headers = {};
  const out: NftHeld[] = [];
  let next: Record<string, string | number> | null = null;
  try {
    for (let page = 0; page < 5; page++) {
      const q = new URLSearchParams({ type: "ERC-721,ERC-1155" });
      for (const [k, v] of Object.entries(next ?? {})) q.set(k, String(v));
      const r: NftPage = await ctx.get<NftPage>(
        `${root}/api/v2/addresses/${ctx.source}/nft?${q}`,
        headers,
      );
      for (const i of r.items ?? []) {
        const contract = (i.token?.address_hash ?? i.token?.address ?? "").toLowerCase();
        if (!contract || !i.id) continue;
        const image = i.image_url ?? i.metadata?.image ?? null;
        out.push({
          contract,
          tokenId: String(i.id),
          type: i.token_type ?? i.token?.type ?? "ERC-721",
          name: i.metadata?.name?.slice(0, 200) ?? null,
          collection: i.token?.name?.slice(0, 200) ?? null,
          image: image && /^(https?|ipfs):\/\//i.test(image) ? image.slice(0, 1000) : null,
          amount: i.value ?? "1",
        });
      }
      next = r.next_page_params ?? null;
      if (!next) break;
    }
  } catch {
    return null;
  }
  // Explorers keep an old copy of the metadata (e.g. a domain's generic logo
  // instead of its picture): ask the contract for the current link (ERC-721
  // tokenURI) and use that image. Best effort, a few NFTs per sync.
  for (const n of out.filter((x) => /721/.test(x.type)).slice(0, 20)) {
    const image = await currentImage(ctx, root, n).catch(() => null);
    if (image) n.image = image;
  }
  return out;
}

/** The image in the token's current metadata (tokenURI), or null. */
async function currentImage(ctx: ChainCtx, root: string, n: NftHeld): Promise<string | null> {
  let id: bigint;
  try {
    id = BigInt(n.tokenId);
  } catch {
    return null;
  }
  const data = `0xc87b56dd${id.toString(16).padStart(64, "0")}`;
  const rpc = await ctx.post<{ result?: string }>(`${root}/api/eth-rpc`, {
    jsonrpc: "2.0",
    id: 1,
    method: "eth_call",
    params: [{ to: n.contract, data }, "latest"],
  });
  const uri = decodeAbiString(rpc.result ?? "");
  if (!uri) return null;
  let meta: { image?: string } | null = null;
  if (/^data:application\/json;base64,/i.test(uri))
    meta = JSON.parse(Buffer.from(uri.split(",")[1] ?? "", "base64").toString("utf8"));
  else if (/^data:application\/json[,;]/i.test(uri))
    meta = JSON.parse(decodeURIComponent(uri.slice(uri.indexOf(",") + 1)));
  else {
    // Someone else's link: only public web hosts, small JSON, quickly.
    const url = new URL(uri.replace(/^ipfs:\/\/(ipfs\/)?/i, "https://ipfs.io/ipfs/"));
    await assertPublicUrl(url);
    const res = await (ctx.deps.fetch ?? fetch)(url, {
      redirect: "error",
      headers: { accept: "application/json", "user-agent": "Muny (self-hosted)" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (text.length > 1_000_000) return null;
    meta = JSON.parse(text);
  }
  const image = meta?.image;
  return typeof image === "string" && /^(https?|ipfs):\/\//i.test(image)
    ? image.slice(0, 1000)
    : null;
}

/** An ABI-encoded string (eth_call result) → text. */
function decodeAbiString(hex: string): string | null {
  const h = hex.replace(/^0x/, "");
  if (h.length < 128) return null;
  const len = Number.parseInt(h.slice(64, 128), 16);
  if (!Number.isFinite(len) || len <= 0 || len > 4096) return null;
  return Buffer.from(h.slice(128, 128 + len * 2), "hex").toString("utf8");
}

export const blockscout: Adapter = async (ctx) => {
  const { chain, source: address, cursor } = ctx;
  const { root, headers } = endpoint(ctx);
  const base = `${root}/api`;
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
  const held = await call<{
    balance?: string;
    decimals?: string;
    symbol?: string;
    type?: string;
    contractAddress?: string;
  }>({
    action: "tokenlist",
  });
  // Tokens sharing a symbol add up; a replaced contract's leftovers don't count.
  const held20 = new Deltas();
  if (Array.isArray(held))
    for (const tk of held) {
      const sym = plausibleSymbol(tk.symbol);
      if (!sym || (tk.type && !/20/.test(tk.type))) continue;
      if (SUPERSEDED_TOKENS.has((tk.contractAddress ?? "").toLowerCase())) continue;
      held20.add(sym, fromBaseUnits(tk.balance, Number(tk.decimals ?? 18) || 0));
    }
  for (const [asset, amount] of held20.toStrings())
    if (amount !== "0") balances.push({ asset, amount });
  const nfts = await heldNfts(ctx);
  return {
    mapped: txns,
    height: Math.max(cursor?.height ?? 0, maxBlock),
    balances,
    ...(nfts ? { nfts } : {}),
  };
};

import type { ChainInfo, SyncedTxn } from "@muny/core";
import type { MunyDb } from "@muny/db";
import { BudgetError, type BudgetProvider, spend } from "../budget.js";

/** Shared pieces for chain adapters (one file per provider in this folder). */

export class SyncError extends Error {}

export interface SyncDeps {
  secretKey: Buffer | undefined;
  fetch?: typeof fetch;
  /** Pause between requests (politeness / rate limits). */
  delayMs?: number;
}

/** Stored per wallet (not secret): sync position and the chain's balances. */
export interface Cursor {
  height: number;
  balances: { asset: string; amount: string }[];
  /** Provider-specific positions (paging tokens, per-address counts…). */
  pos?: Record<string, string | number>;
}

export interface Fetched {
  mapped: SyncedTxn[];
  height: number;
  balances: Cursor["balances"];
  pos?: Cursor["pos"];
  /** Something worth telling the user that isn't an error (e.g. a closed account). */
  notice?: string;
}

export interface ChainCtx {
  db: MunyDb;
  chain: ChainInfo;
  source: string;
  cursor: Cursor | null;
  /** Server override from settings ("" when none). */
  override: string;
  deps: SyncDeps;
  get<T>(url: string, headers?: Record<string, string>): Promise<T>;
  post<T>(url: string, body: unknown, headers?: Record<string, string>): Promise<T>;
}

export type Adapter = (ctx: ChainCtx) => Promise<Fetched>;

const sleep = (ms?: number) => (ms ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/**
 * HTTP for adapters: every request is counted against the provider's budget
 * first; errors never include the URL (it contains the address).
 */
export function makeCtx(base: Omit<ChainCtx, "get" | "post">, provider: BudgetProvider): ChainCtx {
  const f = base.deps.fetch ?? fetch;
  const request = async <T>(url: string, init: RequestInit, extra?: Record<string, string>) => {
    const host = new URL(url).host;
    let res: Response | null = null;
    // Rate limited: back off and retry twice (only when pacing is on).
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        spend(base.db, provider);
      } catch (err) {
        throw new SyncError(err instanceof BudgetError ? err.message : "Request limit reached");
      }
      try {
        res = await f(url, {
          ...init,
          headers: {
            accept: "application/json",
            "user-agent": "Muny (self-hosted)",
            ...(init.headers as Record<string, string>),
            ...extra,
          },
          signal: AbortSignal.timeout(60_000),
        });
      } catch {
        throw new SyncError(`Couldn't reach ${host}`);
      }
      await sleep(base.deps.delayMs);
      if (res.status !== 429 || !base.deps.delayMs || attempt === 2) break;
      await sleep(Math.max(5_000, base.deps.delayMs * 10) * (attempt + 1));
    }
    if (!res) throw new SyncError(`Couldn't reach ${host}`);
    if (res.status === 429) throw new SyncError(`${host} rate limit hit; try again later`);
    if (res.status === 401 || res.status === 403)
      throw new SyncError(
        `${host} refused the request (HTTP ${res.status}). Check the API key or server in Crypto → Settings.`,
      );
    if (res.status === 400 || res.status === 404)
      throw new SyncError(`${host} didn't accept this address (HTTP ${res.status})`);
    if (!res.ok) throw new SyncError(`${host} answered HTTP ${res.status}`);
    return (await res.json()) as T;
  };
  return {
    ...base,
    get: (url, headers) => request(url, { method: "GET" }, headers),
    post: (url, body, headers) =>
      request(
        url,
        {
          method: "POST",
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        },
        headers,
      ),
  };
}

/** Strip anything that looks like an address or hash from a provider message. */
export const safeText = (s: unknown) =>
  String(s ?? "")
    .replace(/0x[0-9a-fA-F]{6,}|[0-9A-Za-z]{25,}/g, "…")
    .slice(0, 120);

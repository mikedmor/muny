import type { MunyDb } from "@muny/db";
import { BudgetError, type BudgetProvider, spend } from "../budget.js";
import { type Cursor, type Fetched, type SyncDeps, SyncError } from "../chains/ctx.js";

/**
 * Shared pieces for exchange adapters (one file per exchange in this folder).
 *
 * Exchanges are synced with the user's own read-only API key, stored
 * encrypted (like a wallet's address) and only ever sent to that exchange,
 * in the headers its API requires. Muny only calls endpoints that read:
 * balances and history. Errors never include URLs, keys or response bodies.
 */

export interface ExchangeCreds {
  key: string;
  secret: string;
  passphrase?: string;
}

export interface ExchangeCtx {
  db: MunyDb;
  creds: ExchangeCreds;
  cursor: Cursor | null;
  deps: SyncDeps;
  /** Coins this wallet has held so far (Binance US answers coin by coin). */
  knownAssets: string[];
  /** One request, counted against the exchange's budget first. */
  request<T>(url: string, init?: RequestInit): Promise<{ status: number; body: T }>;
  /** Wait between calls to respect rate limits (skipped in tests: no delay set). */
  pause(ms: number): Promise<void>;
}

export type ExchangeAdapter = (ctx: ExchangeCtx) => Promise<Fetched>;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function makeExchangeCtx(
  base: Omit<ExchangeCtx, "request" | "pause">,
  provider: BudgetProvider,
  label: string,
): ExchangeCtx {
  const f = base.deps.fetch ?? fetch;
  const paced = !!base.deps.delayMs;
  return {
    ...base,
    pause: (ms) => (paced ? sleep(ms) : Promise.resolve()),
    async request<T>(url: string, init: RequestInit = {}) {
      for (let attempt = 0; ; attempt++) {
        try {
          spend(base.db, provider);
        } catch (err) {
          throw new SyncError(err instanceof BudgetError ? err.message : "Request limit reached");
        }
        let res: Response;
        try {
          res = await f(url, {
            ...init,
            headers: {
              accept: "application/json",
              "user-agent": "Muny (self-hosted)",
              ...(init.headers as Record<string, string> | undefined),
            },
            signal: AbortSignal.timeout(60_000),
          });
        } catch {
          throw new SyncError(`Couldn't reach ${label}`);
        }
        if (res.status === 429 && paced && attempt < 2) {
          await sleep(10_000 * (attempt + 1));
          continue;
        }
        if (res.status === 429) throw new SyncError(`${label} rate limit hit; try again later`);
        if (res.status >= 500) throw new SyncError(`${label} answered HTTP ${res.status}`);
        const text = await res.text();
        let body: unknown = null;
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          throw new SyncError(`${label} sent something Muny couldn't read (HTTP ${res.status})`);
        }
        return { status: res.status, body: body as T };
      }
    },
  };
}

/** The refusal message for a bad or under-permitted key (never echoes the key). */
export const keyRefused = (label: string, detail?: string) =>
  new SyncError(
    `${label} refused the API key${detail ? ` (${detail})` : ""}. Check that it was pasted whole and is allowed to read balances and history.`,
  );

/** Exact decimal multiply of two decimal strings (amount × price), no floats. */
export function mulDec(a: string, b: string): string {
  const parse = (s: string) => {
    const neg = s.startsWith("-");
    const [w = "0", f = ""] = (neg ? s.slice(1) : s).split(".");
    return { n: BigInt((w || "0") + f) * (neg ? -1n : 1n), scale: f.length };
  };
  const x = parse(a);
  const y = parse(b);
  const n = x.n * y.n;
  const scale = x.scale + y.scale;
  const neg = n < 0n;
  const digits = (neg ? -n : n).toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const frac = digits.slice(digits.length - scale).replace(/0+$/, "");
  const out = `${whole}${frac ? `.${frac}` : ""}`;
  return neg && out !== "0" ? `-${out}` : out;
}

import { FIAT, KNOWN_ASSETS } from "@muny/core";
import { type MunyDb, schema } from "@muny/db";
import type { CryptoPriceProvider, CryptoSettings } from "@muny/shared";
import { and, eq, gte, sql } from "drizzle-orm";
import { decryptJson, encryptJson } from "../lib/crypto.js";
import { BudgetError, budgeted } from "./budget.js";

/**
 * Crypto prices. Opt-in (off by default). When on, Muny sends only coin ids
 * (e.g. "bitcoin") to the chosen provider, never balances, addresses or
 * wallet names. Daily USD closes are stored locally.
 *
 * Providers (pluggable):
 * - defillama (default): free, no key, years of daily history (coins.llama.fi).
 * - coingecko: optional; the free API covers about a year and needs a demo key
 *   for reasonable limits.
 * Both use CoinGecko coin ids, so the asset mapping is shared.
 */

const SETTINGS_KEY = "crypto.settings";
const KEY_KEY = "crypto.coingecko_key";
const STATE_KEY = "crypto.price_state";
const LLAMA = "https://coins.llama.fi";
const GECKO = "https://api.coingecko.com/api/v3";
/** DefiLlama allows 500 data points per chart request (coins × days). */
const LLAMA_MAX_POINTS = 500;

export interface PriceDeps {
  secretKey: Buffer | undefined;
  fetch?: typeof fetch;
  /** Pause between history calls (politeness / rate limits). */
  delayMs?: number;
}

interface PriceState {
  updatedAt: number | null;
  /** Last attempt (success or not), so a failing provider isn't retried on every visit. */
  attemptedAt?: number | null;
  change24h: Record<string, number>;
  lastError: string | null;
}

const getSetting = <T>(db: MunyDb, key: string): T | undefined =>
  db.select().from(schema.appSettings).where(eq(schema.appSettings.key, key)).get()?.value as
    | T
    | undefined;
const putSetting = (db: MunyDb, key: string, value: unknown) =>
  db
    .insert(schema.appSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: schema.appSettings.key, set: { value } })
    .run();

export function getCryptoSettings(db: MunyDb): CryptoSettings {
  const s = getSetting<Partial<CryptoSettings>>(db, SETTINGS_KEY) ?? {};
  return {
    pricesEnabled: s.pricesEnabled ?? false,
    provider: s.provider ?? "defillama",
    hasApiKey: !!getSetting<string>(db, KEY_KEY),
    assetIds: s.assetIds ?? {},
    servers: s.servers ?? {},
  };
}

export function saveCryptoSettings(
  db: MunyDb,
  input: {
    pricesEnabled?: boolean;
    provider?: CryptoPriceProvider;
    assetIds?: Record<string, string>;
    servers?: Record<string, string>;
    apiKey?: string | null;
  },
  secretKey: Buffer | undefined,
) {
  const cur = getCryptoSettings(db);
  putSetting(db, SETTINGS_KEY, {
    pricesEnabled: input.pricesEnabled ?? cur.pricesEnabled,
    provider: input.provider ?? cur.provider,
    assetIds: input.assetIds ?? cur.assetIds,
    servers: input.servers ?? cur.servers,
  });
  if (input.apiKey !== undefined) {
    if (!input.apiKey)
      db.delete(schema.appSettings).where(eq(schema.appSettings.key, KEY_KEY)).run();
    else {
      if (!secretKey) throw new Error("Set MUNY_SECRET_KEY first: the key is stored encrypted.");
      putSetting(db, KEY_KEY, encryptJson(secretKey, input.apiKey));
    }
  }
}

export function priceState(db: MunyDb): PriceState {
  return {
    updatedAt: null,
    change24h: {},
    lastError: null,
    ...getSetting<PriceState>(db, STATE_KEY),
  };
}

/** Each held asset (except fiat) with the date of its first transaction. */
function heldAssets(db: MunyDb): { asset: string; first: number }[] {
  return db
    .all<{ a: string; first: number }>(sql`
      select a, min(at) as first from (
        select sent_asset as a, at from crypto_txns
        union all select received_asset, at from crypto_txns
        union all select fee_asset, at from crypto_txns)
       where a is not null group by a
    `)
    .filter((r) => !FIAT.has(r.a))
    .map((r) => ({ asset: r.a, first: Number(r.first) }));
}

export function coinIdFor(asset: string, overrides: Record<string, string>): string | null {
  return overrides[asset] ?? KNOWN_ASSETS[asset]?.id ?? null;
}

class PriceError extends Error {}

async function getJson(
  url: string,
  deps: PriceDeps,
  headers: Record<string, string> = {},
): Promise<unknown> {
  const f = deps.fetch ?? fetch;
  const host = new URL(url).host;
  let res: Response;
  try {
    res = await f(url, {
      headers: { accept: "application/json", ...headers },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    if (err instanceof BudgetError) throw new PriceError(err.message);
    throw new PriceError(`Couldn't reach ${host}`);
  }
  if (res.status === 429) throw new PriceError(`${host} rate limit hit; try again later`);
  if (!res.ok) throw new PriceError(`${host} answered HTTP ${res.status}`);
  return res.json();
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** JSON number → decimal string (no exponent notation). */
const num = (n: number) => (Number.isFinite(n) ? n.toFixed(12).replace(/\.?0+$/, "") : "0");
const sleep = (ms?: number) => (ms ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

interface Provider {
  /** Current USD price and 24h change (%) per coin id. */
  current(ids: string[]): Promise<Map<string, { usd: number; change24h: number | null }>>;
  /** Daily closes per coin id from `fromMs` to now. */
  history(id: string, fromMs: number): Promise<{ ms: number; usd: number }[]>;
  /** Optional: one day's price for many coins in one call (cheap small gaps). */
  onDay?(ids: string[], dayMs: number): Promise<Map<string, number>>;
}

function defillama(deps: PriceDeps): Provider {
  return {
    async current(ids) {
      const out = new Map<string, { usd: number; change24h: number | null }>();
      for (let i = 0; i < ids.length; i += 50) {
        const keys = ids
          .slice(i, i + 50)
          .map((id) => `coingecko:${id}`)
          .join(",");
        const [prices, pct] = (await Promise.all([
          getJson(`${LLAMA}/prices/current/${encodeURIComponent(keys)}`, deps),
          getJson(`${LLAMA}/percentage/${encodeURIComponent(keys)}?period=24h`, deps).catch(() => ({
            coins: {},
          })),
        ])) as [{ coins: Record<string, { price?: number }> }, { coins: Record<string, number> }];
        for (const [k, v] of Object.entries(prices.coins ?? {})) {
          if (typeof v.price !== "number") continue;
          const change = pct.coins?.[k];
          out.set(k.replace(/^coingecko:/, ""), {
            usd: v.price,
            change24h: typeof change === "number" ? change : null,
          });
        }
      }
      return out;
    },
    async history(id, fromMs) {
      const out: { ms: number; usd: number }[] = [];
      let start = Math.floor(fromMs / 1000);
      const now = Math.floor(Date.now() / 1000);
      while (start < now) {
        const span = Math.min(LLAMA_MAX_POINTS, Math.ceil((now - start) / 86_400) + 1);
        const data = (await getJson(
          `${LLAMA}/chart/${encodeURIComponent(`coingecko:${id}`)}?start=${start}&span=${span}&period=1d`,
          deps,
        )) as { coins?: Record<string, { prices?: { timestamp: number; price: number }[] }> };
        const pts = data.coins?.[`coingecko:${id}`]?.prices ?? [];
        for (const p of pts) out.push({ ms: p.timestamp * 1000, usd: p.price });
        const last = pts[pts.length - 1]?.timestamp;
        if (!last || pts.length < span) break;
        start = last + 86_400;
        await sleep(deps.delayMs);
      }
      return out;
    },
    async onDay(ids, dayMs) {
      const out = new Map<string, number>();
      for (let i = 0; i < ids.length; i += 50) {
        const keys = ids
          .slice(i, i + 50)
          .map((id) => `coingecko:${id}`)
          .join(",");
        const data = (await getJson(
          `${LLAMA}/prices/historical/${Math.floor(dayMs / 1000)}/${encodeURIComponent(keys)}`,
          deps,
        )) as { coins?: Record<string, { price?: number }> };
        for (const [k, v] of Object.entries(data.coins ?? {}))
          if (typeof v.price === "number") out.set(k.replace(/^coingecko:/, ""), v.price);
      }
      return out;
    },
  };
}

function coingecko(deps: PriceDeps, key: string | null): Provider {
  const headers: Record<string, string> = key ? { "x-cg-demo-api-key": key } : {};
  return {
    async current(ids) {
      const out = new Map<string, { usd: number; change24h: number | null }>();
      for (let i = 0; i < ids.length; i += 100) {
        const data = (await getJson(
          `${GECKO}/simple/price?ids=${encodeURIComponent(ids.slice(i, i + 100).join(","))}&vs_currencies=usd&include_24hr_change=true`,
          deps,
          headers,
        )) as Record<string, { usd?: number; usd_24h_change?: number }>;
        for (const [id, v] of Object.entries(data))
          if (typeof v.usd === "number")
            out.set(id, {
              usd: v.usd,
              change24h: typeof v.usd_24h_change === "number" ? v.usd_24h_change : null,
            });
      }
      return out;
    },
    async history(id) {
      // The free API serves about a year of daily data.
      const data = (await getJson(
        `${GECKO}/coins/${encodeURIComponent(id)}/market_chart?vs_currency=usd&days=365&interval=daily`,
        deps,
        headers,
      )) as { prices?: [number, number][] };
      return (data.prices ?? []).map(([ms, usd]) => ({ ms, usd }));
    },
  };
}

let running = false;
export const pricesRefreshing = () => running;
/** Gaps up to this many days are filled with one call per day for all coins. */
const SMALL_GAP_DAYS = 3;

/**
 * Fetch today's prices (and 24h change) for every held asset, then fill daily
 * history back to each asset's first transaction (only the missing days).
 */
export async function refreshPrices(
  db: MunyDb,
  deps: PriceDeps,
): Promise<{ assets: number; days: number }> {
  const settings = getCryptoSettings(db);
  if (!settings.pricesEnabled || running) return { assets: 0, days: 0 };
  running = true;
  const state = priceState(db);
  putSetting(db, STATE_KEY, { ...state, attemptedAt: Date.now() });
  try {
    // Every call counts against the provider's request budget.
    deps = { ...deps, fetch: budgeted(db, settings.provider, deps.fetch) };
    let provider: Provider;
    if (settings.provider === "coingecko") {
      let key: string | null = null;
      const enc = getSetting<string>(db, KEY_KEY);
      if (enc && deps.secretKey) key = decryptJson<string>(deps.secretKey, enc);
      provider = coingecko(deps, key);
    } else provider = defillama(deps);

    const assets = new Map<string, { asset: string; first: number }>(); // coin id → asset
    for (const h of heldAssets(db)) {
      const id = coinIdFor(h.asset, settings.assetIds);
      if (id && !assets.has(id)) assets.set(id, h);
    }
    if (assets.size === 0) return { assets: 0, days: 0 };
    const source = settings.provider;
    const put = (asset: string, date: string, usd: string) =>
      db
        .insert(schema.cryptoPrices)
        .values({ asset, date, usd, source })
        .onConflictDoUpdate({
          target: [schema.cryptoPrices.asset, schema.cryptoPrices.date],
          set: { usd, source },
        })
        .run();

    const today = day(Date.now());
    const change24h: Record<string, number> = {};
    for (const [id, v] of await provider.current([...assets.keys()])) {
      const a = assets.get(id);
      if (!a) continue;
      put(a.asset, today, num(v.usd));
      if (v.change24h !== null) change24h[a.asset] = v.change24h;
    }

    // History: from the day after the newest stored price (excluding today),
    // or from the asset's first transaction.
    let days = 0;
    const small = new Map<string, string[]>(); // day → coin ids
    const todayMs = Date.parse(`${today}T00:00:00Z`);
    for (const [id, a] of assets) {
      const newest = db
        .select({ d: sql<string | null>`max(${schema.cryptoPrices.date})` })
        .from(schema.cryptoPrices)
        .where(
          and(eq(schema.cryptoPrices.asset, a.asset), sql`${schema.cryptoPrices.date} < ${today}`),
        )
        .get()?.d;
      const oldest = db
        .select({ d: sql<string | null>`min(${schema.cryptoPrices.date})` })
        .from(schema.cryptoPrices)
        .where(eq(schema.cryptoPrices.asset, a.asset))
        .get()?.d;
      const firstDay = day(a.first);
      // Re-fetch from the first transaction if older days are missing; else just the gap.
      const from =
        !oldest || oldest > firstDay
          ? Date.parse(`${firstDay}T00:00:00Z`)
          : Date.parse(`${newest ?? today}T00:00:00Z`) + 86_400_000;
      if (from >= todayMs) continue;
      if (provider.onDay && todayMs - from <= SMALL_GAP_DAYS * 86_400_000) {
        for (let d = from; d < todayMs; d += 86_400_000)
          small.set(day(d), [...(small.get(day(d)) ?? []), id]);
        continue;
      }
      await sleep(deps.delayMs);
      for (const p of await provider.history(id, from)) {
        const d = day(p.ms);
        if (d >= today) continue;
        put(a.asset, d, num(p.usd));
        days++;
      }
    }
    for (const [d, ids] of small) {
      await sleep(deps.delayMs);
      const got = await provider.onDay?.(ids, Date.parse(`${d}T00:00:00Z`));
      for (const [id, usd] of got ?? []) {
        const a = assets.get(id);
        if (a) {
          put(a.asset, d, num(usd));
          days++;
        }
      }
    }
    const now = Date.now();
    putSetting(db, STATE_KEY, { updatedAt: now, attemptedAt: now, change24h, lastError: null });
    return { assets: assets.size, days };
  } catch (err) {
    putSetting(db, STATE_KEY, {
      ...state,
      attemptedAt: Date.now(),
      lastError: err instanceof PriceError ? err.message : "Price update failed",
    });
    throw err;
  } finally {
    running = false;
  }
}

/** Remove stored prices (e.g. after switching provider), so history refetches. */
export function clearPrices(db: MunyDb, since?: string) {
  db.delete(schema.cryptoPrices)
    .where(since ? gte(schema.cryptoPrices.date, since) : undefined)
    .run();
}

/** Prices are due once per local day (checked when someone opens crypto pages). */
export function pricesDue(db: MunyDb, now = new Date()): boolean {
  if (!getCryptoSettings(db).pricesEnabled || running) return false;
  const st = priceState(db);
  const last = st.attemptedAt ?? st.updatedAt;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return !last || last < start;
}

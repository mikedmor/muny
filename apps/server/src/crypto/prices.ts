import { FIAT, KNOWN_ASSETS } from "@muny/core";
import { type MunyDb, schema } from "@muny/db";
import type { CryptoSettings } from "@muny/shared";
import { eq, sql } from "drizzle-orm";
import { decryptJson, encryptJson } from "../lib/crypto.js";

/**
 * Crypto prices from CoinGecko. Opt-in (off by default): when enabled, Muny
 * sends only coin ids (e.g. "bitcoin") to CoinGecko, never balances or
 * addresses. Daily USD closes are stored locally; the free API covers about a
 * year of history, older values come from imported transactions.
 */

const SETTINGS_KEY = "crypto.settings";
const KEY_KEY = "crypto.coingecko_key";
const STATE_KEY = "crypto.price_state";
const BASE = "https://api.coingecko.com/api/v3";

export interface PriceDeps {
  secretKey: Buffer | undefined;
  fetch?: typeof fetch;
  /** Pause between history calls (rate limit). */
  delayMs?: number;
}

interface PriceState {
  updatedAt: number | null;
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
    hasApiKey: !!getSetting<string>(db, KEY_KEY),
    assetIds: s.assetIds ?? {},
  };
}

export function saveCryptoSettings(
  db: MunyDb,
  input: { pricesEnabled?: boolean; assetIds?: Record<string, string>; apiKey?: string | null },
  secretKey: Buffer | undefined,
) {
  const cur = getCryptoSettings(db);
  putSetting(db, SETTINGS_KEY, {
    pricesEnabled: input.pricesEnabled ?? cur.pricesEnabled,
    assetIds: input.assetIds ?? cur.assetIds,
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

/** Assets that appear in any crypto transaction (except fiat). */
function heldAssets(db: MunyDb): string[] {
  const rows = db.all<{ a: string }>(sql`
    select distinct a from (
      select sent_asset as a from crypto_txns union select received_asset from crypto_txns
      union select fee_asset from crypto_txns)
     where a is not null
  `);
  return rows.map((r) => r.a).filter((a) => !FIAT.has(a));
}

export function coinIdFor(asset: string, overrides: Record<string, string>): string | null {
  return overrides[asset] ?? KNOWN_ASSETS[asset]?.id ?? null;
}

class PriceError extends Error {}

async function getJson(url: string, deps: PriceDeps, key: string | null): Promise<unknown> {
  const f = deps.fetch ?? fetch;
  let res: Response;
  try {
    res = await f(url, {
      headers: { accept: "application/json", ...(key ? { "x-cg-demo-api-key": key } : {}) },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new PriceError("Couldn't reach CoinGecko");
  }
  if (res.status === 429) throw new PriceError("CoinGecko rate limit hit; try again later");
  if (!res.ok) throw new PriceError(`CoinGecko answered HTTP ${res.status}`);
  return res.json();
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** JSON numbers → decimal string without float formatting surprises (e.g. 1e-7). */
const num = (n: number) => (Number.isFinite(n) ? n.toFixed(12).replace(/\.?0+$/, "") : "0");

let running = false;

/**
 * Fetch today's prices (and 24h change) for every held asset, then fill in a
 * year of daily history for assets that don't have it yet.
 */
export async function refreshPrices(
  db: MunyDb,
  deps: PriceDeps,
): Promise<{ assets: number; days: number }> {
  const settings = getCryptoSettings(db);
  if (!settings.pricesEnabled || running) return { assets: 0, days: 0 };
  running = true;
  const state = priceState(db);
  try {
    let key: string | null = null;
    const enc = getSetting<string>(db, KEY_KEY);
    if (enc && deps.secretKey) key = decryptJson<string>(deps.secretKey, enc);
    const ids = new Map<string, string>(); // coin id → asset
    for (const a of heldAssets(db)) {
      const id = coinIdFor(a, settings.assetIds);
      if (id && !ids.has(id)) ids.set(id, a);
    }
    if (ids.size === 0) return { assets: 0, days: 0 };
    const today = day(Date.now());
    const put = (asset: string, date: string, usd: string) =>
      db
        .insert(schema.cryptoPrices)
        .values({ asset, date, usd, source: "coingecko" })
        .onConflictDoUpdate({
          target: [schema.cryptoPrices.asset, schema.cryptoPrices.date],
          set: { usd, source: "coingecko" },
        })
        .run();

    // Current prices, in batches.
    const idList = [...ids.keys()];
    const change24h: Record<string, number> = {};
    for (let i = 0; i < idList.length; i += 100) {
      const batch = idList.slice(i, i + 100);
      const data = (await getJson(
        `${BASE}/simple/price?ids=${encodeURIComponent(batch.join(","))}&vs_currencies=usd&include_24hr_change=true`,
        deps,
        key,
      )) as Record<string, { usd?: number; usd_24h_change?: number }>;
      for (const [id, v] of Object.entries(data)) {
        const asset = ids.get(id);
        if (!asset || typeof v.usd !== "number") continue;
        put(asset, today, num(v.usd));
        if (typeof v.usd_24h_change === "number") change24h[asset] = v.usd_24h_change;
      }
    }

    // History: one call per asset that has less than ~a year stored.
    let days = 0;
    for (const [id, asset] of ids) {
      const have =
        db
          .select({ n: sql<number>`count(*)` })
          .from(schema.cryptoPrices)
          .where(eq(schema.cryptoPrices.asset, asset))
          .get()?.n ?? 0;
      if (Number(have) >= 300) continue;
      if (deps.delayMs) await new Promise((r) => setTimeout(r, deps.delayMs));
      const data = (await getJson(
        `${BASE}/coins/${encodeURIComponent(id)}/market_chart?vs_currency=usd&days=365&interval=daily`,
        deps,
        key,
      )) as { prices?: [number, number][] };
      for (const [ms, usd] of data.prices ?? []) {
        put(asset, day(ms), num(usd));
        days++;
      }
    }
    putSetting(db, STATE_KEY, { updatedAt: Date.now(), change24h, lastError: null });
    return { assets: ids.size, days };
  } catch (err) {
    putSetting(db, STATE_KEY, {
      ...state,
      lastError: err instanceof PriceError ? err.message : "Price update failed",
    });
    throw err;
  } finally {
    running = false;
  }
}

export function startPriceScheduler(
  db: MunyDb,
  deps: PriceDeps,
  log: { warn: (o: object, msg: string) => void },
) {
  const tick = () => {
    const st = priceState(db);
    if (st.updatedAt && Date.now() - st.updatedAt < 6 * 3_600_000) return;
    void refreshPrices(db, { ...deps, delayMs: deps.delayMs ?? 2500 }).catch((err) =>
      log.warn(
        { err: err instanceof Error ? err.message : "unknown" },
        "Crypto price update failed",
      ),
    );
  };
  const first = setTimeout(tick, 60_000);
  const timer = setInterval(tick, 30 * 60_000);
  first.unref();
  timer.unref();
}

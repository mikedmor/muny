import { type MunyDb, schema } from "@muny/db";
import type { CryptoUsage } from "@muny/shared";
import { eq } from "drizzle-orm";

/**
 * Request budgets for the free public services crypto uses. Every outbound
 * call is counted before it is made; once a daily or monthly cap is reached
 * the call is refused (not sent), so Muny can never run past a provider's
 * free limits, however often someone presses "Refresh". Caps sit well under
 * the published limits.
 */

export type BudgetProvider =
  | "defillama"
  | "coingecko"
  | "blockscout"
  | "esplora"
  | "blockcypher"
  | "cosmos"
  | "trongrid"
  | "koios"
  | "algonode"
  | "horizon"
  | "siascan"
  | "blockbook"
  | "coinbase"
  | "kraken"
  | "gemini"
  | "binanceus"
  | "yahoo";

export const LIMITS: Record<BudgetProvider, { day: number; month: number; label: string }> = {
  // Stock price history (one request per ticker per backfill); no published quota.
  yahoo: { day: 200, month: 1000, label: "Yahoo Finance stock prices" },
  // No published key-less quota; stay polite.
  defillama: { day: 300, month: 6000, label: "DefiLlama prices" },
  // Free Demo plan: 10,000 calls a month, 30 a minute.
  coingecko: { day: 200, month: 5000, label: "CoinGecko prices" },
  // Free plan: 100K credits a day at 20-40 credits per call (~2,500+ calls).
  blockscout: { day: 1500, month: 30000, label: "Blockscout wallet sync (EVM chains)" },
  // mempool.space / litecoinspace.org public APIs (per-IP rate limits).
  esplora: { day: 1500, month: 30000, label: "mempool.space wallet sync (Bitcoin, Litecoin)" },
  // BlockCypher without a key: about 100 requests an hour.
  blockcypher: { day: 400, month: 8000, label: "BlockCypher wallet sync (Dogecoin)" },
  cosmos: { day: 500, month: 10000, label: "Cosmos Hub wallet sync (ATOM)" },
  trongrid: { day: 500, month: 10000, label: "TronGrid wallet sync (TRON)" },
  // Koios public tier: 100 requests per 10 s per IP, small bodies.
  koios: { day: 1000, month: 20000, label: "Koios wallet sync (Cardano)" },
  // AlgoNode free public indexer.
  algonode: { day: 1000, month: 20000, label: "AlgoNode wallet sync (Algorand)" },
  // stellar.org Horizon: 3,600 requests an hour per IP.
  horizon: { day: 1000, month: 20000, label: "Horizon wallet sync (Stellar)" },
  // SiaScan's public explorer API (no published quota; stay polite).
  // About two requests per address per daily sync (a Sia wallet can have 100+).
  siascan: { day: 1500, month: 30000, label: "SiaScan wallet sync (Siacoin)" },
  // A Blockbook server you set (e.g. a free GetBlock endpoint: 50K a day).
  blockbook: { day: 1000, month: 20000, label: "Blockbook wallet sync (Zcash)" },
  // Exchanges, with your own read-only API keys (limits are per key).
  // Coinbase: 10,000 requests an hour.
  coinbase: { day: 4000, month: 40000, label: "Coinbase sync" },
  // Kraken: ledger calls cost 2 of a slowly refilling 15-20 point counter.
  kraken: { day: 1500, month: 20000, label: "Kraken sync" },
  // Gemini: 600 private requests a minute.
  gemini: { day: 1500, month: 20000, label: "Gemini sync" },
  // Binance US: 1,200 request weight a minute; history is asked coin by coin.
  binanceus: { day: 4000, month: 40000, label: "Binance US sync" },
};

const KEY = "crypto.usage";

interface Counter {
  day: string;
  dayCount: number;
  month: string;
  monthCount: number;
}

export class BudgetError extends Error {}

const localDay = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function load(db: MunyDb): Partial<Record<BudgetProvider, Counter>> {
  return (db.select().from(schema.appSettings).where(eq(schema.appSettings.key, KEY)).get()
    ?.value ?? {}) as Partial<Record<BudgetProvider, Counter>>;
}

function current(c: Counter | undefined, now: Date): Counter {
  const day = localDay(now);
  const month = day.slice(0, 7);
  return {
    day,
    dayCount: c?.day === day ? c.dayCount : 0,
    month,
    monthCount: c?.month === month ? c.monthCount : 0,
  };
}

/** Count one call, or throw BudgetError without counting if a cap is reached. */
export function spend(db: MunyDb, provider: BudgetProvider, now = new Date()) {
  const all = load(db);
  const c = current(all[provider], now);
  const lim = LIMITS[provider];
  if (c.dayCount >= lim.day)
    throw new BudgetError(
      `Daily limit for ${lim.label} reached (${lim.day} requests); it resets tomorrow`,
    );
  if (c.monthCount >= lim.month)
    throw new BudgetError(
      `Monthly limit for ${lim.label} reached (${lim.month} requests); it resets next month`,
    );
  all[provider] = { ...c, dayCount: c.dayCount + 1, monthCount: c.monthCount + 1 };
  db.insert(schema.appSettings)
    .values({ key: KEY, value: all })
    .onConflictDoUpdate({ target: schema.appSettings.key, set: { value: all } })
    .run();
}

/** A fetch that spends from `provider`'s budget before each request. */
export function budgeted(
  db: MunyDb,
  provider: BudgetProvider,
  f: typeof fetch = fetch,
): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    spend(db, provider);
    return f(input, init);
  }) as typeof fetch;
}

export function usage(db: MunyDb, now = new Date()): CryptoUsage[] {
  const all = load(db);
  return (Object.keys(LIMITS) as BudgetProvider[]).map((p) => {
    const c = current(all[p], now);
    return {
      provider: p,
      label: LIMITS[p].label,
      today: c.dayCount,
      dayLimit: LIMITS[p].day,
      month: c.monthCount,
      monthLimit: LIMITS[p].month,
    };
  });
}

export { localDay };

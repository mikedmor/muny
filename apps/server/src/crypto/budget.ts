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

export type BudgetProvider = "defillama" | "coingecko" | "blockscout" | "blockbook";

export const LIMITS: Record<BudgetProvider, { day: number; month: number; label: string }> = {
  // No published key-less quota; stay polite.
  defillama: { day: 300, month: 6000, label: "DefiLlama prices" },
  // Free Demo plan: 10,000 calls a month, 30 a minute.
  coingecko: { day: 200, month: 5000, label: "CoinGecko prices" },
  // Free plan: 100K credits a day at 20-40 credits per call (~2,500+ calls).
  blockscout: { day: 1500, month: 30000, label: "Blockscout wallet sync (EVM chains)" },
  // A Blockbook server you run or rent.
  blockbook: { day: 500, month: 10000, label: "Blockbook wallet sync (Bitcoin-like chains)" },
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

import type { Candle, CandleRange, CandleSet, LiveKey } from "@muny/shared";
import { spend } from "../crypto/budget.js";
import { chart } from "../invest/market.js";

/**
 * Bars for the trading chart. Stocks: Yahoo Finance's chart endpoint (only
 * the ticker is sent). Coins: Coinbase's public candles (only the pair, like
 * BTC-USD, is sent). Kept in memory for a while, by range.
 */

const MINUTE = 60_000;
const DAY = 1440 * MINUTE;

/** Yahoo's range and bar size for each of ours. */
const YAHOO: Record<CandleRange, { range: string; interval: string; minutes: number }> = {
  "1d": { range: "1d", interval: "5m", minutes: 5 },
  "1w": { range: "5d", interval: "30m", minutes: 30 },
  "1m": { range: "1mo", interval: "1d", minutes: 1440 },
  "3m": { range: "3mo", interval: "1d", minutes: 1440 },
  "6m": { range: "6mo", interval: "1d", minutes: 1440 },
  ytd: { range: "ytd", interval: "1d", minutes: 1440 },
  "1y": { range: "1y", interval: "1d", minutes: 1440 },
  "5y": { range: "5y", interval: "1wk", minutes: 7 * 1440 },
};

/** Coinbase's bar size (seconds) and how far back, for each range. */
const COINBASE: Record<CandleRange, { granularity: number; days: number | "ytd" }> = {
  "1d": { granularity: 300, days: 1 },
  "1w": { granularity: 3600, days: 7 },
  "1m": { granularity: 21_600, days: 30 },
  "3m": { granularity: 86_400, days: 91 },
  "6m": { granularity: 86_400, days: 182 },
  ytd: { granularity: 86_400, days: "ytd" },
  "1y": { granularity: 86_400, days: 365 },
  "5y": { granularity: 86_400, days: 1826 },
};

/** How long a range's bars are kept. */
const KEEP: Record<CandleRange, number> = {
  "1d": 2 * MINUTE,
  "1w": 10 * MINUTE,
  "1m": 60 * MINUTE,
  "3m": 60 * MINUTE,
  "6m": 60 * MINUTE,
  ytd: 60 * MINUTE,
  "1y": 60 * MINUTE,
  "5y": 6 * 60 * MINUTE,
};

const cache = new Map<string, { at: number; data: CandleSet }>();

export async function yahooCandles(
  f: typeof fetch,
  db: Parameters<typeof spend>[0],
  symbol: string,
  range: CandleRange,
): Promise<CandleSet> {
  const y = YAHOO[range];
  spend(db, "yahoo");
  const { meta, points } = await chart(
    f,
    symbol.startsWith("^") ? symbol : symbol.replace(/\./g, "-"),
    `range=${y.range}&interval=${y.interval}${range === "1d" ? "&includePrePost=true" : ""}`,
  );
  return {
    key: `stock:${symbol}` as LiveKey,
    range,
    barMinutes: y.minutes,
    candles: points.map((p) => ({
      t: p.t,
      o: p.open,
      h: p.high,
      l: p.low,
      c: p.close,
      v: p.volume,
    })),
    previousClose: range === "1d" ? (meta.chartPreviousClose ?? meta.previousClose ?? null) : null,
    source: "yahoo",
  };
}

/** Weekly bars from daily ones (the five-year view). */
function weekly(days: Candle[]): Candle[] {
  const out: Candle[] = [];
  for (const d of days) {
    const weekStart = d.t - ((new Date(d.t).getUTCDay() + 6) % 7) * DAY;
    const last = out.at(-1);
    if (last && last.t === weekStart) {
      last.h = Math.max(last.h, d.h);
      last.l = Math.min(last.l, d.l);
      last.c = d.c;
      last.v += d.v;
    } else out.push({ ...d, t: weekStart });
  }
  return out;
}

export async function coinbaseCandles(
  f: typeof fetch,
  asset: string,
  range: CandleRange,
  now = Date.now(),
): Promise<CandleSet> {
  const c = COINBASE[range];
  const from =
    c.days === "ytd" ? Date.UTC(new Date(now).getUTCFullYear(), 0, 1) : now - c.days * DAY;
  const step = c.granularity * 1000 * 300; // at most 300 bars a request
  const rows = new Map<number, Candle>();
  for (let start = from; start < now; start += step) {
    const end = Math.min(now, start + step);
    const q = new URLSearchParams({
      granularity: String(c.granularity),
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
    });
    const res = await f(
      `https://api.exchange.coinbase.com/products/${encodeURIComponent(asset)}-USD/candles?${q}`,
      {
        headers: { accept: "application/json", "user-agent": "Muny (self-hosted)" },
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!res.ok) throw new Error(`Coinbase answered ${res.status}`);
    const list = (await res.json()) as unknown;
    if (!Array.isArray(list)) throw new Error("Unexpected answer");
    // [time, low, high, open, close, volume], newest first.
    for (const r of list) {
      if (!Array.isArray(r) || r.length < 6) continue;
      const [t, l, h, o, cl, v] = r.map(Number) as number[];
      if (![t, l, h, o, cl].every((x) => Number.isFinite(x) && (x as number) > 0)) continue;
      rows.set((t as number) * 1000, {
        t: (t as number) * 1000,
        o: o as number,
        h: h as number,
        l: l as number,
        c: cl as number,
        v: Number.isFinite(v) ? (v as number) : 0,
      });
    }
  }
  const candles = [...rows.values()].sort((a, b) => a.t - b.t);
  return {
    key: `crypto:${asset}` as LiveKey,
    range,
    barMinutes: range === "5y" ? 7 * 1440 : c.granularity / 60,
    candles: range === "5y" ? weekly(candles) : candles,
    previousClose: null,
    source: "coinbase",
  };
}

/** Bars for a stock or coin and range, from memory when they're fresh enough. */
export async function candlesFor(
  load: () => Promise<CandleSet>,
  key: LiveKey,
  range: CandleRange,
  now = Date.now(),
): Promise<CandleSet> {
  const id = `${key}|${range}`;
  const hit = cache.get(id);
  if (hit && now - hit.at < KEEP[range]) return hit.data;
  const data = await load();
  cache.set(id, { at: now, data });
  return data;
}

/** For tests. */
export function resetCandles() {
  cache.clear();
}

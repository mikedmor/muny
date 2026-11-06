import type { MunyDb } from "@muny/db";
import type { MarketIntraday, MarketOverview, MarketQuote } from "@muny/shared";
import { spend } from "../crypto/budget.js";

/**
 * Market overview (D-039), opt-in: major index funds, the VIX and the
 * Vanguard sector funds, from Yahoo Finance's chart endpoint (only the
 * tickers are sent). Kept in memory for an hour; intraday prices for one
 * index on demand, for ten minutes.
 */

export interface MarketDeps {
  fetch?: typeof fetch;
}

export const MARKET_INDEXES: [string, string][] = [
  ["SPY", "S&P 500"],
  ["QQQ", "Nasdaq 100"],
  ["DIA", "Dow Jones"],
  ["IWM", "Russell 2000"],
  ["^VIX", "VIX"],
];

export const MARKET_SECTORS: [string, string][] = [
  ["VOX", "Communication Services"],
  ["VCR", "Consumer Discretionary"],
  ["VDC", "Consumer Staples"],
  ["VDE", "Energy"],
  ["VFH", "Financials"],
  ["VHT", "Health Care"],
  ["VIS", "Industrials"],
  ["VGT", "Information Technology"],
  ["VAW", "Materials"],
  ["VNQ", "Real Estate"],
  ["VPU", "Utilities"],
];

const YAHOO = "https://query1.finance.yahoo.com/v8/finance/chart";
const HOUR = 3_600_000;

interface Chart {
  chart?: {
    result?: {
      meta?: {
        gmtoffset?: number;
        regularMarketPrice?: number;
        chartPreviousClose?: number;
        previousClose?: number;
        regularMarketTime?: number;
      };
      timestamp?: number[];
      indicators?: { quote?: { close?: (number | null)[] }[] };
    }[];
  };
}

async function chart(f: typeof fetch, symbol: string, query: string) {
  const res = await f(`${YAHOO}/${encodeURIComponent(symbol)}?${query}`, {
    headers: { accept: "application/json", "user-agent": "Muny (self-hosted)" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Yahoo Finance answered ${res.status}`);
  const r = ((await res.json()) as Chart).chart?.result?.[0];
  if (!r) throw new Error("No data");
  const offset = r.meta?.gmtoffset ?? 0;
  const points: { t: number; date: string; close: number }[] = [];
  const closes = r.indicators?.quote?.[0]?.close ?? [];
  (r.timestamp ?? []).forEach((t, i) => {
    const c = closes[i];
    if (c !== null && c !== undefined && Number.isFinite(c) && c > 0)
      points.push({
        t: t * 1000,
        date: new Date((t + offset) * 1000).toISOString().slice(0, 10),
        close: c,
      });
  });
  return { meta: r.meta ?? {}, points };
}

/** Percent change from the last close on or before `date` to `last`. */
function changeSince(points: { date: string; close: number }[], date: string, last: number) {
  let base: number | undefined;
  for (const p of points) if (p.date <= date) base = p.close;
  base ??= points[0]?.close;
  return base ? ((last - base) / base) * 100 : null;
}

function daysAgo(today: string, days: number) {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

async function quote(f: typeof fetch, symbol: string, name: string, withSeries: boolean) {
  const { meta, points } = await chart(f, symbol, "range=5y&interval=1d");
  const last = meta.regularMarketPrice ?? points.at(-1)?.close ?? 0;
  const lastDate = points.at(-1)?.date ?? new Date().toISOString().slice(0, 10);
  const prev = points.length >= 2 ? (points.at(-2)?.close ?? null) : null;
  // Today's close may be the last point; the previous trading day's close is the 1-day base.
  const lastPointIsToday =
    meta.regularMarketTime !== undefined &&
    points.at(-1)?.date ===
      new Date((meta.regularMarketTime + (meta.gmtoffset ?? 0)) * 1000).toISOString().slice(0, 10);
  const prevClose = lastPointIsToday ? prev : (points.at(-1)?.close ?? null);
  const q: MarketQuote = {
    symbol,
    name,
    price: last,
    change1dPct: prevClose ? ((last - prevClose) / prevClose) * 100 : null,
    change1mPct: changeSince(points, daysAgo(lastDate, 30), last),
    change6mPct: changeSince(points, daysAgo(lastDate, 182), last),
    changeYtdPct: changeSince(points, `${Number(lastDate.slice(0, 4)) - 1}-12-31`, last),
    change1yPct: changeSince(points, daysAgo(lastDate, 365), last),
    change5yPct: points.length > 1000 ? changeSince(points, daysAgo(lastDate, 1826), last) : null,
    // The last year of daily closes, for the chart.
    series: withSeries
      ? points
          .filter((p) => p.date > daysAgo(lastDate, 366))
          .map((p) => ({ date: p.date, close: p.close }))
      : [],
  };
  return q;
}

let cache: { at: number; data: MarketOverview } | null = null;
let inflight: Promise<MarketOverview> | null = null;

export async function marketOverview(
  db: MunyDb,
  deps: MarketDeps,
  now = Date.now(),
): Promise<MarketOverview> {
  if (cache && now - cache.at < HOUR) return cache.data;
  if (inflight) return inflight;
  const f = deps.fetch ?? fetch;
  inflight = (async () => {
    const indexes: MarketQuote[] = [];
    const sectors: MarketQuote[] = [];
    let failed = 0;
    for (const [list, out, series] of [
      [MARKET_INDEXES, indexes, true],
      [MARKET_SECTORS, sectors, false],
    ] as const)
      for (const [symbol, name] of list) {
        try {
          spend(db, "yahoo");
          out.push(await quote(f, symbol, name, series));
        } catch {
          failed++;
        }
      }
    if (!indexes.length && !sectors.length && cache) return cache.data; // keep the last good one
    const data: MarketOverview = { updatedAt: now, indexes, sectors, failed };
    cache = { at: now, data };
    return data;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

const intradayCache = new Map<string, { at: number; data: MarketIntraday }>();

/** Today's prices for one index fund, every 5 minutes. */
export async function marketIntraday(
  db: MunyDb,
  deps: MarketDeps,
  symbol: string,
  now = Date.now(),
): Promise<MarketIntraday> {
  if (!MARKET_INDEXES.some(([s]) => s === symbol)) throw new Error("Unknown index");
  const hit = intradayCache.get(symbol);
  if (hit && now - hit.at < 10 * 60_000) return hit.data;
  spend(db, "yahoo");
  // Pre-market and after-hours too, so the index funds cover the day like the VIX does.
  const { meta, points } = await chart(
    deps.fetch ?? fetch,
    symbol,
    "range=1d&interval=5m&includePrePost=true",
  );
  const data: MarketIntraday = {
    symbol,
    previousClose: meta.chartPreviousClose ?? meta.previousClose ?? null,
    points: points.map((p) => ({ t: p.t, close: p.close })),
  };
  intradayCache.set(symbol, { at: now, data });
  return data;
}

/** For tests. */
export function resetMarketCache() {
  cache = null;
  intradayCache.clear();
}

import { type MunyDb, schema } from "@muny/db";
import type { SecurityKind, StockLive, StockNews, StockPage } from "@muny/shared";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { spend } from "../crypto/budget.js";
import { getInvestSettings } from "./logos.js";
import { changeSince, chart, daysAgo, type MarketDeps } from "./market.js";
import { investSummary, listInvestTxns } from "./service.js";

/**
 * One stock's page. What you hold, your trades and the closes Muny keeps come
 * from your own data. Live details (price, ranges, returns, five years of
 * closes) and recent news come from Yahoo Finance, only when "details" is
 * turned on; only the ticker is sent. Kept in memory for 15 minutes, and
 * Refresh fetches again (at most every 30 seconds).
 */

/** A ticker, or an index like ^VIX. */
export const STOCK_SYMBOL = /^\^?[A-Z][A-Z0-9.-]{0,9}$/;

const LIVE_FOR = 15 * 60_000;
const REFRESH_AFTER = 30_000;
const MAX_NEWS = 12;
const SEARCH = "https://query1.finance.yahoo.com/v1/finance/search";

const NewsReply = z.object({
  news: z
    .array(
      z.looseObject({
        title: z.string().optional(),
        publisher: z.string().optional(),
        link: z.string().optional(),
        providerPublishTime: z.number().optional(),
        relatedTickers: z.array(z.string()).optional(),
      }),
    )
    .optional(),
});

/** One line of someone else's text: no control characters, bounded. */
const line = (s: string | undefined, max: number) =>
  (s ?? "")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

/** Yahoo writes class shares with a dash (BRK-B). */
const yahooSymbol = (s: string) => (s.startsWith("^") ? s : s.replace(/\./g, "-"));

export async function stockNews(f: typeof fetch, symbol: string): Promise<StockNews[]> {
  const q = new URLSearchParams({
    q: yahooSymbol(symbol),
    quotesCount: "0",
    newsCount: String(MAX_NEWS * 2),
    enableFuzzyQuery: "false",
  });
  const res = await f(`${SEARCH}?${q}`, {
    headers: { accept: "application/json", "user-agent": "Muny (self-hosted)" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Yahoo Finance answered ${res.status}`);
  const parsed = NewsReply.safeParse(await res.json());
  if (!parsed.success) throw new Error("Unexpected answer");
  const want = yahooSymbol(symbol);
  const out: StockNews[] = [];
  const seen = new Set<string>();
  for (const n of parsed.data.news ?? []) {
    // Stories tagged with other companies only aren't about this one.
    if (n.relatedTickers?.length && !n.relatedTickers.includes(want)) continue;
    const title = line(n.title, 300);
    let url: URL;
    try {
      url = new URL(n.link ?? "");
    } catch {
      continue;
    }
    // Only ordinary web links open from Muny.
    if (!title || url.protocol !== "https:" || seen.has(url.href)) continue;
    seen.add(url.href);
    out.push({
      title,
      publisher: line(n.publisher, 80) || null,
      url: url.href,
      publishedAt: (n.providerPublishTime ?? 0) * 1000,
    });
  }
  return out.sort((a, b) => b.publishedAt - a.publishedAt).slice(0, MAX_NEWS);
}

const num = (v: number | undefined) => (v !== undefined && Number.isFinite(v) ? v : null);

async function loadLive(db: MunyDb, f: typeof fetch, symbol: string, now: number) {
  spend(db, "yahoo");
  const { meta, points } = await chart(f, yahooSymbol(symbol), "range=5y&interval=1d");
  if (!points.length && meta.regularMarketPrice === undefined)
    throw new Error(`Yahoo Finance doesn't know ${symbol}.`);
  const last = meta.regularMarketPrice ?? points.at(-1)?.close ?? null;
  const lastDate = points.at(-1)?.date ?? new Date(now).toISOString().slice(0, 10);
  // Today's close may be the last point; then the day before is the base for the day's change.
  const lastIsToday =
    meta.regularMarketTime !== undefined &&
    points.at(-1)?.date ===
      new Date((meta.regularMarketTime + (meta.gmtoffset ?? 0)) * 1000).toISOString().slice(0, 10);
  const prevClose =
    (lastIsToday ? points.at(-2)?.close : points.at(-1)?.close) ??
    num(meta.chartPreviousClose ?? meta.previousClose);
  const since = (date: string) => (last === null ? null : changeSince(points, date, last));

  let news: StockNews[] = [];
  let newsFailed = false;
  try {
    spend(db, "yahoo");
    news = await stockNews(f, symbol);
  } catch {
    newsFailed = true;
  }

  const live: StockLive = {
    updatedAt: now,
    name: line(meta.longName ?? meta.shortName, 200) || null,
    exchange: line(meta.fullExchangeName ?? meta.exchangeName, 60) || null,
    currency: line(meta.currency, 8) || null,
    price: last,
    previousClose: prevClose ?? null,
    dayHigh: num(meta.regularMarketDayHigh),
    dayLow: num(meta.regularMarketDayLow),
    volume: num(meta.regularMarketVolume),
    high52w: num(meta.fiftyTwoWeekHigh),
    low52w: num(meta.fiftyTwoWeekLow),
    change1dPct: last !== null && prevClose ? ((last - prevClose) / prevClose) * 100 : null,
    change1mPct: since(daysAgo(lastDate, 30)),
    change6mPct: since(daysAgo(lastDate, 182)),
    changeYtdPct: since(`${Number(lastDate.slice(0, 4)) - 1}-12-31`),
    change1yPct: since(daysAgo(lastDate, 365)),
    change5yPct: points.length > 1000 ? since(daysAgo(lastDate, 1826)) : null,
    series: points.map((p) => ({ date: p.date, close: p.close })),
    news,
    newsFailed,
  };
  return live;
}

const cache = new Map<string, { at: number; data: StockLive }>();
const inflight = new Map<string, Promise<StockLive>>();

async function liveFor(
  db: MunyDb,
  deps: MarketDeps,
  symbol: string,
  refresh: boolean,
  now: number,
): Promise<StockLive> {
  const hit = cache.get(symbol);
  if (hit && now - hit.at < (refresh ? REFRESH_AFTER : LIVE_FOR)) return hit.data;
  const running = inflight.get(symbol);
  if (running) return running;
  const p = loadLive(db, deps.fetch ?? fetch, symbol, now);
  inflight.set(symbol, p);
  try {
    const data = await p;
    cache.set(symbol, { at: now, data });
    return data;
  } finally {
    inflight.delete(symbol);
  }
}

export async function stockPage(
  db: MunyDb,
  deps: MarketDeps,
  symbol: string,
  opts: { refresh?: boolean; now?: number } = {},
): Promise<StockPage> {
  const now = opts.now ?? Date.now();
  const sec = db.select().from(schema.securities).where(eq(schema.securities.symbol, symbol)).get();
  const position =
    investSummary(db).positions.find((p) => p.symbol === symbol && p.type !== "cash") ?? null;
  const activity = sec
    ? listInvestTxns(db, { limit: 1000 }).filter((t) => t.symbol === symbol)
    : [];
  const history = sec
    ? db
        .select({ date: schema.securityPrices.date, close: schema.securityPrices.close })
        .from(schema.securityPrices)
        .where(eq(schema.securityPrices.securityId, sec.id))
        .orderBy(schema.securityPrices.date)
        .all()
        .map((r) => ({ date: r.date, close: Number(r.close) }))
        .filter((r) => Number.isFinite(r.close) && r.close > 0)
    : [];
  const watching = sec
    ? !!db
        .select({ id: schema.watchlist.securityId })
        .from(schema.watchlist)
        .where(eq(schema.watchlist.securityId, sec.id))
        .get()
    : false;

  const liveOn = getInvestSettings(db).details;
  let live: StockLive | null = null;
  let liveError: string | null = null;
  if (liveOn) {
    try {
      live = await liveFor(db, deps, symbol, !!opts.refresh, now);
    } catch (err) {
      // Show the last good details, and say why they're not newer.
      live = cache.get(symbol)?.data ?? null;
      liveError = err instanceof Error ? err.message : "Couldn't load the live details.";
    }
  }

  return {
    symbol,
    name: sec?.name ?? live?.name ?? symbol,
    type: (sec?.type as SecurityKind | undefined) ?? null,
    securityId: sec?.id ?? null,
    watching,
    position,
    activity,
    history,
    liveOn,
    live,
    liveError,
  };
}

/** For tests. */
export function resetStockCache() {
  cache.clear();
  inflight.clear();
}

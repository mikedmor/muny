import { normDec } from "@muny/core";
import { type MunyDb, schema } from "@muny/db";
import type { SecurityKind, WatchItem } from "@muny/shared";
import { and, desc, eq, inArray } from "drizzle-orm";
import { spend } from "../crypto/budget.js";
import { localToday } from "../lib/dates.js";
import { securityFor } from "./service.js";

/**
 * Watch list (D-037): tickers you follow, owned or not. Prices come from
 * Yahoo Finance's chart endpoint (only the ticker is sent): a year of daily
 * closes when added, then refreshed at most once a day when Stocks is opened.
 */

export interface WatchDeps {
  fetch?: typeof fetch;
}

const YAHOO = "https://query1.finance.yahoo.com/v8/finance/chart";
const REFRESHED_KEY = "invest.watchlist.refreshed";
export const TICKER = /^[A-Z][A-Z0-9.-]{0,9}$/;

interface YahooChart {
  chart?: {
    result?: {
      meta?: {
        gmtoffset?: number;
        longName?: string;
        shortName?: string;
        instrumentType?: string;
        regularMarketPrice?: number;
        regularMarketTime?: number;
      };
      timestamp?: number[];
      indicators?: { quote?: { close?: (number | null)[] }[] };
    }[];
  };
}

const kindOf = (t: string | undefined): SecurityKind =>
  t === "ETF"
    ? "etf"
    : t === "MUTUALFUND"
      ? "mutual_fund"
      : t === "MONEYMARKET"
        ? "cash"
        : t === "OPTION"
          ? "option"
          : "equity";

const dateOf = (ts: number, offset: number) =>
  new Date((ts + offset) * 1000).toISOString().slice(0, 10);

/** A year of daily closes plus the latest price, name and kind; null if Yahoo doesn't know it. */
export async function yahooQuote(f: typeof fetch, symbol: string) {
  const url = `${YAHOO}/${encodeURIComponent(symbol.replace(/\./g, "-"))}?range=1y&interval=1d`;
  const res = await f(url, {
    headers: { accept: "application/json", "user-agent": "Muny (self-hosted)" },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Yahoo Finance answered ${res.status}`);
  const r = ((await res.json()) as YahooChart).chart?.result?.[0];
  if (!r?.meta) return null;
  const offset = r.meta.gmtoffset ?? 0;
  const closes: { date: string; close: string }[] = [];
  const list = r.indicators?.quote?.[0]?.close ?? [];
  (r.timestamp ?? []).forEach((t, i) => {
    const c = list[i];
    if (c !== null && c !== undefined && Number.isFinite(c) && c > 0)
      closes.push({ date: dateOf(t, offset), close: normDec(c.toFixed(6)) });
  });
  const m = r.meta;
  if (m.regularMarketPrice && m.regularMarketTime)
    closes.push({
      date: dateOf(m.regularMarketTime, offset),
      close: normDec(m.regularMarketPrice.toFixed(6)),
    });
  return {
    name: (m.longName ?? m.shortName ?? symbol).slice(0, 200),
    type: kindOf(m.instrumentType),
    closes,
  };
}

function store(db: MunyDb, securityId: string, closes: { date: string; close: string }[]) {
  const p = schema.securityPrices;
  for (const c of closes)
    db.insert(p)
      .values({ securityId, date: c.date, close: c.close, source: "yahoo" })
      .onConflictDoUpdate({
        target: [p.securityId, p.date],
        set: { close: c.close, source: "yahoo" },
      })
      .run();
}

export async function addToWatchlist(db: MunyDb, deps: WatchDeps, raw: string): Promise<string> {
  const symbol = raw.trim().toUpperCase().replace(/^\$/, "");
  if (!TICKER.test(symbol)) throw new Error("Enter a ticker symbol, like VTI or AAPL");
  spend(db, "yahoo");
  const q = await yahooQuote(deps.fetch ?? fetch, symbol);
  if (!q?.closes.length) throw new Error(`Couldn't find ${symbol}. Check the ticker symbol.`);
  const id = securityFor(db, { symbol, name: q.name, type: q.type });
  store(db, id, q.closes);
  db.insert(schema.watchlist).values({ securityId: id }).onConflictDoNothing().run();
  return id;
}

export function removeFromWatchlist(db: MunyDb, securityId: string) {
  db.delete(schema.watchlist).where(eq(schema.watchlist.securityId, securityId)).run();
}

/** Refresh prices once a day (when asked by the page); quiet about failures. */
export async function refreshWatchlist(
  db: MunyDb,
  deps: WatchDeps,
  today = localToday(),
): Promise<{ refreshed: number }> {
  const last = db
    .select({ value: schema.appSettings.value })
    .from(schema.appSettings)
    .where(eq(schema.appSettings.key, REFRESHED_KEY))
    .get()?.value;
  if (last === today) return { refreshed: 0 };
  db.insert(schema.appSettings)
    .values({ key: REFRESHED_KEY, value: today })
    .onConflictDoUpdate({ target: schema.appSettings.key, set: { value: today } })
    .run();
  const rows = db
    .select({ id: schema.securities.id, symbol: schema.securities.symbol })
    .from(schema.watchlist)
    .innerJoin(schema.securities, eq(schema.securities.id, schema.watchlist.securityId))
    .all();
  let refreshed = 0;
  for (const r of rows) {
    try {
      spend(db, "yahoo");
      const q = await yahooQuote(deps.fetch ?? fetch, r.symbol);
      if (q?.closes.length) {
        store(db, r.id, q.closes);
        refreshed++;
      }
    } catch {
      break; // out of budget or Yahoo unreachable: try again tomorrow
    }
  }
  return { refreshed };
}

/** Change in percent from the close on or before `daysAgo` days before the last close. */
function changeOver(closes: { date: string; close: number }[], daysAgo: number): number | null {
  const last = closes[closes.length - 1];
  if (!last) return null;
  const target = new Date(`${last.date}T00:00:00Z`);
  target.setUTCDate(target.getUTCDate() - daysAgo);
  const day = target.toISOString().slice(0, 10);
  let base: { close: number } | undefined;
  for (const c of closes) if (c.date <= day) base = c;
  if (!base?.close) return null;
  return ((last.close - base.close) / base.close) * 100;
}

export function listWatchlist(
  db: MunyDb,
  today = localToday(),
): {
  items: WatchItem[];
  stale: boolean;
} {
  const rows = db
    .select({
      id: schema.securities.id,
      symbol: schema.securities.symbol,
      name: schema.securities.name,
      type: schema.securities.type,
      addedAt: schema.watchlist.addedAt,
    })
    .from(schema.watchlist)
    .innerJoin(schema.securities, eq(schema.securities.id, schema.watchlist.securityId))
    .orderBy(desc(schema.watchlist.addedAt))
    .all();
  const ids = rows.map((r) => r.id);
  const p = schema.securityPrices;
  const prices = ids.length
    ? db
        .select({ securityId: p.securityId, date: p.date, close: p.close })
        .from(p)
        .where(inArray(p.securityId, ids))
        .orderBy(p.date)
        .all()
    : [];
  const owned = new Map<string, number>();
  if (ids.length)
    for (const h of db
      .select({
        securityId: schema.investmentHoldings.securityId,
        v: schema.investmentHoldings.valueCents,
      })
      .from(schema.investmentHoldings)
      .where(and(inArray(schema.investmentHoldings.securityId, ids)))
      .all())
      owned.set(h.securityId, (owned.get(h.securityId) ?? 0) + h.v);
  const last = db
    .select({ value: schema.appSettings.value })
    .from(schema.appSettings)
    .where(eq(schema.appSettings.key, REFRESHED_KEY))
    .get()?.value;
  return {
    stale: rows.length > 0 && last !== today,
    items: rows.map((r) => {
      const closes = prices
        .filter((x) => x.securityId === r.id)
        .map((x) => ({ date: x.date, close: Number(x.close) }));
      const lastClose = closes[closes.length - 1];
      return {
        securityId: r.id,
        symbol: r.symbol,
        name: r.name,
        type: r.type as SecurityKind,
        price: lastClose ? String(lastClose.close) : null,
        priceDate: lastClose?.date ?? null,
        change1dPct: changeOver(closes, 1),
        change1mPct: changeOver(closes, 30),
        change1yPct: changeOver(closes, 365),
        // Last 3 months for the sparkline.
        spark: closes.slice(-63).map((c) => c.close),
        ownedValueCents: owned.get(r.id) ?? null,
      };
    }),
  };
}

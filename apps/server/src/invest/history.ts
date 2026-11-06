import { type HistoryTxn, normDec, reconstructParts, reconstructValues } from "@muny/core";
import { type MunyDb, schema } from "@muny/db";
import type { InvestBackfillResult } from "@muny/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import { BudgetError, spend } from "../crypto/budget.js";
import { localToday } from "../lib/dates.js";

/**
 * Fill in investment accounts' value history (D-036): daily closes for the
 * tickers held (Yahoo Finance's chart endpoint, only ticker symbols are sent,
 * once per ticker unless more history is needed), then each account's value
 * rebuilt day by day from today's holdings and its trades, stored as
 * estimated balance snapshots before its first reported one.
 */

export interface HistoryDeps {
  fetch?: typeof fetch;
}

const TICKER = /^[A-Z][A-Z0-9.-]{0,9}$/;
const YAHOO = "https://query1.finance.yahoo.com/v8/finance/chart";

interface YahooChart {
  chart?: {
    result?: {
      meta?: { gmtoffset?: number };
      timestamp?: number[];
      indicators?: { quote?: { close?: (number | null)[] }[] };
    }[];
    error?: { description?: string } | null;
  };
}

/** Daily closes (split-adjusted) for a ticker between two dates. */
export async function yahooCloses(
  f: typeof fetch,
  symbol: string,
  from: string,
  to: string,
): Promise<{ date: string; close: string }[]> {
  const p1 = Math.floor(Date.parse(`${from}T00:00:00Z`) / 1000) - 86400 * 7;
  const p2 = Math.floor(Date.parse(`${to}T00:00:00Z`) / 1000) + 86400;
  const url = `${YAHOO}/${encodeURIComponent(symbol.replace(/\./g, "-"))}?period1=${p1}&period2=${p2}&interval=1d&events=split`;
  const res = await f(url, {
    headers: { accept: "application/json", "user-agent": "Muny (self-hosted)" },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`Yahoo Finance answered ${res.status}`);
  const body = (await res.json()) as YahooChart;
  const r = body.chart?.result?.[0];
  const ts = r?.timestamp ?? [];
  const closes = r?.indicators?.quote?.[0]?.close ?? [];
  const offset = r?.meta?.gmtoffset ?? 0;
  const out: { date: string; close: string }[] = [];
  ts.forEach((t, i) => {
    const c = closes[i];
    if (c === null || c === undefined || !Number.isFinite(c) || c <= 0) return;
    out.push({
      date: new Date((t + offset) * 1000).toISOString().slice(0, 10),
      close: normDec(c.toFixed(6)),
    });
  });
  return out;
}

export async function backfillInvestHistory(
  db: MunyDb,
  deps: HistoryDeps = {},
  today = localToday(),
): Promise<InvestBackfillResult> {
  const accts = db
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(eq(schema.accounts.type, "investment"))
    .all()
    .map((a) => a.id);
  if (!accts.length) return { accounts: 0, tickers: 0, missing: [], from: null, points: 0 };

  const h = schema.investmentHoldings;
  const s = schema.securities;
  const t = schema.investmentTxns;
  const holdings = db
    .select({
      accountId: h.accountId,
      securityId: h.securityId,
      quantity: h.quantity,
      valueCents: h.valueCents,
      type: s.type,
      symbol: s.symbol,
    })
    .from(h)
    .innerJoin(s, eq(s.id, h.securityId))
    .where(inArray(h.accountId, accts))
    .all();
  const txns = db
    .select({
      accountId: t.accountId,
      date: t.date,
      type: t.type,
      securityId: t.securityId,
      quantity: t.quantity,
      amountCents: t.amountCents,
      symbol: s.symbol,
      secType: s.type,
    })
    .from(t)
    .leftJoin(s, eq(s.id, t.securityId))
    .where(inArray(t.accountId, accts))
    .all();

  // Which tickers, and from when: the first trade in each (or the account's first activity).
  const firstOf = new Map<string, string>();
  for (const x of txns) {
    const k = x.accountId;
    if (!firstOf.has(k) || (firstOf.get(k) as string) > x.date) firstOf.set(k, x.date);
  }
  const need = new Map<string, { symbol: string; from: string }>();
  const want = (securityId: string, symbol: string, type: string, from: string) => {
    if (type === "cash" || type === "option" || !TICKER.test(symbol)) return;
    const cur = need.get(securityId);
    if (!cur || cur.from > from) need.set(securityId, { symbol, from });
  };
  for (const x of holdings) {
    const from = firstOf.get(x.accountId);
    if (from) want(x.securityId, x.symbol, x.type, from);
  }
  for (const x of txns)
    if (x.securityId && x.symbol && x.secType) want(x.securityId, x.symbol, x.secType, x.date);

  // Fetch what isn't stored yet (a little slack for weekends and holidays).
  const f = deps.fetch ?? fetch;
  const missing: string[] = [];
  let tickers = 0;
  const p = schema.securityPrices;
  for (const [securityId, { symbol, from }] of need) {
    const have = db
      .select({ lo: sql<string | null>`min(${p.date})` })
      .from(p)
      .where(and(eq(p.securityId, securityId), eq(p.source, "yahoo")))
      .get();
    const lag = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86400000;
    // Closes back to the first trade are enough: after that, reported values take over.
    if (have?.lo && lag(have.lo, from) >= -4) continue;
    try {
      spend(db, "yahoo");
      const closes = await yahooCloses(f, symbol, from, today);
      if (!closes.length) {
        missing.push(symbol);
        continue;
      }
      for (const c of closes)
        db.insert(p)
          .values({ securityId, date: c.date, close: c.close, source: "yahoo" })
          .onConflictDoUpdate({
            target: [p.securityId, p.date],
            set: { close: c.close, source: "yahoo" },
          })
          .run();
      tickers++;
    } catch (e) {
      if (e instanceof BudgetError) throw e;
      missing.push(symbol);
    }
  }

  // Rebuild each account's days before its first reported value.
  let points = 0;
  let earliest: string | null = null;
  let done = 0;
  for (const accountId of accts) {
    const from = firstOf.get(accountId);
    if (!from) continue;
    const firstReal = db
      .select({ d: sql<string | null>`min(${schema.balanceSnapshots.date})` })
      .from(schema.balanceSnapshots)
      .where(
        and(
          eq(schema.balanceSnapshots.accountId, accountId),
          eq(schema.balanceSnapshots.estimated, false),
        ),
      )
      .get()?.d;
    const until = firstReal ?? today;
    if (from >= until) continue;
    const mine = holdings.filter((x) => x.accountId === accountId);
    const ids = new Set([
      ...mine.map((x) => x.securityId),
      ...txns
        .filter((x) => x.accountId === accountId && x.securityId)
        .map((x) => x.securityId as string),
    ]);
    const prices = new Map<string, Map<string, string>>();
    if (ids.size)
      for (const row of db
        .select({ securityId: p.securityId, date: p.date, close: p.close })
        .from(p)
        .where(inArray(p.securityId, [...ids]))
        .all()) {
        const m = prices.get(row.securityId) ?? new Map<string, string>();
        m.set(row.date, row.close);
        prices.set(row.securityId, m);
      }
    const values = reconstructValues({
      holdings: mine
        .filter((x) => x.type !== "cash")
        .map((x) => ({ securityId: x.securityId, quantity: x.quantity })),
      cashCents: mine.filter((x) => x.type === "cash").reduce((a, x) => a + x.valueCents, 0),
      txns: txns
        .filter((x) => x.accountId === accountId)
        .map(
          (x): HistoryTxn => ({
            date: x.date,
            type: x.type,
            // Cash-like securities move as cash (their amount), not as shares.
            securityId: x.secType === "cash" ? null : x.securityId,
            quantity: x.quantity,
            // Buying or selling a money market fund only moves cash around.
            amountCents:
              x.secType === "cash" && (x.type === "buy" || x.type === "sell") ? 0 : x.amountCents,
          }),
        ),
      prices,
      from,
      to: today,
    });
    db.delete(schema.balanceSnapshots)
      .where(
        and(
          eq(schema.balanceSnapshots.accountId, accountId),
          eq(schema.balanceSnapshots.estimated, true),
        ),
      )
      .run();
    for (const v of values) {
      if (v.date >= until) break;
      db.insert(schema.balanceSnapshots)
        .values({ accountId, date: v.date, balanceCents: v.valueCents, estimated: true })
        .onConflictDoNothing()
        .run();
      points++;
    }
    done++;
    if (!earliest || from < earliest) earliest = from;
  }
  return { accounts: done, tickers, missing, from: earliest, points };
}

/**
 * Split a value history by holding for the chart: each top holding's value on
 * each day (shares that day × that day's close, from the trades and stored
 * closes), scaled so the parts never exceed the recorded total; "Other" is
 * the rest (cash and smaller holdings).
 */
export function historyBySecurity(
  db: MunyDb,
  accountIds: string[],
  history: { date: string; valueCents: number }[],
  top: { securityId: string; symbol: string }[],
): { key: string; label: string; values: number[] }[] {
  const first = history[0];
  const last = history[history.length - 1];
  if (!first || !last || !top.length || !accountIds.length) return [];
  const h = schema.investmentHoldings;
  const s = schema.securities;
  const t = schema.investmentTxns;
  const p = schema.securityPrices;
  const holdings = db
    .select({
      accountId: h.accountId,
      securityId: h.securityId,
      quantity: h.quantity,
      type: s.type,
    })
    .from(h)
    .innerJoin(s, eq(s.id, h.securityId))
    .where(inArray(h.accountId, accountIds))
    .all()
    .filter((x) => x.type !== "cash");
  const txns = db
    .select({
      accountId: t.accountId,
      date: t.date,
      type: t.type,
      securityId: t.securityId,
      quantity: t.quantity,
      amountCents: t.amountCents,
    })
    .from(t)
    .where(inArray(t.accountId, accountIds))
    .all();
  const ids = [...new Set(holdings.map((x) => x.securityId))];
  const prices = new Map<string, Map<string, string>>();
  if (ids.length)
    for (const row of db
      .select({ securityId: p.securityId, date: p.date, close: p.close })
      .from(p)
      .where(inArray(p.securityId, ids))
      .all()) {
      const m = prices.get(row.securityId) ?? new Map<string, string>();
      m.set(row.date, row.close);
      prices.set(row.securityId, m);
    }
  const byDate = new Map<string, Map<string, number>>();
  for (const accountId of new Set(holdings.map((x) => x.accountId))) {
    const parts = reconstructParts({
      holdings: holdings
        .filter((x) => x.accountId === accountId)
        .map((x) => ({ securityId: x.securityId, quantity: x.quantity })),
      cashCents: 0,
      txns: txns.filter((x) => x.accountId === accountId).map((x) => ({ ...x, amountCents: 0 })),
      prices,
      from: first.date,
      to: last.date,
    });
    for (const d of parts) {
      const m = byDate.get(d.date) ?? new Map<string, number>();
      for (const [id, v] of d.bySecurity) m.set(id, (m.get(id) ?? 0) + v);
      byDate.set(d.date, m);
    }
  }
  const series = top.map((x) => ({ key: x.securityId, label: x.symbol, values: [] as number[] }));
  const other: number[] = [];
  for (const pt of history) {
    const m = byDate.get(pt.date);
    const raw = top.map((x) => m?.get(x.securityId) ?? 0);
    const sum = raw.reduce((a, b) => a + b, 0);
    const scale = sum > pt.valueCents && sum > 0 ? pt.valueCents / sum : 1;
    let named = 0;
    raw.forEach((v, i) => {
      const scaled = Math.floor(v * scale);
      named += scaled;
      series[i]?.values.push(scaled);
    });
    other.push(Math.max(0, pt.valueCents - named));
  }
  return [...series, { key: "other", label: "Other", values: other }];
}

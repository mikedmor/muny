import { type MunyDb, schema } from "@muny/db";
import { type LiveKey, type LiveQuote, liveKey } from "@muny/shared";
import { eq } from "drizzle-orm";
import { BudgetError, spend } from "../crypto/budget.js";
import { chart } from "../invest/market.js";
import { finnhubKey, readLive } from "./settings.js";

/**
 * Live prices, kept in memory and pushed to whoever's listening (open pages
 * and price alerts). Nothing is fetched for a symbol nobody is looking at
 * and no alert is watching, and nothing at all while the setting is off.
 *
 * - Stocks without a key: Yahoo Finance's chart endpoint, one symbol at a
 *   time, every few minutes during US market hours, spaced to stay within
 *   the "yahoo" request budget. Only the symbol is sent.
 * - Stocks with a Finnhub key: its quote endpoint for the previous close, and
 *   its trades stream for each price as it happens (up to 50 symbols).
 * - Crypto: Coinbase's public ticker stream (no key), for coins it lists in USD.
 *
 * Nothing about the connections is logged; problems are kept as a short message.
 */

type WsLike = {
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
};
export type WsFactory = new (url: string) => WsLike;

export interface LiveDeps {
  secretKey: Buffer | undefined;
  fetch?: typeof fetch;
  WebSocket?: WsFactory;
  now?: () => number;
}

const MINUTE = 60_000;
/** Of the 300 Yahoo requests a day, what live prices may use (the rest is for the watch list and charts). */
const YAHOO_DAILY_SHARE = 200;
const SESSION_MINUTES = 390;
const FINNHUB_MAX = 50;
const FINNHUB_QUOTE_EVERY = 5 * MINUTE;
const PRODUCTS_EVERY = 24 * 60 * MINUTE;
/** Keep listening this long after the last viewer leaves, so a page reload doesn't reconnect. */
const IDLE_CLOSE = 2 * MINUTE;
const STOCK = /^\^?[A-Z][A-Z0-9.-]{0,9}$/;
const COIN = /^[A-Z0-9]{1,15}$/;

/** US regular hours: 9:30 to 4:00 New York time, Monday to Friday (holidays aren't known). */
export function marketOpen(at: number): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(at));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  if (get("weekday") === "Sat" || get("weekday") === "Sun") return false;
  const m = Number(get("hour")) * 60 + Number(get("minute"));
  return m >= 9 * 60 + 30 && m < 16 * 60;
}

/** Minutes between Yahoo refreshes for this many symbols, within its share of the budget. */
export const yahooEvery = (symbols: number) =>
  Math.max(5, Math.ceil((Math.max(1, symbols) * SESSION_MINUTES) / YAHOO_DAILY_SHARE));

export function parseKeys(raw: string): LiveKey[] {
  const out = new Set<LiveKey>();
  for (const part of raw.split(",")) {
    const [kind, sym] = part.trim().split(":");
    const symbol = (sym ?? "").toUpperCase();
    if (kind === "stock" && STOCK.test(symbol)) out.add(liveKey("stock", symbol));
    if (kind === "crypto" && COIN.test(symbol)) out.add(liveKey("crypto", symbol));
    if (out.size >= 100) break;
  }
  return [...out];
}

const change = (price: number, prev: number | null) =>
  prev ? ((price - prev) / prev) * 100 : null;

export class LiveHub {
  readonly quotes = new Map<LiveKey, LiveQuote>();
  lastError: string | null = null;
  private listeners = new Set<(q: LiveQuote) => void>();
  private viewers = new Map<LiveKey, number>();
  /** Symbols price alerts want, refreshed on sync. */
  private alertKeys = new Set<LiveKey>();
  private lastViewerAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private fetchedAt = new Map<string, number>();
  private yahooBusy = false;
  private finnhub: {
    ws: WsLike | null;
    key: string;
    subscribed: Set<string>;
    retry: number;
  } | null = null;
  private coinbase: { ws: WsLike | null; subscribed: Set<string>; retry: number } | null = null;
  private products: { at: number; bases: Set<string> } | null = null;
  private pendingCrypto = new Map<LiveKey, LiveQuote>();
  private emittedAt = new Map<LiveKey, number>();

  constructor(
    private db: MunyDb,
    private deps: LiveDeps,
  ) {}

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  subscribe(fn: (q: LiveQuote) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** A page wants these prices while it's open. Returns how to stop. */
  watch(keys: LiveKey[]): () => void {
    for (const k of keys) this.viewers.set(k, (this.viewers.get(k) ?? 0) + 1);
    this.lastViewerAt = this.now();
    void this.sync();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      for (const k of keys) {
        const n = (this.viewers.get(k) ?? 1) - 1;
        if (n > 0) this.viewers.set(k, n);
        else this.viewers.delete(k);
      }
      this.lastViewerAt = this.now();
    };
  }

  /** Price alerts changed: what they watch. */
  setAlertKeys(keys: LiveKey[]) {
    this.alertKeys = new Set(keys);
    void this.sync();
  }

  publish(q: LiveQuote) {
    const before = this.quotes.get(q.key);
    this.quotes.set(q.key, q);
    if (before && before.price === q.price && before.previousClose === q.previousClose) return;
    for (const fn of this.listeners) fn(q);
  }

  start(everyMs = 30_000) {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sync(), everyMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.closeFinnhub();
    this.closeCoinbase();
  }

  private wanted() {
    const s = readLive(this.db);
    const idle = this.viewers.size === 0 && this.now() - this.lastViewerAt > IDLE_CLOSE;
    const keys = new Set<LiveKey>([...this.alertKeys, ...(idle ? [] : this.viewers.keys())]);
    const of = (kind: string) =>
      [...keys].filter((k) => k.startsWith(`${kind}:`)).map((k) => k.slice(kind.length + 1));
    return { s, stocks: s.stocks ? of("stock") : [], crypto: s.crypto ? of("crypto") : [] };
  }

  /** Bring connections and polling in line with what's wanted. */
  async sync() {
    const { stocks, crypto } = this.wanted();
    const key = stocks.length ? finnhubKey(this.db, this.deps.secretKey) : null;
    if (key) {
      await this.syncFinnhub(key, stocks);
    } else {
      this.closeFinnhub();
      await this.pollYahoo(stocks);
    }
    await this.syncCoinbase(crypto);
    this.flushCrypto();
  }

  // --- Stocks: Yahoo --------------------------------------------------------

  private async pollYahoo(symbols: string[]) {
    if (!symbols.length || this.yahooBusy) return;
    const now = this.now();
    const open = marketOpen(now);
    const every = yahooEvery(symbols.length) * MINUTE;
    const due = symbols.filter((s) => {
      const at = this.fetchedAt.get(`y:${s}`);
      // Out of hours, once (the closing price) is enough.
      return at === undefined || (open && now - at >= every);
    });
    if (!due.length) return;
    this.yahooBusy = true;
    try {
      for (const symbol of due) {
        this.fetchedAt.set(`y:${symbol}`, now);
        try {
          spend(this.db, "yahoo");
          const { meta, points } = await chart(
            this.deps.fetch ?? fetch,
            symbol.startsWith("^") ? symbol : symbol.replace(/\./g, "-"),
            "range=1d&interval=1d",
          );
          const price = meta.regularMarketPrice ?? points.at(-1)?.close;
          if (price === undefined) continue;
          const prev = meta.chartPreviousClose ?? meta.previousClose ?? null;
          this.publish({
            key: liveKey("stock", symbol),
            kind: "stock",
            symbol,
            price,
            previousClose: prev,
            changePct: change(price, prev),
            at: (meta.regularMarketTime ?? now / 1000) * 1000,
            source: "yahoo",
          });
          this.lastError = null;
        } catch (err) {
          this.lastError =
            err instanceof BudgetError
              ? "Yahoo Finance's daily limit is used up; stock prices pick up again tomorrow."
              : "Couldn't get stock prices from Yahoo Finance.";
          if (err instanceof BudgetError) break;
        }
      }
    } finally {
      this.yahooBusy = false;
    }
  }

  // --- Stocks: Finnhub ------------------------------------------------------

  private async finnhubQuote(key: string, symbol: string) {
    const res = await (this.deps.fetch ?? fetch)(
      `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}`,
      { headers: { "X-Finnhub-Token": key }, signal: AbortSignal.timeout(15_000) },
    );
    if (res.status === 401 || res.status === 403) throw new Error("bad_key");
    if (res.status === 429) throw new Error("busy");
    if (!res.ok) throw new Error("failed");
    const q = (await res.json()) as { c?: number; pc?: number; t?: number };
    if (!q.c) return;
    const prev = q.pc || null;
    this.publish({
      key: liveKey("stock", symbol),
      kind: "stock",
      symbol,
      price: q.c,
      previousClose: prev,
      changePct: change(q.c, prev),
      at: (q.t ?? this.now() / 1000) * 1000,
      source: "finnhub",
    });
  }

  private async syncFinnhub(key: string, wanted: string[]) {
    const symbols = wanted.filter((s) => !s.startsWith("^")).slice(0, FINNHUB_MAX);
    if (!symbols.length) return this.closeFinnhub();
    // The previous close (and a price out of hours), every few minutes; one a second at most.
    const now = this.now();
    for (const s of symbols) {
      const at = this.fetchedAt.get(`f:${s}`);
      if (at !== undefined && now - at < FINNHUB_QUOTE_EVERY) continue;
      this.fetchedAt.set(`f:${s}`, now);
      try {
        await this.finnhubQuote(key, s);
        this.lastError = null;
      } catch (err) {
        const m = err instanceof Error ? err.message : "";
        this.lastError =
          m === "bad_key"
            ? "Finnhub didn't accept the key. Check it in Settings → API."
            : m === "busy"
              ? "Finnhub is limiting requests; prices will catch up."
              : "Couldn't get stock prices from Finnhub.";
        if (m === "bad_key") return this.closeFinnhub();
        break;
      }
    }
    const WS = this.deps.WebSocket ?? (globalThis.WebSocket as unknown as WsFactory | undefined);
    if (!WS) return;
    if (this.finnhub && this.finnhub.key !== key) this.closeFinnhub();
    if (!this.finnhub) {
      const ws = new WS(`wss://ws.finnhub.io?token=${encodeURIComponent(key)}`);
      const state: { ws: WsLike | null; key: string; subscribed: Set<string>; retry: number } = {
        ws,
        key,
        subscribed: new Set<string>(),
        retry: 0,
      };
      this.finnhub = state;
      ws.onopen = () => {
        state.retry = 0;
        this.diffFinnhub(symbols);
      };
      ws.onmessage = (ev) => this.onFinnhub(ev.data);
      ws.onerror = () => {};
      ws.onclose = () => {
        if (this.finnhub !== state) return;
        state.ws = null;
        state.subscribed.clear();
        this.finnhub = null;
      };
      return;
    }
    if (this.finnhub.ws) this.diffFinnhub(symbols);
  }

  private diffFinnhub(symbols: string[]) {
    const f = this.finnhub;
    if (!f?.ws) return;
    const want = new Set(symbols);
    for (const s of want)
      if (!f.subscribed.has(s)) {
        f.ws.send(JSON.stringify({ type: "subscribe", symbol: s }));
        f.subscribed.add(s);
      }
    for (const s of [...f.subscribed])
      if (!want.has(s)) {
        f.ws.send(JSON.stringify({ type: "unsubscribe", symbol: s }));
        f.subscribed.delete(s);
      }
  }

  private onFinnhub(data: unknown) {
    let m: { type?: string; data?: { s?: string; p?: number; t?: number }[] };
    try {
      m = JSON.parse(String(data));
    } catch {
      return;
    }
    if (m.type !== "trade" || !Array.isArray(m.data)) return;
    // The last trade of each symbol in this batch.
    const last = new Map<string, { p: number; t: number }>();
    for (const t of m.data)
      if (t.s && typeof t.p === "number" && t.p > 0)
        last.set(t.s, { p: t.p, t: t.t ?? this.now() });
    for (const [symbol, t] of last) {
      const key = liveKey("stock", symbol);
      const prev = this.quotes.get(key)?.previousClose ?? null;
      this.publish({
        key,
        kind: "stock",
        symbol,
        price: t.p,
        previousClose: prev,
        changePct: change(t.p, prev),
        at: t.t,
        source: "finnhub",
      });
    }
  }

  private closeFinnhub() {
    const f = this.finnhub;
    this.finnhub = null;
    try {
      f?.ws?.close();
    } catch {
      // already closed
    }
  }

  // --- Crypto: Coinbase -----------------------------------------------------

  /** Coins Coinbase lists in USD (kept a day). */
  async coinbaseBases(): Promise<Set<string>> {
    const now = this.now();
    if (this.products && now - this.products.at < PRODUCTS_EVERY) return this.products.bases;
    const res = await (this.deps.fetch ?? fetch)("https://api.exchange.coinbase.com/products", {
      headers: { accept: "application/json", "user-agent": "Muny (self-hosted)" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error("products");
    const list = (await res.json()) as {
      base_currency?: string;
      quote_currency?: string;
      status?: string;
      trading_disabled?: boolean;
    }[];
    const bases = new Set(
      list
        .filter((p) => p.quote_currency === "USD" && p.status === "online" && !p.trading_disabled)
        .map((p) => String(p.base_currency).toUpperCase()),
    );
    this.products = { at: now, bases };
    return bases;
  }

  private async syncCoinbase(wanted: string[]) {
    if (!wanted.length) return this.closeCoinbase();
    let bases: Set<string>;
    try {
      bases = await this.coinbaseBases();
    } catch {
      this.lastError = "Couldn't reach Coinbase for crypto prices.";
      return;
    }
    const symbols = wanted.filter((s) => bases.has(s));
    if (!symbols.length) return this.closeCoinbase();
    const WS = this.deps.WebSocket ?? (globalThis.WebSocket as unknown as WsFactory | undefined);
    if (!WS) return;
    if (!this.coinbase) {
      const ws = new WS("wss://ws-feed.exchange.coinbase.com");
      const state = { ws, subscribed: new Set<string>(), retry: 0 };
      this.coinbase = state;
      ws.onopen = () => this.diffCoinbase(symbols);
      ws.onmessage = (ev) => this.onCoinbase(ev.data);
      ws.onerror = () => {};
      ws.onclose = () => {
        if (this.coinbase !== state) return;
        this.coinbase = null;
      };
      return;
    }
    this.diffCoinbase(symbols);
  }

  private diffCoinbase(symbols: string[]) {
    const c = this.coinbase;
    if (!c?.ws) return;
    const want = new Set(symbols);
    const add = [...want].filter((s) => !c.subscribed.has(s));
    const drop = [...c.subscribed].filter((s) => !want.has(s));
    if (add.length) {
      c.ws.send(
        JSON.stringify({
          type: "subscribe",
          product_ids: add.map((s) => `${s}-USD`),
          channels: ["ticker"],
        }),
      );
      for (const s of add) c.subscribed.add(s);
    }
    if (drop.length) {
      c.ws.send(
        JSON.stringify({
          type: "unsubscribe",
          product_ids: drop.map((s) => `${s}-USD`),
          channels: ["ticker"],
        }),
      );
      for (const s of drop) c.subscribed.delete(s);
    }
  }

  private onCoinbase(data: unknown) {
    let m: { type?: string; product_id?: string; price?: string; open_24h?: string; time?: string };
    try {
      m = JSON.parse(String(data));
    } catch {
      return;
    }
    if (m.type !== "ticker" || !m.product_id?.endsWith("-USD")) return;
    const price = Number(m.price);
    if (!Number.isFinite(price) || price <= 0) return;
    const symbol = m.product_id.slice(0, -4);
    const prev = Number(m.open_24h) || null;
    const key = liveKey("crypto", symbol);
    const q: LiveQuote = {
      key,
      kind: "crypto",
      symbol,
      price,
      previousClose: prev,
      changePct: change(price, prev),
      at: m.time ? Date.parse(m.time) || this.now() : this.now(),
      source: "coinbase",
    };
    // Busy coins trade many times a second: pass on at most one price a second each.
    const last = this.emittedAt.get(key) ?? 0;
    if (this.now() - last >= 1000) {
      this.emittedAt.set(key, this.now());
      this.publish(q);
    } else this.pendingCrypto.set(key, q);
  }

  /** Prices held back by the once-a-second limit. */
  flushCrypto() {
    for (const [key, q] of this.pendingCrypto) {
      this.emittedAt.set(key, this.now());
      this.publish(q);
    }
    this.pendingCrypto.clear();
  }

  private closeCoinbase() {
    const c = this.coinbase;
    this.coinbase = null;
    try {
      c?.ws?.close();
    } catch {
      // already closed
    }
  }

  /** For the settings page: whether stocks come from Yahoo, and how often. */
  yahooMinutes() {
    return yahooEvery(this.wanted().stocks.length);
  }

  /** For tests and the alerts: the latest close Muny keeps for a stock, as a fallback. */
  storedClose(symbol: string): number | null {
    const sec = this.db
      .select({ id: schema.securities.id })
      .from(schema.securities)
      .where(eq(schema.securities.symbol, symbol))
      .get();
    if (!sec) return null;
    const row = this.db
      .select({ close: schema.securityPrices.close })
      .from(schema.securityPrices)
      .where(eq(schema.securityPrices.securityId, sec.id))
      .orderBy(schema.securityPrices.date)
      .all()
      .at(-1);
    const n = Number(row?.close);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
}

import { schema } from "@muny/db";
import type { LiveQuote, LiveSettings, PriceAlert } from "@muny/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { makeSignedInApp } from "../test-utils.js";
import { marketOpen, parseKeys, type WsFactory, yahooEvery } from "./hub.js";

// Fakes only: a made-up Yahoo, Finnhub and Coinbase. Nothing leaves the test.

const SECRET = Buffer.alloc(32, 5).toString("base64");

function fakes() {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const sockets: FakeWs[] = [];
  let yahooPrice = 110;
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    if (url.includes("finnhub.io/api/v1/quote"))
      return new Response(JSON.stringify({ c: 201.5, pc: 200, t: 1_800_000_000 }));
    if (url.includes("api.exchange.coinbase.com/products"))
      return new Response(
        JSON.stringify([
          { base_currency: "BTC", quote_currency: "USD", status: "online" },
          { base_currency: "ETH", quote_currency: "EUR", status: "online" },
        ]),
      );
    if (url.includes("/v8/finance/chart/SRBT"))
      return new Response(
        JSON.stringify({
          chart: {
            result: [
              {
                meta: {
                  regularMarketPrice: yahooPrice,
                  chartPreviousClose: 100,
                  regularMarketTime: 1_800_000_000,
                },
                timestamp: [],
                indicators: { quote: [{ close: [] }] },
              },
            ],
          },
        }),
      );
    return new Response("{}", { status: 404 });
  }) as typeof fetch;

  class FakeWs {
    sent: unknown[] = [];
    onopen: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onclose: ((ev: unknown) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    closed = false;
    constructor(readonly url: string) {
      sockets.push(this);
    }
    send(data: string) {
      this.sent.push(JSON.parse(data));
    }
    close() {
      this.closed = true;
      this.onclose?.({});
    }
    open() {
      this.onopen?.({});
    }
    receive(m: unknown) {
      this.onmessage?.({ data: JSON.stringify(m) });
    }
  }
  return {
    f,
    calls,
    sockets,
    WS: FakeWs as unknown as WsFactory,
    setYahoo: (p: number) => (yahooPrice = p),
  };
}

async function setup() {
  const x = fakes();
  const ctx = await makeSignedInApp({
    env: { MUNY_SECRET_KEY: SECRET },
    priceFetch: x.f,
    liveWebSocket: x.WS,
  });
  const quotes = async (keys: string) =>
    (await ctx.client.get(`/api/live/quotes?keys=${keys}`)).json<LiveQuote[]>();
  const waitQuote = (keys: string) =>
    vi.waitFor(
      async () => {
        const q = await quotes(keys);
        if (!q.length) throw new Error("no quote yet");
        return q;
      },
      { timeout: 3000, interval: 10 },
    );
  const notes = () =>
    ctx.db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.ruleType, "price_alert"))
      .all();
  return { ...ctx, ...x, quotes, waitQuote, notes };
}

describe("live prices: the parts", () => {
  it("knows market hours and spaces Yahoo out within its budget", () => {
    expect(marketOpen(Date.parse("2026-11-12T15:00:00Z"))).toBe(true); // Thursday 10:00 New York
    expect(marketOpen(Date.parse("2026-11-12T22:00:00Z"))).toBe(false); // 5:00 PM
    expect(marketOpen(Date.parse("2026-11-14T15:00:00Z"))).toBe(false); // Saturday
    expect(yahooEvery(1)).toBe(5);
    expect(yahooEvery(10)).toBe(20);
    expect(parseKeys("stock:aapl,crypto:btc,nope:x,stock:not a ticker")).toEqual([
      "stock:AAPL",
      "crypto:BTC",
    ]);
  });
});

describe("live prices and price alerts", () => {
  it("sends nothing while off", async () => {
    const c = await setup();
    const r = await c.client.post("/api/price-alerts", {
      kind: "stock",
      symbol: "SRBT",
      condition: "above",
      value: 105,
      basePrice: 100,
    });
    expect(r.statusCode).toBe(200);
    await new Promise((res) => setTimeout(res, 50));
    expect(c.calls).toEqual([]);
    expect(c.sockets).toEqual([]);
  });

  it("checks a stock alert against Yahoo's price, once, and sends it as an alert", async () => {
    const c = await setup();
    await c.client.put("/api/live", { stocks: true });
    const alert = (
      await c.client.post("/api/price-alerts", {
        kind: "stock",
        symbol: "srbt",
        condition: "above",
        value: 105,
      })
    ).json<PriceAlert>();
    const [q] = await c.waitQuote("stock:SRBT");
    expect(q).toMatchObject({ price: 110, previousClose: 100, source: "yahoo" });
    expect(q?.changePct).toBeCloseTo(10);
    await vi.waitFor(() => expect(c.notes()).toHaveLength(1), { timeout: 2000 });
    const note = c.notes()[0];
    expect(note?.title).toContain("SRBT");
    expect(note?.body).toContain("$110.00");
    expect(note?.link).toBe("/stocks/SRBT");
    // It doesn't repeat, so it turned itself off.
    const after = (await c.client.get("/api/price-alerts?kind=stock&symbol=SRBT")).json<
      PriceAlert[]
    >();
    expect(after.find((a) => a.id === alert.id)).toMatchObject({
      enabled: false,
      lastFiredPrice: 110,
    });
    // Only the symbol went to Yahoo.
    expect(c.calls.every((x) => x.url.includes("/chart/SRBT?"))).toBe(true);

    // A move since it was set needs a price to measure from.
    const move = (
      await c.client.post("/api/price-alerts", {
        kind: "stock",
        symbol: "SRBT",
        condition: "move_down",
        value: 5,
      })
    ).json<PriceAlert>();
    expect(move.basePrice).toBe(110);
    expect(
      (
        await c.client.post("/api/price-alerts", {
          kind: "crypto",
          symbol: "BTC",
          condition: "high_52w",
        })
      ).statusCode,
    ).toBe(400);
  });

  it("uses Finnhub in real time with a key, and never puts the key in the settings", async () => {
    const c = await setup();
    const s = (
      await c.client.put("/api/live", { stocks: true, finnhubKey: "sample-finnhub-key" })
    ).json<LiveSettings>();
    expect(s.hasFinnhubKey).toBe(true);
    expect(JSON.stringify(s)).not.toContain("sample-finnhub-key");
    await c.client.post("/api/price-alerts", {
      kind: "stock",
      symbol: "SRBT",
      condition: "day_up",
      value: 2,
      repeat: true,
    });
    const [q] = await c.waitQuote("stock:SRBT");
    expect(q).toMatchObject({ price: 201.5, previousClose: 200, source: "finnhub" });
    const rest = c.calls.find((x) => x.url.includes("finnhub.io"));
    expect(rest?.url).not.toContain("sample-finnhub-key");
    expect(rest?.headers["X-Finnhub-Token"]).toBe("sample-finnhub-key");

    const ws = c.sockets.find((w) => w.url.startsWith("wss://ws.finnhub.io")) as unknown as {
      open(): void;
      receive(m: unknown): void;
      sent: unknown[];
    };
    ws.open();
    expect(ws.sent).toContainEqual({ type: "subscribe", symbol: "SRBT" });
    ws.receive({
      type: "trade",
      data: [
        { s: "SRBT", p: 203, t: 1_800_000_100_000 },
        { s: "SRBT", p: 205, t: 1_800_000_200_000 },
      ],
    });
    const [live] = await c.quotes("stock:SRBT");
    expect(live).toMatchObject({ price: 205, previousClose: 200 });
    expect(live?.changePct).toBeCloseTo(2.5);
    // Up 2.5% today: it fires, and (repeating) not again today.
    await vi.waitFor(() => expect(c.notes()).toHaveLength(1), { timeout: 2000 });
    ws.receive({ type: "trade", data: [{ s: "SRBT", p: 210, t: 1_800_000_300_000 }] });
    expect(c.notes()).toHaveLength(1);
  });

  it("follows coins on Coinbase in real time, for coins it lists", async () => {
    const c = await setup();
    await c.client.put("/api/live", { crypto: true });
    await c.client.post("/api/price-alerts", {
      kind: "crypto",
      symbol: "BTC",
      condition: "below",
      value: 50_000,
    });
    await c.client.post("/api/price-alerts", {
      kind: "crypto",
      symbol: "ETH",
      condition: "below",
      value: 1,
    });
    const ws = await vi.waitFor(
      () => {
        const w = c.sockets.find((s) => s.url === "wss://ws-feed.exchange.coinbase.com");
        if (!w) throw new Error("not yet");
        return w as unknown as { open(): void; receive(m: unknown): void; sent: unknown[] };
      },
      { timeout: 2000, interval: 10 },
    );
    ws.open();
    // ETH isn't listed in USD there, so it isn't asked for.
    expect(ws.sent).toEqual([
      { type: "subscribe", product_ids: ["BTC-USD"], channels: ["ticker"] },
    ]);
    ws.receive({ type: "ticker", product_id: "BTC-USD", price: "49500.12", open_24h: "51000" });
    const [q] = await c.quotes("crypto:BTC");
    expect(q).toMatchObject({ price: 49_500.12, previousClose: 51_000, source: "coinbase" });
    await vi.waitFor(() => expect(c.notes()).toHaveLength(1), { timeout: 2000 });
    expect(c.notes()[0]?.link).toBe("/crypto");
  });
});

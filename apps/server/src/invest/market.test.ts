import type { MarketOverview } from "@muny/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { makeSignedInApp } from "../test-utils.js";
import { MARKET_INDEXES, MARKET_SECTORS, marketIntraday, resetMarketCache } from "./market.js";

// Fakes only; no network.

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(300, 1)]);

function fakes() {
  const calls: string[] = [];
  const day = 86400;
  const now = Math.floor(Date.now() / 1000);
  const f = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("financialmodelingprep.com/image-stock/AAPL"))
      return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
    if (url.includes("image-stock") || url.includes("parqet"))
      return new Response("nope", { status: 404, headers: { "content-type": "text/html" } });
    if (url.includes("interval=5m"))
      return new Response(
        JSON.stringify({
          chart: {
            result: [
              {
                meta: { gmtoffset: 0, chartPreviousClose: 100 },
                timestamp: [now - 600, now - 300],
                indicators: { quote: [{ close: [101, 102] }] },
              },
            ],
          },
        }),
      );
    // A year ago 80, a month ago 90, yesterday 100, today 110.
    return new Response(
      JSON.stringify({
        chart: {
          result: [
            {
              meta: { gmtoffset: 0, regularMarketPrice: 110, regularMarketTime: now },
              timestamp: [now - 366 * day, now - 31 * day, now - day, now],
              indicators: { quote: [{ close: [80, 90, 100, 110] }] },
            },
          ],
        },
      }),
    );
  }) as typeof fetch;
  return { f, calls };
}

describe("stocks extras (opt-in)", () => {
  beforeEach(() => resetMarketCache());

  it("serves logos only once turned on, fetching each ticker once", async () => {
    const x = fakes();
    const { client } = await makeSignedInApp({ priceFetch: x.f });
    expect((await client.get("/api/invest/logo/AAPL")).statusCode).toBe(404);
    expect(x.calls).toHaveLength(0);

    await client.put("/api/invest/settings", { logos: true });
    const r = await client.get("/api/invest/logo/AAPL");
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toBe("image/png");
    expect(r.headers["content-security-policy"]).toContain("sandbox");
    await client.get("/api/invest/logo/AAPL");
    expect(x.calls).toHaveLength(1); // cached

    // Unknown everywhere: tried both sources, then remembered as missing.
    expect((await client.get("/api/invest/logo/ZZZZ")).statusCode).toBe(404);
    expect((await client.get("/api/invest/logo/ZZZZ")).statusCode).toBe(404);
    expect(x.calls).toHaveLength(3);
    expect((await client.get("/api/invest/logo/..%2Fetc")).statusCode).toBe(404);
  });

  it("shows the market overview once turned on, cached for an hour", async () => {
    const x = fakes();
    const { client } = await makeSignedInApp({ priceFetch: x.f });
    expect((await client.get("/api/invest/market")).statusCode).toBe(400);

    await client.put("/api/invest/settings", { market: true });
    const m = (await client.get("/api/invest/market")).json<MarketOverview>();
    expect(m.indexes.map((q) => q.symbol)).toEqual(MARKET_INDEXES.map(([s]) => s));
    expect(m.sectors).toHaveLength(MARKET_SECTORS.length);
    const spy = m.indexes[0];
    expect(spy?.price).toBe(110);
    expect(spy?.change1dPct).toBeCloseTo(10);
    expect(spy?.change1mPct).toBeCloseTo(22.2, 0);
    expect(spy?.series.length).toBeGreaterThan(0);
    expect(m.sectors[0]?.series).toEqual([]);
    const n = x.calls.length;
    await client.get("/api/invest/market");
    expect(x.calls.length).toBe(n);
    // Only the tickers are sent, with the VIX's caret encoded.
    expect(x.calls.some((u) => u.includes("/chart/%5EVIX?"))).toBe(true);

    const day = await client.get("/api/invest/market/intraday?symbol=SPY");
    expect(day.json<{ previousClose: number; points: unknown[] }>()).toMatchObject({
      previousClose: 100,
    });
    expect((await client.get("/api/invest/market/intraday?symbol=AAPL")).statusCode).toBe(400);
    // Funds include pre-market and after-hours; the VIX only its session (no 3:15 AM start).
    await client.get("/api/invest/market/intraday?symbol=%5EVIX");
    const intraday = x.calls.filter((u) => u.includes("interval=5m"));
    expect(intraday.find((u) => u.includes("/chart/SPY?"))).toContain("includePrePost=true");
    expect(intraday.find((u) => u.includes("/chart/%5EVIX?"))).toContain("includePrePost=false");
  });
});

describe("index intraday session", () => {
  it("charts the VIX from the 9:30 open, and funds with their pre-market", async () => {
    const { db } = await makeSignedInApp();
    resetMarketCache();
    // 8:00 and 10:00 AM New York time on a winter day (UTC-5).
    const at = (h: number) => Date.UTC(2026, 11, 3, h + 5, 0) / 1000;
    const f = (async () =>
      new Response(
        JSON.stringify({
          chart: {
            result: [
              {
                meta: { gmtoffset: -21600, chartPreviousClose: 20 },
                timestamp: [at(8), at(10)],
                indicators: { quote: [{ close: [21, 22] }] },
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    const vix = await marketIntraday(db, { fetch: f }, "^VIX");
    expect(vix.points.map((p) => p.close)).toEqual([22]);
    const spy = await marketIntraday(db, { fetch: f }, "SPY");
    expect(spy.points.map((p) => p.close)).toEqual([21, 22]);
  });
});

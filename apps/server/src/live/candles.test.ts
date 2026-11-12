import { schema } from "@muny/db";
import type { CandleSet, CoinPage } from "@muny/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { makeSignedInApp } from "../test-utils.js";
import { resetCandles } from "./candles.js";

// Fakes only: a made-up Yahoo and Coinbase. Nothing leaves the test.

const DAY = 86_400;

function fakes() {
  const calls: string[] = [];
  const f = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/v8/finance/chart/SRBT?"))
      return new Response(
        JSON.stringify({
          chart: {
            result: [
              {
                meta: { regularMarketPrice: 104, chartPreviousClose: 100, gmtoffset: 0 },
                timestamp: [1_800_000_000, 1_800_000_300, 1_800_000_600],
                indicators: {
                  quote: [
                    {
                      open: [100, 101, null],
                      high: [102, 103, null],
                      low: [99, 100.5, null],
                      close: [101, 102.5, 104],
                      volume: [1000, 1500, null],
                    },
                  ],
                },
              },
            ],
          },
        }),
      );
    if (url.includes("api.exchange.coinbase.com/products/BTC-USD/candles"))
      // Newest first: [time, low, high, open, close, volume].
      return new Response(
        JSON.stringify([
          [1_800_000_000 + DAY, 49_000, 51_000, 50_000, 50_500, 12.5],
          [1_800_000_000, 48_000, 50_200, 48_500, 50_000, 10],
        ]),
      );
    if (url.includes("api.exchange.coinbase.com/products"))
      return new Response(
        JSON.stringify([{ base_currency: "BTC", quote_currency: "USD", status: "online" }]),
      );
    if (url.includes("/v1/finance/search"))
      return new Response(
        JSON.stringify({
          news: [
            {
              title: "Sample coin news",
              publisher: "Example Wire",
              link: "https://news.example.com/btc",
              providerPublishTime: 1_800_000_000,
              relatedTickers: ["BTC-USD"],
            },
          ],
        }),
      );
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { f, calls };
}

describe("the trading chart and coin pages", () => {
  beforeEach(() => resetCandles());

  it("gets a stock's bars from Yahoo once its details are on", async () => {
    const x = fakes();
    const { client } = await makeSignedInApp({ priceFetch: x.f });
    expect((await client.get("/api/live/candles?key=stock:SRBT&range=1d")).statusCode).toBe(409);
    expect(x.calls).toEqual([]);
    await client.put("/api/invest/settings", { details: true });
    const r = (await client.get("/api/live/candles?key=stock:srbt&range=1d")).json<CandleSet>();
    expect(r).toMatchObject({ barMinutes: 5, previousClose: 100, source: "yahoo" });
    expect(r.candles).toEqual([
      { t: 1_800_000_000_000, o: 100, h: 102, l: 99, c: 101, v: 1000 },
      { t: 1_800_000_300_000, o: 101, h: 103, l: 100.5, c: 102.5, v: 1500 },
      // A bar Yahoo only has a close for.
      { t: 1_800_000_600_000, o: 104, h: 104, l: 104, c: 104, v: 0 },
    ]);
    expect(x.calls[0]).toContain("interval=5m");
    // Kept a couple of minutes.
    await client.get("/api/live/candles?key=stock:SRBT&range=1d");
    expect(x.calls).toHaveLength(1);
  });

  it("gets a coin's bars from Coinbase once live crypto is on, for coins it lists", async () => {
    const x = fakes();
    const { client } = await makeSignedInApp({ priceFetch: x.f });
    expect((await client.get("/api/live/candles?key=crypto:BTC&range=1m")).statusCode).toBe(409);
    await client.put("/api/live", { crypto: true });
    const r = (await client.get("/api/live/candles?key=crypto:BTC&range=1m")).json<CandleSet>();
    expect(r.source).toBe("coinbase");
    expect(r.candles.map((c) => [c.o, c.h, c.l, c.c, c.v])).toEqual([
      [48_500, 50_200, 48_000, 50_000, 10],
      [50_000, 51_000, 49_000, 50_500, 12.5],
    ]);
    const other = await client.get("/api/live/candles?key=crypto:ZZZ&range=1m");
    expect(other.statusCode).toBe(409);
    expect(other.json<{ error: string }>().error).toContain("Coinbase doesn't trade ZZZ");
  });

  it("shows a coin's stored prices, and its news when that's on", async () => {
    const x = fakes();
    const { client, db } = await makeSignedInApp({ priceFetch: x.f });
    db.insert(schema.cryptoPrices)
      .values([
        { asset: "BTC", date: "2026-11-10", usd: "50000", source: "defillama" },
        { asset: "BTC", date: "2026-11-11", usd: "51000.5", source: "defillama" },
      ])
      .run();
    let page = (await client.get("/api/crypto/coins/btc")).json<CoinPage>();
    expect(page).toMatchObject({
      asset: "BTC",
      newsOn: false,
      news: [],
      liveOn: false,
      onCoinbase: null,
    });
    expect(page.history).toEqual([
      { date: "2026-11-10", close: 50_000 },
      { date: "2026-11-11", close: 51_000.5 },
    ]);
    expect(x.calls).toEqual([]);
    await client.put("/api/invest/settings", { details: true });
    page = (await client.get("/api/crypto/coins/BTC")).json<CoinPage>();
    expect(page.news.map((n) => n.title)).toEqual(["Sample coin news"]);
    expect(x.calls.every((u) => u.includes("BTC-USD"))).toBe(true);
  });
});

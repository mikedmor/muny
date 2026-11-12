import type { StockPage } from "@muny/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { makeSignedInApp } from "../test-utils.js";
import { resetStockCache } from "./stock.js";

// Synthetic data only. A fake Yahoo Finance; no network.

function fakeYahoo() {
  const calls: string[] = [];
  const day = 86400;
  const now = Math.floor(Date.now() / 1000);
  let newsDown = false;
  const f = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/v1/finance/search")) {
      if (newsDown) return new Response("down", { status: 500 });
      return new Response(
        JSON.stringify({
          news: [
            {
              title: "Sample Robotics\u0007 beats estimates",
              publisher: "Example Wire",
              link: "https://news.example.com/a",
              providerPublishTime: now - 3600,
              relatedTickers: ["SRBT"],
            },
            {
              title: "Older story",
              publisher: "Example Daily",
              link: "https://news.example.com/b",
              providerPublishTime: now - 7200,
            },
            {
              title: "About someone else",
              link: "https://news.example.com/c",
              providerPublishTime: now,
              relatedTickers: ["OTHR"],
            },
            { title: "Not a web link", link: "javascript:alert(1)", providerPublishTime: now },
          ],
        }),
      );
    }
    if (!url.includes("/chart/SRBT?"))
      return new Response(JSON.stringify({ chart: { result: null } }), { status: 404 });
    // A year ago 80, a month ago 90, yesterday 100, today 110.
    return new Response(
      JSON.stringify({
        chart: {
          result: [
            {
              meta: {
                gmtoffset: 0,
                longName: "Sample Robotics Inc.",
                fullExchangeName: "NasdaqGS",
                currency: "USD",
                regularMarketPrice: 110,
                regularMarketTime: now,
                regularMarketDayHigh: 112,
                regularMarketDayLow: 104,
                regularMarketVolume: 1_234_567,
                fiftyTwoWeekHigh: 120,
                fiftyTwoWeekLow: 75,
              },
              timestamp: [now - 366 * day, now - 31 * day, now - day, now],
              indicators: { quote: [{ close: [80, 90, 100, 110] }] },
            },
          ],
        },
      }),
    );
  }) as typeof fetch;
  return { f, calls, setNewsDown: (v: boolean) => (newsDown = v) };
}

describe("a stock's page", () => {
  beforeEach(() => resetStockCache());

  it("shows your own data with nothing sent until live details are on", async () => {
    const y = fakeYahoo();
    const { client } = await makeSignedInApp({ priceFetch: y.f });
    const r = await client.get("/api/invest/stock/srbt");
    expect(r.statusCode).toBe(200);
    expect(r.json<StockPage>()).toMatchObject({
      symbol: "SRBT",
      name: "SRBT",
      liveOn: false,
      live: null,
      position: null,
      activity: [],
      watching: false,
    });
    expect(y.calls).toHaveLength(0);
    expect((await client.get("/api/invest/stock/not%20a%20ticker")).statusCode).toBe(400);
  });

  it("loads details and news once turned on, keeps them, and refreshes on request", async () => {
    const y = fakeYahoo();
    const { client } = await makeSignedInApp({ priceFetch: y.f });
    await client.put("/api/invest/settings", { details: true });
    const page = (await client.get("/api/invest/stock/SRBT")).json<StockPage>();
    const live = page.live;
    if (!live) throw new Error("no live details");
    expect(page.name).toBe("Sample Robotics Inc.");
    expect(live).toMatchObject({
      exchange: "NasdaqGS",
      price: 110,
      previousClose: 100,
      dayHigh: 112,
      low52w: 75,
      volume: 1_234_567,
      newsFailed: false,
    });
    expect(live.change1dPct).toBeCloseTo(10);
    expect(live.series).toHaveLength(4);
    // Only stories about it, only web links, newest first, cleaned up.
    expect(live.news.map((n) => n.title)).toEqual([
      "Sample Robotics beats estimates",
      "Older story",
    ]);
    // Only the ticker goes out.
    expect(y.calls.every((u) => !u.includes("@") && /SRBT/.test(u))).toBe(true);

    const sent = y.calls.length;
    await client.get("/api/invest/stock/SRBT");
    expect(y.calls).toHaveLength(sent);
    // Refresh doesn't go out again within 30 seconds either.
    await client.get("/api/invest/stock/SRBT?refresh=1");
    expect(y.calls).toHaveLength(sent);
  });

  it("still shows the details when the news can't be loaded", async () => {
    const y = fakeYahoo();
    y.setNewsDown(true);
    const { client } = await makeSignedInApp({ priceFetch: y.f });
    await client.put("/api/invest/settings", { details: true });
    const page = (await client.get("/api/invest/stock/SRBT")).json<StockPage>();
    expect(page.live).toMatchObject({ price: 110, news: [], newsFailed: true });
    const unknown = (await client.get("/api/invest/stock/ZZZZ")).json<StockPage>();
    expect(unknown.live).toBeNull();
    expect(unknown.liveError).toBeTruthy();
  });
});

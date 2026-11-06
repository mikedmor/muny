import type { WatchItem } from "@muny/shared";
import { describe, expect, it } from "vitest";
import { makeSignedInApp } from "../test-utils.js";

// Synthetic data only. A fake Yahoo Finance; no network.

function fakeYahoo() {
  const calls: string[] = [];
  const now = Math.floor(Date.now() / 1000);
  const f = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (!url.includes("/chart/NVDA?"))
      return new Response(JSON.stringify({ chart: { result: null } }), { status: 404 });
    return new Response(
      JSON.stringify({
        chart: {
          result: [
            {
              meta: {
                gmtoffset: 0,
                longName: "NVIDIA Corporation",
                instrumentType: "EQUITY",
                regularMarketPrice: 110,
                regularMarketTime: now,
              },
              timestamp: [now - 40 * 86400, now - 86400],
              indicators: { quote: [{ close: [80, 100] }] },
            },
          ],
        },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  return { f, calls };
}

describe("watch list", () => {
  it("adds a ticker with its prices, refreshes once a day, and removes it", async () => {
    const yahoo = fakeYahoo();
    const { client } = await makeSignedInApp({ priceFetch: yahoo.f });
    const add = await client.post("/api/invest/watchlist", { symbol: " nvda " });
    expect(add.statusCode).toBe(200);
    expect(yahoo.calls[0]).toMatch(/\/chart\/NVDA\?range=1y&interval=1d$/);

    const list = (await client.get("/api/invest/watchlist")).json<{
      items: WatchItem[];
      stale: boolean;
    }>();
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({
      symbol: "NVDA",
      name: "NVIDIA Corporation",
      type: "equity",
      price: "110",
      ownedValueCents: null,
    });
    expect(list.items[0]?.change1dPct).toBeCloseTo(10);
    expect(list.items[0]?.change1mPct).toBeCloseTo(37.5);
    expect(list.stale).toBe(true);

    await client.post("/api/invest/watchlist/refresh");
    await client.post("/api/invest/watchlist/refresh");
    expect(yahoo.calls).toHaveLength(2); // the add, then one refresh today
    const after = (await client.get("/api/invest/watchlist")).json<{ stale: boolean }>();
    expect(after.stale).toBe(false);

    await client.delete(`/api/invest/watchlist/${list.items[0]?.securityId}`);
    expect(
      (await client.get("/api/invest/watchlist")).json<{ items: WatchItem[] }>().items,
    ).toHaveLength(0);
  });

  it("explains unknown or malformed tickers", async () => {
    const { client } = await makeSignedInApp({ priceFetch: fakeYahoo().f });
    const unknown = await client.post("/api/invest/watchlist", { symbol: "ZZZZ" });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json<{ error: string }>().error).toMatch(/Couldn't find ZZZZ/);
    const bad = await client.post("/api/invest/watchlist", { symbol: "not a ticker" });
    expect(bad.statusCode).toBe(400);
  });
});

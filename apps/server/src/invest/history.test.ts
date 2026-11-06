import type { InvestBackfillResult, InvestSummary, NetWorthReport } from "@muny/shared";
import { describe, expect, it } from "vitest";
import { makeSignedInApp } from "../test-utils.js";

// Synthetic data only. A fake Yahoo Finance; no network.

const POSITIONS = `Account Number,Account Name,Symbol,Description,Quantity,Last Price,Current Value,Cost Basis Total
X00001234,Individual,SPAXX**,HELD IN MONEY MARKET,,,$100.00,
X00001234,Individual,VTI,VANGUARD TOTAL STOCK MARKET ETF,3,$120.00,$360.00,$300.00
`;

const HISTORY = `Run Date,Account,Account Number,Action,Symbol,Description,Type,Quantity,Price ($),Commission ($),Fees ($),Accrued Interest ($),Amount ($),Settlement Date
01/04/2026,Individual,X00001234,YOU BOUGHT VTI,VTI,VANGUARD TOTAL STOCK MARKET ETF,Cash,2,100.00,,,,-200.00,
01/02/2026,Individual,X00001234,YOU BOUGHT VTI,VTI,VANGUARD TOTAL STOCK MARKET ETF,Cash,1,100.00,,,,-100.00,
01/02/2026,Individual,X00001234,Electronic Funds Transfer Received,,No Description,Cash,,,,,,400.00,
`;

/** Yahoo-shaped answer: VTI closes at 100 on Jan 2, 110 on Jan 3, 120 from Jan 5. */
function fakeYahoo() {
  const calls: string[] = [];
  const day = (d: string) => Date.parse(`${d}T14:30:00Z`) / 1000;
  const f = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (!url.includes("/VTI?"))
      return new Response(JSON.stringify({ chart: { result: null } }), { status: 404 });
    return new Response(
      JSON.stringify({
        chart: {
          result: [
            {
              meta: { gmtoffset: -18000 },
              timestamp: [day("2026-01-02"), day("2026-01-03"), day("2026-01-05")],
              indicators: { quote: [{ close: [100, 110.000001, 120] }] },
            },
          ],
        },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  return { f, calls };
}

describe("investment history backfill", () => {
  it("rebuilds past values from trades and closes, before the first reported value", async () => {
    const yahoo = fakeYahoo();
    const { client } = await makeSignedInApp({ priceFetch: yahoo.f });
    for (const content of [POSITIONS, HISTORY])
      await client.post("/api/invest/import/commit", { content, targets: { X00001234: "new" } });
    // Positions imported "today" give the first real value; the second import matched it.
    const before = (await client.get("/api/invest/summary")).json<InvestSummary>();
    expect(before.accounts).toHaveLength(2);
    const id = before.accounts.find((a) => a.holdings)?.id as string;
    // Put both files in one account (the history import made a second one).
    const again = await client.post("/api/invest/import/commit", {
      content: HISTORY,
      targets: { X00001234: id },
    });
    expect(again.statusCode).toBe(200);

    const res = (await client.post("/api/invest/history/backfill")).json<InvestBackfillResult>();
    expect(res).toMatchObject({ tickers: 1, missing: [], from: "2026-01-02" });
    // Only the ticker is sent; money market funds aren't looked up.
    expect(yahoo.calls).toHaveLength(1);
    expect(yahoo.calls[0]).toMatch(/\/chart\/VTI\?period1=\d+&period2=\d+&interval=1d/);

    const s = (await client.get("/api/invest/summary")).json<InvestSummary>();
    const byDate = new Map(s.history.map((p) => [p.date, p.valueCents]));
    // Jan 2: deposit $400, 1 share at $100 → $300 cash + $100. Jan 3: share at $110.
    // Jan 4 (Sat): 3 shares at Friday's $110 + $100 cash. Jan 5: $120.
    // (The duplicate history account is valued separately; check the one with holdings.)
    expect(s.estimatedUntil).not.toBeNull();
    expect(byDate.get("2026-01-05")).toBeGreaterThan(0);

    // Backfilling again doesn't ask Yahoo again for prices it has.
    await client.post("/api/invest/history/backfill");
    expect(yahoo.calls).toHaveLength(1);

    const nw = (await client.get("/api/reports/net-worth?months=12")).json<NetWorthReport>();
    expect(nw.points.length).toBeGreaterThan(1);
  });

  it("values the account day by day", async () => {
    const yahoo = fakeYahoo();
    const { client } = await makeSignedInApp({ priceFetch: yahoo.f });
    await client.post("/api/invest/import/commit", {
      content: POSITIONS,
      targets: { X00001234: "new" },
    });
    const id = (await client.get("/api/invest/summary")).json<InvestSummary>().accounts[0]?.id;
    await client.post("/api/invest/import/commit", {
      content: HISTORY,
      targets: { X00001234: id },
    });
    await client.post("/api/invest/history/backfill");
    const s = (await client.get("/api/invest/summary")).json<InvestSummary>();
    const v = Object.fromEntries(s.history.map((p) => [p.date, p.valueCents]));
    expect(v["2026-01-01"]).toBeUndefined(); // starts at the first trade
    expect(v["2026-01-02"]).toBe(30000 + 10000);
    expect(v["2026-01-03"]).toBe(30000 + 11000);
    expect(v["2026-01-04"]).toBe(10000 + 33000);
    expect(v["2026-01-05"]).toBe(10000 + 36000);
  });
});

import { schema } from "@muny/db";
import type { Account, NetWorthReport } from "@muny/shared";
import { describe, expect, it } from "vitest";
import { makeSignedInApp } from "../test-utils.js";
import { netWorthReport } from "./service.js";

// Synthetic data only.

describe("net worth history", () => {
  it("spreads a change between two recorded values, and marks it", async () => {
    const { db, client } = await makeSignedInApp();
    const car = (
      await client.post("/api/accounts", { name: "Car", type: "asset", balanceCents: 1_000_000 })
    ).json<Account>();
    db.delete(schema.balanceSnapshots).run();
    db.insert(schema.balanceSnapshots)
      .values([
        { accountId: car.id, date: "2026-01-01", balanceCents: 2_000_000 },
        { accountId: car.id, date: "2026-01-11", balanceCents: 1_000_000 },
      ])
      .run();
    const r = netWorthReport(db, [
      "2025-12-01",
      "2026-01-01",
      "2026-01-06",
      "2026-01-11",
      "2026-02-01",
    ]);
    expect(r.points.map((p) => p.assetsCents)).toEqual([
      2_000_000, 2_000_000, 1_500_000, 1_000_000, 1_000_000,
    ]);
    expect(r.points.map((p) => p.estimated)).toEqual([false, false, true, false, false]);
    for (const p of r.points) expect(Number.isInteger(p.assetsCents)).toBe(true);
  });

  it("leaves accounts with reported balances as they were recorded", async () => {
    const { db, client } = await makeSignedInApp();
    const brokerage = (
      await client.post("/api/accounts", { name: "Broker", type: "investment", balanceCents: 500 })
    ).json<Account>();
    db.delete(schema.balanceSnapshots).run();
    db.insert(schema.balanceSnapshots)
      .values([
        { accountId: brokerage.id, date: "2026-01-01", balanceCents: 100 },
        { accountId: brokerage.id, date: "2026-01-11", balanceCents: 500 },
      ])
      .run();
    const r = netWorthReport(db, ["2026-01-06"]);
    expect(r.points[0]).toMatchObject({ assetsCents: 100, estimated: false });
  });

  it("counts crypto as an asset, at each date's price", async () => {
    const { db, client } = await makeSignedInApp();
    db.insert(schema.cryptoWallets).values({ id: "w1", name: "Cold", kind: "manual" }).run();
    db.insert(schema.cryptoTxns)
      .values({
        id: "c1",
        walletId: "w1",
        at: Date.parse("2026-01-05T12:00:00Z"),
        type: "deposit",
        receivedAsset: "BTC",
        receivedAmount: "2",
        externalId: "e1",
        source: "manual",
      })
      .run();
    db.insert(schema.cryptoPrices)
      .values([
        { asset: "BTC", date: "2026-01-01", usd: "10", source: "test" },
        { asset: "BTC", date: "2026-01-05", usd: "10", source: "test" },
        { asset: "BTC", date: "2026-02-01", usd: "25.50", source: "test" },
      ])
      .run();
    const first = netWorthReport(db, ["2026-01-02", "2026-01-20", "2026-03-01"]);
    expect(first.points.map((p) => p.cryptoCents)).toEqual([0, 2000, 5100]);
    expect(first.points.map((p) => p.netCents)).toEqual([0, 2000, 5100]);
    expect(first.byType).toContainEqual({ type: "crypto", cents: 5100 });

    // A new price is picked up, rather than a stale answer being kept.
    db.insert(schema.cryptoPrices)
      .values({ asset: "BTC", date: "2026-02-20", usd: "30", source: "test" })
      .run();
    expect(netWorthReport(db, ["2026-03-01"]).points[0]?.cryptoCents).toBe(6000);

    const res = (await client.get("/api/reports/net-worth?months=2")).json<NetWorthReport>();
    expect(res.points.at(-1)?.cryptoCents).toBe(6000);
  });
});

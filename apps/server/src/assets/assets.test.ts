import type { Account, Asset, LoansReport, NetWorthReport } from "@muny/shared";
import { describe, expect, it } from "vitest";
import { makeSignedInApp } from "../test-utils.js";

// Synthetic data only.

describe("assets", () => {
  it("tracks a home's value, its history, and equity after the mortgage", async () => {
    const { client } = await makeSignedInApp();
    const home = (
      await client.post("/api/assets", {
        name: "Home",
        kind: "home",
        valueCents: 40_000_000,
        purchasePriceCents: 35_000_000,
        purchaseDate: "2024-06-01",
      })
    ).json<{ accountId: string }>();
    const loan = (
      await client.post("/api/accounts", {
        name: "Mortgage",
        type: "loan",
        balanceCents: -32_000_000,
      })
    ).json<Account>();
    await client.patch(`/api/loans/${loan.id}`, {
      kind: "mortgage",
      propertyAccountId: home.accountId,
    });

    const assets = (await client.get("/api/assets")).json<Asset[]>();
    expect(assets[0]).toMatchObject({
      kind: "home",
      valueCents: 40_000_000,
      equityCents: 8_000_000,
    });
    expect(assets[0]?.history.map((h) => h.valueCents)).toEqual([35_000_000, 40_000_000]);
    expect(assets[0]?.loans).toEqual([
      { accountId: loan.id, name: "Mortgage", balanceCents: 32_000_000 },
    ]);

    const l = (await client.get("/api/loans")).json<LoansReport>().loans[0];
    expect(l?.property).toMatchObject({
      name: "Home",
      valueCents: 40_000_000,
      equityCents: 8_000_000,
    });
    expect(l?.property?.loanToValuePct).toBeCloseTo(80);

    await client.patch(`/api/assets/${home.accountId}`, { valueCents: 41_000_000 });
    const nw = (await client.get("/api/reports/net-worth?months=1")).json<NetWorthReport>();
    expect(nw.byType.find((b) => b.type === "asset")?.cents).toBe(41_000_000);
  });
});

describe("assets without a loan", () => {
  it("takes what's owed by hand, and paid off means full equity", async () => {
    const { client } = await makeSignedInApp();
    const car = (
      await client.post("/api/assets", { name: "Car", kind: "vehicle", valueCents: 1_500_000 })
    ).json<{ accountId: string }>();
    await client.patch(`/api/assets/${car.accountId}`, { owedCents: 400_000 });
    let a = (await client.get("/api/assets")).json<Asset[]>()[0];
    expect(a).toMatchObject({ owedCents: 400_000, equityCents: 1_100_000 });
    await client.patch(`/api/assets/${car.accountId}`, { owedCents: 0 });
    a = (await client.get("/api/assets")).json<Asset[]>()[0];
    expect(a).toMatchObject({ owedCents: 0, equityCents: 1_500_000 });
  });
});

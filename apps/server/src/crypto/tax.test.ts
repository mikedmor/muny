import { schema } from "@muny/db";
import type { CryptoTaxReport, CryptoWallet } from "@muny/shared";
import { describe, expect, it } from "vitest";
import { makeSignedInApp } from "../test-utils.js";

// Synthetic history; no prices needed (values are on the rows).
describe("tax report", () => {
  it("gives the range's flows, the year's gains by term, and holdings by term", async () => {
    const { client, db } = await makeSignedInApp();
    const w = (
      await client.post("/api/crypto/wallets", { name: "W", kind: "manual" })
    ).json<CryptoWallet>();
    const row = (id: string, at: number, v: Record<string, unknown>) =>
      db
        .insert(schema.cryptoTxns)
        .values({
          id,
          walletId: w.id,
          at,
          externalId: `x:${id}`,
          source: "import",
          type: "deposit",
          ...v,
        } as never)
        .run();
    row("buy1", Date.UTC(2023, 0, 10), {
      type: "trade",
      sentAsset: "USD",
      sentAmount: "100",
      receivedAsset: "BTC",
      receivedAmount: "1",
      valueCents: 10_000,
    });
    row("buy2", Date.UTC(2025, 2, 1), {
      type: "trade",
      sentAsset: "USD",
      sentAmount: "300",
      receivedAsset: "BTC",
      receivedAmount: "1",
      valueCents: 30_000,
    });
    row("rew", Date.UTC(2025, 3, 1), {
      label: "staking",
      receivedAsset: "ADA",
      receivedAmount: "10",
      valueCents: 500,
    });
    row("sell", Date.UTC(2025, 5, 1), {
      type: "trade",
      sentAsset: "BTC",
      sentAmount: "1",
      receivedAsset: "USD",
      receivedAmount: "500",
      valueCents: 50_000,
    });
    const r = (
      await client.get("/api/crypto/tax?from=2025-01-01&to=2025-12-31")
    ).json<CryptoTaxReport>();
    expect(r.year).toBe(2025);
    // The 2023 coin went first (FIFO) and was held over a year: long term.
    expect(r.realized.long.profitCents).toBe(40_000);
    expect(r.realized.short).toEqual({ profitCents: 0, lossCents: 0 });
    expect(r.summary).toMatchObject({ incomeCents: 500, realizedCents: 40_000 });
    const btc = r.assets.find((a) => a.asset === "BTC");
    expect(btc?.lots).toEqual([
      expect.objectContaining({ amount: "1", costCents: 30_000, acquiredAt: Date.UTC(2025, 2, 1) }),
    ]);
    expect(r.maturity).toHaveLength(13);
  });
});

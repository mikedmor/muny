import { describe, expect, it } from "vitest";
import { type CostTxn, fifoCostBasis } from "./costbasis.js";

const tx = (p: Partial<CostTxn>): CostTxn => ({
  at: 0,
  type: "deposit",
  sentAsset: null,
  sentAmount: null,
  receivedAsset: null,
  receivedAmount: null,
  feeAsset: null,
  feeAmount: null,
  valueCents: null,
  paired: false,
  ...p,
});
const opts = { skip: new Set(["USD"]), valueAt: () => null };

describe("FIFO cost basis", () => {
  it("disposes oldest lots first and keeps the remaining cost", () => {
    const r = fifoCostBasis(
      [
        tx({
          at: 1,
          type: "trade",
          sentAsset: "USD",
          sentAmount: "100",
          receivedAsset: "ETH",
          receivedAmount: "1",
          valueCents: 10_000,
        }),
        tx({
          at: 2,
          type: "trade",
          sentAsset: "USD",
          sentAmount: "300",
          receivedAsset: "ETH",
          receivedAmount: "1",
          valueCents: 30_000,
        }),
        // Sell 1.5 ETH: all of lot 1 and half of lot 2 go.
        tx({
          at: 3,
          type: "trade",
          sentAsset: "ETH",
          sentAmount: "1.5",
          receivedAsset: "USD",
          receivedAmount: "500",
          valueCents: 50_000,
        }),
      ],
      opts,
    ).get("ETH");
    expect(r).toEqual({ amount: 500_000_000_000_000_000n, costCents: 15_000, missing: false });
  });

  it("ignores moves between own wallets, counts fees and income", () => {
    const r = fifoCostBasis(
      [
        tx({ at: 1, receivedAsset: "ADA", receivedAmount: "100", valueCents: 5_000 }),
        // To my other wallet: no change in the pool, but the fee is spent.
        tx({
          at: 2,
          type: "transfer",
          sentAsset: "ADA",
          sentAmount: "100",
          feeAsset: "ADA",
          feeAmount: "1",
          paired: true,
        }),
        tx({ at: 2, type: "transfer", receivedAsset: "ADA", receivedAmount: "100", paired: true }),
        // A staking reward: income, its cost is its value when received.
        tx({ at: 3, receivedAsset: "ADA", receivedAmount: "2", valueCents: 100 }),
      ],
      opts,
    ).get("ADA");
    expect(r?.amount).toBe(101_000_000_000_000_000_000n);
    expect(r?.costCents).toBe(4_950 + 100);
  });

  it("uses the day's price when the transaction has no value, and flags unknown cost", () => {
    const valueAt = (asset: string, amount: string) =>
      asset === "BTC" ? Math.round(Number(amount) * 2_000_000) : null;
    const r = fifoCostBasis(
      [
        tx({ at: 1, receivedAsset: "BTC", receivedAmount: "0.5" }),
        tx({ at: 2, receivedAsset: "XYZ", receivedAmount: "10" }),
      ],
      { skip: new Set(), valueAt },
    );
    expect(r.get("BTC")).toMatchObject({ costCents: 1_000_000, missing: false });
    expect(r.get("XYZ")).toMatchObject({ costCents: 0, missing: true });
  });
});

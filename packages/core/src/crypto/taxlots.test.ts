import { describe, expect, it } from "vitest";
import { isLongTerm, type TaxTxn, taxLedger } from "./taxlots.js";

const D = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);
const base: Omit<TaxTxn, "at" | "type"> = {
  label: null,
  sentAsset: null,
  sentAmount: null,
  receivedAsset: null,
  receivedAmount: null,
  feeAsset: null,
  feeAmount: null,
  valueCents: null,
  paired: false,
};
const skip = new Set(["USD"]);
const noPrice = () => null;

describe("tax ledger", () => {
  it("splits a sale into short and long term by lot age (FIFO)", () => {
    const { gains, lots } = taxLedger(
      [
        {
          ...base,
          at: D(2023, 1, 1),
          type: "trade",
          sentAsset: "USD",
          sentAmount: "100",
          receivedAsset: "BTC",
          receivedAmount: "1",
          valueCents: 10_000,
        },
        {
          ...base,
          at: D(2024, 6, 1),
          type: "trade",
          sentAsset: "USD",
          sentAmount: "300",
          receivedAsset: "BTC",
          receivedAmount: "1",
          valueCents: 30_000,
        },
        // Sell 1.5 BTC for $600 on 2024-12-01: 1 from 2023 (long), 0.5 from 2024 (short).
        {
          ...base,
          at: D(2024, 12, 1),
          type: "trade",
          sentAsset: "BTC",
          sentAmount: "1.5",
          receivedAsset: "USD",
          receivedAmount: "600",
          valueCents: 60_000,
        },
      ],
      { skip, valueAt: noPrice },
    );
    expect(gains).toEqual([
      expect.objectContaining({
        term: "long",
        amount: "1",
        proceedsCents: 40_000,
        costCents: 10_000,
        gainCents: 30_000,
      }),
      expect.objectContaining({
        term: "short",
        amount: "0.5",
        proceedsCents: 20_000,
        costCents: 15_000,
        gainCents: 5_000,
      }),
    ]);
    const left = lots.get("BTC") ?? [];
    expect(left).toHaveLength(1);
    expect(left[0]?.cost).toBe(15_000n);
  });

  it("counts income, plain withdrawals leave without a gain, lost is a loss", () => {
    const { gains, flows } = taxLedger(
      [
        {
          ...base,
          at: D(2024, 1, 1),
          type: "deposit",
          label: "staking",
          receivedAsset: "ADA",
          receivedAmount: "100",
          valueCents: 5_000,
        },
        {
          ...base,
          at: D(2024, 2, 1),
          type: "withdrawal",
          sentAsset: "ADA",
          sentAmount: "40",
          valueCents: 2_400,
        },
        {
          ...base,
          at: D(2024, 3, 1),
          type: "withdrawal",
          label: "lost",
          sentAsset: "ADA",
          sentAmount: "60",
          valueCents: 3_000,
        },
      ],
      { skip, valueAt: noPrice },
    );
    expect(flows.map((f) => f.kind)).toEqual(["income", "out", "gift"]);
    expect(gains).toEqual([
      expect.objectContaining({
        kind: "lost",
        amount: "60",
        proceedsCents: 0,
        costCents: 3_000,
        gainCents: -3_000,
        term: "short",
      }),
    ]);
  });

  it("treats a fee as a small disposal, and transfers between own wallets as nothing", () => {
    const { gains, lots } = taxLedger(
      [
        {
          ...base,
          at: D(2024, 1, 1),
          type: "deposit",
          receivedAsset: "ETH",
          receivedAmount: "1",
          valueCents: 200_000,
        },
        {
          ...base,
          at: D(2024, 2, 1),
          type: "transfer",
          sentAsset: "ETH",
          sentAmount: "1",
          paired: true,
          feeAsset: "ETH",
          feeAmount: "0.01",
          feeValueCents: 3_000,
        },
      ],
      { skip, valueAt: noPrice },
    );
    expect(gains).toEqual([
      expect.objectContaining({
        kind: "fee",
        amount: "0.01",
        proceedsCents: 3_000,
        costCents: 2_000,
        gainCents: 1_000,
      }),
    ]);
    expect(lots.get("ETH")?.[0]?.amount).toBe(990_000_000_000_000_000n);
  });

  it("long term means more than a year", () => {
    expect(isLongTerm(D(2024, 1, 1), D(2025, 1, 1))).toBe(false);
    expect(isLongTerm(D(2024, 1, 1), D(2025, 1, 2))).toBe(true);
  });

  it("HIFO sells the costliest coins first; LIFO the newest", () => {
    const txns: TaxTxn[] = [
      {
        ...base,
        at: D(2021, 1, 1),
        type: "trade",
        sentAsset: "USD",
        sentAmount: "100",
        receivedAsset: "ETH",
        receivedAmount: "1",
        valueCents: 10_000,
      },
      {
        ...base,
        at: D(2021, 6, 1),
        type: "trade",
        sentAsset: "USD",
        sentAmount: "400",
        receivedAsset: "ETH",
        receivedAmount: "1",
        valueCents: 40_000,
      },
      {
        ...base,
        at: D(2022, 1, 1),
        type: "trade",
        sentAsset: "USD",
        sentAmount: "300",
        receivedAsset: "ETH",
        receivedAmount: "1",
        valueCents: 30_000,
      },
      {
        ...base,
        at: D(2022, 2, 1),
        type: "trade",
        sentAsset: "ETH",
        sentAmount: "1",
        receivedAsset: "USD",
        receivedAmount: "350",
        valueCents: 35_000,
      },
    ];
    const left = (method: "fifo" | "lifo" | "hifo") =>
      (taxLedger(txns, { skip, valueAt: noPrice, method }).lots.get("ETH") ?? []).map((l) =>
        Number(l.cost),
      );
    expect(left("fifo")).toEqual([40_000, 30_000]);
    expect(left("lifo")).toEqual([10_000, 40_000]);
    expect(left("hifo")).toEqual([10_000, 30_000]);
  });

  it("US rules: one pool until 2025, then each wallet keeps its own lots", () => {
    const US = Date.UTC(2025, 0, 1);
    const buyA = {
      ...base,
      at: D(2023, 1, 1),
      type: "trade" as const,
      walletId: "A",
      sentAsset: "USD",
      sentAmount: "1000",
      receivedAsset: "ETH",
      receivedAmount: "1",
      valueCents: 100_000,
    };
    const buyB = {
      ...base,
      at: D(2024, 1, 1),
      type: "trade" as const,
      walletId: "B",
      sentAsset: "USD",
      sentAmount: "3000",
      receivedAsset: "ETH",
      receivedAmount: "1",
      valueCents: 300_000,
    };
    const sellB = {
      ...base,
      at: D(2025, 6, 1),
      type: "trade" as const,
      walletId: "B",
      sentAsset: "ETH",
      sentAmount: "1",
      receivedAsset: "USD",
      receivedAmount: "2500",
      valueCents: 250_000,
    };
    // One pool (FIFO): selling from B uses the 2023 coin.
    expect(taxLedger([buyA, buyB, sellB], { skip, valueAt: noPrice }).gains[0]).toMatchObject({
      costCents: 100_000,
      gainCents: 150_000,
    });
    // Per wallet from 2025: B sells its own (2024) coin.
    expect(
      taxLedger([buyA, buyB, sellB], { skip, valueAt: noPrice, perWalletFrom: US }).gains[0],
    ).toMatchObject({ costCents: 300_000, gainCents: -50_000, term: "long" });

    // A transfer A → B carries A's lot; B then sells both coins.
    const out = {
      ...base,
      id: "o",
      pairId: "i",
      at: D(2025, 3, 1),
      type: "transfer" as const,
      walletId: "A",
      sentAsset: "ETH",
      sentAmount: "1",
      paired: true,
    };
    const inn = {
      ...base,
      id: "i",
      pairId: "o",
      at: D(2025, 3, 1),
      type: "transfer" as const,
      walletId: "B",
      receivedAsset: "ETH",
      receivedAmount: "1",
      paired: true,
    };
    const sell2 = { ...sellB, sentAmount: "2", receivedAmount: "5000", valueCents: 500_000 };
    const r = taxLedger([buyA, buyB, out, inn, sell2], {
      skip,
      valueAt: noPrice,
      perWalletFrom: US,
    });
    const total = r.gains.reduce((s, g) => s + g.costCents, 0);
    expect(total).toBe(400_000);
    expect(r.gains.every((g) => g.term === "long")).toBe(true);
    expect(r.lots.get("ETH") ?? []).toEqual([]);
  });
});

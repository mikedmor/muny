import { describe, expect, it } from "vitest";
import {
  estimateWashSales,
  type LotTxn,
  longTermDate,
  lotCostCents,
  lotKey,
  lotShares,
  runStockLots,
  termOn,
} from "./lots.js";

// Synthetic trades only.
let n = 0;
const tx = (
  date: string,
  type: string,
  quantity: string,
  amountCents: number,
  accountId = "brokerage",
  securityId = "XYZ",
): LotTxn => ({ id: `t${++n}`, accountId, securityId, date, type, quantity, amountCents });

describe("holding period", () => {
  it("is long term from the day after the first anniversary", () => {
    expect(longTermDate("2025-03-10")).toBe("2026-03-11");
    expect(termOn("2025-03-10", "2026-03-10")).toBe("short");
    expect(termOn("2025-03-10", "2026-03-11")).toBe("long");
    expect(termOn(null, "2026-03-11")).toBe("unknown");
    // Bought on Feb 29: the anniversary is Mar 1 in a non-leap year.
    expect(longTermDate("2024-02-29")).toBe("2025-03-02");
  });
});

describe("stock lots", () => {
  it("sells the oldest shares first, one line per holding period", () => {
    const r = runStockLots([
      tx("2024-01-10", "buy", "10", -100_000), // $100 each, long term by the sale
      tx("2025-11-01", "buy", "10", -150_000), // $150 each, short term
      tx("2026-02-01", "sell", "15", 240_000), // $160 each
    ]);
    expect(r.disposals).toHaveLength(2);
    const [short, long] = r.disposals;
    expect(short).toMatchObject({ term: "short", acquired: "2025-11-01", costCents: 75_000 });
    expect(lotShares(short?.q ?? 0n)).toBe("5");
    expect(long).toMatchObject({ term: "long", acquired: "2024-01-10", costCents: 100_000 });
    // Proceeds split by shares: 5/15 and 10/15 of $2,400.
    expect(short?.proceedsCents).toBe(80_000);
    expect(long?.proceedsCents).toBe(160_000);
    const left = r.open.get(lotKey("brokerage", "XYZ")) ?? [];
    expect(left.map((l) => [l.acquired, lotShares(l.q), lotCostCents(l)])).toEqual([
      ["2025-11-01", "5", 75_000],
    ]);
  });

  it("splits grow every lot and keep its date and cost", () => {
    const r = runStockLots([
      tx("2024-01-10", "buy", "10", -100_000),
      tx("2025-01-10", "buy", "5", -100_000),
      tx("2025-06-01", "split", "15", 0), // 2-for-1
    ]);
    const lots = r.open.get(lotKey("brokerage", "XYZ")) ?? [];
    expect(lots.map((l) => [l.acquired, lotShares(l.q), lotCostCents(l)])).toEqual([
      ["2024-01-10", "20", 100_000],
      ["2025-01-10", "10", 100_000],
    ]);
  });

  it("marks shares with no history as unknown and keeps accounts apart", () => {
    const r = runStockLots([
      tx("2025-01-02", "transfer_in", "4", 0),
      tx("2025-01-05", "buy", "2", -20_000, "ira"),
      tx("2025-03-01", "sell", "6", 60_000),
    ]);
    // 4 transferred in (unknown cost and date), 2 more than the history explains.
    expect(r.disposals).toHaveLength(1);
    expect(r.disposals[0]).toMatchObject({
      term: "unknown",
      costCents: null,
      accountId: "brokerage",
    });
    expect(lotShares(r.open.get(lotKey("ira", "XYZ"))?.[0]?.q ?? 0n)).toBe("2");
  });

  it("estimates wash sales across accounts, once per replacement share", () => {
    const buyOld = tx("2025-06-01", "buy", "10", -100_000);
    const sell = tx("2025-12-01", "sell", "10", 70_000); // $300 loss
    const buyIra = tx("2025-12-15", "buy", "4", -28_000, "ira");
    const r = runStockLots([buyOld, sell, buyIra]);
    const w = estimateWashSales(
      r.disposals,
      [buyOld, buyIra].map((b) => ({ ...b, txnId: b.id, quantity: b.quantity as string })),
    );
    // 4 of the 10 shares were bought back within 30 days: 4/10 of the loss.
    expect(w.cents).toEqual([12_000]);
    expect(w.replacementAccount).toEqual(["ira"]);

    // A gain is never a wash sale, and the sold shares don't replace themselves.
    const r2 = runStockLots([
      tx("2025-11-20", "buy", "10", -100_000),
      tx("2025-12-01", "sell", "10", 70_000),
    ]);
    const buys = [
      {
        txnId: `t${n - 1}`,
        accountId: "brokerage",
        securityId: "XYZ",
        date: "2025-11-20",
        quantity: "10",
      },
    ];
    expect(estimateWashSales(r2.disposals, buys).cents).toEqual([0]);
  });
});

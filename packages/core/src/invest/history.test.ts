import { describe, expect, it } from "vitest";
import { reconstructValues } from "./history.js";

const prices = (m: Record<string, Record<string, string>>) =>
  new Map(Object.entries(m).map(([k, v]) => [k, new Map(Object.entries(v))]));

describe("reconstructValues", () => {
  it("undoes trades walking back and values each day at its close", () => {
    const v = reconstructValues({
      holdings: [{ securityId: "VTI", quantity: "3" }],
      cashCents: 1000,
      txns: [
        {
          date: "2026-01-02",
          type: "deposit",
          securityId: null,
          quantity: null,
          amountCents: 31000,
        },
        { date: "2026-01-02", type: "buy", securityId: "VTI", quantity: "1", amountCents: -10000 },
        { date: "2026-01-04", type: "buy", securityId: "VTI", quantity: "2", amountCents: -20000 },
      ],
      prices: prices({ VTI: { "2026-01-02": "100", "2026-01-03": "110", "2026-01-05": "120" } }),
      from: "2026-01-01",
      to: "2026-01-05",
    });
    expect(v).toEqual([
      { date: "2026-01-01", valueCents: 0 }, // before the deposit
      { date: "2026-01-02", valueCents: 21000 + 10000 }, // 1 share at 100 + cash
      { date: "2026-01-03", valueCents: 21000 + 11000 },
      { date: "2026-01-04", valueCents: 1000 + 33000 }, // 3 shares, Saturday: Friday's close
      { date: "2026-01-05", valueCents: 1000 + 36000 },
    ]);
  });

  it("counts shares in today's units across a split (closes are split-adjusted)", () => {
    // Bought 1 share at $200, then a 2-for-1 split: 2 shares today; adjusted closes halve old prices.
    const v = reconstructValues({
      holdings: [{ securityId: "X", quantity: "2" }],
      cashCents: 0,
      txns: [
        { date: "2026-02-01", type: "buy", securityId: "X", quantity: "1", amountCents: -20000 },
        { date: "2026-02-03", type: "split", securityId: "X", quantity: "1", amountCents: 0 },
      ],
      prices: prices({ X: { "2026-02-01": "100", "2026-02-02": "105", "2026-02-03": "110" } }),
      from: "2026-01-31",
      to: "2026-02-03",
    });
    // The day before the buy, its $200 was still cash.
    expect(v.map((p) => p.valueCents)).toEqual([20000, 20000, 21000, 22000]);
  });

  it("keeps shares held from before the history starts", () => {
    const v = reconstructValues({
      holdings: [{ securityId: "A", quantity: "5" }],
      cashCents: 0,
      txns: [
        { date: "2026-03-02", type: "sell", securityId: "A", quantity: "2", amountCents: 2000 },
      ],
      prices: prices({ A: { "2026-03-01": "10" } }),
      from: "2026-03-01",
      to: "2026-03-02",
    });
    // 7 shares before the sale (none of them bought within the history); cash never goes below 0.
    expect(v).toEqual([
      { date: "2026-03-01", valueCents: 7000 },
      { date: "2026-03-02", valueCents: 5000 },
    ]);
  });
});

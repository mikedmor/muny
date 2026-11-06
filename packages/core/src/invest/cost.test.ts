import { describe, expect, it } from "vitest";
import { fifoCost, sameShares } from "./cost.js";

describe("fifoCost", () => {
  it("keeps the cost of what's left after selling the oldest shares", () => {
    expect(
      fifoCost([
        { date: "2026-01-01", type: "buy", quantity: "10", amountCents: -10000 },
        { date: "2026-02-01", type: "buy", quantity: "10", amountCents: -20000 },
        { date: "2026-03-01", type: "sell", quantity: "15", amountCents: 30000 },
        { date: "2026-03-02", type: "dividend", quantity: null, amountCents: 100 },
      ]),
    ).toEqual({ quantity: "5", costCents: 10000 });
  });

  it("adds split shares at no cost", () => {
    expect(
      fifoCost([
        { date: "2026-01-01", type: "buy", quantity: "1", amountCents: -20000 },
        { date: "2026-02-01", type: "split", quantity: "1", amountCents: 0 },
      ]),
    ).toEqual({ quantity: "2", costCents: 20000 });
  });

  it("gives up when shares arrived with no cost or history is missing", () => {
    expect(
      fifoCost([{ date: "2026-01-01", type: "transfer_in", quantity: "5", amountCents: 0 }]),
    ).toBeNull();
    expect(
      fifoCost([{ date: "2026-01-01", type: "sell", quantity: "5", amountCents: 500 }]),
    ).toBeNull();
  });

  it("compares share counts with a little tolerance", () => {
    expect(sameShares("10.00001", "10")).toBe(true);
    expect(sameShares("9.5", "10")).toBe(false);
  });
});

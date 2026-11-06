import { describe, expect, it } from "vitest";
import {
  currentPlan,
  extraNeeded,
  orderLoans,
  type PlanLoan,
  simulatePlan,
} from "./payoff-plan.js";

// Synthetic loans.
const loans: PlanLoan[] = [
  {
    id: "card",
    name: "Card",
    balanceCents: 300_000,
    aprBps: 2000,
    paymentCents: 10_000,
    minimumCents: 10_000,
  },
  {
    id: "car",
    name: "Car",
    balanceCents: 100_000,
    aprBps: 500,
    paymentCents: 20_000,
    minimumCents: 10_000,
  },
];

describe("payoff plan", () => {
  it("orders by rate or by balance", () => {
    expect(orderLoans(loans, "avalanche")).toEqual(["card", "car"]);
    expect(orderLoans(loans, "snowball")).toEqual(["car", "card"]);
    expect(orderLoans(loans, "custom", ["car"])).toEqual(["car", "card"]);
  });

  it("rolls a paid-off loan's payment into the next and beats paying as now", () => {
    const now = currentPlan(loans);
    const plan = simulatePlan(loans, { extraCents: 0, order: ["card", "car"] });
    expect(plan.months).not.toBeNull();
    expect(plan.months ?? 0).toBeLessThan(now.months ?? 0);
    expect(plan.totalInterestCents).toBeLessThan(now.totalInterestCents);
    // The car is paid off on its own payment; then its $200 goes to the card.
    expect(plan.payoffMonth.car).toBe(now.payoffMonth.car);
  });

  it("moves payments above the minimum to the priority loan", () => {
    const keep = simulatePlan(loans, { extraCents: 0, order: ["card", "car"] });
    const moved = simulatePlan(loans, {
      extraCents: 0,
      order: ["card", "car"],
      minimumsOnly: true,
    });
    expect(moved.firstPayment).toEqual({ card: 20_000, car: 10_000 });
    expect(moved.totalInterestCents).toBeLessThan(keep.totalInterestCents);
  });

  it("finds the extra needed to finish by a date", () => {
    const extra = extraNeeded(loans, 12, { order: ["card", "car"] });
    expect(extra).not.toBeNull();
    expect(
      simulatePlan(loans, { extraCents: extra ?? 0, order: ["card", "car"] }).months,
    ).toBeLessThanOrEqual(12);
    expect(
      simulatePlan(loans, { extraCents: (extra ?? 0) - 100, order: ["card", "car"] }).months,
    ).toBeGreaterThan(12);
  });
});

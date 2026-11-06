import { describe, expect, it } from "vitest";
import { amortizedPayment, applyPayments, payoff, splitBackward } from "./loan-math.js";

describe("applyPayments", () => {
  it("covers interest first, then principal", () => {
    // $10,000 at 7.30% (0.02% a day): 30 days' interest is $60.
    const r = applyPayments(1_000_000, 730, "2026-01-01", [
      { date: "2026-01-31", amountCents: 50_000 },
      { date: "2026-03-02", amountCents: 50_000 },
    ]);
    expect(r.payments[0]).toMatchObject({ interestCents: 6000, principalCents: 44_000 });
    expect(r.payments[0]?.balanceAfterCents).toBe(956_000);
    // 30 days on $9,560: $57.36.
    expect(r.payments[1]).toMatchObject({ interestCents: 5736, principalCents: 44_264 });
    expect(r.balanceCents).toBe(911_736);
    expect(r.interestPaidCents).toBe(11_736);
  });

  it("adds unpaid interest when a payment doesn't cover it, and ignores earlier payments", () => {
    const r = applyPayments(1_000_000, 730, "2026-01-01", [
      { date: "2025-12-15", amountCents: 50_000 },
      { date: "2026-01-31", amountCents: 1000 },
    ]);
    expect(r.payments).toHaveLength(1);
    expect(r.balanceCents).toBe(1_005_000);
  });
});

describe("payoff", () => {
  it("counts months and interest, and pays off sooner with extra", () => {
    const base = payoff(1_000_000, 600, 30_000);
    const extra = payoff(1_000_000, 600, 30_000, 10_000);
    expect(base.months).toBe(37);
    expect(extra.months).toBeLessThan(base.months as number);
    expect(extra.totalInterestCents).toBeLessThan(base.totalInterestCents);
    expect(base.balances[0]).toBe(1_000_000);
    expect(base.balances.at(-1)).toBe(0);
  });

  it("never ends when the payment doesn't cover the interest", () => {
    expect(payoff(1_000_000, 1200, 5000).months).toBeNull();
  });
});

describe("amortizedPayment and splitBackward", () => {
  it("gives the standard 30-year payment", () => {
    // $332,500 at 6.13% over 30 years: $2,021.38.
    expect(amortizedPayment(33_250_000, 613, 360)).toBe(202_138);
    expect(amortizedPayment(12_000, 0, 12)).toBe(1000);
  });

  it("works interest and principal back from today's balance", () => {
    const [last, first] = splitBackward(1_000_000, 730, [
      { date: "2026-03-02", amountCents: 50_000 },
      { date: "2026-01-31", amountCents: 50_000 },
    ]);
    // 30 days at 7.30% on the balance before the newest payment.
    expect((last?.interestCents ?? 0) + (last?.principalCents ?? 0)).toBe(50_000);
    expect(last?.interestCents).toBeGreaterThan(6000);
    expect(first?.interestCents).toBeGreaterThan(last?.interestCents ?? 0);
  });
});

import type { CardStatement, CardsReport } from "@muny/shared";
import { describe, expect, it } from "vitest";
import { localToday } from "../lib/dates.js";
import { makeSignedInApp } from "../test-utils.js";
import { parseCardStatement } from "./service.js";

// Synthetic statement text and numbers only.

describe("credit card statements", () => {
  it("reads the standard labels in two common layouts", () => {
    const a = parseCardStatement(
      [
        "ACCOUNT SUMMARY Account Number: XXXX XXXX XXXX 4321",
        "Previous Balance $1,020.00",
        "Payment, Credits -$500.00",
        "New Balance $845.12",
        "Opening/Closing Date 09/14/26 - 10/13/26",
        "Credit Access Line $6,000",
        "PAYMENT INFORMATION",
        "New Balance $845.12",
        "Payment Due Date 11/10/26",
        "Minimum Payment Due $35.00",
        "Purchases 24.99%(v)(d) $12.34",
      ].join("\n"),
    );
    expect(a).toEqual({
      closingDate: "2026-10-13",
      dueDate: "2026-11-10",
      newBalanceCents: 84_512,
      minimumPaymentCents: 3_500,
      creditLimitCents: 600_000,
      aprBps: 2499,
      previousBalanceCents: 102_000,
      paymentsCents: 50_000,
    });
    const b = parseCardStatement(
      [
        "Statement Closing Date: October 20, 2026",
        "New Balance: $1,234.56",
        "Minimum Payment Due: $40.00",
        "Payment Due Date: Nov. 15, 2026",
        "Credit Limit: $10,000.00",
        "Annual Percentage Rate (APR) for Purchases 21.49%",
      ].join("\n"),
    );
    expect(b).toMatchObject({
      closingDate: "2026-10-20",
      dueDate: "2026-11-15",
      newBalanceCents: 123_456,
      creditLimitCents: 1_000_000,
      aprBps: 2149,
    });
    expect(parseCardStatement("Grocery list: eggs, milk")).toBeNull();
  });

  it("reports cards with limits, statements, payments and interest", async () => {
    const { client } = await makeSignedInApp();
    const card = (
      await client.post("/api/accounts", {
        name: "Visa",
        type: "credit",
        balanceCents: -50_000,
        mask: "4321",
      })
    ).json<{ id: string }>();
    const today = localToday();
    const add = (amountCents: number, description: string) =>
      client.post("/api/transactions", {
        accountId: card.id,
        postedDate: today,
        amountCents,
        description,
      });
    await add(-2_500, "CORNER CAFE");
    await add(-1_234, "PURCHASE INTEREST CHARGE");
    await add(20_000, "ONLINE PAYMENT THANK YOU");
    const statement: CardStatement = {
      closingDate: "2026-01-01",
      dueDate: "2099-01-25",
      newBalanceCents: 40_000,
      minimumPaymentCents: 2_500,
      creditLimitCents: 200_000,
      aprBps: 2299,
      previousBalanceCents: null,
      paymentsCents: null,
    };
    expect(
      (await client.post("/api/cards/statements/apply", { accountId: card.id, statement }))
        .statusCode,
    ).toBe(200);
    const r = (await client.get("/api/cards")).json<CardsReport>();
    const c = r.cards[0];
    expect(c).toMatchObject({
      creditLimitCents: 200_000,
      aprBps: 2299,
      minimumPaymentCents: 2_500,
      dueDate: "2099-01-25",
      source: "statement",
      interestThisYearCents: 1_234,
    });
    expect(c?.payments.map((p) => p.amountCents)).toEqual([20_000]);
    expect(c?.utilizationPct).toBeCloseTo((c?.balanceCents ?? 0) / 2000, 5);
    expect(r.nextDue).toMatchObject({ date: "2099-01-25", amountCents: 2_500 });

    // An older statement doesn't replace the newer one.
    await client.post("/api/cards/statements/apply", {
      accountId: card.id,
      statement: { ...statement, closingDate: "2025-12-01", aprBps: 1999 },
    });
    expect((await client.get("/api/cards")).json<CardsReport>().cards[0]?.aprBps).toBe(2299);

    // Typed in.
    await client.patch(`/api/cards/${card.id}`, { creditLimitCents: 300_000 });
    expect((await client.get("/api/cards")).json<CardsReport>().cards[0]?.creditLimitCents).toBe(
      300_000,
    );
  });
});

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
    expect(a).toMatchObject({
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

  it("reads a statement laid out like a community bank's", () => {
    const s = parseCardStatement(
      [
        "Summary of Account Activity",
        "Account Ending In 9999",
        "Previous Balance 1,200.00",
        "Payments 150.00",
        "Interest Charged 12.34",
        "New Balance 1,062.34",
        "Statement Open/Close Date 09/09/2026 - 10/08/2026",
        "Credit Limit 5,000.00",
        "Payment Information",
        "New Balance 1,062.34",
        "Payment Due Date AUTO PAY ENABLED 11/05/2026",
        "Minimum Payment Due 35.00",
        "Only the Minimum Payment 10 years 2,000.00",
        "Type of Balance Ending Balance APR",
        "Purchases 1,062.34 12.50% (v) 1,100.00 12.34",
        "Payments and Credits",
        "09/28 09/28 Automatic Payment - Thank You F650900M600CHGDDA 150.00-",
        "Interest Charged",
        "10/08 10/08 Interest Charge On Purchases 12.34",
        "Total Interest For This Period 12.34",
        "2026 Total Year-To-Date",
        "Total Interest charged in 2026 98.76",
      ].join("\n"),
    );
    expect(s).toMatchObject({
      closingDate: "2026-10-08",
      dueDate: "2026-11-05",
      newBalanceCents: 106_234,
      minimumPaymentCents: 3_500,
      creditLimitCents: 500_000,
      aprBps: 1250,
      interestYtd: { year: 2026, cents: 9_876 },
      minimumOnly: { months: 120, totalCents: 200_000 },
    });
    expect(s?.transactions).toEqual([
      { date: "2026-09-28", description: "Automatic Payment - Thank You", amountCents: 15_000 },
      { date: "2026-10-08", description: "Interest Charge On Purchases", amountCents: -1_234 },
    ]);
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
      interestYtd: { year: Number(localToday().slice(0, 4)), cents: 99_999 },
      minimumOnly: { months: 168, totalCents: 500_000 },
      transactions: [
        { date: localToday(), description: "PURCHASE INTEREST CHARGE", amountCents: -1_234 },
        { date: localToday(), description: "NEW STORE", amountCents: -4_500 },
      ],
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
      interestThisYearCents: 99_999,
      minimumOnly: { months: 168, totalCents: 500_000 },
    });
    // The statement's transactions were added, except one already there.
    const txns = (await client.get(`/api/transactions?accountId=${card.id}&limit=50`)).json<{
      items: { amountCents: number }[];
    }>().items;
    expect(txns.filter((x) => x.amountCents === -1_234)).toHaveLength(1);
    expect(txns.some((x) => x.amountCents === -4_500)).toBe(true);
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

  it("tells two cards' payments apart by amount, day and paying account", async () => {
    const { client } = await makeSignedInApp();
    const acct = async (name: string, type: string) =>
      (await client.post("/api/accounts", { name, type })).json<{ id: string }>().id;
    const a = await acct("Card A", "credit");
    const b = await acct("Card B", "credit");
    const x = await acct("Checking X", "checking");
    const y = await acct("Checking Y", "checking");
    const pay = (accountId: string, postedDate: string, amountCents: number) =>
      client.post("/api/transactions", {
        accountId,
        postedDate,
        amountCents,
        description: "SAMEBANK CARD PYMT",
      });
    const m = localToday().slice(0, 8);
    await pay(x, `${m}05`, -25_000);
    await pay(y, `${m}20`, -31_245);
    await client.patch(`/api/cards/${a}`, {
      paymentMatch: "SAMEBANK CARD",
      paymentAmountCents: 25_000,
      paymentFromAccountId: x,
    });
    await client.patch(`/api/cards/${b}`, {
      paymentMatch: "SAMEBANK CARD",
      paymentDay: 20,
    });
    const r = (await client.get("/api/cards")).json<CardsReport>();
    const paid = (id: string) =>
      r.cards.find((c) => c.accountId === id)?.payments.map((p) => p.amountCents);
    expect(paid(a)).toEqual([25_000]);
    expect(paid(b)).toEqual([31_245]);
  });

  it("anchors a hand-added card to its statement, so statement transactions don't double-count", async () => {
    const { client } = await makeSignedInApp();
    // Added by hand with what was owed at the time.
    const card = (
      await client.post("/api/accounts", { name: "Card", type: "credit", balanceCents: -9_010 })
    ).json<{ id: string }>();
    const chk = (await client.post("/api/accounts", { name: "Checking", type: "checking" })).json<{
      id: string;
    }>();
    const statement: CardStatement = {
      closingDate: "2026-10-04",
      dueDate: "2026-11-01",
      newBalanceCents: 9_010,
      minimumPaymentCents: 2_500,
      creditLimitCents: 100_000,
      aprBps: 1650,
      previousBalanceCents: 2_120,
      paymentsCents: 2_120,
      interestYtd: null,
      minimumOnly: null,
      transactions: [
        { date: "2026-09-20", description: "PAYMENT THANK YOU", amountCents: 2_120 },
        { date: "2026-09-25", description: "SHOP", amountCents: -9_010 },
      ],
    };
    await client.post("/api/cards/statements/apply", { accountId: card.id, statement });
    const owed = async () =>
      (await client.get("/api/cards"))
        .json<CardsReport>()
        .cards.find((c) => c.accountId === card.id)?.balanceCents;
    expect(await owed()).toBe(9_010);

    // A payment from checking after the statement: owed drops before the next statement.
    await client.post("/api/transactions", {
      accountId: chk.id,
      postedDate: "2026-11-01",
      amountCents: -5_000,
      description: "CARD PYMT 9999",
    });
    await client.patch(`/api/cards/${card.id}`, { paymentMatch: "CARD PYMT" });
    expect(await owed()).toBe(4_010);
  });
});

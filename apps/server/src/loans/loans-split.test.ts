import { schema } from "@muny/db";
import type { Account, LoansReport } from "@muny/shared";
import { describe, expect, it } from "vitest";
import { localToday } from "../lib/dates.js";
import { makeSignedInApp } from "../test-utils.js";
import { refreshManualLoans } from "./service.js";

// Synthetic data only.

const daysAgo = (n: number) => {
  const d = new Date(`${localToday()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

async function setup() {
  const ctx = await makeSignedInApp();
  const chk = (
    await ctx.client.post("/api/accounts", { name: "Main Checking", type: "checking" })
  ).json<Account>();
  const pay = (date: string, amountCents: number, description: string) =>
    ctx.client.post("/api/transactions", {
      accountId: chk.id,
      postedDate: date,
      amountCents,
      description,
    });
  const loans = async () => (await ctx.client.get("/api/loans")).json<LoansReport>().loans;
  return { ...ctx, chk, pay, loans };
}

describe("loans: shared and filtered payments", () => {
  it("tells loans apart by payment amount, leaving the yearly dues out", async () => {
    const { client, pay, loans } = await setup();
    for (const n of [60, 30]) {
      await pay(daysAgo(n), -20_000, "SEAVIEW RESORTS MTG");
      await pay(daysAgo(n), -35_000, "SEAVIEW RESORTS MTG");
    }
    await pay(daysAgo(40), -120_000, "SEAVIEW RESORTS MTG"); // yearly dues
    for (const [name, amount] of [
      ["Seaview A", 20_000],
      ["Seaview B", 35_000],
    ] as const)
      await client.post("/api/loans", {
        name,
        startBalanceCents: 1_000_000,
        startDate: daysAgo(90),
        aprBps: 0,
        paymentMatch: "SEAVIEW RESORTS",
        paymentAmountCents: amount,
      });
    const list = await loans();
    expect(list.find((l) => l.name === "Seaview A")?.balanceCents).toBe(1_000_000 - 40_000);
    expect(list.find((l) => l.name === "Seaview B")?.balanceCents).toBe(1_000_000 - 70_000);
    expect(list.find((l) => l.name === "Seaview A")?.payments[0]?.fromAccountName).toBe(
      "Main Checking",
    );
  });

  it("splits one payment across loans by their monthly payments", async () => {
    const { client, pay, loans } = await setup();
    await pay(daysAgo(30), -40_000, "NELNET STUDENT LN");
    for (const [name, monthly] of [
      ["Nelnet 1", 10_000],
      ["Nelnet 2", 30_000],
    ] as const)
      await client.post("/api/loans", {
        name,
        kind: "student",
        startBalanceCents: 500_000,
        startDate: daysAgo(90),
        aprBps: 0,
        monthlyPaymentCents: monthly,
        paymentMatch: "nelnet",
      });
    const list = await loans();
    const one = list.find((l) => l.name === "Nelnet 1");
    expect(one?.payments[0]).toMatchObject({ amountCents: 10_000, totalCents: 40_000 });
    expect(one?.sharedWith).toEqual(["Nelnet 2"]);
    expect(list.find((l) => l.name === "Nelnet 2")?.balanceCents).toBe(500_000 - 30_000);
  });
});

describe("loans: mortgages and synced loans", () => {
  it("splits escrow off, estimates the interest, and dates mortgage insurance", async () => {
    const { client, db, pay, loans } = await setup();
    const loan = (
      await client.post("/api/accounts", {
        name: "Mortgage",
        type: "loan",
        balanceCents: -32_400_000,
      })
    ).json<Account>();
    for (const n of [90, 60, 30]) await pay(daysAgo(n), -274_090, "CITIZENS MTG");
    await client.patch(`/api/loans/${loan.id}`, {
      kind: "mortgage",
      aprBps: 613,
      originalPrincipalCents: 33_250_000,
      termMonths: 360,
      originalValueCents: 35_000_000,
      pmiMonthlyCents: 4795,
      paymentMatch: "citizens",
      // A start balance on a loan whose balance comes from elsewhere is ignored only when synced;
      // this one is manual, so leave it out.
    });
    const m = (await loans())[0];
    expect(m?.principalInterestCents).toBe(202_138);
    expect(m?.escrowCents).toBe(274_090 - 202_138);
    expect(m?.payments[0]).toMatchObject({ escrowCents: 274_090 - 202_138 });
    // No start balance: the split is worked back from today's balance.
    expect(m?.splitEstimated).toBe(true);
    expect((m?.payments[0]?.interestCents ?? 0) + (m?.payments[0]?.principalCents ?? 0)).toBe(
      202_138,
    );
    expect(m?.pmi?.equityPct).toBeCloseTo(7.43, 1);
    expect(m?.pmi?.requestDate).not.toBeNull();
    expect((m?.pmi?.autoEndDate ?? "") > (m?.pmi?.requestDate ?? "")).toBe(true);
    expect(db.select().from(schema.loanDetails).all()).toHaveLength(1);
  });

  it("repairs synced loans saved as tracked-from-payments", async () => {
    const { db, client } = await setup();
    const loan = (
      await client.post("/api/accounts", { name: "Apollo", type: "loan", balanceCents: -854_381 })
    ).json<Account>();
    // Pretend it's synced and was saved the old way.
    const connId = "conn-plaid-1";
    db.insert(schema.connections).values({ id: connId, provider: "plaid" }).run();
    db.update(schema.accounts)
      .set({ connectionId: connId })
      .where((await import("drizzle-orm")).eq(schema.accounts.id, loan.id))
      .run();
    db.insert(schema.loanDetails)
      .values({
        accountId: loan.id,
        source: "manual",
        startBalanceCents: 1,
        startDate: "2026-01-01",
      })
      .run();
    refreshManualLoans(db);
    const d = db.select().from(schema.loanDetails).all()[0];
    expect(d).toMatchObject({ source: "plaid", startBalanceCents: null, startDate: null });
  });
});

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

describe("loans: telling similar payments apart by due day", () => {
  it("gives each payment to the loan whose amount and due day fit best", async () => {
    const { client, pay, loans } = await setup();
    for (const m of [3, 2, 1]) {
      const d = new Date(`${localToday()}T00:00:00Z`);
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() - m);
      const ym = d.toISOString().slice(0, 7);
      await pay(`${ym}-05`, -17_180, "SEAVIEW RESORTS MTG");
      await pay(`${ym}-17`, -17_331, "SEAVIEW RESORTS MTG");
    }
    const due = (day: string) => {
      const d = new Date(`${localToday()}T00:00:00Z`);
      d.setUTCMonth(d.getUTCMonth() + 1);
      return `${d.toISOString().slice(0, 7)}-${day}`;
    };
    for (const [name, amount, day] of [
      ["Seaview 1", 17_180, "04"],
      ["Seaview 2", 17_331, "16"],
    ] as const)
      await client.post("/api/loans", {
        name,
        lender: "Seaview",
        startBalanceCents: 1_000_000,
        startDate: daysAgo(400),
        aprBps: 0,
        paymentMatch: "seaview",
        paymentAmountCents: amount,
        nextDueDate: due(day),
      });
    const list = await loans();
    const one = list.find((l) => l.name === "Seaview 1");
    const two = list.find((l) => l.name === "Seaview 2");
    expect(one?.payments.map((p) => p.date.slice(8))).toEqual(["05", "05", "05"]);
    expect(two?.payments.map((p) => p.date.slice(8))).toEqual(["17", "17", "17"]);
  });

  it("keeps earlier payments after the payment amount changes", async () => {
    const { client, pay, loans } = await setup();
    await pay(daysAgo(70), -20_000, "SEAVIEW RESORTS MTG");
    await pay(daysAgo(40), -20_000, "SEAVIEW RESORTS MTG");
    await pay(daysAgo(10), -21_000, "SEAVIEW RESORTS MTG"); // the payment went up
    await pay(daysAgo(50), -230_000, "SEAVIEW RESORTS MTG"); // yearly maintenance fee
    const { accountId } = (
      await client.post("/api/loans", {
        name: "Seaview",
        startBalanceCents: 1_000_000,
        startDate: daysAgo(90),
        aprBps: 0,
        paymentMatch: "SEAVIEW RESORTS",
        paymentAmountCents: 20_000,
      })
    ).json<{ accountId: string }>();
    await client.patch(`/api/loans/${accountId}`, { paymentAmountCents: 21_000 });
    const loan = (await loans()).find((l) => l.name === "Seaview");
    expect(loan?.pastPaymentAmounts).toEqual([20_000]);
    expect(loan?.payments.map((p) => p.amountCents)).toEqual([21_000, 20_000, 20_000]);
    expect(loan?.balanceCents).toBe(1_000_000 - 61_000);
  });

  it("keeps a lender's yearly fee out of its loans and lists it once for the lender", async () => {
    const { client, pay, loans } = await setup();
    await pay(daysAgo(40), -20_000, "SEAVIEW RESORTS MTG");
    await pay(daysAgo(50), -230_000, "SEAVIEW RESORTS MTG"); // fee under the loans' words
    await pay(daysAgo(400), -215_000, "SEAVIEW CLUB DUES"); // last year's, other words
    for (const name of ["Seaview 1", "Seaview 2"])
      await client.post("/api/loans", {
        name,
        lender: "Seaview",
        startBalanceCents: 1_000_000,
        startDate: daysAgo(90),
        aprBps: 0,
        monthlyPaymentCents: 10_000,
        paymentMatch: "SEAVIEW RESORTS",
      });
    const before = await loans();
    expect(before.find((l) => l.name === "Seaview 1")?.payments).toHaveLength(2);

    const due = daysAgo(-30);
    expect(
      (
        await client.put("/api/loans/lender-fees", {
          lender: " seaview ",
          minCents: 200_000,
          nextDueDate: due,
        })
      ).statusCode,
    ).toBe(200);
    const report = (await client.get("/api/loans")).json<LoansReport>();
    // The fee is no longer a loan payment (the two loans share the $200 one).
    expect(report.loans.find((l) => l.name === "Seaview 1")?.payments).toHaveLength(1);
    expect(report.lenderFees).toHaveLength(1);
    expect(report.lenderFees[0]).toMatchObject({ lenderKey: "seaview", expectedDate: due });
    expect(report.lenderFees[0]?.fees.map((x) => x.amountCents)).toEqual([230_000]);

    // Its own words: last year's dues are found instead.
    await client.put("/api/loans/lender-fees", {
      lender: "Seaview",
      minCents: 200_000,
      paymentMatch: "CLUB DUES",
    });
    const fee = (await client.get("/api/loans")).json<LoansReport>().lenderFees[0];
    expect(fee?.fees.map((x) => x.amountCents)).toEqual([215_000]);
    // No due date entered: about a year after the last one.
    const yearOn = new Date(`${daysAgo(400)}T00:00:00Z`);
    yearOn.setUTCMonth(yearOn.getUTCMonth() + 12);
    expect(fee?.expectedDate).toBe(yearOn.toISOString().slice(0, 10));

    expect((await client.delete("/api/loans/lender-fees?lender=Seaview")).statusCode).toBe(200);
    expect((await client.get("/api/loans")).json<LoansReport>().lenderFees).toEqual([]);
  });

  it("estimates interest on payments before the as-of date", async () => {
    const { client, pay, loans } = await setup();
    await pay(daysAgo(40), -24_305, "SEAVIEW RESORTS MTG");
    await pay(daysAgo(10), -24_305, "SEAVIEW RESORTS MTG");
    await client.post("/api/loans", {
      name: "Seaview",
      startBalanceCents: 1_125_873,
      startDate: localToday(),
      aprBps: 1399,
      paymentMatch: "SEAVIEW RESORTS",
    });
    const loan = (await loans()).find((l) => l.name === "Seaview");
    expect(loan?.balanceCents).toBe(1_125_873);
    expect(loan?.payments.every((p) => (p.interestCents ?? 0) > 10_000)).toBe(true);
    expect(loan?.splitEstimated).toBe(true);
  });
});

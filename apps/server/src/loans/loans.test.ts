import type { Account, LoansReport, NetWorthReport } from "@muny/shared";
import { describe, expect, it } from "vitest";
import { localToday } from "../lib/dates.js";
import { makeSignedInApp } from "../test-utils.js";

// Synthetic data only.

const daysAgo = (n: number) => {
  const d = new Date(`${localToday()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

describe("loans", () => {
  it("works a manual loan's balance down from the payments it finds", async () => {
    const { client } = await makeSignedInApp();
    const chk = (
      await client.post("/api/accounts", { name: "Checking", type: "checking" })
    ).json<Account>();
    const pay = (date: string, amountCents: number, description: string) =>
      client.post("/api/transactions", {
        accountId: chk.id,
        postedDate: date,
        amountCents,
        description,
      });
    await pay(daysAgo(65), -50_000, "SEAVIEW RESORTS MTG PPD"); // before the start: ignored
    await pay(daysAgo(30), -50_000, "SEAVIEW RESORTS MTG PPD");
    await pay(daysAgo(25), -4_000, "COFFEE");

    const created = await client.post("/api/loans", {
      name: "Seaview Resorts",
      lender: "Seaview",
      kind: "personal",
      startBalanceCents: 1_000_000,
      startDate: daysAgo(60),
      aprBps: 730,
      monthlyPaymentCents: 50_000,
      paymentMatch: "seaview resorts",
    });
    expect(created.statusCode).toBe(200);

    let r = (await client.get("/api/loans")).json<LoansReport>();
    const loan = r.loans[0];
    // 30 days at 7.30% on $10,000 is $60 of interest; $440 came off the balance.
    expect(loan).toMatchObject({ source: "manual", balanceCents: 956_000, aprBps: 730 });
    // The earlier payment is history: listed, but before the start, so it doesn't change the balance.
    expect(loan?.payments).toHaveLength(2);
    expect(loan?.payments[1]).toMatchObject({ interestCents: null, principalCents: null });
    expect(loan?.payments[0]).toMatchObject({ interestCents: 6000, principalCents: 44_000 });
    expect(loan?.payoffMonths).toBeGreaterThan(12);
    expect(r.totalOwedCents).toBe(956_000);
    expect(r.monthlyPaymentsCents).toBe(50_000);

    // Net worth sees the loan as a debt.
    const nw = (await client.get("/api/reports/net-worth?months=1")).json<NetWorthReport>();
    expect(nw.byType.find((b) => b.type === "loan")?.cents).toBe(-956_000);

    // Changing the rate re-works the balance.
    await client.patch(`/api/loans/${loan?.accountId}`, { aprBps: 0 });
    r = (await client.get("/api/loans")).json<LoansReport>();
    expect(r.loans[0]?.balanceCents).toBe(950_000);

    const bad = await client.patch(`/api/loans/${chk.id}`, { aprBps: 100 });
    expect(bad.statusCode).toBe(404);
  });

  it("shows synced loans with details you add", async () => {
    const { client } = await makeSignedInApp();
    const loan = (
      await client.post("/api/accounts", {
        name: "Mortgage",
        type: "loan",
        institutionName: "Citizens Bank",
        balanceCents: -20_000_000,
      })
    ).json<Account>();
    await client.patch(`/api/loans/${loan.id}`, {
      kind: "mortgage",
      aprBps: 600,
      monthlyPaymentCents: 150_000,
      originalPrincipalCents: 25_000_000,
    });
    const r = (await client.get("/api/loans")).json<LoansReport>();
    expect(r.loans[0]).toMatchObject({
      kind: "mortgage",
      balanceCents: 20_000_000,
      paidOffPct: 20,
    });
    expect(r.loans[0]?.payoffDate).not.toBeNull();
  });
});

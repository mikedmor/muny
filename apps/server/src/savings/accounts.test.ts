import type { Account, SavingsAccountsReport } from "@muny/shared";
import { describe, expect, it } from "vitest";
import { localToday } from "../lib/dates.js";
import { makeSignedInApp } from "../test-utils.js";

// Synthetic data only.

const monthsAgo = (n: number, day = 15) => {
  const d = new Date(`${localToday()}T00:00:00Z`);
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - n);
  d.setUTCDate(day);
  return d.toISOString().slice(0, 10);
};

describe("savings accounts", () => {
  it("reports balances, interest, the earned rate and monthly saving", async () => {
    const { client } = await makeSignedInApp();
    const acc = (
      await client.post("/api/accounts", {
        name: "High Yield Savings",
        type: "savings",
        institutionName: "Online Bank",
      })
    ).json<Account>();
    const add = (postedDate: string, amountCents: number, description: string) =>
      client.post("/api/transactions", { accountId: acc.id, postedDate, amountCents, description });
    await add(monthsAgo(6, 2), 1_000_000, "TRANSFER FROM CHECKING");
    for (let m = 5; m >= 1; m--) {
      await add(monthsAgo(m, 2), 50_000, "TRANSFER FROM CHECKING");
      await add(monthsAgo(m, 28), 4_000, "INTEREST PAID");
    }
    await add(monthsAgo(1, 10), -20_000, "TRANSFER TO CHECKING");
    // A checking account's interest doesn't count.
    const chk = (
      await client.post("/api/accounts", { name: "Checking", type: "checking" })
    ).json<Account>();
    await client.post("/api/transactions", {
      accountId: chk.id,
      postedDate: monthsAgo(1),
      amountCents: 100,
      description: "INTEREST PAID",
    });

    const r = (await client.get("/api/savings/accounts")).json<SavingsAccountsReport>();
    expect(r.accounts).toHaveLength(1);
    const a = r.accounts[0];
    expect(a?.balanceCents).toBe(1_000_000 + 5 * 50_000 + 5 * 4_000 - 20_000);
    expect(a?.interest.last12Cents).toBe(20_000);
    expect(a?.interest.allTimeCents).toBe(20_000);
    expect(a?.months).toHaveLength(24);
    // Interest isn't counted as money added.
    const last = a?.months.find((m) => m.month === monthsAgo(1).slice(0, 7));
    expect(last).toMatchObject({
      interestCents: 4_000,
      depositsCents: 50_000,
      withdrawalsCents: -20_000,
    });
    // About $40/month on roughly $11,500: a bit over 4% a year.
    expect(a?.earnedApyBps).toBeGreaterThan(300);
    expect(a?.earnedApyBps).toBeLessThan(500);
    expect(r.blendedApyBps).toBe(a?.earnedApyBps);

    // An entered APY wins for the blended rate.
    expect(
      (await client.put(`/api/savings/accounts/${acc.id}/apy`, { apyBps: 435 })).statusCode,
    ).toBe(200);
    const r2 = (await client.get("/api/savings/accounts")).json<SavingsAccountsReport>();
    expect(r2.accounts[0]?.apyBps).toBe(435);
    expect(r2.blendedApyBps).toBe(435);
    // Only savings accounts take an APY.
    expect(
      (await client.put(`/api/savings/accounts/${chk.id}/apy`, { apyBps: 100 })).statusCode,
    ).toBe(404);
  });
});

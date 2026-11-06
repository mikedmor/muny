import type { Account, CategoryGroup, SavingsBuckets, TransactionPage } from "@muny/shared";
import { describe, expect, it } from "vitest";
import { localToday } from "../lib/dates.js";
import { makeSignedInApp } from "../test-utils.js";
import { markCategoryMoves } from "./buckets.js";

// Synthetic data only.

describe("savings categories", () => {
  it("follows each category's moves from the balance you entered", async () => {
    const { client, db } = await makeSignedInApp();
    const acc = (
      await client.post("/api/accounts", {
        name: "Cash Account",
        type: "savings",
        balanceCents: 500_000,
      })
    ).json<Account>();
    const add = (postedDate: string, amountCents: number, description: string) =>
      client.post("/api/transactions", { accountId: acc.id, postedDate, amountCents, description });
    await add("2026-01-05", -1_000, "Old Boat Withdrawal CASH_CATEGORY");
    await add("2026-01-06", 2_000, "Trip Deposit CASH_CATEGORY");

    // Before setup: names to suggest.
    let b = (await client.get(`/api/savings/accounts/${acc.id}/buckets`)).json<SavingsBuckets>();
    expect(b.suggestions.sort()).toEqual(["Old Boat", "Trip"]);

    b = (
      await client.put(`/api/savings/accounts/${acc.id}/buckets`, {
        buckets: [
          { name: "Trip", balanceCents: 100_000, goalCents: 300_000 },
          { name: "Old Boat", balanceCents: 50_000 },
        ],
      })
    ).json<SavingsBuckets>();
    expect(b.unassignedCents).toBe(b.accountBalanceCents - 150_000);
    expect(b.suggestions).toEqual([]);

    // Moves after the balances were entered are followed.
    const tomorrow = new Date(`${localToday()}T00:00:00Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const t = tomorrow.toISOString().slice(0, 10);
    await add(t, 25_000, "Trip Deposit CASH_CATEGORY");
    await add(t, -5_000, "Old Boat Withdrawal CASH_CATEGORY");
    b = (await client.get(`/api/savings/accounts/${acc.id}/buckets`)).json<SavingsBuckets>();
    expect(b.buckets.map((x) => [x.name, x.balanceCents])).toEqual([
      ["Trip", 125_000],
      ["Old Boat", 45_000],
    ]);

    // Saving again without changing a balance keeps following from the first date.
    b = (
      await client.put(`/api/savings/accounts/${acc.id}/buckets`, {
        buckets: b.buckets.map((x) => ({ id: x.id, name: x.name, balanceCents: x.balanceCents })),
      })
    ).json<SavingsBuckets>();
    expect(b.buckets.find((x) => x.name === "Trip")?.balanceCents).toBe(125_000);

    // The moves are internal transfers, not spending or income.
    markCategoryMoves(db);
    const groups = (await client.get("/api/categories")).json<CategoryGroup[]>();
    const internal = groups
      .flatMap((g) => g.categories)
      .find((c) => c.name === "Internal Transfer")?.id;
    const list = (await client.get("/api/transactions?limit=50")).json<TransactionPage>().items;
    expect(list.every((x) => x.categoryId === internal)).toBe(true);
  });

  it("keeps the account's own cash first, with goals, monthly caps and a take-the-rest category", async () => {
    const { client } = await makeSignedInApp();
    const acc = (
      await client.post("/api/accounts", { name: "Cash", type: "savings", balanceCents: 414_667 })
    ).json<Account>();
    const b = (
      await client.put(`/api/savings/accounts/${acc.id}/buckets`, {
        buckets: [
          { name: "Cash", isMain: true, balanceCents: 0, goalCents: 100_000 },
          { name: "Rig", balanceCents: 313_201, goalCents: 700_000, monthlyCapCents: 25_000 },
          { name: "Car", balanceCents: 1_466, fillRemaining: true },
        ],
        mode: "moves",
      })
    ).json<SavingsBuckets>();
    expect(b.buckets.map((x) => [x.name, x.balanceCents, x.isMain, x.fillRemaining])).toEqual([
      ["Cash", 414_667 - 313_201 - 1_466, true, false],
      ["Rig", 313_201, false, false],
      ["Car", 1_466, false, true],
    ]);
    expect(b.unassignedCents).toBe(0);
    // $3,867.99 to go at $250 a month: 16 months.
    const months = (m: string) => {
      const [y, mo] = m.split("-").map(Number);
      return (y ?? 0) * 12 + (mo ?? 0);
    };
    const rig = b.buckets.find((x) => x.name === "Rig");
    expect(months(rig?.goalMonth ?? "0-0") - months(localToday().slice(0, 7))).toBe(16);
  });

  it("splits the total by the plan for banks that don't report category moves", async () => {
    const { client } = await makeSignedInApp();
    const acc = (
      await client.post("/api/accounts", {
        name: "Savings",
        type: "savings",
        balanceCents: 450_000,
      })
    ).json<Account>();
    const b = (
      await client.put(`/api/savings/accounts/${acc.id}/buckets`, {
        buckets: [
          { name: "Savings", isMain: true, balanceCents: 0, goalCents: 100_000 },
          { name: "Trip", balanceCents: 0, goalCents: 200_000 },
          { name: "Car", balanceCents: 0, fillRemaining: true },
        ],
      })
    ).json<SavingsBuckets>();
    expect(b.mode).toBe("split");
    expect(b.buckets.map((x) => [x.name, x.balanceCents])).toEqual([
      ["Savings", 100_000],
      ["Trip", 200_000],
      ["Car", 150_000],
    ]);
  });
});

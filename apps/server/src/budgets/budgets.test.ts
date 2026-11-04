import type { Account, BudgetLine, BudgetMonth, CategoryGroup, Transaction } from "@muny/shared";
import { describe, expect, it } from "vitest";
import { makeSignedInApp } from "../test-utils.js";

// Synthetic data only.

async function setup() {
  const ctx = await makeSignedInApp();
  const { client } = ctx;
  const groups = (await client.get("/api/categories")).json<CategoryGroup[]>();
  const cat = (name: string) =>
    groups.flatMap((g) => g.categories).find((c) => c.name === name)?.id as string;
  const acc = (
    await client.post("/api/accounts", { name: "Checking", type: "checking" })
  ).json<Account>();
  const add = async (
    postedDate: string,
    amountCents: number,
    category: string | null,
    extra: Record<string, unknown> = {},
  ) =>
    (
      await client.post("/api/transactions", {
        accountId: acc.id,
        postedDate,
        amountCents,
        description: `T ${postedDate} ${amountCents}`,
        categoryId: category ? cat(category) : null,
        ...extra,
      })
    ).json<Transaction>();
  return { ...ctx, cat, acc, add };
}

const lineOf = (m: BudgetMonth, name: string) =>
  m.groups.flatMap((g) => g.lines).find((l) => l.name === name) as BudgetLine;

describe("budgets", () => {
  it("tracks spending with refunds, splits and exclusions", async () => {
    const { client, cat, add, acc } = await setup();
    await add("2026-03-02", -6000, "Groceries");
    await add("2026-03-09", -4000, "Groceries");
    await add("2026-03-10", 1500, "Groceries"); // refund
    const split = await add("2026-03-11", -10000, null);
    await client.put(`/api/transactions/${split.id}/splits`, {
      splits: [
        { categoryId: cat("Groceries"), amountCents: -7000 },
        { categoryId: cat("Clothing"), amountCents: -3000 },
      ],
    });
    const hidden = await add("2026-03-12", -99900, "Groceries");
    await client.patch(`/api/transactions/${hidden.id}`, { hidden: true });
    await add("2026-03-15", 250000, "Paycheck");
    await add("2026-03-16", -50000, "Internal Transfer");
    await add("2026-03-20", -1234, null);

    const other = (
      await client.post("/api/accounts", { name: "Business", type: "checking" })
    ).json<Account>();
    await client.patch(`/api/accounts/${other.id}`, { excludeFromReports: true });
    await client.post("/api/transactions", {
      accountId: other.id,
      postedDate: "2026-03-05",
      amountCents: -77700,
      description: "biz",
      categoryId: cat("Groceries"),
    });
    expect(acc.id).toBeTruthy();

    const m = (await client.get("/api/budgets/2026-03")).json<BudgetMonth>();
    expect(lineOf(m, "Groceries")).toMatchObject({
      spentCents: 15500,
      budgetCents: null,
      availableCents: null,
    });
    expect(lineOf(m, "Clothing").spentCents).toBe(3000);
    expect(m.incomeCents).toBe(250000);
    expect(m.uncategorizedCents).toBe(1234);
    expect(m.total.spentCents).toBe(15500 + 3000 + 1234);
    expect(m.groups.some((g) => g.name === "Transfers" || g.name === "Income")).toBe(false);
  });

  it("budgets with rollover carry unspent and overspent amounts", async () => {
    const { client, cat, add } = await setup();
    await client.put("/api/budgets", {
      categoryId: cat("Dining & Drinks"),
      amountCents: 20000,
      rollover: true,
      fromMonth: "2026-01",
    });
    await add("2026-01-10", -15000, "Dining & Drinks"); // 50 under
    await add("2026-02-10", -26000, "Dining & Drinks"); // 60 over
    await add("2026-03-05", -5000, "Dining & Drinks");

    const mar = (await client.get("/api/budgets/2026-03")).json<BudgetMonth>();
    expect(lineOf(mar, "Dining & Drinks")).toMatchObject({
      budgetCents: 20000,
      rollover: true,
      rolloverCents: 5000 - 6000,
      spentCents: 5000,
      availableCents: 20000 - 1000 - 5000,
      averageCents: Math.round((15000 + 26000) / 3),
    });
    // Before the budget started: nothing.
    expect(
      lineOf((await client.get("/api/budgets/2025-12")).json<BudgetMonth>(), "Dining & Drinks")
        .budgetCents,
    ).toBeNull();
  });

  it("amount changes apply from their month on; total budget; delete", async () => {
    const { client, cat } = await setup();
    await client.put("/api/budgets", {
      categoryId: cat("Groceries"),
      amountCents: 50000,
      fromMonth: "2026-01",
    });
    const r = (
      await client.put("/api/budgets", {
        categoryId: cat("Groceries"),
        amountCents: 60000,
        fromMonth: "2026-03",
      })
    ).json<BudgetMonth>();
    expect(lineOf(r, "Groceries").budgetCents).toBe(60000);
    expect(
      lineOf((await client.get("/api/budgets/2026-02")).json<BudgetMonth>(), "Groceries")
        .budgetCents,
    ).toBe(50000);

    await client.put("/api/budgets", {
      categoryId: null,
      amountCents: 300000,
      fromMonth: "2026-03",
    });
    const m = (await client.get("/api/budgets/2026-03")).json<BudgetMonth>();
    expect(m.total.budgetCents).toBe(300000);
    expect(m.budgetedCents).toBe(60000);

    const id = lineOf(m, "Groceries").budgetId;
    expect((await client.delete(`/api/budgets/${id}`)).statusCode).toBe(200);
    expect(
      lineOf((await client.get("/api/budgets/2026-03")).json<BudgetMonth>(), "Groceries")
        .budgetCents,
    ).toBeNull();
  });

  it("validates input", async () => {
    const { client, cat } = await setup();
    expect((await client.get("/api/budgets/2026-13")).statusCode).toBe(400);
    expect(
      (await client.put("/api/budgets", { categoryId: cat("Paycheck"), amountCents: 100 }))
        .statusCode,
    ).toBe(400);
    expect(
      (await client.put("/api/budgets", { categoryId: cat("Groceries"), amountCents: -1 }))
        .statusCode,
    ).toBe(400);
  });
});

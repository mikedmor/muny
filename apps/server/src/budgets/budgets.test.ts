import { addInterval } from "@muny/core";
import type {
  Account,
  BudgetLine,
  BudgetMonth,
  CategoryActivity,
  CategoryGroup,
  Transaction,
  TransactionPage,
} from "@muny/shared";
import { describe, expect, it } from "vitest";
import { localToday } from "../lib/dates.js";
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

describe("budget forecast", () => {
  it("projects recurring income and bills for the rest of a month", async () => {
    const { client } = await setup();
    const today = localToday();
    const rows: string[] = ["Date,Description,Amount"];
    for (let i = 6; i >= 1; i--) {
      const d = addInterval(today, "monthly", -i).slice(0, 8);
      rows.push(`${d}05,STREAMCO SUBSCRIPTION,-12.00`, `${d}10,ACME CORP PAYROLL,2500.00`);
    }
    await client.post("/api/import/commit", {
      filename: "history.csv",
      content: rows.join("\n"),
      accountMap: { csv: "new" },
    });
    // Next month is all forecast: both should be scheduled.
    const next = addInterval(today, "monthly").slice(0, 7);
    const f = (await client.get(`/api/budgets/${next}`)).json<BudgetMonth>().forecast;
    expect(f.period).toBe("future");
    expect(f.scheduled.map((s) => [s.name, s.date, s.amountCents])).toEqual([
      ["Streamco Subscription", `${next}-05`, -1200],
      ["Acme Corp Payroll", `${next}-10`, 250_000],
    ]);
    expect(f).toMatchObject({
      incomeExpectedCents: 250_000,
      recurringDueCents: 1200,
      projectedIncomeCents: 250_000,
      projectedSpendingCents: 1200,
      projectedLeftoverCents: 248_800,
      scheduledByCategory: { "": 1200 },
    });
    // Last month is history: nothing scheduled, and the bill counts as paid.
    const last = addInterval(today, "monthly", -1).slice(0, 7);
    const p = (await client.get(`/api/budgets/${last}`)).json<BudgetMonth>().forecast;
    expect(p).toMatchObject({ period: "past", scheduled: [], recurringPaidCents: 1200 });
  });
});

describe("earnings and bills budgets", () => {
  it("keeps an earnings target and a bills budget apart from the total, and goes back to automatic", async () => {
    const { client, add } = await setup();
    const month = localToday().slice(0, 7);
    await add(`${month}-01`, 300_000, "Paycheck");
    await client.put("/api/budgets", { categoryId: null, amountCents: 250_000 }); // total spending
    await client.put("/api/budgets", { categoryId: null, kind: "income", amountCents: 700_000 });
    await client.put("/api/budgets", { categoryId: null, kind: "bills", amountCents: 75_000 });
    const b = (await client.get(`/api/budgets/${month}`)).json<BudgetMonth>();
    expect(b.total.budgetCents).toBe(250_000);
    expect(b.income).toMatchObject({
      kind: "income",
      budgetCents: 700_000,
      spentCents: 300_000,
      availableCents: 400_000,
    });
    expect(b.bills).toMatchObject({ kind: "bills", budgetCents: 75_000, spentCents: 0 });
    expect(b.income.historyCents).toHaveLength(3);

    // Removing the target makes it automatic again (no fixed amount).
    await client.delete(`/api/budgets/${b.income.budgetId}`);
    const after = (await client.get(`/api/budgets/${month}`)).json<BudgetMonth>();
    expect(after.income.budgetCents).toBeNull();
    expect(after.total.budgetCents).toBe(250_000);
    expect(
      (await client.put("/api/budgets", { categoryId: "x", kind: "income", amountCents: 1 }))
        .statusCode,
    ).toBe(400);
  });
});

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

describe("categories left out of budgets", () => {
  it("drops their spending from lines, totals and the list", async () => {
    const { client, cat, add } = await setup();
    await add("2026-04-02", -6000, "Groceries");
    await add("2026-04-03", -4500, "Clothing");
    const before = (await client.get("/api/budgets/2026-04")).json<BudgetMonth>();
    expect(before.total.spentCents).toBe(10_500);
    expect(before.excluded).toEqual([]);

    await client.patch(`/api/categories/${cat("Clothing")}`, { excludeFromBudget: true });
    const after = (await client.get("/api/budgets/2026-04")).json<BudgetMonth>();
    expect(after.total.spentCents).toBe(6000);
    expect(lineOf(after, "Clothing")).toBeUndefined();
    expect(after.excluded).toEqual([
      expect.objectContaining({ categoryId: cat("Clothing"), name: "Clothing", spentCents: 4500 }),
    ]);
    const groups = (await client.get("/api/categories")).json<CategoryGroup[]>();
    expect(
      groups.flatMap((g) => g.categories).find((c) => c.id === cat("Clothing"))?.excludeFromBudget,
    ).toBe(true);

    await client.patch(`/api/categories/${cat("Clothing")}`, { excludeFromBudget: false });
    expect((await client.get("/api/budgets/2026-04")).json<BudgetMonth>().total.spentCents).toBe(
      10_500,
    );
  });
});

describe("everything else", () => {
  it("is spending without a budget plus uncategorized, like the budget row", async () => {
    const { client, cat, add } = await setup();
    await client.put("/api/budgets", {
      categoryId: cat("Groceries"),
      amountCents: 50_000,
      fromMonth: "2026-05",
    });
    await add("2026-05-02", -6000, "Groceries");
    const clothes = await add("2026-05-03", -4500, "Clothing");
    const loose = await add("2026-05-04", -1200, null);
    const m = (await client.get("/api/budgets/2026-05")).json<BudgetMonth>();
    const budgeted = m.groups
      .flatMap((g) => g.lines)
      .filter((l) => l.budgetCents !== null)
      .reduce((s, l) => s + l.spentCents, 0);

    const a = (
      await client.get("/api/categories/everything-else/activity?month=2026-05&end=2026-05")
    ).json<CategoryActivity>();
    expect(a.stats.totalCents).toBe(m.total.spentCents - budgeted);
    expect(a.stats.totalCents).toBe(5700);
    expect(a.months.at(-1)).toEqual({ month: "2026-05", cents: 5700 });
    expect(a.categoryIds).toContain(cat("Clothing"));
    expect(a.categoryIds).not.toContain(cat("Groceries"));

    const ids = [...(a.categoryIds ?? []), "uncategorized"].join(",");
    const page = (
      await client.get(`/api/transactions?categoryIds=${ids}&from=2026-05-01&to=2026-05-31`)
    ).json<TransactionPage>();
    expect(page.items.map((t) => t.id).sort()).toEqual([clothes.id, loose.id].sort());
  });
});

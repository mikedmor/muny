import type {
  Account,
  CategoryGroup,
  MonthlyReport,
  NetWorthReport,
  Overview,
  SpendingReport,
} from "@muny/shared";
import { describe, expect, it } from "vitest";
import { localToday } from "../lib/dates.js";
import { makeSignedInApp } from "../test-utils.js";
import { cumulativeDailySpending, netWorthDates } from "./service.js";

// Synthetic data only.

async function setup() {
  const ctx = await makeSignedInApp();
  const { client } = ctx;
  const groups = (await client.get("/api/categories")).json<CategoryGroup[]>();
  const cat = (name: string) =>
    groups.flatMap((g) => g.categories).find((c) => c.name === name)?.id as string;
  const chk = (
    await client.post("/api/accounts", { name: "Checking", type: "checking", balanceCents: 100000 })
  ).json<Account>();
  const card = (
    await client.post("/api/accounts", { name: "Card", type: "credit" })
  ).json<Account>();
  const add = (
    accountId: string,
    postedDate: string,
    amountCents: number,
    description: string,
    category?: string,
  ) =>
    client.post("/api/transactions", {
      accountId,
      postedDate,
      amountCents,
      description,
      categoryId: category ? cat(category) : null,
    });
  return { ...ctx, cat, chk, card, add };
}

describe("reports", () => {
  it("breaks spending down by category, group and merchant", async () => {
    const { client, chk, card, add } = await setup();
    await add(card.id, "2026-04-02", -6000, "KROGER #12", "Groceries");
    await add(card.id, "2026-04-09", -4000, "KROGER #12", "Groceries");
    await add(card.id, "2026-04-10", -2500, "CORNER CAFE", "Coffee");
    await add(chk.id, "2026-04-11", 300000, "PAYROLL", "Paycheck");
    await add(chk.id, "2026-04-12", -12500, "CARD PAYMENT", "Credit Card Payment");
    await add(card.id, "2026-04-13", -999, "MYSTERY");
    await add(card.id, "2026-05-01", -7777, "KROGER #12", "Groceries");

    const range = "from=2026-04-01&to=2026-04-30";
    const byCat = (await client.get(`/api/reports/spending?${range}`)).json<SpendingReport>();
    expect(byCat.items.map((i) => [i.name, i.cents])).toEqual([
      ["Groceries", 10000],
      ["Coffee", 2500],
      ["Uncategorized", 999],
    ]);
    expect(byCat.totalCents).toBe(13499);
    const byGroup = (
      await client.get(`/api/reports/spending?${range}&by=group`)
    ).json<SpendingReport>();
    expect(byGroup.items[0]).toMatchObject({ name: "Food & Dining", cents: 12500 });
    const byMerchant = (
      await client.get(`/api/reports/spending?${range}&by=merchant`)
    ).json<SpendingReport>();
    expect(byMerchant.items[0]).toMatchObject({ name: "Kroger", cents: 10000, count: 2 });
    expect(
      (await client.get("/api/reports/spending?from=2026-05-01&to=2026-04-01")).statusCode,
    ).toBe(400);
  });

  it("monthly totals give cash flow and per-category trends", async () => {
    const { client, card, chk, add } = await setup();
    await add(chk.id, "2026-03-15", 200000, "PAY", "Paycheck");
    await add(card.id, "2026-03-20", -5000, "A", "Groceries");
    await add(card.id, "2026-04-20", -7000, "B", "Groceries");
    const r = (
      await client.get("/api/reports/monthly?from=2026-02&to=2026-04")
    ).json<MonthlyReport>();
    expect(r.months.map((m) => [m.month, m.incomeCents, m.spendingCents])).toEqual([
      ["2026-02", 0, 0],
      ["2026-03", 200000, 5000],
      ["2026-04", 0, 7000],
    ]);
    expect(Object.values(r.months[2]?.byCategory ?? {})).toEqual([7000]);
    expect(r.categories.some((c) => c.name === "Groceries")).toBe(true);
    expect(r.categories.some((c) => c.name === "Paycheck")).toBe(false);
  });

  it("net worth walks balances back through history", async () => {
    const { client, card, chk, add } = await setup();
    const today = localToday();
    // Checking opened with $1000; card spent $200 last month.
    await add(card.id, `${today.slice(0, 8)}01`, -20000, "TV", "Electronics");
    const house = (
      await client.post("/api/accounts", { name: "House", type: "asset", balanceCents: 30000000 })
    ).json<Account>();
    expect(house.id).toBeTruthy();
    const nw = (await client.get("/api/reports/net-worth?months=3")).json<NetWorthReport>();
    expect(nw.points).toHaveLength(4);
    const now = nw.points[nw.points.length - 1];
    expect(now).toMatchObject({
      assetsCents: 100000 + 30000000,
      debtsCents: 20000,
      netCents: 100000 + 30000000 - 20000,
    });
    // Before the card charge, no debt.
    expect(nw.points[0]?.debtsCents).toBe(0);
    expect(nw.byType.find((b) => b.type === "credit")?.cents).toBe(-20000);
    expect(chk.balanceCents).toBe(100000);
  });

  it("overview summarizes the month", async () => {
    const { client, card, add } = await setup();
    const today = localToday();
    await add(card.id, today, -4200, "CORNER CAFE");
    const o = (await client.get("/api/overview")).json<Overview>();
    expect(o).toMatchObject({
      today,
      spending: { monthToDateCents: 4200 },
      budget: null,
      attention: { uncategorized: 1, connectionsNeedingLogin: 0 },
    });
    expect(o.netWorth.nowCents).toBe(100000 - 4200);
    expect(o.topCategories[0]).toMatchObject({ name: "Uncategorized", cents: 4200 });
    const day = Number(today.slice(8));
    expect(o.spending.thisMonthDaily).toHaveLength(day);
    expect(o.spending.thisMonthDaily[day - 1]).toBe(4200);
    expect(o.spending.lastMonthDaily.length).toBeGreaterThanOrEqual(28);
    expect(o.spending.daysInMonth).toBeGreaterThanOrEqual(day);
    expect(o.topMerchants[0]).toMatchObject({ name: "Corner Cafe", cents: 4200, count: 1 });
    expect(o.cashFlow).toHaveLength(6);
    expect(o.cashFlow[5]).toMatchObject({ month: today.slice(0, 7), spendingCents: 4200 });
    // Checking opened with $1000 and nothing moved in it; the card isn't cash.
    expect(o.cashTrend).toHaveLength(27);
    expect(o.cashTrend[26]).toEqual({ date: today, cents: 100000 });
    expect(o.cashTrend[0]?.cents).toBe(100000);
  });

  it("daily spending runs up through the month, skipping income and transfers", async () => {
    const { db, card, chk, add } = await setup();
    await add(card.id, "2026-04-02", -6000, "KROGER", "Groceries");
    await add(card.id, "2026-04-02", -1000, "CAFE", "Coffee");
    await add(chk.id, "2026-04-03", 300000, "PAYROLL", "Paycheck");
    await add(card.id, "2026-04-04", 1500, "KROGER REFUND", "Groceries");
    await add(chk.id, "2026-04-04", -50000, "CARD PAYMENT", "Credit Card Payment");
    expect(cumulativeDailySpending(db, "2026-04-01", "2026-04-05")).toEqual([
      0, 7000, 7000, 5500, 5500,
    ]);
  });

  it("builds month-end dates", () => {
    expect(netWorthDates(2, "2026-03-15")).toEqual(["2026-01-31", "2026-02-28", "2026-03-15"]);
  });
});

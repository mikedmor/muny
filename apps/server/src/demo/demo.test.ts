import { schema } from "@muny/db";
import type {
  Account,
  BudgetMonth,
  CategoryGroup,
  LoansReport,
  RecurringSeries,
  SavingsOpportunities,
} from "@muny/shared";
import { describe, expect, it } from "vitest";
import { localToday } from "../lib/dates.js";
import { makeSignedInApp } from "../test-utils.js";
import { maybeSeedDemo } from "./seed.js";

describe("demo mode", () => {
  it("starts a fresh install with a made-up household", async () => {
    const { client } = await makeSignedInApp({ env: { MUNY_DEMO: "true" } });
    expect((await client.get("/api/demo")).json()).toEqual({ active: true });

    const accounts = (await client.get("/api/accounts")).json<Account[]>();
    expect(accounts.map((a) => [a.name, a.type]).sort()).toEqual([
      ["Everyday Checking", "checking"],
      ["Rainy Day Savings", "savings"],
      ["Sample Rewards Card", "credit"],
      ["Student Loan", "loan"],
    ]);
    const balance = (n: string) => accounts.find((a) => a.name === n)?.balanceCents;
    expect(balance("Everyday Checking")).toBe(624_018);
    expect(balance("Sample Rewards Card")).toBe(-84_233);

    const series = (await client.get("/api/recurring")).json<RecurringSeries[]>();
    const names = series.map((s) => s.name.toLowerCase());
    for (const n of ["streamflix", "sample property mgmt", "acme corp payroll", "dropbox"])
      expect(names.some((x) => x.includes(n))).toBe(true);
    expect(series.find((s) => /streamflix/i.test(s.name))?.priceChange).toMatchObject({
      fromCents: -1_399,
      toCents: -1_599,
    });

    const b = (await client.get(`/api/budgets/${localToday().slice(0, 7)}`)).json<BudgetMonth>();
    expect(b.home.budgetCents).toBe(165_000 + 13_000);
    expect((await client.get("/api/loans")).json<LoansReport>().loans).toHaveLength(1);

    const ways = (await client.get("/api/savings/opportunities")).json<SavingsOpportunities>();
    expect(ways.items.map((w) => w.kind)).toEqual(
      expect.arrayContaining(["price_increase", "diy", "overlap"]),
    );
  });

  it("starts clean on request, keeping people and settings, and doesn't refill", async () => {
    const { client, db } = await makeSignedInApp({ env: { MUNY_DEMO: "true" } });
    await client.put("/api/ai", { model: "kept-model" });
    expect((await client.post("/api/demo/clear", {})).statusCode).toBe(200);

    expect((await client.get("/api/accounts")).json<Account[]>()).toEqual([]);
    expect(db.select().from(schema.transactions).all()).toHaveLength(0);
    expect(db.select().from(schema.recurringSeries).all()).toHaveLength(0);
    expect(db.select().from(schema.users).all()).toHaveLength(1);
    // The default categories are back, ready to use.
    const groups = (await client.get("/api/categories")).json<CategoryGroup[]>();
    expect(groups.flatMap((g) => g.categories).some((c) => c.name === "Groceries")).toBe(true);
    expect((await client.get("/api/ai")).json<{ model: string }>().model).toBe("kept-model");
    expect((await client.get("/api/demo")).json()).toEqual({ active: false });
    // Restarting with MUNY_DEMO still set doesn't bring it back.
    expect(maybeSeedDemo(db, true)).toBe(false);
    expect((await client.post("/api/demo/clear", {})).statusCode).toBe(409);
  });

  it("does nothing without MUNY_DEMO", async () => {
    const { client } = await makeSignedInApp();
    expect((await client.get("/api/accounts")).json<Account[]>()).toEqual([]);
    expect((await client.get("/api/demo")).json()).toEqual({ active: false });
  });
});

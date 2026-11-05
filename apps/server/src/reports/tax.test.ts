import type { Account, CategoryGroup, TaxYear, Transaction } from "@muny/shared";
import { describe, expect, it } from "vitest";
import { makeSignedInApp } from "../test-utils.js";

// Synthetic data only.

describe("tax year summary", () => {
  it("totals income, tagged deductibles and the usual tax categories for one year", async () => {
    const { client } = await makeSignedInApp();
    const groups = (await client.get("/api/categories")).json<CategoryGroup[]>();
    const cat = (name: string) =>
      groups.flatMap((g) => g.categories).find((c) => c.name === name)?.id as string;
    const acc = (
      await client.post("/api/accounts", { name: "Checking", type: "checking" })
    ).json<Account>();
    const add = async (
      date: string,
      cents: number,
      desc: string,
      category: string,
      tags?: string[],
    ) => {
      const t = (
        await client.post("/api/transactions", {
          accountId: acc.id,
          postedDate: date,
          amountCents: cents,
          description: desc,
          categoryId: cat(category),
        })
      ).json<Transaction>();
      if (tags) await client.patch(`/api/transactions/${t.id}`, { tags });
      return t;
    };
    await add("2025-01-15", 300_000, "ACME PAYROLL", "Paycheck");
    await add("2025-02-01", -250_000, "MORTGAGE CO", "Rent & Mortgage");
    await add("2025-03-10", -5_000, "FOOD BANK", "Charitable Donations", ["tax-deductible"]);
    await add("2025-04-02", -12_000, "CLINIC", "Medical");
    await add("2025-04-15", -80_000, "STATE REVENUE", "Taxes");
    await add("2025-05-05", -3_000, "OFFICE SUPPLY", "General Merchandise", ["Tax-Deductible"]);
    await add("2026-01-15", 310_000, "ACME PAYROLL", "Paycheck"); // other year

    const t = (await client.get("/api/tax/2025")).json<TaxYear>();
    const total = (k: string) => t.sections.find((s) => s.key === k)?.totalCents;
    expect(total("income")).toBe(300_000);
    expect(total("deductible")).toBe(8_000);
    expect(total("mortgage")).toBe(250_000);
    expect(total("charity")).toBe(5_000);
    expect(total("medical")).toBe(12_000);
    expect(total("taxes")).toBe(80_000);
    expect(t.years).toEqual([2026, 2025]);
    expect(t.sections.find((s) => s.key === "deductible")?.items.map((i) => i.name)).toEqual([
      "Food Bank",
      "Office Supply",
    ]);

    const csv = await client.get("/api/tax/2025/export.csv");
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-disposition"]).toContain("muny-tax-2025.csv");
    expect(csv.body).toContain(
      "Tagged tax-deductible,2025-03-10,Food Bank,Charitable Donations,50.00",
    );
    expect((await client.get("/api/tax/1800")).statusCode).toBe(400);
  });
});

import { schema } from "@muny/db";
import type { Account, CategoryGroup, TransactionPage } from "@muny/shared";
import { eq, like } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { makeSignedInApp } from "../test-utils.js";

// Synthetic data only.

const csv = (rows: [string, string, string][]) =>
  ["Date,Description,Amount", ...rows.map((r) => r.join(","))].join("\n");

async function setup() {
  const ctx = await makeSignedInApp();
  const groups = (await ctx.client.get("/api/categories")).json<CategoryGroup[]>();
  const cat = (name: string) =>
    groups.flatMap((g) => g.categories).find((c) => c.name === name)?.id as string;
  const acc = (
    await ctx.client.post("/api/accounts", { name: "Card", type: "credit" })
  ).json<Account>();
  const importRows = (rows: [string, string, string][]) =>
    ctx.client.post("/api/import/commit", {
      filename: "card.csv",
      content: csv(rows),
      accountMap: { csv: acc.id },
    });
  const txns = async (q = "") =>
    (await ctx.client.get(`/api/transactions?limit=100${q}`)).json<TransactionPage>().items;
  return { ...ctx, cat, importRows, txns };
}

describe("merchant memory", () => {
  it("learns a merchant's category from your edit and applies it to new transactions", async () => {
    const { client, cat, importRows, txns } = await setup();
    await importRows([["2026-09-02", "CORNER BAKERY 123", "-8.50"]]);
    const [first] = await txns();
    await client.patch(`/api/transactions/${first?.id}`, { categoryId: cat("Coffee") });

    await importRows([["2026-10-03", "CORNER BAKERY 456", "-9.25"]]);
    const newer = (await txns()).find((t) => t.postedDate === "2026-10-03");
    expect(newer?.categoryName).toBe("Coffee");
  });

  it("uses a merchant's clear history, but not a mixed one", async () => {
    const { db, cat, importRows, txns } = await setup();
    await importRows([
      ["2026-07-01", "GREENGROCER", "-40.00"],
      ["2026-07-08", "GREENGROCER", "-41.00"],
      ["2026-07-15", "GREENGROCER", "-42.00"],
      ["2026-07-02", "MEGAMART", "-30.00"],
      ["2026-07-09", "MEGAMART", "-31.00"],
      ["2026-07-16", "MEGAMART", "-32.00"],
    ]);
    // History categorized without hand edits (like an imported Rocket Money history).
    const t = schema.transactions;
    db.update(t)
      .set({ categoryId: cat("Groceries") })
      .where(like(t.rawDescription, "GREENGROCER%"))
      .run();
    const mm = db.select({ id: t.id }).from(t).where(like(t.rawDescription, "MEGAMART%")).all();
    db.update(t)
      .set({ categoryId: cat("Groceries") })
      .where(eq(t.id, mm[0]?.id ?? ""))
      .run();
    db.update(t)
      .set({ categoryId: cat("Coffee") })
      .where(eq(t.id, mm[1]?.id ?? ""))
      .run();
    db.update(t)
      .set({ categoryId: cat("Clothing") })
      .where(eq(t.id, mm[2]?.id ?? ""))
      .run();

    await importRows([
      ["2026-08-01", "GREENGROCER", "-43.00"],
      ["2026-08-02", "MEGAMART", "-33.00"],
    ]);
    const aug = (await txns()).filter((x) => x.postedDate.startsWith("2026-08"));
    expect(aug.find((x) => x.description.toUpperCase().includes("GREENGROCER"))?.categoryName).toBe(
      "Groceries",
    );
    expect(
      aug.find((x) => x.description.toUpperCase().includes("MEGAMART"))?.categoryName,
    ).toBeNull();
  });

  it("never overrides a rule", async () => {
    const { client, cat, importRows, txns } = await setup();
    await importRows([["2026-09-02", "FUEL STOP", "-30.00"]]);
    const [first] = await txns();
    await client.patch(`/api/transactions/${first?.id}`, { categoryId: cat("Groceries") });
    await client.post("/api/rules", {
      name: "Fuel",
      match: "all",
      conditions: [{ field: "description", op: "contains", value: "FUEL" }],
      actions: [{ type: "setCategory", categoryId: cat("Coffee") }],
    });
    await importRows([["2026-10-02", "FUEL STOP", "-31.00"]]);
    const newer = (await txns()).find((t) => t.postedDate === "2026-10-02");
    expect(newer?.categoryName).toBe("Coffee");
  });
});

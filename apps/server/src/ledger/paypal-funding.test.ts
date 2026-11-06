import type { Account, CategoryGroup, TransactionPage } from "@muny/shared";
import { describe, expect, it } from "vitest";
import { makeSignedInApp } from "../test-utils.js";
import { pairPayPalFunding } from "./transfers.js";

// Synthetic data only.

describe("PayPal pass-through", () => {
  it("pairs the bank's PayPal withdrawal with the money arriving in PayPal, counting the purchase once", async () => {
    const { client, db } = await makeSignedInApp();
    const groups = (await client.get("/api/categories")).json<CategoryGroup[]>();
    const cat = (name: string) =>
      groups.flatMap((g) => g.categories).find((c) => c.name === name)?.id as string;
    const bank = (
      await client.post("/api/accounts", { name: "Everyday Checking", type: "checking" })
    ).json<Account>();
    const pp = (
      await client.post("/api/accounts", { name: "PayPal", type: "checking" })
    ).json<Account>();
    const add = async (accountId: string, amountCents: number, description: string) =>
      (
        await client.post("/api/transactions", {
          accountId,
          postedDate: "2026-10-22",
          amountCents,
          description,
        })
      ).json<{ id: string }>();
    const out = await add(bank.id, -6_099, "PAYPAL INST XFER GAMESHOP");
    // Filed by hand (e.g. imported from another app) under a spending category.
    const shopping = cat("Shopping") ?? cat("Electronics");
    await client.patch(`/api/transactions/${out.id}`, { categoryId: shopping });
    const arrived = await add(pp.id, 6_099, "PayPal · Dice set");
    const purchase = await add(pp.id, -6_099, "GAMESHOP LTD");

    expect(db.transaction((tx) => pairPayPalFunding(tx))).toBe(1);
    const list = (await client.get("/api/transactions?limit=50")).json<TransactionPage>().items;
    const byId = (id: string) => list.find((t) => t.id === id);
    expect(byId(out.id)?.transferPairId).toBe(arrived.id);
    expect(byId(arrived.id)?.transferPairId).toBe(out.id);
    expect(byId(arrived.id)?.categoryId).toBe(cat("Internal Transfer"));
    expect(byId(out.id)?.categoryId).toBe(cat("Internal Transfer"));
    // The category moved to the PayPal purchase.
    expect(byId(purchase.id)?.categoryId).toBe(shopping);
    // Again: nothing more to do.
    expect(db.transaction((tx) => pairPayPalFunding(tx))).toBe(0);
  });
});

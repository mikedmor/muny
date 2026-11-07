import type { Account, CategoryGroup, TransactionPage } from "@muny/shared";
import { describe, expect, it } from "vitest";
import { rescanRecurring } from "../recurring/service.js";
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
    const row = (id: string) =>
      db.$client
        .prepare(
          "select transfer_pair_id pair, category_id cat, funds_transaction_id funds from transactions where id = ?",
        )
        .get(id) as { pair: string | null; cat: string | null; funds: string | null };
    expect(row(out.id)).toMatchObject({ pair: arrived.id, cat: cat("Internal Transfer") });
    expect(row(arrived.id)).toMatchObject({ pair: out.id, cat: cat("Internal Transfer") });
    // Both only paid for the purchase.
    expect(row(out.id).funds).toBe(purchase.id);
    expect(row(arrived.id).funds).toBe(purchase.id);

    // Listed once: the PayPal purchase, with where its money came from.
    const list = (await client.get("/api/transactions?limit=50")).json<TransactionPage>().items;
    expect(list.map((t) => t.id)).toEqual([purchase.id]);
    expect(list[0]?.categoryId).toBe(shopping); // the category moved to the purchase
    expect(list[0]?.fundedFrom).toMatchObject({
      transactionId: out.id,
      accountName: "Everyday Checking",
      description: "PAYPAL INST XFER GAMESHOP",
    });
    // Either account finds it, and so does the bank's description.
    for (const q of [`accountId=${bank.id}`, `accountId=${pp.id}`, "q=INST%20XFER"])
      expect(
        (await client.get(`/api/transactions?${q}`)).json<TransactionPage>().items.map((t) => t.id),
      ).toEqual([purchase.id]);
    // Again: nothing more to do.
    expect(db.transaction((tx) => pairPayPalFunding(tx))).toBe(0);
  });

  it("leaves a refund in PayPal alone", async () => {
    const { client, db } = await makeSignedInApp();
    const pp = (
      await client.post("/api/accounts", { name: "PayPal", type: "checking" })
    ).json<Account>();
    const add = async (amountCents: number, description: string) =>
      (
        await client.post("/api/transactions", {
          accountId: pp.id,
          postedDate: "2026-10-22",
          amountCents,
          description,
        })
      ).json<{ id: string }>();
    await add(-2_500, "BOOKSHOP");
    await add(2_500, "Refund from BOOKSHOP");
    db.transaction((tx) => pairPayPalFunding(tx));
    expect((await client.get("/api/transactions")).json<TransactionPage>().items).toHaveLength(2);
  });

  it("moves a subscription's charges to its new category, and drops a series of funding only", async () => {
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
          postedDate: "2026-10-18",
          amountCents,
          description,
        })
      ).json<{ id: string }>();
    const out = await add(bank.id, -635, "PAYPAL INST XFER INKCO");
    await add(pp.id, 635, "PayPal · Ink");
    const purchase = await add(pp.id, -635, "INKCO");
    // A series on each side, from before they were tied together.
    const mk = async (transactionId: string) =>
      (await client.post("/api/recurring", { transactionId, interval: "monthly" })).json<{
        id: string;
      }>();
    const bankSeries = await mk(out.id);
    const inkSeries = await mk(purchase.id);
    db.transaction((tx) => pairPayPalFunding(tx));
    db.transaction((tx) => rescanRecurring(tx));
    const status = (id: string) =>
      (
        db.$client.prepare("select status from recurring_series where id = ?").get(id) as
          | { status: string }
          | undefined
      )?.status;
    // The bank-side series was only funding: gone, or ignored when you'd made or edited it.
    expect([undefined, "ignored"]).toContain(status(bankSeries.id));
    expect(status(inkSeries.id)).not.toBe("ignored");

    const r = await client.patch(`/api/recurring/${inkSeries.id}`, {
      categoryId: cat("Home & Garden"),
      applyToTransactions: true,
    });
    expect(r.statusCode).toBe(200);
    const items = (await client.get("/api/transactions")).json<TransactionPage>().items;
    expect(items.find((t) => t.id === purchase.id)?.categoryId).toBe(cat("Home & Garden"));
  });
});

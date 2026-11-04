import { newId, schema } from "@muny/db";
import type { Account, CategoryGroup, Transaction, TransactionPage } from "@muny/shared";
import { describe, expect, it } from "vitest";
import { makeSignedInApp } from "../test-utils.js";

async function setup() {
  const ctx = await makeSignedInApp();
  const { client, db } = ctx;
  const checking = (
    await client.post("/api/accounts", { name: "Checking", type: "checking", balanceCents: 100000 })
  ).json<Account>();
  const card = (
    await client.post("/api/accounts", { name: "Card", type: "credit" })
  ).json<Account>();
  const groups = (await client.get("/api/categories")).json<CategoryGroup[]>();
  const cat = (name: string) => {
    const c = groups.flatMap((g) => g.categories).find((x) => x.name === name);
    if (!c) throw new Error(`no category ${name}`);
    return c.id;
  };
  /** Insert an "imported" (non-manual) transaction directly. */
  const imported = (accountId: string, postedDate: string, amountCents: number, raw: string) => {
    const txnId = newId();
    db.insert(schema.transactions)
      .values({
        id: txnId,
        accountId,
        postedDate,
        amountCents,
        rawDescription: raw,
        importHash: `h-${txnId}`,
      })
      .run();
    return txnId;
  };
  return { ...ctx, checking, card, cat, imported };
}

const list = async (client: Awaited<ReturnType<typeof setup>>["client"], qs = "") =>
  (await client.get(`/api/transactions${qs}`)).json<TransactionPage>();

describe("transactions", () => {
  it("creates manual transactions that affect the account balance", async () => {
    const { client, checking, cat } = await setup();
    const res = await client.post("/api/transactions", {
      accountId: checking.id,
      postedDate: "2026-10-05",
      amountCents: -1599,
      description: "Streaming service",
      categoryId: cat("Streaming"),
    });
    expect(res.statusCode).toBe(201);
    const txn = res.json<Transaction>();
    expect(txn).toMatchObject({
      manual: true,
      description: "Streaming service",
      categoryName: "Streaming",
      categoryGroupName: "Subscriptions",
      accountName: "Checking",
    });
    const acc = (await client.get(`/api/accounts/${checking.id}`)).json<Account>();
    expect(acc.balanceCents).toBe(100000 - 1599);
  });

  it("lists newest first with totals and pagination", async () => {
    const { client, card, imported } = await setup();
    imported(card.id, "2026-09-01", -100, "A");
    imported(card.id, "2026-10-01", -200, "B");
    imported(card.id, "2026-08-01", -300, "C");
    const page = await list(client, "?limit=2");
    expect(page.total).toBe(3);
    expect(page.sumCents).toBe(-600);
    expect(page.items.map((x) => x.rawDescription)).toEqual(["B", "A"]);
    const next = await list(client, "?limit=2&offset=2");
    expect(next.items.map((x) => x.rawDescription)).toEqual(["C"]);
  });

  it("filters by account, date range, category and hidden", async () => {
    const { client, checking, card, cat, imported } = await setup();
    const a = imported(checking.id, "2026-10-01", -500, "GROCER");
    imported(card.id, "2026-10-02", -700, "GAS");
    imported(card.id, "2026-11-02", -900, "LATER");
    await client.patch(`/api/transactions/${a}`, { categoryId: cat("Groceries") });

    expect((await list(client, `?accountId=${card.id}`)).total).toBe(2);
    expect((await list(client, "?from=2026-10-01&to=2026-10-31")).total).toBe(2);
    expect((await list(client, `?categoryId=${cat("Groceries")}`)).items[0]?.id).toBe(a);
    expect((await list(client, "?categoryId=uncategorized")).total).toBe(2);

    await client.patch(`/api/transactions/${a}`, { hidden: true });
    expect((await list(client)).total).toBe(2);
    expect((await list(client, "?hidden=only")).total).toBe(1);
    expect((await list(client, "?hidden=include")).total).toBe(3);
  });

  it("searches description, payee, notes and amount", async () => {
    const { client, card, imported } = await setup();
    const a = imported(card.id, "2026-10-01", -1599, "SQ *COFFEE 1234");
    imported(card.id, "2026-10-02", -4200, "SHELL OIL 5555");
    await client.patch(`/api/transactions/${a}`, { payeeName: "Corner Cafe", notes: "with sam" });

    expect((await list(client, "?q=coffee")).items.map((x) => x.id)).toEqual([a]);
    expect((await list(client, "?q=corner")).items.map((x) => x.id)).toEqual([a]);
    expect((await list(client, "?q=sam")).items.map((x) => x.id)).toEqual([a]);
    expect((await list(client, "?q=15.99")).items.map((x) => x.id)).toEqual([a]);
    expect((await list(client, "?q=%25")).total).toBe(0); // literal %, not wildcard
  });

  it("renames payee, sets tags, and only allows date/amount edits on manual rows", async () => {
    const { client, card, imported } = await setup();
    const a = imported(card.id, "2026-10-01", -999, "AMZN MKTP US*1A2B3C");
    const upd = (
      await client.patch(`/api/transactions/${a}`, {
        payeeName: "Amazon",
        tags: ["homelab", "Homelab", "gift"],
      })
    ).json<Transaction>();
    expect(upd.description).toBe("Amazon");
    expect(upd.rawDescription).toBe("AMZN MKTP US*1A2B3C");
    expect(upd.tags.map((x) => x.name)).toEqual(["gift", "homelab"]);

    const bad = await client.patch(`/api/transactions/${a}`, { amountCents: -1 });
    expect(bad.statusCode).toBe(400);
  });

  it("splits a transaction across categories", async () => {
    const { client, card, cat, imported } = await setup();
    const a = imported(card.id, "2026-10-01", -10000, "COSTCO");
    const wrong = await client.put(`/api/transactions/${a}/splits`, {
      splits: [
        { categoryId: cat("Groceries"), amountCents: -6000 },
        { categoryId: cat("Electronics"), amountCents: -3000 },
      ],
    });
    expect(wrong.statusCode).toBe(400);

    const ok = (
      await client.put(`/api/transactions/${a}/splits`, {
        splits: [
          { categoryId: cat("Groceries"), amountCents: -7000 },
          { categoryId: cat("Electronics"), amountCents: -3000, notes: "cable" },
        ],
      })
    ).json<Transaction>();
    expect(ok.splits.map((s) => [s.categoryName, s.amountCents])).toEqual([
      ["Groceries", -7000],
      ["Electronics", -3000],
    ]);
    expect((await list(client, `?categoryId=${cat("Electronics")}`)).total).toBe(1);
    expect((await list(client, "?categoryId=uncategorized")).total).toBe(0);

    const cleared = (
      await client.put(`/api/transactions/${a}/splits`, { splits: [] })
    ).json<Transaction>();
    expect(cleared.splits).toEqual([]);
  });

  it("bulk updates category, hidden and tags", async () => {
    const { client, card, cat, imported } = await setup();
    const ids = [
      imported(card.id, "2026-10-01", -1, "X"),
      imported(card.id, "2026-10-02", -2, "Y"),
    ];
    const res = await client.post("/api/transactions/bulk", {
      ids,
      set: { categoryId: cat("Software & Apps"), addTag: "review" },
    });
    expect(res.json()).toEqual({ updated: 2 });
    const page = await list(client);
    expect(page.items.every((x) => x.categoryName === "Software & Apps")).toBe(true);
    expect(page.items.every((x) => x.tags.some((tg) => tg.name === "review"))).toBe(true);
    // Re-adding the same tag is a no-op, not an error.
    expect(
      (await client.post("/api/transactions/bulk", { ids, set: { addTag: "review" } })).statusCode,
    ).toBe(200);
  });

  it("rejects unknown categories and accounts", async () => {
    const { client, checking } = await setup();
    const res = await client.post("/api/transactions", {
      accountId: checking.id,
      postedDate: "2026-10-01",
      amountCents: -1,
      description: "x",
      categoryId: "nope",
    });
    expect(res.statusCode).toBe(400);
    const res2 = await client.post("/api/transactions", {
      accountId: "nope",
      postedDate: "2026-10-01",
      amountCents: -1,
      description: "x",
    });
    expect(res2.statusCode).toBe(400);
  });

  it("deletes a transaction", async () => {
    const { client, card, imported } = await setup();
    const a = imported(card.id, "2026-10-01", -1, "X");
    expect((await client.delete(`/api/transactions/${a}`)).statusCode).toBe(200);
    expect((await client.get(`/api/transactions/${a}`)).statusCode).toBe(404);
  });
});

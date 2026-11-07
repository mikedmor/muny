import { newId, schema } from "@muny/db";
import type { Account, CategoryGroup } from "@muny/shared";
import { DEFAULT_CATEGORIES } from "@muny/shared";
import { describe, expect, it } from "vitest";
import { makeSignedInApp } from "../test-utils.js";
import { seedDefaultCategories } from "./seed.js";

function addTxn(
  db: Awaited<ReturnType<typeof makeSignedInApp>>["db"],
  accountId: string,
  amountCents: number,
  extra: Partial<typeof schema.transactions.$inferInsert> = {},
) {
  db.insert(schema.transactions)
    .values({
      id: newId(),
      accountId,
      postedDate: "2026-10-01",
      amountCents,
      rawDescription: "SYNTHETIC",
      importHash: newId(),
      ...extra,
    })
    .run();
}

describe("accounts", () => {
  it("creates a manual account with a starting balance", async () => {
    const { client } = await makeSignedInApp();
    const res = await client.post("/api/accounts", {
      name: "Everyday Checking",
      type: "checking",
      institutionName: "Example Bank",
      mask: "1234",
      balanceCents: 250000,
    });
    expect(res.statusCode).toBe(201);
    const acc = res.json<Account>();
    expect(acc).toMatchObject({
      name: "Everyday Checking",
      balanceCents: 250000,
      balanceSource: "computed",
      provider: "manual",
      transactionCount: 0,
    });
  });

  it("computes balance from opening balance + posted transactions", async () => {
    const { client, db } = await makeSignedInApp();
    const acc = (
      await client.post("/api/accounts", { name: "Card", type: "credit" })
    ).json<Account>();
    addTxn(db, acc.id, -4599);
    addTxn(db, acc.id, -1000);
    addTxn(db, acc.id, -999, { pending: true }); // pending is excluded
    const got = (await client.get(`/api/accounts/${acc.id}`)).json<Account>();
    expect(got.balanceCents).toBe(-5599);
    expect(got.transactionCount).toBe(3);
    expect(got.lastTransactionDate).toBe("2026-10-01");
  });

  it("setting the balance adjusts the opening balance, not transactions", async () => {
    const { client, db } = await makeSignedInApp();
    const acc = (
      await client.post("/api/accounts", { name: "Checking", type: "checking", balanceCents: 1000 })
    ).json<Account>();
    addTxn(db, acc.id, -300);
    const updated = (
      await client.patch(`/api/accounts/${acc.id}`, { balanceCents: 5000 })
    ).json<Account>();
    expect(updated.balanceCents).toBe(5000);
    addTxn(db, acc.id, -500);
    expect((await client.get(`/api/accounts/${acc.id}`)).json<Account>().balanceCents).toBe(4500);
  });

  it("validates input", async () => {
    const { client } = await makeSignedInApp();
    const res = await client.post("/api/accounts", { name: "", type: "nope", mask: "1234567890" });
    expect(res.statusCode).toBe(400);
    const paths = res.json().issues.map((i: { path: string }) => i.path);
    expect(paths).toEqual(expect.arrayContaining(["name", "type", "mask"]));
  });

  it("rejects fractional cents", async () => {
    const { client } = await makeSignedInApp();
    const res = await client.post("/api/accounts", { name: "X", type: "cash", balanceCents: 10.5 });
    expect(res.statusCode).toBe(400);
  });

  it("updates flags and deletes with its transactions", async () => {
    const { client, db } = await makeSignedInApp();
    const acc = (
      await client.post("/api/accounts", { name: "Old", type: "savings" })
    ).json<Account>();
    addTxn(db, acc.id, 100);
    const upd = (
      await client.patch(`/api/accounts/${acc.id}`, { hidden: true, name: "Old Savings" })
    ).json<Account>();
    expect(upd).toMatchObject({ hidden: true, name: "Old Savings" });

    expect((await client.delete(`/api/accounts/${acc.id}`)).statusCode).toBe(200);
    expect((await client.get(`/api/accounts/${acc.id}`)).statusCode).toBe(404);
    expect(db.select().from(schema.transactions).all()).toHaveLength(0);
  });

  it("requires a session", async () => {
    const { app } = await makeSignedInApp();
    expect((await app.inject({ method: "GET", url: "/api/accounts" })).statusCode).toBe(401);
  });
});

describe("categories", () => {
  it("seeds defaults on setup", async () => {
    const { client } = await makeSignedInApp();
    const groups = (await client.get("/api/categories")).json<CategoryGroup[]>();
    expect(groups.map((g) => g.name)).toEqual(DEFAULT_CATEGORIES.map((g) => g.group));
    const subs = groups.find((g) => g.name === "Subscriptions");
    expect(subs?.categories.map((c) => c.name)).toContain("Streaming");
  });

  it("does not reseed after categories are deleted", async () => {
    const { db } = await makeSignedInApp();
    db.delete(schema.categories).run();
    db.delete(schema.categoryGroups).run();
    expect(seedDefaultCategories(db)).toBe(false);
    expect(db.select().from(schema.categoryGroups).all()).toHaveLength(0);
  });

  it("creates, renames and rejects duplicate names", async () => {
    const { client } = await makeSignedInApp();
    const g = (await client.post("/api/category-groups", { name: "Homelab" })).json<{
      id: string;
    }>();
    const c = (await client.post("/api/categories", { groupId: g.id, name: "Hardware" })).json<{
      id: string;
    }>();
    expect(
      (await client.post("/api/categories", { groupId: g.id, name: "hardware" })).statusCode,
    ).toBe(409);
    expect((await client.patch(`/api/categories/${c.id}`, { name: "Servers" })).statusCode).toBe(
      200,
    );
    const groups = (await client.get("/api/categories")).json<CategoryGroup[]>();
    expect(groups.find((x) => x.id === g.id)?.categories.map((x) => x.name)).toEqual(["Servers"]);
  });

  it("deletes a category, reassigning its transactions", async () => {
    const { client, db } = await makeSignedInApp();
    const groups = (await client.get("/api/categories")).json<CategoryGroup[]>();
    const food = groups.find((g) => g.name === "Food & Dining");
    const coffee = food?.categories.find((c) => c.name === "Coffee");
    const dining = food?.categories.find((c) => c.name === "Dining & Drinks");
    if (!coffee || !dining) throw new Error("seed missing");

    const acc = (
      await client.post("/api/accounts", { name: "Card", type: "credit" })
    ).json<Account>();
    addTxn(db, acc.id, -550, { categoryId: coffee.id });

    const res = await client.delete(`/api/categories/${coffee.id}?reassignTo=${dining.id}`);
    expect(res.statusCode).toBe(200);
    const txn = db.select().from(schema.transactions).get();
    expect(txn?.categoryId).toBe(dining.id);
  });

  it("moves rules and the budget along with a deleted category", async () => {
    const { client, db } = await makeSignedInApp();
    const groups = (await client.get("/api/categories")).json<CategoryGroup[]>();
    const food = groups.find((g) => g.name === "Food & Dining");
    const coffee = food?.categories.find((c) => c.name === "Coffee");
    const dining = food?.categories.find((c) => c.name === "Dining & Drinks");
    if (!coffee || !dining) throw new Error("seed missing");
    const rule = (when: string, actions: unknown[]) =>
      client.post("/api/rules", {
        name: when,
        match: "all",
        conditions: [{ field: "description", op: "contains", value: when }],
        actions,
      });
    expect((await rule("BEANS", [{ type: "setCategory", categoryId: coffee.id }])).statusCode).toBe(
      201,
    );
    await rule("ROAST", [
      { type: "setCategory", categoryId: coffee.id },
      { type: "addTag", name: "treat" },
    ]);
    await client.put("/api/budgets", { categoryId: coffee.id, amountCents: 4_000 });

    const usage = (await client.get(`/api/categories/${coffee.id}/usage`)).json();
    expect(usage).toMatchObject({ rules: 2, rulesOnlySetting: 1, budget: true });

    expect(
      (await client.delete(`/api/categories/${coffee.id}?reassignTo=${dining.id}`)).statusCode,
    ).toBe(200);
    const rules = db.select().from(schema.rules).all();
    expect(rules).toHaveLength(2);
    for (const r of rules)
      expect(r.actions).toContainEqual({ type: "setCategory", categoryId: dining.id });
    const budget = db
      .select()
      .from(schema.budgets)
      .all()
      .find((b) => b.categoryId === dining.id);
    expect(budget).toBeDefined();

    // With nowhere to move them, the set-category-only rule goes; the other keeps its tag.
    expect((await client.delete(`/api/categories/${dining.id}`)).statusCode).toBe(200);
    const left = db.select().from(schema.rules).all();
    expect(left.map((r) => r.actions)).toEqual([[{ type: "addTag", name: "treat" }]]);
  });

  it("deletes only the categories nothing uses", async () => {
    const { client, db } = await makeSignedInApp();
    const all = () => db.select().from(schema.categories).all();
    const groups = (await client.get("/api/categories")).json<CategoryGroup[]>();
    const cats = groups.flatMap((g) => g.categories);
    const [a, b] = groups.filter((g) => g.kind === "expense").flatMap((g) => g.categories);
    if (!a || !b) throw new Error("seed missing");
    const acc = (
      await client.post("/api/accounts", { name: "Card", type: "credit" })
    ).json<Account>();
    addTxn(db, acc.id, -550, { categoryId: a.id });
    await client.put("/api/budgets", { categoryId: b.id, amountCents: 1_000 });
    const listed = (await client.get("/api/categories"))
      .json<CategoryGroup[]>()
      .flatMap((g) => g.categories);
    expect(
      listed
        .filter((c) => !c.unused)
        .map((c) => c.id)
        .sort(),
    ).toEqual([a.id, b.id].sort());
    const res = (await client.post("/api/categories/delete-unused", {})).json();
    expect(res.deleted).toBe(cats.length - 2);
    expect(
      all()
        .map((c) => c.id)
        .sort(),
    ).toEqual([a.id, b.id].sort());
  });

  it("refuses to delete a non-empty group", async () => {
    const { client } = await makeSignedInApp();
    const groups = (await client.get("/api/categories")).json<CategoryGroup[]>();
    expect((await client.delete(`/api/category-groups/${groups[0]?.id}`)).statusCode).toBe(409);
  });
});

import type {
  Account,
  CategoryGroup,
  ImportResult,
  PayeeCleanupPreview,
  PayeeSummary,
  Rule,
  RuleConflict,
  RuleOverlap,
  RulePreview,
  TransactionPage,
} from "@muny/shared";
import { describe, expect, it } from "vitest";
import { makeSignedInApp, type TestClient } from "../test-utils.js";

// Synthetic data only.
const CSV = [
  "Date,Description,Amount",
  "2026-02-01,SQ *CORNER CAFE 0123 AUSTIN TX,-4.50",
  "2026-02-02,SQ *CORNER CAFE 0123 AUSTIN TX,-5.25",
  "2026-02-03,ACME CORP PAYROLL PPD ID: 999,2500.00",
  "2026-02-04,STREAMFLIX.COM 800-555-0100,-15.99",
].join("\n");

async function setup() {
  const ctx = await makeSignedInApp();
  const groups = (await ctx.client.get("/api/categories")).json<CategoryGroup[]>();
  const cat = (name: string) => {
    const c = groups.flatMap((g) => g.categories).find((x) => x.name === name);
    if (!c) throw new Error(`no category ${name}`);
    return c.id;
  };
  return { ...ctx, cat };
}

async function importCsv(client: TestClient, content = CSV) {
  return (
    await client.post("/api/import/commit", {
      filename: "bank.csv",
      content,
      accountMap: { csv: "new" },
    })
  ).json<ImportResult>();
}

async function txns(client: TestClient) {
  return (await client.get("/api/transactions?hidden=include&limit=100")).json<TransactionPage>()
    .items;
}

describe("payees", () => {
  it("cleans up payee names on import", async () => {
    const { client } = await setup();
    await importCsv(client);
    const items = await txns(client);
    expect(items.map((t) => t.payeeName).sort()).toEqual([
      "Acme Corp Payroll",
      "Corner Cafe",
      "Corner Cafe",
      "Streamflix",
    ]);
    const payees = (await client.get("/api/payees/manage")).json<PayeeSummary[]>();
    expect(payees.find((p) => p.displayName === "Corner Cafe")?.transactionCount).toBe(2);
  });

  it("renames, merges and deletes payees", async () => {
    const { client } = await setup();
    await importCsv(client);
    const find = async (n: string) =>
      (await client.get("/api/payees/manage"))
        .json<PayeeSummary[]>()
        .find((p) => p.displayName === n);
    const cafe = await find("Corner Cafe");
    const stream = await find("Streamflix");

    const r1 = await client.patch(`/api/payees/${stream?.id}`, { displayName: "StreamFlix" });
    expect(r1.json()).toEqual({ id: stream?.id, merged: false });

    const r2 = await client.patch(`/api/payees/${stream?.id}`, { displayName: "corner cafe" });
    expect(r2.json()).toEqual({ id: cafe?.id, merged: true });
    expect((await find("Corner Cafe"))?.transactionCount).toBe(3);

    await client.delete(`/api/payees/${cafe?.id}`);
    expect((await txns(client)).filter((t) => t.payeeId === null)).toHaveLength(3);
  });

  it("previews and applies cleanup for transactions without a payee", async () => {
    const { client } = await setup();
    const acc = (
      await client.post("/api/accounts", { name: "Cash", type: "cash" })
    ).json<Account>();
    for (const description of ["KROGER #0123 AUSTIN TX", "KROGER #0456 DALLAS TX", "1234"]) {
      await client.post("/api/transactions", {
        accountId: acc.id,
        postedDate: "2026-01-01",
        amountCents: -100,
        description,
      });
    }
    const p = (await client.post("/api/payees/cleanup/preview")).json<PayeeCleanupPreview>();
    expect(p).toMatchObject({ transactions: 2, payees: 1 });
    expect(p.sample[0]).toMatchObject({ cleaned: "Kroger", count: 2 });
    expect((await client.post("/api/payees/cleanup")).json()).toEqual({ updated: 2 });
    expect((await client.post("/api/payees/cleanup")).json()).toEqual({ updated: 0 });
  });
});

describe("rules", () => {
  it("previews matches before actions are chosen, and lists a transaction's rules", async () => {
    const { client, cat } = await setup();
    await importCsv(client);
    const pre = (
      await client.post("/api/rules/preview", {
        match: "all",
        conditions: [{ field: "description", op: "contains", value: "corner cafe" }],
        actions: [],
        limit: 50,
      })
    ).json<RulePreview>();
    expect(pre.matched).toBe(2);
    expect(pre.sample).toHaveLength(2);

    const rule = (
      await client.post("/api/rules", {
        name: "Cafe",
        match: "all",
        conditions: [{ field: "description", op: "contains", value: "corner cafe" }],
        actions: [{ type: "setCategory", categoryId: cat("Coffee") }],
      })
    ).json<Rule>();
    const list = await txns(client);
    const cafe = list.find((t) => t.rawDescription.includes("CORNER CAFE"));
    const other = list.find((t) => t.rawDescription.includes("STREAMFLIX"));
    const forCafe = (await client.get(`/api/transactions/${cafe?.id}/rules`)).json<
      (Rule & { matchedCount: number })[]
    >();
    expect(forCafe).toEqual([expect.objectContaining({ id: rule.id, matchedCount: 2 })]);
    expect((await client.get(`/api/transactions/${other?.id}/rules`)).json()).toEqual([]);
  });

  it("validates definitions", async () => {
    const { client } = await setup();
    const bad = await client.post("/api/rules", {
      name: "x",
      match: "all",
      conditions: [],
      actions: [{ type: "hide" }],
    });
    expect(bad.statusCode).toBe(400);
    const unknown = await client.post("/api/rules", {
      name: "x",
      conditions: [{ field: "payee", op: "contains", value: "x" }],
      actions: [{ type: "setCategory", categoryId: "nope" }],
    });
    expect(unknown.statusCode).toBe(400);
  });

  it("runs on import, previews and applies to existing transactions", async () => {
    const { client, cat } = await setup();
    await importCsv(client);

    const def = {
      match: "all",
      conditions: [
        { field: "payee", op: "equals", value: "corner cafe" },
        { field: "direction", value: "out" },
      ],
      actions: [
        { type: "setCategory", categoryId: cat("Coffee") },
        { type: "addTag", name: "treats" },
      ],
    };
    const preview = (await client.post("/api/rules/preview", def)).json<RulePreview>();
    expect(preview).toMatchObject({ matched: 2, wouldChange: 2, skippedEdited: 0 });
    expect(preview.sample.map((s) => s.amountCents)).toEqual([-525, -450]);
    // Preview writes nothing.
    expect((await txns(client)).every((t) => t.categoryId === null)).toBe(true);

    const rule = (await client.post("/api/rules", { name: "Cafe", ...def })).json<Rule>();
    expect(rule).toMatchObject({ enabled: true, match: "all", priority: 10 });
    expect((await client.post(`/api/rules/${rule.id}/apply`, {})).json()).toEqual({ changed: 2 });
    expect((await client.post(`/api/rules/${rule.id}/apply`, {})).json()).toEqual({ changed: 0 });
    const cafe = (await txns(client)).filter((t) => t.payeeName === "Corner Cafe");
    expect(cafe.every((t) => t.categoryName === "Coffee" && t.tags[0]?.name === "treats")).toBe(
      true,
    );

    // New imports get rules automatically.
    const r = await importCsv(
      client,
      "Date,Description,Amount\n2026-03-01,SQ *CORNER CAFE 0999 AUSTIN TX,-3.00",
    );
    expect(r.rulesApplied).toBe(1);
  });

  it("leaves hand-edited transactions alone unless asked", async () => {
    const { client, cat } = await setup();
    await importCsv(client);
    const pay = (await txns(client)).find((t) => t.payeeName === "Acme Corp Payroll");
    await client.patch(`/api/transactions/${pay?.id}`, { categoryId: cat("Other Income") });

    const rule = (
      await client.post("/api/rules", {
        name: "Paycheck",
        conditions: [{ field: "description", op: "contains", value: "payroll" }],
        actions: [{ type: "setCategory", categoryId: cat("Paycheck") }],
      })
    ).json<Rule>();
    const p = (
      await client.post("/api/rules/preview", { ...rule, includeEdited: false })
    ).json<RulePreview>();
    expect(p).toMatchObject({ matched: 1, wouldChange: 0, skippedEdited: 1 });
    expect((await client.post(`/api/rules/${rule.id}/apply`, {})).json()).toEqual({ changed: 0 });
    expect(
      (await client.post(`/api/rules/${rule.id}/apply`, { includeEdited: true })).json(),
    ).toEqual({ changed: 1 });
    expect((await txns(client)).find((t) => t.id === pay?.id)?.categoryName).toBe("Paycheck");
  });

  it("orders by priority: the first matching category wins", async () => {
    const { client, cat } = await setup();
    await importCsv(client);
    const mk = async (name: string, category: string) =>
      (
        await client.post("/api/rules", {
          name,
          conditions: [{ field: "amount", op: "lte", value: 2000 }],
          actions: [{ type: "setCategory", categoryId: cat(category) }],
        })
      ).json<Rule>();
    await mk("Small = coffee", "Coffee");
    const second = await mk("Small = streaming", "Streaming");
    await client.post(`/api/rules/${second.id}/move`, { direction: "up" });
    const rules = (await client.get("/api/rules")).json<Rule[]>();
    expect(rules.map((r) => r.name)).toEqual(["Small = streaming", "Small = coffee"]);

    expect((await client.post("/api/rules/run", {})).json()).toEqual({ changed: 3 });
    const small = (await txns(client)).filter((t) => Math.abs(t.amountCents) <= 2000);
    expect(small.every((t) => t.categoryName === "Streaming")).toBe(true);

    // Disabled rules don't run; deleting works.
    await client.patch(`/api/rules/${second.id}`, { enabled: false });
    expect((await client.post("/api/rules/run", {})).json()).toEqual({ changed: 3 });
    expect((await client.delete(`/api/rules/${second.id}`)).statusCode).toBe(200);
    expect((await client.get("/api/rules")).json<Rule[]>()).toHaveLength(1);
  });
});

describe("rule overlaps", () => {
  it("finds a duplicate, and a rule that files the same transactions elsewhere", async () => {
    const { client, cat } = await setup();
    await importCsv(client);
    const make = async (value: string, category: string) =>
      (
        await client.post("/api/rules", {
          name: value,
          match: "all",
          conditions: [{ field: "description", op: "contains", value }],
          actions: [{ type: "setCategory", categoryId: cat(category) }],
        })
      ).json<Rule>();
    const cafe = await make("corner cafe", "Coffee");
    await make("streamflix", "Streaming");

    const check = async (value: string, category: string, exceptId?: string) =>
      (
        await client.post("/api/rules/overlaps", {
          match: "all",
          conditions: [{ field: "description", op: "contains", value }],
          actions: [{ type: "setCategory", categoryId: cat(category) }],
          exceptId,
        })
      ).json<RuleOverlap[]>();

    // Same wording, different case: the same rule.
    const same = await check("  CORNER Cafe ", "Coffee");
    expect(same).toHaveLength(1);
    expect(same[0]).toMatchObject({ identical: true, sharedCount: 2, conflicts: [] });
    expect(same[0]?.rule.id).toBe(cafe.id);

    // Narrower wording that files them under another category: a conflict.
    const other = await check("SQ *CORNER", "Dining & Drinks");
    expect(other[0]).toMatchObject({ identical: false, sharedCount: 2, newCount: 2 });
    expect(other[0]?.conflicts).toEqual(["sets the category to Coffee"]);

    // Nothing in common, and a rule doesn't overlap itself while being edited.
    expect(await check("payroll", "Paycheck")).toEqual([]);
    expect(await check("corner cafe", "Coffee", cafe.id)).toEqual([]);
  });
});

describe("rule conflicts", () => {
  it("lists duplicates and rules that file the same transactions differently", async () => {
    const { client, cat } = await setup();
    await importCsv(client);
    const make = async (value: string, category: string) =>
      (
        await client.post("/api/rules", {
          name: `${value} → ${category}`,
          match: "all",
          conditions: [{ field: "description", op: "contains", value }],
          actions: [{ type: "setCategory", categoryId: cat(category) }],
        })
      ).json<Rule>();
    const a = await make("corner cafe", "Coffee");
    const b = await make("SQ *CORNER", "Dining & Drinks");
    const c = await make("Corner Cafe", "Coffee");
    await make("streamflix", "Streaming");

    const list = (await client.get("/api/rules/conflicts")).json<RuleConflict[]>();
    const pair = (x: Rule, y: Rule) => list.find((p) => p.firstId === x.id && p.secondId === y.id);
    expect(pair(a, b)).toMatchObject({
      identical: false,
      sharedCount: 2,
      conflicts: ["sets the category to Dining & Drinks"],
    });
    expect(pair(a, c)).toMatchObject({ identical: true, conflicts: [] });
    expect(pair(b, c)?.conflicts).toEqual(["sets the category to Coffee"]);
    expect(pair(b, c)?.firstConflicts).toEqual(["sets the category to Dining & Drinks"]);
    expect(list).toHaveLength(3); // streamflix clashes with nothing
  });
});

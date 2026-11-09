import { schema } from "@muny/db";
import {
  type Account,
  BUILTIN_CARDS,
  builtinCardDoc,
  type CardDoc,
  type CardResult,
  type CategoryGroup,
  CUSTOM_PREFIX,
  type CustomCard,
  checkCardDoc,
  DATASETS,
  type Dashboard,
  type DashboardSchema,
  TEMPLATE_IDS,
} from "@muny/shared";
import { describe, expect, it } from "vitest";
import { localToday } from "../lib/dates.js";
import { spendingReport } from "../reports/service.js";
import { makeSignedInApp, OWNER, TestClient } from "../test-utils.js";
import { DATASET_READERS } from "./datasets.js";

// Synthetic data only.

const statDoc = (dataset: string, expr: string): CardDoc => ({
  v: 2,
  blocks: [
    {
      id: "b",
      kind: "stat",
      w: 12,
      query: { dataset, measures: [{ id: "x", expr }] },
    },
  ],
});

async function setup() {
  const ctx = await makeSignedInApp();
  const { client } = ctx;
  const groups = (await client.get("/api/categories")).json<CategoryGroup[]>();
  const cat = (name: string) => groups.flatMap((g) => g.categories).find((c) => c.name === name);
  const acc = (
    await client.post("/api/accounts", {
      name: "Everyday",
      type: "checking",
      balanceCents: 500_000,
    })
  ).json<Account>();
  const today = localToday();
  const add = (amountCents: number, description: string, categoryId?: string) =>
    client.post("/api/transactions", {
      accountId: acc.id,
      postedDate: today,
      amountCents,
      description,
      ...(categoryId ? { categoryId } : {}),
    });
  const groceries = cat("Groceries")?.id;
  const income = cat("Paycheck")?.id ?? cat("Income")?.id;
  await add(-4218, "CORNER MARKET", groceries);
  await add(-1999, "CORNER MARKET", groceries);
  await add(-1250, "NOODLE BAR");
  await add(300_000, "EMPLOYER PAYROLL", income);
  return { ...ctx, acc, today, groceries };
}

const preview = async (client: TestClient, doc: CardDoc) => {
  const res = await client.post("/api/dashboard/preview", doc);
  expect(res.statusCode).toBe(200);
  return res.json<CardResult>();
};

describe("the data catalog", () => {
  it("has a reader for every dataset, and only those", () => {
    expect(Object.keys(DATASET_READERS).sort()).toEqual(DATASETS.map((d) => d.id).sort());
  });

  it("lists every field its rows contain", async () => {
    const { db, today } = await setup();
    for (const d of DATASETS) {
      const rows = DATASET_READERS[d.id]?.(db, {}, today) ?? [];
      const ids = new Set(d.fields.map((f) => f.id));
      for (const row of rows)
        for (const key of Object.keys(row)) expect(ids.has(key), `${d.id}.${key}`).toBe(true);
    }
  });

  it("names nothing secret", () => {
    const secret = /password|hash|token|secret|credential|session|config|_enc|encrypted|xpub|key$/i;
    for (const d of DATASETS) {
      expect(d.id).not.toMatch(secret);
      for (const f of d.fields) expect(`${d.id}.${f.id}`).not.toMatch(secret);
    }
  });

  it("can't name a table that isn't in it", async () => {
    const { client } = await setup();
    for (const dataset of ["users", "sessions", "connections", "notification_channels"]) {
      const out = await preview(client, statDoc(dataset, "count()"));
      expect(out.blocks.b?.error).toContain("no dataset");
    }
  });

  it("keeps stored secrets out of rows even when they exist", async () => {
    const { db, today, client, acc } = await setup();
    db.insert(schema.connections)
      .values({
        id: "c1",
        provider: "plaid",
        credentialsEnc: "SECRET-CREDENTIAL",
        providerRef: "SECRET-REF",
      })
      .run();
    db.update(schema.accounts)
      .set({ connectionId: "c1", providerAccountRef: "SECRET-ACCOUNT" })
      .run();
    db.insert(schema.cryptoWallets)
      .values({ id: "w1", name: "Cold", kind: "blockchain", sourceEnc: "SECRET-XPUB" })
      .run();
    const all = JSON.stringify(
      DATASETS.flatMap((d) => DATASET_READERS[d.id]?.(db, {}, today) ?? []),
    );
    expect(all).toContain("Cold");
    expect(all).not.toContain("SECRET");
    expect(acc.id).toBeTruthy();
    expect(client).toBeTruthy();
  });
});

describe("running cards on real data", () => {
  it("agrees with the spending report to the cent", async () => {
    const { db, client, today } = await setup();
    const doc: CardDoc = {
      v: 2,
      blocks: [
        {
          id: "b",
          kind: "table",
          w: 12,
          query: {
            dataset: "transactions",
            range: { from: today, to: today },
            filters: [{ field: "spending", op: "ne", value: 0 }],
            dimensions: [{ field: "category" }],
            measures: [{ id: "spent", field: "spending", agg: "sum" }],
          },
        },
      ],
    };
    const out = await preview(client, doc);
    const report = spendingReport(db, today, today, "category");
    const rows = out.blocks.b?.queries[0]?.rows ?? [];
    expect(rows).toHaveLength(report.items.length);
    for (const item of report.items) {
      const row = rows.find((r) => r[0] === item.name);
      expect(row?.[1], item.name).toBe(item.cents);
    }
    expect(out.blocks.b?.queries[0]?.totals.spent).toBe(report.totalCents);
  });

  it("does calculations across datasets", async () => {
    const { client } = await setup();
    const out = await preview(client, {
      v: 2,
      metrics: [
        {
          id: "spent",
          dataset: "transactions",
          range: { preset: "this_month" },
          expr: "sum([Spending])",
        },
        { id: "balance", dataset: "accounts", expr: "sum([Balance])" },
        { id: "runway", expr: "$balance / $spent", format: "number" },
      ],
      blocks: [],
    });
    expect(out.metrics.spent).toMatchObject({ value: 7467, type: "money" });
    expect(out.metrics.balance).toMatchObject({ value: 500_000 + 300_000 - 7467 });
    expect(Number((out.metrics.runway as { value: number }).value)).toBeCloseTo(
      (800_000 - 7467) / 7467,
      4,
    );
  });

  it("runs every built-in card as a document", async () => {
    const { client } = await setup();
    // All but the interactive ones, which aren't documents.
    expect([...TEMPLATE_IDS].sort()).toEqual(
      BUILTIN_CARDS.filter((c) => !c.needsAi)
        .map((c) => c.id)
        .sort(),
    );
    for (const id of TEMPLATE_IDS) {
      const doc = builtinCardDoc(id) as CardDoc;
      expect(checkCardDoc(doc), id).toEqual([]);
      const out = await preview(client, doc);
      for (const [block, result] of Object.entries(out.blocks))
        expect(result.error, `${id} ${block}`).toBeUndefined();
      for (const [metric, value] of Object.entries(out.metrics))
        expect("error" in value ? value.error : undefined, `${id} $${metric}`).toBeUndefined();
    }
  });

  it("works out the Overview's numbers in the spending card", async () => {
    const { client } = await setup();
    const out = await preview(client, builtinCardDoc("spending") as CardDoc);
    expect(out.metrics.spent).toMatchObject({ value: 7467 });
    expect(out.metrics.earned).toMatchObject({ value: 300_000 });
  });

  it("reads every dataset without failing, with no data at all", async () => {
    const { client } = await makeSignedInApp();
    for (const d of DATASETS) {
      const out = await preview(client, statDoc(d.id, "count()"));
      expect(out.blocks.b?.error, d.id).toBeUndefined();
      expect(out.blocks.b?.value?.value, d.id).toBeTypeOf("number");
    }
  });
});

describe("the Muny AI card", () => {
  const AI = { enabled: true, provider: "ollama", model: "m", baseUrl: "http://ai.example.test" };
  const ids = (d: Dashboard) => d.cards;

  it("exists only while AI is on, and keeps its place while it's off", async () => {
    const { client } = await setup();
    const listed = async () =>
      (await client.get("/api/dashboard/schema"))
        .json<DashboardSchema>()
        .builtinCards.map((c) => c.id);
    expect(await listed()).not.toContain("muny-ai");
    expect(
      (await client.put("/api/dashboard/layout", { cards: ["spending", "muny-ai"] })).statusCode,
    ).toBe(400);

    await client.put("/api/ai", AI);
    expect(await listed()).toContain("muny-ai");
    const on = await client.put("/api/dashboard/layout", { cards: ["spending", "muny-ai"] });
    expect(ids(on.json<Dashboard>())).toEqual(["spending", "muny-ai"]);

    await client.put("/api/ai", { enabled: false });
    const off = (await client.get("/api/dashboard")).json<Dashboard>();
    expect(ids(off)).toEqual(["spending"]);
    // Rearranging while it's hidden doesn't lose it.
    await client.put("/api/dashboard/layout", { cards: ["budget", "spending"] });

    await client.put("/api/ai", { enabled: true });
    const back = (await client.get("/api/dashboard")).json<Dashboard>();
    expect(ids(back)).toEqual(["budget", "spending", "muny-ai"]);
  });
});

describe("saving cards", () => {
  const input = {
    title: "Dining",
    doc: statDoc("transactions", "sum([Spending])"),
  };

  it("creates, reads, edits and deletes", async () => {
    const { client } = await setup();
    const created = await client.post("/api/dashboard/cards", input);
    expect(created.statusCode).toBe(201);
    const card = created.json<CustomCard>();
    const board = (await client.get("/api/dashboard")).json<Dashboard>();
    expect(board.cards).toContain(`${CUSTOM_PREFIX}${card.id}`);

    const data = (await client.get(`/api/dashboard/cards/${card.id}/data`)).json<CardResult>();
    expect(data.blocks.b?.value?.value).toBe(7467);

    const updated = await client.put(`/api/dashboard/cards/${card.id}`, {
      ...input,
      title: "Food",
    });
    expect(updated.json<CustomCard>().title).toBe("Food");

    expect((await client.delete(`/api/dashboard/cards/${card.id}`)).statusCode).toBe(200);
    const after = (await client.get("/api/dashboard")).json<Dashboard>();
    expect(after.cards).not.toContain(`${CUSTOM_PREFIX}${card.id}`);
  });

  it("puts a customized copy where the original was", async () => {
    const { client } = await setup();
    const before = (await client.get("/api/dashboard")).json<Dashboard>().cards;
    const at = before.indexOf("budget");
    const copy = await client.post("/api/dashboard/cards", {
      title: "My budget",
      basedOn: "budget",
      doc: builtinCardDoc("budget"),
    });
    const after = (await client.get("/api/dashboard")).json<Dashboard>().cards;
    expect(after[at]).toBe(`${CUSTOM_PREFIX}${copy.json<CustomCard>().id}`);
    expect(after).not.toContain("budget");
    expect(after).toHaveLength(before.length);
  });

  it("keeps a hand arrangement for each screen size", async () => {
    const { client } = await setup();
    const layout = async () => (await client.get("/api/dashboard")).json<Dashboard>();
    const cards = ["spending", "accounts", "budget"];
    const columns = {
      "2": [["accounts"], ["spending", "budget"]],
      "1": [["budget", "accounts", "spending"]],
    };
    expect((await client.put("/api/dashboard/layout", { cards, columns })).statusCode).toBe(200);
    expect((await layout()).columns).toEqual(columns);

    // Changing the priority order alone leaves them.
    await client.put("/api/dashboard/layout", { cards: [...cards].reverse() });
    expect((await layout()).columns).toEqual(columns);

    // A customized copy takes the original's place at every size.
    const copy = await client.post("/api/dashboard/cards", {
      title: "My budget",
      basedOn: "budget",
      doc: builtinCardDoc("budget"),
    });
    const ref = `${CUSTOM_PREFIX}${copy.json<CustomCard>().id}`;
    expect((await layout()).columns["2"]?.[1]).toEqual(["spending", ref]);
    expect((await layout()).columns["1"]?.[0]?.[0]).toBe(ref);

    // Reset goes back to arranging itself.
    await client.delete("/api/dashboard/layout");
    expect((await layout()).columns).toEqual({});
  });

  it("refuses arrangements that don't fit", async () => {
    const { client } = await setup();
    const put = async (columns: unknown) =>
      (await client.put("/api/dashboard/layout", { cards: ["spending", "accounts"], columns }))
        .statusCode;
    expect(await put({ "2": [["spending"]] })).toBe(400);
    expect(await put({ "2": [["spending"], ["budget"]] })).toBe(400);
    expect(await put({ "2": [["spending"], ["spending"]] })).toBe(400);
    expect(await put({ "9": [["spending"]] })).toBe(400);
  });

  it("gives a template for every built-in card, and no others", async () => {
    const { client } = await setup();
    const res = await client.get("/api/dashboard/templates/budget");
    expect(res.json<CardDoc>().v).toBe(2);
    expect((await client.get("/api/dashboard/templates/nope")).statusCode).toBe(404);
  });

  it("refuses cards that could never work", async () => {
    const { client } = await setup();
    const bad = async (doc: unknown) =>
      (await client.post("/api/dashboard/cards", { title: "x", doc })).statusCode;
    // Things that aren't a card at all.
    expect(await bad({ v: 2, blocks: [], script: "alert(1)" })).toBe(400);
    expect(await bad({ v: 1, blocks: [] })).toBe(400);
    const block = (extra: object) => ({
      v: 2,
      blocks: [{ id: "b", kind: "stat", w: 6, ...extra }],
    });
    expect(await bad(block({ kind: "html" }))).toBe(400);
    expect(await bad(block({ w: 13 }))).toBe(400);
    expect(await bad(block({ options: { onClick: "x" } }))).toBe(400);
    // Things that are shaped right but can't work.
    expect(await bad(block({ query: { dataset: "users" } }))).toBe(400);
    expect(await bad(block({ options: { value: "sum(" } }))).toBe(400);
    expect(await bad(block({ options: { value: "$nope" } }))).toBe(400);
    // Links stay inside Muny.
    expect(
      await bad(block({ options: { link: { to: "https://evil.example", label: "x" } } })),
    ).toBe(400);
    expect(await bad(block({ options: { link: { to: "javascript:alert(1)", label: "x" } } }))).toBe(
      400,
    );
    expect(await bad(block({ options: { link: { to: "//evil.example", label: "x" } } }))).toBe(400);
    expect(await bad(block({ options: { link: { to: "//evil", label: "x" } } }))).toBe(400);
  });

  it("keeps cards saved in the first format working", async () => {
    const { db, client } = await setup();
    db.insert(schema.appSettings)
      .values({
        key: "dashboard.cards",
        value: [
          {
            id: "old1",
            title: "Old",
            spec: { source: "spending_by_category", view: "bars", period: "this_month", limit: 5 },
          },
          { id: "old2", title: "Old 2", spec: { source: "cash_flow_by_month", view: "columns" } },
          {
            id: "old3",
            title: "Old 3",
            spec: { source: "transactions", view: "list", search: "x" },
          },
        ],
      })
      .onConflictDoUpdate({
        target: schema.appSettings.key,
        set: { value: [] },
      })
      .run();
    const board = (await client.get("/api/dashboard")).json<Dashboard>();
    expect(board.customCards.map((c) => c.doc.v)).toEqual([2, 2, 2]);
    for (const id of ["old1", "old2", "old3"]) {
      const data = (await client.get(`/api/dashboard/cards/${id}/data`)).json<CardResult>();
      expect(data.blocks.b1?.error, id).toBeUndefined();
    }
  });

  it("describes itself for assistants, with no financial data", async () => {
    const { client } = await setup();
    const res = await client.get("/api/dashboard/schema");
    const s = res.json<DashboardSchema>();
    expect(s.datasets.length).toBeGreaterThan(20);
    expect(s.functions.length).toBeGreaterThan(30);
    expect(s.formulaGuide).toContain("$name");
    expect(s.cardJsonSchema).toBeTruthy();
    expect(res.body).not.toContain("CORNER MARKET");
    expect(res.body).not.toContain(OWNER.email);
  });

  it("lets a view-only member try cards but not save them", async () => {
    const { client, app } = await setup();
    const invite = await client.post("/api/household/invites", { role: "viewer" });
    const { token } = invite.json<{ token: string }>();
    const viewer = new TestClient(app);
    await viewer.post(`/api/invites/${token}/accept`, {
      email: "viewer@example.com",
      password: "correct horse battery",
    });
    expect(
      (await viewer.post("/api/dashboard/preview", statDoc("accounts", "count()"))).statusCode,
    ).toBe(200);
    expect((await viewer.post("/api/dashboard/cards", input)).statusCode).toBe(403);
  });
});

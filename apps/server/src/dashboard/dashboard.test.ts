import { schema } from "@muny/db";
import {
  type Account,
  CARD_SOURCE_INFO,
  CARD_SOURCES,
  type CardData,
  type CardSpec,
  type CategoryGroup,
  type CustomCard,
  type Dashboard,
  type DashboardSchema,
} from "@muny/shared";
import { describe, expect, it } from "vitest";
import { localToday } from "../lib/dates.js";
import { makeSignedInApp } from "../test-utils.js";
import { periodRange } from "./service.js";

// Synthetic data only.

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
  const groceries = cat("Groceries");
  const add = (amountCents: number, description: string, categoryId?: string | null) =>
    client.post("/api/transactions", {
      accountId: acc.id,
      postedDate: today,
      amountCents,
      description,
      categoryId: categoryId ?? null,
    });
  const preview = (spec: CardSpec) => client.post("/api/dashboard/preview", spec);
  return { ...ctx, acc, add, preview, groceries };
}

async function makeSignedInAppWithUser() {
  const ctx = await makeSignedInApp();
  const user = ctx.db.select().from(schema.users).get();
  if (!user) throw new Error("no user");
  return { ...ctx, user };
}

const dashboard = async (c: Awaited<ReturnType<typeof makeSignedInApp>>["client"]) =>
  (await c.get("/api/dashboard")).json<Dashboard>();

describe("dashboard layout", () => {
  it("starts on the standard cards, with the calendar in and Coming up out", async () => {
    const { client } = await makeSignedInApp();
    const d = await dashboard(client);
    expect(d.isDefault).toBe(true);
    expect(d.cards).toContain("calendar");
    expect(d.cards).toContain("recent");
    expect(d.cards).not.toContain("coming-up");
  });

  it("saves your priority order, and goes back to the standard one", async () => {
    const { client } = await makeSignedInApp();
    const res = await client.put("/api/dashboard/layout", { cards: ["coming-up", "recent"] });
    expect(res.statusCode).toBe(200);
    const d = await dashboard(client);
    expect(d.isDefault).toBe(false);
    expect(d.cards).toEqual(["coming-up", "recent"]);
    expect((await client.delete("/api/dashboard/layout")).statusCode).toBe(200);
    expect((await dashboard(client)).isDefault).toBe(true);
  });

  it("refuses unknown cards, duplicates and the wrong shape", async () => {
    const { client } = await makeSignedInApp();
    const put = (body: unknown) => client.put("/api/dashboard/layout", body);
    expect((await put({ cards: ["nope"] })).statusCode).toBe(400);
    expect((await put({ cards: ["recent", "recent"] })).statusCode).toBe(400);
    expect((await put({ cards: "recent" })).statusCode).toBe(400);
    expect((await put({ cards: [], extra: 1 })).statusCode).toBe(400);
  });

  it("converts a layout saved with grid positions", async () => {
    const { client, db, user } = await makeSignedInAppWithUser();
    db.insert(schema.appSettings)
      .values({
        key: `dashboard.layout:${user.id}`,
        value: [
          { card: "recent", x: 8, y: 0, w: 4, h: 10 },
          { card: "spending", x: 0, y: 0, w: 8, h: 10 },
          { card: "calendar", x: 0, y: 20, w: 8, h: 10 },
        ],
      })
      .run();
    expect((await dashboard(client)).cards).toEqual(["spending", "recent", "calendar"]);
  });
});

describe("custom cards", () => {
  it("creates a card, adds it to the layout, and removes it everywhere when deleted", async () => {
    const { client } = await makeSignedInApp();
    const res = await client.post("/api/dashboard/cards", {
      title: "Spending",
      spec: { source: "spending_total", view: "stat", period: "last_30_days" },
    });
    expect(res.statusCode).toBe(201);
    const card = res.json<CustomCard>();
    const ref = `custom:${card.id}`;
    expect((await dashboard(client)).cards.at(-1)).toBe(ref);
    expect((await client.get(`/api/dashboard/cards/${card.id}/data`)).statusCode).toBe(200);

    const edit = await client.put(`/api/dashboard/cards/${card.id}`, {
      title: "Renamed",
      spec: { source: "spending_total", view: "stat" },
    });
    expect(edit.json<CustomCard>().title).toBe("Renamed");

    expect((await client.delete(`/api/dashboard/cards/${card.id}`)).statusCode).toBe(200);
    const after = await dashboard(client);
    expect(after.cards).not.toContain(ref);
    expect(after.customCards).toEqual([]);
  });

  it("only accepts definitions: no extra fields, wrong views or unused options", async () => {
    const { client } = await makeSignedInApp();
    const post = (body: unknown) => client.post("/api/dashboard/cards", body);
    const spec = { source: "spending_total", view: "stat" };
    expect((await post({ title: "", spec })).statusCode).toBe(400);
    expect((await post({ title: "x", spec, html: "<script>" })).statusCode).toBe(400);
    expect((await post({ title: "x", spec: { ...spec, code: "alert(1)" } })).statusCode).toBe(400);
    expect((await post({ title: "x", spec: { source: "sql", view: "stat" } })).statusCode).toBe(
      400,
    );
    expect(
      (await post({ title: "x", spec: { source: "spending_total", view: "line" } })).statusCode,
    ).toBe(400);
    expect((await post({ title: "x", spec: { ...spec, days: 3 } })).statusCode).toBe(400);
  });

  it("describes itself, and every source and view it lists actually runs", async () => {
    const { client, preview, add } = await setup();
    await add(-1_000, "COFFEE");
    const info = (await client.get("/api/dashboard/schema")).json<DashboardSchema>();
    expect(Object.keys(info.sources).sort()).toEqual([...CARD_SOURCES].sort());
    expect(info.cardJsonSchema).toBeTruthy();
    for (const source of CARD_SOURCES)
      for (const view of CARD_SOURCE_INFO[source].views) {
        const res = await preview({ source, view });
        expect(res.statusCode, `${source}/${view}`).toBe(200);
        expect(Number.isInteger(res.json<CardData>().totalCents)).toBe(true);
      }
  });

  it("reports what the ledger says", async () => {
    const { preview, add, groceries, acc } = await setup();
    await add(-4_000, "MARKET", groceries?.id);
    await add(-1_000, "COFFEE");

    const total = (await preview({ source: "spending_total", view: "stat" })).json<CardData>();
    expect(total.totalCents).toBe(5_000);

    const inCat = (
      await preview({ source: "spending_total", view: "stat", categoryId: groceries?.id })
    ).json<CardData>();
    expect(inCat.totalCents).toBe(4_000);

    const byMonth = (
      await preview({
        source: "spending_by_month",
        view: "columns",
        months: 3,
        categoryId: groceries?.id,
      })
    ).json<CardData>();
    expect(byMonth.rows).toHaveLength(3);
    expect(byMonth.rows.at(-1)?.values).toEqual([4_000]);

    const txns = (
      await preview({ source: "transactions", view: "list", search: "MARK", limit: 5 })
    ).json<CardData>();
    expect(txns.rows).toHaveLength(1);
    expect(txns.rows[0]?.values).toEqual([-4_000]);

    const wild = (
      await preview({ source: "transactions", view: "list", search: "%" })
    ).json<CardData>();
    expect(wild.rows).toEqual([]); // % is text, not a wildcard

    const balances = (await preview({ source: "account_balances", view: "list" })).json<CardData>();
    expect(balances.rows[0]).toMatchObject({ key: acc.id, label: "Everyday" });
  });

  it("works out periods", () => {
    expect(periodRange("this_month", "2026-11-07")).toEqual({
      from: "2026-11-01",
      to: "2026-11-07",
    });
    expect(periodRange("last_month", "2026-03-15")).toEqual({
      from: "2026-02-01",
      to: "2026-02-28",
    });
    expect(periodRange("last_30_days", "2026-11-30")).toEqual({
      from: "2026-11-01",
      to: "2026-11-30",
    });
    expect(periodRange("this_year", "2026-11-07").from).toBe("2026-01-01");
    expect(periodRange("last_12_months", "2026-11-07").from).toBe("2025-12-01");
  });
});

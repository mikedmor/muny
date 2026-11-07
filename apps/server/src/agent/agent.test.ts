import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { schema } from "@muny/db";
import {
  type Account,
  AGENT_SCOPES,
  type AgentScope,
  type ApiToken,
  BUILTIN_THEMES,
  builtinCardDoc,
  type CardDoc,
  type CategoryGroup,
  type CreatedApiToken,
  type Dashboard,
  type Theme,
  type ThemeState,
} from "@muny/shared";
import { afterEach, describe, expect, it } from "vitest";
import { localToday } from "../lib/dates.js";
import { makeSignedInApp, TestClient } from "../test-utils.js";
import { TOOLS, unmappedDatasets } from "./tools.js";

// Synthetic data only.

const READ_ALL: AgentScope[] = ["read:summary", "read:transactions", "read:accounts", "read:debts"];

async function setup() {
  const ctx = await makeSignedInApp();
  const { client, app } = ctx;
  const groups = (await client.get("/api/categories")).json<CategoryGroup[]>();
  const groceries = groups.flatMap((g) => g.categories).find((c) => c.name === "Groceries")?.id;
  const acc = (
    await client.post("/api/accounts", {
      name: "Everyday",
      type: "checking",
      balanceCents: 500_000,
    })
  ).json<Account>();
  await client.post("/api/transactions", {
    accountId: acc.id,
    postedDate: localToday(),
    amountCents: -4218,
    description: "CORNER MARKET",
    categoryId: groceries,
  });
  const token = async (scopes: AgentScope[], extra: object = {}) =>
    (
      await client.post("/api/agents/tokens", {
        name: "Test",
        scopes,
        expiresInDays: null,
        ...extra,
      })
    ).json<CreatedApiToken>();
  const call = async (bearer: string, name: string, input: unknown = {}) =>
    app.inject({
      method: "POST",
      url: `/api/v1/tools/${name}`,
      headers: { authorization: `Bearer ${bearer}` },
      payload: input as object,
    });
  return { ...ctx, token, call };
}

const statDoc = (dataset: string): CardDoc => ({
  v: 2,
  blocks: [
    { id: "b", kind: "stat", w: 12, query: { dataset, measures: [{ id: "n", agg: "count" }] } },
  ],
});

describe("tokens", () => {
  it("are shown once and only stored as a hash", async () => {
    const { db, token, client } = await setup();
    const created = await token(["read:summary"]);
    expect(created.token).toMatch(/^muny_/);
    expect(JSON.stringify(db.select().from(schema.apiTokens).all())).not.toContain(created.token);
    const list = (await client.get("/api/agents/tokens")).json<ApiToken[]>();
    expect(list[0]?.prefix).toBe(created.token.slice(0, 12));
    expect(JSON.stringify(list)).not.toContain(created.token);
  });

  it("stop working when revoked or expired, and bad ones get nowhere", async () => {
    const { db, token, call, client, app } = await setup();
    const t = await token(["read:summary"]);
    expect((await call(t.token, "get_financial_overview")).statusCode).toBe(200);

    await client.delete(`/api/agents/tokens/${t.id}`);
    const revoked = await call(t.token, "get_financial_overview");
    expect(revoked.statusCode).toBe(401);
    expect(revoked.headers["www-authenticate"]).toContain("Bearer");

    const old = await token(["read:summary"], { expiresInDays: 1 });
    db.update(schema.apiTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .run();
    expect((await call(old.token, "get_financial_overview")).statusCode).toBe(401);

    expect((await call("muny_nope", "get_financial_overview")).statusCode).toBe(401);
    const none = await app.inject({ method: "POST", url: "/api/v1/tools/list_accounts" });
    expect(none.statusCode).toBe(401);
  });

  it("can't reach the web app, and a session can't reach the agent routes", async () => {
    const { app, token, client } = await setup();
    const t = await token(READ_ALL);
    for (const url of ["/api/accounts", "/api/dashboard", "/api/household", "/api/agents/tokens"]) {
      const res = await app.inject({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${t.token}` },
      });
      expect(res.statusCode, url).toBe(401);
    }
    expect((await client.post("/api/v1/tools/list_accounts", {})).statusCode).toBe(401);
    expect((await client.post("/mcp", {})).statusCode).toBe(401);
  });

  it("are managed by the owner only", async () => {
    const { client, app } = await setup();
    const invite = await client.post("/api/household/invites", { role: "member" });
    const member = new TestClient(app);
    await member.post(`/api/invites/${invite.json<{ token: string }>().token}/accept`, {
      email: "partner@example.com",
      password: "correct horse battery",
    });
    expect((await member.get("/api/agents/tokens")).statusCode).toBe(403);
    expect(
      (
        await member.post("/api/agents/tokens", {
          name: "x",
          scopes: ["read:summary"],
          expiresInDays: null,
        })
      ).statusCode,
    ).toBe(403);
  });

  it("refuse unknown permissions", async () => {
    const { client } = await setup();
    const res = await client.post("/api/agents/tokens", {
      name: "x",
      scopes: ["admin"],
      expiresInDays: null,
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("permissions", () => {
  it("every tool answers only with its scope", async () => {
    const { token, call } = await setup();
    for (const scope of AGENT_SCOPES) {
      const t = await token([scope]);
      for (const tool of TOOLS.filter((x) => x.scope)) {
        const res = await call(t.token, tool.name, {});
        if (tool.scope === scope) expect(res.statusCode, tool.name).not.toBe(403);
        else expect(res.statusCode, `${tool.name} with ${scope}`).toBe(403);
      }
    }
  });

  it("every dataset has a permission", () => {
    expect(unmappedDatasets()).toEqual([]);
  });

  it("can't read past its scope by going through a card or query", async () => {
    const { token, call } = await setup();
    const t = await token(["read:summary", "write:dashboard"]);
    const query = await call(t.token, "query_data", {
      query: { dataset: "transactions", raw: true, dimensions: [{ field: "merchant" }] },
    });
    expect(query.statusCode).toBe(403);
    expect(query.body).not.toContain("Corner");

    for (const doc of [
      statDoc("accounts"),
      { v: 2, metrics: [{ id: "x", dataset: "transactions", expr: "sum([Amount])" }], blocks: [] },
      {
        v: 2,
        blocks: [
          {
            id: "b",
            kind: "line",
            w: 12,
            query: { dataset: "budgets" },
            layers: [{ dataset: "credit_cards" }],
          },
        ],
      },
    ]) {
      const preview = await call(t.token, "preview_card", { doc });
      expect(preview.statusCode).toBe(200);
      expect(preview.json().preview).toContain("Not shown");
      const dry = await call(t.token, "create_card", { title: "x", doc });
      expect(dry.json().preview).toContain("Not shown");
    }
    const ok = await call(t.token, "preview_card", { doc: statDoc("budgets") });
    expect(ok.json().preview.blocks.b.value).toBeDefined();
  });

  it("can't name tables outside the catalog", async () => {
    const { token, call } = await setup();
    const t = await token(READ_ALL);
    for (const dataset of ["users", "sessions", "api_tokens", "connections"]) {
      const res = await call(t.token, "query_data", {
        query: { dataset, measures: [{ id: "n", agg: "count" }] },
      });
      expect(res.statusCode, dataset).toBe(400);
    }
  });
});

describe("reading", () => {
  it("answers questions in integer cents", async () => {
    const { token, call } = await setup();
    const t = await token(READ_ALL);
    const o = (await call(t.token, "get_financial_overview")).json();
    expect(o.spending.monthToDateCents).toBe(4218);
    const by = (await call(t.token, "get_spending_by_category", {})).json();
    expect(by.items[0]).toMatchObject({ name: "Groceries", cents: 4218, previousCents: 0 });
    const accounts = (await call(t.token, "list_accounts")).json();
    expect(accounts[0]).toMatchObject({ name: "Everyday", balanceCents: 495_782 });
    const q = (
      await call(t.token, "query_data", {
        query: {
          dataset: "transactions",
          dimensions: [{ field: "category" }],
          measures: [
            { id: "spent", expr: "sum([Spending])" },
            { id: "share", expr: "pct_of_total(spent)" },
          ],
          filters: [{ field: "spending", op: "gt", value: 0 }],
        },
      })
    ).json();
    expect(q.rows).toEqual([["Groceries", 4218, 1]]);
  });

  it("searches transactions", async () => {
    const { token, call } = await setup();
    const t = await token(["read:transactions"]);
    const hits = (await call(t.token, "search_transactions", { text: "corner" })).json();
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ amountCents: -4218, category: "Groceries" });
    expect((await call(t.token, "search_transactions", { text: "zzz" })).json()).toEqual([]);
  });

  it("runs every read tool without failing, on no data at all", async () => {
    const { client, app } = await makeSignedInApp();
    const t = (
      await client.post("/api/agents/tokens", {
        name: "x",
        scopes: AGENT_SCOPES,
        expiresInDays: null,
      })
    ).json<CreatedApiToken>();
    for (const tool of TOOLS.filter((x) => !x.write)) {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/tools/${tool.name}`,
        headers: { authorization: `Bearer ${t.token}` },
        payload:
          tool.name === "query_data"
            ? { query: { dataset: "budgets", measures: [{ id: "n", agg: "count" }] } }
            : tool.name === "preview_card"
              ? { doc: statDoc("budgets") }
              : {},
      });
      expect(res.statusCode, tool.name).toBe(200);
    }
  });

  it("writes every call to the audit log, without the input", async () => {
    const { db, token, call, client } = await setup();
    const t = await token(READ_ALL);
    await call(t.token, "search_transactions", { text: "secret-looking-search" });
    await call(t.token, "search_transactions", { limit: 9_999_999 });
    const rows = db.select().from(schema.auditLog).all();
    const mine = rows.filter((r) => r.actorType === "agent" && r.actorId === t.id);
    expect(mine).toHaveLength(2);
    expect(mine[0]?.details).toMatchObject({ ok: true });
    expect(mine[1]?.details).toMatchObject({ ok: false, code: "invalid" });
    expect(JSON.stringify(rows)).not.toContain("secret-looking-search");
    expect(JSON.stringify(rows)).not.toContain(t.token);
    const activity = (await client.get(`/api/agents/tokens/${t.id}/activity`)).json<unknown[]>();
    expect(activity).toHaveLength(2);
  });
});

describe("what the first live test found", () => {
  it("checks a layout in the dry run too, and says what it would remove", async () => {
    const { token, call } = await setup();
    const t = await token(["write:dashboard"]);
    const bad = await call(t.token, "arrange_dashboard", { cards: ["spending", "not-a-card"] });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toContain("not-a-card");
    const twice = await call(t.token, "arrange_dashboard", { cards: ["spending", "spending"] });
    expect(twice.statusCode).toBe(400);
    const ok = (
      await call(t.token, "arrange_dashboard", { cards: ["spending", "coming-up"] })
    ).json();
    expect(ok.wouldRemove).toContain("accounts");
    expect(ok.wouldRemove).not.toContain("spending");
    expect(ok.wouldAdd).toEqual(["coming-up"]);
  });

  it("reports blocks that couldn't draw anything", async () => {
    const { token, call } = await setup();
    const t = await token([...READ_ALL, "write:dashboard"]);
    const blocks: [string, object, RegExp][] = [
      ["bars", { dataset: "budgets" }, /needs a field|needs a value/],
      ["bars", { dataset: "budgets", dimensions: [{ field: "name" }] }, /needs a value/],
      [
        "heatmap",
        {
          dataset: "budgets",
          dimensions: [{ field: "name" }],
          measures: [{ id: "n", agg: "count" }],
        },
        /needs a field/,
      ],
      [
        "scatter",
        {
          dataset: "budgets",
          dimensions: [{ field: "name" }],
          measures: [{ id: "n", agg: "count" }],
        },
        /2 values/,
      ],
      ["table", { dataset: "budgets" }, /choose a field/],
    ];
    for (const [kind, query, why] of blocks) {
      const out = (
        await call(t.token, "preview_card", {
          doc: { v: 2, blocks: [{ id: "b", kind, w: 12, query }] },
        })
      ).json();
      expect(out.valid, kind).toBe(false);
      expect(out.issues.join(" "), kind).toMatch(why);
    }
    const missing = (
      await call(t.token, "preview_card", {
        doc: { v: 2, blocks: [{ id: "b", kind: "bars", w: 12 }] },
      })
    ).json();
    expect(missing.valid).toBe(false);
    const saved = await call(t.token, "create_card", {
      title: "x",
      dry_run: false,
      doc: { v: 2, blocks: [{ id: "b", kind: "bars", w: 12, query: { dataset: "budgets" } }] },
    });
    expect(saved.statusCode).toBe(400);
    // A big number can still run on a formula alone.
    const stat = (
      await call(t.token, "preview_card", {
        doc: { v: 2, blocks: [{ id: "b", kind: "stat", w: 6, options: { value: "1 + 1" } }] },
      })
    ).json();
    expect(stat.valid).toBe(true);
  });

  it("says a query with no fields is a mistake, and lists the fields", async () => {
    const { token, call } = await setup();
    const t = await token(READ_ALL);
    const res = await call(t.token, "query_data", {
      query: {
        dataset: "transactions",
        raw: true,
        filters: [{ field: "merchant", op: "contains", value: "corner" }],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain("merchant");
  });

  it("names crypto money as cents and doesn't call unknown costs zero", async () => {
    const { db, client, token, call } = await setup();
    db.insert(schema.cryptoWallets).values({ id: "w1", name: "Cold", kind: "manual" }).run();
    db.insert(schema.cryptoTxns)
      .values({
        id: "c1",
        walletId: "w1",
        at: Date.parse("2020-01-01T00:00:00Z"),
        type: "deposit",
        receivedAsset: "BTC",
        receivedAmount: "2",
        externalId: "e1",
        source: "manual",
      })
      .run();
    db.insert(schema.cryptoPrices)
      .values({ asset: "BTC", date: "2020-01-01", usd: "10", source: "test" })
      .run();
    const broker = (
      await client.post("/api/accounts", { name: "Broker", type: "investment", balanceCents: 0 })
    ).json<Account>();
    db.insert(schema.securities)
      .values({ id: "s1", symbol: "XYZ", name: "XYZ", type: "equity" })
      .run();
    db.insert(schema.investmentHoldings)
      .values({
        accountId: broker.id,
        securityId: "s1",
        quantity: "1",
        valueCents: 5000,
        costBasisCents: null,
        asOf: "2020-01-01",
        source: "manual",
      })
      .run();
    const t = await token(READ_ALL);
    const out = (await call(t.token, "get_investments_summary")).json();
    expect(out.costBasisCents).toBeNull();
    expect(out.gainCents).toBeNull();
    expect(out.unknownCostValueCents).toBe(5000);
    expect(out.knownCostBasisCents).toBe(0);
    expect(out.crypto[0]).toMatchObject({ asset: "BTC", amount: "2" });
    expect(out.crypto[0]).toHaveProperty("valueCents");
    expect(out.crypto[0]).not.toHaveProperty("value");
  });

  it("gives one budget figure everywhere", async () => {
    const { client, token, call } = await setup();
    const groups = (await client.get("/api/categories")).json<CategoryGroup[]>();
    const cat = groups.flatMap((g) => g.categories).find((c) => c.name === "Groceries");
    await client.put("/api/budgets", { categoryId: cat?.id, amountCents: 50_000 });
    const t = await token(READ_ALL);
    const status = (await call(t.token, "get_budget_status")).json();
    const overview = (await call(t.token, "get_financial_overview")).json();
    expect(status.total.budgetCents).toBe(50_000);
    expect(status.total.availableCents).toBe(50_000 - 4218);
    expect(overview.budget.budgetCents).toBe(50_000);
    const card = (await call(t.token, "preview_card", { doc: builtinCardDoc("budget") })).json();
    expect(card.preview.values.budget.value).toBe(50_000);
  });

  it("explains why a built-in card can't be deleted", async () => {
    const { token, call } = await setup();
    const t = await token(["write:dashboard"]);
    const res = await call(t.token, "delete_card", { id: "spending" });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toContain("built-in");
  });

  it("keeps the version before a change in the audit log", async () => {
    const { db, token, call } = await setup();
    const t = await token(["write:dashboard"]);
    const doc = builtinCardDoc("budget") as CardDoc;
    const made = (
      await call(t.token, "create_card", { title: "Before", doc, dry_run: false })
    ).json();
    await call(t.token, "update_card", { id: made.id, title: "After", doc, dry_run: false });
    const entry = db
      .select()
      .from(schema.auditLog)
      .all()
      .find((r) => r.action === "dashboard.card_update");
    expect(entry?.actorType).toBe("agent");
    expect(entry?.details).toMatchObject({ title: "After", previous: { title: "Before" } });
  });
});

describe("building cards and themes", () => {
  const doc = builtinCardDoc("budget") as CardDoc;
  const sand = BUILTIN_THEMES.find((x) => x.id === "sand") as Theme;
  const themeInput = { name: "Agent theme", mode: sand.mode, colors: sand.colors };

  it("only previews until told otherwise", async () => {
    const { token, call, client } = await setup();
    const t = await token([...READ_ALL, "write:dashboard"]);
    const dry = (await call(t.token, "create_card", { title: "Budget", doc })).json();
    expect(dry.dryRun).toBe(true);
    expect(dry.valid).toBe(true);
    expect((await client.get("/api/dashboard")).json<Dashboard>().customCards).toEqual([]);

    const dryTheme = (await call(t.token, "create_theme", themeInput)).json();
    expect(dryTheme.dryRun).toBe(true);
    expect((await client.get("/api/theme")).json<ThemeState>().custom).toEqual([]);
  });

  it("creates, changes and arranges cards when told to", async () => {
    const { db, token, call, client } = await setup();
    const t = await token(["write:dashboard"]);
    const made = (
      await call(t.token, "create_card", { title: "Budget", doc, dry_run: false })
    ).json();
    expect(made.saved).toBe(true);
    const board = (await client.get("/api/dashboard")).json<Dashboard>();
    expect(board.cards).toContain(made.ref);
    expect(board.customCards[0]?.createdBy).toBe(`agent:${t.id}`);

    const changed = await call(t.token, "update_card", {
      id: made.id,
      title: "Renamed",
      doc,
      dry_run: false,
    });
    expect(changed.json().saved).toBe(true);
    const audit = db.select().from(schema.auditLog).all();
    expect(JSON.stringify(audit)).toContain("card_update");

    const arranged = await call(t.token, "arrange_dashboard", {
      cards: [made.ref, "spending"],
      columns: { "2": [[made.ref], ["spending"]] },
      dry_run: false,
    });
    expect(arranged.json().saved).toBe(true);
    const after = (await client.get("/api/dashboard")).json<Dashboard>();
    expect(after.cards).toEqual([made.ref, "spending"]);
    expect(after.columns["2"]).toEqual([[made.ref], ["spending"]]);
    expect(after.customCards[0]?.title).toBe("Renamed");
    expect(after.customCards[0]?.createdBy).toBe(`agent:${t.id}`);

    expect((await call(t.token, "delete_card", { id: made.id, dry_run: false })).json().saved).toBe(
      true,
    );
    expect((await client.get("/api/dashboard")).json<Dashboard>().customCards).toEqual([]);
  });

  it("refuses broken cards, saying why", async () => {
    const { token, call } = await setup();
    const t = await token(["write:dashboard"]);
    const bad = await call(t.token, "create_card", {
      title: "x",
      dry_run: false,
      doc: { v: 2, blocks: [{ id: "b", kind: "stat", w: 6, options: { value: "$nope" } }] },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toContain("$nope");
    const script = await call(t.token, "create_card", {
      title: "x",
      doc: { v: 2, blocks: [], script: "alert(1)" },
    });
    expect(script.statusCode).toBe(400);
  });

  it("can't delete what people made", async () => {
    const { token, call, client } = await setup();
    const t = await token(["write:dashboard"]);
    const mine = (await client.post("/api/dashboard/cards", { title: "Mine", doc })).json<{
      id: string;
    }>();
    const res = await call(t.token, "delete_card", { id: mine.id, dry_run: false });
    expect(res.statusCode).toBe(403);
    expect((await client.get("/api/dashboard")).json<Dashboard>().customCards).toHaveLength(1);

    const theirs = (await client.post("/api/themes", themeInput)).json<Theme>();
    const themeRes = await call(t.token, "delete_theme", { id: theirs.id, dry_run: false });
    expect(themeRes.statusCode).toBe(403);
  });

  it("makes and applies themes, only for the token's person", async () => {
    const { token, call, client } = await setup();
    const t = await token(["write:dashboard"]);
    const made = (await call(t.token, "create_theme", { ...themeInput, dry_run: false })).json();
    expect(made.saved).toBe(true);
    await call(t.token, "set_theme", { id: made.id, dry_run: false });
    const state = (await client.get("/api/theme")).json<ThemeState>();
    expect(state.selected).toBe(made.id);
    expect((await call(t.token, "set_theme", { id: "nope", dry_run: false })).statusCode).toBe(400);
    const inject = await call(t.token, "create_theme", {
      ...themeInput,
      colors: { ...themeInput.colors, surface: "url(https://evil.example)" },
    });
    expect(inject.statusCode).toBe(400);
    expect(
      (await call(t.token, "delete_theme", { id: made.id, dry_run: false })).json().saved,
    ).toBe(true);
  });

  it("applies only display settings directly", async () => {
    const { token, call } = await setup();
    const t = await token(READ_ALL.concat("write:dashboard"));
    expect(TOOLS.filter((x) => x.write && x.scope === "write:dashboard").length).toBeGreaterThan(0);
    expect((await call(t.token, "categorize_transactions", {})).statusCode).toBe(403);
  });
});

describe("MCP", () => {
  let stop: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await stop?.();
    stop = undefined;
  });

  async function connect(scopes: AgentScope[]) {
    const ctx = await setup();
    const address = await ctx.app.listen({ port: 0, host: "127.0.0.1" });
    const t = await ctx.token(scopes);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${address}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${t.token}` } },
      }),
    );
    stop = async () => {
      await client.close();
      await ctx.app.close();
    };
    return { ...ctx, client, address };
  }

  it("talks to a real client: instructions, tools, calls and prompts", async () => {
    const { client } = await connect([...READ_ALL, "write:dashboard"]);
    expect(client.getInstructions()).toContain("integer cents");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["query_data", "create_card"]));
    expect(tools.every((t) => t.inputSchema.type === "object")).toBe(true);

    const out = await client.callTool({ name: "get_spending_by_category", arguments: {} });
    const text = (out.content as { text: string }[])[0]?.text ?? "";
    expect(JSON.parse(text).items[0]).toMatchObject({ name: "Groceries", cents: 4218 });

    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((p) => p.name)).toContain("savings_review");
    expect((await client.getPrompt({ name: "build_card" })).messages).toHaveLength(1);
  });

  it("only lists what a token can use, and reports refusals as tool errors", async () => {
    const { client } = await connect(["read:summary"]);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("get_budget_status");
    expect(names).not.toContain("search_transactions");
    expect(names).not.toContain("create_card");
    const refused = await client.callTool({ name: "search_transactions", arguments: {} });
    expect(refused.isError).toBe(true);
    expect((refused.content as { text: string }[])[0]?.text).toContain("read:transactions");
    const bad = await client.callTool({ name: "get_budget_status", arguments: { month: "nope" } });
    expect(bad.isError).toBe(true);
  });

  it("refuses requests with no token or from another site", async () => {
    const { address, token } = await connect(["read:summary"]);
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    expect((await fetch(`${address}/mcp`, { method: "POST", headers, body })).status).toBe(401);
    const t = await token(["read:summary"]);
    const cross = await fetch(`${address}/mcp`, {
      method: "POST",
      headers: { ...headers, authorization: `Bearer ${t.token}`, origin: "https://evil.example" },
      body,
    });
    expect(cross.status).toBe(403);
    expect((await fetch(`${address}/mcp`, { method: "GET" })).status).toBe(405);
  });
});

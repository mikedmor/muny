import type {
  Account,
  AiReview,
  AiSettings,
  CategoryGroup,
  ChangeList,
  ProposalList,
} from "@muny/shared";
import { describe, expect, it } from "vitest";
import { fileFromMuny } from "../agent/proposals.js";
import { localToday } from "../lib/dates.js";
import { transactionsAdded } from "../lib/events.js";
import { addMonths } from "../reports/spending.js";
import { makeSignedInApp } from "../test-utils.js";
import { autoCategorize, startAutoCategorize, tidyReview } from "./features.js";

// Synthetic data only. The AI server is a fake that answers from what it's sent.

const SECRET = Buffer.alloc(32, 7).toString("base64");

interface Sent {
  model: string;
  prompt: string;
}

async function setup(answer: (s: Sent) => string = () => "- Fine.\nNext month: keep going.") {
  const sent: Sent[] = [];
  const fetchFn = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const s = { model: body.model, prompt: body.messages?.[1]?.content ?? "" };
    sent.push(s);
    return new Response(JSON.stringify({ message: { content: answer(s) } }), {
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const ctx = await makeSignedInApp({
    env: { MUNY_SECRET_KEY: SECRET },
    aiFetch: fetchFn,
    aiSleep: async () => {},
  });
  await ctx.client.put("/api/ai", {
    enabled: true,
    provider: "ollama",
    model: "big-model",
    baseUrl: "http://ai.example.test",
  });
  const acc = (
    await ctx.client.post("/api/accounts", { name: "Sample Checking", type: "checking" })
  ).json<Account>();
  const cats = (await ctx.client.get("/api/categories"))
    .json<CategoryGroup[]>()
    .flatMap((g) => g.categories);
  const cat = (name: string) => cats.find((c) => c.name === name)?.id as string;
  const add = async (description: string, amountCents = -450, postedDate = localToday()) =>
    (
      await ctx.client.post("/api/transactions", {
        accountId: acc.id,
        postedDate,
        amountCents,
        description,
      })
    ).json<{ id: string }>().id;
  const deps = { secretKey: ctx.config.secretKey, fetch: fetchFn, sleep: async () => {} };
  const inbox = async () => (await ctx.client.get("/api/proposals")).json<ProposalList>();
  return { ...ctx, sent, cat, add, deps, inbox };
}

/** A categorize answer: every transaction in the prompt into `category`. */
const allInto = (category: string) => (s: Sent) => {
  const n = (s.prompt.match(/^\d+\. /gm) ?? []).length;
  return JSON.stringify({
    suggestions: Array.from({ length: n }, (_, i) => ({ n: i + 1, category })),
  });
};

describe("the review's shape", () => {
  it("turns a paragraph into points, and keeps Next month on its own line", () => {
    expect(
      tidyReview(
        "Income was $5,000.00, but spending hit $5,400.00. You overspent on Travel. Fuel held steady.\nNext month: plan travel ahead.",
      ),
    ).toBe(
      "- Income was $5,000.00, but spending hit $5,400.00.\n- You overspent on Travel.\n- Fuel held steady.\nNext month: plan travel ahead.",
    );
    // Next month folded into the paragraph.
    expect(tidyReview("Spending fell. Nice work. Next month: keep it up.")).toBe(
      "- Spending fell.\n- Nice work.\nNext month: keep it up.",
    );
    // Already in points: left as written, markdown dropped.
    expect(tidyReview("**Review**\n- One.\n\n- Two.\nnext month: three.")).toBe(
      "Review\n- One.\n- Two.\nNext month: three.",
    );
  });
});

describe("a model per job", () => {
  it("uses the job's model when set, and the main one otherwise", async () => {
    const { client, sent, add } = await setup((s) =>
      s.prompt.includes("Categories:") ? allInto("Food & Dining / Coffee")(s) : "- Fine.",
    );
    await add("CORNER CAFE");
    const put = await client.put("/api/ai", { models: { categorize: "small-model" } });
    expect(put.json<AiSettings>().models).toEqual({ categorize: "small-model" });
    await client.post("/api/ai/categorize", {});
    await client.post("/api/ai/review", {});
    expect(sent.map((s) => s.model)).toEqual(["small-model", "big-model"]);
    // Blank goes back to the main model.
    const cleared = await client.put("/api/ai", { models: { categorize: "" } });
    expect(cleared.json<AiSettings>().models).toEqual({});
  });
});

describe("suggesting categories after a sync", () => {
  it("does nothing unless it's turned on", async () => {
    const { db, deps, add, sent } = await setup();
    await add("CORNER CAFE");
    expect(await autoCategorize(db, deps)).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it("files suggestions as its own change, and never offers the same ones twice", async () => {
    const { client, db, deps, add, sent, inbox } = await setup(allInto("Food & Dining / Coffee"));
    await client.put("/api/ai", { features: { autoCategorize: true } });
    await add("CORNER CAFE");
    await add("ANOTHER CAFE", -600);
    const out = await autoCategorize(db, deps);
    expect(out).toMatchObject({ considered: 2, filed: 1 });
    const changes = (await client.get("/api/changes")).json<ChangeList>().items;
    expect(changes[0]).toMatchObject({
      title: "Suggested categories for 2 new transactions",
      actor: { type: "system", name: "Muny AI" },
    });

    // Turned down: not suggested again. Only the new one is sent.
    const [item] = (await inbox()).pending;
    await client.post("/api/proposals/decide", { ids: [item?.id], decision: "reject" });
    await add("THIRD CAFE", -700);
    await autoCategorize(db, deps);
    expect(sent.at(-1)?.prompt).toContain("THIRD CAFE");
    expect(sent.at(-1)?.prompt).not.toContain("CORNER CAFE");
  });

  it("runs a little after transactions arrive", async () => {
    const { client, db, deps, add, inbox } = await setup(allInto("Food & Dining / Coffee"));
    await client.put("/api/ai", { features: { autoCategorize: true } });
    await add("CORNER CAFE");
    const stop = startAutoCategorize(db, deps, { warn: () => {} }, 5);
    transactionsAdded(db);
    transactionsAdded(db); // a second sync right after: still one run
    await new Promise((r) => setTimeout(r, 150));
    stop();
    expect((await inbox()).pending).toHaveLength(1);
  });
});

describe("rules from what you approve", () => {
  it("offers a rule once a merchant has a few in one category", async () => {
    const { client, db, add: addRaw, cat, inbox } = await setup();
    const add = async (d: string, cents?: number) => {
      const id = await addRaw(d, cents);
      await client.patch(`/api/transactions/${id}`, { payeeName: "Corner Cafe" });
      return id;
    };
    const ids = [await add("CORNER CAFE"), await add("CORNER CAFE", -500)];
    const approve = async (txns: string[]) => {
      fileFromMuny(
        db,
        localToday(),
        "categorize_transactions",
        { transaction_ids: txns, category: cat("Coffee") },
        "Sample.",
      );
      const pending = (await inbox()).pending.filter((p) => p.tool === "categorize_transactions");
      await client.post("/api/proposals/decide", {
        ids: pending.map((p) => p.id),
        decision: "approve",
      });
    };
    await approve(ids);
    expect((await inbox()).pending.filter((p) => p.tool === "create_rule")).toHaveLength(0);

    await approve([await add("CORNER CAFE", -550)]);
    const rules = (await inbox()).pending.filter((p) => p.tool === "create_rule");
    expect(rules).toHaveLength(1);
    expect(rules[0]?.summary).toMatch(/→ Coffee/);
    expect(rules[0]?.reason).toContain("3");

    // Not offered again, whatever happens to it.
    await client.post("/api/proposals/decide", { ids: [rules[0]?.id], decision: "reject" });
    await approve([await add("CORNER CAFE", -560)]);
    expect((await inbox()).pending.filter((p) => p.tool === "create_rule")).toHaveLength(0);
  });
});

describe("the review's budget", () => {
  it("suggests one for the category that jumped, in the facts and the inbox, and keeps the review", async () => {
    const { client, sent, add, inbox } = await setup();
    const reviewed = addMonths(localToday().slice(0, 7), -1);
    for (const k of [1, 2, 3]) await add("NOODLE BAR", -9_550, `${addMonths(reviewed, -k)}-10`);
    await add("NOODLE BAR", -30_000, `${reviewed}-10`);
    // The merchant needs a category: put them all in Dining & Drinks.
    const groups = (await client.get("/api/categories")).json<CategoryGroup[]>();
    const dining = groups.flatMap((g) => g.categories).find((c) => c.name === "Dining & Drinks");
    const txns = (await client.get("/api/transactions?limit=50")).json<{
      items: { id: string }[];
    }>();
    for (const t of txns.items)
      await client.patch(`/api/transactions/${t.id}`, { categoryId: dining?.id });

    const r = await client.post("/api/ai/review", {});
    expect(r.statusCode).toBe(200);
    expect(sent.at(-1)?.prompt).toContain(
      "Budget Muny suggests, waiting in the inbox to approve: Dining & Drinks at $100.00 a month",
    );
    const budget = (await inbox()).pending.find((p) => p.tool === "set_budget");
    expect(budget?.summary).toMatch(/^Budget \$100\.00 a month for Dining & Drinks/);

    const reviews = (await client.get("/api/ai/reviews")).json<AiReview[]>();
    expect(reviews.map((x) => x.month)).toEqual([reviewed]);
  });

  it("doesn't offer a budget you turned down", async () => {
    const { client, sent, add, inbox } = await setup();
    const reviewed = addMonths(localToday().slice(0, 7), -1);
    for (const k of [1, 2, 3]) await add("NOODLE BAR", -9_550, `${addMonths(reviewed, -k)}-10`);
    await add("NOODLE BAR", -30_000, `${reviewed}-10`);
    const groups = (await client.get("/api/categories")).json<CategoryGroup[]>();
    const dining = groups.flatMap((g) => g.categories).find((c) => c.name === "Dining & Drinks");
    const txns = (await client.get("/api/transactions?limit=50")).json<{
      items: { id: string }[];
    }>();
    for (const t of txns.items)
      await client.patch(`/api/transactions/${t.id}`, { categoryId: dining?.id });
    await client.post("/api/ai/review", {});
    const budget = (await inbox()).pending.find((p) => p.tool === "set_budget");
    await client.post("/api/proposals/decide", { ids: [budget?.id], decision: "reject" });
    await client.post("/api/ai/review", {});
    expect(sent.at(-1)?.prompt).not.toContain("Budget Muny suggests");
    expect((await inbox()).pending.filter((p) => p.tool === "set_budget")).toHaveLength(0);
  });
});

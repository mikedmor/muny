import type {
  Account,
  AlertRule,
  CategoryGroup,
  NotificationChannel,
  NotificationList,
} from "@muny/shared";
import { describe, expect, it } from "vitest";
import { localToday } from "../lib/dates.js";
import { makeSignedInApp } from "../test-utils.js";

// Synthetic data only.

const SECRET = Buffer.alloc(32, 7).toString("base64");

async function setup(opts: Parameters<typeof makeSignedInApp>[0] = {}) {
  const ctx = await makeSignedInApp(opts);
  const { client } = ctx;
  const groups = (await client.get("/api/categories")).json<CategoryGroup[]>();
  const cat = (name: string) =>
    groups.flatMap((g) => g.categories).find((c) => c.name === name)?.id ?? null;
  const chk = (
    await client.post("/api/accounts", {
      name: "Everyday",
      type: "checking",
      balanceCents: 500_000,
      mask: "4321",
    })
  ).json<Account>();
  const card = (
    await client.post("/api/accounts", { name: "Card", type: "credit" })
  ).json<Account>();
  const add = (
    accountId: string,
    postedDate: string,
    amountCents: number,
    description: string,
    category?: string,
  ) =>
    client.post("/api/transactions", {
      accountId,
      postedDate,
      amountCents,
      description,
      categoryId: category ? cat(category) : null,
    });
  const run = async () => (await client.post("/api/alerts/run")).json<{ created: number }>();
  const list = async () => (await client.get("/api/notifications")).json<NotificationList>();
  return { ...ctx, chk, card, add, run, list, cat };
}

const today = localToday();

describe("alerts", () => {
  it("has every rule on by default with sensible thresholds", async () => {
    const { client } = await setup();
    const rules = (await client.get("/api/alerts/rules")).json<AlertRule[]>();
    expect(rules.map((r) => r.type)).toContain("large_transaction");
    expect(rules.every((r) => r.enabled)).toBe(true);
    expect(rules.find((r) => r.type === "low_balance")?.params.thresholdCents).toBe(10_000);
  });

  it("alerts on a large charge once, and marks it read", async () => {
    const { add, card, run, list, client } = await setup();
    await add(card.id, today, -75_000, "BIG TV STORE");
    await add(card.id, today, -1_000, "CORNER CAFE");
    expect((await run()).created).toBe(1);
    expect((await run()).created).toBe(0);
    const l = await list();
    expect(l.unread).toBe(1);
    expect(l.items[0]?.title).toBe("Large charge: $750.00 at Big TV Store");
    await client.post("/api/notifications/read", {});
    expect((await list()).unread).toBe(0);
  });

  it("spots duplicate charges", async () => {
    const { add, card, run, list } = await setup();
    await add(card.id, today, -4_999, "STREAMING CO");
    await add(card.id, today, -4_999, "STREAMING CO");
    await run();
    const titles = (await list()).items.map((n) => n.title);
    expect(titles).toContain("Possible duplicate: $49.99 at Streaming Co");
    expect(titles.filter((t) => t.startsWith("Possible duplicate"))).toHaveLength(1);
  });

  it("flags low balances once per dip", async () => {
    const { client, chk, run, list } = await setup();
    await client.patch(`/api/accounts/${chk.id}`, { balanceCents: 5_000 });
    await run();
    await run();
    const low = () => list().then((l) => l.items.filter((n) => n.ruleType === "low_balance"));
    expect(await low()).toHaveLength(1);
    expect((await low())[0]?.title).toBe("Low balance: Everyday is at $50.00");
    await client.patch(`/api/accounts/${chk.id}`, { balanceCents: 50_000 });
    await run();
    await client.patch(`/api/accounts/${chk.id}`, { balanceCents: 2_000 });
    await run();
    expect(await low()).toHaveLength(2);
  });

  it("warns at 80% and again when over budget", async () => {
    const { client, add, card, run, list } = await setup();
    await client.put("/api/budgets", { categoryId: null, amountCents: 10_000 });
    await add(card.id, today, -8_500, "GROCER", "Groceries");
    await run();
    await add(card.id, today, -2_000, "GROCER 2", "Groceries");
    await run();
    const titles = (await list()).items.filter((n) => n.ruleType === "budget").map((n) => n.title);
    expect(titles).toEqual([
      "Your total budget: over budget ($105.00 of $100.00)",
      "Your total budget: 85% of budget used",
    ]);
  });

  it("doesn't replay history when a rule is turned on", async () => {
    const { add, card, run, list, client } = await setup();
    await client.patch("/api/alerts/rules/large_transaction", { enabled: false });
    await add(card.id, today, -90_000, "OLD BIG THING");
    await run();
    await client.patch("/api/alerts/rules/large_transaction", { enabled: true });
    await run();
    expect((await list()).items.some((n) => n.ruleType === "large_transaction")).toBe(false);
  });

  it("sends to an ntfy channel without leaking secrets or account numbers", async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    let status = 200;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return new Response("ok", { status });
    }) as unknown as typeof fetch;
    const { client, add, card, run } = await setup({
      env: { MUNY_SECRET_KEY: SECRET, MUNY_PUBLIC_URL: "https://muny.example.ts.net" },
      alertFetch: fakeFetch,
    });
    const created = await client.post("/api/alerts/channels", {
      type: "ntfy",
      name: "Phone",
      config: { topic: "my-muny-alerts", token: "tk_supersecret" },
    });
    expect(created.statusCode).toBe(201);
    const chan = created.json<NotificationChannel>();
    expect(chan.summary).toBe("ntfy.sh / my-muny-alerts");
    expect(JSON.stringify(chan)).not.toContain("tk_supersecret");

    expect((await client.post(`/api/alerts/channels/${chan.id}/test`)).statusCode).toBe(200);
    await client.patch("/api/alerts/rules/large_transaction", { channelIds: [chan.id] });
    await add(card.id, today, -60_000, "BIG TV STORE");
    await run();

    const last = sent[sent.length - 1];
    expect(last?.url).toBe("https://ntfy.sh");
    const body = JSON.parse(String(last?.init.body));
    expect(body).toMatchObject({
      topic: "my-muny-alerts",
      title: "Large charge: $600.00 at Big TV Store",
      click: "https://muny.example.ts.net/transactions",
    });
    expect((last?.init.headers as Record<string, string> | undefined)?.authorization).toBe(
      "Bearer tk_supersecret",
    );
    expect(String(last?.init.body)).not.toContain("4321");

    // A failing channel records a short error and is retried on the next run.
    status = 500;
    await add(card.id, today, -70_000, "ANOTHER BIG ONE");
    await run();
    const ch = (await client.get("/api/alerts/channels")).json<NotificationChannel[]>()[0];
    expect(ch?.lastError).toBe("The server answered HTTP 500");
    status = 200;
    const before = sent.length;
    await run();
    expect(sent.length).toBe(before + 1);
  });

  it("rejects bad channel settings and needs the secret key", async () => {
    const { client } = await setup();
    const r = await client.post("/api/alerts/channels", {
      type: "webhook",
      name: "Hook",
      config: { url: "https://example.com/hook" },
    });
    expect(r.statusCode).toBe(409);
    const ok = await setup({ env: { MUNY_SECRET_KEY: SECRET } });
    const bad = await ok.client.post("/api/alerts/channels", {
      type: "webhook",
      name: "Hook",
      config: { url: "ftp://example.com" },
    });
    expect(bad.statusCode).toBe(400);
  });
});

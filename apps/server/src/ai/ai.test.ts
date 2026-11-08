import { schema } from "@muny/db";
import type {
  Account,
  AgentProposal,
  AiSettings,
  AppNotification,
  ProposalList,
} from "@muny/shared";
import { describe, expect, it } from "vitest";
import { localToday } from "../lib/dates.js";
import { makeSignedInApp } from "../test-utils.js";

// Synthetic data only. The provider is a fake: nothing leaves the test.

const SECRET = Buffer.alloc(32, 7).toString("base64");
const KEY = "sk-test-not-a-real-key";

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** A fake provider: records each request and answers with `reply`. */
function fakeProvider(reply: (seen: Seen) => { status?: number; json: unknown }) {
  const seen: Seen[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const s: Seen = {
      url: req.url,
      headers: Object.fromEntries(req.headers.entries()),
      body: JSON.parse((await req.text()) || "{}"),
    };
    seen.push(s);
    const r = reply(s);
    return new Response(JSON.stringify(r.json), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json", "request-id": "req_test" },
    });
  }) as typeof fetch;
  return { fetchFn, seen };
}

/** A Messages API reply carrying `text`. */
const claudeReply = (text: string, model = "claude-opus-5-5") => ({
  id: "msg_test",
  type: "message",
  role: "assistant",
  model,
  content: [{ type: "text", text }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 10 },
});

async function setup(reply: Parameters<typeof fakeProvider>[0]) {
  const fake = fakeProvider(reply);
  const ctx = await makeSignedInApp({ env: { MUNY_SECRET_KEY: SECRET }, aiFetch: fake.fetchFn });
  return { ...ctx, ...fake };
}

describe("built-in AI", () => {
  it("is off until set up, and never hands the key back", async () => {
    const { client, db, seen } = await setup(() => ({ json: {} }));
    const s = (await client.get("/api/ai")).json<AiSettings>();
    expect(s).toMatchObject({
      enabled: false,
      provider: "anthropic",
      hasKey: false,
      canStoreKey: true,
    });
    expect((await client.post("/api/ai/categorize", {})).statusCode).toBe(409);

    const put = await client.put("/api/ai", { enabled: true, key: KEY });
    expect(put.statusCode).toBe(200);
    expect(put.body).not.toContain(KEY);
    expect(put.json<AiSettings>().hasKey).toBe(true);
    // Stored encrypted; the audit log says only that it changed.
    const stored = JSON.stringify(db.select().from(schema.appSettings).all());
    expect(stored).not.toContain(KEY);
    expect(JSON.stringify(db.select().from(schema.auditLog).all())).not.toContain(KEY);
    expect(seen).toHaveLength(0);
  });

  it("files category suggestions from Claude in the inbox, with numbers masked", async () => {
    const { client, seen } = await setup((s) => {
      const prompt = JSON.stringify(s.body.messages);
      // Number the transactions as Muny did: newest first.
      const cafe = prompt.indexOf("CORNER CAFE") < prompt.indexOf("ACME PAYROLL") ? 1 : 2;
      const pay = cafe === 1 ? 2 : 1;
      return {
        json: claudeReply(
          JSON.stringify({
            suggestions: [
              { n: cafe, category: "Food & Dining / Coffee" },
              { n: pay, category: "Income / Paycheck" },
              { n: 3, category: "Food & Dining / Groceries" },
              { n: 4, category: null },
            ],
          }),
        ),
      };
    });
    const acc = (
      await client.post("/api/accounts", { name: "Checking", type: "checking" })
    ).json<Account>();
    const today = localToday();
    const add = (amountCents: number, description: string) =>
      client.post("/api/transactions", {
        accountId: acc.id,
        postedDate: today,
        amountCents,
        description,
      });
    await add(-450, "CORNER CAFE 1234567890");
    await add(250_000, "ACME PAYROLL");
    // Money in can't go to a spending category: this one is dropped.
    await add(3000, "MYSTERY REFUND");
    await add(-999, "UNKNOWN THING");
    await client.put("/api/ai", { enabled: true, key: KEY });

    const r = await client.post("/api/ai/categorize", {});
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ considered: 4, suggested: 2, filed: 2 });

    const req = seen[0] as Seen;
    expect(req.url).toContain("api.anthropic.com/v1/messages");
    expect(req.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(req.body).toMatchObject({ model: "claude-opus-5-5", fallbacks: "default" });
    const sent = JSON.stringify(req.body);
    expect(sent).not.toContain("1234567890");
    expect(sent).toContain("##########");
    expect(sent).not.toContain(KEY);

    const inbox = (await client.get("/api/proposals")).json<ProposalList>();
    expect(inbox.pending.map((p: AgentProposal) => p.tokenName)).toEqual(["Muny AI", "Muny AI"]);
    expect(inbox.pending.map((p: AgentProposal) => p.summary).sort()).toEqual([
      "Put 1 transaction in Coffee",
      "Put 1 transaction in Paycheck",
    ]);
  });

  it("writes last month's review through an OpenAI-compatible server", async () => {
    const { client, seen } = await setup(() => ({
      json: {
        choices: [
          { message: { content: "- You spent less than the month before.\n- Keep it up." } },
        ],
      },
    }));
    await client.put("/api/ai", {
      enabled: true,
      provider: "openai",
      model: "test-model",
      baseUrl: "https://ai.example.test/v1",
      key: KEY,
    });
    const r = await client.post("/api/ai/review", {});
    expect(r.statusCode).toBe(200);
    expect(r.json<{ text: string }>().text).toContain("You spent less");
    expect(seen[0]?.url).toBe("https://ai.example.test/v1/chat/completions");
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
    // Writing it again replaces it.
    await client.post("/api/ai/review", {});
    const reviews = (await client.get("/api/notifications")).json<AppNotification[]>();
    const mine = (
      Array.isArray(reviews) ? reviews : (reviews as { items: AppNotification[] }).items
    ).filter((n) => n.ruleType === "ai_review");
    expect(mine).toHaveLength(1);
    expect(mine[0]?.title).toMatch(/money review$/);
  });

  it("drafts a statement template, keeping only labels that find a value", async () => {
    const { client } = await setup(() => ({
      json: {
        message: {
          content: JSON.stringify({
            name: "Sample Bank",
            matchText: "samplebank.example",
            fields: [
              { key: "newBalanceCents", label: "New Balance" },
              { key: "minimumPaymentCents", label: "Not on this statement" },
              { key: "dueDate", label: null },
            ],
          }),
        },
      },
    }));
    await client.put("/api/ai", {
      enabled: true,
      provider: "ollama",
      baseUrl: "http://localhost:11434",
    });
    const r = await client.post("/api/ai/statement-template", {
      kind: "card",
      lines: [
        "Sample Bank samplebank.example",
        "Account 4111111111111111",
        "New Balance $1,234.56",
      ],
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      name: "Sample Bank",
      matchText: "samplebank.example",
      fields: { newBalanceCents: { label: "New Balance" } },
    });
  });

  it("says plainly when the provider refuses the key", async () => {
    const { client } = await setup(() => ({
      status: 401,
      json: {
        type: "error",
        error: { type: "authentication_error", message: "invalid x-api-key" },
      },
    }));
    await client.put("/api/ai", { enabled: true, key: KEY });
    const r = await client.post("/api/ai/test", {});
    expect(r.statusCode).toBe(502);
    expect(r.json<{ error: string }>().error).toBe("Anthropic rejected the API key.");
  });
});

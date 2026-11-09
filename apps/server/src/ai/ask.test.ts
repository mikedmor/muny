import type { AiAskResult, ProposalList } from "@muny/shared";
import { describe, expect, it } from "vitest";
import { makeSignedInApp } from "../test-utils.js";
import { maskResult } from "./ask.js";

// Synthetic only: every provider is a fake, and nothing leaves the test.

const SECRET = Buffer.alloc(32, 7).toString("base64");
type Body = Record<string, any>; // biome-ignore lint/suspicious/noExplicitAny: wire formats of three providers

async function setup(
  reply: (body: Body, n: number) => { status?: number; json: unknown },
  ai: Record<string, unknown> = {
    provider: "ollama",
    model: "sample-model",
    baseUrl: "http://ai.example.test",
  },
) {
  const sent: Body[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const raw = input instanceof Request ? await input.text() : String(init?.body ?? "{}");
    // Copied: the conversation array keeps growing after this call.
    const body = JSON.parse(raw) as Body;
    sent.push(body);
    const r = reply(body, sent.length - 1);
    return new Response(JSON.stringify(r.json), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json", "request-id": "req_test" },
    });
  }) as typeof fetch;
  const ctx = await makeSignedInApp({
    env: { MUNY_SECRET_KEY: SECRET },
    aiFetch: fetchFn,
    aiSleep: async () => {},
  });
  await ctx.client.put("/api/ai", { enabled: true, features: { ask: true }, ...ai });
  const ask = (question: string, history: unknown[] = []) =>
    ctx.client.post("/api/ai/ask", { question, history });
  return { ...ctx, sent, ask };
}

const ollamaCall = (name: string, args: unknown = {}) => ({
  json: { message: { content: "", tool_calls: [{ function: { name, arguments: args } }] } },
});
const ollamaText = (content: string) => ({ json: { message: { content } } });
const toolNames = (b: Body) => (b.tools as Body[]).map((t) => t.function.name as string);

describe("Ask Muny", () => {
  it("is off until it's turned on", async () => {
    const { client, sent } = await setup(() => ollamaText("no"));
    await client.put("/api/ai", { features: { ask: false } });
    expect((await client.post("/api/ai/ask", { question: "Hello?" })).statusCode).toBe(409);
    expect(sent).toHaveLength(0);
  });

  it("looks things up, answers from them, and says what it looked at", async () => {
    const { ask, sent } = await setup((_b, n) =>
      n === 0 ? ollamaCall("get_budget_status") : ollamaText("You have **no** budgets yet."),
    );
    const r = await ask("How are my budgets?");
    expect(r.statusCode).toBe(200);
    expect(r.json<AiAskResult>()).toEqual({
      answer: "You have no budgets yet.",
      looked: ["budgets"],
    });
    const back = (sent[1] as Body).messages.at(-1) as Body;
    expect(back).toMatchObject({ role: "tool", tool_name: "get_budget_status" });
    expect(JSON.parse(back.content)).toBeTruthy();
    expect((sent[1] as Body).messages.at(-2).tool_calls).toHaveLength(1);
  });

  it("offers only read-only tools, and refuses anything else it asks for", async () => {
    const { ask, client, sent } = await setup((_b, n) =>
      n === 0
        ? ollamaCall("create_rule", {
            name: "Sample",
            conditions: [{ field: "description", op: "contains", value: "X" }],
            actions: [{ type: "hide" }],
            dry_run: false,
          })
        : ollamaText("I can't change anything."),
    );
    const r = await ask("Hide everything");
    expect(r.statusCode).toBe(200);
    const offered = toolNames(sent[0] as Body);
    expect(offered).toContain("search_transactions");
    for (const name of ["create_rule", "create_card", "categorize_transactions", "set_theme"])
      expect(offered).not.toContain(name);
    expect((sent[1] as Body).messages.at(-1).content).toContain("no tool called create_rule");
    expect((await client.get("/api/proposals")).json<ProposalList>().pending).toHaveLength(0);
  });

  it("stops a model that never stops looking", async () => {
    const { ask, sent } = await setup(() => ollamaCall("get_budget_status"));
    const r = await ask("Forever?");
    expect(r.json<{ error: string }>().error).toContain("narrower question");
    expect(sent).toHaveLength(9);
  });

  it("carries earlier turns, for follow-ups", async () => {
    const { ask, sent } = await setup(() => ollamaText("Yes."));
    await ask("And before that?", [
      { role: "user", text: "Spending in May?" },
      { role: "assistant", text: "$10.00." },
    ]);
    expect(((sent[0] as Body).messages as Body[]).map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);
  });

  it("says when the model may not support tools", async () => {
    const { ask } = await setup(() => ({ status: 400, json: { error: "does not support tools" } }));
    expect((await ask("Hello?")).json<{ error: string }>().error).toContain(
      "may not support tools",
    );
  });

  it("speaks the OpenAI-compatible format", async () => {
    const { ask, sent } = await setup(
      (_b, n) => ({
        json: {
          choices: [
            {
              message:
                n === 0
                  ? {
                      content: null,
                      tool_calls: [
                        {
                          id: "call_1",
                          type: "function",
                          function: { name: "list_accounts", arguments: "{}" },
                        },
                      ],
                    }
                  : { content: "You have no accounts." },
            },
          ],
        },
      }),
      { provider: "openai", model: "sample", baseUrl: "https://ai.example.test/v1", key: "k" },
    );
    expect((await ask("Accounts?")).json<AiAskResult>().answer).toBe("You have no accounts.");
    expect((sent[1] as Body).messages.at(-1)).toMatchObject({
      role: "tool",
      tool_call_id: "call_1",
    });
  });

  it("speaks Claude's format, sending the whole reply back", async () => {
    const message = (content: unknown[], stop_reason: string) => ({
      json: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content,
        stop_reason,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 10 },
      },
    });
    const { ask, sent } = await setup(
      (_b, n) =>
        n === 0
          ? message(
              [
                { type: "thinking", thinking: "", signature: "sig" },
                { type: "tool_use", id: "toolu_1", name: "get_debts", input: {} },
              ],
              "tool_use",
            )
          : message([{ type: "text", text: "No debts." }], "end_turn"),
      { provider: "anthropic", key: "sk-test-not-a-real-key" },
    );
    const r = await ask("Debts?");
    expect(r.json<AiAskResult>()).toEqual({ answer: "No debts.", looked: ["debts"] });
    const [assistant, results] = ((sent[1] as Body).messages as Body[]).slice(-2);
    expect(assistant?.content[0]).toMatchObject({ type: "thinking", signature: "sig" });
    expect(results?.content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "toolu_1",
      is_error: false,
    });
    expect((sent[0] as Body).tools[0].input_schema.$schema).toBeUndefined();
  });

  it("hides long numbers in what it sends, but keeps ids usable", () => {
    expect(
      maskResult({
        transactionId: "01234567890",
        ids: ["1234567"],
        description: "ACH 123456789 SAMPLE",
        amountCents: 12_345_678,
        rows: [{ note: "ref 9876543" }],
      }),
    ).toEqual({
      transactionId: "01234567890",
      ids: ["1234567"],
      description: "ACH ######### SAMPLE",
      amountCents: 12_345_678,
      rows: [{ note: "ref #######" }],
    });
  });
});

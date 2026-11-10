import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { AiAskTurn } from "@muny/shared";
import type { z } from "zod";
import { type AiCall, AiCallError, type ChatTool, type ToolChat } from "./call.js";

/**
 * Claude through the official SDK. Only this file talks to Anthropic; other
 * providers are in compatible.ts. Nothing here logs the key or the content.
 */

/** Models that take the server-side fallback on a declined request. */
const FALLBACK_MODELS = new Set([
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-fable-5-1",
  "claude-sonnet-5-5",
]);
/** Models that take an effort setting (the 5 family). */
const takesEffort = (model: string) => /^claude-(opus|sonnet|haiku|fable)-5/.test(model);

function client(c: AiCall) {
  return new Anthropic({
    apiKey: c.apiKey ?? undefined,
    fetch: c.fetch,
    maxRetries: 1,
    timeout: c.mode === "background" ? 300_000 : 120_000,
  });
}

function common(c: AiCall) {
  return {
    model: c.model,
    max_tokens: c.maxTokens,
    system: c.system,
    messages: [{ role: "user" as const, content: c.prompt }],
    ...(FALLBACK_MODELS.has(c.model)
      ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
      : {}),
  };
}

function check(stop: string | null) {
  if (stop === "refusal") throw new AiCallError("The model declined this request.");
  if (stop === "max_tokens")
    throw new AiCallError("The model's answer was cut off.", { badAnswer: true });
}

/** Typed SDK errors to short messages (the provider's text never includes the key). */
function friendly(err: unknown): never {
  if (err instanceof AiCallError) throw err;
  if (err instanceof Anthropic.AuthenticationError)
    throw new AiCallError("Anthropic rejected the API key.");
  if (err instanceof Anthropic.PermissionDeniedError)
    throw new AiCallError("That API key can't use this model.");
  if (err instanceof Anthropic.NotFoundError)
    throw new AiCallError("Anthropic doesn't have that model. Check the model name.");
  if (err instanceof Anthropic.RateLimitError)
    throw new AiCallError("Anthropic is rate limiting this key. Try again in a minute.");
  if (err instanceof Anthropic.BadRequestError)
    throw new AiCallError(`Anthropic rejected the request: ${err.message.slice(0, 200)}`);
  if (err instanceof Anthropic.APIConnectionError)
    throw new AiCallError("Couldn't reach Anthropic.");
  if (err instanceof Anthropic.APIError)
    throw new AiCallError(`Anthropic returned an error (${err.status ?? "unknown"}).`);
  throw new AiCallError("The AI request failed.");
}

export async function anthropicJson<T>(c: AiCall, schema: z.ZodType<T>): Promise<T> {
  try {
    const msg = await client(c).beta.messages.parse({
      ...common(c),
      output_config: {
        ...(takesEffort(c.model) ? { effort: c.effort } : {}),
        format: betaZodOutputFormat(schema),
      },
    });
    check(msg.stop_reason);
    if (!msg.parsed_output)
      throw new AiCallError("The model's answer wasn't in the expected shape.", {
        badAnswer: true,
      });
    return msg.parsed_output as T;
  } catch (err) {
    friendly(err);
  }
}

export async function anthropicText(c: AiCall): Promise<string> {
  try {
    const msg = await client(c).beta.messages.create({
      ...common(c),
      ...(takesEffort(c.model) ? { output_config: { effort: c.effort } } : {}),
    });
    check(msg.stop_reason);
    return msg.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();
  } catch (err) {
    friendly(err);
  }
}

/** A conversation with tools. The whole reply goes back each turn, so thinking blocks stay in place. */
export function anthropicToolChat(c: AiCall, tools: ChatTool[], history: AiAskTurn[]): ToolChat {
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    ...history.map((t) => ({ role: t.role, content: t.text })),
    { role: "user", content: c.prompt },
  ];
  const api = client(c);
  const definitions = tools.map((t) => {
    const { $schema: _, ...schema } = t.parameters;
    return {
      name: t.name,
      description: t.description,
      input_schema: schema as Anthropic.Beta.BetaTool.InputSchema,
    };
  });
  return {
    async send(answers) {
      if (answers)
        messages.push({
          role: "user",
          content: answers.map((a) => ({
            type: "tool_result" as const,
            tool_use_id: a.id,
            content: a.content,
            is_error: a.isError,
          })),
        });
      try {
        for (;;) {
          const msg = await api.beta.messages.create({
            ...common(c),
            messages,
            tools: definitions,
            ...(takesEffort(c.model) ? { output_config: { effort: c.effort } } : {}),
          });
          check(msg.stop_reason);
          messages.push({ role: "assistant", content: msg.content });
          if (msg.stop_reason === "pause_turn") continue;
          return {
            text: msg.content
              .map((b) => (b.type === "text" ? b.text : ""))
              .join("")
              .trim(),
            calls: msg.content.flatMap((b) =>
              b.type === "tool_use" ? [{ id: b.id, name: b.name, input: b.input }] : [],
            ),
          };
        }
      } catch (err) {
        friendly(err);
      }
    },
  };
}

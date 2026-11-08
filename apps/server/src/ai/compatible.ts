import { z } from "zod";
import { type AiCall, AiCallError } from "./call.js";

/**
 * OpenAI-compatible servers (/chat/completions) and Ollama (/api/chat), over
 * plain HTTP to the address you set. JSON answers are checked against the
 * same schema as Claude's; the prompt spells the shape out.
 */

async function post(c: AiCall, path: string, body: unknown): Promise<unknown> {
  const base = (c.baseUrl ?? "").replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base))
    throw new AiCallError("Set the server address in Settings → AI.");
  let res: Response;
  try {
    res = await (c.fetch ?? fetch)(`${base}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(c.apiKey ? { authorization: `Bearer ${c.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new AiCallError("Couldn't reach the AI server.");
  }
  if (res.status === 401 || res.status === 403)
    throw new AiCallError("The AI server rejected the key.");
  if (res.status === 404)
    throw new AiCallError("The AI server doesn't have that model or address.");
  if (!res.ok) throw new AiCallError(`The AI server returned an error (${res.status}).`);
  try {
    return await res.json();
  } catch {
    throw new AiCallError("The AI server's answer wasn't JSON.");
  }
}

const OpenAiReply = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).min(1),
});
const OllamaReply = z.object({ message: z.object({ content: z.string() }) });

async function complete(c: AiCall, json: boolean): Promise<string> {
  const messages = [
    { role: "system", content: c.system },
    { role: "user", content: c.prompt },
  ];
  if (c.provider === "ollama") {
    const r = OllamaReply.safeParse(
      await post(c, "/api/chat", {
        model: c.model,
        messages,
        stream: false,
        ...(json ? { format: "json" } : {}),
      }),
    );
    if (!r.success) throw new AiCallError("Ollama's answer wasn't in the expected shape.");
    return r.data.message.content.trim();
  }
  const r = OpenAiReply.safeParse(
    await post(c, "/chat/completions", {
      model: c.model,
      messages,
      max_tokens: c.maxTokens,
      ...(json ? { response_format: { type: "json_object" } } : {}),
    }),
  );
  if (!r.success) throw new AiCallError("The AI server's answer wasn't in the expected shape.");
  return (r.data.choices[0]?.message.content ?? "").trim();
}

export const compatibleText = (c: AiCall) => complete(c, false);

export async function compatibleJson<T>(c: AiCall, schema: z.ZodType<T>): Promise<T> {
  const text = await complete(c, true);
  // Some models wrap JSON in a code fence.
  const body = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    throw new AiCallError("The model's answer wasn't JSON.");
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw new AiCallError("The model's answer wasn't in the expected shape.");
  return r.data;
}

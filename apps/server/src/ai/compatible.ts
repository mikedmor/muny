import { z } from "zod";
import { type AiCall, AiCallError } from "./call.js";

/**
 * OpenAI-compatible servers (/chat/completions) and Ollama (/api/chat), over
 * plain HTTP to the address you set. JSON answers are checked against the
 * same schema as Claude's; the prompt spells the shape out.
 *
 * A server shared by several computers can say why it can't answer yet: it's
 * downloading the model, everyone's busy, no computer is connected, or one
 * failed partway. It says so with a `code`, a Retry-After header and
 * `retry_after`/`details` in the body. Muny acts on those, never on the
 * message text, and waits and sends again within the limits below.
 */

/** How long to keep trying. Someone waiting on a button gets an answer quickly; background jobs wait. */
export const RETRY_POLICY = {
  interactive: { longestWait: 15, totalWait: 30, download: 30, timeout: 120 },
  background: { longestWait: 600, totalWait: 30 * 60, download: 30 * 60, timeout: 300 },
} as const;

const TRIES: Record<string, number> = {
  machine_failed: 2, // once more, which may go to another computer
  busy: 4,
  no_machines: 4,
  retry: 4, // a 429 or 503 with Retry-After, from any server
  model_downloading: Number.POSITIVE_INFINITY, // bounded by the download time instead
};

const Problem = z.object({
  code: z.string().max(40).optional(),
  retry_after: z.number().nullable().optional(),
  details: z.record(z.string(), z.unknown()).nullable().optional(),
});

/** One failed request, read into what Muny needs to decide. */
export interface AiProblem {
  status: number;
  code: string | null;
  /** Seconds to wait before sending again; null when it shouldn't be retried. */
  retryAfter: number | null;
  message: string;
  /** The message already says how long, so don't say it twice. */
  saysWait: boolean;
}

/** Names from the server, shown to the user: short, one line, no markup. */
const clean = (v: unknown) =>
  typeof v === "string" && v.trim()
    ? v
        .replace(/[\p{Cc}<>]/gu, "")
        .trim()
        .slice(0, 60)
    : null;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function waitWords(secs: number): string {
  if (secs < 60) return `${Math.max(1, Math.round(secs))} seconds`;
  const m = Math.round(secs / 60);
  if (m < 60) return m === 1 ? "1 minute" : `${m} minutes`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return `${h} hour${h === 1 ? "" : "s"}${rest ? ` ${rest} minute${rest === 1 ? "" : "s"}` : ""}`;
}

const ordinal = (n: number) =>
  n % 100 >= 11 && n % 100 <= 13 ? `${n}th` : `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;

function retryAfterHeader(v: string | null): number | null {
  if (!v) return null;
  if (/^\d+$/.test(v.trim())) return Number(v.trim());
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, (at - Date.now()) / 1000);
}

/** What a non-200 answer means, from its status, code, Retry-After and details. */
export function readProblem(
  status: number,
  body: unknown,
  header: string | null,
  model: string | null,
): AiProblem {
  const p = Problem.safeParse(body);
  const code = p.success ? (p.data.code ?? null) : null;
  const d = (p.success ? p.data.details : null) ?? {};
  const after = (p.success ? num(p.data.retry_after) : null) ?? retryAfterHeader(header);
  const eta = num(d.eta_secs);
  const out = (message: string, retryAfter: number | null): AiProblem => ({
    status,
    code,
    retryAfter,
    message,
    saysWait: message.includes(", about ") || message.includes("(about "),
  });

  if (code === "model_downloading") {
    const what = clean(d.model) ?? clean(model) ?? "the model";
    const where = clean(d.machine);
    const pct = num(d.percent);
    return out(
      `The AI server is downloading ${what}${where ? ` to ${where}` : ""}${pct !== null ? ` (${Math.floor(pct)}%)` : ""}${eta !== null ? `, about ${waitWords(eta)} left` : ""}.`,
      after ?? 60,
    );
  }
  if (code === "busy") {
    const pos = num(d.position);
    const wait = eta ?? after;
    return out(
      `The AI server is busy${pos !== null && pos > 0 ? ` (${ordinal(Math.round(pos))} in line${wait !== null ? `, about ${waitWords(wait)}` : ""})` : wait !== null ? ` (about ${waitWords(wait)})` : ""}.`,
      after ?? 30,
    );
  }
  if (code === "no_machines")
    return out("No computer is connected to the AI server right now.", after ?? 60);
  if (code === "machine_failed")
    return out("The computer running the model stopped partway through.", 5);
  if (code === "model_unavailable" || status === 404)
    return out(
      code === "model_unavailable"
        ? `No computer on the AI server has ${clean(model) ?? "that model"}, and none may download it. Choose another model in Settings → AI.`
        : "The AI server doesn't have that model or address.",
      null,
    );
  if (code === "bad_key" || status === 401 || status === 403)
    return out("The AI server rejected the key. Enter a new one in Settings → AI.", null);
  if (status === 429 || status === 503)
    return out(
      status === 429
        ? "The AI server is taking too many requests."
        : "The AI server is unavailable right now.",
      after,
    );
  return out(`The AI server returned an error (${status}).`, null);
}

const sleepFor = (secs: number) => new Promise<void>((r) => setTimeout(r, secs * 1000));

async function post(c: AiCall, path: string, body: unknown): Promise<unknown> {
  const base = (c.baseUrl ?? "").replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base))
    throw new AiCallError("Set the server address in Settings → AI.");
  const policy = RETRY_POLICY[c.mode ?? "interactive"];
  const sleep = c.sleep ?? sleepFor;
  const tries = new Map<string, number>();
  let waited = 0;
  let downloading = 0;

  for (;;) {
    let res: Response;
    try {
      res = await (c.fetch ?? fetch)(`${base}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(c.apiKey ? { authorization: `Bearer ${c.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(policy.timeout * 1000),
      });
    } catch {
      throw new AiCallError("Couldn't reach the AI server.");
    }
    if (res.ok) {
      try {
        return await res.json();
      } catch {
        throw new AiCallError("The AI server's answer wasn't JSON.");
      }
    }

    let raw: unknown = null;
    try {
      raw = await res.json();
    } catch {
      // Not JSON: go by the status and header.
    }
    const p = readProblem(res.status, raw, res.headers.get("retry-after"), c.model);
    const kind = p.code && p.code in TRIES ? p.code : "retry";
    const tried = (tries.get(kind) ?? 0) + 1;
    tries.set(kind, tried);
    // Asking again every second or two while a model downloads doesn't help anyone.
    const floor = kind === "model_downloading" || kind === "no_machines" ? 10 : 1;
    const wait = p.retryAfter === null ? null : Math.max(floor, Math.ceil(p.retryAfter));
    const background = c.mode === "background";
    const fits =
      wait !== null &&
      tried < (TRIES[kind] ?? 1) &&
      // Background jobs wait up to the cap; someone waiting on a button is told instead.
      (background || wait <= policy.longestWait) &&
      (kind === "model_downloading"
        ? downloading + Math.min(wait, policy.longestWait) <= policy.download
        : waited + Math.min(wait, policy.longestWait) <= policy.totalWait);
    if (!fits) {
      const when =
        wait === null || background
          ? ""
          : p.saysWait || wait <= 5
            ? " Try again shortly."
            : ` Try again in about ${waitWords(wait)}.`;
      throw new AiCallError(
        `${p.message}${when}`,
        wait === null ? { code: p.code } : { retryAfter: wait, code: p.code },
      );
    }
    const pause = Math.min(wait, policy.longestWait);
    if (kind === "model_downloading") downloading += pause;
    else waited += pause;
    c.onWait?.(p.message, pause);
    await sleep(pause);
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

import { schema } from "@muny/db";
import { eq, like } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { makeSignedInApp } from "../test-utils.js";
import { readProblem } from "./compatible.js";
import { monthlyReviewIfDue } from "./features.js";

// Synthetic only: the AI server is a fake, and waits are recorded rather than slept.

const SECRET = Buffer.alloc(32, 7).toString("base64");
const OK = { message: { content: "- You spent less than the month before." } };

type Answer = { status?: number; json: unknown; retryAfter?: number };

/** A fake shared AI server that answers from a script, then 200 once it runs out. */
async function setup(script: Answer[] | ((n: number) => Answer)) {
  let n = 0;
  const fetchFn = (async () => {
    const a = typeof script === "function" ? script(n) : (script[n] ?? { json: OK });
    n++;
    return new Response(JSON.stringify(a.json), {
      status: a.status ?? 200,
      headers: {
        "content-type": "application/json",
        ...(a.retryAfter !== undefined ? { "retry-after": String(a.retryAfter) } : {}),
      },
    });
  }) as unknown as typeof fetch;
  const slept: number[] = [];
  const sleep = async (s: number) => {
    slept.push(s);
  };
  const ctx = await makeSignedInApp({
    env: { MUNY_SECRET_KEY: SECRET },
    aiFetch: fetchFn,
    aiSleep: sleep,
  });
  await ctx.client.put("/api/ai", {
    enabled: true,
    provider: "ollama",
    model: "sample-model",
    baseUrl: "http://ai.example.test",
    features: { monthlyReview: true },
  });
  return {
    ...ctx,
    slept,
    sent: () => n,
    deps: { secretKey: ctx.config.secretKey, fetch: fetchFn, sleep },
  };
}

const busy = (eta: number, position = 2): Answer => ({
  status: 503,
  retryAfter: eta,
  json: {
    error: "Still waiting in line after 100 seconds. Try again shortly.",
    code: "busy",
    retry_after: eta,
    details: { position, eta_secs: eta },
  },
});
const downloading = (retry: number, percent: number, eta: number | null = retry): Answer => ({
  status: 503,
  retryAfter: retry,
  json: {
    error: "Downloading",
    code: "model_downloading",
    retry_after: retry,
    details: { model: "sample-model", machine: "DESKTOP", percent, eta_secs: eta },
  },
});
const noMachines: Answer = {
  status: 503,
  retryAfter: 60,
  json: { error: "No PC is connected", code: "no_machines", retry_after: 60 },
};
const machineFailed: Answer = {
  status: 502,
  retryAfter: 5,
  json: { error: "The PC failed", code: "machine_failed", retry_after: 5 },
};

describe("reading a shared AI server's answers", () => {
  it("goes by the code and details, not the message", () => {
    expect(readProblem(503, busy(35).json, "35", "m").message).toBe(
      "The AI server is busy (2nd in line, about 35 seconds).",
    );
    expect(readProblem(503, downloading(120, 42.7).json, "120", "m").message).toBe(
      "The AI server is downloading sample-model to DESKTOP (42%), about 2 minutes left.",
    );
    // No estimate yet (say, the only able computer is running a game).
    expect(readProblem(503, downloading(60, 3, null).json, "60", "m").message).toBe(
      "The AI server is downloading sample-model to DESKTOP (3%).",
    );
    expect(readProblem(503, noMachines.json, "60", "m")).toMatchObject({ retryAfter: 60 });
    const gone = readProblem(404, { code: "model_unavailable" }, null, "sample-model");
    expect(gone).toMatchObject({ retryAfter: null });
    expect(gone.message).toContain("sample-model");
    expect(readProblem(401, { code: "bad_key" }, null, "m")).toMatchObject({ retryAfter: null });
    // Any server: a 503 with only a Retry-After header can still be waited out.
    expect(readProblem(503, null, "20", "m")).toMatchObject({ retryAfter: 20 });
    expect(readProblem(500, null, null, "m")).toMatchObject({ retryAfter: null });
  });

  it("keeps names from the server short and plain", () => {
    const p = readProblem(
      503,
      { code: "model_downloading", details: { machine: `<b>${"X".repeat(200)}</b>\n` } },
      null,
      "m",
    );
    expect(p.message).not.toMatch(/[<>\n]/);
    expect(p.message.length).toBeLessThan(140);
  });
});

describe("when someone's waiting on the answer", () => {
  it("sends again once after a computer fails partway", async () => {
    const { client, slept, sent } = await setup([machineFailed]);
    const r = await client.post("/api/ai/test", {});
    expect(r.statusCode).toBe(200);
    expect(sent()).toBe(2);
    expect(slept).toEqual([5]);
  });

  it("gives up after the second failure", async () => {
    const { client, sent } = await setup([machineFailed, machineFailed]);
    const r = await client.post("/api/ai/test", {});
    expect(r.statusCode).toBe(503);
    expect(sent()).toBe(2);
  });

  it("says how long to wait instead of holding the page", async () => {
    const { client, slept, sent } = await setup([busy(35)]);
    const r = await client.post("/api/ai/review", {});
    expect(r.statusCode).toBe(503);
    expect(r.json()).toMatchObject({
      error: "The AI server is busy (2nd in line, about 35 seconds). Try again shortly.",
      details: { retryAfter: 35, code: "busy" },
    });
    expect(sent()).toBe(1);
    expect(slept).toEqual([]);

    const dl = await setup([downloading(300, 42)]);
    const d = await dl.client.post("/api/ai/test", {});
    expect(d.json<{ error: string }>().error).toBe(
      "The AI server is downloading sample-model to DESKTOP (42%), about 5 minutes left. Try again shortly.",
    );

    const none = await setup([noMachines]);
    const n = await none.client.post("/api/ai/test", {});
    expect(n.json<{ error: string }>().error).toBe(
      "No computer is connected to the AI server right now. Try again in about 1 minute.",
    );
  });

  it("waits out a short line by itself", async () => {
    const { client, slept } = await setup([busy(8, 1)]);
    expect((await client.post("/api/ai/test", {})).statusCode).toBe(200);
    expect(slept).toEqual([8]);
  });

  it("doesn't retry a missing model or a bad key", async () => {
    const gone = await setup(() => ({ status: 404, json: { code: "model_unavailable" } }));
    const r = await gone.client.post("/api/ai/test", {});
    expect(r.statusCode).toBe(502);
    expect(r.json<{ error: string }>().error).toContain("Choose another model");
    expect(gone.sent()).toBe(1);

    const key = await setup(() => ({ status: 401, json: { code: "bad_key" } }));
    expect((await key.client.post("/api/ai/test", {})).json<{ error: string }>().error).toBe(
      "The AI server rejected the key. Enter a new one in Settings → AI.",
    );
    expect(key.sent()).toBe(1);
  });
});

describe("the monthly review, in the background", () => {
  const today = "2026-11-03";
  const notes = (db: Awaited<ReturnType<typeof setup>>["db"]) =>
    db
      .select()
      .from(schema.notifications)
      .where(like(schema.notifications.dedupeKey, "ai_review%"))
      .all();

  it("waits out a model download, then writes it", async () => {
    const { db, deps, slept } = await setup([downloading(90, 10), downloading(30, 80), busy(45)]);
    expect(await monthlyReviewIfDue(db, deps, today)).toBe(true);
    expect(slept).toEqual([90, 30, 45]);
    expect(notes(db).map((n) => n.dedupeKey)).toEqual(["ai_review:2026-10"]);
  });

  it("caps each wait at 10 minutes and a download at 30", async () => {
    const { db, deps, slept, sent } = await setup(() => downloading(2400, 5));
    await expect(monthlyReviewIfDue(db, deps, today)).rejects.toThrow("downloading");
    expect(slept).toEqual([600, 600, 600]);
    expect(sent()).toBe(4);
  });

  it("says once that it couldn't, keeps trying, and clears that when it lands", async () => {
    let up = false;
    const { db, deps, slept } = await setup(() => (up ? { json: OK } : noMachines));
    await expect(monthlyReviewIfDue(db, deps, today)).rejects.toThrow("No computer");
    expect(slept).toEqual([60, 60, 60]);
    await expect(monthlyReviewIfDue(db, deps, today)).rejects.toThrow("No computer");
    const missed = notes(db);
    expect(missed).toHaveLength(1);
    expect(missed[0]).toMatchObject({
      ruleType: "ai_review",
      severity: "warning",
      title: "Couldn't write your October 2026 money review yet",
    });
    expect(missed[0]?.body).toContain("every hour until the 7th");

    up = true;
    expect(await monthlyReviewIfDue(db, deps, today)).toBe(true);
    expect(notes(db).map((n) => n.dedupeKey)).toEqual(["ai_review:2026-10"]);
    expect(
      db
        .select()
        .from(schema.notifications)
        .where(eq(schema.notifications.dedupeKey, "ai_review_missed:2026-10"))
        .all(),
    ).toHaveLength(0);
  });
});

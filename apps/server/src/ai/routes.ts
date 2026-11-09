import { type MunyDb, schema } from "@muny/db";
import {
  AI_MODEL_JOBS,
  AI_PROVIDERS,
  type AiAskResult,
  type AiReview,
  type AiSettings,
} from "@muny/shared";
import { desc } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireOwner, requireUser } from "../auth/plugin.js";
import { audit } from "../lib/audit.js";
import { localToday } from "../lib/dates.js";
import { HttpError, parse } from "../lib/http.js";
import { addMonths } from "../reports/spending.js";
import { askMuny } from "./ask.js";
import { AiCallError, askText } from "./call.js";
import {
  type AiDeps,
  draftTemplate,
  suggestCategories,
  suggestMerchantNames,
  writeCheckin,
  writeReview,
} from "./features.js";
import { AiSetupError, aiConnection, aiSettings, updateAiSettings } from "./settings.js";

/** Setup problems and provider failures as short messages; anything else stays a 500. */
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AiSetupError) throw new HttpError(409, err.message);
    // Worth trying again later (busy, downloading, no computer free): say when.
    if (err instanceof AiCallError && err.retryAfter !== undefined)
      throw new HttpError(503, err.message, { retryAfter: err.retryAfter, code: err.code });
    if (err instanceof AiCallError) throw new HttpError(502, err.message);
    throw err;
  }
}

export function registerAiRoutes(app: FastifyInstance, db: MunyDb, deps: AiDeps) {
  const log = (userId: string, action: string, details?: unknown) =>
    audit(db, { actorType: "user", actorId: userId, action, entityType: "ai", details });

  app.get("/api/ai", async (req): Promise<AiSettings> => {
    requireUser(req);
    return aiSettings(db, deps.secretKey);
  });

  app.put("/api/ai", async (req): Promise<AiSettings> => {
    const user = requireOwner(req);
    const body = parse(
      z.object({
        enabled: z.boolean().optional(),
        provider: z.enum(AI_PROVIDERS).optional(),
        model: z.string().trim().max(100).optional(),
        baseUrl: z
          .string()
          .trim()
          .max(300)
          .regex(/^(https?:\/\/\S+)?$/, "Use an http:// or https:// address")
          .nullable()
          .optional(),
        features: z
          .object({
            categorize: z.boolean().optional(),
            monthlyReview: z.boolean().optional(),
            statementTemplates: z.boolean().optional(),
            autoCategorize: z.boolean().optional(),
            merchantNames: z.boolean().optional(),
            midMonthCheckin: z.boolean().optional(),
            ask: z.boolean().optional(),
          })
          .optional(),
        models: z.partialRecord(z.enum(AI_MODEL_JOBS), z.string().trim().max(100)).optional(),
        key: z.string().max(500).nullable().optional(),
      }),
      req.body,
    );
    const out = await guard(async () => updateAiSettings(db, deps.secretKey, body));
    // Never the key itself.
    log(user.id, "ai.settings", {
      ...body,
      key: body.key === undefined ? undefined : body.key ? "changed" : "removed",
    });
    return out;
  });

  /** A tiny request, to check the provider, model and key work. */
  app.post("/api/ai/test", async (req) => {
    requireOwner(req);
    return guard(async () => {
      const conn = aiConnection(db, deps.secretKey);
      const reply = await askText({
        ...conn,
        fetch: deps.fetch,
        sleep: deps.sleep,
        effort: "low",
        maxTokens: 200,
        system: "Reply with the single word OK.",
        prompt: "Are you there?",
      });
      return { ok: true, reply: reply.slice(0, 40) };
    });
  });

  app.post("/api/ai/categorize", async (req) => {
    const user = requireUser(req);
    const out = await guard(() => suggestCategories(db, deps));
    log(user.id, "ai.categorize", out);
    return out;
  });

  app.post("/api/ai/review", async (req) => {
    const user = requireUser(req);
    const body = parse(
      z.object({
        month: z
          .string()
          .regex(/^\d{4}-\d{2}$/)
          .optional(),
      }),
      req.body ?? {},
    );
    const month = body.month ?? addMonths(localToday().slice(0, 7), -1);
    const text = await guard(() => writeReview(db, deps, month));
    log(user.id, "ai.review", { month });
    return { month, text };
  });

  app.post("/api/ai/merchant-names", async (req) => {
    const user = requireUser(req);
    const out = await guard(() => suggestMerchantNames(db, deps));
    log(user.id, "ai.merchantNames", out);
    return out;
  });

  app.post("/api/ai/checkin", async (req) => {
    const user = requireUser(req);
    const text = await guard(() => writeCheckin(db, deps));
    log(user.id, "ai.checkin");
    return { text };
  });

  /** A question in plain words. Read-only; viewers may ask too. The question isn't logged. */
  app.post("/api/ai/ask", async (req): Promise<AiAskResult> => {
    const user = requireUser(req);
    const body = parse(
      z.object({
        question: z.string().trim().min(1).max(1000),
        history: z
          .array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(8000) }))
          .max(12)
          .default([]),
      }),
      req.body,
    );
    const out = await guard(() => askMuny(db, deps, user.id, body.question, body.history));
    log(user.id, "ai.ask", { looked: out.looked });
    return out;
  });

  /** Every monthly review written, newest first (they stay after AI is turned off). */
  app.get("/api/ai/reviews", async (req): Promise<AiReview[]> => {
    requireUser(req);
    return db
      .select()
      .from(schema.aiReviews)
      .orderBy(desc(schema.aiReviews.month))
      .all()
      .map((r) => ({ month: r.month, body: r.body, createdAt: r.createdAt.getTime() }));
  });

  app.post("/api/ai/statement-template", async (req) => {
    requireUser(req);
    const body = parse(
      z.object({
        kind: z.enum(["card", "loan"]),
        lines: z.array(z.string().max(1000)).min(1).max(2000),
      }),
      req.body,
    );
    return guard(() => draftTemplate(db, deps, body.kind, body.lines));
  });
}

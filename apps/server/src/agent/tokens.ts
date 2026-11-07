import { createHash, randomBytes } from "node:crypto";
import { type MunyDb, newId, schema } from "@muny/db";
import {
  AGENT_SCOPES,
  type AgentActivity,
  type AgentScope,
  type ApiToken,
  type CreatedApiToken,
} from "@muny/shared";
import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireOwner } from "../auth/plugin.js";
import { RateLimiter } from "../auth/rate-limit.js";
import { audit } from "../lib/audit.js";
import { HttpError, notFound, parse } from "../lib/http.js";

/**
 * Bearer tokens for assistants and scripts. They only work on the agent surfaces
 * (/mcp and /api/v1), and sessions only work on the web app's routes, so neither
 * can stand in for the other. Only a hash is stored.
 */

export interface AgentContext {
  tokenId: string;
  scopes: Set<AgentScope>;
  /** Whose Overview and theme it changes. */
  userId: string;
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

const toApi = (t: typeof schema.apiTokens.$inferSelect): ApiToken => ({
  id: t.id,
  name: t.name,
  prefix: t.prefix,
  scopes: t.scopes as AgentScope[],
  createdAt: t.createdAt.getTime(),
  expiresAt: t.expiresAt?.getTime() ?? null,
  lastUsedAt: t.lastUsedAt?.getTime() ?? null,
  revokedAt: t.revokedAt?.getTime() ?? null,
});

const CreateSchema = z
  .object({
    name: z.string().trim().min(1, "Give the token a name").max(60),
    scopes: z.array(z.enum(AGENT_SCOPES)).min(1, "Choose at least one permission"),
    expiresInDays: z.number().int().min(1).max(3650).nullable(),
  })
  .strict();

const IdParams = z.object({ id: z.string().min(1).max(64) });

export function createApiToken(
  db: MunyDb,
  userId: string,
  input: z.infer<typeof CreateSchema>,
  now = Date.now(),
): CreatedApiToken {
  const token = `muny_${randomBytes(32).toString("base64url")}`;
  const row = db
    .insert(schema.apiTokens)
    .values({
      id: newId(),
      name: input.name,
      tokenHash: hashToken(token),
      prefix: token.slice(0, 12),
      scopes: [...new Set(input.scopes)],
      createdBy: userId,
      expiresAt:
        input.expiresInDays === null ? null : new Date(now + input.expiresInDays * 86_400_000),
    })
    .returning()
    .get();
  return { ...toApi(row), token };
}

/** 300 calls a minute per token: plenty for a conversation, not for a runaway loop. */
const limiter = new RateLimiter(300, 60_000);

/** The token behind a request, or a 401 saying only that it isn't valid. */
export function authenticateAgent(db: MunyDb, req: FastifyRequest): AgentContext {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const invalid = () => new HttpError(401, "A valid API token is required");
  if (!token.startsWith("muny_")) throw invalid();
  const row = db
    .select()
    .from(schema.apiTokens)
    .where(eq(schema.apiTokens.tokenHash, hashToken(token)))
    .get();
  const now = Date.now();
  if (!row || row.revokedAt || (row.expiresAt && row.expiresAt.getTime() <= now)) throw invalid();
  const wait = limiter.hit(row.id, now);
  if (wait > 0) throw new HttpError(429, `Too many requests. Try again in ${wait} seconds.`);
  if (!row.lastUsedAt || now - row.lastUsedAt.getTime() > 60_000)
    db.update(schema.apiTokens)
      .set({ lastUsedAt: new Date(now) })
      .where(eq(schema.apiTokens.id, row.id))
      .run();
  return {
    tokenId: row.id,
    scopes: new Set(row.scopes as AgentScope[]),
    userId: row.createdBy,
  };
}

/** Managing tokens is for the household's owner, signed in to the web app. */
export function registerTokenRoutes(app: FastifyInstance, db: MunyDb) {
  const t = schema.apiTokens;
  const log = (userId: string, action: string, id: string, details?: unknown) =>
    audit(db, {
      actorType: "user",
      actorId: userId,
      action,
      entityType: "api_token",
      entityId: id,
      details,
    });

  app.get("/api/agents/tokens", async (req): Promise<ApiToken[]> => {
    requireOwner(req);
    return db.select().from(t).orderBy(desc(t.createdAt)).all().map(toApi);
  });

  app.post("/api/agents/tokens", async (req, reply) => {
    const user = requireOwner(req);
    const created = createApiToken(db, user.id, parse(CreateSchema, req.body));
    log(user.id, "agent.token_create", created.id, {
      name: created.name,
      scopes: created.scopes,
    });
    return reply.code(201).send(created);
  });

  app.delete("/api/agents/tokens/:id", async (req) => {
    const user = requireOwner(req);
    const { id } = parse(IdParams, req.params);
    const done = db
      .update(t)
      .set({ revokedAt: new Date() })
      .where(and(eq(t.id, id)))
      .returning({ id: t.id })
      .get();
    if (!done) throw notFound("Token not found");
    log(user.id, "agent.token_revoke", id);
    return { ok: true };
  });

  app.get("/api/agents/tokens/:id/activity", async (req): Promise<AgentActivity[]> => {
    requireOwner(req);
    const { id } = parse(IdParams, req.params);
    const a = schema.auditLog;
    return db
      .select()
      .from(a)
      .where(and(eq(a.actorType, "agent"), eq(a.actorId, id)))
      .orderBy(desc(a.id))
      .limit(100)
      .all()
      .map((r) => {
        const d = (r.details ?? {}) as { ok?: boolean; dryRun?: boolean };
        return {
          at: r.at.getTime(),
          action: r.action.replace(/^agent\./, ""),
          ok: d.ok !== false,
          dryRun: !!d.dryRun,
        };
      });
  });
}

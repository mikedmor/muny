import { createHash, randomBytes } from "node:crypto";
import { type MunyDb, newId, schema } from "@muny/db";
import type { HouseholdInfo, InviteCreated, InviteStatus } from "@muny/shared";
import { and, desc, eq, gt, isNull, ne } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../lib/audit.js";
import { badRequest, conflict, HttpError, notFound, parse, unauthorized } from "../lib/http.js";
import { hashPassword, PASSWORD_MIN_LENGTH, verifyPassword } from "./password.js";
import { cookieOptions, requireOwner, requireUser } from "./plugin.js";
import { RateLimiter } from "./rate-limit.js";
import { createSession, SESSION_COOKIE } from "./sessions.js";

/**
 * Household members. The owner creates single-use invite links (no email is
 * sent; Muny makes no outbound calls for this) for a member (full access) or
 * a viewer (read-only). Invite tokens are random, stored hashed, expire after
 * 7 days and work once.
 */

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const email = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ message: "Enter a valid email address" }));
const password = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(256);
const IdParams = z.object({ id: z.string().min(1).max(64) });
const TokenParams = z.object({ token: z.string().min(20).max(100) });

export function registerHouseholdRoutes(app: FastifyInstance, db: MunyDb) {
  const limiter = new RateLimiter(20, 15 * 60 * 1000);
  const u = schema.users;
  const inv = schema.invites;

  const findInvite = (token: string) =>
    db
      .select()
      .from(inv)
      .where(
        and(eq(inv.tokenHash, sha256(token)), isNull(inv.usedAt), gt(inv.expiresAt, new Date())),
      )
      .get();

  app.get("/api/household", async (req): Promise<HouseholdInfo> => {
    const me = requireUser(req);
    const users = db
      .select({
        id: u.id,
        email: u.email,
        displayName: u.displayName,
        role: u.role,
        createdAt: u.createdAt,
      })
      .from(u)
      .orderBy(u.createdAt)
      .all()
      .map((x) => ({ ...x, createdAt: x.createdAt.getTime(), isYou: x.id === me.id }));
    const invites =
      me.role === "owner"
        ? db
            .select({
              id: inv.id,
              role: inv.role,
              expiresAt: inv.expiresAt,
              createdAt: inv.createdAt,
            })
            .from(inv)
            .where(and(isNull(inv.usedAt), gt(inv.expiresAt, new Date())))
            .orderBy(desc(inv.createdAt))
            .all()
            .map((i) => ({
              ...i,
              expiresAt: i.expiresAt.getTime(),
              createdAt: i.createdAt.getTime(),
            }))
        : [];
    return { users, invites };
  });

  app.post("/api/household/invites", async (req, reply): Promise<InviteCreated> => {
    const owner = requireOwner(req);
    const { role } = parse(z.object({ role: z.enum(["member", "viewer"]) }), req.body);
    const token = randomBytes(24).toString("base64url");
    const id = newId();
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
    db.insert(inv)
      .values({ id, tokenHash: sha256(token), role, createdBy: owner.id, expiresAt })
      .run();
    audit(db, {
      actorType: "user",
      actorId: owner.id,
      action: "household.invite",
      entityType: "invite",
      entityId: id,
      details: { role },
    });
    reply.code(201);
    // The token is only ever returned here; Muny keeps just its hash.
    return { id, role, token, path: `/invite/${token}`, expiresAt: expiresAt.getTime() };
  });

  app.delete("/api/household/invites/:id", async (req) => {
    const owner = requireOwner(req);
    const { id } = parse(IdParams, req.params);
    if (db.delete(inv).where(eq(inv.id, id)).run().changes === 0)
      throw notFound("Invite not found");
    audit(db, {
      actorType: "user",
      actorId: owner.id,
      action: "household.invite_revoke",
      entityType: "invite",
      entityId: id,
    });
    return { ok: true };
  });

  app.patch("/api/household/users/:id", async (req) => {
    const owner = requireOwner(req);
    const { id } = parse(IdParams, req.params);
    const { role } = parse(z.object({ role: z.enum(["member", "viewer"]) }), req.body);
    if (id === owner.id) throw badRequest("You can't change your own role.");
    if (
      db
        .update(u)
        .set({ role })
        .where(and(eq(u.id, id), ne(u.role, "owner")))
        .run().changes === 0
    )
      throw notFound("User not found");
    audit(db, {
      actorType: "user",
      actorId: owner.id,
      action: "household.role",
      entityType: "user",
      entityId: id,
      details: { role },
    });
    return { ok: true };
  });

  app.delete("/api/household/users/:id", async (req) => {
    const owner = requireOwner(req);
    const { id } = parse(IdParams, req.params);
    if (id === owner.id) throw badRequest("You can't remove yourself.");
    // Sessions cascade; shared data (transactions etc.) belongs to the household and stays.
    if (
      db
        .delete(u)
        .where(and(eq(u.id, id), ne(u.role, "owner")))
        .run().changes === 0
    )
      throw notFound("User not found");
    audit(db, {
      actorType: "user",
      actorId: owner.id,
      action: "household.remove",
      entityType: "user",
      entityId: id,
    });
    return { ok: true };
  });

  // --- Public: accepting an invite --------------------------------------------

  app.get("/api/invites/:token", async (req): Promise<InviteStatus> => {
    const { token } = parse(TokenParams, req.params);
    const i = findInvite(token);
    return i ? { valid: true, role: i.role, expiresAt: i.expiresAt.getTime() } : { valid: false };
  });

  app.post("/api/invites/:token/accept", async (req, reply) => {
    const retryAfter = limiter.hit(`ip:${req.ip}`);
    if (retryAfter > 0) {
      reply.header("retry-after", String(retryAfter));
      throw new HttpError(429, "Too many attempts. Try again later.");
    }
    const { token } = parse(TokenParams, req.params);
    const body = parse(
      z.object({ email, password, displayName: z.string().trim().max(100).optional() }),
      req.body,
    );
    const passwordHash = await hashPassword(body.password);
    const userId = newId();
    const result = db.transaction((tx) => {
      const i = tx
        .select()
        .from(inv)
        .where(
          and(eq(inv.tokenHash, sha256(token)), isNull(inv.usedAt), gt(inv.expiresAt, new Date())),
        )
        .get();
      if (!i) return "invalid" as const;
      if (tx.select({ id: u.id }).from(u).where(eq(u.email, body.email)).get())
        return "taken" as const;
      tx.insert(u)
        .values({
          id: userId,
          email: body.email,
          displayName: body.displayName || null,
          passwordHash,
          role: i.role,
        })
        .run();
      tx.update(inv).set({ usedAt: new Date(), usedBy: userId }).where(eq(inv.id, i.id)).run();
      return i.role;
    });
    if (result === "invalid")
      throw notFound("This invite link is invalid, used or expired. Ask for a new one.");
    if (result === "taken")
      throw conflict("An account with that email already exists. Sign in instead.");
    audit(db, {
      actorType: "user",
      actorId: userId,
      action: "household.join",
      entityType: "user",
      entityId: userId,
      details: { role: result },
    });
    const session = createSession(db, userId);
    reply.setCookie(SESSION_COOKIE, session.token, cookieOptions(req, session.expiresAt));
    return reply.code(201).send({ ok: true });
  });

  // --- Own account --------------------------------------------------------------

  /** Change your password; signs out your other sessions. */
  app.post("/api/auth/password", async (req) => {
    const me = requireUser(req);
    const body = parse(
      z.object({ currentPassword: z.string().min(1).max(256), newPassword: password }),
      req.body,
    );
    const row = db.select().from(u).where(eq(u.id, me.id)).get();
    if (!row || !(await verifyPassword(body.currentPassword, row.passwordHash)))
      throw unauthorized("Your current password is incorrect");
    db.update(u)
      .set({ passwordHash: await hashPassword(body.newPassword) })
      .where(eq(u.id, me.id))
      .run();
    const current = req.cookies[SESSION_COOKIE];
    const keep = current ? sha256(current) : "";
    db.delete(schema.sessions)
      .where(and(eq(schema.sessions.userId, me.id), ne(schema.sessions.idHash, keep)))
      .run();
    audit(db, { actorType: "user", actorId: me.id, action: "auth.password_change" });
    return { ok: true };
  });
}

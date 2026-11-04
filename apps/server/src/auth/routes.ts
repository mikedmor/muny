import { type MunyDb, newId, schema } from "@muny/db";
import type { AuthStatusResponse } from "@muny/shared";
import { count, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { seedDefaultCategories } from "../ledger/seed.js";
import { audit } from "../lib/audit.js";
import { conflict, HttpError, parse, unauthorized } from "../lib/http.js";
import { dummyVerify, hashPassword, PASSWORD_MIN_LENGTH, verifyPassword } from "./password.js";
import { cookieOptions } from "./plugin.js";
import { RateLimiter } from "./rate-limit.js";
import { createSession, deleteSession, SESSION_COOKIE } from "./sessions.js";

const email = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ message: "Enter a valid email address" }));
const password = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(256);

const SetupBody = z.object({
  email,
  password,
  displayName: z.string().trim().max(100).optional(),
});
const LoginBody = z.object({ email, password: z.string().min(1).max(256) });

export function registerAuthRoutes(app: FastifyInstance, db: MunyDb) {
  // 10 attempts per 15 minutes per IP and per email.
  const limiter = new RateLimiter(10, 15 * 60 * 1000);

  const userCount = () => db.select({ n: count() }).from(schema.users).get()?.n ?? 0;

  app.get("/api/auth/status", async (req): Promise<AuthStatusResponse> => {
    return { setupRequired: userCount() === 0, user: req.user };
  });

  /** First-run: create the owner account. Only works while there are no users. */
  app.post("/api/auth/setup", async (req, reply) => {
    const body = parse(SetupBody, req.body);
    const passwordHash = await hashPassword(body.password);

    const userId = newId();
    const created = db.transaction((tx) => {
      const n = tx.select({ n: count() }).from(schema.users).get()?.n ?? 0;
      if (n > 0) return false;
      tx.insert(schema.users)
        .values({
          id: userId,
          email: body.email,
          displayName: body.displayName || null,
          passwordHash,
          role: "owner",
        })
        .run();
      return true;
    });
    if (!created) throw conflict("Muny is already set up. Sign in instead.");
    seedDefaultCategories(db);

    audit(db, {
      actorType: "user",
      actorId: userId,
      action: "auth.setup",
      entityType: "user",
      entityId: userId,
    });
    const session = createSession(db, userId);
    reply.setCookie(SESSION_COOKIE, session.token, cookieOptions(req, session.expiresAt));
    return reply.code(201).send({ ok: true });
  });

  app.post("/api/auth/login", async (req, reply) => {
    const body = parse(LoginBody, req.body);
    for (const key of [`ip:${req.ip}`, `email:${body.email}`]) {
      const retryAfter = limiter.hit(key);
      if (retryAfter > 0) {
        reply.header("retry-after", String(retryAfter));
        throw new HttpError(429, "Too many sign-in attempts. Try again later.");
      }
    }

    const user = db.select().from(schema.users).where(eq(schema.users.email, body.email)).get();
    const ok = user
      ? await verifyPassword(body.password, user.passwordHash)
      : await dummyVerify(body.password);
    if (!user || !ok) {
      audit(db, { actorType: "system", action: "auth.login_failed", details: { ip: req.ip } });
      throw unauthorized("Incorrect email or password");
    }

    limiter.reset(`email:${body.email}`);
    const session = createSession(db, user.id);
    audit(db, {
      actorType: "user",
      actorId: user.id,
      action: "auth.login",
      details: { ip: req.ip },
    });
    reply.setCookie(SESSION_COOKIE, session.token, cookieOptions(req, session.expiresAt));
    return { ok: true };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) deleteSession(db, token);
    if (req.user) audit(db, { actorType: "user", actorId: req.user.id, action: "auth.logout" });
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });
}

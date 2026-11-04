import type { MunyDb } from "@muny/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { forbidden, unauthorized } from "../lib/http.js";
import { SESSION_COOKIE, type SessionUser, validateSession } from "./sessions.js";

declare module "fastify" {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

/** Routes reachable without a session. */
const PUBLIC_ROUTES = new Set([
  "GET /api/health",
  "GET /api/meta",
  "GET /api/auth/status",
  "POST /api/auth/setup",
  "POST /api/auth/login",
  "POST /api/auth/logout",
  "GET /api/invites/:token",
  "POST /api/invites/:token/accept",
]);

/** The only changes a read-only (viewer) user may make. */
const VIEWER_WRITES = new Set(["POST /api/auth/logout", "POST /api/auth/password"]);

/** Header the web client sends on every mutating request (see SECURITY.md). */
export const CSRF_HEADER = "x-muny-csrf";

export function cookieOptions(req: FastifyRequest, expires: Date) {
  return {
    path: "/",
    httpOnly: true,
    sameSite: "lax" as const,
    // Set Secure when served over HTTPS (directly or via reverse proxy).
    secure: req.protocol === "https",
    expires,
  };
}

export function registerAuth(app: FastifyInstance, db: MunyDb) {
  app.decorateRequest("user", null);

  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith("/api/")) return;

    // CSRF: a custom header can't be sent cross-site without a CORS preflight,
    // which this server never approves.
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.headers[CSRF_HEADER] !== "1") {
      throw forbidden("Missing CSRF header");
    }

    const token = req.cookies[SESSION_COOKIE];
    if (token) {
      const session = validateSession(db, token);
      if (session) {
        req.user = session.user;
        if (session.renewed) {
          reply.setCookie(SESSION_COOKIE, token, cookieOptions(req, session.expiresAt));
        }
      }
    }

    const routeKey = `${req.method} ${req.routeOptions.url ?? req.url.split("?")[0]}`;
    if (!req.user && !PUBLIC_ROUTES.has(routeKey)) throw unauthorized();
    if (
      req.user?.role === "viewer" &&
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      !VIEWER_WRITES.has(routeKey)
    ) {
      throw forbidden("You have view-only access to this household.");
    }
  });
}

/** Household administration and backups (which contain password hashes) are owner-only. */
export function requireOwner(req: FastifyRequest): SessionUser {
  const user = requireUser(req);
  if (user.role !== "owner") throw forbidden("Only the household owner can do this.");
  return user;
}

export function requireUser(req: FastifyRequest): SessionUser {
  if (!req.user) throw unauthorized();
  return req.user;
}

import { createHash, randomBytes } from "node:crypto";
import { type MunyDb, schema } from "@muny/db";
import { and, eq, gt, lt } from "drizzle-orm";

export const SESSION_COOKIE = "muny_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, sliding
const RENEW_AFTER_MS = 24 * 60 * 60 * 1000; // extend at most once a day

export interface SessionUser {
  id: string;
  email: string;
  displayName: string | null;
  role: "owner" | "member" | "viewer";
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Create a session and return the raw token (only ever stored in the cookie). */
export function createSession(db: MunyDb, userId: string): { token: string; expiresAt: Date } {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  db.insert(schema.sessions)
    .values({ idHash: sha256(token), userId, expiresAt })
    .run();
  return { token, expiresAt };
}

/** Resolve a session token to its user, sliding the expiry forward. */
export function validateSession(
  db: MunyDb,
  token: string,
): { user: SessionUser; expiresAt: Date; renewed: boolean } | null {
  const idHash = sha256(token);
  const now = new Date();
  const row = db
    .select({
      expiresAt: schema.sessions.expiresAt,
      id: schema.users.id,
      email: schema.users.email,
      displayName: schema.users.displayName,
      role: schema.users.role,
    })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(and(eq(schema.sessions.idHash, idHash), gt(schema.sessions.expiresAt, now)))
    .get();
  if (!row) return null;

  let expiresAt = row.expiresAt;
  let renewed = false;
  if (expiresAt.getTime() - now.getTime() < SESSION_TTL_MS - RENEW_AFTER_MS) {
    expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    db.update(schema.sessions).set({ expiresAt }).where(eq(schema.sessions.idHash, idHash)).run();
    renewed = true;
  }
  const { id, email, displayName, role } = row;
  return { user: { id, email, displayName, role }, expiresAt, renewed };
}

export function deleteSession(db: MunyDb, token: string): void {
  db.delete(schema.sessions)
    .where(eq(schema.sessions.idHash, sha256(token)))
    .run();
}

export function purgeExpiredSessions(db: MunyDb): number {
  return db.delete(schema.sessions).where(lt(schema.sessions.expiresAt, new Date())).run().changes;
}

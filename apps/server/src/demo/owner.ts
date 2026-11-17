import { type MunyDb, newId, schema } from "@muny/db";
import { count } from "drizzle-orm";
import { hashPassword } from "../auth/password.js";
import { seedDefaultCategories } from "../ledger/seed.js";

/**
 * A public demo's owner account (MUNY_DEMO_OWNER, only with MUNY_DEMO): made at start on an
 * empty install, so a demo that's wiped and started again (as the one for app-store reviewers
 * is, every hour) can be signed in to with a short, shared password like "demo". The usual
 * password length doesn't apply: it's a demo with made-up data, and nothing here is private.
 */
export async function ensureDemoOwner(
  db: MunyDb,
  owner: { email: string; password: string },
): Promise<boolean> {
  const users = db.select({ n: count() }).from(schema.users).get()?.n ?? 0;
  if (users > 0) return false;
  const passwordHash = await hashPassword(owner.password);
  db.insert(schema.users)
    .values({
      id: newId(),
      email: owner.email,
      displayName: "Demo",
      passwordHash,
      role: "owner",
    })
    .run();
  seedDefaultCategories(db);
  return true;
}

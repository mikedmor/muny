import type { MunyDb } from "@muny/db";
import type { FastifyInstance } from "fastify";
import { requireOwner, requireUser } from "../auth/plugin.js";
import { seedDefaultCategories } from "../ledger/seed.js";
import { audit } from "../lib/audit.js";
import { HttpError } from "../lib/http.js";
import { clearDemo, demoActive } from "./seed.js";

export function registerDemoRoutes(app: FastifyInstance, db: MunyDb) {
  app.get("/api/demo", async (req) => {
    requireUser(req);
    return { active: demoActive(db) };
  });

  /** Remove the made-up household and everything added since; keep people and settings. */
  app.post("/api/demo/clear", async (req) => {
    const user = requireOwner(req);
    if (!demoActive(db)) throw new HttpError(409, "There's no demo data to remove.");
    clearDemo(db, seedDefaultCategories);
    audit(db, {
      actorType: "user",
      actorId: user.id,
      action: "demo.clear",
      entityType: "household",
    });
    return { ok: true };
  });
}

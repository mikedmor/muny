import type { MunyDb } from "@muny/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireOwner, requireUser } from "../auth/plugin.js";
import { audit } from "../lib/audit.js";
import { parse } from "../lib/http.js";
import { describeChange } from "../undo/track.js";
import { checkForUpdates, setUpdatesEnabled, type UpdateDeps, updateStatus } from "./service.js";

/** Settings → Updates: what's running, whether a newer release is out, and the switch (owner only). */
export function registerUpdateRoutes(app: FastifyInstance, db: MunyDb, deps: UpdateDeps) {
  app.get("/api/updates", async (req) => {
    requireUser(req);
    return updateStatus(db, deps.sourceUrl);
  });

  app.put("/api/updates", async (req) => {
    const user = requireOwner(req);
    const { enabled } = parse(z.object({ enabled: z.boolean() }), req.body);
    setUpdatesEnabled(db, enabled);
    describeChange(db, enabled ? "Turned on the update check" : "Turned off the update check");
    audit(db, {
      actorType: "user",
      actorId: user.id,
      action: "settings.updates",
      entityType: "settings",
      details: { enabled },
    });
    // Turning it on checks right away, so you see the answer.
    return enabled ? checkForUpdates(db, deps) : updateStatus(db, deps.sourceUrl);
  });

  app.post("/api/updates/check", async (req) => {
    requireOwner(req);
    const s = updateStatus(db, deps.sourceUrl);
    if (!s.enabled) return s;
    // Pressing it again within a minute gets the same answer.
    if (s.checkedAt && Date.now() - s.checkedAt < 60_000) return s;
    return checkForUpdates(db, deps);
  });
}

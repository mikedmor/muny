import { type MunyDb, schema } from "@muny/db";
import type { UiPrefs } from "@muny/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/plugin.js";
import { parse } from "../lib/http.js";

/** Display preferences for the household (Settings → Display). */

const KEY = "ui.prefs";
const DEFAULTS: UiPrefs = { splitCharts: true };

export function getUiPrefs(db: MunyDb): UiPrefs {
  const v = db
    .select({ value: schema.appSettings.value })
    .from(schema.appSettings)
    .where(eq(schema.appSettings.key, KEY))
    .get()?.value as Partial<UiPrefs> | undefined;
  return { ...DEFAULTS, ...v };
}

export function registerPrefsRoutes(app: FastifyInstance, db: MunyDb) {
  app.get("/api/settings/ui", async (req) => {
    requireUser(req);
    return getUiPrefs(db);
  });
  app.put("/api/settings/ui", async (req) => {
    requireUser(req);
    const patch = parse(z.object({ splitCharts: z.boolean().optional() }), req.body);
    const next = { ...getUiPrefs(db), ...patch };
    db.insert(schema.appSettings)
      .values({ key: KEY, value: next })
      .onConflictDoUpdate({ target: schema.appSettings.key, set: { value: next } })
      .run();
    return next;
  });
}

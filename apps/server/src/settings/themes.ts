import { type MunyDb, newId, schema } from "@muny/db";
import {
  BUILTIN_THEMES,
  HEX_COLOR,
  MAX_CUSTOM_THEMES,
  SYSTEM_THEME,
  THEME_COLOR_KEYS,
  THEME_MODES,
  type Theme,
  type ThemeColorKey,
  type ThemeState,
} from "@muny/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/plugin.js";
import { audit } from "../lib/audit.js";
import { badRequest, conflict, notFound, parse } from "../lib/http.js";

/**
 * Themes. Each person picks their own; custom themes are shared by the
 * household, like custom cards. A theme is names and hex colors only.
 */

const THEMES_KEY = "ui.themes";
const selectedKey = (userId: string) => `ui.theme:${userId}`;

const color = z.string().trim().toLowerCase().regex(HEX_COLOR, "Colors look like #1a2b3c");

export const ThemeInputSchema = z
  .object({
    name: z.string().trim().min(1, "Give the theme a name").max(40),
    mode: z.enum(THEME_MODES),
    colors: z
      .object(
        Object.fromEntries(THEME_COLOR_KEYS.map((k) => [k, color])) as Record<
          ThemeColorKey,
          typeof color
        >,
      )
      .strict(),
  })
  .strict();

const SelectSchema = z.object({ id: z.string().min(1).max(64) }).strict();
const IdParams = z.object({ id: z.string().min(1).max(64) });

function read<T>(db: MunyDb, key: string): T | null {
  const row = db.select().from(schema.appSettings).where(eq(schema.appSettings.key, key)).get();
  return (row?.value as T | undefined) ?? null;
}

function write(db: MunyDb, key: string, value: unknown) {
  db.insert(schema.appSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: schema.appSettings.key, set: { value } })
    .run();
}

export const listThemes = (db: MunyDb): Theme[] => read<Theme[]>(db, THEMES_KEY) ?? [];

export function themeState(db: MunyDb, userId: string): ThemeState {
  return {
    selected: read<string>(db, selectedKey(userId)) ?? SYSTEM_THEME,
    custom: listThemes(db),
  };
}

export function selectTheme(db: MunyDb, userId: string, id: string) {
  const known =
    id === SYSTEM_THEME ||
    BUILTIN_THEMES.some((t) => t.id === id) ||
    listThemes(db).some((t) => t.id === id);
  if (!known) throw badRequest("That theme doesn't exist");
  write(db, selectedKey(userId), id);
}

export function createTheme(db: MunyDb, input: Omit<Theme, "id">, createdBy?: string): Theme {
  const themes = listThemes(db);
  if (themes.length >= MAX_CUSTOM_THEMES)
    throw conflict(`You can keep up to ${MAX_CUSTOM_THEMES} custom themes; delete one first`);
  const theme: Theme = { id: newId(), ...input, ...(createdBy ? { createdBy } : {}) };
  write(db, THEMES_KEY, [...themes, theme]);
  return theme;
}

export function updateTheme(db: MunyDb, id: string, input: Omit<Theme, "id">): Theme {
  const themes = listThemes(db);
  const before = themes.find((t) => t.id === id);
  if (!before) throw notFound("Theme not found");
  const theme: Theme = {
    id,
    ...input,
    ...(before.createdBy ? { createdBy: before.createdBy } : {}),
  };
  write(
    db,
    THEMES_KEY,
    themes.map((t) => (t.id === id ? theme : t)),
  );
  return theme;
}

export function deleteTheme(db: MunyDb, id: string) {
  const themes = listThemes(db);
  if (!themes.some((t) => t.id === id)) throw notFound("Theme not found");
  // Anyone using it goes back to following their device: resolveTheme ignores unknown ids.
  write(
    db,
    THEMES_KEY,
    themes.filter((t) => t.id !== id),
  );
}

export function registerThemeRoutes(app: FastifyInstance, db: MunyDb) {
  const log = (userId: string, action: string, entityId: string, details?: unknown) =>
    audit(db, {
      actorType: "user",
      actorId: userId,
      action,
      entityType: "theme",
      entityId,
      details,
    });

  app.get("/api/theme", async (req) => themeState(db, requireUser(req).id));

  app.put("/api/theme/selected", async (req) => {
    const user = requireUser(req);
    selectTheme(db, user.id, parse(SelectSchema, req.body).id);
    return themeState(db, user.id);
  });

  app.post("/api/themes", async (req, reply) => {
    const user = requireUser(req);
    const theme = createTheme(db, parse(ThemeInputSchema, req.body));
    log(user.id, "theme.create", theme.id, { name: theme.name });
    return reply.code(201).send(theme);
  });

  app.put("/api/themes/:id", async (req) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    const theme = updateTheme(db, id, parse(ThemeInputSchema, req.body));
    log(user.id, "theme.update", id, { name: theme.name });
    return theme;
  });

  app.delete("/api/themes/:id", async (req) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    deleteTheme(db, id);
    log(user.id, "theme.delete", id);
    return { ok: true };
  });
}

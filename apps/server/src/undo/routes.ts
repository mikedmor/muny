import type { MunyDb } from "@muny/db";
import {
  CHANGE_HEADER,
  CHANGE_TITLE_HEADER,
  type ChangeItem,
  type ChangeList,
  type UndoPreview,
  type UndoResult,
} from "@muny/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireOwner, requireUser } from "../auth/plugin.js";
import { HttpError, parse } from "../lib/http.js";
import { previewUndo, pruneChanges, UndoError, undoChange } from "./apply.js";
import { changeParts, changeTitle, partText } from "./describe.js";
import { currentChange, installChangeTracking, openChange, runAsChange } from "./track.js";

declare module "fastify" {
  interface FastifyRequest {
    changeId: string | null;
  }
}

const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Recorded, but not offered for undo the moment they happen: arranging and housekeeping. */
const QUIET = new Set([
  "PUT /api/settings/ui",
  "PUT /api/dashboard/layout",
  "DELETE /api/dashboard/layout",
  "PUT /api/theme/selected",
  "POST /api/notifications/read",
  "POST /api/alerts/push/subscribe",
  "POST /api/alerts/run",
  "POST /api/changes/:id/undo",
]);

const isAgentRoute = (route: string) => route === "/mcp" || route.startsWith("/api/v1/");

/**
 * Record every change made through the app or by an assistant, so it can be
 * undone. Register right after auth, so the signed-in person is known.
 */
export function registerChangeTracking(app: FastifyInstance, db: MunyDb) {
  installChangeTracking(db);
  app.decorateRequest("changeId", null);

  app.addHook("onRequest", (req, _reply, done) => {
    const route = req.routeOptions.url;
    if (
      !WRITES.has(req.method) ||
      !route ||
      route.startsWith("/api/auth/") ||
      route.startsWith("/api/invites/") ||
      (route.startsWith("/api/changes") && route !== "/api/changes/:id/undo") ||
      (!req.user && !isAgentRoute(route))
    )
      return done();
    const key = `${req.method} ${route}`;
    const id = openChange(db, {
      actorType: req.user ? "user" : "agent",
      actorId: req.user?.id ?? null,
      actorName: req.user ? (req.user.displayName ?? req.user.email) : null,
      route: key,
    });
    req.changeId = id;
    // Everything the request does from here, through its awaits, is this change.
    runAsChange(id, done, QUIET.has(key));
  });

  app.addHook("onSend", async (req, reply, payload) => {
    if (
      !req.changeId ||
      reply.statusCode >= 400 ||
      QUIET.has(`${req.method} ${req.routeOptions.url}`)
    )
      return payload;
    const parts = changeParts(db, req.changeId);
    if (parts.length) {
      reply.header(CHANGE_HEADER, req.changeId);
      reply.header(CHANGE_TITLE_HEADER, encodeURIComponent(changeTitle(db, req.changeId, parts)));
    }
    return payload;
  });

  registerChangeRoutes(app, db);
}

function registerChangeRoutes(app: FastifyInstance, db: MunyDb) {
  app.get("/api/changes", async (req): Promise<ChangeList> => {
    requireUser(req);
    const { before, limit } = parse(
      z.object({
        before: z.coerce.number().int().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
      req.query,
    );
    const rows = db.$client
      .prepare(
        `select id, at, actor_type, actor_name, undone_by, undo_of from changesets c
          where at < ? and exists (select 1 from change_log l where l.changeset_id = c.id)
          order by at desc, id desc limit ?`,
      )
      .all(before ?? Number.MAX_SAFE_INTEGER, limit + 1) as {
      id: string;
      at: number;
      actor_type: ChangeItem["actor"]["type"];
      actor_name: string | null;
      undone_by: string | null;
      undo_of: string | null;
    }[];
    const page = rows.slice(0, limit);
    return {
      items: page.map((r) => {
        const parts = changeParts(db, r.id);
        return {
          id: r.id,
          at: r.at,
          actor: { type: r.actor_type, name: r.actor_name },
          title: changeTitle(db, r.id, parts),
          parts: parts.map((p) => partText(p)),
          undone: !!r.undone_by,
          undoOf: r.undo_of,
        };
      }),
      next: rows.length > limit ? (page.at(-1)?.at ?? null) : null,
    };
  });

  const Id = z.object({ id: z.string().min(1).max(64) });

  app.get("/api/changes/:id/preview", async (req): Promise<UndoPreview> => {
    requireUser(req);
    const { id } = parse(Id, req.params);
    try {
      return previewUndo(db, id);
    } catch (e) {
      if (e instanceof UndoError) throw new HttpError(404, e.message);
      throw e;
    }
  });

  /**
   * Undo a change. Without `force`, answers 409 with the preview when
   * something was changed since or more would go than the change touched.
   */
  app.post("/api/changes/:id/undo", async (req, reply): Promise<UndoResult> => {
    requireUser(req);
    const { id } = parse(Id, req.params);
    const { force } = parse(z.object({ force: z.boolean().default(false) }), req.body ?? {});
    const me = currentChange();
    if (!me) throw new HttpError(500, "Undo isn't available right now.");
    try {
      const r = undoChange(db, id, me.id, force);
      if (!r.done) {
        reply.code(409);
        throw new HttpError(409, "Check this before undoing it.", r.preview);
      }
      return { id: me.id, title: r.title };
    } catch (e) {
      if (e instanceof UndoError) throw new HttpError(422, e.message);
      throw e;
    }
  });

  /** Forget the history (what's in the database stays as it is). */
  app.delete("/api/changes", async (req) => {
    requireOwner(req);
    runAsChange(null, () =>
      db.$client.transaction(() => {
        db.$client.prepare("delete from change_log").run();
        db.$client.prepare("delete from changesets").run();
      })(),
    );
    return { ok: true };
  });
}

export function startChangePruner(db: MunyDb) {
  pruneChanges(db);
  const timer = setInterval(() => pruneChanges(db), 60 * 60_000);
  timer.unref();
  return () => clearInterval(timer);
}

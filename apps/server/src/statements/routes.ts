import type { MunyDb } from "@muny/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/plugin.js";
import { audit } from "../lib/audit.js";
import { notFound, parse } from "../lib/http.js";
import { deleteTemplate, listTemplates, saveTemplate } from "./templates.js";

/**
 * Statement templates (how to read statements the built-in readers miss).
 * Plain JSON in and out, so an assistant can set them up through the API too.
 */

const Body = z.object({
  kind: z.enum(["card", "loan"]),
  name: z.string().trim().min(1, "Name it").max(100),
  matchText: z.string().trim().min(3, "Give text that's on these statements").max(200),
  fields: z
    .record(z.string().max(40), z.object({ label: z.string().trim().max(120) }))
    .refine((f) => Object.keys(f).length <= 20),
});
const IdParams = z.object({ id: z.string().min(1).max(64) });

export function registerStatementTemplateRoutes(app: FastifyInstance, db: MunyDb) {
  const log = (userId: string, action: string, entityId?: string) =>
    audit(db, {
      actorType: "user",
      actorId: userId,
      action,
      entityType: "statement_template",
      entityId,
    });

  app.get("/api/statement-templates", async (req) => {
    requireUser(req);
    const { kind } = parse(z.object({ kind: z.enum(["card", "loan"]).optional() }), req.query);
    return listTemplates(db, kind);
  });

  app.post("/api/statement-templates", async (req) => {
    const user = requireUser(req);
    const t = saveTemplate(db, parse(Body, req.body));
    log(user.id, "statement_template.create", t.id);
    return t;
  });

  app.put("/api/statement-templates/:id", async (req) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    if (!listTemplates(db).some((t) => t.id === id)) throw notFound("Template not found");
    const t = saveTemplate(db, parse(Body, req.body), id);
    log(user.id, "statement_template.update", id);
    return t;
  });

  app.delete("/api/statement-templates/:id", async (req) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    if (!deleteTemplate(db, id)) throw notFound("Template not found");
    log(user.id, "statement_template.delete", id);
    return { ok: true };
  });
}

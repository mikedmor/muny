import type { MunyDb } from "@muny/db";
import { builtinCardDoc, type CardDoc, TEMPLATE_IDS } from "@muny/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/plugin.js";
import { audit } from "../lib/audit.js";
import { notFound, parse } from "../lib/http.js";
import {
  CardDocSchema,
  CustomCardSchema,
  createCustomCard,
  customCard,
  dashboardSchema,
  deleteCustomCard,
  getDashboard,
  LayoutSchema,
  resetLayout,
  runCard,
  saveLayout,
  updateCustomCard,
} from "./service.js";

const IdParams = z.object({ id: z.string().min(1).max(64) });

/**
 * The customizable Overview. Layouts belong to each person; custom cards are
 * documents shared by the household. These are the operations an assistant's
 * tools will call once agent tokens exist.
 */
export function registerDashboardRoutes(app: FastifyInstance, db: MunyDb) {
  const log = (userId: string, action: string, entityId: string, details?: unknown) =>
    audit(db, {
      actorType: "user",
      actorId: userId,
      action,
      entityType: "dashboard",
      entityId,
      details,
    });

  app.get("/api/dashboard", async (req) => getDashboard(db, requireUser(req).id));

  /** Everything a person or an assistant needs to write a card. Holds no financial data. */
  app.get("/api/dashboard/schema", async (req) => {
    requireUser(req);
    return dashboardSchema();
  });

  app.put("/api/dashboard/layout", async (req) => {
    const user = requireUser(req);
    const { cards } = parse(LayoutSchema, req.body);
    const out = saveLayout(db, user.id, cards);
    log(user.id, "dashboard.layout", user.id, { cards: cards.length });
    return out;
  });

  app.delete("/api/dashboard/layout", async (req) => {
    const user = requireUser(req);
    const out = resetLayout(db, user.id);
    log(user.id, "dashboard.reset", user.id);
    return out;
  });

  /** Run a card without saving it. */
  app.post("/api/dashboard/preview", async (req) => {
    requireUser(req);
    return runCard(db, parse(CardDocSchema, req.body) as CardDoc);
  });

  /** A built-in card as a document, to customize a copy of it. */
  app.get("/api/dashboard/templates/:id", async (req) => {
    requireUser(req);
    const { id } = parse(IdParams, req.params);
    const doc = builtinCardDoc(id);
    if (!doc || !TEMPLATE_IDS.includes(id)) throw notFound("There's no such card");
    return doc;
  });

  app.get("/api/dashboard/cards/:id/data", async (req) => {
    requireUser(req);
    return runCard(db, customCard(db, parse(IdParams, req.params).id).doc);
  });

  app.post("/api/dashboard/cards", async (req, reply) => {
    const user = requireUser(req);
    const { place, ...input } = parse(
      CustomCardSchema.extend({ place: z.boolean().default(true) }),
      req.body,
    );
    const card = createCustomCard(db, user.id, input as never, place);
    log(user.id, "dashboard.card_create", card.id, {
      title: card.title,
      blocks: card.doc.blocks.length,
    });
    return reply.code(201).send(card);
  });

  app.put("/api/dashboard/cards/:id", async (req) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    const card = updateCustomCard(db, id, parse(CustomCardSchema, req.body) as never);
    log(user.id, "dashboard.card_update", id, {
      title: card.title,
      blocks: card.doc.blocks.length,
    });
    return card;
  });

  app.delete("/api/dashboard/cards/:id", async (req) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    deleteCustomCard(db, id);
    log(user.id, "dashboard.card_delete", id);
    return { ok: true };
  });
}

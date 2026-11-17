import type { MunyDb } from "@muny/db";
import {
  availableBuiltinCards,
  builtinCardDoc,
  type CardDoc,
  CUSTOM_PREFIX,
  TEMPLATE_IDS,
} from "@muny/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { aiEnabled } from "../ai/settings.js";
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

/** Where tapping a built-in card's home-screen widget goes (custom cards open the Overview). */
const WIDGET_OPENS: Record<string, string> = {
  spending: "/spending",
  calendar: "/recurring",
  "cash-flow": "/reports",
  categories: "/spending",
  merchants: "/spending",
  forecast: "/forecast",
  "cash-trend": "/reports",
  accounts: "/accounts",
  cards: "/cards",
  loans: "/loans",
  stocks: "/stocks",
  crypto: "/crypto",
  budget: "/budgets",
  recent: "/transactions",
  "coming-up": "/recurring",
};

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

  /**
   * Cards that can be home-screen widgets in the Android app (app-shell's widget
   * contract): this person's Overview cards first, then the rest. Each `page`
   * draws just that card; `open` is where tapping the widget goes.
   */
  app.get("/api/app-widgets", async (req) => {
    const user = requireUser(req);
    const d = getDashboard(db, user.id);
    const builtins = availableBuiltinCards(aiEnabled(db)).filter((c) => !c.needsAi);
    const all = [
      ...builtins.map((c) => ({ id: c.id, title: c.title, description: c.description })),
      ...d.customCards.map((c) => ({
        id: `${CUSTOM_PREFIX}${c.id}`,
        title: c.title,
        description: "Your custom card",
      })),
    ];
    const order = new Map(d.cards.map((ref, i) => [ref, i]));
    all.sort((a, b) => (order.get(a.id) ?? 1e6) - (order.get(b.id) ?? 1e6));
    return {
      widgets: all.map((c) => ({
        ...c,
        onOverview: order.has(c.id),
        page: `/app-widget/${encodeURIComponent(c.id)}`,
        open: WIDGET_OPENS[c.id] ?? "/",
        refresh: 30,
      })),
    };
  });

  /** Everything a person or an assistant needs to write a card. Holds no financial data. */
  app.get("/api/dashboard/schema", async (req) => {
    requireUser(req);
    return dashboardSchema(db);
  });

  app.put("/api/dashboard/layout", async (req) => {
    const user = requireUser(req);
    const { cards, columns } = parse(LayoutSchema, req.body);
    const out = saveLayout(db, user.id, cards, columns);
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

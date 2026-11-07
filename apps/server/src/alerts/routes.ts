import { type MunyDb, newId, schema } from "@muny/db";
import {
  ACCOUNT_ALERT_TYPES,
  type AccountAlertSettings,
  ALERT_TYPES,
  CHANNEL_TYPES,
  type ChannelConfig,
  type ChannelType,
  DEFAULT_ACCOUNT_ALERTS,
  type NotificationChannel,
  type NotificationList,
} from "@muny/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/plugin.js";
import { audit } from "../lib/audit.js";
import { decryptJson, encryptJson } from "../lib/crypto.js";
import { badRequest, HttpError, notFound, parse } from "../lib/http.js";
import { accountAlerts, setAccountAlerts } from "./accounts.js";
import { channelSummary, parseChannelConfig } from "./channels.js";
import {
  type AlertDeps,
  deliver,
  ensureAlertRules,
  listNotifications,
  listRules,
  markRead,
  outbound,
  runAlerts,
} from "./service.js";
import { vapidKeys } from "./webpush.js";

const IdParams = z.object({ id: z.string().min(1).max(64) });
const cents = z.number().int().min(0).max(1_000_000_000);

const RuleParams = z
  .object({
    thresholdCents: cents.optional(),
    accountIds: z.array(z.string().max(64)).max(100).optional(),
    minCents: cents.optional(),
    multiplier: z.number().min(1.5).max(20).optional(),
    days: z.number().int().min(1).max(14).optional(),
    daysBefore: z.number().int().min(0).max(30).optional(),
    percents: z.array(z.number().int().min(1).max(500)).min(1).max(5).optional(),
    mutedCategoryIds: z.array(z.string().min(1).max(64)).max(500).optional(),
  })
  .strict();

function toChannel(
  row: typeof schema.notificationChannels.$inferSelect,
  secretKey: Buffer | undefined,
): NotificationChannel {
  let summary = "";
  if (secretKey) {
    try {
      summary = channelSummary(
        row.type as ChannelType,
        decryptJson<ChannelConfig>(secretKey, row.configEnc),
      );
    } catch {
      summary = "(can't read settings: was MUNY_SECRET_KEY changed?)";
    }
  }
  return {
    id: row.id,
    type: row.type as ChannelType,
    name: row.name,
    enabled: row.enabled,
    summary,
    lastSentAt: row.lastSentAt ? row.lastSentAt.getTime() : null,
    lastError: row.lastError,
  };
}

export function registerAlertRoutes(app: FastifyInstance, db: MunyDb, deps: AlertDeps) {
  ensureAlertRules(db);
  const ch = schema.notificationChannels;
  const log = (userId: string, action: string, entityId?: string, details?: unknown) =>
    audit(db, {
      actorType: "user",
      actorId: userId,
      action,
      entityType: "alert",
      entityId,
      details,
    });
  const needKey = () => {
    if (!deps.secretKey)
      throw new HttpError(
        409,
        "Set MUNY_SECRET_KEY first: notification settings are stored encrypted.",
      );
    return deps.secretKey;
  };
  const parseConfig = (type: ChannelType, input: unknown) => {
    try {
      return parseChannelConfig(type, input);
    } catch (err) {
      if (err instanceof z.ZodError)
        throw badRequest(err.issues[0]?.message ?? "Check the channel settings");
      throw err;
    }
  };

  // --- Notifications ------------------------------------------------------------

  app.get("/api/notifications", async (req): Promise<NotificationList> => {
    const q = parse(
      z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
      req.query,
    );
    return listNotifications(db, q.limit);
  });

  app.post("/api/notifications/read", async (req) => {
    const body = parse(
      z.object({ ids: z.array(z.string().max(64)).max(500).optional() }),
      req.body ?? {},
    );
    return { updated: markRead(db, body.ids) };
  });

  // --- Rules --------------------------------------------------------------------

  app.get("/api/alerts/rules", async () => listRules(db));

  app.patch("/api/alerts/rules/:type", async (req) => {
    const user = requireUser(req);
    const { type } = parse(z.object({ type: z.enum(ALERT_TYPES) }), req.params);
    const body = parse(
      z.object({
        enabled: z.boolean().optional(),
        params: RuleParams.optional(),
        channelIds: z.array(z.string().max(64)).max(20).optional(),
      }),
      req.body,
    );
    const rule = listRules(db).find((r) => r.type === type);
    if (!rule) throw notFound("Alert not found");
    if (body.channelIds) {
      const known = new Set(
        db
          .select({ id: ch.id })
          .from(ch)
          .all()
          .map((c) => c.id),
      );
      if (body.channelIds.some((id) => !known.has(id))) throw badRequest("Unknown channel");
    }
    // Account alerts stay on; each account decides (Accounts page).
    const perAccount = ACCOUNT_ALERT_TYPES.includes(type);
    db.update(schema.alertRules)
      .set({
        ...(body.enabled !== undefined && !perAccount ? { enabled: body.enabled } : {}),
        ...(body.params ? { params: { ...rule.params, ...body.params } } : {}),
        ...(body.channelIds ? { channelIds: body.channelIds } : {}),
      })
      .where(eq(schema.alertRules.type, type))
      .run();
    log(user.id, "alert.rule_update", type, { enabled: body.enabled });
    return listRules(db).find((r) => r.type === type);
  });

  // --- Per-account alerts (Accounts page) -----------------------------------------

  app.get("/api/account-alerts", async (req): Promise<Record<string, AccountAlertSettings>> => {
    requireUser(req);
    const set = accountAlerts(db);
    return Object.fromEntries(
      db
        .select({ id: schema.accounts.id })
        .from(schema.accounts)
        .all()
        .map((a) => {
          const { since: _, ...s } = set.get(a.id) ?? { ...DEFAULT_ACCOUNT_ALERTS, since: null };
          return [a.id, s];
        }),
    );
  });

  app.put("/api/account-alerts/:accountId", async (req) => {
    const user = requireUser(req);
    const { accountId } = parse(z.object({ accountId: z.string().min(1).max(64) }), req.params);
    const cents = z.number().int().min(0).max(100_000_000_000).nullable();
    const body = parse(
      z.object({
        lowBalanceCents: cents,
        largeChargeCents: cents,
        unusualCharge: z.boolean(),
        duplicateCharge: z.boolean(),
      }),
      req.body,
    );
    const exists = db
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(eq(schema.accounts.id, accountId))
      .get();
    if (!exists) throw notFound("Account not found");
    setAccountAlerts(db, accountId, body);
    log(user.id, "alert.account_update", accountId);
    return body;
  });

  /** Check now instead of waiting for the next 5-minute run. */
  app.post("/api/alerts/run", async (req) => {
    requireUser(req);
    return runAlerts(db, deps);
  });

  // --- Channels -----------------------------------------------------------------

  app.get("/api/alerts/channels", async () =>
    db
      .select()
      .from(ch)
      .orderBy(ch.createdAt)
      .all()
      .map((r) => toChannel(r, deps.secretKey)),
  );

  // --- Notifications on this device (Web Push) ----------------------------------

  /** The key a browser needs to subscribe this device. */
  app.get("/api/alerts/push/key", async (req) => {
    requireUser(req);
    return { publicKey: vapidKeys(db, needKey()).publicKey };
  });

  /**
   * Turn on notifications for this device: it becomes a channel (once per
   * device), sending every alert that's on until you change it.
   */
  app.post("/api/alerts/push/subscribe", async (req) => {
    const user = requireUser(req);
    const key = needKey();
    const body = parse(
      z.object({
        endpoint: z.string().max(1000),
        keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }),
        device: z.string().trim().min(1).max(80),
      }),
      req.body,
    );
    const config = parseConfig("push", {
      endpoint: body.endpoint,
      p256dh: body.keys.p256dh,
      auth: body.keys.auth,
      device: body.device,
    });
    const existing = db
      .select()
      .from(ch)
      .where(eq(ch.type, "push"))
      .all()
      .find((c) => decryptJson<ChannelConfig>(key, c.configEnc).endpoint === config.endpoint);
    let id = existing?.id;
    if (id) {
      db.update(ch)
        .set({ configEnc: encryptJson(key, config), enabled: true, lastError: null })
        .where(eq(ch.id, id))
        .run();
    } else {
      id = newId();
      db.insert(ch)
        .values({ id, type: "push", name: body.device, configEnc: encryptJson(key, config) })
        .run();
      // New device: every alert that's on goes to it too (untick any on Alerts → Settings).
      for (const r of listRules(db))
        if (r.enabled)
          db.update(schema.alertRules)
            .set({ channelIds: [...r.channelIds, id] })
            .where(eq(schema.alertRules.type, r.type))
            .run();
    }
    log(user.id, "alert.push_subscribe", id);
    return toChannel(db.select().from(ch).where(eq(ch.id, id)).get() as never, key);
  });

  app.post("/api/alerts/channels", async (req, reply) => {
    const user = requireUser(req);
    const key = needKey();
    const body = parse(
      z.object({
        type: z.enum(CHANNEL_TYPES),
        name: z.string().trim().min(1).max(60),
        config: z.record(z.string(), z.unknown()),
      }),
      req.body,
    );
    const config = parseConfig(body.type, body.config);
    const id = newId();
    db.insert(ch)
      .values({ id, type: body.type, name: body.name, configEnc: encryptJson(key, config) })
      .run();
    log(user.id, "alert.channel_add", id, { type: body.type });
    reply.code(201);
    return toChannel(db.select().from(ch).where(eq(ch.id, id)).get() as never, key);
  });

  app.patch("/api/alerts/channels/:id", async (req) => {
    const user = requireUser(req);
    const key = needKey();
    const { id } = parse(IdParams, req.params);
    const row = db.select().from(ch).where(eq(ch.id, id)).get();
    if (!row) throw notFound("Channel not found");
    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(60).optional(),
        enabled: z.boolean().optional(),
        /** Replaces the settings; leave a secret empty to keep the current one. */
        config: z.record(z.string(), z.unknown()).optional(),
      }),
      req.body,
    );
    let configEnc: string | undefined;
    if (body.config) {
      const old = decryptJson<ChannelConfig>(key, row.configEnc);
      const merged: Record<string, unknown> = { ...body.config };
      for (const secret of ["token", "secret", "password"] as const)
        if (!merged[secret] && old[secret]) merged[secret] = old[secret];
      configEnc = encryptJson(key, parseConfig(row.type as ChannelType, merged));
    }
    db.update(ch)
      .set({
        ...(body.name ? { name: body.name } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(configEnc ? { configEnc, lastError: null } : {}),
      })
      .where(eq(ch.id, id))
      .run();
    log(user.id, "alert.channel_update", id);
    return toChannel(db.select().from(ch).where(eq(ch.id, id)).get() as never, key);
  });

  app.delete("/api/alerts/channels/:id", async (req) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    if (db.delete(ch).where(eq(ch.id, id)).run().changes === 0) throw notFound("Channel not found");
    // Drop it from any rule that used it.
    for (const r of db.select().from(schema.alertRules).all()) {
      if (r.channelIds.includes(id))
        db.update(schema.alertRules)
          .set({ channelIds: r.channelIds.filter((c) => c !== id) })
          .where(eq(schema.alertRules.id, r.id))
          .run();
    }
    log(user.id, "alert.channel_delete", id);
    return { ok: true };
  });

  app.post("/api/alerts/channels/:id/test", async (req) => {
    requireUser(req);
    needKey();
    const { id } = parse(IdParams, req.params);
    const r = await deliver(
      db,
      id,
      outbound(
        {
          title: "Test from Muny",
          body: "If you can read this, Muny can reach you here.",
          link: "/",
          severity: "info",
          ruleType: "test",
          createdAt: new Date(),
        },
        deps.publicUrl,
      ),
      deps,
    );
    if (!r.ok) throw badRequest(r.error ?? "Sending failed");
    return { ok: true };
  });
}

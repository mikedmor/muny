import { type MunyDb, newId, schema } from "@muny/db";
import {
  ALERT_TYPES,
  type AlertParams,
  type AlertRule,
  type AlertType,
  type AppNotification,
  type ChannelConfig,
  type ChannelType,
} from "@muny/shared";
import { and, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import { decryptJson } from "../lib/crypto.js";
import { localToday } from "../lib/dates.js";
import { verifySavings } from "../savings/service.js";
import { moveAlertsToAccounts } from "./accounts.js";
import { ChannelError, type OutboundMessage, sendToChannel } from "./channels.js";
import { type Candidate, DEFAULT_PARAMS, evaluateRules } from "./evaluate.js";

export interface AlertDeps {
  secretKey: Buffer | undefined;
  /** e.g. https://muny.example.ts.net, for links in outbound messages. */
  publicUrl: string | undefined;
  fetch?: typeof fetch;
}

/** Every alert type exists as a rule (enabled by default, in-app only). */
export function ensureAlertRules(db: MunyDb) {
  const have = new Set(
    db
      .select({ type: schema.alertRules.type })
      .from(schema.alertRules)
      .all()
      .map((r) => r.type),
  );
  for (const type of ALERT_TYPES) {
    if (have.has(type)) continue;
    db.insert(schema.alertRules)
      .values({ id: newId(), type, enabled: true, params: DEFAULT_PARAMS[type], channelIds: [] })
      .run();
  }
  moveAlertsToAccounts(db);
}

export function listRules(db: MunyDb): AlertRule[] {
  ensureAlertRules(db);
  const order = new Map(ALERT_TYPES.map((t, i) => [t, i]));
  return db
    .select()
    .from(schema.alertRules)
    .all()
    .filter((r) => order.has(r.type as AlertType))
    .map((r) => ({
      id: r.id,
      type: r.type as AlertType,
      enabled: r.enabled,
      params: { ...DEFAULT_PARAMS[r.type as AlertType], ...(r.params as AlertParams) },
      channelIds: r.channelIds,
    }))
    .sort((a, b) => (order.get(a.type) ?? 0) - (order.get(b.type) ?? 0));
}

export function toNotification(r: typeof schema.notifications.$inferSelect): AppNotification {
  return {
    id: r.id,
    ruleType: r.ruleType,
    severity: r.severity,
    title: r.title,
    body: r.body,
    link: r.link,
    createdAt: r.createdAt.getTime(),
    readAt: r.readAt ? r.readAt.getTime() : null,
  };
}

/** Insert candidates that haven't fired before. Returns the new ones. */
function record(db: MunyDb, candidates: Candidate[]) {
  const created: (typeof schema.notifications.$inferSelect)[] = [];
  for (const c of candidates) {
    const row = db
      .insert(schema.notifications)
      .values({
        id: newId(),
        ruleType: c.type,
        dedupeKey: c.dedupeKey,
        severity: c.severity,
        title: c.title.slice(0, 200),
        body: c.body.slice(0, 1000),
        link: c.link,
      })
      .onConflictDoNothing({ target: schema.notifications.dedupeKey })
      .returning()
      .get();
    if (row) created.push(row);
  }
  return created;
}

export function outbound(
  n: {
    title: string;
    body: string;
    link: string | null;
    severity: "info" | "warning";
    ruleType: string;
    createdAt: Date;
  },
  publicUrl: string | undefined,
): OutboundMessage {
  return {
    title: n.title,
    body: n.body,
    url: publicUrl && n.link ? `${publicUrl.replace(/\/+$/, "")}${n.link}` : null,
    severity: n.severity,
    type: n.ruleType,
    createdAt: n.createdAt.getTime(),
  };
}

export async function deliver(
  db: MunyDb,
  channelId: string,
  msg: OutboundMessage,
  deps: AlertDeps,
): Promise<{ ok: boolean; error?: string }> {
  const ch = db
    .select()
    .from(schema.notificationChannels)
    .where(eq(schema.notificationChannels.id, channelId))
    .get();
  if (!ch) return { ok: false, error: "Channel not found" };
  let error: string | undefined;
  try {
    if (!deps.secretKey) throw new ChannelError("MUNY_SECRET_KEY isn't set");
    const config = decryptJson<ChannelConfig>(deps.secretKey, ch.configEnc);
    await sendToChannel(ch.type as ChannelType, config, msg, deps.fetch);
  } catch (err) {
    // Only our own short messages are kept; never URLs or tokens.
    error = err instanceof ChannelError ? err.message : "Sending failed";
  }
  db.update(schema.notificationChannels)
    .set(error ? { lastError: error } : { lastError: null, lastSentAt: new Date() })
    .where(eq(schema.notificationChannels.id, channelId))
    .run();
  return error ? { ok: false, error } : { ok: true };
}

let running = false;

/** Evaluate every enabled rule, record new notifications and send them out. */
export async function runAlerts(db: MunyDb, deps: AlertDeps, now = new Date()) {
  if (running) return { created: 0 };
  running = true;
  try {
    verifySavings(db, localToday(now));
    const rules = db
      .select()
      .from(schema.alertRules)
      .where(eq(schema.alertRules.enabled, true))
      .all();
    const candidates = evaluateRules(
      db,
      rules
        .filter((r) => (ALERT_TYPES as readonly string[]).includes(r.type))
        .map((r) => ({
          type: r.type as AlertType,
          params: r.params as AlertParams,
          since: r.updatedAt,
        })),
      localToday(now),
      now,
    );
    const created = record(db, candidates);

    // Send anything not yet handed off (from this run or a failed earlier one) from the last day.
    const channelsByType = new Map(rules.map((r) => [r.type, r.channelIds]));
    const pending = db
      .select()
      .from(schema.notifications)
      .where(
        and(
          isNull(schema.notifications.sentAt),
          gte(schema.notifications.createdAt, new Date(now.getTime() - 86_400_000)),
        ),
      )
      .all();
    const enabledChannels = new Set(
      db
        .select({ id: schema.notificationChannels.id })
        .from(schema.notificationChannels)
        .where(eq(schema.notificationChannels.enabled, true))
        .all()
        .map((c) => c.id),
    );
    for (const n of pending) {
      const ids = (channelsByType.get(n.ruleType) ?? []).filter((id) => enabledChannels.has(id));
      let allOk = true;
      for (const id of ids) {
        const r = await deliver(db, id, outbound(n, deps.publicUrl), deps);
        allOk &&= r.ok;
      }
      if (allOk)
        db.update(schema.notifications)
          .set({ sentAt: new Date() })
          .where(eq(schema.notifications.id, n.id))
          .run();
    }
    return { created: created.length };
  } finally {
    running = false;
  }
}

export function listNotifications(db: MunyDb, limit = 50) {
  const items = db
    .select()
    .from(schema.notifications)
    .orderBy(desc(schema.notifications.createdAt))
    .limit(limit)
    .all()
    .map(toNotification);
  const unread = db
    .select({ id: schema.notifications.id })
    .from(schema.notifications)
    .where(isNull(schema.notifications.readAt))
    .all().length;
  return { items, unread };
}

export function markRead(db: MunyDb, ids?: string[]) {
  const n = schema.notifications;
  return db
    .update(n)
    .set({ readAt: new Date() })
    .where(ids ? and(inArray(n.id, ids), isNull(n.readAt)) : isNull(n.readAt))
    .run().changes;
}

export function startAlertScheduler(
  db: MunyDb,
  deps: AlertDeps,
  log: { warn: (o: object, msg: string) => void },
) {
  const tick = () =>
    void runAlerts(db, deps).catch((err) =>
      log.warn({ err: err instanceof Error ? err.message : "unknown" }, "Alert check failed"),
    );
  const first = setTimeout(tick, 45_000);
  const timer = setInterval(tick, 5 * 60_000);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

declare module "fastify" {
  interface FastifyInstance {
    alertDeps: AlertDeps;
  }
}

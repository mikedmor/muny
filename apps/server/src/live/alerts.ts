import { type MunyDb, newId, schema } from "@muny/db";
import {
  type LiveKey,
  type LiveQuote,
  liveKey,
  PRICE_ALERT_LABELS,
  type PriceAlert,
  type PriceAlertCondition,
  type PriceAlertInput,
} from "@muny/shared";
import { and, desc, eq, gte, lt } from "drizzle-orm";
import { type AlertDeps, ensureAlertRules, sendPending } from "../alerts/service.js";
import { localToday } from "../lib/dates.js";

/**
 * Price alerts: checked against each live price as it arrives. One that
 * doesn't repeat fires once and turns itself off; one that repeats fires at
 * most once a day. They go out like any alert, to the channels chosen for
 * "Price alerts" in Alerts settings.
 */

const num = (v: string | null) => (v === null ? null : Number(v));

const toAlert = (r: typeof schema.priceAlerts.$inferSelect): PriceAlert => ({
  id: r.id,
  kind: r.kind,
  symbol: r.symbol,
  condition: r.condition as PriceAlertCondition,
  value: num(r.value),
  basePrice: num(r.basePrice),
  note: r.note,
  repeat: r.repeat,
  enabled: r.enabled,
  lastFiredAt: r.lastFiredAt?.getTime() ?? null,
  lastFiredPrice: num(r.lastFiredPrice),
  createdAt: r.createdAt.getTime(),
});

export function listPriceAlerts(db: MunyDb, key?: LiveKey): PriceAlert[] {
  const t = schema.priceAlerts;
  const [kind, symbol] = key ? key.split(":") : [];
  return db
    .select()
    .from(t)
    .where(
      key ? and(eq(t.kind, kind as "stock" | "crypto"), eq(t.symbol, symbol as string)) : undefined,
    )
    .orderBy(desc(t.createdAt))
    .all()
    .map(toAlert);
}

/** What every enabled alert is watching. */
export function alertKeys(db: MunyDb): LiveKey[] {
  return [
    ...new Set(
      db
        .select({ kind: schema.priceAlerts.kind, symbol: schema.priceAlerts.symbol })
        .from(schema.priceAlerts)
        .where(eq(schema.priceAlerts.enabled, true))
        .all()
        .map((r) => liveKey(r.kind, r.symbol)),
    ),
  ];
}

export function savePriceAlert(
  db: MunyDb,
  input: PriceAlertInput & { basePrice?: number | null },
  id?: string,
): PriceAlert {
  const t = schema.priceAlerts;
  const values = {
    kind: input.kind,
    symbol: input.symbol.toUpperCase(),
    condition: input.condition,
    value:
      PRICE_ALERT_LABELS[input.condition].unit && input.value != null ? String(input.value) : null,
    note: input.note?.trim() || null,
    repeat: input.repeat ?? false,
    enabled: input.enabled ?? true,
    ...(input.basePrice != null ? { basePrice: String(input.basePrice) } : {}),
  };
  if (id) db.update(t).set(values).where(eq(t.id, id)).run();
  else {
    id = newId();
    db.insert(t)
      .values({ id, ...values })
      .run();
  }
  const row = db.select().from(t).where(eq(t.id, id)).get();
  if (!row) throw new Error("Alert not saved");
  return toAlert(row);
}

export function deletePriceAlert(db: MunyDb, id: string) {
  return db.delete(schema.priceAlerts).where(eq(schema.priceAlerts.id, id)).run().changes > 0;
}

export function fmtPrice(n: number) {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: n < 1 ? 6 : 2,
  });
}

const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(Math.abs(n) < 10 ? 1 : 0)}%`;

/** The year's highest and lowest close before today, from the closes Muny keeps; null with too few. */
function yearRange(
  db: MunyDb,
  symbol: string,
  today: string,
): { high: number; low: number } | null {
  const sec = db
    .select({ id: schema.securities.id })
    .from(schema.securities)
    .where(eq(schema.securities.symbol, symbol))
    .get();
  if (!sec) return null;
  const from = new Date(`${today}T00:00:00Z`);
  from.setUTCDate(from.getUTCDate() - 365);
  const p = schema.securityPrices;
  const closes = db
    .select({ close: p.close })
    .from(p)
    .where(
      and(
        eq(p.securityId, sec.id),
        gte(p.date, from.toISOString().slice(0, 10)),
        lt(p.date, today),
      ),
    )
    .all()
    .map((r) => Number(r.close))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (closes.length < 100) return null;
  return { high: Math.max(...closes), low: Math.min(...closes) };
}

/** Whether an alert's condition holds at this price, and how to say so. */
export function triggered(
  a: PriceAlert,
  q: LiveQuote,
  range: () => { high: number; low: number } | null,
): string | null {
  const v = a.value;
  const name = a.symbol;
  const today = q.changePct === null ? "" : ` (${pct(q.changePct)} today)`;
  switch (a.condition) {
    case "above":
      return v !== null && q.price >= v
        ? `${name} is at ${fmtPrice(q.price)}, above ${fmtPrice(v)}${today}.`
        : null;
    case "below":
      return v !== null && q.price <= v
        ? `${name} is at ${fmtPrice(q.price)}, below ${fmtPrice(v)}${today}.`
        : null;
    case "day_up":
      return v !== null && q.changePct !== null && q.changePct >= v
        ? `${name} is up ${pct(q.changePct)} today, at ${fmtPrice(q.price)}.`
        : null;
    case "day_down":
      return v !== null && q.changePct !== null && q.changePct <= -v
        ? `${name} is down ${pct(q.changePct)} today, at ${fmtPrice(q.price)}.`
        : null;
    case "move_up":
    case "move_down": {
      if (v === null || !a.basePrice) return null;
      const moved = ((q.price - a.basePrice) / a.basePrice) * 100;
      const hit = a.condition === "move_up" ? moved >= v : moved <= -v;
      return hit
        ? `${name} has moved ${pct(moved)} since you set this alert at ${fmtPrice(a.basePrice)}; it's at ${fmtPrice(q.price)}.`
        : null;
    }
    case "high_52w":
    case "low_52w": {
      const r = range();
      if (!r) return null;
      if (a.condition === "high_52w" && q.price > r.high)
        return `${name} reached a new 52-week high: ${fmtPrice(q.price)} (the high was ${fmtPrice(r.high)}).`;
      if (a.condition === "low_52w" && q.price < r.low)
        return `${name} fell to a new 52-week low: ${fmtPrice(q.price)} (the low was ${fmtPrice(r.low)}).`;
      return null;
    }
  }
}

/** Check a new price against the alerts on its symbol; record and send what fires. */
export function checkPriceAlerts(
  db: MunyDb,
  q: LiveQuote,
  alertDeps: AlertDeps | null,
  now = new Date(),
): number {
  const t = schema.priceAlerts;
  const alerts = db
    .select()
    .from(t)
    .where(and(eq(t.kind, q.kind), eq(t.symbol, q.symbol), eq(t.enabled, true)))
    .all()
    .map(toAlert);
  if (!alerts.length) return 0;
  const today = localToday(now);
  let range: { high: number; low: number } | null | undefined;
  const rangeOf = () => {
    if (range === undefined) range = q.kind === "stock" ? yearRange(db, q.symbol, today) : null;
    return range;
  };
  ensureAlertRules(db);
  const rule = db
    .select({ enabled: schema.alertRules.enabled })
    .from(schema.alertRules)
    .where(eq(schema.alertRules.type, "price_alert"))
    .get();
  let fired = 0;
  for (const a of alerts) {
    // A repeating alert: once a day at most.
    if (a.lastFiredAt && localToday(new Date(a.lastFiredAt)) === today) continue;
    const text = triggered(a, q, rangeOf);
    if (!text) continue;
    fired++;
    db.update(t)
      .set({
        lastFiredAt: now,
        lastFiredPrice: String(q.price),
        ...(a.repeat ? {} : { enabled: false }),
      })
      .where(eq(t.id, a.id))
      .run();
    if (rule && !rule.enabled) continue;
    db.insert(schema.notifications)
      .values({
        id: newId(),
        ruleType: "price_alert",
        dedupeKey: `price_alert:${a.id}:${now.getTime()}`,
        severity: "info",
        title: `${a.symbol}: ${PRICE_ALERT_LABELS[a.condition].label.toLowerCase()}${a.value !== null ? ` ${PRICE_ALERT_LABELS[a.condition].unit === "price" ? fmtPrice(a.value) : `${a.value}%`}` : ""}`,
        body: `${text}${a.note ? ` ${a.note}` : ""}`,
        link: q.kind === "stock" ? `/stocks/${encodeURIComponent(a.symbol)}` : "/crypto",
      })
      .run();
  }
  if (fired && alertDeps) void sendPending(db, alertDeps, now).catch(() => {});
  return fired;
}

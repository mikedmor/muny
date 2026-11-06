import { type MunyDb, schema } from "@muny/db";
import {
  ACCOUNT_ALERT_TYPES,
  type AccountAlertSettings,
  type AlertParams,
  DEFAULT_ACCOUNT_ALERTS,
} from "@muny/shared";
import { eq, inArray } from "drizzle-orm";

/**
 * Alerts per account (set on the Accounts page): low balance, large charges,
 * unusual and duplicate charges. The rules for these four types stay on (for
 * their channels); each account decides whether and at what amount.
 */

/** Each account's settings, and when they were last changed. */
export function accountAlerts(db: MunyDb): Map<string, AccountAlertSettings & { since: Date }> {
  return new Map(
    db
      .select()
      .from(schema.accountAlerts)
      .all()
      .map((r) => [
        r.accountId,
        {
          lowBalanceCents: r.lowBalanceCents,
          largeChargeCents: r.largeChargeCents,
          unusualCharge: r.unusualCharge,
          duplicateCharge: r.duplicateCharge,
          since: r.updatedAt,
        },
      ]),
  );
}

export function setAccountAlerts(db: MunyDb, accountId: string, input: AccountAlertSettings) {
  db.insert(schema.accountAlerts)
    .values({ accountId, ...input })
    .onConflictDoUpdate({
      target: schema.accountAlerts.accountId,
      set: { ...input, updatedAt: new Date() },
    })
    .run();
}

const MOVED_KEY = "alerts.perAccount";

/**
 * Once: turn the old global settings into each account's (low balance on the
 * chosen accounts, or checking and savings; large charges on every account),
 * and keep the four rules on so each account's settings apply.
 */
export function moveAlertsToAccounts(db: MunyDb) {
  const done = db
    .select()
    .from(schema.appSettings)
    .where(eq(schema.appSettings.key, MOVED_KEY))
    .get();
  if (done) return;
  const rules = new Map(
    db
      .select()
      .from(schema.alertRules)
      .all()
      .map((r) => [r.type, { enabled: r.enabled, params: (r.params ?? {}) as AlertParams }]),
  );
  const low = rules.get("low_balance");
  const large = rules.get("large_transaction");
  const lowIds = new Set(low?.params.accountIds ?? []);
  for (const a of db.select().from(schema.accounts).all()) {
    const cashLike = a.type === "checking" || a.type === "savings";
    const s: AccountAlertSettings = {
      lowBalanceCents:
        low?.enabled && (lowIds.size ? lowIds.has(a.id) : cashLike)
          ? (low.params.thresholdCents ?? 10_000)
          : null,
      largeChargeCents: large?.enabled ? (large.params.minCents ?? 50_000) : null,
      unusualCharge: rules.get("unusual_charge")?.enabled ?? DEFAULT_ACCOUNT_ALERTS.unusualCharge,
      duplicateCharge:
        rules.get("duplicate_charge")?.enabled ?? DEFAULT_ACCOUNT_ALERTS.duplicateCharge,
    };
    db.insert(schema.accountAlerts)
      .values({ accountId: a.id, ...s })
      .onConflictDoNothing()
      .run();
  }
  db.update(schema.alertRules)
    .set({ enabled: true })
    .where(inArray(schema.alertRules.type, [...ACCOUNT_ALERT_TYPES]))
    .run();
  db.insert(schema.appSettings).values({ key: MOVED_KEY, value: true }).onConflictDoNothing().run();
}

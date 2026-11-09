import { cleanPayeeName } from "@muny/core";
import { type MunyDb, schema } from "@muny/db";
import {
  type AlertParams,
  type AlertType,
  DEFAULT_ACCOUNT_ALERTS,
  describeWait,
  formatMoney,
} from "@muny/shared";
import { and, eq, gte, isNull, sql } from "drizzle-orm";
import { budgetMonth } from "../budgets/service.js";
import { apiLimits } from "../crypto/budget.js";
import { listAccounts } from "../ledger/accounts.js";
import { listSeries, merchantKey, upcoming } from "../recurring/service.js";
import { listTrials } from "../trials/routes.js";
import { accountAlerts } from "./accounts.js";

/**
 * Turns alert rules into candidate notifications. Pure reads plus a small
 * state blob (which accounts/connections are currently "in alert"), so an
 * ongoing condition notifies once, not on every check.
 *
 * Transaction alerts only look at transactions that arrived after the rule was
 * turned on (and in the last few days), so enabling a rule never replays years
 * of history.
 */

export interface Candidate {
  type: AlertType;
  dedupeKey: string;
  severity: "info" | "warning";
  title: string;
  body: string;
  link: string | null;
}

export interface RuleRow {
  type: AlertType;
  params: AlertParams;
  /** When the rule was (last) enabled. */
  since: Date;
}

export const DEFAULT_PARAMS: Record<AlertType, AlertParams> = {
  low_balance: { thresholdCents: 10_000, accountIds: [] },
  large_transaction: { minCents: 50_000 },
  unusual_charge: { multiplier: 3 },
  duplicate_charge: { days: 3 },
  bill_due: { daysBefore: 3 },
  price_increase: {},
  budget: { percents: [80, 100] },
  charged_after_cancel: {},
  connection_error: {},
  trial_ending: { daysBefore: 3 },
  agent_proposal: {},
  ai_review: {},
  ai_checkin: {},
  api_limit: {},
};

const STATE_KEY = "alerts.state";
interface AlertState {
  low: Record<string, boolean>;
  conn: Record<string, string>;
}

/** Reminder days for bills and trials, largest first (older rules have one daysBefore). */
export function reminderDays(p: AlertParams): number[] {
  const days = p.reminderDays?.length ? p.reminderDays : [p.daysBefore ?? 3];
  return [...new Set(days)].sort((a, b) => b - a);
}

/**
 * Which reminder a date `left` days away falls in: the closest one at or above
 * it. The earliest reminder keeps the key it always had, so upgrading doesn't
 * repeat alerts already sent. Null when it's not time yet.
 */
export function reminderTier(days: number[], left: number): { suffix: string } | null {
  const hit = [...days].reverse().find((d) => left <= d);
  if (hit === undefined) return null;
  return { suffix: hit === days[0] ? "" : `:${hit}d` };
}

const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

function addDays(iso: string, n: number) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const dayLabel = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
const money = (cents: number) => formatMoney(Math.abs(cents));

interface Txn {
  id: string;
  accountId: string;
  accountName: string;
  postedDate: string;
  amountCents: number;
  raw: string;
  payee: string | null;
  key: string;
  /** When Muny got it. */
  createdAt: Date;
}

/** Spending-type transactions (no transfers, hidden, pending). */
function loadTxns(db: MunyDb, where: ReturnType<typeof and>): Txn[] {
  const t = schema.transactions;
  return db
    .select({
      id: t.id,
      accountId: t.accountId,
      accountName: schema.accounts.name,
      postedDate: t.postedDate,
      amountCents: t.amountCents,
      raw: t.rawDescription,
      payee: schema.payees.displayName,
      createdAt: t.createdAt,
    })
    .from(t)
    .innerJoin(schema.accounts, eq(schema.accounts.id, t.accountId))
    .leftJoin(schema.payees, eq(schema.payees.id, t.payeeId))
    .leftJoin(schema.categories, eq(schema.categories.id, t.categoryId))
    .leftJoin(schema.categoryGroups, eq(schema.categoryGroups.id, schema.categories.groupId))
    .where(
      and(
        where,
        eq(t.pending, false),
        eq(t.hidden, false),
        isNull(t.transferPairId),
        sql`coalesce(${schema.categoryGroups.kind}, 'expense') <> 'transfer'`,
      ),
    )
    .all()
    .map((r) => ({ ...r, key: merchantKey(r.payee, r.raw) }));
}

const nameOf = (t: Txn) => t.payee ?? cleanPayeeName(t.raw) ?? t.raw.slice(0, 60);

export function evaluateRules(
  db: MunyDb,
  rules: RuleRow[],
  today: string,
  now = new Date(),
): Candidate[] {
  const out: Candidate[] = [];
  const state: AlertState = {
    low: {},
    conn: {},
    ...((db.select().from(schema.appSettings).where(eq(schema.appSettings.key, STATE_KEY)).get()
      ?.value as AlertState | undefined) ?? {}),
  };
  const t = schema.transactions;
  // Each account's own alert settings.
  const perAccount = accountAlerts(db);
  const alertsOf = (accountId: string) => perAccount.get(accountId) ?? DEFAULT_ACCOUNT_ALERTS;
  // Changing an account's alerts never replays what arrived before.
  const afterChange = (x: Txn) => {
    const s = perAccount.get(x.accountId)?.since;
    return !s || x.createdAt.getTime() >= s.getTime();
  };

  // Transactions that arrived recently and after the rule was enabled.
  const freshCache = new Map<number, Txn[]>();
  const fresh = (since: Date) => {
    const from = Math.max(since.getTime(), now.getTime() - 3 * 86_400_000);
    let rows = freshCache.get(from);
    if (!rows) {
      rows = loadTxns(
        db,
        and(gte(t.createdAt, new Date(from)), gte(t.postedDate, addDays(today, -10))),
      );
      freshCache.set(from, rows);
    }
    return rows;
  };

  // Earlier charges at the same merchant, smallest first (six months back).
  let chargesByKey: Map<string, Txn[]> | null = null;
  const chargesBefore = (x: Txn): number[] => {
    if (!chargesByKey) {
      chargesByKey = new Map();
      for (const h of loadTxns(
        db,
        and(gte(t.postedDate, addDays(today, -190)), sql`${t.amountCents} < 0`),
      ))
        chargesByKey.set(h.key, [...(chargesByKey.get(h.key) ?? []), h]);
    }
    return (chargesByKey.get(x.key) ?? [])
      .filter((h) => h.id !== x.id && h.postedDate <= x.postedDate)
      .map((h) => -h.amountCents)
      .sort((a, b) => a - b);
  };

  for (const rule of rules) {
    const p = { ...DEFAULT_PARAMS[rule.type], ...rule.params };
    switch (rule.type) {
      case "large_transaction": {
        for (const x of fresh(rule.since)) {
          const min = alertsOf(x.accountId).largeChargeCents;
          if (min === null || x.amountCents > -min || !afterChange(x)) continue;
          const before = chargesBefore(x);
          const usual = before.length ? (before[Math.floor(before.length / 2)] as number) : null;
          const context =
            usual === null
              ? "The first charge here in the last six months. "
              : `Usually about ${money(usual)} here. `;
          out.push({
            type: rule.type,
            dedupeKey: `large:${x.id}`,
            severity: "info",
            title: `Large charge: ${money(x.amountCents)} at ${nameOf(x)}`,
            body: `${context}${x.accountName} · ${dayLabel(x.postedDate)}`,
            link: "/transactions",
          });
        }
        break;
      }
      case "unusual_charge": {
        const mult = p.multiplier ?? 3;
        const news = fresh(rule.since).filter(
          (x) => x.amountCents < -2000 && alertsOf(x.accountId).unusualCharge && afterChange(x),
        );
        if (!news.length) break;
        for (const x of news) {
          const prior = chargesBefore(x);
          if (prior.length < 3) continue;
          const median = prior[Math.floor(prior.length / 2)] as number;
          if (-x.amountCents < median * mult) continue;
          out.push({
            type: rule.type,
            dedupeKey: `unusual:${x.id}`,
            severity: "warning",
            title: `Unusual charge at ${nameOf(x)}: ${money(x.amountCents)}`,
            body: `Usually about ${money(median)}. ${x.accountName} · ${dayLabel(x.postedDate)}`,
            link: "/transactions",
          });
        }
        break;
      }
      case "duplicate_charge": {
        const days = p.days ?? 3;
        const news = fresh(rule.since).filter(
          (x) => x.amountCents < 0 && alertsOf(x.accountId).duplicateCharge && afterChange(x),
        );
        if (!news.length) break;
        const recent = loadTxns(db, gte(t.postedDate, addDays(today, -(days + 10))));
        for (const x of news) {
          const twin = recent.find(
            (r) =>
              r.id !== x.id &&
              r.accountId === x.accountId &&
              r.amountCents === x.amountCents &&
              r.key === x.key &&
              Math.abs(Date.parse(r.postedDate) - Date.parse(x.postedDate)) <= days * 86_400_000,
          );
          if (!twin) continue;
          const pair = [x.id, twin.id].sort().join(":");
          out.push({
            type: rule.type,
            dedupeKey: `dup:${pair}`,
            severity: "warning",
            title: `Possible duplicate: ${money(x.amountCents)} at ${nameOf(x)}`,
            body: `Charged twice: ${dayLabel(twin.postedDate)} and ${dayLabel(x.postedDate)} on ${x.accountName}.`,
            link: "/transactions",
          });
        }
        break;
      }
      case "low_balance": {
        for (const a of listAccounts(db)) {
          const threshold = alertsOf(a.id).lowBalanceCents;
          if (a.hidden || threshold === null) {
            delete state.low[a.id];
            continue;
          }
          const low = a.balanceCents < threshold;
          if (low && !state.low[a.id]) {
            out.push({
              type: rule.type,
              dedupeKey: `low:${a.id}:${now.getTime()}`,
              severity: "warning",
              title: `Low balance: ${a.name} is at ${formatMoney(a.balanceCents)}`,
              body: `Below your ${formatMoney(threshold)} alert.`,
              link: "/accounts",
            });
          }
          state.low[a.id] = low;
        }
        break;
      }
      case "api_limit": {
        // Once per service per period: the reset time is what makes it unique.
        for (const l of apiLimits(db, now))
          out.push({
            type: rule.type,
            dedupeKey: `api_limit:${l.provider}:${l.period}:${l.resetsAt}`,
            severity: "warning",
            title: `${l.label} reached its ${l.period === "day" ? "daily" : "monthly"} limit`,
            body: `Muny won't use it again until it resets in ${describeWait(l.resetsAt - now.getTime())}.`,
            link: "/settings#api",
          });
        break;
      }
      case "connection_error": {
        for (const c of db.select().from(schema.connections).all()) {
          const bad = c.status === "reauth_required" || c.status === "error";
          if (bad && state.conn[c.id] !== c.status) {
            out.push({
              type: rule.type,
              dedupeKey: `conn:${c.id}:${now.getTime()}`,
              severity: "warning",
              title:
                c.status === "reauth_required"
                  ? `${c.institutionName ?? "A bank"} needs you to log in again`
                  : `Syncing ${c.institutionName ?? "a bank"} failed`,
              body: "Open Accounts in Muny to fix the connection.",
              link: "/accounts",
            });
          }
          if (bad) state.conn[c.id] = c.status;
          else delete state.conn[c.id];
        }
        break;
      }
      case "bill_due": {
        const days = reminderDays(p);
        for (const u of upcoming(db, today, addDays(today, Math.max(...days)), today)) {
          if (u.amountCents >= 0) continue;
          const tier = reminderTier(days, daysBetween(today, u.date));
          if (tier === null) continue;
          out.push({
            type: rule.type,
            dedupeKey: `bill:${u.seriesId}:${u.date}${tier.suffix}`,
            severity: "info",
            title:
              u.date === today
                ? `${u.name} (${money(u.amountCents)}) is due today`
                : `${u.name} (${money(u.amountCents)}) is due ${dayLabel(u.date)}`,
            body: u.accountName ? `Expected from ${u.accountName}.` : "Expected soon.",
            link: "/recurring",
          });
        }
        break;
      }
      case "price_increase": {
        const since = addDays(today, -30);
        for (const s of listSeries(db, today)) {
          const pc = s.priceChange;
          if (!pc || s.status === "ignored" || pc.date < since) continue;
          // Costs are negative; more negative = more expensive.
          if (pc.toCents >= pc.fromCents) continue;
          out.push({
            type: rule.type,
            dedupeKey: `price:${s.id}:${pc.date}`,
            severity: "warning",
            title: `${s.name} went up to ${money(pc.toCents)}`,
            body: `Was ${money(pc.fromCents)}: about ${Math.round(((pc.toCents - pc.fromCents) / pc.fromCents) * 100)}% more (${money(pc.toCents - pc.fromCents)} each time).`,
            link: "/recurring",
          });
        }
        break;
      }
      case "charged_after_cancel": {
        for (const s of listSeries(db, today)) {
          if (!s.chargedAfterCancel) continue;
          out.push({
            type: rule.type,
            dedupeKey: `cac:${s.id}:${s.lastDate}`,
            severity: "warning",
            title: `${s.name} charged you after you cancelled`,
            body: `${money(s.lastAmountCents)} on ${dayLabel(s.lastDate)}. You may be owed a refund.`,
            link: "/recurring",
          });
        }
        break;
      }
      case "trial_ending": {
        const days = reminderDays(p);
        for (const tr of listTrials(db, today)) {
          if (tr.status !== "active" || tr.daysLeft < 0) continue;
          const tier = reminderTier(days, tr.daysLeft);
          if (tier === null) continue;
          const price = tr.priceCents
            ? ` It becomes ${formatMoney(tr.priceCents)}${tr.interval ? ` (${tr.interval})` : ""}.`
            : "";
          out.push({
            type: rule.type,
            dedupeKey: `trial:${tr.id}:${tr.endDate}${tier.suffix}`,
            severity: "warning",
            title:
              tr.daysLeft === 0
                ? `Your ${tr.name} trial ends today`
                : `Your ${tr.name} trial ends ${dayLabel(tr.endDate)}`,
            body: `Cancel before then if you don’t want to keep it.${price}`,
            link: "/recurring#trials",
          });
        }
        break;
      }
      case "budget": {
        const month = today.slice(0, 7);
        const b = budgetMonth(db, month);
        const percents = [...(p.percents ?? [80, 100])].sort((a, z) => z - a);
        const lines = [b.total, ...b.groups.flatMap((g) => g.lines)];
        const muted = new Set(p.mutedCategoryIds ?? []);
        for (const l of lines) {
          if (!l.budgetCents || l.budgetCents <= 0) continue;
          if (muted.has(l.categoryId ?? "total")) continue;
          const limit = l.budgetCents + Math.max(0, l.rolloverCents);
          const pct = (l.spentCents / limit) * 100;
          const hit = percents.find((x) => pct >= x);
          if (hit === undefined) continue;
          const name = l.categoryId ? l.name : "Your total budget";
          out.push({
            type: rule.type,
            dedupeKey: `budget:${month}:${l.categoryId ?? "total"}:${hit}`,
            severity: hit >= 100 ? "warning" : "info",
            title:
              hit >= 100
                ? `${name}: over budget (${formatMoney(l.spentCents)} of ${formatMoney(limit)})`
                : `${name}: ${Math.floor(pct)}% of budget used`,
            body:
              hit >= 100
                ? `${formatMoney(l.spentCents - limit)} over for ${month}.`
                : `${formatMoney(limit - l.spentCents)} left for ${month}.`,
            link: "/budgets",
          });
        }
        break;
      }
    }
  }

  db.insert(schema.appSettings)
    .values({ key: STATE_KEY, value: state })
    .onConflictDoUpdate({ target: schema.appSettings.key, set: { value: state } })
    .run();
  return out;
}

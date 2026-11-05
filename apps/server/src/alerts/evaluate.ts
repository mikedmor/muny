import { cleanPayeeName } from "@muny/core";
import { type MunyDb, schema } from "@muny/db";
import { type AlertParams, type AlertType, formatMoney } from "@muny/shared";
import { and, eq, gte, isNull, sql } from "drizzle-orm";
import { budgetMonth } from "../budgets/service.js";
import { listAccounts } from "../ledger/accounts.js";
import { listSeries, merchantKey, upcoming } from "../recurring/service.js";

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
};

const STATE_KEY = "alerts.state";
interface AlertState {
  low: Record<string, boolean>;
  conn: Record<string, string>;
}

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

  for (const rule of rules) {
    const p = { ...DEFAULT_PARAMS[rule.type], ...rule.params };
    switch (rule.type) {
      case "large_transaction": {
        const min = p.minCents ?? 50_000;
        for (const x of fresh(rule.since)) {
          if (x.amountCents > -min) continue;
          out.push({
            type: rule.type,
            dedupeKey: `large:${x.id}`,
            severity: "info",
            title: `Large charge: ${money(x.amountCents)} at ${nameOf(x)}`,
            body: `${x.accountName} · ${dayLabel(x.postedDate)}`,
            link: "/transactions",
          });
        }
        break;
      }
      case "unusual_charge": {
        const mult = p.multiplier ?? 3;
        const news = fresh(rule.since).filter((x) => x.amountCents < -2000);
        if (!news.length) break;
        const history = loadTxns(
          db,
          and(gte(t.postedDate, addDays(today, -190)), sql`${t.amountCents} < 0`),
        );
        const byKey = new Map<string, Txn[]>();
        for (const h of history) byKey.set(h.key, [...(byKey.get(h.key) ?? []), h]);
        for (const x of news) {
          const prior = (byKey.get(x.key) ?? [])
            .filter((h) => h.id !== x.id && h.postedDate <= x.postedDate)
            .map((h) => -h.amountCents)
            .sort((a, b) => a - b);
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
        const news = fresh(rule.since).filter((x) => x.amountCents < 0);
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
        const threshold = p.thresholdCents ?? 10_000;
        const ids = new Set(p.accountIds ?? []);
        for (const a of listAccounts(db)) {
          if (a.hidden) continue;
          if (ids.size ? !ids.has(a.id) : a.type !== "checking" && a.type !== "savings") continue;
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
        const ahead = p.daysBefore ?? 3;
        for (const u of upcoming(db, today, addDays(today, ahead), today)) {
          if (u.amountCents >= 0) continue;
          out.push({
            type: rule.type,
            dedupeKey: `bill:${u.seriesId}:${u.date}`,
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
            body: `Was ${money(pc.fromCents)} (${money(pc.toCents - pc.fromCents)} more each time).`,
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
      case "budget": {
        const month = today.slice(0, 7);
        const b = budgetMonth(db, month);
        const percents = [...(p.percents ?? [80, 100])].sort((a, z) => z - a);
        const lines = [b.total, ...b.groups.flatMap((g) => g.lines)];
        for (const l of lines) {
          if (!l.budgetCents || l.budgetCents <= 0) continue;
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

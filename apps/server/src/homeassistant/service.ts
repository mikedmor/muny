import type { MunyDb } from "@muny/db";
import { schema } from "@muny/db";
import { type AgentScope, toDecimalString } from "@muny/shared";
import { isNull, sql } from "drizzle-orm";
import { balanceForecast } from "../forecast/service.js";
import { listAccounts } from "../ledger/accounts.js";
import { overview } from "../reports/service.js";

/**
 * Home Assistant sensors (D-091): one flat JSON object for HA's REST
 * integration to poll with a Muny token. Read-only. Money as decimal strings
 * made from integer cents ("1234.56"), so HA can treat them as monetary
 * sensors. Which keys appear depends on the token's permissions:
 *
 * - read:summary: spending, earnings, budget, bills coming up, unread alerts;
 * - read:accounts: net worth, cash, the balance forecast and each account.
 */

const money = (cents: number) => toDecimalString(cents);

export type HaSummary = Record<string, string | number | boolean | null | object>;

export function haSummary(db: MunyDb, scopes: Set<AgentScope>): HaSummary {
  const o = overview(db);
  const out: HaSummary = { currency: "USD", updated: new Date().toISOString(), today: o.today };

  if (scopes.has("read:summary")) {
    out.spent_this_month = money(o.spending.monthToDateCents);
    out.spent_last_month_same_day = money(o.spending.lastMonthSameDayCents);
    out.spent_last_month = money(o.spending.lastMonthTotalCents);
    out.earned_this_month = money(o.incomeMonthToDateCents);
    if (o.budget?.budgetCents) {
      out.budget = money(o.budget.budgetCents);
      out.budget_left = money(o.budget.budgetCents - o.budget.spentCents);
      out.budget_used_pct = Math.round((o.budget.spentCents / o.budget.budgetCents) * 100);
    }
    const bills = o.upcoming.filter((u) => u.amountCents < 0);
    const next = bills[0];
    out.next_bill = next?.name ?? null;
    out.next_bill_date = next?.date ?? null;
    out.next_bill_amount = next ? money(-next.amountCents) : null;
    const week = new Date(`${o.today}T00:00:00Z`);
    week.setUTCDate(week.getUTCDate() + 7);
    const until = week.toISOString().slice(0, 10);
    out.bills_due_7_days = money(
      -bills.filter((u) => u.date <= until).reduce((s, u) => s + u.amountCents, 0),
    );
    out.bills_due_7_days_count = bills.filter((u) => u.date <= until).length;
    out.unread_alerts = Number(
      db
        .select({ n: sql<number>`count(*)` })
        .from(schema.notifications)
        .where(isNull(schema.notifications.readAt))
        .get()?.n ?? 0,
    );
  }

  if (scopes.has("read:accounts")) {
    out.net_worth = money(o.netWorth.nowCents);
    out.net_worth_month_ago =
      o.netWorth.monthAgoCents === null ? null : money(o.netWorth.monthAgoCents);
    const accounts = listAccounts(db).filter((a) => !a.hidden);
    out.cash = money(
      accounts
        .filter((a) => a.type === "checking" || a.type === "savings" || a.type === "cash")
        .reduce((s, a) => s + a.balanceCents, 0),
    );
    const f = balanceForecast(db, { days: 30 });
    if (f.account) {
      out.forecast_account = f.account.name;
      out.forecast_lowest = money(f.lowest.balanceCents);
      out.forecast_lowest_date = f.lowest.date;
      out.forecast_in_30_days = money(f.endCents);
      out.forecast_below_alert = f.firstBelow !== null;
      out.forecast_below_alert_date = f.firstBelow?.date ?? null;
    }
    // Each account, as attributes (names and balances only).
    out.accounts = accounts.map((a) => ({
      name: a.name,
      type: a.type,
      balance: money(a.balanceCents),
    }));
  }
  return out;
}

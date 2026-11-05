import { cleanPayeeName } from "@muny/core";
import type { MunyDb } from "@muny/db";
import type { SpendingOverview } from "@muny/shared";
import { sql } from "drizzle-orm";
import { budgetMonth } from "../budgets/service.js";
import { localToday } from "../lib/dates.js";
import { monthlyReport } from "./service.js";
import { addMonths, categoryMeta, monthEnd } from "./spending.js";

/**
 * Spending page data. "Bills" are transactions linked to a recurring
 * subscription or bill; with includeBills=false they're left out of the
 * breakdown and largest purchases (so everyday spending stands out).
 */
export function spendingOverview(
  db: MunyDb,
  month: string,
  includeBills: boolean,
  today = localToday(),
): SpendingOverview {
  const thisMonth = today.slice(0, 7);
  const period = month < thisMonth ? "past" : month > thisMonth ? "future" : "current";
  const from = `${month}-01`;
  const to = period === "current" ? today : monthEnd(month);
  const prev = addMonths(month, -1);
  const prevEndDay = Math.min(Number(today.slice(8)), Number(monthEnd(prev).slice(8)));
  const cFrom = `${prev}-01`;
  const cTo =
    period === "current" ? `${prev}-${String(prevEndDay).padStart(2, "0")}` : monthEnd(prev);
  const cats = categoryMeta(db);

  const billFilter = includeBills
    ? sql``
    : sql`and (t.recurring_series_id is null or exists (select 1 from recurring_series r where r.id = t.recurring_series_id and r.kind = 'income'))`;

  /** Net spending per category id ("" = uncategorized) between two dates. */
  const byCategory = (a: string, b: string) => {
    const rows = db.all<{ c: string | null; s: number; transfer: number }>(sql`
      select t.category_id as c, sum(t.amount_cents) as s, (t.transfer_pair_id is not null) as transfer
        from transactions t join accounts acc on acc.id = t.account_id
       where t.hidden = 0 and acc.exclude_from_reports = 0
         and t.posted_date between ${a} and ${b}
         and not exists (select 1 from transaction_splits x where x.transaction_id = t.id)
         ${billFilter}
       group by c, transfer
      union all
      select sp.category_id as c, sum(sp.amount_cents) as s, 0 as transfer
        from transaction_splits sp
        join transactions t on t.id = sp.transaction_id
        join accounts acc on acc.id = t.account_id
       where t.hidden = 0 and acc.exclude_from_reports = 0
         and t.posted_date between ${a} and ${b}
         ${billFilter}
       group by c
    `);
    const out = new Map<string, number>();
    for (const r of rows) {
      if (!r.c && r.transfer) continue; // uncategorized side of a transfer
      if (r.c && cats.get(r.c)?.kind !== "expense") continue;
      const k = r.c ?? "";
      out.set(k, (out.get(k) ?? 0) - Number(r.s));
    }
    return out;
  };

  const now = period === "future" ? new Map<string, number>() : byCategory(from, to);
  const before = byCategory(cFrom, cTo);
  const ids = new Set([...now.keys(), ...before.keys()]);
  const categories = [...ids]
    .map((k) => {
      const meta = k ? cats.get(k) : undefined;
      return {
        id: k || null,
        name: meta?.name ?? "Uncategorized",
        groupName: meta?.groupName ?? null,
        cents: now.get(k) ?? 0,
        compareCents: before.get(k) ?? 0,
      };
    })
    .filter((c) => c.cents > 0 || c.compareCents > 0)
    .sort((x, y) => y.cents - x.cents || y.compareCents - x.compareCents);
  const sum = (m: Map<string, number>) => [...m.values()].reduce((s, v) => s + Math.max(0, v), 0);

  const largest = db
    .all<{
      id: string;
      d: string;
      cents: number;
      raw: string;
      payee: string | null;
      cat: string | null;
      grp: string | null;
    }>(sql`
      select t.id as id, t.posted_date as d, t.amount_cents as cents, t.raw_description as raw,
             p.display_name as payee, c.name as cat, g.name as grp
        from transactions t
        join accounts acc on acc.id = t.account_id
        left join payees p on p.id = t.payee_id
        left join categories c on c.id = t.category_id
        left join category_groups g on g.id = c.group_id
       where t.hidden = 0 and acc.exclude_from_reports = 0 and t.amount_cents < 0
         and t.transfer_pair_id is null and coalesce(g.kind, 'expense') = 'expense'
         and t.posted_date between ${from} and ${to}
         ${billFilter}
       order by t.amount_cents asc limit 3
    `)
    .map((r) => ({
      id: r.id,
      date: r.d,
      name: r.payee ?? cleanPayeeName(r.raw) ?? r.raw,
      cents: -Number(r.cents),
      categoryName: r.cat,
      groupName: r.grp,
    }));

  const end = month > thisMonth ? month : thisMonth;
  const chart = monthlyReport(db, addMonths(end, -5), end).months.map((m) => ({
    month: m.month,
    incomeCents: m.incomeCents,
    spendingCents: m.spendingCents,
  }));
  const forecast = budgetMonth(db, month).forecast;
  const payday = forecast.scheduled.find((s) => s.amountCents > 0 && s.date >= today);

  return {
    month,
    period,
    includeBills,
    months: chart,
    totalCents: sum(now),
    compareCents: sum(before),
    categories,
    summary: {
      incomeCents: forecast.incomeSoFarCents,
      nextPayday: payday
        ? { date: payday.date, name: payday.name, amountCents: payday.amountCents }
        : null,
      billsPaidCents: forecast.recurringPaidCents,
      billsDueCents: forecast.recurringDueCents,
    },
    largest: period === "future" ? [] : largest,
  };
}

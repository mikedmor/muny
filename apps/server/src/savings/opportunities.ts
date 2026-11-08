import { type MunyDb, schema } from "@muny/db";
import {
  currentPlan,
  formatMoney,
  type LoanPlanSettings,
  orderLoans,
  type PlanLoan,
  type SavingsOpportunities,
  type SavingsOpportunity,
  simulatePlan,
} from "@muny/shared";
import { eq } from "drizzle-orm";
import { cardsReport } from "../cards/service.js";
import { listAccounts } from "../ledger/accounts.js";
import { localToday } from "../lib/dates.js";
import { loansReport } from "../loans/service.js";
import { listSeries } from "../recurring/service.js";
import { monthlyReport } from "../reports/service.js";
import { addMonths } from "../reports/spending.js";
import { savingsAccountsReport } from "./accounts.js";
import { alternativeSuggestions } from "./service.js";

/**
 * Ways to save, worked out from your own data by fixed rules: no model, no
 * network. Every one says how it was worked out, and each amount is a yearly
 * estimate in whole cents (display only, never the money path). Some overlap
 * (a subscription can be both a duplicate and replaceable), so the total is an
 * upper bound.
 */

const DISMISSED_KEY = "savings.opportunities.dismissed";
/** Below this a year, it isn't worth your attention. */
const MIN_YEARLY_CENTS = 600;
const yearly = (monthlyCents: number) => monthlyCents * 12;
const perMonth = (cents: number) => `${formatMoney(cents)}/mo`;

function plannedLoans(db: MunyDb, plan: LoanPlanSettings, today: string): PlanLoan[] {
  return loansReport(db, today)
    .loans.filter((l) => l.balanceCents > 0)
    .filter((l) =>
      l.kind === "mortgage"
        ? plan.included.includes(l.accountId)
        : !plan.excluded.includes(l.accountId),
    )
    .map((l) => {
      const payment =
        l.principalInterestCents ?? l.monthlyPaymentCents ?? l.minimumPaymentCents ?? 0;
      return {
        id: l.accountId,
        name: l.name,
        balanceCents: l.balanceCents,
        aprBps: l.aprBps ?? 0,
        paymentCents: payment,
        minimumCents: Math.min(payment, l.minimumPaymentCents ?? payment),
      };
    })
    .filter((l) => l.paymentCents > 0);
}

export function savingsOpportunities(
  db: MunyDb,
  plan: LoanPlanSettings,
  today = localToday(),
): SavingsOpportunities {
  const out: SavingsOpportunity[] = [];
  const series = listSeries(db, today).filter(
    (s) =>
      s.active && s.status !== "ignored" && s.status !== "cancelled" && s.expectedAmountCents < 0,
  );

  // Several subscriptions doing the same job: dropping the cheapest saves at least that.
  const groups = new Map<string, typeof series>();
  for (const s of series.filter((x) => x.kind === "subscription" && x.categoryId)) {
    const g = groups.get(s.categoryId as string) ?? [];
    g.push(s);
    groups.set(s.categoryId as string, g);
  }
  for (const [categoryId, g] of groups) {
    if (g.length < 2) continue;
    const sorted = [...g].sort((a, b) => Math.abs(b.monthlyCents) - Math.abs(a.monthlyCents));
    const cheapest = sorted.at(-1) as (typeof g)[number];
    out.push({
      id: `overlap:${categoryId}:${sorted.map((s) => s.id).join(",")}`,
      kind: "overlap",
      title: `${g.length} ${cheapest.categoryName ?? "similar"} subscriptions`,
      detail: `You pay for ${g.length} services in ${cheapest.categoryName ?? "one category"}. Dropping even the cheapest, ${cheapest.name}, saves this much.`,
      yearlyCents: Math.abs(cheapest.annualCents),
      confidence: "likely",
      evidence: sorted.map((s) => ({ label: s.name, value: perMonth(Math.abs(s.monthlyCents)) })),
      link: { to: "/recurring" },
    });
  }

  // Charged after you cancelled: money leaving for nothing.
  for (const s of series.filter((x) => x.chargedAfterCancel)) {
    out.push({
      id: `after-cancel:${s.id}:${s.lastDate}`,
      kind: "charged_after_cancel",
      title: `${s.name} is still charging you`,
      detail: `You marked it cancelled, but it charged again on ${s.lastDate}. Ask for a refund and check the cancellation went through.`,
      yearlyCents: Math.abs(s.annualCents),
      confidence: "sure",
      evidence: [
        {
          label: "Last charge",
          value: `${s.lastDate}, ${formatMoney(Math.abs(s.lastAmountCents))}`,
        },
      ],
      link: { to: "/recurring" },
    });
  }

  // Price went up in the last year: ask for the old price, or shop around.
  const yearAgo = `${Number(today.slice(0, 4)) - 1}${today.slice(4)}`;
  for (const s of series) {
    const c = s.priceChange;
    if (!c || c.date < yearAgo || s.expectedAmountCents === 0) continue;
    const rise = Math.abs(c.toCents) - Math.abs(c.fromCents);
    if (rise <= 0) continue;
    out.push({
      id: `price:${s.id}:${c.date}`,
      kind: "price_increase",
      title: `${s.name} went up ${formatMoney(rise)}`,
      detail: `It went from ${formatMoney(Math.abs(c.fromCents))} to ${formatMoney(Math.abs(c.toCents))} on ${c.date}. Asking for the old price, a retention offer or a cheaper plan wins this back.`,
      yearlyCents: Math.round((rise * Math.abs(s.annualCents)) / Math.abs(s.expectedAmountCents)),
      confidence: "likely",
      evidence: [
        { label: "Before", value: formatMoney(Math.abs(c.fromCents)) },
        { label: "Now", value: formatMoney(Math.abs(c.toCents)) },
      ],
      link: { to: "/recurring" },
    });
  }

  // Replaceable with something self-hosted or free (not already a project).
  for (const a of alternativeSuggestions(db, today)) {
    if (a.projectId || !a.alternatives.length) continue;
    const first = a.alternatives[0] as (typeof a.alternatives)[number];
    out.push({
      id: `diy:${a.seriesId}`,
      kind: "diy",
      title: `Replace ${a.seriesName} with ${first.name}`,
      detail: `${first.name} is ${first.kind === "free" ? "free" : `a ${first.kind}`} alternative (${first.effort} effort).${a.tradeoff ? ` What you give up: ${a.tradeoff}` : ""} Running costs aren't counted.`,
      yearlyCents: yearly(a.monthlyCents),
      confidence: "likely",
      evidence: a.alternatives
        .slice(0, 3)
        .map((x) => ({ label: x.name, value: `${x.kind}, ${x.effort} effort` })),
      link: { to: "/savings", hash: "alternatives" },
    });
  }

  // Card interest: paying the statement balance in full each month stops it.
  const monthOfYear = Number(today.slice(5, 7));
  for (const c of cardsReport(db, today).cards) {
    if (c.interestThisYearCents <= 0) continue;
    out.push({
      id: `card-interest:${c.accountId}:${today.slice(0, 4)}`,
      kind: "card_interest",
      title: `Stop paying interest on ${c.name}`,
      detail: `${formatMoney(c.interestThisYearCents)} in interest so far this year${c.aprBps ? ` at ${(c.aprBps / 100).toFixed(2)}% APR` : ""}. Paying the statement balance in full each month means no interest; the amount is this year's pace.`,
      yearlyCents: Math.round((c.interestThisYearCents * 12) / monthOfYear),
      confidence: "likely",
      evidence: [
        { label: "Interest this year", value: formatMoney(c.interestThisYearCents) },
        ...(c.statementBalanceCents !== null
          ? [{ label: "Statement balance", value: formatMoney(c.statementBalanceCents) }]
          : []),
      ],
      link: { to: "/cards" },
    });
  }

  // Debt order: rolling a paid-off loan's payment into the next, highest rate first.
  const loans = plannedLoans(db, plan, today);
  if (loans.length >= 2) {
    const now = currentPlan(loans);
    const better = simulatePlan(loans, {
      extraCents: 0,
      order: orderLoans(loans, "avalanche"),
      rollover: true,
    });
    const saved = now.totalInterestCents - better.totalInterestCents;
    if (now.months && better.months && saved > 0) {
      const sooner = now.months - better.months;
      out.push({
        id: `debt-order:${loans
          .map((l) => l.id)
          .sort()
          .join(",")}`,
        kind: "debt_order",
        title: "Roll paid-off loan payments into the next loan",
        detail: `With no extra money, sending each paid-off loan's payment to the highest-rate loan left saves ${formatMoney(saved)} in interest over the life of the loans${sooner > 0 ? ` and finishes ${sooner} month${sooner === 1 ? "" : "s"} sooner` : ""}. The yearly figure spreads that over today's payoff time.`,
        yearlyCents: Math.round((saved * 12) / now.months),
        confidence: "likely",
        evidence: [
          { label: "Interest as you pay now", value: formatMoney(now.totalInterestCents) },
          { label: "Rolling payments over", value: formatMoney(better.totalInterestCents) },
        ],
        link: { to: "/loans", hash: "plan" },
      });
    }
  }

  // Idle cash: checking well above a month and a half of spending, while savings pays interest.
  const month = today.slice(0, 7);
  const past = monthlyReport(db, addMonths(month, -3), addMonths(month, -1)).months;
  const avgSpend = Math.round(past.reduce((s, m) => s + Math.max(0, m.spendingCents), 0) / 3);
  const checking = listAccounts(db)
    .filter((a) => a.type === "checking" && !a.hidden && !a.excludeFromReports)
    .reduce((s, a) => s + a.balanceCents, 0);
  const best = savingsAccountsReport(db, today)
    .accounts.map((a) => ({ name: a.name, bps: a.apyBps ?? a.earnedApyBps ?? 0 }))
    .sort((a, b) => b.bps - a.bps)[0];
  const buffer = Math.round((avgSpend * 3) / 2);
  const idle = checking - buffer;
  if (best && best.bps >= 50 && avgSpend > 0 && idle >= 50_000) {
    out.push({
      id: `idle-cash:${month}`,
      kind: "idle_cash",
      title: `Move ${formatMoney(idle)} to ${best.name}`,
      detail: `Checking holds ${formatMoney(checking)}, more than a month and a half of your spending (${formatMoney(buffer)}). The rest would earn about ${(best.bps / 100).toFixed(2)}% in ${best.name}.`,
      yearlyCents: Math.round((idle * best.bps) / 10_000),
      confidence: "guess",
      evidence: [
        { label: "Checking", value: formatMoney(checking) },
        { label: "Spending, monthly average", value: formatMoney(avgSpend) },
        { label: "Savings rate", value: `${(best.bps / 100).toFixed(2)}%` },
      ],
      link: { to: "/savings", hash: "accounts" },
    });
  }

  const dismissed = new Set(dismissedIds(db));
  const kept = out
    .filter((o) => o.yearlyCents >= MIN_YEARLY_CENTS)
    .sort((a, b) => b.yearlyCents - a.yearlyCents);
  const items = kept.filter((o) => !dismissed.has(o.id));
  return {
    today,
    totalYearlyCents: items.reduce((s, o) => s + o.yearlyCents, 0),
    items,
    dismissed: kept.filter((o) => dismissed.has(o.id)),
  };
}

export function dismissedIds(db: MunyDb): string[] {
  const row = db
    .select()
    .from(schema.appSettings)
    .where(eq(schema.appSettings.key, DISMISSED_KEY))
    .get();
  return Array.isArray(row?.value) ? (row.value as string[]) : [];
}

/** Hide one (or bring it back). Kept to the latest 500. */
export function setDismissed(db: MunyDb, id: string, dismissed: boolean) {
  const now = dismissedIds(db).filter((x) => x !== id);
  const next = (dismissed ? [...now, id] : now).slice(-500);
  db.insert(schema.appSettings)
    .values({ key: DISMISSED_KEY, value: next })
    .onConflictDoUpdate({ target: schema.appSettings.key, set: { value: next } })
    .run();
}

/**
 * Paying several loans off together (Loans → Payoff plan). Every loan gets
 * its payment each month; whatever is left of the monthly budget (extra
 * money, and the payments of loans already paid off) goes to the loans in
 * priority order. Projections only: display, never the money path, but
 * still whole cents.
 */

export type PlanStrategy = "avalanche" | "snowball" | "custom";

export const PLAN_STRATEGY_LABELS: Record<PlanStrategy, string> = {
  avalanche: "Highest rate first",
  snowball: "Smallest balance first",
  custom: "My own order",
};

export interface PlanLoan {
  id: string;
  name: string;
  balanceCents: number;
  aprBps: number;
  /** What you pay now each month (a mortgage: its principal and interest part). */
  paymentCents: number;
  /** The lowest payment due. */
  minimumCents: number;
}

export interface PlanOptions {
  /** Money on top of the payments, each month. */
  extraCents: number;
  /** Who gets the leftover money first (loan ids). */
  order: string[];
  /** Pay only the minimums and put the rest of today's payments toward the priority loan. */
  minimumsOnly?: boolean;
  /** Paid-off loans' payments go to the next loan (false: they stop; how you pay now). */
  rollover?: boolean;
  maxMonths?: number;
}

export interface PlanResult {
  /** Months until every loan is paid off (null: not within maxMonths). */
  months: number | null;
  totalInterestCents: number;
  /** Month each loan is paid off (null: not within maxMonths). */
  payoffMonth: Record<string, number | null>;
  /** Each loan's balance at the start of each month (month 0 = today). */
  balances: Record<string, number[]>;
  /** What each loan gets in the first month. */
  firstPayment: Record<string, number>;
  /** The monthly budget the plan spends. */
  monthlyCents: number;
}

const interestOf = (balance: number, aprBps: number) => Math.round((balance * aprBps) / 120_000);

/** The order a strategy pays loans in (custom: as given, then any others by rate). */
export function orderLoans(loans: PlanLoan[], strategy: PlanStrategy, custom: string[] = []) {
  const byRate = [...loans].sort((a, b) => b.aprBps - a.aprBps || a.balanceCents - b.balanceCents);
  if (strategy === "avalanche") return byRate.map((l) => l.id);
  if (strategy === "snowball")
    return [...loans]
      .sort((a, b) => a.balanceCents - b.balanceCents || b.aprBps - a.aprBps)
      .map((l) => l.id);
  const ids = new Set(loans.map((l) => l.id));
  const first = custom.filter((id) => ids.has(id));
  return [...first, ...byRate.map((l) => l.id).filter((id) => !first.includes(id))];
}

export function simulatePlan(loans: PlanLoan[], opts: PlanOptions): PlanResult {
  const max = opts.maxMonths ?? 600;
  const rollover = opts.rollover ?? true;
  const base = new Map(
    loans.map((l) => [
      l.id,
      opts.minimumsOnly ? Math.min(l.minimumCents, l.paymentCents) : l.paymentCents,
    ]),
  );
  const monthlyCents = loans.reduce((s, l) => s + l.paymentCents, 0) + opts.extraCents;
  const bal = new Map(loans.map((l) => [l.id, Math.max(0, l.balanceCents)]));
  const balances: Record<string, number[]> = Object.fromEntries(
    loans.map((l) => [l.id, [Math.max(0, l.balanceCents)]]),
  );
  const payoffMonth: Record<string, number | null> = Object.fromEntries(
    loans.map((l) => [l.id, l.balanceCents <= 0 ? 0 : null]),
  );
  const firstPayment: Record<string, number> = Object.fromEntries(loans.map((l) => [l.id, 0]));
  const order = opts.order.filter((id) => bal.has(id));
  for (const l of loans) if (!order.includes(l.id)) order.push(l.id);
  let interest = 0;
  let month = 0;
  const open = () => [...bal.values()].some((b) => b > 0);
  while (open() && month < max) {
    month++;
    // Interest for the month, then each loan's own payment.
    let spent = 0;
    const paid = new Map<string, number>();
    for (const l of loans) {
      const b = bal.get(l.id) ?? 0;
      if (b <= 0) continue;
      const i = interestOf(b, l.aprBps);
      interest += i;
      const pay = Math.min(b + i, base.get(l.id) ?? 0);
      bal.set(l.id, b + i - pay);
      paid.set(l.id, pay);
      spent += pay;
    }
    // The rest of the budget, in priority order.
    // Without rollover a paid-off loan's payment just stops; only the extra moves.
    let left = rollover ? monthlyCents - spent : opts.extraCents;
    for (const id of order) {
      if (left <= 0) break;
      const b = bal.get(id) ?? 0;
      if (b <= 0) continue;
      const more = Math.min(b, left);
      bal.set(id, b - more);
      paid.set(id, (paid.get(id) ?? 0) + more);
      left -= more;
    }
    for (const l of loans) {
      const b = bal.get(l.id) ?? 0;
      balances[l.id]?.push(b);
      if (b <= 0 && payoffMonth[l.id] === null) payoffMonth[l.id] = month;
      if (month === 1) firstPayment[l.id] = paid.get(l.id) ?? 0;
    }
  }
  return {
    months: open() ? null : month,
    totalInterestCents: interest,
    payoffMonth,
    balances,
    firstPayment,
    monthlyCents,
  };
}

/** How you pay now: each loan its own payment, nothing moves between them. */
export const currentPlan = (loans: PlanLoan[]) =>
  simulatePlan(loans, { extraCents: 0, order: [], rollover: false });

/** The smallest extra each month (to the dollar) that pays everything off within `months`. */
export function extraNeeded(
  loans: PlanLoan[],
  months: number,
  opts: Omit<PlanOptions, "extraCents">,
): number | null {
  const fits = (extra: number) => {
    const r = simulatePlan(loans, { ...opts, extraCents: extra, maxMonths: months });
    return r.months !== null && r.months <= months;
  };
  if (fits(0)) return 0;
  let hi = 100;
  const cap = loans.reduce((s, l) => s + l.balanceCents, 0) + 100;
  while (!fits(hi)) {
    if (hi > cap) return null;
    hi *= 2;
  }
  let lo = 0;
  while (hi - lo > 100) {
    const mid = Math.floor((lo + hi) / 200) * 100;
    if (mid <= lo) break;
    if (fits(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** The saved payoff plan (Loans → Payoff plan). */
export interface LoanPlanSettings {
  strategy: PlanStrategy;
  extraCents: number;
  /** "My own order" (loan account ids, first = paid first). */
  order: string[];
  minimumsOnly: boolean;
  /** A paid-off loan's payment goes to the next loan (the "snowball"); off: it stops. */
  rollover: boolean;
  /** Loans left out of the plan (by default, mortgages). */
  excluded: string[];
  /** Mortgages the user put in (otherwise left out). */
  included: string[];
  /** Goal: every loan in the plan paid off by this date. */
  debtFreeBy: string | null;
  /** Goal: a loan paid off by a date (loan account id → YYYY-MM-DD). */
  targets: Record<string, string>;
}

export const DEFAULT_LOAN_PLAN: LoanPlanSettings = {
  strategy: "avalanche",
  extraCents: 0,
  order: [],
  minimumsOnly: false,
  rollover: true,
  excluded: [],
  included: [],
  debtFreeBy: null,
  targets: {},
};

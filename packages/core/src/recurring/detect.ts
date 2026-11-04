/**
 * Recurring-charge detection (subscriptions, bills, regular income).
 *
 * Pure functions: give it transactions grouped by merchant key, get back
 * candidate series. The server decides what to store.
 *
 * Approach:
 *  1. Group by merchant key and direction (money out vs in).
 *  2. Within a group, cluster by amount, so one merchant with two plans
 *     (e.g. two Apple subscriptions) gives two series.
 *  3. Find the interval (weekly ... annual) that best explains the gaps,
 *     allowing the odd missed or doubled-up period.
 *  4. Fixed price (recent charges within 2%) = subscription-like; varying
 *     amounts (utilities) are only accepted for monthly-or-longer intervals.
 */

export const RECURRING_INTERVALS = [
  "weekly",
  "biweekly",
  "monthly",
  "quarterly",
  "semiannual",
  "annual",
] as const;
export type RecurringInterval = (typeof RECURRING_INTERVALS)[number];

const SPEC: Record<
  RecurringInterval,
  { days: number; tol: number; minCount: number; months: number }
> = {
  weekly: { days: 7, tol: 2, minCount: 4, months: 0 },
  biweekly: { days: 14, tol: 3, minCount: 3, months: 0 },
  monthly: { days: 30.44, tol: 5, minCount: 3, months: 1 },
  quarterly: { days: 91.31, tol: 10, minCount: 3, months: 3 },
  semiannual: { days: 182.62, tol: 15, minCount: 2, months: 6 },
  annual: { days: 365.25, tol: 20, minCount: 2, months: 12 },
};

/** How many of this interval fit in a month, for normalizing cost. */
export const PER_MONTH: Record<RecurringInterval, number> = {
  weekly: 52 / 12,
  biweekly: 26 / 12,
  monthly: 1,
  quarterly: 1 / 3,
  semiannual: 1 / 6,
  annual: 1 / 12,
};

export function monthlyCents(amountCents: number, interval: RecurringInterval): number {
  return Math.round(amountCents * PER_MONTH[interval]);
}

export interface RecurringInput {
  id: string;
  key: string;
  date: string;
  amountCents: number;
  accountId: string;
}

export interface RecurringCandidate {
  key: string;
  direction: "out" | "in";
  interval: RecurringInterval;
  /** Member transaction ids, oldest first. */
  transactionIds: string[];
  firstDate: string;
  lastDate: string;
  nextDate: string;
  /** Latest charge (fixed) or median of recent ones (variable), signed. */
  expectedAmountCents: number;
  lastAmountCents: number;
  /** Recent amounts within 2% of each other. */
  fixedAmount: boolean;
  /** Center of the amount cluster (absolute cents), used to re-identify the series. */
  anchorCents: number;
  accountId: string;
  /** Charged recently enough to still be running. */
  active: boolean;
}

const DAY = 86_400_000;
const toDay = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / DAY;
const fromDay = (d: number) => new Date(d * DAY).toISOString().slice(0, 10);

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

/** Add one interval to a date (calendar months for monthly and longer, clamping the day). */
export function addInterval(iso: string, interval: RecurringInterval, times = 1): string {
  const spec = SPEC[interval];
  if (spec.months === 0) return fromDay(toDay(iso) + spec.days * times);
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const total = m - 1 + spec.months * times;
  const ny = y + Math.floor(total / 12);
  const nm = ((total % 12) + 12) % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${ny}-${String(nm + 1).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

/** Score how well an interval explains the gaps (0..1), or -1 if it doesn't. */
function scoreInterval(gaps: number[], interval: RecurringInterval): number {
  const { days, tol } = SPEC[interval];
  let exact = 0;
  let ok = 0;
  for (const g of gaps) {
    const n = Math.round(g / days);
    if (n < 1 || n > 2) continue;
    if (Math.abs(g - n * days) <= tol * n) {
      ok++;
      if (n === 1) exact++;
    }
  }
  if (gaps.length === 0) return -1;
  if (ok / gaps.length < 0.75 || exact / gaps.length < 0.5) return -1;
  return exact / gaps.length;
}

/** Relative spread of amounts: median absolute deviation / median. */
function spread(amounts: number[]): number {
  const med = median(amounts);
  if (med === 0) return Number.POSITIVE_INFINITY;
  return median(amounts.map((a) => Math.abs(a - med))) / med;
}

function detectInCluster(
  rows: RecurringInput[],
  direction: "out" | "in",
  today: string,
  allowVariable: boolean,
): RecurringCandidate | null {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  // Same-day duplicates (e.g. a charge and its retry) count once for timing.
  const days = [...new Set(sorted.map((r) => toDay(r.date)))];
  if (days.length < 2) return null;
  const gaps = days.slice(1).map((d, i) => d - (days[i] as number));

  let best: { interval: RecurringInterval; score: number } | null = null;
  for (const interval of RECURRING_INTERVALS) {
    if (days.length < SPEC[interval].minCount) continue;
    const s = scoreInterval(gaps, interval);
    if (s > (best?.score ?? -1)) best = { interval, score: s };
  }
  if (!best || best.score < 0) return null;

  const abs = sorted.map((r) => Math.abs(r.amountCents));
  const recent = abs.slice(-3);
  const fixedAmount =
    spread(recent) <= 0.02 &&
    Math.max(...recent) - Math.min(...recent) <= Math.max(...recent) * 0.02;
  if (!fixedAmount) {
    // Varying amounts: only plausible for bills on a monthly-or-longer cycle.
    if (!allowVariable || SPEC[best.interval].months === 0 || spread(abs) > 0.35) return null;
  }
  // Two occurrences are only convincing with an identical price.
  if (days.length === 2 && !fixedAmount) return null;

  const last = sorted[sorted.length - 1] as RecurringInput;
  const sign = direction === "out" ? -1 : 1;
  const expectedAbs = fixedAmount ? Math.abs(last.amountCents) : Math.round(median(recent));
  let next = addInterval(last.date, best.interval);
  // If we're past the expected date, roll forward (it may just be late or skipped).
  for (let i = 0; i < 3 && next < today; i++) next = addInterval(next, best.interval);
  const graceDays = SPEC[best.interval].days * 1.5 + 7;
  return {
    key: rows[0]?.key ?? "",
    direction,
    interval: best.interval,
    transactionIds: sorted.map((r) => r.id),
    firstDate: sorted[0]?.date ?? last.date,
    lastDate: last.date,
    nextDate: next,
    expectedAmountCents: sign * expectedAbs,
    lastAmountCents: last.amountCents,
    fixedAmount,
    anchorCents: Math.round(median(abs)),
    accountId: last.accountId,
    active: toDay(today) - toDay(last.date) <= graceDays,
  };
}

/** Split a merchant's transactions into amount clusters (±25% of the cluster's smallest). */
function clusterByAmount(rows: RecurringInput[]): RecurringInput[][] {
  const sorted = [...rows].sort((a, b) => Math.abs(a.amountCents) - Math.abs(b.amountCents));
  const out: RecurringInput[][] = [];
  let cur: RecurringInput[] = [];
  let base = 0;
  for (const r of sorted) {
    const a = Math.abs(r.amountCents);
    if (cur.length && a <= base * 1.25) cur.push(r);
    else {
      if (cur.length) out.push(cur);
      cur = [r];
      base = a;
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

export function detectRecurring(rows: RecurringInput[], today: string): RecurringCandidate[] {
  const groups = new Map<string, RecurringInput[]>();
  for (const r of rows) {
    if (r.amountCents === 0 || !r.key) continue;
    const k = `${r.key}\u0000${r.amountCents < 0 ? "out" : "in"}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const found: RecurringCandidate[] = [];
  for (const [k, group] of groups) {
    const direction = k.endsWith("out") ? "out" : "in";
    const used = new Set<string>();
    for (const cluster of clusterByAmount(group)) {
      const c = detectInCluster(cluster, direction, today, false);
      if (c) {
        found.push(c);
        for (const id of c.transactionIds) used.add(id);
      }
    }
    // Whatever's left may still be one variable bill (e.g. electricity).
    const rest = group.filter((r) => !used.has(r.id));
    if (rest.length >= 3 && used.size === 0) {
      const c = detectInCluster(rest, direction, today, true);
      if (c) found.push(c);
    }
  }
  return found.sort((a, b) => a.nextDate.localeCompare(b.nextDate));
}

/** Expected dates of a series between `from` and `to` (inclusive). */
export function occurrencesBetween(
  nextDate: string,
  interval: RecurringInterval,
  from: string,
  to: string,
): string[] {
  const out: string[] = [];
  let d = nextDate;
  let i = 0;
  while (d < from && i < 1000) {
    d = addInterval(nextDate, interval, ++i);
  }
  while (d <= to && out.length < 400) {
    out.push(d);
    d = addInterval(nextDate, interval, ++i);
  }
  return out;
}

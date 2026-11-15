import {
  type PayAmount,
  type PayBreakdown,
  type PayLine,
  type PayPeriodView,
  type PayStubRead,
  periodsPerYear,
  type W2Check,
  type W2Read,
} from "@muny/shared";

/**
 * A year of pay, gross down to take-home. With stubs, the latest stub's
 * year-to-date column is the year so far (a line without one is added up from
 * the stubs you uploaded, and says so). With only a W-2, its boxes and ADP's
 * earnings summary give the whole year.
 */

/** "Northwind Parts, LLC" and "NORTHWIND PARTS LLC" are the same employer. */
export const employerKey = (s: string | null | undefined) =>
  (s ?? "")
    .toLowerCase()
    .replace(/\b(llc|inc|corp|corporation|co|company|ltd|lp|llp)\b/g, "")
    .replace(/[^a-z0-9]/g, "");

const byDate = (a: PayStubRead, b: PayStubRead) => a.payDate.localeCompare(b.payDate);

function addTo(list: PayAmount[], item: PayAmount) {
  const same = list.find((a) => a.name.toLowerCase() === item.name.toLowerCase());
  if (!same) list.push({ ...item });
  else {
    same.cents += item.cents;
    same.fromStubs ||= item.fromStubs;
  }
}

/** One employer's year so far, from its latest stub. */
function yearSoFar(stubs: PayStubRead[]) {
  const sorted = [...stubs].sort(byDate);
  const latest = sorted[sorted.length - 1] as PayStubRead;
  const taxes: PayAmount[] = [];
  const deductions: PayAmount[] = [];
  const names = new Map<string, PayLine>();
  for (const s of sorted)
    for (const l of s.lines)
      if (l.kind === "tax" || l.kind === "deduction")
        names.set(`${l.kind}:${l.name.toLowerCase()}`, l);
  for (const [key, any] of names) {
    const kind = key.startsWith("tax:") ? "tax" : "deduction";
    const now = latest.lines.find(
      (l) => l.kind === kind && l.name.toLowerCase() === any.name.toLowerCase(),
    );
    let item: PayAmount;
    if (now && now.ytdCents !== null) item = { name: now.name, cents: now.ytdCents };
    else {
      const cents = sorted.reduce(
        (t, s) =>
          t +
          s.lines
            .filter((l) => l.kind === kind && l.name.toLowerCase() === any.name.toLowerCase())
            .reduce((u, l) => u + (l.cents ?? 0), 0),
        0,
      );
      item = { name: any.name, cents, fromStubs: true };
    }
    if (any.preTax) item.preTax = true;
    if (item.cents) addTo(kind === "tax" ? taxes : deductions, item);
  }
  const grossCents = latest.ytdGrossCents ?? sorted.reduce((t, s) => t + s.grossCents, 0);
  return { latest, grossCents, taxes, deductions };
}

const total = (list: PayAmount[]) => list.reduce((t, a) => t + a.cents, 0);
const desc = (a: PayAmount, b: PayAmount) => b.cents - a.cents;

export function payBreakdown(
  year: number,
  stubs: PayStubRead[],
  w2s: W2Read[],
): PayBreakdown | null {
  const mine = stubs.filter((s) => s.payDate.startsWith(`${year}-`));
  const yearW2s = w2s.filter((w) => w.year === year);
  const dd = yearW2s.flatMap((w) => w.box12.filter((b) => b.code === "DD"));
  const healthCoverageCents = dd.length ? dd.reduce((t, b) => t + b.cents, 0) : null;

  if (mine.length) {
    const groups = new Map<string, PayStubRead[]>();
    for (const s of mine) {
      const k = employerKey(s.employer);
      groups.set(k, [...(groups.get(k) ?? []), s]);
    }
    const taxes: PayAmount[] = [];
    const deductions: PayAmount[] = [];
    let grossCents = 0;
    const employers: string[] = [];
    let asOf = "";
    for (const g of groups.values()) {
      const y = yearSoFar(g);
      grossCents += y.grossCents;
      for (const t of y.taxes) addTo(taxes, t);
      for (const d of y.deductions) addTo(deductions, d);
      if (y.latest.employer) employers.push(y.latest.employer);
      if (y.latest.payDate > asOf) asOf = y.latest.payDate;
    }
    return withHealth(yearW2s, {
      source: "stubs",
      asOf,
      employers,
      grossCents,
      taxes: taxes.sort(desc),
      deductions: deductions.sort(desc),
      takeHomeCents: grossCents - total(taxes) - total(deductions),
      healthCoverageCents,
      yourHealthCents: null,
      employerHealthCents: null,
    });
  }

  if (!yearW2s.length) return null;
  const taxes: PayAmount[] = [];
  const deductions: PayAmount[] = [];
  let grossCents = 0;
  for (const w of yearW2s) {
    const b = w.boxes;
    // Box 1 is after pre-tax deductions; ADP's summary gives the gross and what came out.
    grossCents += w.summary.grossCents ?? b.wagesCents ?? 0;
    if (w.summary.grossCents !== null)
      for (const a of w.summary.adjustments)
        if (a.cents < 0)
          addTo(deductions, { name: friendlyName(a.name), cents: -a.cents, preTax: true });
    const add = (name: string, cents: number | null) => {
      if (cents) addTo(taxes, { name, cents });
    };
    add("Federal Income Tax", b.federalCents);
    add("Social Security Tax", b.ssCents);
    add("Medicare Tax", b.medicareCents);
    add(`${b.state ?? "State"} State Income Tax`, b.stateCents);
    add("Local Income Tax", b.localCents);
  }
  return withHealth(yearW2s, {
    source: "w2",
    asOf: `${year}-12-31`,
    employers: yearW2s.map((w) => w.employer).filter((e): e is string => !!e),
    grossCents,
    taxes: taxes.sort(desc),
    deductions: deductions.sort(desc),
    takeHomeCents: grossCents - total(taxes) - total(deductions),
    healthCoverageCents,
    yourHealthCents: null,
    employerHealthCents: null,
  });
}

/** ADP's "Other Cafe 125" is health premiums taken before tax under Section 125. */
const CAFE_125 = /\bcafe(teria)?\b.*\b125\b|\bsec(tion)?\.?\s*125\b|^125\b/i;
export const HEALTH_PREMIUMS = "Health premiums (medical, dental, vision)";
const friendlyName = (name: string) => (CAFE_125.test(name) ? HEALTH_PREMIUMS : name);

/** Health insurance premiums, not an FSA, HSA or dependent care account. */
const HEALTH = /cafe|125|medical|dental|vision|health|premium/i;
const NOT_PREMIUM = /fsa|flex|hsa|savings|dependent|dep care|life|disab/i;
const isPremium = (name: string) => HEALTH.test(name) && !NOT_PREMIUM.test(name);

/**
 * Box 12 DD is the whole cost of health coverage. Your share is the health
 * premiums taken from your pay that year (the W-2's own summary when it has
 * one, else the stubs); the rest is roughly what your employer paid.
 */
function withHealth(w2s: W2Read[], b: PayBreakdown): PayBreakdown {
  if (b.healthCoverageCents === null) return b;
  const fromW2 = w2s.flatMap((w) =>
    w.summary.adjustments.filter((a) => a.cents < 0 && isPremium(a.name)),
  );
  const yours = fromW2.length
    ? fromW2.reduce((t, a) => t - a.cents, 0)
    : b.deductions.filter((d) => d.preTax && isPremium(d.name)).reduce((t, d) => t + d.cents, 0);
  if (!yours || yours > b.healthCoverageCents) return b;
  return {
    ...b,
    yourHealthCents: yours,
    employerHealthCents: b.healthCoverageCents - yours,
  };
}

/** The latest stub's period, with how many periods make a year. */
export function latestPeriod(stubs: PayStubRead[]): PayPeriodView | null {
  const latest = [...stubs].sort(byDate).pop();
  if (!latest) return null;
  const pick = (kind: PayLine["kind"]): PayAmount[] =>
    latest.lines
      .filter((l) => l.kind === kind && l.cents)
      .map((l) => ({
        name: l.name,
        cents: l.cents as number,
        ...(l.preTax ? { preTax: true } : {}),
      }))
      .sort(desc);
  const taxes = pick("tax");
  const deductions = pick("deduction");
  return {
    payDate: latest.payDate,
    employer: latest.employer,
    periodsPerYear: periodsPerYear(latest.periodStart, latest.periodEnd),
    grossCents: latest.grossCents,
    taxesCents: total(taxes),
    deductionsCents: total(deductions),
    netCents: latest.netCents,
    taxes,
    deductions,
  };
}

/** A W-2 next to the year's last stub from the same employer, total by total. */
export function w2Check(
  w2: W2Read,
  stubs: PayStubRead[],
): { stubDate: string; rows: W2Check[] } | null {
  const key = employerKey(w2.employer);
  const last = stubs
    .filter((s) => s.payDate.startsWith(`${w2.year}-`) && (!key || employerKey(s.employer) === key))
    .sort(byDate)
    .pop();
  if (!last) return null;
  const taxes = last.lines.filter((l) => l.kind === "tax");
  const ytd = (re: RegExp, not?: RegExp) => {
    const hits = taxes.filter((l) => re.test(l.name) && !not?.test(l.name));
    return hits.length ? hits.reduce((t, l) => t + (l.ytdCents ?? 0), 0) : null;
  };
  const rows: W2Check[] = [];
  const push = (label: string, w2Cents: number | null, stubCents: number | null) => {
    if (w2Cents !== null) rows.push({ label, w2Cents, stubCents });
  };
  push("Gross pay", w2.summary.grossCents, last.ytdGrossCents);
  push("Federal income tax (box 2)", w2.boxes.federalCents, ytd(/federal/i));
  push("Social Security tax (box 4)", w2.boxes.ssCents, ytd(/social security|oasdi|fica/i));
  push("Medicare tax (box 6)", w2.boxes.medicareCents, ytd(/medicare/i));
  push(
    `${w2.boxes.state ?? "State"} income tax (box 17)`,
    w2.boxes.stateCents,
    ytd(/\bstate\b|^[A-Z]{2}\b.*\bincome\b/i, /federal|local|city|county|occ/i),
  );
  push("Local income tax (box 19)", w2.boxes.localCents, ytd(/local|city|county|occ/i));
  return { stubDate: last.payDate, rows };
}

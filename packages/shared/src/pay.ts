/**
 * Pay: what you earn before it reaches the bank. Read from pay stubs (earnings
 * statements) and W-2s you upload; amounts are integer cents.
 */

/** A pay stub line: what it is, this period's amount and the year to date. */
export type PayLineKind = "earning" | "tax" | "deduction" | "deposit" | "info";

export interface PayLine {
  kind: PayLineKind;
  name: string;
  /** This period, positive; null when the stub shows only a year-to-date amount. */
  cents: number | null;
  /** Year to date, positive; null when the stub doesn't show one. */
  ytdCents: number | null;
  /** Taken before federal income tax (marked * on ADP stubs). */
  preTax?: boolean;
}

/** What a pay stub says, as read from the PDF. */
export interface PayStubRead {
  employer: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  payDate: string;
  grossCents: number;
  netCents: number;
  ytdGrossCents: number | null;
  federalTaxableCents: number | null;
  lines: PayLine[];
  /** Where net pay went: each direct deposit, with the account's last 4 digits when shown. */
  deposits: { cents: number; last4: string | null }[];
  /** Paid as a paper check. */
  checkCents: number;
}

export interface PayDeposit {
  cents: number;
  last4: string | null;
  /** The bank transaction it became, when Muny can find it. */
  transaction: { id: string; date: string; accountName: string } | null;
}

export interface PayStubInfo extends Omit<PayStubRead, "deposits"> {
  id: string;
  filename: string;
  uploadedAt: number;
  deposits: PayDeposit[];
  /** Ways the stub doesn't add up; empty when it does. */
  problems: string[];
}

/** W-2 boxes, in cents. */
export interface W2Boxes {
  wagesCents: number | null;
  federalCents: number | null;
  ssWagesCents: number | null;
  ssCents: number | null;
  medicareWagesCents: number | null;
  medicareCents: number | null;
  state: string | null;
  stateWagesCents: number | null;
  stateCents: number | null;
  localWagesCents: number | null;
  localCents: number | null;
}

export interface W2Read {
  year: number;
  employer: string | null;
  boxes: W2Boxes;
  /** Box 12: code and amount (DD is the cost of health coverage, yours and your employer's). */
  box12: { code: string; cents: number }[];
  /** How gross pay became box 1, when the form shows it (ADP's earnings summary). */
  summary: { grossCents: number | null; adjustments: { name: string; cents: number }[] };
}

/** A W-2 total next to the same total from the year's last pay stub. */
export interface W2Check {
  label: string;
  w2Cents: number;
  stubCents: number | null;
}

export interface W2Info extends W2Read {
  id: string;
  filename: string;
  uploadedAt: number;
  /** Compared with the last stub of the year from the same employer; null with none uploaded. */
  check: { stubDate: string; rows: W2Check[] } | null;
}

/** One line of a year's breakdown. */
export interface PayAmount {
  name: string;
  cents: number;
  preTax?: boolean;
  /** Added up from the stubs you uploaded because the stub has no year-to-date amount. */
  fromStubs?: boolean;
}

/** Gross pay down to take-home, for a year so far (or a whole year from a W-2). */
export interface PayBreakdown {
  source: "stubs" | "w2";
  /** The last pay date counted (stubs), or the year's end (W-2). */
  asOf: string;
  employers: string[];
  grossCents: number;
  taxes: PayAmount[];
  deductions: PayAmount[];
  /** Gross less taxes and deductions. From a W-2 alone it still includes after-tax deductions. */
  takeHomeCents: number;
  /** W-2 box 12 DD: the whole cost of your health coverage, both shares. */
  healthCoverageCents: number | null;
  /** Your health premiums that year (taken from your pay), when the W-2's DD is known. */
  yourHealthCents: number | null;
  /** Roughly what your employer paid toward health coverage: DD less your premiums. */
  employerHealthCents: number | null;
}

/** The latest pay period, and the same at that rate for a year. */
export interface PayPeriodView {
  payDate: string;
  employer: string | null;
  periodsPerYear: number;
  grossCents: number;
  taxesCents: number;
  deductionsCents: number;
  netCents: number;
  taxes: PayAmount[];
  deductions: PayAmount[];
}

export interface PayYear {
  year: number;
  /** Years with a stub or W-2, newest first. */
  years: number[];
  breakdown: PayBreakdown | null;
  latest: PayPeriodView | null;
  stubs: PayStubInfo[];
  w2s: W2Info[];
}

export interface PayUploadResult {
  kind: "stub" | "w2";
  id: string;
  /** "Pay stub for Nov 13, 2026" or "2025 W-2". */
  label: string;
  problems: string[];
}

/** Pay periods in a year from the days a period covers (7 → weekly). */
export function periodsPerYear(periodStart: string | null, periodEnd: string | null): number {
  if (!periodStart || !periodEnd) return 52;
  const days =
    Math.round(
      (Date.parse(`${periodEnd}T00:00:00Z`) - Date.parse(`${periodStart}T00:00:00Z`)) / 864e5,
    ) + 1;
  if (days <= 8) return 52;
  if (days <= 14) return 26;
  if (days <= 16) return 24;
  return 12;
}

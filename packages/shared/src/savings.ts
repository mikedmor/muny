/** Savings ledger, DIY replacements and self-hosting costs. Amounts are positive cents. */

export const SAVING_KINDS = ["cancelled", "downgraded", "negotiated", "replaced", "other"] as const;
export type SavingKind = (typeof SAVING_KINDS)[number];
export type SavingStatus = "projected" | "verified" | "failed";

export interface Saving {
  id: string;
  kind: SavingKind;
  name: string;
  seriesId: string | null;
  beforeMonthlyCents: number;
  afterMonthlyCents: number;
  /** before - after */
  monthlyCents: number;
  effectiveDate: string;
  status: SavingStatus;
  /** Why it's verified/failed, e.g. "No charge since Oct 3". */
  statusNote: string | null;
  notes: string | null;
  /** Saved so far: whole months since the change × monthly (verified only). */
  realizedCents: number;
}

export interface SavingInput {
  kind: SavingKind;
  name?: string;
  seriesId?: string | null;
  beforeMonthlyCents?: number;
  afterMonthlyCents?: number;
  effectiveDate?: string;
  notes?: string | null;
  /** cancelled/replaced: also mark the recurring charge cancelled (default true). */
  cancelSeries?: boolean;
}

export const DIY_STATUSES = ["idea", "testing", "migrated", "cancelled", "abandoned"] as const;
export type DiyStatus = (typeof DIY_STATUSES)[number];
export type Effort = "low" | "medium" | "high";

export interface DiyProject {
  id: string;
  serviceName: string;
  seriesId: string | null;
  /** Current monthly cost of the paid service (from the recurring charge), if linked. */
  serviceMonthlyCents: number | null;
  alternative: string;
  status: DiyStatus;
  effort: Effort | null;
  runningMonthlyCents: number;
  savingId: string | null;
  notes: string | null;
}

export interface DiyInput {
  serviceName?: string;
  seriesId?: string | null;
  alternative?: string;
  status?: DiyStatus;
  effort?: Effort | null;
  runningMonthlyCents?: number;
  notes?: string | null;
}

export const INFRA_KINDS = [
  "power",
  "hardware",
  "domain",
  "hosting",
  "storage",
  "software",
  "other",
] as const;
export type InfraKind = (typeof INFRA_KINDS)[number];

export interface InfraCost {
  id: string;
  name: string;
  kind: InfraKind;
  amountCents: number | null;
  period: "monthly" | "annual" | "once" | null;
  amortizeMonths: number | null;
  watts: number | null;
  priceDeciCentsPerKwh: number | null;
  startDate: string;
  endDate: string | null;
  notes: string | null;
  /** What it costs per month right now. */
  monthlyCents: number;
}

export type InfraInput = Omit<InfraCost, "id" | "monthlyCents">;

export interface AlternativeOption {
  name: string;
  url: string;
  kind: "self-hosted" | "open-source app" | "free";
  effort: Effort;
  note?: string;
}

/** A subscription you pay for that has known self-hosted/free alternatives. */
export interface AlternativeSuggestion {
  seriesId: string;
  seriesName: string;
  monthlyCents: number;
  service: string;
  category: string;
  alternatives: AlternativeOption[];
  tradeoff: string | null;
  /** An existing DIY project for this subscription. */
  projectId: string | null;
}

export interface SavingsSummary {
  /** Verified savings per month. */
  verifiedMonthlyCents: number;
  /** Not yet confirmed by the bank data. */
  projectedMonthlyCents: number;
  /** Saved so far (verified). */
  realizedCents: number;
  /** DIY replacements' gross monthly savings (kind "replaced", verified or projected). */
  diyMonthlyCents: number;
  /** Self-hosting running costs per month (infrastructure + per-project costs). */
  infraMonthlyCents: number;
  /** diy - infra */
  diyNetMonthlyCents: number;
}

/** One month of a savings account (display and projection inputs). */
export interface SavingsAccountMonth {
  /** YYYY-MM */
  month: string;
  /** Balance at the end of the month (or today, for this month). */
  balanceCents: number;
  interestCents: number;
  /** Money in that wasn't interest. */
  depositsCents: number;
  /** Money out (negative). */
  withdrawalsCents: number;
}

export interface SavingsAccountInfo {
  id: string;
  name: string;
  institutionName: string | null;
  mask: string | null;
  balanceCents: number;
  /** The APY you entered (hundredths of a percent: 435 = 4.35%). */
  apyBps: number | null;
  /** Your saved plan (Plan & project): monthly deposit, and the rate to project with (null: the APY). */
  plan: { monthlyCents: number; rateBps: number | null } | null;
  /** The rate actually earned over the last year (interest over the average balance). */
  earnedApyBps: number | null;
  interest: { last30Cents: number; ytdCents: number; last12Cents: number; allTimeCents: number };
  lastInterestDate: string | null;
  /** Average net money added per month over the last 12 months (not counting interest). */
  avgMonthlyContributionCents: number;
  /** The last 24 months, oldest first. */
  months: SavingsAccountMonth[];
}

export interface SavingsAccountsReport {
  totalBalanceCents: number;
  interestYtdCents: number;
  interest12Cents: number;
  /** Balance-weighted rate across accounts (entered APY, else earned), hundredths of a percent. */
  blendedApyBps: number | null;
  accounts: SavingsAccountInfo[];
}

/** A category inside a savings account (e.g. "Vacation"). */
export interface SavingsBucket {
  id: string;
  name: string;
  /** What it holds now: the balance you entered plus the moves since. */
  balanceCents: number;
  /** What you entered, and when. */
  enteredCents: number;
  asOf: string;
  goalCents: number | null;
  /** Saves at most this much a month. */
  monthlyCapCents: number | null;
  /** Takes whatever's left over. */
  fillRemaining: boolean;
  /** The account's own cash (what's not in a category); its goal is the target it keeps. */
  isMain: boolean;
  /** When it reaches its goal at its monthly cap (YYYY-MM), if it has both. */
  goalMonth: string | null;
}

export interface SavingsBuckets {
  /** moves: follows the transfers the bank reports between categories; split: the plan applied to the total. */
  mode: "moves" | "split";
  accountBalanceCents: number;
  buckets: SavingsBucket[];
  /** The account's balance not in any category. */
  unassignedCents: number;
  /** Category names seen in the account's transactions, not set up yet. */
  suggestions: string[];
}

export interface SavingsBucketInput {
  id?: string;
  name: string;
  /** Ignored for the main cash (it's the rest of the account). */
  balanceCents: number;
  goalCents?: number | null;
  monthlyCapCents?: number | null;
  fillRemaining?: boolean;
  isMain?: boolean;
}

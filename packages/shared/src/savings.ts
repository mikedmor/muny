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

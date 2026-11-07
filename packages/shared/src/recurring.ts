export const RECURRING_KINDS = ["subscription", "bill", "income"] as const;
export type RecurringKind = (typeof RECURRING_KINDS)[number];

export const RECURRING_STATUSES = ["detected", "confirmed", "ignored", "cancelled"] as const;
export type RecurringStatus = (typeof RECURRING_STATUSES)[number];

export const INTERVAL_LABELS = {
  weekly: "Weekly",
  biweekly: "Every 2 weeks",
  monthly: "Monthly",
  quarterly: "Every 3 months",
  semiannual: "Every 6 months",
  annual: "Yearly",
} as const;
export type Interval = keyof typeof INTERVAL_LABELS;
export const INTERVALS = Object.keys(INTERVAL_LABELS) as Interval[];

export interface RecurringSeries {
  id: string;
  name: string;
  kind: RecurringKind;
  status: RecurringStatus;
  interval: Interval;
  /** Signed, negative = money out. */
  expectedAmountCents: number;
  fixedAmount: boolean;
  /** Normalized to a month / a year (signed). */
  monthlyCents: number;
  annualCents: number;
  firstDate: string;
  lastDate: string;
  lastAmountCents: number;
  /** Next expected charge (may be in the past if it's late). */
  nextDate: string;
  /** Charged recently enough to still be running. */
  active: boolean;
  /** Expected date has passed without a charge (but still within the grace period). */
  late: boolean;
  /** A charge arrived after you marked it cancelled. */
  chargedAfterCancel: boolean;
  accountId: string | null;
  accountName: string | null;
  categoryId: string | null;
  categoryName: string | null;
  source: "detected" | "manual";
  cancelledAt: string | null;
  notes: string | null;
  transactionCount: number;
  /** Most recent price change on a fixed-price series. */
  priceChange: { fromCents: number; toCents: number; date: string } | null;
  /** A charge the bank shows as pending that looks like this series' next one. */
  pending: { transactionId: string; date: string; amountCents: number } | null;
}

export interface UpdateRecurringInput {
  name?: string;
  kind?: RecurringKind;
  status?: RecurringStatus;
  interval?: Interval;
  expectedAmountCents?: number;
  categoryId?: string | null;
  /** With categoryId: also file the series' charges there (not split ones or transfers). */
  applyToTransactions?: boolean;
  notes?: string | null;
}

export interface UpcomingCharge {
  seriesId: string;
  name: string;
  kind: RecurringKind;
  date: string;
  amountCents: number;
  accountName: string | null;
  /** Already at the bank, pending (dated when it was charged, or today if earlier). */
  pending?: boolean;
}

export interface RecurringScanResult {
  created: number;
  updated: number;
  linked: number;
}

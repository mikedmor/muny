/** Free trials you're tracking so they don't silently turn into charges. */

export type TrialStatus = "active" | "cancelled" | "kept";
export type TrialInterval = "weekly" | "monthly" | "quarterly" | "annual";

export interface Trial {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  priceCents: number | null;
  interval: TrialInterval | null;
  status: TrialStatus;
  cancelInfo: string | null;
  notes: string | null;
  /** Days until endDate (negative once it has passed). */
  daysLeft: number;
}

export interface TrialInput {
  name: string;
  startDate: string;
  endDate: string;
  priceCents?: number | null;
  interval?: TrialInterval | null;
  status?: TrialStatus;
  cancelInfo?: string | null;
  notes?: string | null;
}

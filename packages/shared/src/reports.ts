export type SpendingGroupBy = "category" | "group" | "merchant";

export interface SpendingItem {
  /** Category/group id, or merchant key. null = uncategorized. */
  id: string | null;
  name: string;
  /** Net spending (positive = spent). */
  cents: number;
  count: number;
  /** For categories: their group. */
  groupName?: string;
}

export interface SpendingReport {
  from: string;
  to: string;
  by: SpendingGroupBy;
  totalCents: number;
  items: SpendingItem[];
}

export interface MonthTotals {
  /** YYYY-MM */
  month: string;
  incomeCents: number;
  spendingCents: number;
  /** Spending per expense category id ("" = uncategorized). */
  byCategory: Record<string, number>;
}

export interface MonthlyReport {
  months: MonthTotals[];
  categories: { id: string; name: string; groupName: string }[];
}

export interface NetWorthPoint {
  date: string;
  assetsCents: number;
  /** Positive amount owed. */
  debtsCents: number;
  netCents: number;
}

export interface NetWorthReport {
  points: NetWorthPoint[];
  /** Current value per account type bucket, for the breakdown. */
  byType: { type: string; cents: number }[];
}

export interface Overview {
  today: string;
  netWorth: { nowCents: number; monthAgoCents: number | null };
  spending: {
    monthToDateCents: number;
    /** Same span of days last month. */
    lastMonthSameDayCents: number;
    lastMonthTotalCents: number;
  };
  incomeMonthToDateCents: number;
  budget: { budgetCents: number | null; spentCents: number } | null;
  upcoming: { seriesId: string; name: string; date: string; amountCents: number }[];
  topCategories: { id: string | null; name: string; cents: number }[];
  attention: { uncategorized: number; connectionsNeedingLogin: number; newRecurring: number };
}

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
  /** The crypto included in assets. */
  cryptoCents: number;
  /** Something here sits between two recorded values, so its value is worked out. */
  estimated: boolean;
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
    /** Running total spent, one entry per day from the 1st through today. */
    thisMonthDaily: number[];
    /** The same running total by category: the largest few, then "Other" (id "other"). */
    thisMonthByCategory: { id: string | null; name: string; daily: number[] }[];
    /** Running total spent, one entry per day of last month. */
    lastMonthDaily: number[];
    /** Running total earned, one entry per day from the 1st through today. */
    incomeDaily: number[];
    /**
     * Where earnings should end up: today's total plus expected recurring income
     * on its due dates, one entry per day from today through the month's end.
     */
    incomeExpectedDaily: number[];
    /** Expected recurring income still to come this month. */
    incomeExpectedCents: number;
    daysInMonth: number;
  };
  incomeMonthToDateCents: number;
  budget: { budgetCents: number | null; spentCents: number } | null;
  /** Signed: money out is negative, expected income positive. */
  upcoming: { seriesId: string; name: string; date: string; amountCents: number }[];
  topCategories: { id: string | null; name: string; cents: number; groupName: string | null }[];
  /** Biggest merchants by spending this month. */
  topMerchants: { name: string; cents: number; count: number }[];
  /** Income and spending for the last 6 months, this month last. */
  cashFlow: { month: string; incomeCents: number; spendingCents: number }[];
  /** Cash in checking & savings, weekly over the last 26 weeks. */
  cashTrend: { date: string; cents: number }[];
  attention: { uncategorized: number; connectionsNeedingLogin: number; newRecurring: number };
}

/** One category over time, for its detail page. Amounts are positive spending (or income). */
export interface CategoryActivity {
  category: {
    id: string;
    name: string;
    groupName: string;
    kind: "expense" | "income" | "transfer";
  };
  /** Selected month (YYYY-MM). */
  month: string;
  /** Net totals per month for the chart, oldest first, ending at `end`. */
  months: { month: string; cents: number }[];
  /** Budget for the selected month (expense categories), or null if none. */
  budget: { budgetCents: number; rolloverCents: number; availableCents: number } | null;
  /** Transactions (or split parts) in this category in the selected month. */
  stats: { count: number; totalCents: number; averageCents: number; largestCents: number };
}

/** The budget page's "Everything else" row as a category: spending with no category. */
export const EVERYTHING_ELSE = "everything-else";
/** The budget page's "Earnings" row as a category: money in your income categories. */
export const EARNINGS = "earnings";
/** The budget page's "Bills & subscriptions" row as a category: charges from recurring bills. */
export const BILLS = "bills";
/** The budget page's "Home & utilities" row: spending in the home categories. */
export const HOME = "home";
/** The budget page's "All other categories" row: spending that isn't a bill or a home cost. */
export const OTHER_SPENDING = "other-spending";
/** Budget rows that open as a category page, and what the transactions list filters on. */
export const BUDGET_ROWS = [EVERYTHING_ELSE, EARNINGS, HOME, BILLS, OTHER_SPENDING] as const;
export type BudgetRowId = (typeof BUDGET_ROWS)[number];

/** The Spending page: breakdown by category plus a monthly summary. */
export interface SpendingOverview {
  month: string;
  period: "past" | "current" | "future";
  includeBills: boolean;
  /** Income vs spending per month for the chart, oldest first. */
  months: { month: string; incomeCents: number; spendingCents: number }[];
  totalCents: number;
  /** Same span last month (to today's day for the current month, else the full month). */
  compareCents: number;
  categories: {
    id: string | null;
    name: string;
    groupName: string | null;
    cents: number;
    /** Same category over the comparison span. */
    compareCents: number;
  }[];
  summary: {
    incomeCents: number;
    nextPayday: { date: string; name: string; amountCents: number } | null;
    billsPaidCents: number;
    billsDueCents: number;
  };
  largest: {
    id: string;
    date: string;
    name: string;
    cents: number;
    categoryName: string | null;
    groupName: string | null;
  }[];
}

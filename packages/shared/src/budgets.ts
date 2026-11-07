export type BudgetKind = "spending" | "income" | "bills";

export interface BudgetLine {
  /** null for the overall total budget (or the earnings / bills lines). */
  categoryId: string | null;
  /** "spending" for categories and the total; "income" / "bills" for the basics. */
  kind: BudgetKind;
  name: string;
  budgetId: string | null;
  /** This month's budgeted amount (positive), or null if no budget. */
  budgetCents: number | null;
  /** Net spending this month (positive = spent; refunds reduce it). */
  spentCents: number;
  rollover: boolean;
  /** Carried in from previous months (negative = overspent before). */
  rolloverCents: number;
  /** budget + rollover - spent. */
  availableCents: number | null;
  /** Average monthly spending over the previous 3 months, for suggestions. */
  averageCents: number;
  /** Spending in each of the previous 3 months, oldest first (for picking a budget). */
  historyCents: { month: string; cents: number }[];
}

export interface BudgetGroup {
  groupId: string;
  name: string;
  lines: BudgetLine[];
}

/** A recurring charge or paycheck expected later this month. */
export interface ScheduledItem {
  seriesId: string;
  name: string;
  kind: "subscription" | "bill" | "income";
  date: string;
  /** Signed: negative = money out. */
  amountCents: number;
  categoryId: string | null;
}

/**
 * What the rest of the month should look like, from detected recurring
 * charges and income. Projected numbers only add what is scheduled; everyday
 * spending that isn't recurring isn't guessed at.
 */
export interface BudgetForecast {
  /** "past" months are final; "current" is partly forecast; "future" is all forecast. */
  period: "past" | "current" | "future";
  incomeSoFarCents: number;
  /** Recurring income still expected this month. */
  incomeExpectedCents: number;
  /** Average monthly income over the previous 3 months. */
  incomeAverageCents: number;
  /** Recurring bills/subscriptions already charged this month (positive). */
  recurringPaidCents: number;
  /** Recurring bills/subscriptions still due this month (positive). */
  recurringDueCents: number;
  scheduled: ScheduledItem[];
  /** Still-due recurring spending per category id ("" = uncategorized), positive. */
  scheduledByCategory: Record<string, number>;
  /** Spent so far + recurring still due. */
  projectedSpendingCents: number;
  /** Income so far + recurring income still expected. */
  projectedIncomeCents: number;
  projectedLeftoverCents: number;
}

export interface BudgetMonth {
  forecast: BudgetForecast;
  month: string;
  total: BudgetLine;
  /** Earnings: target (budgetCents) vs income received (spentCents). */
  income: BudgetLine;
  /** Bills & subscriptions: budget vs recurring charges paid (spentCents). */
  bills: BudgetLine;
  groups: BudgetGroup[];
  /** Spending with no category (needs categorizing). */
  uncategorizedCents: number;
  incomeCents: number;
  /** Sum of all category budgets this month. */
  budgetedCents: number;
  /** Categories left out of the budget, with this month's spending in them. */
  excluded: { categoryId: string; name: string; groupName: string; spentCents: number }[];
}

export interface SetBudgetInput {
  categoryId: string | null;
  /** With no category: which budget (default "spending", the total). */
  kind?: BudgetKind;
  amountCents: number;
  rollover?: boolean;
  /** YYYY-MM the amount applies from (defaults to the current month). */
  fromMonth?: string;
}

export interface BudgetLine {
  /** null for the overall total budget. */
  categoryId: string | null;
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
}

export interface BudgetGroup {
  groupId: string;
  name: string;
  lines: BudgetLine[];
}

export interface BudgetMonth {
  month: string;
  total: BudgetLine;
  groups: BudgetGroup[];
  /** Spending with no category (needs categorizing). */
  uncategorizedCents: number;
  incomeCents: number;
  /** Sum of all category budgets this month. */
  budgetedCents: number;
}

export interface SetBudgetInput {
  categoryId: string | null;
  amountCents: number;
  rollover?: boolean;
  /** YYYY-MM the amount applies from (defaults to the current month). */
  fromMonth?: string;
}

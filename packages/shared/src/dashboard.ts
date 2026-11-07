/**
 * The customizable Overview: an ordered list of cards. You choose which cards
 * and their priority; Muny lays them out in the columns the screen has room
 * for. Cards are either built in or custom. A custom card is a definition
 * (data), never code: a whitelisted data source plus a way to show it. People,
 * the API and AI assistants all create the same definitions.
 */

export const MAX_LAYOUT_CARDS = 100;
export const MAX_CUSTOM_CARDS = 100;
/** Prefix of a custom card's reference in a layout. */
export const CUSTOM_PREFIX = "custom:";

/** Where a card lives on a screen with several columns. */
export type CardPlacement = "main" | "side";

export interface BuiltinCard {
  id: string;
  title: string;
  description: string;
  /** "main": flexible columns (charts). "side": the fixed right column (lists). */
  placement: CardPlacement;
  /** Roughly how tall it is, for balancing columns. */
  weight: number;
}

export const BUILTIN_CARDS: BuiltinCard[] = [
  {
    id: "spending",
    title: "Spent this month",
    description: "Running spending against last month, with what you've earned.",
    placement: "main",
    weight: 30,
  },
  {
    id: "calendar",
    title: "Recurring calendar",
    description: "Bills, subscriptions and income on a month calendar.",
    placement: "main",
    weight: 36,
  },
  {
    id: "cash-flow",
    title: "Cash flow",
    description: "Income and spending by month.",
    placement: "main",
    weight: 24,
  },
  {
    id: "categories",
    title: "Where your money went",
    description: "This month's spending by category.",
    placement: "main",
    weight: 28,
  },
  {
    id: "merchants",
    title: "Top merchants",
    description: "Where you spent the most this month.",
    placement: "main",
    weight: 28,
  },
  {
    id: "cash-trend",
    title: "Cash trend",
    description: "Your cash over time.",
    placement: "main",
    weight: 22,
  },
  {
    id: "accounts",
    title: "Accounts",
    description: "Balances by account type.",
    placement: "side",
    weight: 26,
  },
  {
    id: "cards",
    title: "Credit cards",
    description: "Balances and what's due.",
    placement: "side",
    weight: 14,
  },
  {
    id: "loans",
    title: "Loans",
    description: "What you owe and what's due.",
    placement: "side",
    weight: 14,
  },
  {
    id: "stocks",
    title: "Stocks",
    description: "Your holdings at a glance.",
    placement: "side",
    weight: 14,
  },
  {
    id: "crypto",
    title: "Crypto",
    description: "Your coins at a glance.",
    placement: "side",
    weight: 14,
  },
  {
    id: "budget",
    title: "Budget",
    description: "How this month's budget is going.",
    placement: "side",
    weight: 12,
  },
  {
    id: "recent",
    title: "Recent transactions",
    description: "What just happened.",
    placement: "side",
    weight: 30,
  },
  {
    id: "coming-up",
    title: "Coming up",
    description: "Bills and subscriptions due in the next 7 days.",
    placement: "side",
    weight: 20,
  },
];

/** A new user's Overview, highest priority first. */
export const DEFAULT_DASHBOARD: string[] = [
  "spending",
  "accounts",
  "cards",
  "loans",
  "stocks",
  "crypto",
  "budget",
  "recent",
  "calendar",
  "cash-flow",
  "categories",
  "merchants",
  "cash-trend",
];

export interface ArrangeCard {
  card: string;
  placement: CardPlacement;
  weight: number;
}

export interface ArrangedColumns {
  /** Cards top to bottom, per column, left to right. */
  columns: string[][];
  /** The last column holds the "side" cards. */
  hasSide: boolean;
}

/**
 * Lay cards out in the columns available. One column is simply the priority
 * order. With more, side cards fill the right column in order, but only up to
 * their fair share of the page's height, so it can't run on alone past the
 * others on a wide screen. Main cards then go to the shortest remaining column,
 * followed by any side cards that didn't fit, so priority still reads top to
 * bottom. Uses each card's typical height rather than measuring, so cards never
 * jump between columns as their numbers load.
 */
export function arrangeColumns(cards: ArrangeCard[], columnCount: number): ArrangedColumns {
  const count = Math.max(1, Math.floor(columnCount));
  if (count === 1) return { columns: [cards.map((c) => c.card)], hasSide: false };
  const side = cards.filter((c) => c.placement === "side");
  const main = cards.filter((c) => c.placement === "main");
  // With only one kind of card, every column is available to it.
  const hasSide = side.length > 0 && main.length > 0;
  const fairShare = cards.reduce((sum, c) => sum + c.weight, 0) / count;
  const inSide: string[] = [];
  const overflow: ArrangeCard[] = [];
  let sideHeight = 0;
  for (const c of hasSide ? side : []) {
    if (sideHeight < fairShare) {
      inSide.push(c.card);
      sideHeight += c.weight;
    } else overflow.push(c);
  }
  const flexible = hasSide ? [...main, ...overflow] : cards;
  const columns: string[][] = Array.from({ length: hasSide ? count - 1 : count }, () => []);
  const heights = columns.map(() => 0);
  for (const c of flexible) {
    const shortest = heights.indexOf(Math.min(...heights));
    columns[shortest]?.push(c.card);
    heights[shortest] = (heights[shortest] ?? 0) + c.weight;
  }
  if (hasSide) columns.push(inSide);
  return { columns, hasSide };
}

/** Move a card to a new position in the priority order. */
export function moveCard(cards: string[], card: string, toIndex: number): string[] {
  const from = cards.indexOf(card);
  if (from < 0) return cards;
  const rest = cards.filter((c) => c !== card);
  const to = Math.max(0, Math.min(rest.length, Math.round(toIndex)));
  return [...rest.slice(0, to), card, ...rest.slice(to)];
}

/**
 * Read a saved layout. An earlier version stored grid positions: those become
 * a priority order, reading the grid top to bottom and left to right.
 */
export function layoutFromSaved(saved: unknown): string[] | null {
  if (!Array.isArray(saved)) return null;
  if (saved.every((c) => typeof c === "string")) return saved as string[];
  return (saved as { card: string; x: number; y: number }[])
    .filter((i) => typeof i?.card === "string")
    .sort((a, b) => (a.y ?? 0) - (b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0))
    .map((i) => i.card);
}

/** Where a custom card goes: numbers and lists at the side, charts in the main columns. */
export function customCardArrangement(view: CardView): {
  placement: CardPlacement;
  weight: number;
} {
  if (view === "stat") return { placement: "side", weight: 9 };
  if (view === "list") return { placement: "side", weight: 22 };
  return { placement: "main", weight: 24 };
}

// ---------------------------------------------------------------------------
// Custom cards: definitions, never code.
// ---------------------------------------------------------------------------

export const CARD_VIEWS = ["stat", "list", "bars", "columns", "line"] as const;
export type CardView = (typeof CARD_VIEWS)[number];

export const CARD_PERIODS = [
  "this_month",
  "last_month",
  "last_30_days",
  "last_90_days",
  "this_year",
  "last_12_months",
] as const;
export type CardPeriod = (typeof CARD_PERIODS)[number];

export const CARD_PERIOD_LABELS: Record<CardPeriod, string> = {
  this_month: "This month",
  last_month: "Last month",
  last_30_days: "Last 30 days",
  last_90_days: "Last 90 days",
  this_year: "This year",
  last_12_months: "Last 12 months",
};

export const CARD_SOURCES = [
  "spending_by_category",
  "spending_by_merchant",
  "spending_total",
  "income_total",
  "spending_by_month",
  "income_by_month",
  "cash_flow_by_month",
  "net_worth_by_month",
  "account_balances",
  "budget_status",
  "upcoming_charges",
  "transactions",
] as const;
export type CardSource = (typeof CARD_SOURCES)[number];

export type CardParam =
  | "period"
  | "months"
  | "days"
  | "limit"
  | "categoryId"
  | "accountId"
  | "search";

export interface CardSourceInfo {
  label: string;
  description: string;
  views: CardView[];
  params: CardParam[];
}

/** What each source returns, how it can be shown, and what it accepts. */
export const CARD_SOURCE_INFO: Record<CardSource, CardSourceInfo> = {
  spending_by_category: {
    label: "Spending by category",
    description: "Each category's spending in a period, largest first.",
    views: ["bars", "list", "stat"],
    params: ["period", "limit"],
  },
  spending_by_merchant: {
    label: "Spending by merchant",
    description: "Each merchant's spending in a period, optionally in one category.",
    views: ["bars", "list", "stat"],
    params: ["period", "limit", "categoryId"],
  },
  spending_total: {
    label: "Total spending",
    description: "One number: spending in a period, optionally in one category.",
    views: ["stat"],
    params: ["period", "categoryId"],
  },
  income_total: {
    label: "Total income",
    description: "One number: income in a period.",
    views: ["stat"],
    params: ["period"],
  },
  spending_by_month: {
    label: "Spending by month",
    description: "Spending each month, optionally in one category.",
    views: ["columns", "line", "list", "stat"],
    params: ["months", "categoryId"],
  },
  income_by_month: {
    label: "Income by month",
    description: "Income each month.",
    views: ["columns", "line", "list", "stat"],
    params: ["months"],
  },
  cash_flow_by_month: {
    label: "Cash flow by month",
    description: "Income and spending side by side each month. The total is what's left.",
    views: ["columns", "stat"],
    params: ["months"],
  },
  net_worth_by_month: {
    label: "Net worth by month",
    description: "Assets minus debts at each month's end.",
    views: ["line", "columns", "stat"],
    params: ["months"],
  },
  account_balances: {
    label: "Account balances",
    description: "Each account's balance; debts count against the total.",
    views: ["list", "stat"],
    params: ["limit"],
  },
  budget_status: {
    label: "Budget status",
    description: "This month's category budgets: spent of budget. The total is what's left.",
    views: ["list", "stat"],
    params: ["limit"],
  },
  upcoming_charges: {
    label: "Upcoming charges",
    description: "Expected bills, subscriptions and income in the coming days.",
    views: ["list", "stat"],
    params: ["days", "limit"],
  },
  transactions: {
    label: "Transactions",
    description: "Latest transactions, optionally by text, category or account.",
    views: ["list", "stat"],
    params: ["limit", "search", "categoryId", "accountId"],
  },
};

export interface CardSpec {
  source: CardSource;
  view: CardView;
  period?: CardPeriod;
  /** Months of history, 2-36. */
  months?: number;
  /** Days ahead, 1-90. */
  days?: number;
  /** Rows, 1-50. */
  limit?: number;
  categoryId?: string;
  accountId?: string;
  search?: string;
}

export interface CustomCard {
  id: string;
  title: string;
  description?: string;
  spec: CardSpec;
}

/** Create or replace a custom card. */
export type CustomCardInput = Omit<CustomCard, "id">;

export interface CardRow {
  key: string;
  label: string;
  detail?: string;
  /** Integer cents, one per series. */
  values: number[];
}

/** What every source returns, whichever view shows it. */
export interface CardData {
  /** The headline number, in integer cents. */
  totalCents: number;
  totalLabel: string;
  seriesNames: string[];
  rows: CardRow[];
}

export interface Dashboard {
  /** Cards on this person's Overview, highest priority first. */
  cards: string[];
  /** Still the default: you haven't customized it. */
  isDefault: boolean;
  /** Every custom card in the household, on this layout or not. */
  customCards: CustomCard[];
}

/** The self-description assistants and tools read before making a card. */
export interface DashboardSchema {
  builtinCards: BuiltinCard[];
  views: readonly CardView[];
  periods: readonly CardPeriod[];
  sources: Record<CardSource, CardSourceInfo>;
  /** JSON Schema of a custom card. */
  cardJsonSchema: unknown;
}

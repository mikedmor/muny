/**
 * The customizable Overview: a 12-column grid, as tall as it needs to be.
 * Cards are either built in or custom. A custom card is a definition (data),
 * never code: a whitelisted data source plus a way to show it. People, the API
 * and AI assistants all create the same definitions.
 */

export const GRID_COLUMNS = 12;
/** Height of one grid row. Card heights are in rows, so 25 rows is 400px. */
export const GRID_ROW_PX = 16;
export const CARD_MIN_W = 2;
export const CARD_MIN_H = 4;
export const CARD_MAX_H = 200;
export const MAX_LAYOUT_ITEMS = 100;
export const MAX_CUSTOM_CARDS = 100;
/** Prefix of a custom card's reference in a layout. */
export const CUSTOM_PREFIX = "custom:";

export interface DashboardItem {
  /** A built-in card id, or "custom:<id>". A layout holds each card once. */
  card: string;
  /** Column, 0-11. */
  x: number;
  /** Row, from 0, no upper limit. */
  y: number;
  /** Width in columns, 2-12. */
  w: number;
  /** Height in rows. */
  h: number;
  /** Height follows the card's content, until you resize it. */
  auto?: boolean;
}

export type GridRect = Pick<DashboardItem, "x" | "y" | "w" | "h">;

export interface BuiltinCard {
  id: string;
  title: string;
  description: string;
  /** Size when added. */
  w: number;
  h: number;
}

export const BUILTIN_CARDS: BuiltinCard[] = [
  {
    id: "spending",
    title: "Spent this month",
    description: "Running spending against last month, with what you've earned.",
    w: 8,
    h: 30,
  },
  {
    id: "cash-flow",
    title: "Cash flow",
    description: "Income and spending by month.",
    w: 8,
    h: 24,
  },
  {
    id: "categories",
    title: "Where your money went",
    description: "This month's spending by category.",
    w: 4,
    h: 28,
  },
  {
    id: "merchants",
    title: "Top merchants",
    description: "Where you spent the most this month.",
    w: 4,
    h: 28,
  },
  { id: "cash-trend", title: "Cash trend", description: "Your cash over time.", w: 8, h: 22 },
  {
    id: "calendar",
    title: "Recurring calendar",
    description: "Bills, subscriptions and income on a month calendar.",
    w: 8,
    h: 36,
  },
  {
    id: "recent",
    title: "Recent transactions",
    description: "What just happened.",
    w: 4,
    h: 30,
  },
  { id: "accounts", title: "Accounts", description: "Balances by account type.", w: 4, h: 26 },
  { id: "cards", title: "Credit cards", description: "Balances and what's due.", w: 4, h: 14 },
  { id: "loans", title: "Loans", description: "What you owe and what's due.", w: 4, h: 14 },
  { id: "stocks", title: "Stocks", description: "Your holdings at a glance.", w: 4, h: 14 },
  { id: "crypto", title: "Crypto", description: "Your coins at a glance.", w: 4, h: 14 },
  { id: "budget", title: "Budget", description: "How this month's budget is going.", w: 4, h: 12 },
  {
    id: "coming-up",
    title: "Coming up",
    description: "Bills and subscriptions due in the next 7 days.",
    w: 4,
    h: 20,
  },
];

/** A new user's Overview. Heights follow the content until a card is resized. */
export const DEFAULT_DASHBOARD: DashboardItem[] = [
  { card: "spending", x: 0, y: 0, w: 8, h: 30, auto: true },
  { card: "cash-flow", x: 0, y: 30, w: 8, h: 24, auto: true },
  { card: "categories", x: 0, y: 54, w: 4, h: 28, auto: true },
  { card: "merchants", x: 4, y: 54, w: 4, h: 28, auto: true },
  { card: "cash-trend", x: 0, y: 82, w: 8, h: 22, auto: true },
  { card: "calendar", x: 0, y: 104, w: 8, h: 36, auto: true },
  { card: "accounts", x: 8, y: 0, w: 4, h: 26, auto: true },
  { card: "cards", x: 8, y: 26, w: 4, h: 14, auto: true },
  { card: "loans", x: 8, y: 40, w: 4, h: 14, auto: true },
  { card: "stocks", x: 8, y: 54, w: 4, h: 14, auto: true },
  { card: "crypto", x: 8, y: 68, w: 4, h: 14, auto: true },
  { card: "budget", x: 8, y: 82, w: 4, h: 12, auto: true },
  { card: "recent", x: 8, y: 94, w: 4, h: 30, auto: true },
];

// ---------------------------------------------------------------------------
// Grid rules: the same for the web app, the server and assistants.
// ---------------------------------------------------------------------------

const overlaps = (a: GridRect, b: GridRect) =>
  a.h > 0 && b.h > 0 && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Keep a card on the grid. A height of 0 means "nothing to show" and stays 0. */
export function clampRect<T extends GridRect>(r: T): T {
  const w = Math.min(GRID_COLUMNS, Math.max(CARD_MIN_W, Math.round(r.w)));
  return {
    ...r,
    w,
    x: Math.min(GRID_COLUMNS - w, Math.max(0, Math.round(r.x))),
    y: Math.max(0, Math.round(r.y)),
    h: r.h === 0 ? 0 : Math.min(CARD_MAX_H, Math.max(CARD_MIN_H, Math.round(r.h))),
  };
}

/** The highest row a card fits at, in its columns, among those already placed. */
function highestFit<T extends GridRect>(r: T, placed: T[], from = 0): T {
  const at = { ...r, y: from };
  for (
    let hit = placed.find((p) => overlaps(p, at));
    hit;
    hit = placed.find((p) => overlaps(p, at))
  )
    at.y = hit.y + hit.h;
  return at;
}

const byPosition = (a: GridRect, b: GridRect) => a.y - b.y || a.x - b.x;

/** No overlaps and no gaps above a card: everything floats up as far as it can. */
export function normalizeLayout<T extends GridRect>(items: T[]): T[] {
  const placed: T[] = [];
  for (const item of items.map(clampRect).sort(byPosition)) placed.push(highestFit(item, placed));
  return placed;
}

/**
 * Move or resize a card. It takes the spot asked for, and the others make room
 * around it.
 */
export function placeCard(items: DashboardItem[], card: string, rect: GridRect): DashboardItem[] {
  const current = items.find((i) => i.card === card);
  if (!current) return items;
  const moved = clampRect({ ...current, ...rect });
  const placed: DashboardItem[] = [moved];
  for (const item of items.filter((i) => i.card !== card).sort(byPosition))
    placed.push(highestFit(item, placed));
  return normalizeLayout(placed);
}

/** Add a card under everything else (a card already there stays put). */
export function addCard(
  items: DashboardItem[],
  card: string,
  size: { w: number; h: number; auto?: boolean; x?: number; y?: number },
): DashboardItem[] {
  if (items.some((i) => i.card === card)) return items;
  const bottom = Math.max(0, ...items.map((i) => i.y + i.h));
  return normalizeLayout([
    ...items,
    { card, x: size.x ?? 0, y: size.y ?? bottom, w: size.w, h: size.h, auto: size.auto },
  ]);
}

export const removeCard = (items: DashboardItem[], card: string) =>
  normalizeLayout(items.filter((i) => i.card !== card));

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
  items: DashboardItem[];
  /** Still the default: you haven't customized it. */
  isDefault: boolean;
  /** Every custom card in the household, on this layout or not. */
  customCards: CustomCard[];
}

/** The self-description assistants and tools read before making a card. */
export interface DashboardSchema {
  grid: { columns: number; rowPx: number; minW: number; minH: number; maxH: number };
  builtinCards: BuiltinCard[];
  views: readonly CardView[];
  periods: readonly CardPeriod[];
  sources: Record<CardSource, CardSourceInfo>;
  /** JSON Schema of a custom card. */
  cardJsonSchema: unknown;
}

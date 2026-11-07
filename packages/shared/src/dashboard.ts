/**
 * The customizable Overview: an ordered list of cards. You choose which cards
 * and their priority; Muny lays them out in the columns the screen has room
 * for. Cards are either built in or custom. A custom card is a document (data),
 * never code; see cardkit/. People, the API and AI assistants all write the same
 * documents.
 */

import type { DatasetInfo } from "./cardkit/catalog.js";
import type { BlockKind, BlockKindInfo, CardDoc } from "./cardkit/doc.js";
import type { FunctionInfo } from "./cardkit/expr.js";

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
  /** Roughly how tall it is, in 16px rows, until its real height is known. */
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

/** Share cards between columns as evenly as possible: tallest first, into the shortest. */
function packColumns(cards: ArrangeCard[], count: number) {
  const columns: ArrangeCard[][] = Array.from({ length: count }, () => []);
  const heights = columns.map(() => 0);
  for (const c of [...cards].sort((x, y) => y.weight - x.weight)) {
    const shortest = heights.indexOf(Math.min(...heights));
    columns[shortest]?.push(c);
    heights[shortest] = (heights[shortest] ?? 0) + c.weight;
  }
  return { columns, tallest: Math.max(0, ...heights) };
}

/**
 * Lay cards out in the columns available, with as little empty space as
 * possible. One column is simply the priority order. With more, side cards stay
 * in the right column as far as that keeps the page short, highest priority
 * first; the rest share the other columns with the main cards. Priority reads
 * top to bottom in every column, and the column holding your highest-priority
 * card comes first. Weights can be any unit: the web app passes measured heights.
 */
export function arrangeColumns(cards: ArrangeCard[], columnCount: number): ArrangedColumns {
  const count = Math.max(1, Math.floor(columnCount));
  if (count === 1) return { columns: [cards.map((c) => c.card)], hasSide: false };
  const priority = new Map(cards.map((c, i) => [c.card, i]));
  const rank = (c: ArrangeCard) => priority.get(c.card) ?? 0;
  const inOrder = (column: ArrangeCard[]) => [...column].sort((x, y) => rank(x) - rank(y));
  const flexibleColumns = (packed: ArrangeCard[][]) =>
    packed
      .map(inOrder)
      .sort((x, y) => (x[0] ? rank(x[0]) : Infinity) - (y[0] ? rank(y[0]) : Infinity))
      .map((column) => column.map((c) => c.card));

  const side = cards.filter((c) => c.placement === "side");
  const main = cards.filter((c) => c.placement === "main");
  // With only one kind of card, every column is available to it.
  if (side.length === 0 || main.length === 0)
    return { columns: flexibleColumns(packColumns(cards, count).columns), hasSide: false };

  // How many lists to keep on the right: whichever makes the page shortest,
  // and on a tie, the most (that's where lists read best).
  let best: { keep: number; tallest: number; packed: ArrangeCard[][] } | null = null;
  for (let keep = side.length; keep >= 1; keep--) {
    const sideHeight = side.slice(0, keep).reduce((sum, c) => sum + c.weight, 0);
    const { columns, tallest } = packColumns([...main, ...side.slice(keep)], count - 1);
    const pageHeight = Math.max(sideHeight, tallest);
    if (!best || pageHeight < best.tallest) best = { keep, tallest: pageHeight, packed: columns };
  }
  const keep = best?.keep ?? side.length;
  return {
    columns: [...flexibleColumns(best?.packed ?? []), side.slice(0, keep).map((c) => c.card)],
    hasSide: true,
  };
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

/** Where a custom card goes: charts in the wide columns, numbers and lists on the right. */
export function customCardArrangement(doc: CardDoc): { placement: CardPlacement; weight: number } {
  const hasChart = doc.blocks.some((b) => CHART_KINDS.has(b.kind));
  const placement =
    doc.placement && doc.placement !== "auto" ? doc.placement : hasChart ? "main" : "side";
  // In 16px rows, for until its real height has been measured.
  let weight = 3;
  for (const b of doc.blocks) {
    const rows = BLOCK_WEIGHTS[b.kind] ?? 4;
    weight += b.w >= 12 ? rows : rows / 2;
  }
  return { placement, weight: Math.round(weight) };
}

const CHART_KINDS = new Set<BlockKind>([
  "bars",
  "column",
  "line",
  "area",
  "pie",
  "treemap",
  "heatmap",
  "scatter",
  "waterfall",
  "calendar",
]);

const BLOCK_WEIGHTS: Partial<Record<BlockKind, number>> = {
  stat: 6,
  text: 2,
  heading: 3,
  divider: 2,
  list: 14,
  table: 14,
  bars: 14,
  column: 16,
  line: 16,
  area: 16,
  pie: 14,
  progress: 5,
  treemap: 16,
  heatmap: 16,
  scatter: 16,
  waterfall: 16,
  calendar: 30,
};

// ---------------------------------------------------------------------------
// Custom cards: documents, never code. See cardkit/.
// ---------------------------------------------------------------------------

export interface CustomCard {
  id: string;
  title: string;
  description?: string;
  doc: CardDoc;
  /** The built-in card it started as, if any. */
  basedOn?: string;
}

/** Create or replace a custom card. */
export type CustomCardInput = Omit<CustomCard, "id">;

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
  datasets: DatasetInfo[];
  functions: FunctionInfo[];
  blockKinds: BlockKindInfo[];
  datePresets: readonly string[];
  dateBuckets: readonly string[];
  filterOps: readonly string[];
  aggregates: readonly string[];
  colors: readonly string[];
  /** How formulas work, in words. */
  formulaGuide: string;
  /** JSON Schema of a card. */
  cardJsonSchema: unknown;
  /** Worked examples. */
  examples: CustomCardInput[];
}

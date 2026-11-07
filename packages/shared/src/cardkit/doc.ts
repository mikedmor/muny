/**
 * What a card is: a document, never code. People (in the editor), the API and AI
 * assistants all write the same documents. Colors are named roles the theme fills
 * in, so a card can't clash with the theme or carry styling of its own.
 */
import type { FieldType } from "./catalog.js";

/** How many columns a card's blocks are laid out on. */
export const CARD_GRID_COLUMNS = 12;
export const MAX_BLOCKS = 40;
export const MAX_METRICS = 40;
export const MAX_LAYERS = 4;
export const MAX_MEASURES = 16;
export const MAX_DIMENSIONS = 8;
export const MAX_FILTERS = 20;
export const MAX_CALCULATED = 20;
export const MAX_OUTPUT_ROWS = 2000;

export const DATE_PRESETS = [
  "this_month",
  "last_month",
  "last_3_months",
  "last_6_months",
  "last_12_months",
  "this_year",
  "last_year",
  "last_7_days",
  "last_30_days",
  "last_90_days",
  "next_7_days",
  "next_30_days",
  "next_90_days",
  "this_and_last_month",
  "all_time",
] as const;
export type DatePreset = (typeof DATE_PRESETS)[number];

export const DATE_PRESET_LABELS: Record<DatePreset, string> = {
  this_month: "This month",
  last_month: "Last month",
  this_and_last_month: "This and last month",
  last_3_months: "Last 3 months",
  last_6_months: "Last 6 months",
  last_12_months: "Last 12 months",
  this_year: "This year",
  last_year: "Last year",
  last_7_days: "Last 7 days",
  last_30_days: "Last 30 days",
  last_90_days: "Last 90 days",
  next_7_days: "Next 7 days",
  next_30_days: "Next 30 days",
  next_90_days: "Next 90 days",
  all_time: "All time",
};

export type DateRange =
  | { preset: DatePreset }
  /** The last or next so many days or months. */
  | { last?: number; next?: number; unit: "days" | "months" }
  | { from: string; to: string };

export const FILTER_OPS = [
  "eq",
  "ne",
  "in",
  "not_in",
  "contains",
  "not_contains",
  "gt",
  "gte",
  "lt",
  "lte",
  "is_empty",
  "not_empty",
  "is_true",
  "is_false",
] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

export const FILTER_OP_LABELS: Record<FilterOp, string> = {
  eq: "is",
  ne: "isn't",
  in: "is one of",
  not_in: "isn't one of",
  contains: "contains",
  not_contains: "doesn't contain",
  gt: "is more than",
  gte: "is at least",
  lt: "is less than",
  lte: "is at most",
  is_empty: "is empty",
  not_empty: "has a value",
  is_true: "is yes",
  is_false: "is no",
};

export interface CardFilter {
  field: string;
  op: FilterOp;
  /** Money is in dollars here, like "25.50". */
  value?: string | number | boolean | string[];
}

export const DATE_BUCKETS = [
  "day",
  "week",
  "month",
  "quarter",
  "year",
  "day_of_month",
  "weekday",
  "month_of_year",
] as const;
export type DateBucket = (typeof DATE_BUCKETS)[number];

export const DATE_BUCKET_LABELS: Record<DateBucket, string> = {
  day: "By day",
  week: "By week",
  month: "By month",
  quarter: "By quarter",
  year: "By year",
  day_of_month: "By day of the month",
  weekday: "By day of the week",
  month_of_year: "By month of the year",
};

export interface CardDimension {
  field: string;
  /** How to group a date. */
  bucket?: DateBucket;
  label?: string;
}

export const AGGREGATES = [
  "sum",
  "avg",
  "min",
  "max",
  "median",
  "count",
  "count_distinct",
  "first",
  "last",
] as const;
export type Aggregate = (typeof AGGREGATES)[number];

export const AGGREGATE_LABELS: Record<Aggregate, string> = {
  sum: "Total",
  avg: "Average",
  min: "Smallest",
  max: "Largest",
  median: "Middle",
  count: "Count",
  count_distinct: "Count different",
  first: "First",
  last: "Last",
};

/** Named theme roles. */
export const CARD_COLORS = [
  "auto",
  "series1",
  "series2",
  "series3",
  "series4",
  "series5",
  "series6",
  "series7",
  "series8",
  "positive",
  "negative",
  "warning",
  "muted",
] as const;
export type CardColor = (typeof CARD_COLORS)[number];

export const CARD_MARKS = ["auto", "line", "dashed", "area", "column"] as const;
export type CardMark = (typeof CARD_MARKS)[number];

export interface CardMeasure {
  /** Other formulas refer to it by this. */
  id: string;
  label?: string;
  /** A field and how to total it… */
  field?: string;
  agg?: Aggregate;
  /** …or a formula. */
  expr?: string;
  format?: FieldType;
  color?: CardColor;
  /** How it's drawn on a chart, when it differs from the block. */
  mark?: CardMark;
  /** Calculated but not shown; other measures can still use it. */
  hidden?: boolean;
}

export interface CardCalculated {
  id: string;
  label?: string;
  /** Worked out for each row, before anything is grouped. */
  expr: string;
  format?: FieldType;
}

export interface CardSort {
  /** A dimension's field or a measure's id. */
  by: string;
  dir: "asc" | "desc";
}

export interface CardQuery {
  dataset: string;
  range?: DateRange;
  filters?: CardFilter[];
  calculated?: CardCalculated[];
  /** Group by these. The first is the axis on charts; the second splits it into series. */
  dimensions?: CardDimension[];
  measures?: CardMeasure[];
  sort?: CardSort[];
  limit?: number;
  /** With a limit, fold the rest into one "Other" row. */
  other?: boolean;
  /** Show every date in the range, even with nothing on it. */
  fill?: boolean;
  /** Each row stays its own row (for lists of transactions and the like). */
  raw?: boolean;
}

/** A named number or text worked out once for the card. Formulas use it as $id. */
export interface CardMetric {
  id: string;
  label?: string;
  format?: FieldType;
  /** With a dataset, read over its rows: sum([Spending]). Without, over other metrics: $a - $b. */
  expr: string;
  dataset?: string;
  range?: DateRange;
  filters?: CardFilter[];
}

export const BLOCK_KINDS = [
  "stat",
  "text",
  "heading",
  "divider",
  "list",
  "table",
  "bars",
  "column",
  "line",
  "area",
  "pie",
  "progress",
  "treemap",
  "heatmap",
  "scatter",
  "waterfall",
  "calendar",
] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

export type CardTone = "normal" | "muted" | "positive" | "negative" | "warning";
export type CardSize = "sm" | "md" | "lg" | "xl";

export interface BlockOptions {
  /** text, heading, or a line under a stat. {{formula}} fills in a value. */
  text?: string;
  /** A formula giving a tone, like if($left < 0, "negative", "positive"). */
  toneExpr?: string;
  tone?: CardTone;
  size?: CardSize;
  /** A link on the block's header or heading. Inside Muny only. */
  link?: { to: string; label: string; hash?: string };
  /** stat: the value's formula; otherwise the query's first measure. */
  value?: string;
  format?: FieldType;
  label?: string;
  /** stat: a formula to compare with, shown as an arrow and the difference. */
  compare?: string;
  compareLabel?: string;
  goodWhen?: "up" | "down" | "either";
  /** stat: draw the query's rows as a small line. */
  spark?: boolean;

  /** Charts. */
  stacked?: boolean;
  height?: number;
  legend?: boolean;
  /** Flat lines across a chart, from formulas. */
  references?: { label: string; expr: string; color?: CardColor }[];

  /** bars and pie: show each row's share. */
  percent?: boolean;
  donut?: boolean;
  /** pie: a formula or text for the middle. */
  center?: string;

  /** list and table: which columns do what, by dimension field or measure id. */
  title?: string;
  subtitle?: string;
  amount?: string;
  subamount?: string;
  icon?: "none" | "merchant" | "category" | "coin" | "rank";
  /** list: draw a bar under each row. */
  bar?: boolean;
  /** list: rows gather under this column, and open on click. */
  groupBy?: string;
  /** list: color amounts by their sign. */
  signColors?: boolean;
  /** list and table: flip amounts' signs for showing (debts as what you owe). */
  flip?: boolean;
  /** table: add a total row. */
  totals?: boolean;

  /** progress: columns (with several rows) or formulas (one bar). */
  target?: string;
  marker?: string;
  markerLabel?: string;
  /** progress: going past the target is bad. */
  overIsBad?: boolean;
}

export interface CardBlock {
  id: string;
  kind: BlockKind;
  /** Columns wide, 1-12. */
  w: number;
  title?: string;
  query?: CardQuery;
  /** Charts: more data on the same axis, from any dataset. */
  layers?: CardQuery[];
  options?: BlockOptions;
}

export interface CardDoc {
  v: 2;
  /** Where it prefers to go on a wide screen; "auto" decides by what's inside. */
  placement?: "auto" | "main" | "side";
  metrics?: CardMetric[];
  blocks: CardBlock[];
}

export const emptyDoc = (): CardDoc => ({ v: 2, blocks: [] });

/** What each kind of block needs from a query, for the editor and for assistants. */
export interface BlockKindInfo {
  kind: BlockKind;
  label: string;
  group: "Numbers" | "Charts" | "Lists" | "Layout";
  description: string;
  /** Uses a query at all. */
  query: boolean;
  /** Dimension slots, in order. */
  dimensions: { label: string; hint: string }[];
  /** How many of those slots have to be filled. */
  minDimensions: number;
  /** Can't work without a query (a big number can run on a formula instead). */
  requiresQuery: boolean;
  /** How many measures: at least, at most. */
  measures: [number, number];
  /** Wide enough to read by default, in 12ths. */
  width: number;
}

export const BLOCK_KIND_INFO: Record<BlockKind, BlockKindInfo> = {
  stat: {
    kind: "stat",
    minDimensions: 0,
    requiresQuery: false,
    label: "Big number",
    group: "Numbers",
    description: "One number, with an optional comparison and small line.",
    query: true,
    dimensions: [{ label: "Small line by", hint: "Optional: draws a small line over this." }],
    measures: [0, 1],
    width: 6,
  },
  progress: {
    kind: "progress",
    minDimensions: 0,
    requiresQuery: false,
    label: "Progress bars",
    group: "Numbers",
    description: "How far a value has come towards a target.",
    query: true,
    dimensions: [{ label: "One bar for each", hint: "Optional: leave empty for a single bar." }],
    measures: [0, 3],
    width: 12,
  },
  text: {
    kind: "text",
    minDimensions: 0,
    requiresQuery: false,
    label: "Text",
    group: "Layout",
    description: "A sentence that can include live values, like {{$spent}}.",
    query: false,
    dimensions: [],
    measures: [0, 0],
    width: 12,
  },
  heading: {
    kind: "heading",
    minDimensions: 0,
    requiresQuery: false,
    label: "Heading",
    group: "Layout",
    description: "A title, with an optional link.",
    query: false,
    dimensions: [],
    measures: [0, 0],
    width: 12,
  },
  divider: {
    kind: "divider",
    minDimensions: 0,
    requiresQuery: false,
    label: "Divider",
    group: "Layout",
    description: "A line between sections.",
    query: false,
    dimensions: [],
    measures: [0, 0],
    width: 12,
  },
  list: {
    kind: "list",
    minDimensions: 1,
    requiresQuery: true,
    label: "List",
    group: "Lists",
    description: "Rows with an icon, a title, a detail and an amount.",
    query: true,
    dimensions: [
      { label: "Title", hint: "What each row is." },
      { label: "Detail", hint: "Optional: the small line under it." },
      { label: "Group under", hint: "Optional: rows gather under this and open on click." },
    ],
    measures: [0, 2],
    width: 12,
  },
  table: {
    kind: "table",
    minDimensions: 0,
    requiresQuery: true,
    label: "Table",
    group: "Lists",
    description: "Any columns you like, with an optional total row.",
    query: true,
    dimensions: [
      { label: "Rows", hint: "A column for each thing you group by." },
      { label: "Rows", hint: "" },
      { label: "Rows", hint: "" },
      { label: "Rows", hint: "" },
    ],
    measures: [0, 16],
    width: 12,
  },
  bars: {
    kind: "bars",
    minDimensions: 1,
    requiresQuery: true,
    label: "Ranked bars",
    group: "Charts",
    description: "Compare things by size, largest first.",
    query: true,
    dimensions: [{ label: "One bar for each", hint: "What's being compared." }],
    measures: [1, 1],
    width: 12,
  },
  column: {
    kind: "column",
    minDimensions: 1,
    requiresQuery: true,
    label: "Columns",
    group: "Charts",
    description: "Compare values over time or between things. Can stack.",
    query: true,
    dimensions: [
      { label: "Across the bottom", hint: "Usually a date." },
      { label: "Split into colors by", hint: "Optional." },
    ],
    measures: [1, 8],
    width: 12,
  },
  line: {
    kind: "line",
    minDimensions: 1,
    requiresQuery: true,
    label: "Line",
    group: "Charts",
    description: "Change over time, one or many lines.",
    query: true,
    dimensions: [
      { label: "Across the bottom", hint: "Usually a date." },
      { label: "One line for each", hint: "Optional." },
    ],
    measures: [1, 8],
    width: 12,
  },
  area: {
    kind: "area",
    minDimensions: 1,
    requiresQuery: true,
    label: "Area",
    group: "Charts",
    description: "Change over time with the space filled in. Can stack.",
    query: true,
    dimensions: [
      { label: "Across the bottom", hint: "Usually a date." },
      { label: "One band for each", hint: "Optional." },
    ],
    measures: [1, 8],
    width: 12,
  },
  pie: {
    kind: "pie",
    minDimensions: 1,
    requiresQuery: true,
    label: "Donut",
    group: "Charts",
    description: "Parts of a whole.",
    query: true,
    dimensions: [{ label: "One slice for each", hint: "A handful of things reads best." }],
    measures: [1, 1],
    width: 12,
  },
  treemap: {
    kind: "treemap",
    minDimensions: 1,
    requiresQuery: true,
    label: "Treemap",
    group: "Charts",
    description: "Parts of a whole as boxes; handles many parts.",
    query: true,
    dimensions: [{ label: "One box for each", hint: "" }],
    measures: [1, 1],
    width: 12,
  },
  heatmap: {
    kind: "heatmap",
    minDimensions: 2,
    requiresQuery: true,
    label: "Heat map",
    group: "Charts",
    description: "Two groupings at once, darker where it's higher.",
    query: true,
    dimensions: [
      { label: "Across", hint: "Like day of the week." },
      { label: "Down", hint: "Like category or month." },
    ],
    measures: [1, 1],
    width: 12,
  },
  scatter: {
    kind: "scatter",
    minDimensions: 1,
    requiresQuery: true,
    label: "Scatter",
    group: "Charts",
    description: "Two measures against each other, one dot per row.",
    query: true,
    dimensions: [{ label: "One dot for each", hint: "" }],
    measures: [2, 2],
    width: 12,
  },
  waterfall: {
    kind: "waterfall",
    minDimensions: 1,
    requiresQuery: true,
    label: "Waterfall",
    group: "Charts",
    description: "How a total builds up, step by step.",
    query: true,
    dimensions: [{ label: "One step for each", hint: "" }],
    measures: [1, 1],
    width: 12,
  },
  calendar: {
    kind: "calendar",
    minDimensions: 1,
    requiresQuery: true,
    label: "Calendar",
    group: "Lists",
    description: "Dated things on a month you can page through.",
    query: true,
    dimensions: [
      { label: "Date", hint: "When it happens." },
      { label: "Name", hint: "What it is." },
    ],
    measures: [1, 1],
    width: 12,
  },
};

// ---------------------------------------------------------------------------
// What running a card returns. Plain numbers and text only.
// ---------------------------------------------------------------------------

export type CardCell = string | number | boolean | null;

export interface ResultColumn {
  id: string;
  label: string;
  type: FieldType;
  role: "dimension" | "measure";
  bucket?: DateBucket;
  color?: CardColor;
  mark?: CardMark;
  hidden?: boolean;
}

export interface QueryResult {
  columns: ResultColumn[];
  rows: CardCell[][];
  /** Money in integer cents, percents as fractions. */
  totals: Record<string, number | null>;
  /** There was more than fits. */
  truncated?: boolean;
}

export interface ResolvedValue {
  value: CardCell;
  type: FieldType;
  /** Ready to show. */
  text: string;
}

export interface BlockResult {
  /** The block's query, then its layers. */
  queries: QueryResult[];
  value?: ResolvedValue;
  compare?: ResolvedValue;
  /** value minus compare. */
  delta?: ResolvedValue;
  text?: string;
  tone?: CardTone;
  center?: string;
  references?: { label: string; color?: CardColor; value: number | null; type: FieldType }[];
  target?: ResolvedValue;
  marker?: ResolvedValue;
  error?: string;
}

export interface CardResult {
  metrics: Record<string, ResolvedValue | { error: string }>;
  blocks: Record<string, BlockResult>;
  /** The day it was worked out for. */
  today: string;
}

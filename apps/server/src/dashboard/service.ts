import { type MunyDb, newId, schema } from "@muny/db";
import {
  AGGREGATES,
  BLOCK_KIND_INFO,
  BLOCK_KINDS,
  BUILTIN_CARDS,
  builtinCardDoc,
  CARD_COLORS,
  CARD_GRID_COLUMNS,
  CARD_MARKS,
  type CardDoc,
  type CardResult,
  CUSTOM_PREFIX,
  type CustomCard,
  type CustomCardInput,
  checkCardDoc,
  DATASETS,
  DATE_BUCKETS,
  DATE_PRESETS,
  type Dashboard,
  type DashboardSchema,
  DEFAULT_DASHBOARD,
  FILTER_OPS,
  FUNCTIONS,
  isV1Spec,
  layoutFromSaved,
  MAX_BLOCKS,
  MAX_CALCULATED,
  MAX_CUSTOM_CARDS,
  MAX_DIMENSIONS,
  MAX_EXPR_LENGTH,
  MAX_FILTERS,
  MAX_LAYERS,
  MAX_LAYOUT_CARDS,
  MAX_MEASURES,
  MAX_METRICS,
  MAX_OUTPUT_ROWS,
  type ManualColumns,
  runCardDoc,
  upgradeV1Spec,
} from "@muny/shared";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { localToday } from "../lib/dates.js";
import { badRequest, conflict, notFound } from "../lib/http.js";
import { dataProvider } from "./datasets.js";

type Db = MunyDb;

// ---------------------------------------------------------------------------
// What a card may be. Strict, so nothing else gets stored.
// ---------------------------------------------------------------------------

const formula = z.string().trim().min(1).max(MAX_EXPR_LENGTH);
const shortText = z.string().trim().max(120);
const longText = z.string().trim().max(2000);
const name = z.string().trim().min(1).max(64);
/** What formulas call it, so it has to be writable in one. */
const identifier = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, "Use letters, numbers and underscores");
const fieldType = z.enum(["money", "number", "percent", "text", "date", "month", "boolean"]);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const DateRangeSchema = z.union([
  z.object({ preset: z.enum(DATE_PRESETS) }).strict(),
  z
    .object({
      last: z.number().int().min(1).max(3650).optional(),
      next: z.number().int().min(1).max(400).optional(),
      unit: z.enum(["days", "months"]),
    })
    .strict(),
  z.object({ from: isoDate, to: isoDate }).strict(),
]);

const FilterSchema = z
  .object({
    field: name,
    op: z.enum(FILTER_OPS),
    value: z
      .union([z.string().max(500), z.number(), z.boolean(), z.array(z.string().max(200)).max(100)])
      .optional(),
  })
  .strict();

const QuerySchema = z
  .object({
    dataset: name,
    range: DateRangeSchema.optional(),
    filters: z.array(FilterSchema).max(MAX_FILTERS).optional(),
    calculated: z
      .array(
        z
          .object({
            id: identifier,
            label: shortText.optional(),
            expr: formula,
            format: fieldType.optional(),
          })
          .strict(),
      )
      .max(MAX_CALCULATED)
      .optional(),
    dimensions: z
      .array(
        z
          .object({
            field: name,
            bucket: z.enum(DATE_BUCKETS).optional(),
            label: shortText.optional(),
          })
          .strict(),
      )
      .max(MAX_DIMENSIONS)
      .optional(),
    measures: z
      .array(
        z
          .object({
            id: identifier,
            label: shortText.optional(),
            field: name.optional(),
            agg: z.enum(AGGREGATES).optional(),
            expr: formula.optional(),
            format: fieldType.optional(),
            color: z.enum(CARD_COLORS).optional(),
            mark: z.enum(CARD_MARKS).optional(),
            hidden: z.boolean().optional(),
          })
          .strict(),
      )
      .max(MAX_MEASURES)
      .optional(),
    sort: z
      .array(z.object({ by: name, dir: z.enum(["asc", "desc"]) }).strict())
      .max(4)
      .optional(),
    limit: z.number().int().min(1).max(MAX_OUTPUT_ROWS).optional(),
    other: z.boolean().optional(),
    fill: z.boolean().optional(),
    raw: z.boolean().optional(),
  })
  .strict();

const OptionsSchema = z
  .object({
    text: longText.optional(),
    toneExpr: formula.optional(),
    tone: z.enum(["normal", "muted", "positive", "negative", "warning"]).optional(),
    size: z.enum(["sm", "md", "lg", "xl"]).optional(),
    link: z
      .object({
        to: z.string().max(100),
        label: shortText,
        hash: z
          .string()
          .regex(/^[A-Za-z0-9_-]{1,40}$/)
          .optional(),
      })
      .strict()
      .optional(),
    value: formula.optional(),
    format: fieldType.optional(),
    label: shortText.optional(),
    compare: formula.optional(),
    compareLabel: shortText.optional(),
    goodWhen: z.enum(["up", "down", "either"]).optional(),
    spark: z.boolean().optional(),
    stacked: z.boolean().optional(),
    height: z.number().int().min(60).max(800).optional(),
    legend: z.boolean().optional(),
    references: z
      .array(
        z
          .object({
            label: shortText,
            expr: formula,
            color: z.enum(CARD_COLORS).optional(),
          })
          .strict(),
      )
      .max(8)
      .optional(),
    percent: z.boolean().optional(),
    donut: z.boolean().optional(),
    center: shortText.optional(),
    title: name.optional(),
    subtitle: name.optional(),
    amount: name.optional(),
    subamount: name.optional(),
    icon: z.enum(["none", "merchant", "category", "coin", "rank"]).optional(),
    bar: z.boolean().optional(),
    groupBy: name.optional(),
    signColors: z.boolean().optional(),
    flip: z.boolean().optional(),
    totals: z.boolean().optional(),
    target: formula.optional(),
    marker: formula.optional(),
    markerLabel: shortText.optional(),
    overIsBad: z.boolean().optional(),
  })
  .strict();

const BlockSchema = z
  .object({
    id: name,
    kind: z.enum(BLOCK_KINDS),
    w: z.number().int().min(1).max(CARD_GRID_COLUMNS),
    title: shortText.optional(),
    query: QuerySchema.optional(),
    layers: z.array(QuerySchema).max(MAX_LAYERS).optional(),
    options: OptionsSchema.optional(),
  })
  .strict();

const MetricSchema = z
  .object({
    id: identifier,
    label: shortText.optional(),
    format: fieldType.optional(),
    expr: formula,
    dataset: name.optional(),
    range: DateRangeSchema.optional(),
    filters: z.array(FilterSchema).max(MAX_FILTERS).optional(),
  })
  .strict();

export const CardDocSchema = z
  .object({
    v: z.literal(2),
    placement: z.enum(["auto", "main", "side"]).optional(),
    metrics: z.array(MetricSchema).max(MAX_METRICS).optional(),
    blocks: z.array(BlockSchema).max(MAX_BLOCKS),
  })
  .strict();

export const CustomCardSchema = z
  .object({
    title: z.string().trim().min(1, "Give the card a title").max(60),
    description: z.string().trim().max(200).optional(),
    doc: CardDocSchema,
    basedOn: name.optional(),
  })
  .strict();

const cardRef = z.string().min(1).max(80);
/** One size's arrangement: exactly as many columns as that size has. */
const manualColumns = (count: number) =>
  z.array(z.array(cardRef).max(MAX_LAYOUT_CARDS)).length(count).optional();

export const LayoutSchema = z
  .object({
    cards: z.array(cardRef).max(MAX_LAYOUT_CARDS),
    /** Replaces every size's hand arrangement. Left out, they stay as they are. */
    columns: z
      .object({
        "1": manualColumns(1),
        "2": manualColumns(2),
        "3": manualColumns(3),
        "4": manualColumns(4),
      })
      .strict()
      .optional(),
  })
  .strict();

/** Refuse a card that could never work, saying exactly why. */
function assertUsable(doc: CardDoc) {
  const issues = checkCardDoc(doc);
  if (issues.length) throw badRequest(issues.map((i) => i.message).join(" "));
}

const FORMULA_GUIDE = `Formulas are small expressions, not code.
Refer to fields as [Field label] or by id, and to the card's named values as $name.
Money in a formula is in dollars: [Amount] > 100 means more than a hundred dollars.
Write percentages as 10% (0.1). Text goes in "quotes". Join text with &.
Operators: + - * / ^ and = != < <= > >= and, or, not.
A measure's formula is worked out for each group of rows. A field on its own there means its total: [Spending] / [Income]. Totals take an optional condition: sum([Spending], [Category] = "Dining").
"Over rows" functions read the result's rows in axis order, within each series: running_sum([Spending]), pct_of_total(spent), prev(spent, 12).
A calculated field is worked out for each row before grouping, and can then be grouped by: if([Amount] < -100, "Large", "Small").
A named value (metric) with a dataset is worked out over that dataset's rows; without one, over other named values: $income - $spent. Named values work across datasets, so they're how to combine them.
Text can include live values: "You spent {{$spent}} of {{$budget}}".
Dividing by zero gives an empty value rather than an error.`;

export function dashboardSchema(): DashboardSchema {
  const example = (id: string, title: string, description: string): CustomCardInput => ({
    title,
    description,
    doc: builtinCardDoc(id) as CardDoc,
  });
  return {
    builtinCards: BUILTIN_CARDS,
    datasets: DATASETS,
    functions: FUNCTIONS,
    blockKinds: Object.values(BLOCK_KIND_INFO),
    datePresets: DATE_PRESETS,
    dateBuckets: DATE_BUCKETS,
    filterOps: FILTER_OPS,
    aggregates: AGGREGATES,
    colors: CARD_COLORS,
    formulaGuide: FORMULA_GUIDE,
    cardJsonSchema: z.toJSONSchema(CustomCardSchema),
    examples: [
      example("cash-flow", "Income vs. spending", "Two measures by month, and a sentence."),
      example("budget", "Budget", "Named values, a progress bar and live text."),
      example("spending", "Spent this month", "Stacked layers across datasets."),
    ],
  };
}

// ---------------------------------------------------------------------------
// Storage: a layout per person; custom cards shared by the household.
// ---------------------------------------------------------------------------

const CARDS_KEY = "dashboard.cards";
const layoutKey = (userId: string) => `dashboard.layout:${userId}`;
const columnsKey = (userId: string) => `dashboard.columns:${userId}`;

function read<T>(db: Db, key: string): T | null {
  const row = db.select().from(schema.appSettings).where(eq(schema.appSettings.key, key)).get();
  return (row?.value as T | undefined) ?? null;
}

function write(db: Db, key: string, value: unknown) {
  db.insert(schema.appSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: schema.appSettings.key, set: { value } })
    .run();
}

type StoredCard = Omit<CustomCard, "doc"> & { doc?: CardDoc; spec?: unknown };

export const listCustomCards = (db: Db): CustomCard[] =>
  (read<StoredCard[]>(db, CARDS_KEY) ?? []).map(({ spec, ...card }) => ({
    ...card,
    // Cards saved before documents existed.
    doc: card.doc ?? (isV1Spec(spec) ? upgradeV1Spec(spec) : { v: 2, blocks: [] }),
  }));

function knownCards(db: Db) {
  return new Set([
    ...BUILTIN_CARDS.map((c) => c.id),
    ...listCustomCards(db).map((c) => `${CUSTOM_PREFIX}${c.id}`),
  ]);
}

export function getDashboard(db: Db, userId: string): Dashboard {
  const saved = layoutFromSaved(read<unknown>(db, layoutKey(userId)));
  const known = knownCards(db);
  return {
    // A custom card someone deleted simply drops out of everyone's layout.
    cards: (saved ?? DEFAULT_DASHBOARD).filter((c) => known.has(c)),
    isDefault: saved === null,
    columns: read<ManualColumns>(db, columnsKey(userId)) ?? {},
    customCards: listCustomCards(db),
  };
}

export function saveLayout(
  db: Db,
  userId: string,
  cards: string[],
  columns?: ManualColumns,
): Dashboard {
  const known = knownCards(db);
  const seen = new Set<string>();
  for (const c of cards) {
    if (!known.has(c)) throw badRequest(`Unknown card: ${c}`);
    if (seen.has(c)) throw badRequest(`A layout can hold ${c} only once`);
    seen.add(c);
  }
  for (const list of Object.values(columns ?? {})) {
    const placed = (list ?? []).flat();
    if (placed.some((c) => !seen.has(c)))
      throw badRequest("Columns can only hold cards on the Overview");
    if (new Set(placed).size !== placed.length)
      throw badRequest("Columns can hold each card only once");
  }
  write(db, layoutKey(userId), cards);
  if (columns) write(db, columnsKey(userId), columns);
  return getDashboard(db, userId);
}

export function resetLayout(db: Db, userId: string): Dashboard {
  for (const key of [layoutKey(userId), columnsKey(userId)])
    db.delete(schema.appSettings).where(eq(schema.appSettings.key, key)).run();
  return getDashboard(db, userId);
}

/**
 * Create a custom card. With `place`, also add it to this person's Overview:
 * in the place of the built-in card it's a copy of, otherwise last.
 */
export function createCustomCard(
  db: Db,
  userId: string,
  input: CustomCardInput,
  place: boolean,
): CustomCard {
  assertUsable(input.doc);
  const cards = listCustomCards(db);
  if (cards.length >= MAX_CUSTOM_CARDS)
    throw conflict(`You can keep up to ${MAX_CUSTOM_CARDS} custom cards; delete one first`);
  const card: CustomCard = { id: newId(), ...input };
  write(db, CARDS_KEY, [...cards, card]);
  if (place) {
    const ref = `${CUSTOM_PREFIX}${card.id}`;
    const { cards: layout, columns } = getDashboard(db, userId);
    const at = input.basedOn ? layout.indexOf(input.basedOn) : -1;
    if (at < 0) saveLayout(db, userId, [...layout, ref]);
    else {
      // A copy sits exactly where the original did, at every size.
      const swap = (c: string) => (c === input.basedOn ? ref : c);
      const swapped: ManualColumns = {};
      for (const [size, list] of Object.entries(columns))
        swapped[size as keyof ManualColumns] = list?.map((column) => column.map(swap));
      saveLayout(db, userId, layout.map(swap), swapped);
    }
  }
  return card;
}

export function updateCustomCard(db: Db, cardId: string, input: CustomCardInput): CustomCard {
  assertUsable(input.doc);
  const cards = listCustomCards(db);
  if (!cards.some((c) => c.id === cardId)) throw notFound("Card not found");
  const card: CustomCard = { id: cardId, ...input };
  write(
    db,
    CARDS_KEY,
    cards.map((c) => (c.id === cardId ? card : c)),
  );
  return card;
}

export function deleteCustomCard(db: Db, cardId: string) {
  const cards = listCustomCards(db);
  if (!cards.some((c) => c.id === cardId)) throw notFound("Card not found");
  write(
    db,
    CARDS_KEY,
    cards.filter((c) => c.id !== cardId),
  );
}

export function customCard(db: Db, cardId: string): CustomCard {
  const card = listCustomCards(db).find((c) => c.id === cardId);
  if (!card) throw notFound("Card not found");
  return card;
}

/** Run a card. Reads only; nothing here can change data. */
export function runCard(db: Db, doc: CardDoc, today = localToday()): CardResult {
  return runCardDoc(doc, dataProvider(db, today), today);
}

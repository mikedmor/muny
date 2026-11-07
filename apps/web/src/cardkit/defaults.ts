import {
  BLOCK_KIND_INFO,
  type BlockKind,
  type CardBlock,
  type CardDoc,
  type CardMeasure,
  type CardQuery,
  DATASET_BY_ID,
  type FieldInfo,
  findField,
} from "@muny/shared";

/** A block that shows something right away, ready to change. */

const SPENT: CardMeasure = { id: "spent", label: "Spent", field: "spending", agg: "sum" };

const QUERIES: Partial<Record<BlockKind, CardQuery>> = {
  stat: { dataset: "transactions", range: { preset: "this_month" }, measures: [SPENT] },
  progress: {
    dataset: "budgets",
    range: { preset: "this_month" },
    filters: [
      { field: "line_type", op: "eq", value: "category" },
      { field: "has_budget", op: "is_true" },
    ],
    dimensions: [{ field: "name" }],
    measures: [
      { id: "spent", label: "Spent", field: "spent", agg: "sum" },
      { id: "budget", label: "Budgeted", field: "budget", agg: "sum" },
    ],
  },
  list: {
    dataset: "transactions",
    range: { preset: "this_month" },
    filters: [{ field: "spending", op: "gt", value: 0 }],
    dimensions: [{ field: "merchant" }],
    measures: [SPENT],
    limit: 8,
  },
  table: {
    dataset: "transactions",
    range: { preset: "this_month" },
    filters: [{ field: "spending", op: "ne", value: 0 }],
    dimensions: [{ field: "category" }],
    measures: [SPENT, { id: "charges", label: "Charges", agg: "count" }],
  },
  bars: {
    dataset: "transactions",
    range: { preset: "this_month" },
    filters: [{ field: "spending", op: "ne", value: 0 }],
    dimensions: [{ field: "category" }],
    measures: [SPENT],
    limit: 10,
    other: true,
  },
  column: {
    dataset: "transactions",
    range: { last: 6, unit: "months" },
    dimensions: [{ field: "date", bucket: "month" }],
    measures: [{ id: "income", label: "Income", field: "income", agg: "sum" }, SPENT],
    fill: true,
  },
  line: {
    dataset: "net_worth",
    range: { last: 12, unit: "months" },
    dimensions: [{ field: "date" }],
    measures: [{ id: "net", label: "Net worth", field: "net", agg: "last" }],
  },
  area: {
    dataset: "transactions",
    range: { last: 12, unit: "months" },
    dimensions: [{ field: "date", bucket: "month" }],
    measures: [SPENT],
    fill: true,
  },
  pie: {
    dataset: "transactions",
    range: { preset: "this_month" },
    filters: [{ field: "spending", op: "ne", value: 0 }],
    dimensions: [{ field: "category_group" }],
    measures: [SPENT],
  },
  treemap: {
    dataset: "transactions",
    range: { preset: "this_month" },
    filters: [{ field: "spending", op: "gt", value: 0 }],
    dimensions: [{ field: "merchant" }],
    measures: [SPENT],
    limit: 30,
  },
  heatmap: {
    dataset: "transactions",
    range: { preset: "last_3_months" },
    filters: [{ field: "spending", op: "gt", value: 0 }],
    dimensions: [{ field: "date", bucket: "weekday" }, { field: "category_group" }],
    measures: [SPENT],
  },
  scatter: {
    dataset: "transactions",
    range: { preset: "last_3_months" },
    filters: [{ field: "spending", op: "gt", value: 0 }],
    dimensions: [{ field: "merchant" }],
    measures: [{ id: "charges", label: "Charges", agg: "count" }, SPENT],
    limit: 40,
  },
  waterfall: {
    dataset: "transactions",
    range: { preset: "this_month" },
    filters: [{ field: "is_transfer", op: "is_false" }],
    dimensions: [{ field: "category_group" }],
    measures: [{ id: "amount", label: "Amount", field: "amount", agg: "sum" }],
    limit: 12,
  },
  calendar: {
    dataset: "upcoming",
    range: { preset: "next_90_days" },
    raw: true,
    dimensions: [{ field: "date" }, { field: "name" }],
    measures: [{ id: "amount", label: "Amount", field: "amount", agg: "sum" }],
  },
};

const OPTIONS: Partial<Record<BlockKind, CardBlock["options"]>> = {
  stat: { label: "Spent this month", size: "lg" },
  text: { text: "Write anything here, with live values like {{today()}}." },
  heading: { text: "A heading" },
  bars: { percent: true },
  table: { totals: true },
  list: { icon: "merchant" },
  progress: { overIsBad: true },
};

export function newBlockId(doc: CardDoc): string {
  const used = new Set(doc.blocks.map((b) => b.id));
  let n = doc.blocks.length + 1;
  while (used.has(`b${n}`)) n++;
  return `b${n}`;
}

export function defaultBlock(kind: BlockKind, id: string): CardBlock {
  const query = QUERIES[kind];
  const options = OPTIONS[kind];
  return {
    id,
    kind,
    w: BLOCK_KIND_INFO[kind].width,
    ...(query ? { query: structuredClone(query) } : {}),
    ...(options ? { options: { ...options } } : {}),
  };
}

export const isNumeric = (f: FieldInfo | undefined) =>
  f?.type === "money" || f?.type === "number" || f?.type === "percent";

export function uniqueId(base: string, used: Iterable<string>): string {
  const clean = base.replace(/[^A-Za-z0-9_]/g, "_").replace(/^[^A-Za-z_]+/, "") || "value";
  const taken = new Set(used);
  if (!taken.has(clean)) return clean;
  let n = 2;
  while (taken.has(`${clean}_${n}`)) n++;
  return `${clean}_${n}`;
}

export function measureFromField(query: CardQuery, dataset: string, field: string): CardMeasure {
  const info = DATASET_BY_ID.get(dataset);
  const f = info ? findField(info, field) : undefined;
  const id = uniqueId(
    field,
    (query.measures ?? []).map((m) => m.id),
  );
  return {
    id,
    ...(f ? { label: f.label } : {}),
    field,
    agg: isNumeric(f) ? "sum" : "count_distinct",
  };
}

/**
 * A block for a field dropped on the empty part of a card: a total for numbers,
 * a line over time for dates, and a comparison for anything else.
 */
export function blockForField(dataset: string, field: string, id: string): CardBlock {
  const info = DATASET_BY_ID.get(dataset);
  const f = info ? findField(info, field) : undefined;
  const range = info?.dateField
    ? { range: { last: 3, unit: "months" as const } }
    : ({} as Record<string, never>);
  const base: CardQuery = { dataset, ...range };
  if (isNumeric(f))
    return {
      id,
      kind: "stat",
      w: 6,
      query: { ...base, measures: [measureFromField(base, dataset, field)] },
      options: { label: f?.label ?? field, size: "lg" },
    };
  const count: CardMeasure = { id: "rows", label: "How many", agg: "count" };
  if (f?.type === "date" || f?.type === "month")
    return {
      id,
      kind: "column",
      w: 12,
      query: {
        ...base,
        dimensions: [{ field, bucket: "month" }],
        measures: [count],
        fill: true,
      },
    };
  return {
    id,
    kind: "bars",
    w: 12,
    query: { ...base, dimensions: [{ field }], measures: [count], limit: 10, other: true },
  };
}

/** Add a field to a block: a number becomes a value, anything else a grouping. */
export function addFieldToBlock(block: CardBlock, dataset: string, field: string): CardBlock {
  const kind = BLOCK_KIND_INFO[block.kind];
  if (!kind.query) return block;
  const info = DATASET_BY_ID.get(dataset);
  const f = info ? findField(info, field) : undefined;
  const base = queryForDataset(block.query, dataset);
  if (isNumeric(f)) {
    const measure = measureFromField(base, dataset, field);
    const measures =
      kind.measures[1] === 1
        ? [measure]
        : [...(base.measures ?? []), measure].slice(0, kind.measures[1] || 16);
    return { ...block, query: { ...base, measures } };
  }
  const dims = base.dimensions ?? [];
  if (dims.some((d) => d.field === field)) return { ...block, query: base };
  const bucket = f?.type === "date" || f?.type === "month" ? ({ bucket: "month" } as const) : {};
  const room = kind.dimensions.length;
  const dimensions =
    dims.length < room
      ? [...dims, { field, ...bucket }]
      : [...dims.slice(0, room - 1), { field, ...bucket }];
  const measures = base.measures?.length
    ? base.measures
    : [{ id: "rows", label: "How many", agg: "count" as const }];
  return { ...block, query: { ...base, dimensions, measures } };
}

/** The same query on another dataset, keeping whatever still makes sense there. */
export function queryForDataset(query: CardQuery | undefined, dataset: string): CardQuery {
  if (!query) return { dataset };
  if (query.dataset === dataset) return query;
  const info = DATASET_BY_ID.get(dataset);
  const has = (name: string) => !!info && !!findField(info, name);
  const { range, ...rest } = query;
  return {
    ...rest,
    dataset,
    ...(range && info?.dateField ? { range } : {}),
    filters: query.filters?.filter((f) => has(f.field)),
    dimensions: query.dimensions?.filter((d) => has(d.field)),
    measures: query.measures?.filter((m) =>
      m.field ? has(m.field) : !!m.expr || m.agg === "count",
    ),
    sort: undefined,
    calculated: undefined,
  };
}

/** Prompt for any assistant. It holds no financial data, only what a card can be. */
export function assistantPrompt(schema: unknown) {
  return `Write one card for the Overview page of Muny, a self-hosted personal finance app.
Reply with only a JSON object: { "title": ..., "description": ..., "doc": { "v": 2, "metrics": [...], "blocks": [...] } }.

A card is data, not code: blocks on a 12-column grid, each with an optional query over one of the datasets below, plus named values (metrics) that work across datasets. Follow cardJsonSchema exactly, and use only the datasets, fields and functions listed. Colors come from the app's theme, so don't try to set any. The examples show real cards.

What I want on the card: <describe it here>

${JSON.stringify(schema)}`;
}

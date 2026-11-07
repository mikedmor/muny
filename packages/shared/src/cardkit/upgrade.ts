/**
 * The first version of custom cards was one source and one view. Those stored
 * cards keep working: they turn into documents when they're read.
 */
import type { BlockKind, CardDoc, CardFilter, CardQuery, DatePreset } from "./doc.js";

interface V1Spec {
  source: string;
  view: string;
  period?: string;
  months?: number;
  days?: number;
  limit?: number;
  categoryId?: string;
  accountId?: string;
  search?: string;
}

const KIND: Record<string, BlockKind> = {
  stat: "stat",
  list: "list",
  bars: "bars",
  columns: "column",
  line: "line",
};

const PERIOD: Record<string, DatePreset> = {
  this_month: "this_month",
  last_month: "last_month",
  last_30_days: "last_30_days",
  last_90_days: "last_90_days",
  this_year: "this_year",
  last_12_months: "last_12_months",
};

export function upgradeV1Spec(spec: V1Spec): CardDoc {
  const range = { preset: PERIOD[spec.period ?? "this_month"] ?? ("this_month" as const) };
  const months = { last: spec.months ?? 6, unit: "months" as const };
  const limit = spec.limit ?? 10;
  const category: CardFilter[] = spec.categoryId
    ? [{ field: "category_id", op: "eq", value: spec.categoryId }]
    : [];
  const spent = { id: "spent", label: "Spent", field: "spending", agg: "sum" as const };
  const earned = { id: "earned", label: "Income", field: "income", agg: "sum" as const };
  const byMonth = { field: "date", bucket: "month" as const };

  let query: CardQuery;
  const options: NonNullable<CardDoc["blocks"][number]["options"]> = {};
  switch (spec.source) {
    case "spending_by_category":
    case "spending_by_merchant":
      query = {
        dataset: "transactions",
        range,
        filters: [{ field: "spending", op: "ne", value: 0 }, ...category],
        dimensions: [{ field: spec.source === "spending_by_merchant" ? "merchant" : "category" }],
        measures: [spent],
        limit,
      };
      if (spec.view === "bars") options.percent = true;
      break;
    case "spending_total":
      query = { dataset: "transactions", range, filters: category, measures: [spent] };
      break;
    case "income_total":
      query = { dataset: "transactions", range, measures: [earned] };
      break;
    case "spending_by_month":
      query = {
        dataset: "transactions",
        range: months,
        filters: category,
        dimensions: [byMonth],
        measures: [spent],
        fill: true,
      };
      break;
    case "income_by_month":
      query = {
        dataset: "transactions",
        range: months,
        dimensions: [byMonth],
        measures: [earned],
        fill: true,
      };
      break;
    case "cash_flow_by_month":
      query = {
        dataset: "transactions",
        range: months,
        dimensions: [byMonth],
        measures: [earned, spent],
        fill: true,
      };
      if (spec.view === "stat") options.value = "earned - spent";
      break;
    case "net_worth_by_month":
      query = {
        dataset: "net_worth",
        range: { last: spec.months ?? 12, unit: "months" },
        dimensions: [{ field: "date" }],
        measures: [{ id: "net", label: "Net worth", field: "net", agg: "last" }],
      };
      break;
    case "account_balances":
      query = {
        dataset: "accounts",
        raw: true,
        dimensions: [{ field: "name" }, { field: "institution" }],
        measures: [{ id: "balance", label: "Balance", field: "balance", agg: "sum" }],
        limit,
      };
      options.subtitle = "institution";
      break;
    case "budget_status":
      query = {
        dataset: "budgets",
        range: { preset: "this_month" },
        filters: [
          { field: "line_type", op: "eq", value: "category" },
          { field: "has_budget", op: "is_true" },
        ],
        raw: true,
        dimensions: [{ field: "name" }],
        measures: [
          { id: "spent", label: "Spent", field: "spent", agg: "sum" },
          { id: "budget", label: "Budgeted", field: "budget", agg: "sum" },
        ],
        limit,
      };
      break;
    case "upcoming_charges":
      query = {
        dataset: "upcoming",
        range: { next: spec.days ?? 30, unit: "days" },
        raw: true,
        dimensions: [{ field: "name" }, { field: "date" }],
        measures: [{ id: "amount", label: "Amount", field: "amount", agg: "sum" }],
        limit,
      };
      options.subtitle = "date";
      break;
    default:
      query = {
        dataset: "transactions",
        raw: true,
        filters: [
          ...category,
          ...(spec.accountId
            ? [{ field: "account_id", op: "eq" as const, value: spec.accountId }]
            : []),
          ...(spec.search
            ? [{ field: "merchant_or_description", op: "contains" as const, value: spec.search }]
            : []),
        ],
        dimensions: [{ field: "merchant" }, { field: "date" }],
        measures: [{ id: "amount", label: "Amount", field: "amount", agg: "sum" }],
        limit,
      };
      options.subtitle = "date";
  }
  if (spec.view === "list") {
    const first = query.dimensions?.[0]?.field;
    if (first) options.title = first;
    const measure = query.measures?.[0]?.id;
    if (measure) options.amount = measure;
  }
  return {
    v: 2,
    blocks: [{ id: "b1", kind: KIND[spec.view] ?? "list", w: 12, query, options }],
  };
}

export const isV1Spec = (value: unknown): value is V1Spec =>
  typeof value === "object" && value !== null && typeof (value as V1Spec).source === "string";

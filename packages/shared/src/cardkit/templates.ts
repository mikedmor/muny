/**
 * Every built-in Overview card written as a card document. "Customize a copy"
 * starts from these, so a person can change anything about a built-in card.
 */
import type { BlockOptions, CardBlock, CardDoc, CardQuery } from "./doc.js";

let counter = 0;
const nextId = () => `b${++counter}`;

const block = (
  kind: CardBlock["kind"],
  w: number,
  query?: CardQuery,
  options?: BlockOptions,
  extra?: Partial<CardBlock>,
): CardBlock => ({
  id: nextId(),
  kind,
  w,
  ...(query ? { query } : {}),
  ...(options ? { options } : {}),
  ...extra,
});

const heading = (text: string, to?: string, label?: string, hash?: string) =>
  block("heading", 12, undefined, {
    text,
    ...(to && label ? { link: { to, label, ...(hash ? { hash } : {}) } } : {}),
  });

const THIS_MONTH = { preset: "this_month" } as const;
const LAST_MONTH = { preset: "last_month" } as const;

const money = (id: string, field: string, label?: string) => ({
  id,
  field,
  agg: "sum" as const,
  ...(label ? { label } : {}),
});

const TEMPLATES: Record<string, () => CardDoc> = {
  spending: () => ({
    v: 2,
    placement: "main",
    metrics: [
      {
        id: "spent",
        label: "Spent this month",
        dataset: "transactions",
        range: THIS_MONTH,
        expr: "sum([Spending])",
      },
      {
        id: "last_same_day",
        label: "Spent by this day last month",
        dataset: "transactions",
        range: LAST_MONTH,
        expr: "sum([Spending], [Date] <= add_months(today(), -1))",
      },
      {
        id: "last_total",
        label: "Spent last month",
        dataset: "transactions",
        range: LAST_MONTH,
        expr: "sum([Spending])",
      },
      {
        id: "earned",
        label: "Earned this month",
        dataset: "transactions",
        range: THIS_MONTH,
        expr: "sum([Income])",
      },
    ],
    blocks: [
      block("stat", 12, undefined, {
        label: "Spent this month",
        value: "$spent",
        compare: "$last_same_day",
        compareLabel: "this point last month",
        goodWhen: "down",
        size: "xl",
      }),
      block(
        "area",
        12,
        {
          dataset: "transactions",
          range: THIS_MONTH,
          filters: [{ field: "spending", op: "ne", value: 0 }],
          dimensions: [
            { field: "date", bucket: "day_of_month", label: "Day" },
            { field: "category" },
          ],
          measures: [{ id: "total", label: "This month", expr: "running_sum([Spending])" }],
          fill: true,
        },
        {
          stacked: true,
          references: [{ label: "Earned", expr: "$earned", color: "positive" }],
        },
        {
          layers: [
            {
              dataset: "transactions",
              range: LAST_MONTH,
              dimensions: [{ field: "date", bucket: "day_of_month", label: "Day" }],
              measures: [
                {
                  id: "last",
                  label: "Last month",
                  expr: "running_sum([Spending])",
                  color: "muted",
                  mark: "dashed",
                },
              ],
              fill: true,
            },
          ],
        },
      ),
      block("stat", 6, undefined, { label: "Earned this month", value: "$earned", size: "sm" }),
      block("stat", 6, undefined, { label: "Spent last month", value: "$last_total", size: "sm" }),
    ],
  }),

  calendar: () => ({
    v: 2,
    placement: "main",
    blocks: [
      block(
        "calendar",
        12,
        {
          dataset: "upcoming",
          range: { preset: "next_90_days" },
          raw: true,
          dimensions: [{ field: "date" }, { field: "name" }],
          measures: [money("amount", "amount")],
        },
        {},
      ),
    ],
  }),

  "cash-flow": () => ({
    v: 2,
    placement: "main",
    metrics: [
      {
        id: "kept",
        label: "Kept per full month",
        dataset: "transactions",
        range: { last: 6, unit: "months" },
        expr: "sum([Income] - [Spending], month_key([Date]) != this_month()) / 5",
        format: "money",
      },
    ],
    blocks: [
      heading("Income vs. spending", "/reports", "Cash flow", "cash-flow"),
      block("text", 12, undefined, {
        text: "Over the last 5 full months you kept {{$kept}} a month on average.",
        tone: "muted",
        toneExpr: 'if($kept >= 0, "muted", "negative")',
      }),
      block(
        "column",
        12,
        {
          dataset: "transactions",
          range: { last: 6, unit: "months" },
          dimensions: [{ field: "date", bucket: "month" }],
          measures: [
            { ...money("income", "income", "Income"), color: "series1" },
            { ...money("spending", "spending", "Spending"), color: "series2" },
          ],
          fill: true,
        },
        {},
      ),
    ],
  }),

  categories: () => ({
    v: 2,
    placement: "main",
    blocks: [
      heading("Where your money went this month", "/reports", "Reports"),
      block(
        "bars",
        12,
        {
          dataset: "transactions",
          range: THIS_MONTH,
          filters: [{ field: "spending", op: "ne", value: 0 }],
          dimensions: [{ field: "category" }],
          measures: [money("spent", "spending", "Spent")],
          limit: 12,
          other: true,
        },
        { percent: true },
      ),
    ],
  }),

  merchants: () => ({
    v: 2,
    placement: "main",
    blocks: [
      heading("Top merchants this month", "/reports", "More", "spending"),
      block(
        "list",
        12,
        {
          dataset: "transactions",
          range: THIS_MONTH,
          filters: [{ field: "spending", op: "gt", value: 0 }],
          dimensions: [{ field: "merchant" }],
          measures: [
            money("spent", "spending", "Spent"),
            { id: "charges", label: "Charges", agg: "count" },
          ],
          limit: 8,
        },
        {
          title: "merchant",
          amount: "spent",
          subamount: "charges",
          icon: "merchant",
          bar: true,
        },
      ),
    ],
  }),

  "cash-trend": () => ({
    v: 2,
    placement: "main",
    metrics: [
      {
        id: "first",
        label: "Cash 6 months ago",
        dataset: "net_worth",
        range: { last: 6, unit: "months" },
        expr: "first([Cash])",
      },
      {
        id: "now",
        label: "Cash now",
        dataset: "net_worth",
        range: { last: 6, unit: "months" },
        expr: "last([Cash])",
      },
    ],
    blocks: [
      heading("Cash over time", "/reports", "Net worth", "net-worth"),
      block("text", 12, undefined, {
        text: 'Checking & savings {{if($now >= $first, "up", "down")}} {{abs($now - $first)}} over 6 months',
        toneExpr: 'if($now >= $first, "positive", "negative")',
      }),
      block(
        "line",
        12,
        {
          dataset: "net_worth",
          range: { last: 6, unit: "months" },
          dimensions: [{ field: "date" }],
          measures: [{ id: "cash", field: "cash", agg: "last", label: "Cash" }],
        },
        { height: 160 },
      ),
    ],
  }),

  accounts: () => ({
    v: 2,
    placement: "side",
    metrics: [
      {
        id: "cash",
        label: "Cash in checking & savings",
        dataset: "accounts",
        filters: [{ field: "type", op: "in", value: ["checking", "cash", "savings"] }],
        expr: "sum([Balance])",
      },
      {
        id: "checking",
        label: "Checking",
        dataset: "accounts",
        filters: [{ field: "type", op: "in", value: ["checking", "cash"] }],
        expr: "sum([Balance])",
      },
      {
        id: "cards",
        label: "Credit cards",
        dataset: "accounts",
        filters: [{ field: "type", op: "eq", value: "credit" }],
        expr: "sum([Balance])",
      },
    ],
    blocks: [
      heading("Accounts", "/accounts", "Manage"),
      block("stat", 12, undefined, {
        label: "Cash in checking & savings",
        value: "$cash",
        size: "xl",
      }),
      block(
        "list",
        12,
        {
          dataset: "accounts",
          raw: true,
          calculated: [
            {
              id: "shown",
              label: "Shown balance",
              expr: "if([Debt], [Owed], [Balance])",
              format: "money",
            },
          ],
          dimensions: [{ field: "type_group" }, { field: "name" }, { field: "institution" }],
          measures: [{ id: "balance", label: "Balance", field: "shown", agg: "sum" }],
          sort: [{ by: "balance", dir: "desc" }],
        },
        {
          groupBy: "type_group",
          title: "name",
          subtitle: "institution",
          amount: "balance",
        },
      ),
      block("stat", 12, undefined, {
        label: "Net cash: checking minus card balances",
        value: "$checking + $cards",
        size: "sm",
      }),
    ],
  }),

  cards: () => ({
    v: 2,
    placement: "side",
    metrics: [
      {
        id: "owed",
        label: "Owed on cards",
        dataset: "credit_cards",
        expr: "sum([Balance])",
      },
      {
        id: "limit",
        label: "Total limit",
        dataset: "credit_cards",
        expr: "sum([Limit])",
      },
    ],
    blocks: [
      heading("Credit cards", "/cards", "Open Credit cards"),
      block("stat", 12, undefined, {
        label: "Owed",
        value: "$owed",
        size: "lg",
      }),
      block("progress", 12, undefined, {
        label: "Share of your limits in use",
        value: "$owed",
        target: "$limit",
        overIsBad: true,
      }),
      block(
        "list",
        12,
        {
          dataset: "credit_cards",
          raw: true,
          dimensions: [{ field: "name" }, { field: "due_date" }],
          measures: [money("balance", "balance", "Owed")],
          sort: [{ by: "balance", dir: "desc" }],
          limit: 6,
        },
        { title: "name", subtitle: "due_date", amount: "balance" },
      ),
    ],
  }),

  loans: () => ({
    v: 2,
    placement: "side",
    metrics: [
      {
        id: "owed",
        label: "Owed on loans",
        dataset: "loans",
        expr: "sum([Owed])",
      },
      {
        id: "monthly",
        label: "Monthly payments",
        dataset: "loans",
        expr: "sum([Monthly payment])",
      },
    ],
    blocks: [
      heading("Loans", "/loans", "Open Loans"),
      block("stat", 12, undefined, {
        label: "Owed",
        value: "$owed",
        size: "lg",
        text: "{{$monthly}} a month in payments",
      }),
      block(
        "list",
        12,
        {
          dataset: "loans",
          raw: true,
          dimensions: [{ field: "name" }, { field: "lender" }],
          measures: [money("balance", "balance", "Owed")],
          sort: [{ by: "balance", dir: "desc" }],
          limit: 6,
        },
        { title: "name", subtitle: "lender", amount: "balance" },
      ),
    ],
  }),

  stocks: () => ({
    v: 2,
    placement: "side",
    metrics: [
      { id: "value", label: "Value", dataset: "holdings", expr: "sum([Value])" },
      { id: "cost", label: "Cost", dataset: "holdings", expr: "sum([Cost], [Cost] > 0)" },
      {
        id: "known_value",
        label: "Value with a known cost",
        dataset: "holdings",
        expr: "sum([Value], [Cost] > 0)",
      },
      {
        id: "dividends",
        label: "Dividends and interest, last 12 months",
        dataset: "investment_transactions",
        range: { preset: "last_12_months" },
        filters: [{ field: "type", op: "in", value: ["dividend", "interest"] }],
        expr: "sum([Cash effect])",
      },
    ],
    blocks: [
      heading("Stocks", "/stocks", "Open Stocks"),
      block("stat", 12, undefined, {
        value: "$value",
        size: "lg",
        compare: "$cost + ($value - $known_value)",
        compareLabel: "what you paid",
        goodWhen: "up",
      }),
      block(
        "list",
        12,
        {
          dataset: "holdings",
          filters: [{ field: "type", op: "ne", value: "cash" }],
          dimensions: [{ field: "symbol" }, { field: "name" }],
          measures: [money("value", "value", "Value")],
          limit: 4,
        },
        { title: "symbol", subtitle: "name", amount: "value" },
      ),
      block("text", 12, undefined, {
        text: "Dividends and interest, last 12 months: {{$dividends}}",
        tone: "muted",
      }),
    ],
  }),

  crypto: () => ({
    v: 2,
    placement: "side",
    metrics: [{ id: "value", label: "Value", dataset: "crypto_holdings", expr: "sum([Value])" }],
    blocks: [
      heading("Crypto", "/crypto", "Open Crypto"),
      block("stat", 12, undefined, { value: "$value", size: "lg" }),
      block(
        "list",
        12,
        {
          dataset: "crypto_holdings",
          filters: [{ field: "value", op: "gt", value: 0 }],
          dimensions: [{ field: "asset" }],
          measures: [money("value", "value", "Value")],
          limit: 4,
        },
        { title: "asset", amount: "value", icon: "coin" },
      ),
    ],
  }),

  budget: () => ({
    v: 2,
    placement: "side",
    metrics: [
      {
        id: "budget",
        label: "Budgeted",
        dataset: "budgets",
        range: THIS_MONTH,
        filters: [{ field: "line_type", op: "eq", value: "total" }],
        expr: "sum([Budgeted])",
      },
      {
        id: "spent",
        label: "Spent",
        dataset: "budgets",
        range: THIS_MONTH,
        filters: [{ field: "line_type", op: "eq", value: "total" }],
        expr: "sum([Spent])",
      },
      {
        id: "pace",
        label: "Where you'd be spending evenly",
        expr: "$budget * day(today()) / days_in_month(today())",
        format: "money",
      },
    ],
    blocks: [
      heading("Budget", "/budgets", "Details"),
      block("stat", 12, undefined, {
        label: "Left to spend",
        value: "$budget - $spent",
        size: "md",
      }),
      block("progress", 12, undefined, {
        value: "$spent",
        target: "$budget",
        marker: "$pace",
        markerLabel: "Today's pace",
        overIsBad: true,
      }),
      block("text", 12, undefined, {
        text: '{{$spent}} of {{$budget}} · {{abs($pace - $spent)}} {{if($spent <= $pace, "under", "over")}} today\'s pace',
        tone: "muted",
      }),
    ],
  }),

  recent: () => ({
    v: 2,
    placement: "side",
    blocks: [
      heading("Recent transactions", "/transactions", "See all"),
      block(
        "list",
        12,
        {
          dataset: "transactions",
          raw: true,
          filters: [{ field: "is_funding", op: "is_false" }],
          calculated: [
            {
              id: "detail",
              label: "Detail",
              expr: '[Category] & " · " & text([Date]) & if([Pending], " · Pending", "")',
            },
          ],
          dimensions: [{ field: "merchant" }, { field: "detail" }, { field: "category" }],
          measures: [money("amount", "amount", "Amount")],
          limit: 8,
        },
        {
          title: "merchant",
          subtitle: "detail",
          amount: "amount",
          icon: "merchant",
          signColors: true,
        },
      ),
    ],
  }),

  "coming-up": () => ({
    v: 2,
    placement: "side",
    metrics: [
      {
        id: "due",
        label: "Due in the next 7 days",
        dataset: "upcoming",
        range: { preset: "next_7_days" },
        expr: "-sum([Amount], [Amount] < 0)",
        format: "money",
      },
      {
        id: "incoming",
        label: "Coming in over the next 7 days",
        dataset: "upcoming",
        range: { preset: "next_7_days" },
        expr: "sum([Amount], [Amount] > 0)",
        format: "money",
      },
    ],
    blocks: [
      heading("Coming up", "/recurring", "All recurring"),
      block("text", 12, undefined, {
        text: "{{$due}} due · {{$incoming}} coming in, in the next 7 days",
        tone: "muted",
      }),
      block(
        "list",
        12,
        {
          dataset: "upcoming",
          range: { preset: "next_7_days" },
          raw: true,
          dimensions: [{ field: "name" }, { field: "date" }],
          measures: [money("amount", "amount", "Amount")],
          sort: [{ by: "date", dir: "asc" }],
          limit: 12,
        },
        { title: "name", subtitle: "date", amount: "amount", icon: "merchant", signColors: true },
      ),
    ],
  }),
};

export const TEMPLATE_IDS = Object.keys(TEMPLATES);

/** A built-in card as a document to change, or null if there's no such card. */
export function builtinCardDoc(id: string): CardDoc | null {
  const make = TEMPLATES[id];
  if (!make) return null;
  // Block ids only need to be unique within a card.
  counter = 0;
  return make();
}

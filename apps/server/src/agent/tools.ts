import {
  type AgentScope,
  BUILTIN_CARDS,
  BUILTIN_THEMES,
  type CardDoc,
  type CardQuery,
  type CardResult,
  CUSTOM_PREFIX,
  checkCardDoc,
  DATASETS,
  SYSTEM_THEME,
  THEME_COLOR_KEYS,
  type Theme,
  themeWarnings,
} from "@muny/shared";
import { z } from "zod";
import { budgetMonth, overallBudget } from "../budgets/service.js";
import { cardsReport } from "../cards/service.js";
import { DATASET_READERS } from "../dashboard/datasets.js";
import {
  assertLayout,
  CardDocSchema,
  createCustomCard,
  customCard,
  dashboardSchema,
  deleteCustomCard,
  getDashboard,
  LayoutSchema,
  runCard,
  saveLayout,
  updateCustomCard,
} from "../dashboard/service.js";
import { investSummary } from "../invest/service.js";
import { listAccounts } from "../ledger/accounts.js";
import { audit } from "../lib/audit.js";
import { loansReport } from "../loans/service.js";
import { listSeries } from "../recurring/service.js";
import { netWorthDates, netWorthReport, overview, spendingReport } from "../reports/service.js";
import { alternativeSuggestions, listSavings, savingsSummary } from "../savings/service.js";
import {
  createTheme,
  deleteTheme,
  listThemes,
  selectTheme,
  ThemeInputSchema,
  themeState,
  updateTheme,
} from "../settings/themes.js";
import { listProposalsTool, PROPOSAL_TOOLS } from "./proposals.js";
import { defineTool, dryRunField, type Tool, type ToolContext, ToolError } from "./registry.js";

/** What reading each dataset takes. A card's data is only as open as this allows. */
export const DATASET_SCOPES: Record<string, AgentScope> = {
  transactions: "read:transactions",
  alerts: "read:transactions",
  categories: "read:summary",
  budgets: "read:summary",
  budget_forecast: "read:summary",
  recurring: "read:summary",
  upcoming: "read:summary",
  trials: "read:summary",
  money_saved: "read:summary",
  infrastructure_costs: "read:summary",
  accounts: "read:accounts",
  balance_history: "read:accounts",
  net_worth: "read:accounts",
  holdings: "read:accounts",
  investment_transactions: "read:accounts",
  crypto_holdings: "read:accounts",
  crypto_history: "read:accounts",
  crypto_history_by_asset: "read:accounts",
  crypto_transactions: "read:accounts",
  crypto_wallets: "read:accounts",
  savings_accounts: "read:accounts",
  savings_months: "read:accounts",
  savings_buckets: "read:accounts",
  assets: "read:accounts",
  documents: "read:accounts",
  loans: "read:debts",
  loan_payments: "read:debts",
  loan_history: "read:debts",
  credit_cards: "read:debts",
  card_history: "read:debts",
};

const datasetsIn = (doc: CardDoc) => {
  const out = new Set<string>();
  for (const m of doc.metrics ?? []) if (m.dataset) out.add(m.dataset);
  for (const b of doc.blocks) {
    if (b.query) out.add(b.query.dataset);
    for (const l of b.layers ?? []) out.add(l.dataset);
  }
  return out;
};

/** The permissions a token lacks to see this card's numbers. Unknown datasets fail when run. */
function missingScopes(ctx: ToolContext, doc: CardDoc): AgentScope[] {
  const missing = new Set<AgentScope>();
  for (const d of datasetsIn(doc)) {
    const scope = DATASET_SCOPES[d];
    if (scope && !ctx.agent.scopes.has(scope)) missing.add(scope);
  }
  return [...missing];
}

function requireRead(ctx: ToolContext, doc: CardDoc) {
  const missing = missingScopes(ctx, doc);
  if (missing.length)
    throw new ToolError(
      "not_allowed",
      `Reading this data takes the ${missing.join(" and ")} permission, which this token doesn't have.`,
    );
}

const ROWS_IN_PREVIEW = 25;

/** A card's results, small enough to hand to a model. */
function compactResult(result: CardResult) {
  return {
    today: result.today,
    values: result.metrics,
    blocks: Object.fromEntries(
      Object.entries(result.blocks).map(([id, b]) => [
        id,
        {
          ...(b.error ? { error: b.error } : {}),
          ...(b.value ? { value: b.value.text } : {}),
          ...(b.text ? { text: b.text } : {}),
          queries: b.queries.map((q) => ({
            columns: q.columns.map((c) => `${c.id} (${c.type})`),
            rowCount: q.rows.length,
            rows: q.rows.slice(0, ROWS_IN_PREVIEW),
          })),
        },
      ]),
    ),
  };
}

function parseDoc(raw: unknown): CardDoc {
  return CardDocSchema.parse(raw) as CardDoc;
}

/** Check a card, and show what it comes to if this token may see its data. */
function previewDoc(ctx: ToolContext, doc: CardDoc) {
  const issues = checkCardDoc(doc).map((i) => (i.block ? `${i.block}: ${i.message}` : i.message));
  const missing = missingScopes(ctx, doc);
  return {
    valid: issues.length === 0,
    issues,
    ...(missing.length
      ? { preview: `Not shown: this token lacks ${missing.join(" and ")}.` }
      : { preview: compactResult(runCard(ctx.db, doc, ctx.today)) }),
  };
}

const looseDoc = z
  .looseObject({})
  .describe(
    "The card: { v: 2, metrics?: [...], blocks: [...] }. Read get_card_schema first: it has the exact format, every dataset and function, and worked examples.",
  );

const cardFields = {
  title: z.string().max(60),
  description: z.string().max(200).optional(),
  doc: looseDoc,
};

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Dates look like 2026-11-07");
const AGENT_MADE = (ctx: ToolContext) => `agent:${ctx.agent.tokenId}`;

function logChange(ctx: ToolContext, action: string, entityId: string, details: unknown) {
  audit(ctx.db, {
    actorType: "agent",
    actorId: ctx.agent.tokenId,
    action,
    entityType: "dashboard",
    entityId,
    details,
  });
}

const COMPACT_LOANS = (ctx: ToolContext) =>
  loansReport(ctx.db, ctx.today).loans.map((l) => ({
    name: l.name,
    lender: l.lender,
    kind: l.kind,
    balanceCents: l.balanceCents,
    aprBps: l.aprBps,
    monthlyPaymentCents: l.monthlyPaymentCents,
    minimumPaymentCents: l.minimumPaymentCents,
    nextDueDate: l.nextDueDate,
    paidOffPct: l.paidOffPct,
    interestThisYearCents: l.interestThisYearCents,
    interestRemainingCents: l.interestRemainingCents,
    payoffDate: l.payoffDate,
  }));

const COMPACT_CARDS = (ctx: ToolContext) =>
  cardsReport(ctx.db, ctx.today).cards.map((c) => ({
    name: c.name,
    issuer: c.issuer,
    balanceCents: c.balanceCents,
    creditLimitCents: c.creditLimitCents,
    utilizationPct: c.utilizationPct,
    aprBps: c.aprBps,
    statementBalanceCents: c.statementBalanceCents,
    minimumPaymentCents: c.minimumPaymentCents,
    dueDate: c.dueDate,
    interestThisYearCents: c.interestThisYearCents,
  }));

export const TOOLS: Tool[] = [
  ...PROPOSAL_TOOLS,
  listProposalsTool,
  // --- Summaries
  defineTool({
    name: "get_financial_overview",
    description:
      "This month at a glance: net worth, spending against last month, income, budget, upcoming bills, top categories and merchants, and six months of cash flow. Money is integer cents throughout this API. Start here.",
    scope: "read:summary",
    input: z.object({}),
    run: (ctx) => {
      const o = overview(ctx.db, ctx.today);
      return {
        today: o.today,
        netWorth: o.netWorth,
        spending: {
          monthToDateCents: o.spending.monthToDateCents,
          lastMonthSameDayCents: o.spending.lastMonthSameDayCents,
          lastMonthTotalCents: o.spending.lastMonthTotalCents,
        },
        incomeMonthToDateCents: o.incomeMonthToDateCents,
        incomeExpectedRestOfMonthCents: o.spending.incomeExpectedCents,
        budget: o.budget,
        upcoming: o.upcoming,
        topCategories: o.topCategories,
        topMerchants: o.topMerchants,
        cashFlow: o.cashFlow,
        attention: o.attention,
      };
    },
  }),
  defineTool({
    name: "get_spending_by_category",
    description:
      "Spending between two dates by category, category group or merchant, largest first, with the same number of days before it for comparison. Defaults to this month.",
    scope: "read:summary",
    input: z.object({
      from: isoDate.optional(),
      to: isoDate.optional(),
      by: z.enum(["category", "group", "merchant"]).default("category"),
    }),
    run: (ctx, { from, to, by }) => {
      const start = from ?? `${ctx.today.slice(0, 7)}-01`;
      const end = to ?? ctx.today;
      const days = Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1;
      const shift = (iso: string, n: number) =>
        new Date(Date.parse(iso) + n * 86_400_000).toISOString().slice(0, 10);
      const now = spendingReport(ctx.db, start, end, by);
      const before = spendingReport(ctx.db, shift(start, -days), shift(start, -1), by);
      const prior = new Map(before.items.map((i) => [i.name, i.cents]));
      return {
        from: start,
        to: end,
        totalCents: now.totalCents,
        previousTotalCents: before.totalCents,
        items: now.items.slice(0, 200).map((i) => ({
          name: i.name,
          cents: i.cents,
          previousCents: prior.get(i.name) ?? 0,
        })),
      };
    },
  }),
  defineTool({
    name: "list_subscriptions",
    description:
      "Recurring charges and income: amounts per month and year, latest and next dates, whether they're late or still running, and the latest price change.",
    scope: "read:summary",
    input: z.object({ include_inactive: z.boolean().default(false) }),
    run: (ctx, { include_inactive }) =>
      listSeries(ctx.db, ctx.today)
        .filter((s) => s.status !== "ignored" && (include_inactive || s.active))
        .map((s) => ({
          id: s.id,
          name: s.name,
          kind: s.kind,
          status: s.status,
          interval: s.interval,
          monthlyCents: s.monthlyCents,
          annualCents: s.annualCents,
          lastDate: s.lastDate,
          nextDate: s.nextDate,
          late: s.late,
          category: s.categoryName,
          priceChange: s.priceChange,
          paidThisMonthCents: s.paidThisMonth.cents,
        })),
  }),
  defineTool({
    name: "get_budget_status",
    description:
      "A month's budgets against what's been spent, plus the forecast for the rest of the month. Defaults to this month.",
    scope: "read:summary",
    input: z.object({
      month: z
        .string()
        .regex(/^\d{4}-\d{2}$/)
        .optional(),
    }),
    run: (ctx, { month }) => {
      const b = budgetMonth(ctx.db, month ?? ctx.today.slice(0, 7));
      const line = (l: typeof b.total) => ({
        name: l.name,
        budgetCents: l.budgetCents,
        spentCents: l.spentCents,
        availableCents: l.availableCents,
        averageCents: l.averageCents,
      });
      const total = overallBudget(b);
      return {
        month: b.month,
        total: { ...line(b.total), ...total },
        income: line(b.income),
        bills: line(b.bills),
        uncategorizedCents: b.uncategorizedCents,
        forecast: {
          projectedSpendingCents: b.forecast.projectedSpendingCents,
          projectedIncomeCents: b.forecast.projectedIncomeCents,
          projectedLeftoverCents: b.forecast.projectedLeftoverCents,
          recurringDueCents: b.forecast.recurringDueCents,
        },
        categories: b.groups.flatMap((g) =>
          g.lines
            .filter((l) => l.budgetCents !== null || l.spentCents !== 0)
            .map((l) => ({ group: g.name, ...line(l) })),
        ),
      };
    },
  }),
  defineTool({
    name: "get_savings_ledger",
    description: "Subscriptions cancelled or replaced, and what they've saved so far.",
    scope: "read:summary",
    input: z.object({}),
    run: (ctx) => ({
      summary: savingsSummary(ctx.db, ctx.today),
      items: listSavings(ctx.db, ctx.today).map((s) => ({
        name: s.name,
        kind: s.kind,
        status: s.status,
        monthlyCents: s.monthlyCents,
        realizedCents: s.realizedCents,
        effectiveDate: s.effectiveDate,
      })),
    }),
  }),
  defineTool({
    name: "find_alternatives",
    description:
      "Self-hosted or DIY replacements for the subscriptions you're paying for, from Muny's catalog. Optionally for one service by name.",
    scope: "read:summary",
    input: z.object({ service: z.string().max(100).optional() }),
    run: (ctx, { service }) => {
      const q = service?.toLowerCase();
      return alternativeSuggestions(ctx.db, ctx.today).filter(
        (a) => !q || a.seriesName.toLowerCase().includes(q) || a.service.toLowerCase().includes(q),
      );
    },
  }),

  // --- Accounts
  defineTool({
    name: "list_accounts",
    description:
      "Accounts with their balances. Balances are signed: debts are negative. Last-4 masks only, never full numbers.",
    scope: "read:accounts",
    input: z.object({}),
    run: (ctx) =>
      listAccounts(ctx.db)
        .filter((a) => !a.hidden)
        .map((a) => ({
          name: a.name,
          type: a.type,
          institution: a.institutionName,
          mask: a.mask,
          balanceCents: a.balanceCents,
          currency: a.currency,
          lastTransactionDate: a.lastTransactionDate,
        })),
  }),
  defineTool({
    name: "get_net_worth_history",
    description:
      "Assets, debts and net worth at each month's end. Assets include crypto (cryptoCents). estimated is true where a home, vehicle or similar is between two values you recorded, so its value is worked out rather than recorded.",
    scope: "read:accounts",
    input: z.object({ months: z.number().int().min(1).max(120).default(12) }),
    run: (ctx, { months }) => netWorthReport(ctx.db, netWorthDates(months, ctx.today)),
  }),
  defineTool({
    name: "get_investments_summary",
    description: "Stock and fund positions with value, cost and gain, plus crypto holdings.",
    scope: "read:accounts",
    input: z.object({}),
    run: (ctx) => {
      const s = investSummary(ctx.db, ctx.today);
      // With any cost unknown there's no true total: null, not a misleading partial.
      const complete = s.unknownCostValueCents === 0;
      return {
        valueCents: s.valueCents,
        cashCents: s.cashCents,
        costBasisCents: complete ? s.costBasisCents : null,
        gainCents: complete ? s.gainCents : null,
        knownCostBasisCents: s.costBasisCents,
        knownCostGainCents: s.gainCents,
        unknownCostValueCents: s.unknownCostValueCents,
        incomeLast12Cents: s.incomeLast12Cents,
        positions: s.positions.map((p) => ({
          symbol: p.symbol,
          name: p.name,
          type: p.type,
          quantity: p.quantity,
          valueCents: p.valueCents,
          costBasisCents: p.type === "cash" ? null : p.costBasisCents,
          gainCents: p.type === "cash" ? null : p.gainCents,
        })),
        crypto: DATASET_READERS.crypto_holdings?.(ctx.db, {}, ctx.today)
          .filter((h) => typeof h.value === "number" && h.value > 0)
          .map((h) => ({
            asset: h.asset,
            name: h.name,
            amount: h.amount,
            valueCents: h.value,
            costCents: h.cost,
            gainCents: h.gain,
            change24h: h.change_24h,
            allocation: h.allocation,
          })),
      };
    },
  }),

  // --- Debts
  defineTool({
    name: "get_debts",
    description:
      "Loans and credit cards: balances, rates (aprBps: 649 is 6.49%), payments, due dates, interest and payoff dates.",
    scope: "read:debts",
    input: z.object({}),
    run: (ctx) => ({ loans: COMPACT_LOANS(ctx), cards: COMPACT_CARDS(ctx) }),
  }),

  // --- Transactions
  defineTool({
    name: "search_transactions",
    description:
      "Individual transactions, newest first. amountCents is signed: money out is negative. Filter by text, category, account, dates or size. For totals, get_spending_by_category or query_data are better.",
    scope: "read:transactions",
    input: z.object({
      text: z.string().max(100).optional().describe("Found in the merchant or bank description."),
      category: z.string().max(100).optional(),
      account: z.string().max(100).optional(),
      from: isoDate.optional(),
      to: isoDate.optional(),
      limit: z.number().int().min(1).max(1000).default(100),
      offset: z.number().int().min(0).max(5000).default(0),
    }),
    run: (ctx, { text, category, account, from, to, limit, offset }) => {
      const query: CardQuery = {
        dataset: "transactions",
        raw: true,
        ...(from || to ? { range: { from: from ?? "1900-01-01", to: to ?? ctx.today } } : {}),
        filters: [
          ...(text
            ? [{ field: "merchant_or_description", op: "contains" as const, value: text }]
            : []),
          ...(category ? [{ field: "category", op: "eq" as const, value: category }] : []),
          ...(account ? [{ field: "account", op: "eq" as const, value: account }] : []),
        ],
        dimensions: ["id", "date", "merchant", "category", "account", "pending", "notes"].map(
          (field) => ({
            field,
          }),
        ),
        measures: [{ id: "amountCents", field: "amount", agg: "sum" }],
        limit: Math.min(offset + limit, 2000),
      };
      const out = runCard(
        ctx.db,
        { v: 2, blocks: [{ id: "q", kind: "table", w: 12, query }] },
        ctx.today,
      ).blocks.q;
      if (out?.error) throw new ToolError("invalid", out.error);
      const q = out?.queries[0];
      const ids = q?.columns.map((c) => c.id) ?? [];
      return (q?.rows ?? [])
        .slice(offset)
        .map((row) => Object.fromEntries(ids.map((id, i) => [id, row[i]])));
    },
  }),

  // --- Anything at all, and cards
  defineTool({
    name: "get_card_schema",
    description:
      "Everything about Muny's data and cards: every dataset and field, every formula function, every kind of block, the formula guide, the JSON Schema of a card and worked examples. Holds no financial data. Read this before query_data or building a card.",
    scope: null,
    input: z.object({}),
    run: () => ({
      ...dashboardSchema(),
      datasetPermissions: DATASET_SCOPES,
    }),
  }),
  defineTool({
    name: "query_data",
    description:
      "Ask almost anything: filter, group and calculate over any dataset, with formulas (sum([Spending], [Category] = \"Dining\"), running_sum, pct_of_total and more). It's the same query a card block uses; see get_card_schema for datasets and fields. Reading a dataset takes that dataset's permission. Money comes back as integer cents.",
    scope: null,
    input: z.object({
      query: z
        .looseObject({})
        .describe(
          "{ dataset, range?, filters?, calculated?, dimensions?, measures?, sort?, limit?, raw? }",
        ),
    }),
    run: (ctx, { query }) => {
      const limit = Math.min(Number(query.limit ?? 100) || 100, 1000);
      const doc = parseDoc({
        v: 2,
        blocks: [{ id: "q", kind: "table", w: 12, query: { ...query, limit } }],
      });
      requireRead(ctx, doc);
      const out = runCard(ctx.db, doc, ctx.today).blocks.q;
      if (out?.error) throw new ToolError("invalid", out.error);
      const q = out?.queries[0];
      return {
        columns: q?.columns.map((c) => ({ id: c.id, label: c.label, type: c.type })),
        rows: q?.rows,
        totals: q?.totals,
      };
    },
  }),
  defineTool({
    name: "get_dashboard",
    description:
      "The Overview of the person who made this token: their cards in priority order, sizes arranged by hand, built-in cards, and every custom card with its document.",
    scope: null,
    input: z.object({}),
    run: (ctx) => getDashboard(ctx.db, ctx.agent.userId),
  }),
  defineTool({
    name: "preview_card",
    description:
      "Check a card and see what it comes to, without saving anything. Issues say exactly what's wrong. Numbers only show for data this token may read.",
    scope: null,
    input: z.object({ doc: looseDoc }),
    run: (ctx, { doc }) => previewDoc(ctx, parseDoc(doc)),
  }),
  defineTool({
    name: "create_card",
    description:
      "Make a custom Overview card. With dry_run (the default) it only checks and previews; pass dry_run: false to save it, which also puts it on this person's Overview (place: false to leave it off). Custom cards are shared with the household. Colors come from the theme: don't try to set any.",
    scope: "write:dashboard",
    write: true,
    input: z.object({
      ...cardFields,
      place: z.boolean().default(true),
      dry_run: dryRunField,
    }),
    run: (ctx, { doc, place, dry_run, ...rest }) => {
      const parsed = parseDoc(doc);
      if (dry_run) return { dryRun: true, ...previewDoc(ctx, parsed) };
      const card = createCustomCard(
        ctx.db,
        ctx.agent.userId,
        { ...rest, doc: parsed, createdBy: AGENT_MADE(ctx) },
        place,
      );
      logChange(ctx, "dashboard.card_create", card.id, {
        title: card.title,
        blocks: parsed.blocks.length,
      });
      return { saved: true, id: card.id, ref: `${CUSTOM_PREFIX}${card.id}` };
    },
  }),
  defineTool({
    name: "update_card",
    description:
      "Replace a custom card's title, description and document. dry_run by default. The previous version is kept in the audit log.",
    scope: "write:dashboard",
    write: true,
    input: z.object({ id: z.string().max(64), ...cardFields, dry_run: dryRunField }),
    run: (ctx, { id, doc, dry_run, ...rest }) => {
      const parsed = parseDoc(doc);
      const before = customCard(ctx.db, id);
      if (dry_run) return { dryRun: true, ...previewDoc(ctx, parsed) };
      updateCustomCard(ctx.db, id, {
        ...rest,
        doc: parsed,
        ...(before.basedOn ? { basedOn: before.basedOn } : {}),
        ...(before.createdBy ? { createdBy: before.createdBy } : {}),
      });
      logChange(ctx, "dashboard.card_update", id, {
        title: rest.title,
        previous: { title: before.title, description: before.description, doc: before.doc },
      });
      return { saved: true, id };
    },
  }),
  defineTool({
    name: "delete_card",
    description:
      "Delete a custom card made by an assistant. Cards people made themselves can only be deleted by them, in Muny. dry_run by default.",
    scope: "write:dashboard",
    write: true,
    input: z.object({ id: z.string().max(64), dry_run: dryRunField }),
    run: (ctx, { id, dry_run }) => {
      if (BUILTIN_CARDS.some((c) => c.id === id))
        throw new ToolError(
          "not_allowed",
          `${id} is a built-in card, so it can't be deleted. arrange_dashboard takes it off the Overview.`,
        );
      const card = customCard(ctx.db, id);
      if (!card.createdBy?.startsWith("agent:"))
        throw new ToolError(
          "not_allowed",
          `"${card.title}" was made by a person, so only they can delete it, in Muny.`,
        );
      if (dry_run) return { dryRun: true, wouldDelete: card.title };
      deleteCustomCard(ctx.db, id);
      logChange(ctx, "dashboard.card_delete", id, { title: card.title, previous: card.doc });
      return { saved: true };
    },
  }),
  defineTool({
    name: "arrange_dashboard",
    description:
      'Set which cards are on this person\'s Overview and their priority, and optionally arrange screen sizes by hand. cards: built-in ids and custom:<id> refs, highest priority first. columns: { "1": phone, "2": laptop, "3": wide, "4": ultrawide }, each a list of that many columns of cards; a size left out arranges itself. Leaving columns out keeps them as they are. dry_run by default.',
    scope: "write:dashboard",
    write: true,
    input: LayoutSchema.extend({ dry_run: dryRunField }),
    run: (ctx, { cards, columns, dry_run }) => {
      assertLayout(ctx.db, cards, columns);
      const before = getDashboard(ctx.db, ctx.agent.userId);
      if (dry_run)
        return {
          dryRun: true,
          current: { cards: before.cards, columns: before.columns },
          proposed: { cards, ...(columns ? { columns } : {}) },
          wouldRemove: before.cards.filter((c) => !cards.includes(c)),
          wouldAdd: cards.filter((c) => !before.cards.includes(c)),
          note: "Pass dry_run: false to apply this.",
        };
      const out = saveLayout(ctx.db, ctx.agent.userId, cards, columns);
      logChange(ctx, "dashboard.layout", ctx.agent.userId, {
        previous: { cards: before.cards, columns: before.columns },
      });
      return { saved: true, cards: out.cards, columns: out.columns };
    },
  }),

  // --- Themes
  defineTool({
    name: "list_themes",
    description:
      "Every theme, built in and custom, with colors, and which one this token's person uses. Holds no financial data.",
    scope: null,
    input: z.object({}),
    run: (ctx) => {
      const { selected, custom } = themeState(ctx.db, ctx.agent.userId);
      return { selected, system: SYSTEM_THEME, builtin: BUILTIN_THEMES, custom };
    },
  }),
  defineTool({
    name: "create_theme",
    description: `Make a custom theme: a name, mode ("light" or "dark") and colors as #rrggbb for each of ${THEME_COLOR_KEYS.join(", ")}. dry_run (the default) reports colors that are hard to read. Custom themes are shared with the household; set_theme applies one.`,
    scope: "write:dashboard",
    write: true,
    input: ThemeInputSchema.extend({ dry_run: dryRunField }),
    run: (ctx, { dry_run, ...input }) => {
      const warnings = themeWarnings(input as Pick<Theme, "colors">).map((w) => w.message);
      if (dry_run) return { dryRun: true, warnings };
      const theme = createTheme(ctx.db, input as Omit<Theme, "id">, AGENT_MADE(ctx));
      return { saved: true, id: theme.id, warnings };
    },
  }),
  defineTool({
    name: "update_theme",
    description:
      "Replace a custom theme's name, mode and colors. dry_run by default. Built-in themes can't be changed: copy their colors into a new one.",
    scope: "write:dashboard",
    write: true,
    input: ThemeInputSchema.extend({ id: z.string().max(64), dry_run: dryRunField }),
    run: (ctx, { id, dry_run, ...input }) => {
      const before = listThemes(ctx.db).find((t) => t.id === id);
      if (!before) throw new ToolError("not_found", "There's no custom theme with that id.");
      const warnings = themeWarnings(input as Pick<Theme, "colors">).map((w) => w.message);
      if (dry_run) return { dryRun: true, warnings };
      updateTheme(ctx.db, id, input as Omit<Theme, "id">);
      logChange(ctx, "theme.update", id, { previous: before });
      return { saved: true, id, warnings };
    },
  }),
  defineTool({
    name: "delete_theme",
    description:
      "Delete a custom theme made by an assistant. Themes people made can only be deleted by them. dry_run by default.",
    scope: "write:dashboard",
    write: true,
    input: z.object({ id: z.string().max(64), dry_run: dryRunField }),
    run: (ctx, { id, dry_run }) => {
      const theme = listThemes(ctx.db).find((t) => t.id === id);
      if (!theme) throw new ToolError("not_found", "There's no custom theme with that id.");
      if (!theme.createdBy?.startsWith("agent:"))
        throw new ToolError(
          "not_allowed",
          `"${theme.name}" was made by a person, so only they can delete it, in Muny.`,
        );
      if (dry_run) return { dryRun: true, wouldDelete: theme.name };
      deleteTheme(ctx.db, id);
      logChange(ctx, "theme.delete", id, { previous: theme });
      return { saved: true };
    },
  }),
  defineTool({
    name: "set_theme",
    description:
      'Choose the theme for the person who made this token: a built-in id, a custom id, or "system" to follow their device. Only changes theirs. dry_run by default.',
    scope: "write:dashboard",
    write: true,
    input: z.object({ id: z.string().max(64), dry_run: dryRunField }),
    run: (ctx, { id, dry_run }) => {
      const before = themeState(ctx.db, ctx.agent.userId).selected;
      if (dry_run) return { dryRun: true, current: before, proposed: id };
      selectTheme(ctx.db, ctx.agent.userId, id);
      logChange(ctx, "theme.select", ctx.agent.userId, { previous: before });
      return { saved: true, selected: id };
    },
  }),
];

export const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

/** Kept honest by a test: every dataset has a permission. */
export const unmappedDatasets = () =>
  DATASETS.filter((d) => !DATASET_SCOPES[d.id]).map((d) => d.id);

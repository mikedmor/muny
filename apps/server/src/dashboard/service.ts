import { cleanPayeeName } from "@muny/core";
import { type MunyDb, newId, schema } from "@muny/db";
import {
  BUILTIN_CARDS,
  CARD_PERIOD_LABELS,
  CARD_PERIODS,
  CARD_SOURCE_INFO,
  CARD_SOURCES,
  CARD_VIEWS,
  type CardData,
  type CardPeriod,
  type CardSpec,
  CUSTOM_PREFIX,
  type CustomCard,
  type CustomCardInput,
  type Dashboard,
  type DashboardSchema,
  DEFAULT_DASHBOARD,
  layoutFromSaved,
  MAX_CUSTOM_CARDS,
  MAX_LAYOUT_CARDS,
} from "@muny/shared";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { budgetMonth } from "../budgets/service.js";
import { listAccounts } from "../ledger/accounts.js";
import { localToday } from "../lib/dates.js";
import { badRequest, conflict, notFound } from "../lib/http.js";
import { upcoming } from "../recurring/service.js";
import {
  monthlyReport,
  netWorthDates,
  netWorthReport,
  spendingReport,
} from "../reports/service.js";
import {
  addMonths,
  categoryMeta,
  monthEnd,
  monthlyCategoryTotals,
  TRANSFER_KEY,
} from "../reports/spending.js";

type Db = MunyDb;

// ---------------------------------------------------------------------------
// Definitions: what a custom card may be. Strict, so nothing else gets stored.
// ---------------------------------------------------------------------------

const id = z.string().min(1).max(64);

export const CardSpecSchema = z
  .object({
    source: z.enum(CARD_SOURCES),
    view: z.enum(CARD_VIEWS),
    period: z.enum(CARD_PERIODS).optional(),
    months: z.number().int().min(2).max(36).optional(),
    days: z.number().int().min(1).max(90).optional(),
    limit: z.number().int().min(1).max(50).optional(),
    categoryId: id.optional(),
    accountId: id.optional(),
    search: z.string().trim().min(1).max(100).optional(),
  })
  .strict()
  .superRefine((s, ctx) => {
    const info = CARD_SOURCE_INFO[s.source];
    if (!info.views.includes(s.view))
      ctx.addIssue({
        code: "custom",
        path: ["view"],
        message: `${info.label} can be shown as: ${info.views.join(", ")}`,
      });
    for (const p of [
      "period",
      "months",
      "days",
      "limit",
      "categoryId",
      "accountId",
      "search",
    ] as const)
      if (s[p] !== undefined && !info.params.includes(p))
        ctx.addIssue({
          code: "custom",
          path: [p],
          message: `${info.label} doesn't use ${p}`,
        });
  });

export const CustomCardSchema = z
  .object({
    title: z.string().trim().min(1, "Give the card a title").max(60),
    description: z.string().trim().max(200).optional(),
    spec: CardSpecSchema,
  })
  .strict();

export const LayoutSchema = z
  .object({ cards: z.array(z.string().min(1).max(80)).max(MAX_LAYOUT_CARDS) })
  .strict();

export function dashboardSchema(): DashboardSchema {
  return {
    builtinCards: BUILTIN_CARDS,
    views: CARD_VIEWS,
    periods: CARD_PERIODS,
    sources: CARD_SOURCE_INFO,
    cardJsonSchema: z.toJSONSchema(
      z.object({
        title: z.string().max(60),
        description: z.string().max(200).optional(),
        spec: z.object({
          source: z.enum(CARD_SOURCES),
          view: z.enum(CARD_VIEWS),
          period: z.enum(CARD_PERIODS).optional(),
          months: z.number().int().min(2).max(36).optional(),
          days: z.number().int().min(1).max(90).optional(),
          limit: z.number().int().min(1).max(50).optional(),
          categoryId: z.string().optional(),
          accountId: z.string().optional(),
          search: z.string().max(100).optional(),
        }),
      }),
    ),
  };
}

// ---------------------------------------------------------------------------
// Storage: a layout per person; custom cards shared by the household.
// ---------------------------------------------------------------------------

const CARDS_KEY = "dashboard.cards";
const layoutKey = (userId: string) => `dashboard.layout:${userId}`;

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

export const listCustomCards = (db: Db): CustomCard[] => read<CustomCard[]>(db, CARDS_KEY) ?? [];

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
    customCards: listCustomCards(db),
  };
}

export function saveLayout(db: Db, userId: string, cards: string[]): Dashboard {
  const known = knownCards(db);
  const seen = new Set<string>();
  for (const c of cards) {
    if (!known.has(c)) throw badRequest(`Unknown card: ${c}`);
    if (seen.has(c)) throw badRequest(`A layout can hold ${c} only once`);
    seen.add(c);
  }
  write(db, layoutKey(userId), cards);
  return getDashboard(db, userId);
}

export function resetLayout(db: Db, userId: string): Dashboard {
  db.delete(schema.appSettings)
    .where(eq(schema.appSettings.key, layoutKey(userId)))
    .run();
  return getDashboard(db, userId);
}

/** Create a custom card; with `place`, also add it to this person's Overview. */
export function createCustomCard(
  db: Db,
  userId: string,
  input: CustomCardInput,
  place: boolean,
): CustomCard {
  const cards = listCustomCards(db);
  if (cards.length >= MAX_CUSTOM_CARDS)
    throw conflict(`You can keep up to ${MAX_CUSTOM_CARDS} custom cards; delete one first`);
  const card: CustomCard = { id: newId(), ...input };
  write(db, CARDS_KEY, [...cards, card]);
  // New cards start at the lowest priority.
  if (place)
    saveLayout(db, userId, [...getDashboard(db, userId).cards, `${CUSTOM_PREFIX}${card.id}`]);
  return card;
}

export function updateCustomCard(db: Db, cardId: string, input: CustomCardInput): CustomCard {
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

// ---------------------------------------------------------------------------
// Data: every source returns the same shape, in integer cents.
// ---------------------------------------------------------------------------

/** First and last day of a period, inclusive. */
export function periodRange(period: CardPeriod, today = localToday()) {
  const month = today.slice(0, 7);
  const back = (days: number) => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - days);
    return d.toISOString().slice(0, 10);
  };
  switch (period) {
    case "this_month":
      return { from: `${month}-01`, to: today };
    case "last_month": {
      const m = addMonths(month, -1);
      return { from: `${m}-01`, to: monthEnd(m) };
    }
    case "last_30_days":
      return { from: back(29), to: today };
    case "last_90_days":
      return { from: back(89), to: today };
    case "this_year":
      return { from: `${today.slice(0, 4)}-01-01`, to: today };
    case "last_12_months":
      return { from: `${addMonths(month, -11)}-01`, to: today };
  }
}

const monthLabel = (m: string) =>
  new Date(`${m}-15T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    year: "2-digit",
    timeZone: "UTC",
  });

const DEBT_TYPES = new Set(["credit", "loan"]);

function monthsFor(spec: CardSpec, today: string) {
  const month = today.slice(0, 7);
  return { from: addMonths(month, -((spec.months ?? 6) - 1)), to: month };
}

/** Run a definition. Reads only; nothing here can change data. */
export function runCard(db: Db, spec: CardSpec, today = localToday()): CardData {
  const period = spec.period ?? "this_month";
  const periodName = CARD_PERIOD_LABELS[period];
  const limit = spec.limit ?? 10;
  const one = (totalCents: number, totalLabel: string): CardData => ({
    totalCents,
    totalLabel,
    seriesNames: [totalLabel],
    rows: [],
  });

  switch (spec.source) {
    case "spending_by_category":
    case "spending_by_merchant": {
      const { from, to } = periodRange(period, today);
      const merchants = spec.source === "spending_by_merchant";
      const report = spendingReport(
        db,
        from,
        to,
        merchants ? "merchant" : "category",
        spec.categoryId,
      );
      return {
        totalCents: report.totalCents,
        totalLabel: `Spent · ${periodName}`,
        seriesNames: ["Spent"],
        rows: report.items.slice(0, limit).map((i) => ({
          key: i.id ?? "uncategorized",
          label: i.name,
          values: [i.cents],
        })),
      };
    }
    case "spending_total": {
      const { from, to } = periodRange(period, today);
      // The report filters by category only when grouping by merchant.
      const report = spendingReport(
        db,
        from,
        to,
        spec.categoryId ? "merchant" : "category",
        spec.categoryId,
      );
      return one(report.totalCents, `Spent · ${periodName}`);
    }
    case "income_total": {
      const { from, to } = periodRange(period, today);
      const cats = categoryMeta(db);
      let cents = 0;
      for (const t of monthlyCategoryTotals(db, from, to)) {
        if (t.categoryId === TRANSFER_KEY) continue;
        if (t.categoryId && cats.get(t.categoryId)?.kind === "income") cents += t.cents;
      }
      return one(cents, `Income · ${periodName}`);
    }
    case "spending_by_month":
    case "income_by_month":
    case "cash_flow_by_month": {
      const { from, to } = monthsFor(spec, today);
      const months = monthlyReport(db, from, to).months;
      const spent = (m: (typeof months)[number]) =>
        spec.categoryId ? (m.byCategory[spec.categoryId] ?? 0) : m.spendingCents;
      const rows = months.map((m) => ({
        key: m.month,
        label: monthLabel(m.month),
        values:
          spec.source === "spending_by_month"
            ? [spent(m)]
            : spec.source === "income_by_month"
              ? [m.incomeCents]
              : [m.incomeCents, m.spendingCents],
      }));
      if (spec.source === "cash_flow_by_month")
        return {
          totalCents: months.reduce((s, m) => s + m.incomeCents - m.spendingCents, 0),
          totalLabel: `Left over · ${months.length} months`,
          seriesNames: ["Income", "Spending"],
          rows,
        };
      const income = spec.source === "income_by_month";
      return {
        totalCents: rows.reduce((s, r) => s + (r.values[0] ?? 0), 0),
        totalLabel: `${income ? "Income" : "Spent"} · ${months.length} months`,
        seriesNames: [income ? "Income" : "Spent"],
        rows,
      };
    }
    case "net_worth_by_month": {
      const { points } = netWorthReport(db, netWorthDates((spec.months ?? 12) - 1, today));
      return {
        totalCents: points.at(-1)?.netCents ?? 0,
        totalLabel: "Net worth",
        seriesNames: ["Net worth"],
        rows: points.map((p) => ({
          key: p.date,
          label: monthLabel(p.date.slice(0, 7)),
          values: [p.netCents],
        })),
      };
    }
    case "account_balances": {
      const accounts = listAccounts(db).filter((a) => !a.hidden);
      const signed = (a: (typeof accounts)[number]) =>
        DEBT_TYPES.has(a.type) ? -Math.abs(a.balanceCents) : a.balanceCents;
      return {
        totalCents: accounts
          .filter((a) => !a.excludeFromReports)
          .reduce((s, a) => s + signed(a), 0),
        totalLabel: "Assets minus debts",
        seriesNames: ["Balance"],
        rows: accounts.slice(0, limit).map((a) => ({
          key: a.id,
          label: a.name,
          detail: a.institutionName ?? a.type,
          values: [signed(a)],
        })),
      };
    }
    case "budget_status": {
      const b = budgetMonth(db, today.slice(0, 7));
      const lines = b.groups
        .flatMap((g) => g.lines)
        .filter((l) => l.categoryId && l.budgetCents !== null);
      return {
        totalCents: lines.reduce((s, l) => s + (l.budgetCents ?? 0) - l.spentCents, 0),
        totalLabel: "Left in your budgets",
        seriesNames: ["Spent"],
        rows: lines.slice(0, limit).map((l) => ({
          key: l.categoryId as string,
          label: l.name,
          detail: `of ${((l.budgetCents ?? 0) / 100).toLocaleString("en-US", {
            style: "currency",
            currency: "USD",
          })}`,
          values: [l.spentCents],
        })),
      };
    }
    case "upcoming_charges": {
      const days = spec.days ?? 30;
      const d = new Date(`${today}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + days);
      const list = upcoming(db, today, d.toISOString().slice(0, 10), today);
      return {
        totalCents: list.reduce((s, u) => s + u.amountCents, 0),
        totalLabel: `Expected · next ${days} days`,
        seriesNames: ["Amount"],
        rows: list.slice(0, limit).map((u) => ({
          key: `${u.seriesId}-${u.date}`,
          label: u.name,
          detail: u.date,
          values: [u.amountCents],
        })),
      };
    }
    case "transactions": {
      const t = schema.transactions;
      const p = schema.payees;
      const search = spec.search ? `%${spec.search.replace(/[%_\\]/g, "\\$&")}%` : null;
      const rows = db
        .select({
          id: t.id,
          date: t.postedDate,
          cents: t.amountCents,
          raw: t.rawDescription,
          payee: p.displayName,
          account: schema.accounts.name,
        })
        .from(t)
        .innerJoin(schema.accounts, eq(schema.accounts.id, t.accountId))
        .leftJoin(p, eq(p.id, t.payeeId))
        .where(
          and(
            eq(t.hidden, false),
            isNull(t.fundsTransactionId),
            spec.categoryId ? eq(t.categoryId, spec.categoryId) : undefined,
            spec.accountId ? eq(t.accountId, spec.accountId) : undefined,
            search
              ? or(
                  sql`${t.rawDescription} like ${search} escape '\\'`,
                  sql`${p.displayName} like ${search} escape '\\'`,
                )
              : undefined,
          ),
        )
        .orderBy(desc(t.postedDate), desc(t.id))
        .limit(limit)
        .all();
      return {
        totalCents: rows.reduce((s, r) => s + r.cents, 0),
        totalLabel: `Total of the latest ${rows.length}`,
        seriesNames: ["Amount"],
        rows: rows.map((r) => ({
          key: r.id,
          label: r.payee ?? cleanPayeeName(r.raw) ?? "Transaction",
          detail: `${r.date} · ${r.account}`,
          values: [r.cents],
        })),
      };
    }
  }
}

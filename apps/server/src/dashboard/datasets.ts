import { cleanPayeeName } from "@muny/core";
import { type MunyDb, schema } from "@muny/db";
import { addMonthsToMonth, type DataRow, resolveRange } from "@muny/shared";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { listAssets } from "../assets/service.js";
import { budgetMonth, overallBudget } from "../budgets/service.js";
import { cardsReport } from "../cards/service.js";
import { getCryptoSettings, priceState } from "../crypto/prices.js";
import { cryptoOverview, listWallets } from "../crypto/service.js";
import { investSummary, listInvestTxns } from "../invest/service.js";
import { listAccounts } from "../ledger/accounts.js";
import { loansReport } from "../loans/service.js";
import { listSeries, upcoming } from "../recurring/service.js";
import { cashTrend, netWorthReport } from "../reports/service.js";
import { categoryMeta } from "../reports/spending.js";
import { savingsAccountsReport } from "../savings/accounts.js";
import { bucketsFor } from "../savings/buckets.js";
import { listInfra, listSavings } from "../savings/service.js";
import { listTrials } from "../trials/routes.js";

/**
 * Rows for each dataset in the catalog (@muny/shared). Every row is built field
 * by field, so nothing reaches a card unless it's named here: no passwords,
 * sessions, bank credentials, API keys, encrypted wallet sources or raw provider
 * data. Reads only.
 */

interface Range {
  from?: string;
  to?: string;
}

type Reader = (db: MunyDb, range: Range, today: string) => DataRow[];

const TYPE_GROUPS: Record<string, string> = {
  checking: "Checking",
  cash: "Checking",
  credit: "Credit cards",
  savings: "Savings",
  investment: "Investments",
  loan: "Loans",
  asset: "Property & other",
  other: "Property & other",
};

const DEBT_TYPES = new Set(["credit", "loan"]);
const bps = (v: number | null | undefined) => (v === null || v === undefined ? null : v / 10000);
const share = (v: number | null | undefined) => (v === null || v === undefined ? null : v / 100);

function transactions(db: MunyDb, range: Range): DataRow[] {
  const t = schema.transactions;
  const a = schema.accounts;
  const cats = categoryMeta(db);
  const rows = db
    .select({
      id: t.id,
      date: t.postedDate,
      amount: t.amountCents,
      currency: t.currency,
      raw: t.rawDescription,
      categoryId: t.categoryId,
      notes: t.notes,
      pending: t.pending,
      transferPairId: t.transferPairId,
      fundsTransactionId: t.fundsTransactionId,
      payee: schema.payees.displayName,
      accountId: t.accountId,
      account: a.name,
      accountType: a.type,
      institution: a.institutionName,
      excluded: a.excludeFromReports,
      recurring: schema.recurringSeries.name,
    })
    .from(t)
    .innerJoin(a, eq(a.id, t.accountId))
    .leftJoin(schema.payees, eq(schema.payees.id, t.payeeId))
    .leftJoin(schema.recurringSeries, eq(schema.recurringSeries.id, t.recurringSeriesId))
    .where(
      and(
        eq(t.hidden, false),
        range.from ? gte(t.postedDate, range.from) : undefined,
        range.to ? lte(t.postedDate, range.to) : undefined,
      ),
    )
    .all();

  const splits = new Map<string, { categoryId: string | null; amountCents: number }[]>();
  for (const s of db.select().from(schema.transactionSplits).all()) {
    const list = splits.get(s.transactionId);
    if (list) list.push(s);
    else splits.set(s.transactionId, [s]);
  }
  const tags = new Map<string, string[]>();
  for (const row of db
    .select({ id: schema.transactionTags.transactionId, name: schema.tags.name })
    .from(schema.transactionTags)
    .innerJoin(schema.tags, eq(schema.tags.id, schema.transactionTags.tagId))
    .all()) {
    const list = tags.get(row.id);
    if (list) list.push(row.name);
    else tags.set(row.id, [row.name]);
  }

  const out: DataRow[] = [];
  for (const r of rows) {
    const parts = splits.get(r.id);
    const merchant = r.payee ?? cleanPayeeName(r.raw) ?? r.raw;
    for (const part of parts ?? [{ categoryId: r.categoryId, amountCents: r.amount }]) {
      const meta = part.categoryId ? cats.get(part.categoryId) : undefined;
      const kind = meta?.kind ?? null;
      // The same rules as budgets and reports.
      const reported = !r.excluded && r.accountType !== "loan";
      const pairedUncategorized = !part.categoryId && !!r.transferPairId;
      const isSpending = reported && !pairedUncategorized && (kind === "expense" || !kind);
      const isIncome = reported && kind === "income";
      out.push({
        date: r.date,
        amount: part.amountCents,
        spending: isSpending ? -part.amountCents : 0,
        income: isIncome ? part.amountCents : 0,
        merchant,
        description: r.raw,
        merchant_or_description: `${merchant} ${r.raw}`,
        category: meta?.name ?? "Uncategorized",
        category_id: part.categoryId,
        category_group: meta?.groupName ?? "Uncategorized",
        category_kind: kind,
        is_bill: meta?.isBill ?? false,
        account: r.account,
        account_id: r.accountId,
        account_type: r.accountType,
        institution: r.institution,
        pending: r.pending,
        is_transfer: !!r.transferPairId || kind === "transfer",
        is_funding: !!r.fundsTransactionId,
        is_split: !!parts,
        recurring: r.recurring,
        tags: tags.get(r.id)?.join(", ") ?? null,
        notes: r.notes,
        currency: r.currency,
      });
    }
  }
  return out;
}

const accounts: Reader = (db) =>
  listAccounts(db)
    .filter((a) => !a.hidden)
    .map((a) => {
      const debt = DEBT_TYPES.has(a.type);
      return {
        name: a.name,
        type: a.type,
        type_group: TYPE_GROUPS[a.type] ?? "Property & other",
        institution: a.institutionName,
        mask: a.mask,
        balance: a.balanceCents,
        value: debt ? 0 : a.balanceCents,
        owed: debt ? -a.balanceCents : 0,
        is_debt: debt,
        in_reports: !a.excludeFromReports,
        provider: a.provider,
        transaction_count: a.transactionCount,
        last_transaction: a.lastTransactionDate,
        currency: a.currency,
      };
    });

const balanceHistory: Reader = (db, range) => {
  const s = schema.balanceSnapshots;
  const a = schema.accounts;
  return db
    .select({
      date: s.date,
      account: a.name,
      account_type: a.type,
      balance: s.balanceCents,
      estimated: s.estimated,
    })
    .from(s)
    .innerJoin(a, eq(a.id, s.accountId))
    .where(
      and(
        eq(a.hidden, false),
        range.from ? gte(s.date, range.from) : undefined,
        range.to ? lte(s.date, range.to) : undefined,
      ),
    )
    .all();
};

const netWorth: Reader = (db, range, today) => {
  // Weekly, up to five years, always ending on the range's last day.
  const to = range.to && range.to < today ? range.to : today;
  const from = range.from ?? resolveRange({ last: 60, unit: "months" }, today).from ?? to;
  const dates: string[] = [];
  const d = new Date(`${to}T00:00:00Z`);
  const start = new Date(`${from}T00:00:00Z`);
  while (d >= start && dates.length < 262) {
    dates.unshift(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 7);
  }
  if (!dates.length) return [];
  const { points } = netWorthReport(db, dates);
  const cash = cashTrend(db, dates);
  return points.map((p, i) => ({
    date: p.date,
    assets: p.assetsCents,
    debts: p.debtsCents,
    net: p.netCents,
    cash: cash[i]?.cents ?? 0,
    crypto: p.cryptoCents,
    estimated: p.estimated,
  }));
};

const categories: Reader = (db) =>
  [...categoryMeta(db).values()].map((c) => ({
    name: c.name,
    group: c.groupName,
    kind: c.kind,
    hidden: c.hidden,
    is_bill: c.isBill,
    excluded_from_budget: c.excludeFromBudget,
  }));

/** The months a range covers, this month if it's unset, the latest two years at most. */
function monthsIn(range: Range, today: string): string[] {
  const last = (range.to ?? today).slice(0, 7);
  const first = (range.from ?? today).slice(0, 7);
  const out: string[] = [];
  for (let m = last; m >= first && out.length < 24; m = addMonthsToMonth(m, -1)) out.unshift(m);
  return out;
}

const budgets: Reader = (db, range, today) =>
  monthsIn(range, today).flatMap((month) => {
    const b = budgetMonth(db, month);
    const line = (
      l: typeof b.total,
      lineType: string,
      name: string,
      group: string | null,
    ): DataRow => ({
      month,
      name,
      group,
      line_type: lineType,
      budget: l.budgetCents,
      spent: l.spentCents,
      available: l.availableCents,
      rollover: l.rolloverCents,
      average: l.averageCents,
      has_budget: l.budgetCents !== null,
      is_bill: l.isBill,
    });
    return [
      line({ ...b.total, ...overallBudget(b) }, "total", "Total spending", null),
      line(b.income, "income", "Earnings", null),
      line(b.bills, "bills", "Bills & subscriptions", null),
      line(b.other, "other", "Everything else", null),
      ...b.groups.flatMap((g) => g.lines.map((l) => line(l, "category", l.name, g.name))),
    ];
  });

const budgetForecast: Reader = (db, range, today) =>
  monthsIn(range, today).map((month) => {
    const f = budgetMonth(db, month).forecast;
    return {
      month,
      income_so_far: f.incomeSoFarCents,
      income_expected: f.incomeExpectedCents,
      income_average: f.incomeAverageCents,
      recurring_paid: f.recurringPaidCents,
      recurring_due: f.recurringDueCents,
      projected_spending: f.projectedSpendingCents,
      projected_income: f.projectedIncomeCents,
      projected_leftover: f.projectedLeftoverCents,
    };
  });

const recurring: Reader = (db, _range, today) =>
  listSeries(db, today)
    .filter((s) => s.status !== "ignored")
    .map((s) => ({
      name: s.name,
      kind: s.kind,
      status: s.status,
      interval: s.interval,
      amount: s.expectedAmountCents,
      monthly: s.monthlyCents,
      yearly: s.annualCents,
      last_amount: s.lastAmountCents,
      first_date: s.firstDate,
      last_date: s.lastDate,
      next_date: s.nextDate,
      active: s.active,
      late: s.late,
      pending: !!s.pending,
      paid_this_month: s.paidThisMonth.cents,
      charge_count: s.transactionCount,
      category: s.categoryName,
      account: s.accountName,
      notes: s.notes,
    }));

const upcomingCharges: Reader = (db, range, today) => {
  const from = range.from && range.from > today ? range.from : today;
  const end = new Date(`${today}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 30);
  // A year ahead is as far as a schedule is worth drawing.
  const limit = new Date(`${today}T00:00:00Z`);
  limit.setUTCDate(limit.getUTCDate() + 400);
  const wanted = range.to ?? end.toISOString().slice(0, 10);
  const maxTo = limit.toISOString().slice(0, 10);
  return upcoming(db, from, wanted < maxTo ? wanted : maxTo, today, true).map((u) => ({
    date: u.date,
    name: u.name,
    kind: u.kind,
    amount: u.amountCents,
    account: u.accountName,
    pending: !!u.pending,
  }));
};

const trials: Reader = (db, _range, today) =>
  listTrials(db, today).map((t) => ({
    name: t.name,
    start_date: t.startDate,
    end_date: t.endDate,
    price: t.priceCents,
    interval: t.interval,
    status: t.status,
    days_left: t.daysLeft,
    notes: t.notes,
  }));

const loans: Reader = (db, _range, today) =>
  loansReport(db, today).loans.map((l) => ({
    name: l.name,
    lender: l.lender,
    kind: l.kind,
    balance: l.balanceCents,
    apr: bps(l.aprBps),
    monthly_payment: l.monthlyPaymentCents,
    minimum_payment: l.minimumPaymentCents,
    next_due: l.nextDueDate,
    original: l.originalPrincipalCents,
    start_date: l.originationDate,
    term_months: l.termMonths,
    paid_off: share(l.paidOffPct),
    interest_this_year: l.interestThisYearCents,
    interest_remaining: l.interestRemainingCents,
    payoff_date: l.payoffDate,
    payoff_months: l.payoffMonths,
    last_payment_date: l.lastPayment?.date ?? null,
    last_payment: l.lastPayment?.amountCents ?? null,
    institution: l.institutionName,
  }));

const loanPayments: Reader = (db, _range, today) =>
  loansReport(db, today).loans.flatMap((l) =>
    l.payments.map((p) => ({
      date: p.date,
      loan: l.name,
      lender: l.lender,
      amount: p.amountCents,
      interest: p.interestCents,
      principal: p.principalCents,
      escrow: p.escrowCents,
      from_account: p.fromAccountName,
    })),
  );

const loanHistory: Reader = (db, _range, today) =>
  loansReport(db, today).loans.flatMap((l) =>
    l.history.map((h) => ({
      date: h.date,
      loan: l.name,
      lender: l.lender,
      balance: h.balanceCents,
    })),
  );

const creditCards: Reader = (db, _range, today) =>
  cardsReport(db, today).cards.map((c) => ({
    name: c.name,
    issuer: c.issuer,
    balance: c.balanceCents,
    limit: c.creditLimitCents,
    available: c.availableCents,
    utilization: share(c.utilizationPct),
    apr: bps(c.aprBps),
    statement_balance: c.statementBalanceCents,
    statement_date: c.statementDate,
    minimum_payment: c.minimumPaymentCents,
    due_date: c.dueDate,
    spent_since_statement: c.spentSinceStatementCents,
    interest_this_year: c.interestThisYearCents,
    last_payment_date: c.lastPayment?.date ?? null,
    last_payment: c.lastPayment?.amountCents ?? null,
    institution: c.institutionName,
  }));

const cardHistory: Reader = (db, _range, today) =>
  cardsReport(db, today).cards.flatMap((c) =>
    c.history.map((h) => ({ date: h.date, card: c.name, balance: h.balanceCents })),
  );

const holdings: Reader = (db, _range, today) =>
  investSummary(db, today).positions.flatMap((p) =>
    p.accounts.map((a) => ({
      symbol: p.symbol,
      name: p.name,
      type: p.type,
      account: a.accountName,
      quantity: a.quantity,
      value: a.valueCents,
      cost: a.costBasisCents,
      gain: a.costBasisCents === null ? null : a.valueCents - a.costBasisCents,
    })),
  );

const investmentTransactions: Reader = (db) =>
  listInvestTxns(db, { limit: 100_000 }).map((t) => ({
    date: t.date,
    type: t.type,
    symbol: t.symbol,
    name: t.securityName,
    account: t.accountName,
    quantity: t.quantity,
    amount: t.amountCents,
    fees: t.feesCents,
  }));

function crypto(db: MunyDb) {
  const st = priceState(db);
  return cryptoOverview(db, {
    pricesEnabled: getCryptoSettings(db).pricesEnabled,
    pricesUpdatedAt: st.updatedAt,
    change24h: st.change24h,
    mcap: st.mcap ?? {},
  });
}

const cryptoHoldings: Reader = (db) =>
  crypto(db).holdings.map((h) => ({
    asset: h.asset,
    name: h.name,
    amount: h.amount,
    value: h.valueCents,
    cost: h.costCents,
    gain: h.valueCents !== null && h.costCents !== null ? h.valueCents - h.costCents : null,
    change_24h: share(h.change24hPct),
    allocation: share(h.allocationPct),
  }));

const cryptoHistory: Reader = (db) =>
  crypto(db).history.map((h) => ({ date: h.date, value: h.valueCents, cost: h.costCents }));

const cryptoHistoryByAsset: Reader = (db) => {
  const o = crypto(db);
  return o.historyByAsset.flatMap((series) =>
    o.history.map((h, i) => ({ date: h.date, asset: series.asset, value: series.values[i] ?? 0 })),
  );
};

const cryptoTransactions: Reader = (db, range) => {
  const t = schema.cryptoTxns;
  const startOf = (d: string) => Date.parse(`${d}T00:00:00Z`);
  return db
    .select({
      at: t.at,
      type: t.type,
      label: t.label,
      wallet: schema.cryptoWallets.name,
      sent_asset: t.sentAsset,
      sent_amount: t.sentAmount,
      received_asset: t.receivedAsset,
      received_amount: t.receivedAmount,
      value: t.valueCents,
      fee: t.feeValueCents,
    })
    .from(t)
    .innerJoin(schema.cryptoWallets, eq(schema.cryptoWallets.id, t.walletId))
    .where(
      and(
        range.from ? gte(t.at, startOf(range.from)) : undefined,
        range.to ? lte(t.at, startOf(range.to) + 86_399_999) : undefined,
      ),
    )
    .all()
    .map(({ at, ...r }) => ({ ...r, date: new Date(at).toISOString().slice(0, 10) }));
};

const cryptoWallets: Reader = (db) =>
  listWallets(db).map((w) => ({
    name: w.name,
    kind: w.kind,
    chain: w.chain,
    status: w.status,
    archived: w.archived,
  }));

const savingsAccounts: Reader = (db, _range, today) =>
  savingsAccountsReport(db, today).accounts.map((a) => ({
    name: a.name,
    institution: a.institutionName,
    balance: a.balanceCents,
    apy: bps(a.apyBps),
    earned_apy: bps(a.earnedApyBps),
    interest_30_days: a.interest.last30Cents,
    interest_this_year: a.interest.ytdCents,
    interest_12_months: a.interest.last12Cents,
    interest_all_time: a.interest.allTimeCents,
    average_contribution: a.avgMonthlyContributionCents,
  }));

const savingsMonths: Reader = (db, _range, today) =>
  savingsAccountsReport(db, today).accounts.flatMap((a) =>
    a.months.map((m) => ({
      month: m.month,
      account: a.name,
      balance: m.balanceCents,
      interest: m.interestCents,
      deposits: m.depositsCents,
      withdrawals: m.withdrawalsCents,
    })),
  );

const savingsBuckets: Reader = (db) => {
  const ids = db
    .select({ id: schema.accounts.id, name: schema.accounts.name })
    .from(schema.accounts);
  return ids.all().flatMap((a) =>
    (bucketsFor(db, a.id)?.buckets ?? []).map((b) => ({
      name: b.name,
      account: a.name,
      balance: b.balanceCents,
      goal: b.goalCents,
      monthly_cap: b.monthlyCapCents,
      is_main: b.isMain,
    })),
  );
};

const moneySaved: Reader = (db, _range, today) =>
  listSavings(db, today).map((s) => ({
    name: s.name,
    kind: s.kind,
    status: s.status,
    before: s.beforeMonthlyCents,
    after: s.afterMonthlyCents,
    monthly: s.monthlyCents,
    saved_so_far: s.realizedCents,
    effective_date: s.effectiveDate,
  }));

const assets: Reader = (db) =>
  listAssets(db).map((a) => ({
    name: a.name,
    kind: a.kind,
    value: a.valueCents,
    purchase_price: a.purchasePriceCents,
    purchase_date: a.purchaseDate,
    owed: a.valueCents - a.equityCents,
    equity: a.equityCents,
    gain: a.purchasePriceCents === null ? null : a.valueCents - a.purchasePriceCents,
  }));

const infrastructureCosts: Reader = (db, _range, today) =>
  listInfra(db, today).map((c) => ({
    name: c.name,
    kind: c.kind,
    monthly: c.monthlyCents,
    start_date: c.startDate,
  }));

const documents: Reader = (db) => {
  const d = schema.documents;
  return db
    .select({
      name: d.name,
      kind: d.kind,
      folder: d.folder,
      lender: d.lender,
      documentDate: d.documentDate,
      createdAt: d.createdAt,
      account: schema.accounts.name,
      sizeBytes: d.sizeBytes,
    })
    .from(d)
    .leftJoin(schema.accounts, eq(schema.accounts.id, d.accountId))
    .all()
    .map(({ documentDate, createdAt, sizeBytes, ...r }) => ({
      ...r,
      date: documentDate ?? createdAt.toISOString().slice(0, 10),
      size_kb: Math.ceil(sizeBytes / 1024),
    }));
};

const alerts: Reader = (db, range) => {
  const n = schema.notifications;
  const from = range.from ? new Date(`${range.from}T00:00:00Z`) : undefined;
  return db
    .select({
      title: n.title,
      body: n.body,
      type: n.ruleType,
      severity: n.severity,
      createdAt: n.createdAt,
      readAt: n.readAt,
    })
    .from(n)
    .where(from ? sql`${n.createdAt} >= ${from.getTime()}` : undefined)
    .all()
    .map(({ createdAt, readAt, ...r }) => ({
      ...r,
      date: createdAt.toISOString().slice(0, 10),
      read: !!readAt,
    }));
};

export const DATASET_READERS: Record<string, Reader> = {
  transactions: (db, range) => transactions(db, range),
  accounts,
  balance_history: balanceHistory,
  net_worth: netWorth,
  categories,
  budgets,
  budget_forecast: budgetForecast,
  recurring,
  upcoming: upcomingCharges,
  trials,
  loans,
  loan_payments: loanPayments,
  loan_history: loanHistory,
  credit_cards: creditCards,
  card_history: cardHistory,
  holdings,
  investment_transactions: investmentTransactions,
  crypto_holdings: cryptoHoldings,
  crypto_history: cryptoHistory,
  crypto_history_by_asset: cryptoHistoryByAsset,
  crypto_transactions: cryptoTransactions,
  crypto_wallets: cryptoWallets,
  savings_accounts: savingsAccounts,
  savings_months: savingsMonths,
  savings_buckets: savingsBuckets,
  money_saved: moneySaved,
  assets,
  infrastructure_costs: infrastructureCosts,
  documents,
  alerts,
};

/** What the engine reads through. Unknown datasets simply have no rows. */
export function dataProvider(db: MunyDb, today: string) {
  return (dataset: string, range: Range): DataRow[] =>
    DATASET_READERS[dataset]?.(db, range, today) ?? [];
}

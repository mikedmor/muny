/**
 * Stock taxes (D-088): lots worked out from your trades, realized gains by
 * term, wash sales, holding periods, a reconcile against what brokers report,
 * and 1099-B forms. Money is integer cents; share counts are exact decimal
 * strings. Muny's numbers are estimates (first in, first out); the broker's
 * 1099-B is the official record.
 */
import type { InvestTxn, SecurityKind } from "./invest.js";

/** How an investment account is taxed. */
export const TAX_TREATMENTS = ["taxable", "deferred", "exempt"] as const;
export type TaxTreatment = (typeof TAX_TREATMENTS)[number];

export const TAX_TREATMENT_LABELS: Record<TaxTreatment, string> = {
  taxable: "Taxable",
  deferred: "Tax-deferred",
  exempt: "Tax-free",
};

export const TAX_TREATMENT_HELP: Record<TaxTreatment, string> = {
  taxable: "A regular brokerage account: sales and dividends are taxed each year.",
  deferred:
    "Traditional IRA, 401(k), 403(b) and the like: taxed when you withdraw, not when you sell.",
  exempt: "Roth IRA, Roth 401(k), HSA, 529: no tax on sales or qualified withdrawals.",
};

const EXEMPT = /\b(roth|hsa|health savings|529|coverdell|education savings|tfsa)\b/i;
const DEFERRED =
  /\b(ira|401\s*\(?k\)?|401a|403\s*\(?b\)?|457\s*\(?b\)?|sep|simple|sarsep|keogh|pension|retirement|profit sharing|tsp|thrift savings|rrsp|rrif|lira|lif|annuity|non-taxable)\b/i;

/**
 * A good first guess from the bank sync's account type (Plaid subtype) or the
 * account's name. You can always set it yourself.
 */
export function guessTaxTreatment(subtype: string | null, name: string): TaxTreatment {
  for (const s of [subtype ?? "", name]) {
    if (EXEMPT.test(s)) return "exempt";
    if (DEFERRED.test(s)) return "deferred";
  }
  return "taxable";
}

export type TaxTerm = "short" | "long" | "unknown";

/** Shares bought together, still held (taxable accounts). */
export interface StockLot {
  accountId: string;
  accountName: string;
  /** YYYY-MM-DD bought; null when unknown (shares that arrived by transfer, or before your history). */
  acquired: string | null;
  quantity: string;
  /** Null when the cost isn't known. */
  costCents: number | null;
  /** YYYY-MM-DD it counts as long term from; null when the purchase date is unknown. */
  longFrom: string | null;
}

export interface StockTermPart {
  quantity: string;
  costCents: number;
  valueCents: number | null;
}

/** One security in one taxable account, split by how long it's been held. */
export interface StockTaxAsset {
  accountId: string;
  accountName: string;
  securityId: string;
  symbol: string;
  name: string;
  type: SecurityKind;
  quantity: string;
  price: string | null;
  valueCents: number;
  short: StockTermPart;
  long: StockTermPart;
  /** Shares whose purchase date isn't known. */
  unknown: StockTermPart;
  /** Oldest first. */
  lots: StockLot[];
  /** Some shares have no known cost: gains are uncertain. */
  missingCost: boolean;
  /**
   * You bought it (in any account, IRAs included) in the last 30 days, so
   * selling at a loss before this date (YYYY-MM-DD) would be a wash sale.
   */
  washUntil: string | null;
  /** The most recent purchase behind washUntil. */
  recentBuy: { date: string; accountName: string; treatment: TaxTreatment } | null;
}

/** A sale (one line per holding period), from your trades. */
export interface StockSale {
  /** The sale transaction. */
  txnId: string;
  date: string;
  accountId: string;
  accountName: string;
  securityId: string;
  symbol: string;
  name: string;
  quantity: string;
  proceedsCents: number;
  /** Null when some of the shares have no known cost. */
  costCents: number | null;
  gainCents: number | null;
  term: TaxTerm;
  /** YYYY-MM-DD bought; null when unknown or bought on several dates. */
  acquired: string | null;
  /** Bought on several dates ("Various" on Form 8949). */
  various: boolean;
  /** Loss you can't take yet because you bought the same stock within 30 days (an estimate). */
  washCents: number;
  /** The replacement was bought in an IRA or similar: the loss is lost for good. */
  washInRetirement: boolean;
}

export interface RealizedByTerm {
  short: { profitCents: number; lossCents: number };
  long: { profitCents: number; lossCents: number };
  /** Sales whose holding period isn't known. */
  unknown: { profitCents: number; lossCents: number };
}

export interface StockTaxAccount {
  id: string;
  name: string;
  institutionName: string | null;
  mask: string | null;
  treatment: TaxTreatment;
  /** Muny guessed the treatment (you haven't set it). */
  guessed: boolean;
  /** What the guess would be. */
  guess: TaxTreatment;
  valueCents: number;
}

export interface StockTaxReport {
  year: number;
  /** YYYY-MM-DD the report was worked out for. */
  today: string;
  accounts: StockTaxAccount[];
  /** Realized gains in taxable accounts this year, before wash sale adjustments. */
  realized: RealizedByTerm;
  /** Losses disallowed by wash sales this year (positive cents, an estimate). */
  washCents: number;
  /** This year's sales in taxable accounts, newest first. */
  sales: StockSale[];
  dividendsCents: number;
  interestCents: number;
  /** Dividends this year by ticker, largest first. */
  dividendsBySymbol: { symbol: string; cents: number }[];
  /** What's held in taxable accounts. */
  assets: StockTaxAsset[];
  /** Long-term share of today's value, now and at the start of each of the next 12 months. */
  maturity: { date: string; longPct: number }[];
  /** Value held in tax-deferred and tax-free accounts (left out of all of this). */
  sheltered: { deferredCents: number; exemptCents: number };
  /** Some holdings aren't fully explained by your trades: see Reconcile. */
  needsReconcile: number;
}

/** How a holding's trades compare with what the broker reports. */
export type ReconcileStatus =
  | "ok"
  /** The broker reports more shares than your trades add up to: earlier purchases are missing. */
  | "missing_buys"
  /** Your trades add up to more shares than the broker reports: a sale or transfer is missing. */
  | "missing_sales"
  /** Held, but no trades at all. */
  | "no_trades"
  /** Shares match, but the cost differs from the broker's by more than 1%. */
  | "cost_differs"
  /** Your trades say you still hold some, but the broker reports none. */
  | "closed";

export interface ReconcileRow {
  accountId: string;
  accountName: string;
  treatment: TaxTreatment;
  securityId: string;
  symbol: string;
  name: string;
  /** What the broker reports holding (null when it reports none). */
  heldQuantity: string | null;
  /** What your trades add up to. */
  tradesQuantity: string;
  /** Held minus trades (positive: missing buys). */
  differenceQuantity: string;
  brokerCostCents: number | null;
  tradesCostCents: number | null;
  firstTrade: string | null;
  lastTrade: string | null;
  trades: number;
  /** Some trade shares arrived by transfer, with no cost. */
  unknownCost: boolean;
  status: ReconcileStatus;
}

export interface ReconcileReport {
  rows: ReconcileRow[];
  ok: number;
  problems: number;
}

/** A trade or other activity, as the Transactions page lists it. */
export interface InvestTxnPage {
  items: InvestTxn[];
  total: number;
  offset: number;
  limit: number;
}

/** Form 8949 boxes: A–C short term, D–F long term (covered, not covered, no 1099-B). */
export const FORM_8949_BOXES = ["A", "B", "C", "D", "E", "F"] as const;
export type Form8949Box = (typeof FORM_8949_BOXES)[number];

export const BOX_LABELS: Record<Form8949Box | "?", string> = {
  A: "Short term, cost reported to the IRS (box A)",
  B: "Short term, cost not reported (box B)",
  C: "Short term, no 1099-B (box C)",
  D: "Long term, cost reported to the IRS (box D)",
  E: "Long term, cost not reported (box E)",
  F: "Long term, no 1099-B (box F)",
  "?": "Holding period not known",
};

export const boxTerm = (b: Form8949Box | "?"): TaxTerm =>
  b === "?" ? "unknown" : "ABC".includes(b) ? "short" : "long";

/** One sale as a 1099-B reports it. */
export interface B1099Sale {
  box: Form8949Box | "?";
  /** From the box, else the file's term column, else the dates. */
  term: TaxTerm;
  description: string;
  symbol: string | null;
  quantity: string | null;
  /** YYYY-MM-DD, or null when "Various" or not given. */
  acquired: string | null;
  sold: string | null;
  proceedsCents: number;
  costCents: number | null;
  /** Wash sale loss disallowed (positive). */
  washCents: number;
}

export interface B1099Totals {
  proceedsCents: number;
  costCents: number;
  washCents: number;
  gainCents: number;
  count: number;
}

export type B1099Summary = Partial<Record<Form8949Box | "?", B1099Totals>>;

/** Where a form's totals came from. */
export type B1099SummarySource = "sales" | "read" | "entered" | null;

/** A 1099-B (or a TXF or CSV export of one) for a tax year. */
export interface B1099Doc {
  id: string;
  accountId: string | null;
  accountName: string | null;
  year: number;
  filename: string;
  format: "txf" | "csv" | "pdf" | "image";
  size: number;
  uploadedAt: number;
  /** Sale by sale (TXF and CSV files). */
  saleCount: number;
  summary: B1099Summary;
  summarySource: B1099SummarySource;
  /** Muny's own numbers for the same account and year, by term, to compare. */
  muny: Record<TaxTerm, B1099Totals>;
}

/** Stocks, ETFs and funds in brokerage accounts (D-034). Money is integer cents. */

export const SECURITY_TYPES = [
  "equity",
  "etf",
  "mutual_fund",
  "bond",
  "option",
  "cash",
  "other",
] as const;
export type SecurityKind = (typeof SECURITY_TYPES)[number];

export const SECURITY_TYPE_LABELS: Record<SecurityKind, string> = {
  equity: "Stocks",
  etf: "ETFs",
  mutual_fund: "Mutual funds",
  bond: "Bonds",
  option: "Options",
  cash: "Cash",
  other: "Other",
};

export const INVEST_TXN_TYPES = [
  "buy",
  "sell",
  "dividend",
  "interest",
  "split",
  "transfer_in",
  "transfer_out",
  "deposit",
  "withdrawal",
  "fee",
  "tax",
  "other",
] as const;
export type InvestTxnKind = (typeof INVEST_TXN_TYPES)[number];

export const INVEST_TXN_LABELS: Record<InvestTxnKind, string> = {
  buy: "Buy",
  sell: "Sell",
  dividend: "Dividend",
  interest: "Interest",
  split: "Split",
  transfer_in: "Shares in",
  transfer_out: "Shares out",
  deposit: "Deposit",
  withdrawal: "Withdrawal",
  fee: "Fee",
  tax: "Tax",
  other: "Other",
};

/** Where a holding's cost basis came from: the broker, you, or worked out from trades. */
export type CostSource = "broker" | "entered" | "trades" | null;

/** One security across all accounts (or one account, on its page). */
export interface InvestPosition {
  securityId: string;
  symbol: string;
  name: string;
  type: SecurityKind;
  quantity: string;
  price: string | null;
  valueCents: number;
  /** Null when any account holding it doesn't report cost. */
  costBasisCents: number | null;
  gainCents: number | null;
  accounts: {
    accountId: string;
    accountName: string;
    quantity: string;
    valueCents: number;
    costBasisCents: number | null;
    costSource: CostSource;
  }[];
}

export interface InvestAccount {
  id: string;
  name: string;
  institutionName: string | null;
  mask: string | null;
  valueCents: number;
  cashCents: number;
  costBasisCents: number | null;
  gainCents: number | null;
  holdings: number;
  /** When the holdings were last reported (YYYY-MM-DD), or null if never. */
  asOf: string | null;
  /** Where its holdings come from. */
  source: "plaid" | "import" | "manual" | null;
  provider: string | null;
}

export interface InvestSummary {
  valueCents: number;
  cashCents: number;
  /** Cost of the positions whose cost is known. */
  costBasisCents: number;
  gainCents: number;
  /** Value of positions with no reported cost (left out of the gain). */
  unknownCostValueCents: number;
  accounts: InvestAccount[];
  positions: InvestPosition[];
  allocation: { type: SecurityKind; valueCents: number }[];
  /** Total value over time (from each account's recorded balances). */
  history: { date: string; valueCents: number }[];
  /** Dividends and interest received in the last 12 months. */
  incomeLast12Cents: number;
  /** The history split by the largest holdings (key = securityId), then "other"; adds up to it. */
  historyBySecurity: { key: string; label: string; values: number[] }[];
  /** History before this date is estimated (rebuilt from trades and past closes). */
  estimatedUntil: string | null;
}

export interface InvestBackfillResult {
  accounts: number;
  /** Tickers whose past closes were fetched. */
  tickers: number;
  /** Tickers no price history was found for. */
  missing: string[];
  from: string | null;
  points: number;
}

export interface SecurityPricePoint {
  date: string;
  close: string;
}

export interface InvestTxn {
  id: string;
  accountId: string;
  accountName: string;
  date: string;
  type: InvestTxnKind;
  symbol: string | null;
  securityName: string | null;
  quantity: string | null;
  price: string | null;
  amountCents: number;
  feesCents: number;
  description: string | null;
  source: "plaid" | "import" | "manual";
}

export interface InvestImportAccount {
  ref: string;
  label: string;
  mask: string | null;
  positions: number;
  activity: number;
  valueCents: number;
  /** The existing investment account this most likely is. */
  matchId: string | null;
}

export interface InvestImportPreview {
  broker: string;
  accounts: InvestImportAccount[];
  positions: number;
  activity: number;
  firstDate: string | null;
  lastDate: string | null;
  skipped: number;
}

export interface InvestImportResult {
  accountsCreated: number;
  holdingsUpdated: number;
  added: number;
  duplicates: number;
}

/** A ticker on the watch list (owned or not). Percentages are for display only. */
export interface WatchItem {
  securityId: string;
  symbol: string;
  name: string;
  type: SecurityKind;
  /** Latest close or price (decimal string). */
  price: string | null;
  priceDate: string | null;
  change1dPct: number | null;
  change1mPct: number | null;
  change1yPct: number | null;
  /** About three months of closes, oldest first. */
  spark: number[];
  /** What you hold of it across accounts, if any. */
  ownedValueCents: number | null;
}

/** Opt-in extras on the Stocks page. */
export interface InvestSettings {
  /** Show company logos (fetched once per ticker by the server). */
  logos: boolean;
  /** Show the market overview (index and sector prices from Yahoo Finance). */
  market: boolean;
  /** On a stock's page: live details and recent news from Yahoo Finance. */
  details: boolean;
}

/** A fund or index in the market overview. Prices and percentages are for display only. */
export interface MarketQuote {
  symbol: string;
  name: string;
  price: number;
  change1dPct: number | null;
  change1mPct: number | null;
  change6mPct: number | null;
  changeYtdPct: number | null;
  change1yPct: number | null;
  change5yPct: number | null;
  /** The last year of daily closes (indexes only). */
  series: { date: string; close: number }[];
}

export interface MarketOverview {
  updatedAt: number;
  indexes: MarketQuote[];
  sectors: MarketQuote[];
  /** How many couldn't be loaded this time. */
  failed: number;
}

export interface MarketIntraday {
  symbol: string;
  previousClose: number | null;
  /** Unix ms and price, every 5 minutes today. */
  points: { t: number; close: number }[];
}

/** A news story about a stock (opens on the publisher's site). */
export interface StockNews {
  title: string;
  publisher: string | null;
  url: string;
  /** unix ms */
  publishedAt: number;
}

/** Live details for one ticker, from Yahoo Finance (for display only). */
export interface StockLive {
  /** unix ms */
  updatedAt: number;
  name: string | null;
  exchange: string | null;
  currency: string | null;
  price: number | null;
  previousClose: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  volume: number | null;
  high52w: number | null;
  low52w: number | null;
  change1dPct: number | null;
  change1mPct: number | null;
  change6mPct: number | null;
  changeYtdPct: number | null;
  change1yPct: number | null;
  change5yPct: number | null;
  /** Daily closes, up to five years, oldest first. */
  series: { date: string; close: number }[];
  news: StockNews[];
  /** The news couldn't be loaded this time (the details could). */
  newsFailed: boolean;
}

/** One stock's page: what Muny knows from your own data, and live details if they're on. */
export interface StockPage {
  symbol: string;
  name: string;
  type: SecurityKind | null;
  securityId: string | null;
  watching: boolean;
  /** What you hold of it, across accounts. */
  position: InvestPosition | null;
  /** Your trades, dividends and the like in it, newest first. */
  activity: InvestTxn[];
  /** Daily closes Muny keeps for it (holdings and the watch list), oldest first. */
  history: { date: string; close: number }[];
  /** Live details and news are turned on. */
  liveOn: boolean;
  live: StockLive | null;
  /** Why the live details couldn't be loaded. */
  liveError: string | null;
}

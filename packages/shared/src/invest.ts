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

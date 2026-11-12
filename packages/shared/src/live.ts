/**
 * Live prices and price alerts. Prices here are market quotes for display
 * and alerts only; they never change what an account is worth.
 *
 * Stocks: Yahoo Finance every few minutes during market hours (no key), or
 * Finnhub in real time with your own free key. Crypto: Coinbase's public
 * ticker in real time, for coins it lists. Each is off until turned on, and
 * only symbols are sent.
 */

export type LiveKind = "stock" | "crypto";

/** "stock:AAPL" or "crypto:BTC". */
export type LiveKey = `${LiveKind}:${string}`;

export const liveKey = (kind: LiveKind, symbol: string): LiveKey =>
  `${kind}:${symbol.toUpperCase()}`;

export interface LiveQuote {
  key: LiveKey;
  kind: LiveKind;
  symbol: string;
  price: number;
  /** Stocks: the previous close. Crypto: the price 24 hours ago. */
  previousClose: number | null;
  /** Change from previousClose, in percent. */
  changePct: number | null;
  /** unix ms of the price */
  at: number;
  source: "yahoo" | "finnhub" | "coinbase";
}

export interface LiveSettings {
  /** Stock prices refresh while you look, and stock alerts are checked. */
  stocks: boolean;
  /** Crypto prices come from Coinbase in real time, and crypto alerts are checked. */
  crypto: boolean;
  /** A Finnhub key is stored: stocks are real time. */
  hasFinnhubKey: boolean;
  /** MUNY_SECRET_KEY is set, so a key can be stored. */
  canStoreKey: boolean;
  /** How often stocks refresh from Yahoo right now, in minutes (with no Finnhub key). */
  yahooEveryMinutes: number;
  /** Why the last attempt to get live prices failed, if it did. */
  lastError: string | null;
}

export interface LiveSettingsInput {
  stocks?: boolean;
  crypto?: boolean;
  /** A new key; null removes it; leave it out to keep the stored one. */
  finnhubKey?: string | null;
}

export const PRICE_ALERT_CONDITIONS = [
  "above",
  "below",
  "day_up",
  "day_down",
  "move_up",
  "move_down",
  "high_52w",
  "low_52w",
] as const;
export type PriceAlertCondition = (typeof PRICE_ALERT_CONDITIONS)[number];

export const PRICE_ALERT_LABELS: Record<
  PriceAlertCondition,
  { label: string; unit: "price" | "percent" | null; stocksOnly?: boolean }
> = {
  above: { label: "Price rises to or above", unit: "price" },
  below: { label: "Price falls to or below", unit: "price" },
  day_up: { label: "Up today by at least", unit: "percent" },
  day_down: { label: "Down today by at least", unit: "percent" },
  move_up: { label: "Up since now by at least", unit: "percent" },
  move_down: { label: "Down since now by at least", unit: "percent" },
  high_52w: { label: "Reaches a new 52-week high", unit: null, stocksOnly: true },
  low_52w: { label: "Falls to a new 52-week low", unit: null, stocksOnly: true },
};

export interface PriceAlert {
  id: string;
  kind: LiveKind;
  symbol: string;
  condition: PriceAlertCondition;
  /** A price (above/below) or a percent (the rest); null for 52-week ones. */
  value: number | null;
  /** The price when it was set (for "since now"). */
  basePrice: number | null;
  note: string | null;
  /** Off: it fires once, then turns off. On: at most once a day. */
  repeat: boolean;
  enabled: boolean;
  /** unix ms */
  lastFiredAt: number | null;
  lastFiredPrice: number | null;
  createdAt: number;
}

export interface PriceAlertInput {
  kind: LiveKind;
  symbol: string;
  condition: PriceAlertCondition;
  value?: number | null;
  note?: string | null;
  repeat?: boolean;
  enabled?: boolean;
}

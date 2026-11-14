/**
 * Balance forecast (D-090): where a checking or savings account is headed
 * over the next weeks, from today's balance, what's pending, recurring bills
 * and income, credit card payments, and everyday spending. Money is integer
 * cents; an estimate, not a promise.
 */

export const FORECAST_ACCOUNT_TYPES = ["checking", "savings", "cash"] as const;

export type ForecastItemKind = "income" | "bill" | "subscription" | "card" | "pending";

export interface ForecastItem {
  /** YYYY-MM-DD */
  date: string;
  name: string;
  /** Signed: money out is negative. */
  amountCents: number;
  kind: ForecastItemKind;
  /** The amount is a guess (a card's later payments, from what you usually pay). */
  estimate: boolean;
  /** A recurring series, or the card's account id. */
  ref: string | null;
}

export interface BalanceForecast {
  today: string;
  days: number;
  /** The account forecast (null when there's none to forecast). */
  account: { id: string; name: string; type: string; balanceCents: number } | null;
  /** Accounts that can be forecast. */
  accounts: { id: string; name: string; type: string }[];
  /** Today's balance with pending transactions included. */
  startCents: number;
  pendingCents: number;
  /** Everyday spending a day, from the last 90 days (bills, card payments and one-offs left out). */
  dailySpendCents: number;
  /** End-of-day balance, today first, one per day. */
  points: { date: string; balanceCents: number }[];
  /** Everything scheduled, by date. */
  items: ForecastItem[];
  lowest: { date: string; balanceCents: number };
  /** The account's low-balance alert amount, if it has one. */
  thresholdCents: number | null;
  /** The first day it's expected below the alert amount (or below zero without one). */
  firstBelow: { date: string; balanceCents: number } | null;
  endCents: number;
}

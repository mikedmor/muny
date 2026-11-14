/**
 * Year in review (D-092): a year of your own data told as a story. Money is
 * integer cents; spending is positive. A year still under way covers January
 * through today and compares with the same months the year before.
 */

export interface ReviewItem {
  name: string;
  cents: number;
  /** Same span the year before (null when there's no data then). */
  lastYearCents?: number | null;
  count?: number;
  id?: string | null;
}

export interface YearReview {
  year: number;
  from: string;
  to: string;
  /** The year isn't over yet (it runs January through today). */
  partial: boolean;
  /** Earliest transaction Muny has (the review only knows from there). */
  dataFrom: string | null;
  earnedCents: number;
  spentCents: number;
  /** Earned minus spent. */
  keptCents: number;
  /** Kept as a share of earnings (null without earnings). */
  savingsRatePct: number | null;
  /** The same months last year (null when Muny has nothing then). */
  lastYear: { earnedCents: number; spentCents: number } | null;
  months: { month: string; earnedCents: number; spentCents: number }[];
  /** Cheapest and costliest full months by spending. */
  lightestMonth: { month: string; cents: number } | null;
  heaviestMonth: { month: string; cents: number } | null;
  netWorth: {
    startCents: number | null;
    endCents: number | null;
    /** Debts owed at the start and end (positive). */
    debtStartCents: number | null;
    debtEndCents: number | null;
    points: { date: string; cents: number }[];
  };
  categories: ReviewItem[];
  merchants: ReviewItem[];
  /** The merchant you went to most often. */
  regular: ReviewItem | null;
  biggest: { date: string; name: string; cents: number; category: string | null }[];
  recurring: {
    /** Paid to bills and subscriptions this year. */
    paidCents: number;
    started: { name: string; date: string; monthlyCents: number }[];
    cancelled: { name: string; date: string; monthlyCents: number }[];
    priceIncreases: { name: string; date: string; fromCents: number; toCents: number }[];
  };
  facts: {
    transactions: number;
    /** Days with no spending at all. */
    noSpendDays: number;
    longestNoSpendStreak: number;
    /** The weekday you spend the most on (0 = Sunday). */
    busiestWeekday: number | null;
    biggestDay: { date: string; cents: number } | null;
  };
  investing: {
    dividendsCents: number;
    stockGainsCents: number;
    cryptoGainsCents: number;
  } | null;
}

/**
 * Money helpers. Muny stores every amount as an integer number of minor units
 * (cents) plus an ISO 4217 currency code. Floats never enter the money path:
 * parsing works on the decimal string directly.
 */

/** Integer amount in minor units (e.g. cents). Negative = money out. */
export type Cents = number;

export class MoneyParseError extends Error {
  override name = "MoneyParseError";
}

/** Minor-unit exponent for a currency. Defaults to 2 (USD, EUR, ...). */
export function currencyExponent(currency: string): number {
  switch (currency.toUpperCase()) {
    case "JPY":
    case "KRW":
    case "VND":
    case "CLP":
    case "ISK":
      return 0;
    case "BHD":
    case "KWD":
    case "OMR":
    case "JOD":
    case "TND":
      return 3;
    default:
      return 2;
  }
}

/**
 * Parse a human/bank formatted amount string into integer minor units.
 *
 * Accepts: "1,234.56", "-12.3", "(45.00)" (accounting negative), "$1,000",
 * "12.30-" (trailing minus), "+5", " 0.5 ". Rejects anything with more decimal
 * places than the currency allows, unless `round` is true (half away from zero).
 */
export function parseAmount(
  input: string,
  options: { currency?: string; round?: boolean } = {},
): Cents {
  const exponent = currencyExponent(options.currency ?? "USD");
  let s = input.trim();
  if (s === "") throw new MoneyParseError("Empty amount");

  let negative = false;
  if (s.startsWith("(") && s.endsWith(")")) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  if (s.endsWith("-")) {
    negative = !negative;
    s = s.slice(0, -1).trim();
  }
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1).trim();
  } else if (s.startsWith("+")) {
    s = s.slice(1).trim();
  }
  // Strip currency symbols/codes and thousands separators.
  s = s.replace(/^[A-Za-z$€£¥₹\s]+/, "").replace(/[A-Za-z$€£¥₹\s]+$/, "");
  s = s.replace(/,/g, "");
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1);
  }

  const match = /^(\d*)(?:\.(\d*))?$/.exec(s);
  if (!match || (match[1] === "" && (match[2] ?? "") === "")) {
    throw new MoneyParseError(`Invalid amount: "${input}"`);
  }
  const whole = match[1] || "0";
  let frac = match[2] ?? "";

  let roundUp = false;
  if (frac.length > exponent) {
    if (!options.round) {
      throw new MoneyParseError(`Too many decimal places for amount: "${input}"`);
    }
    roundUp = Number(frac[exponent]) >= 5;
    frac = frac.slice(0, exponent);
  }
  frac = frac.padEnd(exponent, "0");

  let minor = BigInt(whole + frac);
  if (roundUp) minor += 1n;
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new MoneyParseError(`Amount out of range: "${input}"`);
  }
  const value = Number(minor);
  return negative && value !== 0 ? -value : value;
}

/** Format minor units as a plain decimal string, e.g. -123456 -> "-1234.56". */
export function toDecimalString(amount: Cents, currency = "USD"): string {
  assertCents(amount);
  const exponent = currencyExponent(currency);
  const negative = amount < 0;
  const digits = String(Math.abs(amount)).padStart(exponent + 1, "0");
  const whole = exponent === 0 ? digits : digits.slice(0, -exponent);
  const frac = exponent === 0 ? "" : `.${digits.slice(-exponent)}`;
  return `${negative ? "-" : ""}${whole}${frac}`;
}

/** Locale-aware display formatting. Display only; never parse this back. */
export function formatMoney(amount: Cents, currency = "USD", locale = "en-US"): string {
  assertCents(amount);
  const exponent = currencyExponent(currency);
  // Intl accepts decimal strings, which avoids float division.
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  }).format(toDecimalString(amount, currency) as unknown as number);
}

export function assertCents(amount: number): asserts amount is Cents {
  if (!Number.isSafeInteger(amount)) {
    throw new TypeError(`Money amount must be a safe integer of minor units, got ${amount}`);
  }
}

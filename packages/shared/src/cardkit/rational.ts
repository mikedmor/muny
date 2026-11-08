/**
 * Exact fractions, so a card's calculations never touch floats. Money enters as
 * exact dollars (cents / 100) and leaves as rounded integer cents.
 */
export interface Rat {
  n: bigint;
  /** Always positive. */
  d: bigint;
}

const gcd = (a: bigint, b: bigint): bigint => {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y) [x, y] = [y, x % y];
  return x;
};

/** Long chains of division can grow without limit: past this, round to 15 places. */
const MAX_DENOMINATOR = 10n ** 30n;
const ROUND_TO = 10n ** 15n;

/** a / b rounded to the nearest integer, halves away from zero. */
function divRound(a: bigint, b: bigint): bigint {
  const negative = a < 0n !== b < 0n;
  const x = a < 0n ? -a : a;
  const y = b < 0n ? -b : b;
  const q = (x * 2n + y) / (y * 2n);
  return negative ? -q : q;
}

function make(n: bigint, d: bigint): Rat {
  const sign = d < 0n ? -1n : 1n;
  const g = gcd(n, d) || 1n;
  let num = (n * sign) / g;
  let den = (d * sign) / g;
  if (den > MAX_DENOMINATOR) {
    num = divRound(num * ROUND_TO, den);
    den = ROUND_TO;
    const g2 = gcd(num, den) || 1n;
    num /= g2;
    den /= g2;
  }
  return { n: num, d: den };
}

export const rat = (n: bigint | number, d: bigint | number = 1n): Rat => make(BigInt(n), BigInt(d));
export const ZERO = rat(0);
export const ONE = rat(1);

/** Integer cents to exact dollars. */
export const fromCents = (cents: number): Rat => make(BigInt(Math.round(cents)), 100n);

export const add = (a: Rat, b: Rat): Rat => make(a.n * b.d + b.n * a.d, a.d * b.d);
export const sub = (a: Rat, b: Rat): Rat => make(a.n * b.d - b.n * a.d, a.d * b.d);
export const mul = (a: Rat, b: Rat): Rat => make(a.n * b.n, a.d * b.d);
/** Null when dividing by zero. */
export const div = (a: Rat, b: Rat): Rat | null => (b.n === 0n ? null : make(a.n * b.d, a.d * b.n));
export const neg = (a: Rat): Rat => ({ n: -a.n, d: a.d });
export const abs = (a: Rat): Rat => (a.n < 0n ? neg(a) : a);
export const cmp = (a: Rat, b: Rat): number => {
  const x = a.n * b.d;
  const y = b.n * a.d;
  return x < y ? -1 : x > y ? 1 : 0;
};

/** "12.50", "-0.0001", "1e-7": exact for anything a decimal string can say. */
export function fromDecimal(text: string): Rat | null {
  const m = /^\s*([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d{1,3}))?\s*$/.exec(text);
  if (!m || (!m[2] && !m[3])) return null;
  const digits = `${m[2] ?? ""}${m[3] ?? ""}` || "0";
  let value = make(BigInt(digits), 10n ** BigInt((m[3] ?? "").length));
  const exp = Number(m[4] ?? 0);
  if (exp > 0) value = make(value.n * 10n ** BigInt(exp), value.d);
  if (exp < 0) value = make(value.n, value.d * 10n ** BigInt(-exp));
  return m[1] === "-" ? neg(value) : value;
}

/** A plain number from a stored field (rates, counts). */
export const fromNumber = (v: number): Rat | null =>
  Number.isFinite(v) ? fromDecimal(String(v)) : null;

/** Past this many bits a result is nonsense for money, and nested powers could freeze the server. */
const MAX_POW_BITS = 4096;
const bits = (v: bigint) => (v < 0n ? -v : v).toString(16).length * 4;

/** Whole powers only, within reason. */
export function pow(a: Rat, exponent: Rat): Rat | null {
  if (exponent.d !== 1n || exponent.n > 64n || exponent.n < -64n) return null;
  // Checked before computing: pow(pow(pow(1e999, 64), 64), 64) would need ~10^8 digits.
  const e = Number(exponent.n < 0n ? -exponent.n : exponent.n);
  if (Math.max(bits(a.n), bits(a.d)) * e > MAX_POW_BITS) return null;
  if (exponent.n >= 0n) return make(a.n ** exponent.n, a.d ** exponent.n);
  return a.n === 0n ? null : make(a.d ** -exponent.n, a.n ** -exponent.n);
}

/** Round to some decimal places, halves away from zero. */
export function round(a: Rat, places = 0): Rat {
  const scale = 10n ** BigInt(Math.max(0, Math.min(15, Math.floor(places))));
  return make(divRound(a.n * scale, a.d), scale);
}

export function floor(a: Rat): Rat {
  const q = a.n / a.d;
  return rat(a.n < 0n && a.n % a.d !== 0n ? q - 1n : q);
}

export function ceil(a: Rat): Rat {
  const q = a.n / a.d;
  return rat(a.n > 0n && a.n % a.d !== 0n ? q + 1n : q);
}

/** Exact dollars to integer cents. */
export function toCents(a: Rat): number {
  return Number(divRound(a.n * 100n, a.d));
}

/** For display and chart positions only; money goes through toCents. */
export function toNumber(a: Rat): number {
  return Number(divRound(a.n * 10n ** 9n, a.d)) / 1e9;
}

/** Up to six decimal places, without trailing zeros. */
export function ratToString(a: Rat): string {
  const v = round(a, 6);
  const whole = v.n / v.d;
  const rest = v.n - whole * v.d;
  if (rest === 0n) return whole.toString();
  const scaled = ((rest < 0n ? -rest : rest) * 10n ** 6n) / v.d;
  const sign = v.n < 0n && whole === 0n ? "-" : "";
  return `${sign}${whole}.${scaled.toString().padStart(6, "0").replace(/0+$/, "")}`;
}

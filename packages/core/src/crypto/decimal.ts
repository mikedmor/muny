/**
 * Exact decimal arithmetic for crypto quantities.
 *
 * Crypto amounts don't fit integer cents (1 wei = 1e-18 ETH) and must never
 * go through floats. Quantities are kept as decimal strings at rest and as
 * BigInt fixed-point (18 decimal places) while computing. Dollar values are
 * produced as integer cents.
 */

export const SCALE = 18;
const ONE = 10n ** BigInt(SCALE);

/** Parse "1.2345", "-0.5", "1e-8" or "  12 " into fixed-point. Throws on junk. */
export function toFixed(input: string | number | bigint): bigint {
  if (typeof input === "bigint") return input * ONE;
  let s = String(input).trim().replace(/,/g, "");
  if (s === "") return 0n;
  // Scientific notation (some CSVs and APIs use it for tiny amounts).
  const sci = /^([+-]?)(\d+(?:\.\d*)?|\.\d+)[eE]([+-]?\d+)$/.exec(s);
  if (sci) {
    const [, sign, mant = "0", expStr = "0"] = sci;
    const exp = Number(expStr);
    const [i = "0", f = ""] = mant.split(".");
    const digits = `${i}${f}`.replace(/^0+(?=\d)/, "");
    const point = i.length + exp;
    if (point <= 0) s = `${sign}0.${"0".repeat(-point)}${digits}`;
    else if (point >= digits.length) s = `${sign}${digits}${"0".repeat(point - digits.length)}`;
    else s = `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
  }
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[2] === "" && (m[3] ?? "") === "")) throw new Error(`Not a number: ${input}`);
  const [, sign, whole = "0", frac = ""] = m;
  // Round half away from zero past 18 places.
  const kept = frac.slice(0, SCALE).padEnd(SCALE, "0");
  let v = BigInt(whole || "0") * ONE + BigInt(kept || "0");
  if (frac.length > SCALE && Number(frac[SCALE]) >= 5) v += 1n;
  return sign === "-" ? -v : v;
}

/** Fixed-point → canonical decimal string ("1.5", "0.00000001", "-3"). */
export function fromFixed(v: bigint): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = a / ONE;
  const frac = (a % ONE).toString().padStart(SCALE, "0").replace(/0+$/, "");
  return `${neg && a !== 0n ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** Normalize any accepted input to the canonical string form. */
export const normDec = (s: string | number) => fromFixed(toFixed(s));

export const addDec = (a: string, b: string) => fromFixed(toFixed(a) + toFixed(b));
export const subDec = (a: string, b: string) => fromFixed(toFixed(a) - toFixed(b));
export const cmpDec = (a: string, b: string) => {
  const x = toFixed(a);
  const y = toFixed(b);
  return x < y ? -1 : x > y ? 1 : 0;
};
export const isZeroDec = (a: string | null | undefined) => !a || toFixed(a) === 0n;

/** a × b (both fixed-point), rounded half away from zero. */
export function mulFixed(a: bigint, b: bigint): bigint {
  const p = a * b;
  const q = p / ONE;
  const r = p % ONE;
  const half = ONE / 2n;
  if (r >= half) return q + 1n;
  if (r <= -half) return q - 1n;
  return q;
}

/** a ÷ b (both fixed-point), rounded half away from zero. */
export function divFixed(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new Error("Division by zero");
  const n = a * ONE;
  const q = n / b;
  const r = n % b;
  const absB = b < 0n ? -b : b;
  if (2n * (r < 0n ? -r : r) >= absB) return q + (n < 0n !== b < 0n ? -1n : 1n);
  return q;
}

/** Quantity × USD price per unit → integer cents (rounded half away from zero). */
export function valueCents(amount: string, usdPerUnit: string): number {
  const usd = mulFixed(toFixed(amount), toFixed(usdPerUnit)); // fixed-point dollars
  const cents = mulFixed(usd, 100n * ONE); // still fixed-point
  const whole = cents / ONE;
  const r = cents % ONE;
  const rounded = r >= ONE / 2n ? whole + 1n : r <= -(ONE / 2n) ? whole - 1n : whole;
  return Number(rounded);
}

/** Cents ÷ quantity → USD per unit as a decimal string (for cost basis per unit). */
export function perUnit(cents: number, amount: string): string {
  const q = toFixed(amount);
  if (q === 0n) return "0";
  return fromFixed(divFixed(BigInt(cents) * ONE, q * 100n));
}

/** Short display: up to `max` significant decimals, trimmed. */
export function shortDec(s: string, maxDecimals = 8): string {
  const v = toFixed(s);
  const factor = 10n ** BigInt(SCALE - maxDecimals);
  const rounded = ((v >= 0n ? v + factor / 2n : v - factor / 2n) / factor) * factor;
  return fromFixed(rounded);
}

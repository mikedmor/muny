import { describe, expect, it } from "vitest";
import { formatMoney, MoneyParseError, parseAmount, toDecimalString } from "./money.js";

describe("parseAmount", () => {
  it.each([
    ["0", 0],
    ["12", 1200],
    ["12.3", 1230],
    ["12.34", 1234],
    ["-12.34", -1234],
    ["+5", 500],
    [" 1,234.56 ", 123456],
    ["$1,000", 100000],
    ["-$19.99", -1999],
    ["$-19.99", -1999],
    ["(45.00)", -4500],
    ["12.30-", -1230],
    [".5", 50],
    ["0.10", 10],
    ["USD 7.01", 701],
    ["-0.00", 0],
  ])("parses %j -> %d", (input, expected) => {
    expect(parseAmount(input)).toBe(expected);
  });

  it("avoids float rounding errors", () => {
    // 0.1 + 0.2 style problems: 1.15 * 100 === 114.99999999999999 in floats.
    expect(parseAmount("1.15")).toBe(115);
    expect(parseAmount("4.35")).toBe(435);
  });

  it("respects currency exponent", () => {
    expect(parseAmount("1500", { currency: "JPY" })).toBe(1500);
    expect(parseAmount("1.234", { currency: "KWD" })).toBe(1234);
  });

  it("rejects excess precision unless rounding", () => {
    expect(() => parseAmount("1.005")).toThrow(MoneyParseError);
    expect(parseAmount("1.005", { round: true })).toBe(101);
    expect(parseAmount("1.004", { round: true })).toBe(100);
    expect(parseAmount("-1.005", { round: true })).toBe(-101);
  });

  it.each(["", "abc", "1.2.3", "--", "$", "1e5"])("rejects %j", (input) => {
    expect(() => parseAmount(input)).toThrow(MoneyParseError);
  });
});

describe("toDecimalString", () => {
  it.each([
    [0, "0.00"],
    [5, "0.05"],
    [-5, "-0.05"],
    [123456, "1234.56"],
    [-100, "-1.00"],
  ])("%d -> %s", (cents, expected) => {
    expect(toDecimalString(cents)).toBe(expected);
  });

  it("rejects non-integers", () => {
    expect(() => toDecimalString(1.5)).toThrow(TypeError);
  });

  it("round-trips with parseAmount", () => {
    for (const cents of [0, 1, -1, 99, 100, 123456789, -987654321]) {
      expect(parseAmount(toDecimalString(cents))).toBe(cents);
    }
  });
});

describe("formatMoney", () => {
  it("formats USD", () => {
    expect(formatMoney(123456)).toBe("$1,234.56");
    expect(formatMoney(-1999)).toBe("-$19.99");
  });
});

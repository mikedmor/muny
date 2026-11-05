import { describe, expect, it } from "vitest";
import {
  addDec,
  cmpDec,
  fromFixed,
  normDec,
  perUnit,
  shortDec,
  subDec,
  toFixed,
  valueCents,
} from "./decimal.js";

describe("crypto decimals", () => {
  it("round-trips without floats", () => {
    expect(normDec("0.000000000000000001")).toBe("0.000000000000000001");
    expect(normDec("1.50")).toBe("1.5");
    expect(normDec("-0.0")).toBe("0");
    expect(normDec("1,234.5")).toBe("1234.5");
    expect(normDec("1e-8")).toBe("0.00000001");
    expect(normDec("2.5E3")).toBe("2500");
    expect(fromFixed(toFixed("123456789.123456789123456789"))).toBe(
      "123456789.123456789123456789".slice(0, 28),
    );
  });

  it("adds and compares exactly", () => {
    expect(addDec("0.1", "0.2")).toBe("0.3");
    expect(subDec("1", "0.00000001")).toBe("0.99999999");
    expect(cmpDec("0.00009203", "0.0001")).toBe(-1);
  });

  it("values quantities in integer cents", () => {
    expect(valueCents("0.00099203", "80461.28")).toBe(7982); // $79.82
    expect(valueCents("2.18782663", "55.92")).toBe(12234); // $122.343…
    expect(valueCents("1", "0.004")).toBe(0);
    expect(valueCents("1", "0.005")).toBe(1);
    expect(perUnit(80500, "0.5")).toBe("1610");
  });

  it("rejects junk and shortens for display", () => {
    expect(() => toFixed("abc")).toThrow();
    expect(shortDec("0.123456789123", 8)).toBe("0.12345679");
  });
});

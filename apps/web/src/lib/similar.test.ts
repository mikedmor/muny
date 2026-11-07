import { describe, expect, it } from "vitest";
import { similarQuery } from "./similar.js";

describe("similarQuery", () => {
  it("keeps a payee name as is", () => {
    expect(similarQuery("  City  Electric ", true)).toBe("City Electric");
  });

  it("takes the longest run of words without reference numbers", () => {
    expect(similarQuery("ACH DEBIT CITY ELECTRIC 0042 WEB")).toBe("ACH DEBIT CITY ELECTRIC");
    expect(similarQuery("POS 1234 COFFEE SHOP #55")).toBe("COFFEE SHOP");
    // Original spacing kept, so it still matches the description as written.
    expect(similarQuery("CITY  ELECTRIC   PAYMENT 99")).toBe("CITY  ELECTRIC   PAYMENT");
    expect(similarQuery("12/03 STREAMCO MONTHLY")).toBe("STREAMCO MONTHLY");
    expect(similarQuery("ONE TWO THREE FOUR FIVE SIX")).toBe("ONE TWO THREE FOUR FIVE");
    expect(similarQuery("0042")).toBe("0042");
  });
});

import { describe, expect, it } from "vitest";
import { cleanPayeeName } from "./normalize.js";

describe("cleanPayeeName", () => {
  it.each([
    ["POS DEBIT SQ *BLUE BOTTLE COFFEE 0123 OAKLAND CA", "Blue Bottle Coffee"],
    ["ACME CORP PAYROLL PPD ID: 1234567890", "Acme Corp Payroll"],
    ["AMZN Mktp US*2K4L71X02", "Amazon"],
    ["Amazon.com*AB12CD34", "Amazon"],
    ["PAYPAL INST XFER MEALKIT WEB ID: PAYPALSI77", "Mealkit"],
    ["NETFLIX.COM 866-579-7172 CA", "Netflix"],
    ["APPLE.COM/BILL 866-712-7753 CA", "Apple"],
    ["TST* CORNER CAFE AUSTIN TX", "Corner Cafe"],
    ["KROGER #0123 AUSTIN TX", "Kroger"],
    ["CHECKCARD 0105 HARDWARE STORE 4567 DALLAS TX", "Hardware Store"],
    ["PURCHASE AUTHORIZED ON 01/05 LOCAL DINER S123456789 CARD 1234", "Local Diner"],
    ["Online Transfer to SAV ...1234 transaction#: 123", "Transfer"],
    ["Payment Thank You-Mobile", "Card Payment"],
    ["Interest Paid", "Interest"],
    ["SQ *STARBUCKS", "Starbucks"],
    ["GOOGLE *Google Storage", "Google Storage"],
    ["UBER *EATS PENDING", "Uber Eats"],
    ["O'REILLY AUTO PARTS 1234", "O'Reilly Auto Parts"],
    ["CVS/PHARMACY #01234", "CVS"],
  ])("%s -> %s", (raw, expected) => {
    expect(cleanPayeeName(raw)).toBe(expected);
  });

  it("returns null when nothing is left", () => {
    expect(cleanPayeeName("")).toBeNull();
    expect(cleanPayeeName("1234 5678")).toBeNull();
    expect(cleanPayeeName("#")).toBeNull();
  });
});

describe("cleanPayeeName: bank-specific shapes", () => {
  it.each([
    ["ACME INC DIRECT DEP PPD ID: 1234", "Acme Inc"],
    ["ACME INC  DIRECT DEP JOHN,DOE", "Acme Inc"],
    ["BIG BANK CARD PMT PPD ID: 123", "Big Bank Card"],
    ["CARD ISSUER MOBILE PMT", "Card Issuer"],
    ["ONLINE TRANSFER 123 TO SAVINGS ######1234 TRANSACTION #: 1 01/02", "Transfer"],
    ["ONLINE PAYMENT 123 TO AUTO LENDER 01/02", "Auto Lender"],
    ["PURCHASE FROM EXAMPLE.COM | LOCATION: EXAMPLE.COM, CA, US | **1234", "Example"],
    ["SOME BROKER EXT TRNSFR; SOME BROKER: 123 ; JOHN: DOE", "Some Broker"],
    ["PAYPAL INST XFER", "PayPal"],
    ["PAYPAL INST XFER; MEALKIT: 123 ; JOHN: DOE", "Mealkit"],
    ["PAYPAL PURCHASE MEALKIT WEB ID: PAYPALSI77", "Mealkit"],
    ["PAYPAL TRANSFER PPD ID: PAYPALSD11", "PayPal"],
    ["PAYMENT TO PAYPAL CREDIT", "PayPal Credit"],
  ])("%s -> %s", (raw, expected) => {
    expect(cleanPayeeName(raw)).toBe(expected);
  });
});

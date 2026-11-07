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
    ["POS DEBIT WD7 FT. WORTH TX", "WD7"],
    ["WD7 512-555-0142 TX 01/06", "WD7"],
    ["GOOGLE *FI 297KJx g.co/helppay# CA 06/13", "Google Fi"],
    ["REY AZTECA 570-1234 PA 01/07", "Rey Azteca"],
    ["MSI RENTERS 844-788-1234 TX 04/29", "Msi Renters"],
    ["MR FUEL_1234 WACO TX 06/27", "Mr Fuel"],
    ["PIX365 512-946-1234 TX 03/13", "PIX365"],
    ["BWR LAKEVIEW 141 214-1234 TX 03/06", "Bwr Lakeview"],
    ["BP12345BP FO AUSTIN TX 04/11", "BP"],
    ["PILOT_1234 POS PUR RF12345 MI", "Pilot"],
    ["PIZZA PALACE NEW ALBANY IN", "Pizza Palace"],
    ["THE HOME DEPOT #1234 PLANO TX 123456 10/02", "The Home Depot"],
    ["FLYING J #123 MILL HALL, PA, US", "Flying J Mill"],
    ["EINSTEIN BROS BAGELS353 LAS VEGAS NV 01/02", "Einstein Bros"],
    ["TROPICAL SMOOTHIE CAFE 512-1234567 TX 01/02", "Tropical Smoothie Cafe"],
    ["FRISCO TOBACCO &amp; VA POS PUR RF#123456 Frisco TX 1234", "Frisco Tobacco"],
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
    ["POWER CO BILL PAY", "Power Co"],
    ["CITY WATER AUTOPAY 0123", "City Water"],
    [
      "ORIG CO NAME:MORTGAGE BANK CO ENTRY DESCR:MTG SEC:WEB TRACE#:12345 EED:261103 IND ID:999 IND NAME:JOHN DOE",
      "Mortgage Bank",
    ],
    ["Orig Co Name:lender Co Entry Descr:web Pay Sec:web Ind", "Lender"],
    ["ORIG CO NAME:NETFLIX.COM CO ENTRY DESCR:SUBSCRIPT SEC:CCD", "Netflix"],
  ])("%s -> %s", (raw, expected) => {
    expect(cleanPayeeName(raw)).toBe(expected);
  });
});

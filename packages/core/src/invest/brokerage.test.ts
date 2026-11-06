import { describe, expect, it } from "vitest";
import { classifyAction, parseBrokerageCsv } from "./brokerage.js";

// Synthetic exports in each broker's layout (made-up accounts and numbers).

const FIDELITY_HISTORY = `

Run Date,Account,Account Number,Action,Symbol,Description,Type,Quantity,Price ($),Commission ($),Fees ($),Accrued Interest ($),Amount ($),Settlement Date
11/03/2026,Individual,X00001234,YOU BOUGHT VANGUARD TOTAL STOCK MARKET ETF (VTI) (Cash),VTI,VANGUARD TOTAL STOCK MARKET ETF,Cash,2,250.10,,,,-500.20,11/04/2026
10/15/2026,Individual,X00001234,DIVIDEND RECEIVED VANGUARD TOTAL STOCK MARKET ETF (VTI) (Cash),VTI,VANGUARD TOTAL STOCK MARKET ETF,Cash,0.000,,,,,12.34,
10/15/2026,Individual,X00001234,REINVESTMENT VANGUARD TOTAL STOCK MARKET ETF (VTI) (Cash),VTI,VANGUARD TOTAL STOCK MARKET ETF,Cash,0.049,251.80,,,,-12.34,
10/01/2026,Individual,X00001234,YOU SOLD APPLE INC (AAPL) (Cash),AAPL,APPLE INC,Cash,-1,230.00,,0.02,,229.98,10/02/2026
09/30/2026,Individual,X00001234,Electronic Funds Transfer Received (Cash),,No Description,Cash,0.000,,,,,1000,

"The data and information in this spreadsheet is provided to you solely for your use."
"Date downloaded 11/05/2026 10:00 am"
`;

const FIDELITY_POSITIONS = `Account Number,Account Name,Symbol,Description,Quantity,Last Price,Last Price Change,Current Value,Today's Gain/Loss Dollar,Today's Gain/Loss Percent,Total Gain/Loss Dollar,Total Gain/Loss Percent,Percent Of Account,Cost Basis Total,Average Cost Basis,Type
X00001234,Individual,SPAXX**,HELD IN MONEY MARKET,,,,$520.11,,,,,5.2%,,,Cash,
X00001234,Individual,VTI,VANGUARD TOTAL STOCK MARKET ETF,10.049,$251.80,+$1.10,$2530.34,+$11.05,+0.44%,+$30.00,+1.2%,25%,$2500.34,$248.81,Cash,
X00001234,Individual,Pending Activity,,,,,$-10.00,,,,,,,,,

"The data and information in this spreadsheet is provided to you solely for your use."
`;

const ROBINHOOD = `"Activity Date","Process Date","Settle Date","Instrument","Description","Trans Code","Quantity","Price","Amount"
"11/3/2026","11/3/2026","11/4/2026","TSLA","Tesla
CUSIP: 88160R101","Buy","1.5","$200.00","($300.00)"
"10/20/2026","10/20/2026","10/20/2026","TSLA","Cash Div: R/D 2026-10-01 P/D 2026-10-20 - 1.5 shares at 0.1","CDIV","","","$0.15"
"10/01/2026","10/01/2026","10/01/2026","","ACH Deposit","ACH","","","$500.00"
"09/01/2026","09/01/2026","09/01/2026","NVDA","NVIDIA 10:1 split","SPL","9","",""


"","","","","","","","","The data provided is for informational purposes only."
`;

const SCHWAB_POSITIONS = `"Positions for account Individual ...567 as of 10:00 AM ET, 11/05/2026"
""
"Symbol","Description","Qty (Quantity)","Price","Price Chng % (Price Change %)","Mkt Val (Market Value)","Cost Basis","Security Type"
"SCHD","SCHWAB US DIVIDEND EQUITY ETF","20","$28.00","0.5%","$560.00","$500.00","ETFs & Closed End Funds"
"Cash & Cash Investments","--","--","--","--","$1,234.56","--","Cash and Money Market"
"Account Total","--","--","--","--","$1,794.56","$500.00","--"
`;

const SCHWAB_HISTORY = `"Date","Action","Symbol","Description","Quantity","Price","Fees & Comm","Amount"
"11/02/2026","Buy","SCHD","SCHWAB US DIVIDEND EQUITY ETF","10","$28.00","","-$280.00"
"10/30/2026 as of 10/29/2026","Qualified Dividend","SCHD","SCHWAB US DIVIDEND EQUITY ETF","","","","$5.10"
"10/01/2026","Sell","XYZ","XYZ CORP","5","$10.00","$0.05","$49.95"
`;

const VANGUARD = `Account Number,Investment Name,Symbol,Shares,Share Price,Total Value,
12345678,VANGUARD 500 INDEX ADMIRAL,VFIAX,3.5,500.00,1750.00,
12345678,VANGUARD FEDERAL MONEY MARKET INVESTOR,VMFXX,100,1.00,100.00,



Account Number,Trade Date,Settlement Date,Transaction Type,Transaction Description,Investment Name,Symbol,Shares,Share Price,Principal Amount,Commission Fees,Net Amount,Accrued Interest,Account Type,
12345678,2026-10-01,2026-10-02,Buy,Buy,VANGUARD 500 INDEX ADMIRAL,VFIAX,1.0,500.00,-500.00,0.00,-500.00,0.0,CASH,
12345678,2026-09-15,2026-09-15,Dividend,Dividend Received,VANGUARD 500 INDEX ADMIRAL,VFIAX,0.0,1.0,7.00,0.00,7.00,0.0,CASH,
`;

const WEBULL = `Name,Symbol,Side,Status,Filled,Total Qty,Price,Avg Price,Time-in-Force,Placed Time,Filled Time
Apple Inc,AAPL,Buy,Filled,2,2,@210.00,209.50,DAY,11/03/2026 09:30:00 EST,11/03/2026 09:30:01 EST
Apple Inc,AAPL,Sell,Cancelled,0,2,@250.00,,GTC,11/04/2026 09:30:00 EST,
Apple Inc,AAPL,Sell,Filled,1,1,@215.00,215.00,DAY,11/04/2026 10:00:00 EST,11/04/2026 10:00:02 EST
`;

describe("parseBrokerageCsv", () => {
  it("reads Fidelity history around its blank lines and disclaimers", () => {
    const f = parseBrokerageCsv(FIDELITY_HISTORY);
    expect(f.broker).toBe("Fidelity");
    expect(f.accounts).toEqual([{ ref: "X00001234", label: "Individual ••1234", mask: "1234" }]);
    expect(f.activity.map((a) => [a.type, a.symbol, a.quantity, a.amountCents])).toEqual([
      ["buy", "VTI", "2", -50020],
      ["dividend", "VTI", null, 1234],
      ["buy", "VTI", "0.049", -1234],
      ["sell", "AAPL", "1", 22998],
      ["deposit", null, null, 100000],
    ]);
    expect(f.activity[3]?.feesCents).toBe(2);
    expect(f.activity[0]?.date).toBe("2026-11-03");
  });

  it("reads Fidelity positions, money market as cash, skipping pending activity", () => {
    const f = parseBrokerageCsv(FIDELITY_POSITIONS);
    expect(f.positions).toEqual([
      expect.objectContaining({ symbol: "SPAXX", type: "cash", valueCents: 52011 }),
      expect.objectContaining({
        symbol: "VTI",
        quantity: "10.049",
        price: "251.8",
        valueCents: 253034,
        costBasisCents: 250034,
      }),
    ]);
  });

  it("reads Robinhood codes, multi-line descriptions and accounting negatives", () => {
    const f = parseBrokerageCsv(ROBINHOOD);
    expect(f.broker).toBe("Robinhood");
    expect(f.activity.map((a) => [a.type, a.symbol, a.quantity, a.amountCents])).toEqual([
      ["buy", "TSLA", "1.5", -30000],
      ["dividend", "TSLA", null, 15],
      ["deposit", null, null, 50000],
      ["split", "NVDA", "9", 0],
    ]);
  });

  it("reads Schwab positions with the account in the title line", () => {
    const f = parseBrokerageCsv(SCHWAB_POSITIONS);
    expect(f.broker).toBe("Schwab");
    expect(f.accounts[0]?.mask).toBe("567");
    expect(f.positions.map((p) => [p.symbol, p.type, p.valueCents, p.costBasisCents])).toEqual([
      ["SCHD", "etf", 56000, 50000],
      ["CASH", "cash", 123456, 123456],
    ]);
  });

  it("reads Schwab history with fees and 'as of' dates", () => {
    const f = parseBrokerageCsv(SCHWAB_HISTORY);
    expect(f.activity.map((a) => [a.date, a.type, a.amountCents, a.feesCents])).toEqual([
      ["2026-11-02", "buy", -28000, 0],
      ["2026-10-30", "dividend", 510, 0],
      ["2026-10-01", "sell", 4995, 5],
    ]);
  });

  it("reads a Vanguard file with holdings and history in one", () => {
    const f = parseBrokerageCsv(VANGUARD);
    expect(f.broker).toBe("Vanguard");
    expect(f.positions.map((p) => [p.symbol, p.type, p.valueCents])).toEqual([
      ["VFIAX", "mutual_fund", 175000],
      ["VMFXX", "cash", 10000],
    ]);
    expect(f.activity.map((a) => [a.type, a.amountCents])).toEqual([
      ["buy", -50000],
      ["dividend", 700],
    ]);
  });

  it("reads Webull orders, skipping cancelled ones and pricing from the fill", () => {
    const f = parseBrokerageCsv(WEBULL);
    expect(f.broker).toBe("Webull");
    expect(f.activity.map((a) => [a.type, a.quantity, a.price, a.amountCents])).toEqual([
      ["buy", "2", "209.5", -41900],
      ["sell", "1", "215", 21500],
    ]);
  });

  it("gives identical rows distinct ids and the same ids on re-import", () => {
    const twice = `Date,Action,Symbol,Description,Quantity,Price,Fees & Comm,Amount
11/02/2026,Buy,ABC,ABC CO,1,$10.00,,-$10.00
11/02/2026,Buy,ABC,ABC CO,1,$10.00,,-$10.00
`;
    const a = parseBrokerageCsv(twice).activity.map((x) => x.externalId);
    const b = parseBrokerageCsv(twice).activity.map((x) => x.externalId);
    expect(new Set(a).size).toBe(2);
    expect(a).toEqual(b);
  });

  it("rejects files that aren't brokerage exports", () => {
    expect(() => parseBrokerageCsv("Date,Description,Amount\n11/01/2026,Coffee,-4.00\n")).toThrow(
      /brokerage export/,
    );
  });
});

describe("classifyAction", () => {
  it.each([
    ["Qualified Dividend", "", false, 100, "dividend"],
    ["Reinvest Shares", "", true, -100, "buy"],
    ["Bank Interest", "", false, 5, "interest"],
    ["NRA Tax Adj", "", false, -5, "tax"],
    ["MoneyLink Transfer", "", false, -1000, "withdrawal"],
    ["Journaled Shares", "", true, 0, "transfer_in"],
    ["DTAX", "", false, -1, "tax"],
  ] as const)("%s → %s", (action, desc, shares, amount, want) => {
    expect(classifyAction(action, desc, shares, amount)).toBe(want);
  });
});

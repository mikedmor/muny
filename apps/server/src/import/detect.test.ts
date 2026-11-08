import { describe, expect, it } from "vitest";
import { detectImportFile } from "./detect.js";

// Synthetic samples in each provider's layout.

const BANK = `Date,Description,Amount,Type
11/03/2026,CORNER MARKET,-42.10,Debit
11/04/2026,ACME PAYROLL,2450.00,Credit`;

const ROCKET = `Date,Original Date,Account Type,Account Name,Account Number,Institution Name,Name,Custom Name,Amount,Description,Category,Note,Ignored From,Tax Deductible,Transaction Tags
2026-11-03,2026-11-03,Cash,Checking,0101,Sample Bank,CORNER MARKET,,42.10,CORNER MARKET,Groceries,,,,`;

const OFX = `OFXHEADER:100
DATA:OFXSGML
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261103<TRNAMT>-42.10<FITID>1<NAME>CORNER MARKET</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

const BROKER = `Run Date,Account,Account Number,Action,Symbol,Description,Type,Quantity,Price ($),Commission ($),Fees ($),Accrued Interest ($),Amount ($),Settlement Date
11/03/2026,Individual,X00001234,YOU BOUGHT SAMPLE ETF (SMPL) (Cash),SMPL,SAMPLE ETF,Cash,2,250.10,,,,-500.20,11/04/2026`;

const KOINLY = [
  "Date,Type,Tag,Sending Wallet,Sent Amount,Sent Currency,Sent Cost Basis,Receiving Wallet,Received Amount,Received Currency,Received Cost Basis,Fee Amount,Fee Currency,Gain (USD),Net Value (USD),Fee Value (USD),TxSrc,TxDest,TxHash,Description",
  "2025-08-15 09:30:00 UTC,sell,,Demo Exchange,0.1,BTC,4000.00,Demo Exchange,6000.00,USD,,1.00,USD,1999.00,6000.00,1.00,,,,",
].join("\n");

describe("import file detection", () => {
  it("sends each file to the importer that reads it", () => {
    expect(detectImportFile(BANK, "bank.csv").kind).toBe("transactions");
    expect(detectImportFile(ROCKET, "rocket.csv")).toEqual({
      kind: "transactions",
      label: "Rocket Money export",
    });
    expect(detectImportFile(OFX, "bank.ofx").kind).toBe("transactions");
    expect(detectImportFile(BROKER, "history.csv")).toEqual({
      kind: "brokerage",
      label: "Fidelity export",
    });
    expect(detectImportFile(KOINLY, "koinly.csv").kind).toBe("crypto");
  });
});

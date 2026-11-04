import { describe, expect, it } from "vitest";
import { isOfx, parseOfx } from "./ofx.js";

// Synthetic data only.

const SGML = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0<SEVERITY>INFO</STATUS>
<DTSERVER>20260120120000[-5:EST]<LANGUAGE>ENG
<FI><ORG>Example Bank<FID>1234</FI>
</SONRS></SIGNONMSGSRSV1>
<BANKMSGSRSV1><STMTTRNRS><TRNUID>1<STATUS><CODE>0<SEVERITY>INFO</STATUS>
<STMTRS><CURDEF>USD
<BANKACCTFROM><BANKID>000000000<ACCTID>9876543210<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST><DTSTART>20260101<DTEND>20260120
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260105120000[-5:EST]<DTUSER>20260104<TRNAMT>-12.34<FITID>T1<NAME>COFFEE &amp; CO<MEMO>COFFEE &amp; CO DOWNTOWN STORE 42</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260110<TRNAMT>1500.00<FITID>T2<NAME>PAYROLL<MEMO>Direct deposit</STMTTRN>
<STMTTRN><TRNTYPE>CHECK<DTPOSTED>20260111<TRNAMT>-80.00<FITID>T3<CHECKNUM>1001</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>bad<TRNAMT>-1.00<FITID>T4<NAME>X</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL><BALAMT>2345.67<DTASOF>20260120</LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1>
<CREDITCARDMSGSRSV1><CCSTMTTRNRS><TRNUID>2<STATUS><CODE>0<SEVERITY>INFO</STATUS>
<CCSTMTRS><CURDEF>USD<CCACCTFROM><ACCTID>4111222233334444</CCACCTFROM>
<BANKTRANLIST><STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260112<TRNAMT>-9.99<FITID>C1<NAME>STREAMFLIX</STMTTRN></BANKTRANLIST>
<LEDGERBAL><BALAMT>-9.99<DTASOF>20260120</LEDGERBAL>
</CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1>
</OFX>`;

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<?OFX OFXHEADER="200" VERSION="220" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>
<OFX>
  <SIGNONMSGSRSV1><SONRS><FI><ORG>Online Savings</ORG></FI></SONRS></SIGNONMSGSRSV1>
  <BANKMSGSRSV1><STMTTRNRS><STMTRS>
    <CURDEF>USD</CURDEF>
    <BANKACCTFROM><BANKID>1</BANKID><ACCTID>55556666</ACCTID><ACCTTYPE>SAVINGS</ACCTTYPE></BANKACCTFROM>
    <BANKTRANLIST>
      <STMTTRN><TRNTYPE>INT</TRNTYPE><DTPOSTED>20260131</DTPOSTED><TRNAMT>3.21</TRNAMT><FITID>X1</FITID><NAME>Interest</NAME><MEMO></MEMO></STMTTRN>
    </BANKTRANLIST>
    <LEDGERBAL><BALAMT>10003.21</BALAMT><DTASOF>20260131</DTASOF></LEDGERBAL>
  </STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>`;

describe("OFX/QFX", () => {
  it("recognizes OFX", () => {
    expect(isOfx(SGML)).toBe(true);
    expect(isOfx(XML)).toBe(true);
    expect(isOfx("Date,Amount\n")).toBe(false);
  });

  it("parses SGML statements, accounts and balances without keeping full account numbers", () => {
    const r = parseOfx(SGML);
    expect(r.accounts).toEqual([
      {
        key: "ofx-1",
        name: "Example Bank Checking",
        institutionName: "Example Bank",
        mask: "3210",
        type: "checking",
        statementBalance: { cents: 234567, asOf: "2026-01-20" },
      },
      expect.objectContaining({
        key: "ofx-2",
        type: "credit",
        mask: "4444",
        statementBalance: { cents: -999, asOf: "2026-01-20" },
      }),
    ]);
    expect(JSON.stringify(r)).not.toContain("9876543210");
    expect(JSON.stringify(r)).not.toContain("4111222233334444");
  });

  it("parses SGML transactions", () => {
    const r = parseOfx(SGML);
    const [coffee, pay, check, card] = r.transactions;
    expect(coffee).toMatchObject({
      accountKey: "ofx-1",
      postedDate: "2026-01-05",
      authorizedDate: "2026-01-04",
      amountCents: -1234,
      // Full MEMO wins over the truncated NAME it starts with.
      rawDescription: "COFFEE & CO DOWNTOWN STORE 42",
      notes: null,
      providerTxnRef: "T1",
    });
    expect(pay).toMatchObject({ rawDescription: "PAYROLL", notes: "Direct deposit" });
    expect(check).toMatchObject({ rawDescription: "Check #1001", amountCents: -8000 });
    expect(card).toMatchObject({ accountKey: "ofx-2", amountCents: -999 });
    expect(r.errors).toEqual([expect.objectContaining({ message: 'Invalid date "bad"' })]);
  });

  it("parses OFX 2.x XML", () => {
    const r = parseOfx(XML);
    expect(r.accounts[0]).toMatchObject({
      name: "Online Savings",
      type: "savings",
      mask: "6666",
      statementBalance: { cents: 1000321, asOf: "2026-01-31" },
    });
    expect(r.transactions).toEqual([
      expect.objectContaining({
        postedDate: "2026-01-31",
        amountCents: 321,
        rawDescription: "Interest",
      }),
    ]);
  });

  it("reports files without statements", () => {
    expect(parseOfx("<OFX></OFX>").errors[0]?.message).toMatch(/No statements/);
  });
});

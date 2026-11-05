import { describe, expect, it } from "vitest";
import { parseKoinlyCsv } from "./koinly.js";

// Synthetic sample in Koinly's export layout.
const HEADER =
  "Date,Type,Tag,Sending Wallet,Sent Amount,Sent Currency,Sent Cost Basis,Receiving Wallet,Received Amount,Received Currency,Received Cost Basis,Fee Amount,Fee Currency,Gain (USD),Net Value (USD),Fee Value (USD),TxSrc,TxDest,TxHash,Description";
const SAMPLE = [
  "Koinly Transaction History",
  HEADER,
  "2025-10-26 15:00:00 UTC,crypto_deposit,Reward,,,,,Demo Exchange,0.000035,ATOM,0.00,,,,0.00,,,,,staking reward",
  "2025-09-01 12:00:00 UTC,transfer,,Demo Exchange,0.5,ETH,800.00,Hardware ETH,0.499,ETH,,0.001,ETH,,1200.00,2.40,,,0xabc,",
  "2025-08-15 09:30:00 UTC,sell,,Demo Exchange,0.1,BTC,4000.00,Demo Exchange,6000.00,USD,,1.00,USD,1999.00,6000.00,1.00,,,,",
  "2025-07-04 08:00:00 UTC,crypto_withdrawal,Cost,Hardware ETH,0.002,ETH,3.00,,,,,,,0.50,5.00,,,,0xdef,",
  "not-a-date,crypto_deposit,,,,,,Demo Exchange,1,BTC,,,,,1,,,,,",
].join("\n");

describe("Koinly import", () => {
  it("maps deposits, transfers, trades and withdrawals", () => {
    const r = parseKoinlyCsv(SAMPLE);
    expect(r.errors).toEqual([{ line: 7, message: 'Unrecognized date "not-a-date"' }]);
    expect(r.wallets).toEqual([
      { name: "Demo Exchange", kind: "manual" },
      { name: "Hardware ETH", kind: "manual" },
    ]);
    expect(r.txns.map((t) => [t.wallet, t.type, t.label, t.sentAmount, t.receivedAmount])).toEqual([
      ["Demo Exchange", "deposit", "reward", null, "0.000035"],
      ["Demo Exchange", "transfer", null, "0.5", null],
      ["Hardware ETH", "transfer", null, null, "0.499"],
      ["Demo Exchange", "trade", null, "0.1", "6000"],
      ["Hardware ETH", "withdrawal", "cost", "0.002", null],
    ]);
    const [, out, inn, sell] = r.txns;
    expect(out?.transferKey).toBe(inn?.transferKey);
    expect(out?.feeAmount).toBe("0.001");
    expect(inn?.feeAmount).toBeNull();
    expect(sell).toMatchObject({
      importedGainCents: 199_900,
      valueCents: 600_000,
      receivedAsset: "USD",
    });
    expect(r.txns[0]?.at).toBe(Date.UTC(2025, 9, 26, 15, 0, 0));
  });

  it("recognizes exchanges and rejects other files", () => {
    const r = parseKoinlyCsv(
      `${HEADER}\n2025-01-01 00:00:00 UTC,buy,,Coinbase,10,USD,,Coinbase,0.1,ETH,,,,,10,,,,,`,
    );
    expect(r.wallets).toEqual([{ name: "Coinbase", kind: "exchange" }]);
    expect(r.txns[0]?.type).toBe("trade");
    expect(() => parseKoinlyCsv("Date,Description,Amount\n2025-01-01,x,1")).toThrow(/Koinly/);
  });
});

import { describe, expect, it } from "vitest";
import { type BbTx, fromBaseUnits, mapUtxoTx } from "./blockbook.js";
import { CHAINS, sourceHint } from "./chains.js";

// Synthetic transactions in Blockbook API v2 shape.
const T = 1_700_000_000;
const ME = "0x1111111111111111111111111111111111111111";

describe("blockbook mapping", () => {
  it("converts smallest units exactly", () => {
    expect(fromBaseUnits("12345", 8)).toBe("0.00012345");
    expect(fromBaseUnits("1000000000000000000", 18)).toBe("1");
    expect(fromBaseUnits("1", 18)).toBe("0.000000000000000001");
    expect(fromBaseUnits(undefined, 8)).toBe("0");
  });

  it("maps a UTXO deposit, a payment with change, and skips unconfirmed", () => {
    const deposit: BbTx = {
      txid: "a1",
      blockHeight: 800_000,
      blockTime: T,
      fees: "500",
      vin: [{ value: "100000", isOwn: false }],
      vout: [
        { value: "60000", isOwn: true },
        { value: "39500", isOwn: false },
      ],
    };
    expect(mapUtxoTx(deposit, "BTC", 8)).toMatchObject({
      type: "deposit",
      receivedAsset: "BTC",
      receivedAmount: "0.0006",
      feeAmount: null,
      at: T * 1000,
      externalId: "bb:a1",
    });
    const pay: BbTx = {
      txid: "b2",
      blockHeight: 800_001,
      blockTime: T,
      fees: "1000",
      vin: [{ value: "60000", isOwn: true }],
      vout: [
        { value: "20000", isOwn: false },
        { value: "39000", isOwn: true }, // change
      ],
    };
    expect(mapUtxoTx(pay, "BTC", 8)).toMatchObject({
      type: "withdrawal",
      sentAmount: "0.0002",
      feeAsset: "BTC",
      feeAmount: "0.00001",
    });
    expect(mapUtxoTx({ ...pay, blockHeight: -1 }, "BTC", 8)).toBeNull();
    // Single address (no isOwn): compare addresses.
    const plain: BbTx = {
      txid: "c3",
      blockHeight: 1,
      blockTime: T,
      fees: "0",
      vin: [{ addresses: ["Dother"], value: "500000000" }],
      vout: [{ addresses: ["Dmine"], value: "500000000" }],
    };
    expect(mapUtxoTx(plain, "DOGE", 8, (a) => a === "Dmine")).toMatchObject({
      type: "deposit",
      receivedAmount: "5",
    });
  });

  it("validates sources per chain and hides most of them", () => {
    expect(CHAINS.eth.validate(ME)).toBe(true);
    expect(CHAINS.eth.validate("0x123")).toBe(false);
    expect(CHAINS.btc.validate("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4")).toBe(true);
    expect(
      CHAINS.btc.validate(
        "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs",
      ),
    ).toBe(true);
    expect(CHAINS.zec.validate("t1Rv4exT7bqhZqi2j7xz8bUHDMxwosrjADU")).toBe(true);
    expect(sourceHint("zpub6rFR7y4Q2AijBEqTUquhVz398ht")).toBe("zpub6r…398ht");
  });
});

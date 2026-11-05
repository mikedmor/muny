import { describe, expect, it } from "vitest";
import { mapEvmHistory, plausibleSymbol } from "./evm.js";

// Synthetic history in the Etherscan-compatible format. No real addresses.
const ME = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const ROUTER = "0x3333333333333333333333333333333333333333";
const ETH = { asset: "ETH", decimals: 18 };
const T = "1700000000";

describe("EVM history mapping", () => {
  it("maps receives, sends with gas, swaps, internal transfers and failed calls", () => {
    const { txns, maxBlock } = mapEvmHistory(ME.toUpperCase().replace("0X", "0x"), ETH, {
      txs: [
        // Received 1 ETH (sender pays gas).
        {
          hash: "0xa",
          blockNumber: "10",
          timeStamp: T,
          from: OTHER,
          to: ME,
          value: "1000000000000000000",
          gasUsed: "21000",
          gasPrice: "1000000000",
        },
        // Sent 0.25 ETH; gas 21000 × 10 gwei = 0.00021 ETH.
        {
          hash: "0xb",
          blockNumber: "11",
          timeStamp: T,
          from: ME,
          to: OTHER,
          value: "250000000000000000",
          gasUsed: "21000",
          gasPrice: "10000000000",
        },
        // Swap: 100 USDC → ETH (ETH arrives as an internal transfer).
        {
          hash: "0xc",
          blockNumber: "12",
          timeStamp: T,
          from: ME,
          to: ROUTER,
          value: "0",
          gasUsed: "100000",
          gasPrice: "10000000000",
        },
        // Failed call: only gas.
        {
          hash: "0xd",
          blockNumber: "13",
          timeStamp: T,
          from: ME,
          to: ROUTER,
          value: "5",
          gasUsed: "50000",
          gasPrice: "10000000000",
          isError: "1",
        },
      ],
      internals: [
        {
          transactionHash: "0xc",
          blockNumber: "12",
          timeStamp: T,
          from: ROUTER,
          to: ME,
          value: "40000000000000000",
        },
      ],
      tokens: [
        {
          hash: "0xc",
          blockNumber: "12",
          timeStamp: T,
          from: ME,
          to: ROUTER,
          value: "100000000",
          tokenSymbol: "USDC",
          tokenDecimal: "6",
        },
        // Airdropped spam: ignored.
        {
          hash: "0xe",
          blockNumber: "14",
          timeStamp: T,
          from: OTHER,
          to: ME,
          value: "1",
          tokenSymbol: "Visit claim-now.example",
          tokenDecimal: "0",
        },
        // A token received from someone else's transaction: no fee for us.
        {
          hash: "0xf",
          blockNumber: "15",
          timeStamp: T,
          from: OTHER,
          to: ME,
          value: "5000000000000000000",
          tokenSymbol: "dai",
          tokenDecimal: "18",
        },
      ],
    });
    expect(maxBlock).toBe(15);
    const by = Object.fromEntries(txns.map((t) => [t.externalId, t]));
    expect(by["evm:0xa"]).toMatchObject({
      type: "deposit",
      receivedAsset: "ETH",
      receivedAmount: "1",
      feeAmount: null,
    });
    expect(by["evm:0xb"]).toMatchObject({
      type: "withdrawal",
      sentAmount: "0.25",
      feeAsset: "ETH",
      feeAmount: "0.00021",
    });
    expect(by["evm:0xc"]).toMatchObject({
      type: "trade",
      sentAsset: "USDC",
      sentAmount: "100",
      receivedAsset: "ETH",
      receivedAmount: "0.04",
      feeAmount: "0.001",
    });
    expect(by["evm:0xd"]).toMatchObject({
      type: "withdrawal",
      sentAmount: null,
      feeAmount: "0.0005",
    });
    expect(by["evm:0xe"]).toBeUndefined();
    expect(by["evm:0xf"]).toMatchObject({
      type: "deposit",
      receivedAsset: "DAI",
      receivedAmount: "5",
      feeAmount: null,
    });
  });

  it("splits multi-asset transactions with the fee on the first row only", () => {
    const { txns } = mapEvmHistory(ME, ETH, {
      txs: [
        {
          hash: "0x1",
          blockNumber: "1",
          timeStamp: T,
          from: ME,
          to: ROUTER,
          value: "0",
          gasUsed: "1",
          gasPrice: "1",
        },
      ],
      internals: [],
      tokens: [
        {
          hash: "0x1",
          blockNumber: "1",
          timeStamp: T,
          from: ROUTER,
          to: ME,
          value: "1",
          tokenSymbol: "AAA",
          tokenDecimal: "0",
        },
        {
          hash: "0x1",
          blockNumber: "1",
          timeStamp: T,
          from: ROUTER,
          to: ME,
          value: "2",
          tokenSymbol: "BBB",
          tokenDecimal: "0",
        },
      ],
    });
    expect(txns.map((t) => [t.externalId, t.receivedAsset, t.feeAmount])).toEqual([
      ["evm:0x1", "AAA", "0.000000000000000001"],
      ["evm:0x1:1", "BBB", null],
    ]);
  });

  it("keeps plain tickers only", () => {
    expect(plausibleSymbol(" usdc ")).toBe("USDC");
    expect(plausibleSymbol("WETH.e")).toBe("WETH.E");
    expect(plausibleSymbol("$ Claim reward at x.io")).toBeNull();
    expect(plausibleSymbol("")).toBeNull();
  });
});

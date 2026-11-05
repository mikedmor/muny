import { CHAINS, type ChainKey } from "@muny/core";
import { openDb } from "@muny/db";
import { describe, expect, it } from "vitest";
import { blockcypher } from "./blockcypher.js";
import { cosmos } from "./cosmos.js";
import { type Adapter, type Cursor, makeCtx } from "./ctx.js";
import { esplora } from "./esplora.js";
import { tron } from "./tron.js";

// Synthetic accounts and responses (plus public BIP test vectors). No network.

type Route = (url: URL) => unknown;

function run(adapter: Adapter, chain: ChainKey, source: string, route: Route, cursor?: Cursor) {
  const urls: string[] = [];
  const f = (async (u: string) => {
    urls.push(u);
    const out = route(new URL(u));
    return out === undefined ? new Response("nf", { status: 404 }) : Response.json(out);
  }) as unknown as typeof fetch;
  const ctx = makeCtx(
    {
      db: openDb({ filename: ":memory:" }),
      chain: CHAINS[chain],
      source,
      cursor: cursor ?? null,
      override: "",
      deps: { secretKey: undefined, fetch: f, delayMs: 0 },
    },
    "esplora",
  );
  return { result: adapter(ctx), urls };
}

const byId = <T extends { externalId: string }>(xs: T[]) =>
  Object.fromEntries(xs.map((x) => [x.externalId, x]));

describe("Bitcoin (mempool.space) with an extended public key", () => {
  // Public BIP84 test vector; its first receive address is FIRST.
  const ZPUB =
    "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";
  const FIRST = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
  const route: Route = (u) => {
    const m = /^\/api\/address\/([^/]+)(\/txs\/chain.*)?$/.exec(u.pathname);
    if (!m) return undefined;
    const used = m[1] === FIRST;
    if (!m[2])
      return {
        chain_stats: used
          ? { funded_txo_sum: 50_000, spent_txo_sum: 0, tx_count: 1 }
          : { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0 },
      };
    return used
      ? [
          {
            txid: "tx1",
            fee: 200,
            status: { confirmed: true, block_height: 800_000, block_time: 1_700_000_000 },
            vin: [{ prevout: { scriptpubkey_address: "bc1qsomeoneelse", value: 80_200 } }],
            vout: [
              { scriptpubkey_address: FIRST, value: 50_000 },
              { scriptpubkey_address: "bc1qsomeoneelse", value: 30_000 },
            ],
          },
        ]
      : [];
  };

  it("scans addresses locally, maps transactions, and skips unchanged addresses next time", async () => {
    const first = run(esplora, "btc", ZPUB, route);
    const r = await first.result;
    expect(r.mapped).toEqual([
      expect.objectContaining({ type: "deposit", receivedAsset: "BTC", receivedAmount: "0.0005" }),
    ]);
    expect(r.balances).toEqual([{ asset: "BTC", amount: "0.0005" }]);
    // 21 receive (1 used + 20 unused) + 20 change lookups, then 1 page of transactions.
    expect(first.urls.filter((u) => !u.includes("/txs/")).length).toBe(41);
    expect(first.urls.some((u) => u.includes(ZPUB))).toBe(false); // the key never leaves
    expect(r.pos).toEqual({ "0/0": 1 });

    const again = run(esplora, "btc", ZPUB, route, { height: r.height, balances: [], pos: r.pos });
    await again.result;
    expect(again.urls.some((u) => u.includes("/txs/"))).toBe(false);
  });
});

describe("Dogecoin (BlockCypher)", () => {
  const ME = `D${"a".repeat(33)}`;
  it("maps transactions with fees and remembers counts", async () => {
    const { result, urls } = run(blockcypher, "doge", ME, (u) => {
      if (u.pathname.endsWith("/balance")) return { n_tx: 2, final_balance: 14_999_000_000 };
      if (u.pathname.endsWith("/full"))
        return {
          hasMore: false,
          txs: [
            {
              hash: "d2",
              block_height: 20,
              confirmed: "2021-05-02T10:00:00Z",
              fees: 1_000_000,
              inputs: [{ addresses: [ME], output_value: 20_000_000_000 }],
              outputs: [
                { addresses: ["Dother"], value: 5_000_000_000 },
                { addresses: [ME], value: 14_999_000_000 },
              ],
            },
            {
              hash: "d1",
              block_height: 10,
              confirmed: "2021-05-01T10:00:00Z",
              fees: 1_000_000,
              inputs: [{ addresses: ["Dother"], output_value: 20_001_000_000 }],
              outputs: [{ addresses: [ME], value: 20_000_000_000 }],
            },
          ],
        };
      return undefined;
    });
    const r = await result;
    const t = byId(r.mapped);
    expect(t["bb:d1"]).toMatchObject({ type: "deposit", receivedAmount: "200" });
    expect(t["bb:d2"]).toMatchObject({ type: "withdrawal", sentAmount: "50", feeAmount: "0.01" });
    expect(t["bb:d1"]?.at).toBe(Date.UTC(2021, 4, 1, 10));
    expect(r.balances).toEqual([{ asset: "DOGE", amount: "149.99" }]);
    expect(r.pos).toEqual({ a: 2 });
    expect(urls[0]).toContain("api.blockcypher.com/v1/doge/main/addrs/");
  });
});

describe("Cosmos Hub", () => {
  const ME = `cosmos1${"q".repeat(38)}`;
  const OTHER = `cosmos1${"p".repeat(38)}`;
  const BONDED = "cosmos1fl48vsnmsdzcv85q5d2q4z5ajdha8yu34mf0eh";
  const DIST = "cosmos1jv65s3grqf6v6jl3dp4t6c9t9rk99cd88lyufl";
  const FEES = "cosmos17xpfvakm2amg962yls6f84z3kell8c5lserqta";
  const transfer = (sender: string, recipient: string, amount: string) => ({
    type: "transfer",
    attributes: [
      { key: "recipient", value: recipient },
      { key: "sender", value: sender },
      { key: "amount", value: amount },
    ],
  });
  it("ignores staking pool moves and records rewards and fees", async () => {
    const { result } = run(cosmos, "atom", ME, (u) => {
      const q = u.searchParams.get("query") ?? "";
      if (u.pathname === "/cosmos/tx/v1beta1/txs")
        return q.startsWith("message.sender")
          ? {
              tx_responses: [
                {
                  height: "100",
                  txhash: "DEL",
                  timestamp: "2022-01-01T00:00:00Z",
                  events: [
                    transfer(ME, FEES, "5000uatom"),
                    transfer(DIST, ME, "1500000uatom"),
                    transfer(ME, BONDED, "10000000uatom"),
                  ],
                  tx: { auth_info: { fee: { amount: [{ denom: "uatom", amount: "5000" }] } } },
                },
              ],
            }
          : {
              tx_responses: [
                {
                  height: "90",
                  txhash: "IN",
                  timestamp: "2021-12-01T00:00:00Z",
                  events: [transfer(OTHER, ME, "20000000uatom")],
                },
              ],
            };
      if (u.pathname.startsWith("/cosmos/bank/"))
        return { balances: [{ denom: "uatom", amount: "11495000" }] };
      if (u.pathname.includes("/delegations/"))
        return { delegation_responses: [{ balance: { amount: "10000000" } }] };
      if (u.pathname.includes("/unbonding_delegations")) return { unbonding_responses: [] };
      return undefined;
    });
    const r = await result;
    const t = byId(r.mapped);
    expect(t["atom:IN"]).toMatchObject({ type: "deposit", receivedAmount: "20" });
    expect(t["atom:DEL"]).toMatchObject({
      type: "withdrawal",
      sentAmount: null,
      feeAmount: "0.005",
    });
    expect(t["atom:DEL:reward"]).toMatchObject({ label: "staking", receivedAmount: "1.5" });
    // 20 + 1.5 − 0.005 = 21.495 = liquid 11.495 + delegated 10.
    expect(r.balances).toEqual([{ asset: "ATOM", amount: "21.495" }]);
    expect(r.height).toBe(100);
  });
});

describe("TRON (TronGrid)", () => {
  // The TRON zero address stands in for the wallet.
  const ME = "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb";
  const ME_HEX = "410000000000000000000000000000000000000000";
  const OTHER_HEX = "41ffffffffffffffffffffffffffffffffffffff";
  const contract = (type: string, value: object) => ({
    contract: [{ type, parameter: { value } }],
  });
  it("maps TRX, TRC-10 and TRC-20 movements with fees", async () => {
    const { result } = run(tron, "trx", ME, (u) => {
      if (u.pathname === `/v1/accounts/${ME}/transactions`)
        return {
          data: [
            {
              txID: "t1",
              block_timestamp: 1_600_000_000_000,
              ret: [{ contractRet: "SUCCESS", fee: 0 }],
              raw_data: contract("TransferContract", {
                owner_address: OTHER_HEX,
                to_address: ME_HEX,
                amount: 100_000_000,
              }),
            },
            {
              txID: "t2",
              block_timestamp: 1_600_000_100_000,
              ret: [{ contractRet: "SUCCESS", fee: 1_100_000 }],
              raw_data: contract("TransferAssetContract", {
                owner_address: ME_HEX,
                to_address: OTHER_HEX,
                amount: 5_000_000,
                asset_name: "1002000",
              }),
            },
          ],
          meta: {},
        };
      if (u.pathname === `/v1/accounts/${ME}/transactions/trc20`)
        return {
          data: [
            {
              transaction_id: "t3",
              block_timestamp: 1_600_000_200_000,
              from: "TOther",
              to: ME,
              value: "2500000",
              type: "Transfer",
              token_info: { symbol: "USDT", decimals: 6 },
            },
          ],
          meta: {},
        };
      if (u.pathname === "/v1/assets/1002000") return { data: [{ abbr: "BTT", precision: 6 }] };
      if (u.pathname === `/v1/accounts/${ME}`)
        return { data: [{ balance: 98_900_000, frozenV2: [{ amount: 0 }], assetV2: [] }] };
      return undefined;
    });
    const r = await result;
    const t = byId(r.mapped);
    expect(t["trx:t1"]).toMatchObject({
      type: "deposit",
      receivedAsset: "TRX",
      receivedAmount: "100",
    });
    expect(t["trx:t2"]).toMatchObject({
      type: "withdrawal",
      sentAsset: "BTT",
      sentAmount: "5",
      feeAmount: "1.1",
    });
    expect(t["trx:t3"]).toMatchObject({
      type: "deposit",
      receivedAsset: "USDT",
      receivedAmount: "2.5",
    });
    expect(r.balances).toEqual([{ asset: "TRX", amount: "98.9" }]);
    expect(r.pos).toEqual({ ts: 1_600_000_200_001 });
  });
});

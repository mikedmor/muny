import { CHAINS, type ChainKey } from "@muny/core";
import { openDb } from "@muny/db";
import { describe, expect, it } from "vitest";
import { algorand } from "./algorand.js";
import { cardano } from "./cardano.js";
import { type Adapter, type Cursor, makeCtx } from "./ctx.js";
import { stellar } from "./stellar.js";

// Synthetic accounts and responses only. No network.

type Route = (url: URL, body: unknown) => unknown;

function run(adapter: Adapter, chain: ChainKey, source: string, route: Route, cursor?: Cursor) {
  const urls: string[] = [];
  const f = (async (u: string, init?: RequestInit) => {
    urls.push(u);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const out = route(new URL(u), body);
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
    "koios",
  );
  return { result: adapter(ctx), urls };
}

const byId = <T extends { externalId: string }>(xs: T[]) =>
  Object.fromEntries(xs.map((x) => [x.externalId, x]));

describe("Cardano (Koios)", () => {
  const STAKE = `stake1${"u".repeat(53)}`;
  const OTHER = `stake1${"x".repeat(53)}`;
  it("maps receives, sends with fee, reward withdrawals and staking rewards", async () => {
    const { result, urls } = run(cardano, "ada", STAKE, (u, body) => {
      const p = u.pathname.replace("/api/v1/", "");
      if (p === "account_txs")
        return [
          { tx_hash: "aa", block_height: 10, block_time: 1 },
          { tx_hash: "bb", block_height: 11, block_time: 2 },
        ];
      if (p === "tx_info") {
        expect((body as { _tx_hashes: string[] })._tx_hashes).toEqual(["aa", "bb"]);
        return [
          // Received 100 ADA.
          {
            tx_hash: "aa",
            block_height: 10,
            tx_timestamp: 1_700_000_000,
            fee: "170000",
            inputs: [{ stake_addr: OTHER, value: "200000000" }],
            outputs: [
              { stake_addr: STAKE, value: "100000000" },
              { stake_addr: OTHER, value: "99830000" },
            ],
          },
          // Sent 30 ADA, withdrew 5 ADA of rewards in the same tx, paid 0.2 ADA fee.
          {
            tx_hash: "bb",
            block_height: 11,
            tx_timestamp: 1_700_100_000,
            fee: "200000",
            inputs: [{ stake_addr: STAKE, value: "100000000" }],
            outputs: [
              { stake_addr: OTHER, value: "30000000" },
              { stake_addr: STAKE, value: "74800000" },
            ],
            withdrawals: [{ stake_addr: STAKE, amount: "5000000" }],
          },
        ];
      }
      if (p === "account_reward_history")
        return [
          {
            earned_epoch: 300,
            spendable_epoch: 302,
            amount: "3000000",
            type: "member",
            pool_id: "p",
          },
          {
            earned_epoch: 301,
            spendable_epoch: 303,
            amount: "2000000",
            type: "member",
            pool_id: "p",
          },
        ];
      if (p === "account_info") return [{ total_balance: "74800000" }];
      return undefined;
    });
    const r = await result;
    const t = byId(r.mapped);
    expect(t["ada:aa"]).toMatchObject({ type: "deposit", receivedAmount: "100", feeAmount: null });
    // 100 in + 5 rewards withdrawn = 30 out + 74.8 change + 0.2 fee; rewards counted when earned.
    expect(t["ada:bb"]).toMatchObject({ type: "withdrawal", sentAmount: "30", feeAmount: "0.2" });
    expect(t["ada:reward:300:member:p"]).toMatchObject({
      type: "deposit",
      label: "staking",
      receivedAmount: "3",
    });
    expect(r.height).toBe(11);
    expect(r.balances).toEqual([{ asset: "ADA", amount: "74.8" }]);
    // 100 + 3 + 2 − 30 − 0.2 = 74.8 ✓ matches the chain.
    expect(urls[0]).toContain("_after_block_height=0");
  });
});

describe("Algorand (AlgoNode)", () => {
  const ME = "A".repeat(58);
  const OTHER = "B".repeat(58);
  it("maps payments, tokens, inner payments and fees", async () => {
    const { result } = run(algorand, "algo", ME, (u) => {
      if (u.pathname.endsWith("/transactions"))
        return {
          transactions: [
            {
              id: "T1",
              "confirmed-round": 5,
              "round-time": 1_700_000_000,
              sender: OTHER,
              fee: 1000,
              "payment-transaction": { receiver: ME, amount: 10_000_000 },
            },
            {
              id: "T2",
              "confirmed-round": 6,
              "round-time": 1_700_000_100,
              sender: ME,
              fee: 1000,
              "asset-transfer-transaction": {
                "asset-id": 31566704,
                amount: 2_500_000,
                receiver: OTHER,
              },
              "inner-txns": [
                { sender: OTHER, "payment-transaction": { receiver: ME, amount: 3_000_000 } },
              ],
            },
          ],
        };
      if (u.pathname === "/v2/assets/31566704")
        return { asset: { params: { decimals: 6, "unit-name": "USDC" } } };
      if (u.pathname === `/v2/accounts/${ME}`)
        return { account: { amount: 12_999_000, assets: [{ "asset-id": 31566704, amount: 0 }] } };
      return undefined;
    });
    const r = await result;
    const t = byId(r.mapped);
    expect(t["algo:T1"]).toMatchObject({ type: "deposit", receivedAmount: "10", feeAmount: null });
    expect(t["algo:T2"]).toMatchObject({
      type: "trade",
      sentAsset: "USDC",
      sentAmount: "2.5",
      receivedAsset: "ALGO",
      receivedAmount: "3",
      feeAmount: "0.001",
    });
    expect(r.balances).toEqual([{ asset: "ALGO", amount: "12.999" }]);
    expect(r.height).toBe(6);
  });
});

describe("Stellar (Horizon)", () => {
  const ME = `G${"A".repeat(55)}`;
  it("maps account creation, payments, trades and fees, and resumes from paging tokens", async () => {
    const { result } = run(stellar, "xlm", ME, (u) => {
      if (u.pathname.endsWith("/effects"))
        return {
          _embedded: {
            records: [
              {
                id: "100-1",
                paging_token: "100-1",
                type: "account_created",
                created_at: "2021-01-01T00:00:00Z",
                starting_balance: "50.0000000",
              },
              {
                id: "200-1",
                paging_token: "200-1",
                type: "account_debited",
                created_at: "2021-02-01T00:00:00Z",
                amount: "10.0000000",
                asset_type: "native",
              },
              {
                id: "300-1",
                paging_token: "300-1",
                type: "trade",
                created_at: "2021-03-01T00:00:00Z",
                sold_amount: "5.0000000",
                sold_asset_type: "native",
                bought_amount: "2.0000000",
                bought_asset_type: "credit_alphanum4",
                bought_asset_code: "USDC",
              },
            ],
          },
        };
      if (u.pathname.endsWith("/transactions"))
        return {
          _embedded: {
            records: [
              {
                hash: "h2",
                paging_token: "p2",
                created_at: "2021-02-01T00:00:00Z",
                ledger: 20,
                source_account: ME,
                fee_charged: "100",
              },
              {
                hash: "h9",
                paging_token: "p9",
                created_at: "2021-02-02T00:00:00Z",
                ledger: 21,
                source_account: "GOTHER",
                fee_charged: "100",
              },
            ],
          },
        };
      if (u.pathname === `/accounts/${ME}`)
        return {
          balances: [
            { balance: "34.9999900", asset_type: "native" },
            { balance: "2.0000000", asset_type: "credit_alphanum4", asset_code: "USDC" },
          ],
        };
      return undefined;
    });
    const r = await result;
    const t = byId(r.mapped);
    expect(t["xlm:op:100"]).toMatchObject({ type: "deposit", receivedAmount: "50" });
    expect(t["xlm:op:200"]).toMatchObject({ type: "withdrawal", sentAmount: "10" });
    expect(t["xlm:op:300"]).toMatchObject({
      type: "trade",
      sentAsset: "XLM",
      receivedAsset: "USDC",
    });
    expect(t["xlm:fee:h2"]).toMatchObject({ feeAsset: "XLM", feeAmount: "0.00001" });
    expect(t["xlm:fee:h9"]).toBeUndefined();
    expect(r.pos).toEqual({ effects: "300-1", txs: "p9" });
    expect(r.balances.map((b) => b.asset)).toEqual(["XLM", "USDC"]);
  });
});

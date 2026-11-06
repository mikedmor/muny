import { createHmac, generateKeyPairSync, randomBytes, verify } from "node:crypto";
import { schema } from "@muny/db";
import type { CryptoTxn, CryptoTxnPage, CryptoWallet } from "@muny/shared";
import { describe, expect, it } from "vitest";
import { makeSignedInApp } from "../test-utils.js";

// Fake exchanges with synthetic accounts. No network; keys are generated here.

async function setup(fake: typeof fetch) {
  const app = await makeSignedInApp({
    priceFetch: fake,
    env: { MUNY_SECRET_KEY: randomBytes(32).toString("base64") },
  });
  const wallet = (
    await app.client.post("/api/crypto/wallets", { name: "Exchange", kind: "exchange" })
  ).json<CryptoWallet>();
  const connect = async (exchange: string, key: string, secret: string) => {
    const res = await app.client.put(`/api/crypto/wallets/${wallet.id}/exchange`, {
      exchange,
      key,
      secret,
    });
    expect(res.statusCode).toBe(200);
    for (let i = 0; i < 300; i++) {
      const ws = (await app.client.get("/api/crypto/wallets")).json<CryptoWallet[]>();
      const w = ws.find((x) => x.id === wallet.id);
      if (w && w.status !== "never" && !w.syncing) return w;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("sync didn't finish");
  };
  const rows = async () =>
    (await app.client.get(`/api/crypto/txns?walletId=${wallet.id}&limit=100`)).json<CryptoTxnPage>()
      .items;
  return { ...app, wallet, connect, rows };
}
const pick = (rows: CryptoTxn[], f: (t: CryptoTxn) => boolean) => rows.find(f);

describe("Kraken", () => {
  it("maps the ledger: trades, staking rewards, withdrawals with fees", async () => {
    const secret = randomBytes(32).toString("base64");
    const fake = (async (url: string, init: RequestInit) => {
      const h = init.headers as Record<string, string>;
      if (!h["API-Sign"] || h["API-Key"] !== "k-123")
        return Response.json({ error: ["EAPI:Invalid key"] });
      const path = new URL(url).pathname;
      if (path === "/0/private/Ledgers")
        return Response.json({
          error: [],
          result: {
            count: 4,
            ledger: {
              L1: {
                refid: "R1",
                time: 1_700_000_000.5,
                type: "trade",
                asset: "ZUSD",
                amount: "-100.0000",
                fee: "0.2600",
              },
              L2: {
                refid: "R1",
                time: 1_700_000_000.5,
                type: "trade",
                asset: "XXBT",
                amount: "0.0025000000",
                fee: "0",
              },
              L3: {
                refid: "R2",
                time: 1_700_000_100,
                type: "staking",
                asset: "DOT.S",
                amount: "0.5",
                fee: "0",
              },
              L4: {
                refid: "R3",
                time: 1_700_000_200,
                type: "withdrawal",
                asset: "XETH",
                amount: "-0.5",
                fee: "0.0035",
              },
            },
          },
        });
      if (path === "/0/private/Balance")
        return Response.json({ error: [], result: { XXBT: "0.0025", "DOT.S": "0.5" } });
      return Response.json({ error: ["EGeneral:Unknown method"] });
    }) as unknown as typeof fetch;
    const { connect, rows } = await setup(fake);
    const w = await connect("kraken", "k-123", secret);
    expect(w).toMatchObject({ status: "ok", exchange: "kraken", sourceHint: "API key …-123" });
    const r = await rows();
    expect(pick(r, (t) => t.type === "trade")).toMatchObject({
      sentAsset: "USD",
      sentAmount: "100",
      receivedAsset: "BTC",
      receivedAmount: "0.0025",
      feeAsset: "USD",
      feeAmount: "0.26",
    });
    expect(pick(r, (t) => t.receivedAsset === "DOT")).toMatchObject({
      label: "staking",
      receivedAmount: "0.5",
    });
    expect(pick(r, (t) => t.sentAsset === "ETH")).toMatchObject({
      type: "withdrawal",
      sentAmount: "0.5",
      feeAmount: "0.0035",
    });
  });

  it("says so when the key is refused, without echoing it", async () => {
    const fake = (async () =>
      Response.json({ error: ["EAPI:Invalid key"] })) as unknown as typeof fetch;
    const { connect } = await setup(fake);
    const w = await connect("kraken", "secret-key-value", randomBytes(16).toString("base64"));
    expect(w.status).toBe("error");
    expect(w.lastError).toMatch(/Kraken refused the API key/);
    expect(w.lastError).not.toContain("secret-key-value");
  });
});

describe("Coinbase", () => {
  it("signs each request with an ES256 JWT and groups a buy into one trade", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const pem = privateKey.export({ type: "sec1", format: "pem" }).toString();
    const name = "organizations/org-1/apiKeys/key-1";
    const asked: string[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      const u = new URL(url);
      asked.push(u.pathname);
      const token = String((init.headers as Record<string, string>).authorization).replace(
        "Bearer ",
        "",
      );
      const [h, p, s] = token.split(".") as [string, string, string];
      const claims = JSON.parse(Buffer.from(p, "base64url").toString());
      const ok = verify(
        "sha256",
        Buffer.from(`${h}.${p}`),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(s, "base64url"),
      );
      if (!ok || claims.sub !== name || claims.uri !== `GET api.coinbase.com${u.pathname}`)
        return Response.json({ errors: [{ id: "unauthorized" }] }, { status: 401 });
      if (u.pathname === "/v2/accounts")
        return Response.json({
          data: [
            {
              id: "a-btc",
              currency: { code: "BTC" },
              balance: { amount: "0.01", currency: "BTC" },
              created_at: "2021-01-01T00:00:00Z",
              updated_at: "2021-02-01T00:00:00Z",
            },
            {
              id: "a-doge",
              currency: { code: "DOGE" },
              balance: { amount: "0.00", currency: "DOGE" },
              created_at: "2021-01-01T00:00:00Z",
              updated_at: "2021-01-01T00:00:00Z",
            },
          ],
          pagination: { next_uri: null },
        });
      if (u.pathname === "/v2/accounts/a-btc/transactions")
        return Response.json({
          data: [
            {
              id: "t3",
              type: "learning_reward",
              status: "completed",
              amount: { amount: "0.0001", currency: "BTC" },
              created_at: "2021-01-25T00:00:00Z",
            },
            {
              id: "t2",
              type: "send",
              status: "completed",
              amount: { amount: "-0.0011", currency: "BTC" },
              created_at: "2021-01-20T00:00:00Z",
              network: {
                hash: "abc123",
                transaction_fee: { amount: "0.0001", currency: "BTC" },
                transaction_amount: { amount: "0.001", currency: "BTC" },
              },
              to: { address: "bc1qsyntheticaddress000000000000000000" },
            },
            {
              id: "t1",
              type: "buy",
              status: "completed",
              amount: { amount: "0.011", currency: "BTC" },
              native_amount: { amount: "400.00", currency: "USD" },
              created_at: "2021-01-10T00:00:00Z",
              buy: { id: "b1" },
            },
          ],
          pagination: { next_uri: null },
        });
      return Response.json({ data: [], pagination: { next_uri: null } });
    }) as unknown as typeof fetch;
    const { connect, rows } = await setup(fake);
    const w = await connect("coinbase", name, pem);
    expect(w.status).toBe("ok");
    // An empty wallet Coinbase lists for every coin isn't asked about.
    expect(asked).not.toContain("/v2/accounts/a-doge/transactions");
    const r = await rows();
    expect(pick(r, (t) => t.type === "trade")).toMatchObject({
      sentAsset: "USD",
      sentAmount: "400",
      receivedAsset: "BTC",
      receivedAmount: "0.011",
    });
    expect(pick(r, (t) => t.type === "withdrawal")).toMatchObject({
      sentAmount: "0.001",
      feeAmount: "0.0001",
      txHash: "abc123",
      counterparty: "bc1qsyntheticaddress000000000000000000",
    });
    expect(pick(r, (t) => t.label === "reward")).toMatchObject({ receivedAmount: "0.0001" });
    expect(w.balances.find((b) => b.asset === "BTC")?.amount).toBe("0.01");
  });
});

describe("Coinbase alongside a Koinly import", () => {
  it("doesn't repeat an order Koinly recorded whole, or rewards Koinly rounded", async () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const pem = privateKey.export({ type: "sec1", format: "pem" }).toString();
    const fill = (id: string, amount: string, currency: string, at: string) => ({
      id,
      type: "advanced_trade_fill",
      status: "completed",
      amount: { amount, currency },
      created_at: at,
      advanced_trade_fill: { order_id: "o1", product_id: "ALEO-USD", order_side: "SELL" },
    });
    const acct = (id: string, code: string, amount: string) => ({
      id,
      currency: { code },
      balance: { amount, currency: code },
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-02-01T00:00:00Z",
    });
    const fake = (async (url: string) => {
      const p = new URL(url).pathname;
      const page = (data: unknown[]) => Response.json({ data, pagination: { next_uri: null } });
      if (p === "/v2/accounts")
        return page([
          acct("a-aleo", "ALEO", "0"),
          acct("a-usd", "USD", "1300"),
          acct("a-ada", "ADA", "0.00027972189318106"),
        ]);
      if (p === "/v2/accounts/a-aleo/transactions")
        return page([
          fill("f2", "-12.29", "ALEO", "2025-01-26T18:50:01Z"),
          fill("f1", "-55.39", "ALEO", "2025-01-26T18:50:00Z"),
        ]);
      if (p === "/v2/accounts/a-usd/transactions")
        return page([
          fill("u2", "236.00", "USD", "2025-01-26T18:50:01Z"),
          fill("u1", "1064.00", "USD", "2025-01-26T18:50:00Z"),
        ]);
      if (p === "/v2/accounts/a-ada/transactions")
        return page([
          {
            id: "r1",
            type: "staking_reward",
            status: "completed",
            amount: { amount: "0.00027972189318106", currency: "ADA" },
            created_at: "2024-05-07T03:06:43Z",
          },
        ]);
      return page([]);
    }) as unknown as typeof fetch;
    const { db, wallet, connect, rows } = await setup(fake);
    const imp = (id: string, v: Record<string, unknown>) =>
      db
        .insert(schema.cryptoTxns)
        .values({
          id,
          walletId: wallet.id,
          externalId: `koinly:${id}`,
          source: "import",
          ...v,
        } as never)
        .run();
    imp("k1", {
      at: Date.UTC(2025, 0, 26, 18, 50),
      type: "trade",
      sentAsset: "ALEO",
      sentAmount: "67.68",
      receivedAsset: "USD",
      receivedAmount: "1295.12",
    });
    imp("k2", {
      at: Date.UTC(2024, 4, 7, 3, 6, 43),
      type: "deposit",
      label: "reward",
      receivedAsset: "ADA",
      receivedAmount: "0.000279",
    });
    const w = await connect("coinbase", "organizations/o/apiKeys/k", pem);
    expect(w.status).toBe("ok");
    const r = await rows();
    expect(r.map((t) => t.id).sort()).toEqual(["k1", "k2"]);
  });
});

describe("Coinbase buy dated when it completed", () => {
  it("matches the imported buy dated when it was placed, days earlier", async () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const pem = privateKey.export({ type: "sec1", format: "pem" }).toString();
    const fake = (async (url: string) => {
      const p = new URL(url).pathname;
      const page = (data: unknown[]) => Response.json({ data, pagination: { next_uri: null } });
      if (p === "/v2/accounts")
        return page([
          {
            id: "a-btc",
            currency: { code: "BTC" },
            balance: { amount: "0.01652", currency: "BTC" },
            created_at: "2014-01-01T00:00:00Z",
            updated_at: "2014-03-05T00:00:00Z",
          },
        ]);
      if (p === "/v2/accounts/a-btc/transactions")
        return page([
          {
            id: "b",
            type: "buy",
            status: "completed",
            amount: { amount: "0.01652", currency: "BTC" },
            native_amount: { amount: "10.00", currency: "USD" },
            created_at: "2014-03-04T16:24:29Z",
            buy: { id: "b1" },
          },
        ]);
      return page([]);
    }) as unknown as typeof fetch;
    const { db, wallet, connect, rows } = await setup(fake);
    db.insert(schema.cryptoTxns)
      .values({
        id: "k",
        walletId: wallet.id,
        at: Date.UTC(2014, 1, 26, 18, 30),
        externalId: "koinly:k",
        source: "import",
        type: "trade",
        sentAsset: "USD",
        sentAmount: "9.75",
        receivedAsset: "BTC",
        receivedAmount: "0.01652",
      })
      .run();
    expect((await connect("coinbase", "organizations/o/apiKeys/k", pem)).status).toBe("ok");
    expect((await rows()).map((t) => t.id)).toEqual(["k"]);
  });
});

describe("Gemini", () => {
  it("signs the payload and maps trades and transfers", async () => {
    const secret = "gemini-secret";
    let tradeCalls = 0;
    let transferCalls = 0;
    const fake = (async (url: string, init: RequestInit) => {
      const h = init.headers as Record<string, string>;
      const sig = createHmac("sha384", secret)
        .update(h["X-GEMINI-PAYLOAD"] ?? "")
        .digest("hex");
      if (sig !== h["X-GEMINI-SIGNATURE"])
        return Response.json({ result: "error", reason: "InvalidSignature" }, { status: 400 });
      const path = new URL(url).pathname;
      if (path === "/v1/mytrades")
        return Response.json(
          tradeCalls++
            ? []
            : [
                {
                  tid: 1,
                  timestampms: 1_700_000_000_000,
                  symbol: "ETHUSD",
                  price: "2000",
                  amount: "0.5",
                  type: "Buy",
                  fee_currency: "USD",
                  fee_amount: "2.5",
                },
              ],
        );
      if (path === "/v1/transfers")
        return Response.json(
          transferCalls++
            ? []
            : [
                {
                  eid: 9,
                  type: "Withdrawal",
                  status: "Complete",
                  timestampms: 1_700_000_500_000,
                  currency: "ETH",
                  amount: "0.2",
                  feeAmount: "0.001",
                  feeCurrency: "ETH",
                  txHash: "0xdead",
                  destination: "0xabc",
                },
              ],
        );
      if (path === "/v1/balances") return Response.json([{ currency: "ETH", amount: "0.299" }]);
      return Response.json({ result: "error", reason: "NotFound" }, { status: 404 });
    }) as unknown as typeof fetch;
    const { connect, rows } = await setup(fake);
    const w = await connect("gemini", "account-xyz", secret);
    expect(w.status).toBe("ok");
    const r = await rows();
    expect(pick(r, (t) => t.type === "trade")).toMatchObject({
      sentAsset: "USD",
      sentAmount: "1000",
      receivedAsset: "ETH",
      receivedAmount: "0.5",
      feeAmount: "2.5",
    });
    expect(pick(r, (t) => t.type === "withdrawal")).toMatchObject({
      sentAmount: "0.2",
      feeAmount: "0.001",
      txHash: "0xdead",
    });
  });
});

describe("Gemini with a time-based nonce", () => {
  it("switches to seconds when Gemini rejects the default nonce", async () => {
    const fake = (async (url: string, init: RequestInit) => {
      const h = init.headers as Record<string, string>;
      const p = JSON.parse(Buffer.from(h["X-GEMINI-PAYLOAD"] ?? "", "base64").toString());
      // This key wants seconds within 30 s of now.
      if (Math.abs(Number(p.nonce) - Date.now() / 1000) > 30)
        return Response.json({ result: "error", reason: "InvalidNonce" }, { status: 400 });
      const path = new URL(url).pathname;
      if (path === "/v1/balances") return Response.json([{ currency: "BTC", amount: "1" }]);
      return Response.json([]);
    }) as unknown as typeof fetch;
    const { connect } = await setup(fake);
    const w = await connect("gemini", "account-xyz", "secret");
    expect(w).toMatchObject({ status: "ok", onChain: [{ asset: "BTC", amount: "1" }] });
  });
});

describe("Gemini with a master key", () => {
  it("names each exchange account of the group, and adds them up", async () => {
    const seen: (string | undefined)[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      const h = init.headers as Record<string, string>;
      const p = JSON.parse(Buffer.from(h["X-GEMINI-PAYLOAD"] ?? "", "base64").toString());
      const path = new URL(url).pathname;
      if (path === "/v1/account/list")
        return Response.json([
          { name: "Primary", account: "primary", type: "exchange", status: "open" },
          { name: "Trading", account: "trading", type: "exchange", status: "open" },
          { name: "Vault", account: "vault", type: "custody", status: "open" },
        ]);
      if (!p.account)
        return Response.json({ result: "error", reason: "MissingAccounts" }, { status: 400 });
      seen.push(p.account);
      if (path === "/v1/balances")
        return Response.json([{ currency: "BTC", amount: p.account === "primary" ? "1" : "0.5" }]);
      return Response.json([]);
    }) as unknown as typeof fetch;
    const { connect } = await setup(fake);
    const w = await connect("gemini", "master-abc", "secret");
    expect(w).toMatchObject({
      status: "ok",
      lastError: null,
      onChain: [{ asset: "BTC", amount: "1.5" }],
    });
    expect(new Set(seen)).toEqual(new Set(["primary", "trading"]));
  });
});

describe("Binance US", () => {
  it("asks coin by coin and market by market, signed", async () => {
    const secret = "bus-secret";
    const fake = (async (url: string, init: RequestInit) => {
      const u = new URL(url);
      if (u.pathname === "/api/v3/exchangeInfo")
        return Response.json({
          symbols: [{ symbol: "BTCUSD", baseAsset: "BTC", quoteAsset: "USD" }],
        });
      const sig = u.searchParams.get("signature");
      const q = new URLSearchParams(u.search);
      q.delete("signature");
      if (
        (init.headers as Record<string, string>)["X-MBX-APIKEY"] !== "bus-key" ||
        createHmac("sha256", secret).update(q.toString()).digest("hex") !== sig
      )
        return Response.json({ code: -2015, msg: "Invalid API-key" }, { status: 401 });
      switch (u.pathname) {
        case "/api/v3/account":
          return Response.json({ balances: [{ asset: "BTC", free: "0.4995", locked: "0" }] });
        case "/sapi/v1/capital/deposit/hisrec":
          // Like Binance: a range over 90 days returns nothing.
          if (
            Number(u.searchParams.get("endTime")) - Number(u.searchParams.get("startTime")) >
            90 * 86_400_000
          )
            return Response.json([]);
          if (
            Number(u.searchParams.get("endTime")) < 1_600_000_000_000 ||
            Number(u.searchParams.get("startTime")) > 1_600_000_000_000
          )
            return Response.json([]);
          return Response.json([
            { amount: "1", coin: "BTC", status: 1, txId: "tx1", insertTime: 1_600_000_000_000 },
          ]);
        case "/sapi/v1/capital/withdraw/history":
          return Response.json([
            {
              id: "w1",
              amount: "0.4",
              transactionFee: "0.0005",
              coin: "BTC",
              status: 6,
              applyTime: "2020-10-01 10:00:00",
              txId: "tx2",
            },
          ]);
        case "/api/v3/myTrades":
          return Response.json([
            {
              id: 5,
              qty: "0.1",
              quoteQty: "1000",
              commission: "1",
              commissionAsset: "USD",
              time: 1_601_000_000_000,
              isBuyer: false,
            },
          ]);
        case "/sapi/v1/ocbs/orders":
          return Response.json({ dataList: [] });
        case "/sapi/v1/otc/orders":
          return Response.json({ rows: [] });
        case "/sapi/v1/staking/stakingRewardsHistory":
          return Response.json({ data: [] });
        case "/sapi/v1/asset/assetDistributionHistory":
          return Response.json({ rows: [] });
      }
      return Response.json({ code: -1, msg: "unknown" }, { status: 400 });
    }) as unknown as typeof fetch;
    const { connect, rows } = await setup(fake);
    const w = await connect("binance_us", "bus-key", secret);
    expect(w).toMatchObject({ status: "ok", lastError: null });
    const r = await rows();
    expect(pick(r, (t) => t.type === "deposit")).toMatchObject({
      receivedAmount: "1",
      txHash: "tx1",
    });
    expect(pick(r, (t) => t.type === "withdrawal")).toMatchObject({
      sentAmount: "0.4",
      feeAmount: "0.0005",
      at: Date.UTC(2020, 9, 1, 10),
    });
    expect(pick(r, (t) => t.type === "trade")).toMatchObject({
      sentAsset: "BTC",
      sentAmount: "0.1",
      receivedAsset: "USD",
      receivedAmount: "1000",
    });
    // Balances agree with the history: no difference to explain.
    expect(w.onChain).toEqual([{ asset: "BTC", amount: "0.4995" }]);
  });
});

describe("closed exchanges", () => {
  it("marks what's left as lost, and archives the wallet", async () => {
    const { client, db, wallet } = await setup(
      (async () => new Response("", { status: 500 })) as unknown as typeof fetch,
    );
    db.insert(schema.cryptoTxns)
      .values({
        id: "in",
        walletId: wallet.id,
        at: Date.UTC(2021, 0, 1),
        externalId: "koinly:in",
        source: "import",
        type: "deposit",
        receivedAsset: "XMR",
        receivedAmount: "2.5",
      })
      .run();
    const at = Date.UTC(2025, 8, 18);
    expect((await client.post(`/api/crypto/wallets/${wallet.id}/lost`, { at })).json()).toEqual({
      coins: 1,
    });
    const page = (await client.get(`/api/crypto/txns?walletId=${wallet.id}`)).json<CryptoTxnPage>();
    expect(page.items[0]).toMatchObject({
      type: "withdrawal",
      label: "lost",
      sentAmount: "2.5",
      at,
    });
    const patched = (
      await client.patch(`/api/crypto/wallets/${wallet.id}`, {
        archived: true,
        exchange: "tradeogre",
      })
    ).json<CryptoWallet>();
    expect(patched).toMatchObject({ archived: true, exchange: "tradeogre", balances: [] });
  });

  it("records a wallet you can't open any more as lost, saying why", async () => {
    const { client, db } = await setup(
      (async () => new Response("", { status: 500 })) as unknown as typeof fetch,
    );
    const bcn = (
      await client.post("/api/crypto/wallets", { name: "Bytecoin", kind: "manual" })
    ).json<CryptoWallet>();
    db.insert(schema.cryptoTxns)
      .values({
        id: "bcn-in",
        walletId: bcn.id,
        at: Date.UTC(2018, 0, 1),
        externalId: "koinly:bcn-in",
        source: "import",
        type: "deposit",
        receivedAsset: "BCN",
        receivedAmount: "1000",
      })
      .run();
    const at = Date.UTC(2020, 5, 1, 12);
    await client.post(`/api/crypto/wallets/${bcn.id}/lost`, { at, reason: "access" });
    const page = (await client.get(`/api/crypto/txns?walletId=${bcn.id}`)).json<CryptoTxnPage>();
    expect(page.items[0]).toMatchObject({
      label: "lost",
      sentAmount: "1000",
      at,
      description: "Lost: no longer have access to Bytecoin",
    });
  });
});

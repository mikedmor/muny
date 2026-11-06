import { randomBytes } from "node:crypto";
import { openDb, schema } from "@muny/db";
import type {
  Account,
  CategoryGroup,
  ConnectionSummary,
  InvestSummary,
  InvestTxn,
  LinkResult,
  LinkStart,
  SyncConfigStatus,
  TransactionPage,
} from "@muny/shared";
import { describe, expect, it } from "vitest";
import { buildApp, contentSecurityPolicy } from "../app.js";
import { loadConfig } from "../config.js";
import { decryptJson, encryptJson } from "../lib/crypto.js";
import { OWNER, TestClient } from "../test-utils.js";
import { type FetchLike, PlaidProvider, plaidCents } from "./plaid.js";
import { type TellerHttp, TellerProvider } from "./teller.js";

// Synthetic data only. Fake providers; no network.

const SECRET = randomBytes(32).toString("base64");

function plaidTxn(id: string, over: Record<string, unknown> = {}) {
  return {
    transaction_id: id,
    account_id: "acc-chk",
    amount: 4.5,
    iso_currency_code: "USD",
    date: "2026-03-02",
    authorized_date: "2026-03-01",
    name: "SQ *CORNER CAFE",
    original_description: "SQ *CORNER CAFE 0123 AUSTIN TX",
    merchant_name: "Corner Cafe",
    pending: false,
    pending_transaction_id: null,
    personal_finance_category: { primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_COFFEE" },
    ...over,
  };
}

/** Scriptable fake of the Plaid API. */
function fakePlaid() {
  const state = {
    calls: [] as string[],
    pages: [] as { added: unknown[]; modified: unknown[]; removed: { transaction_id: string }[] }[],
    error: null as null | { status: number; body: Record<string, unknown> },
    cardOwed: 120.5,
    linkBodies: [] as Record<string, unknown>[],
    investNotReady: false,
  };
  const fetchFn: FetchLike = async (url, init) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(String(init.body));
    state.calls.push(path);
    if (body.client_id !== "client" || body.secret !== "secret") throw new Error("bad keys");
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });
    if (state.error && path !== "/item/remove") return json(state.error.status, state.error.body);
    switch (path) {
      case "/link/token/create":
        state.linkBodies.push(body);
        return json(200, { link_token: body.access_token ? "link-update" : "link-new" });
      case "/item/public_token/exchange":
        return json(200, { access_token: "access-sandbox-SECRET", item_id: "item-1" });
      case "/accounts/get":
        return json(200, {
          item: { institution_id: "ins_1" },
          accounts: [
            {
              account_id: "acc-chk",
              name: "Checking",
              mask: "1111",
              type: "depository",
              subtype: "checking",
              balances: { current: 1000.25, available: 990, iso_currency_code: "USD" },
            },
            {
              account_id: "acc-card",
              name: "Card",
              mask: "2222",
              type: "credit",
              subtype: "credit card",
              balances: { current: state.cardOwed, available: null, iso_currency_code: "USD" },
            },
            {
              account_id: "acc-ira",
              name: "IRA",
              mask: "3333",
              type: "investment",
              subtype: "ira",
              balances: { current: 5000, available: null },
            },
          ],
        });
      case "/institutions/get_by_id":
        return json(200, { institution: { name: "Example Bank" } });
      case "/transactions/sync": {
        const page = state.pages.shift() ?? { added: [], modified: [], removed: [] };
        return json(200, { ...page, next_cursor: `cursor-${state.calls.length}`, has_more: false });
      }
      case "/investments/holdings/get":
        return json(200, {
          holdings: [
            {
              account_id: "acc-ira",
              security_id: "s-vti",
              quantity: 10,
              institution_price: 250.1,
              institution_value: 2501,
              cost_basis: 2000,
            },
            {
              account_id: "acc-ira",
              security_id: "s-xyz",
              quantity: 1.5,
              institution_price: 10,
              institution_value: 15,
              cost_basis: null,
            },
            {
              account_id: "acc-ira",
              security_id: "s-mm",
              quantity: 1000,
              institution_price: 1,
              institution_value: 1000,
              cost_basis: 1000,
            },
          ],
          securities: [
            {
              security_id: "s-vti",
              ticker_symbol: "VTI",
              name: "Vanguard Total Stock Market ETF",
              type: "etf",
            },
            {
              security_id: "s-xyz",
              ticker_symbol: null,
              cusip: "123456789",
              name: "XYZ Private Fund",
              type: "mutual fund",
            },
            {
              security_id: "s-mm",
              ticker_symbol: "SPAXX",
              name: "Money Market",
              type: "cash",
              is_cash_equivalent: true,
            },
          ],
        });
      case "/investments/transactions/get":
        if (state.investNotReady)
          return json(400, {
            error_type: "ITEM_ERROR",
            error_code: "PRODUCT_NOT_READY",
            error_message: "not ready",
          });
        return json(200, {
          total_investment_transactions: 2,
          securities: [],
          investment_transactions: [
            {
              investment_transaction_id: "it-1",
              account_id: "acc-ira",
              security_id: "s-vti",
              date: "2026-10-01",
              name: "BUY VTI",
              quantity: 2,
              amount: 500.2,
              price: 250.1,
              fees: 0,
              type: "buy",
              subtype: "buy",
            },
            {
              investment_transaction_id: "it-2",
              account_id: "acc-ira",
              security_id: "s-vti",
              date: "2026-10-15",
              name: "DIVIDEND VTI",
              quantity: 0,
              amount: -12.34,
              price: 0,
              fees: 0,
              type: "cash",
              subtype: "dividend",
            },
          ],
        });
      case "/item/remove":
        return json(200, {});
      default:
        return json(404, { error_code: "NOT_FOUND" });
    }
  };
  return { state, fetchFn };
}

async function setup(opts: { teller?: TellerHttp } = {}) {
  const config = loadConfig({
    NODE_ENV: "test",
    MUNY_SECRET_KEY: SECRET,
    PLAID_CLIENT_ID: "client",
    PLAID_SECRET: "secret",
    TELLER_APPLICATION_ID: "app_test",
  });
  const plaid = fakePlaid();
  const db = openDb({ filename: ":memory:" });
  const providers = {
    plaid: config.plaid ? new PlaidProvider(config.plaid, plaid.fetchFn) : undefined,
    teller: config.teller ? new TellerProvider(config.teller, opts.teller) : undefined,
  };
  const app = await buildApp({ config, db, providers });
  const client = new TestClient(app);
  await client.post("/api/auth/setup", OWNER);
  return { app, db, client, plaid: plaid.state, config };
}

async function txns(client: TestClient, accountId: string) {
  return (
    await client.get(`/api/transactions?accountId=${accountId}&hidden=include&limit=100`)
  ).json<TransactionPage>().items;
}

describe("credential encryption", () => {
  it("round-trips and rejects the wrong key or tampering", () => {
    const key = randomBytes(32);
    const blob = encryptJson(key, { accessToken: "abc" });
    expect(blob).toMatch(/^v1:/);
    expect(blob).not.toContain("abc");
    expect(decryptJson(key, blob)).toEqual({ accessToken: "abc" });
    expect(() => decryptJson(randomBytes(32), blob)).toThrow(/MUNY_SECRET_KEY/);
    const tampered = `${blob.slice(0, -4)}AAAA`;
    expect(() => decryptJson(key, tampered)).toThrow();
  });
});

describe("plaid helpers", () => {
  it("converts floats to cents exactly", () => {
    expect([
      plaidCents(4.5),
      plaidCents(-1.1),
      plaidCents(1234.56),
      plaidCents(0.29),
      plaidCents(1.005),
    ]).toEqual([450, -110, 123456, 29, 101]);
  });
});

describe("sync config + CSP", () => {
  it("reports what's configured without secrets", async () => {
    const { client } = await setup();
    const s = (await client.get("/api/sync/config")).json<SyncConfigStatus>();
    expect(s).toMatchObject({
      secretKey: true,
      intervalHours: 6,
      plaid: { configured: true, env: "sandbox", oauth: false },
    });
    expect(s.teller).toMatchObject({
      configured: true,
      applicationId: "app_test",
      certificate: false,
    });
    expect(JSON.stringify(s)).not.toContain('secret"');
  });

  it("only allows provider domains when configured", () => {
    const plain = contentSecurityPolicy(loadConfig({ NODE_ENV: "test" }));
    expect(plain).not.toContain("plaid");
    expect(plain).toContain("frame-src 'none'");
    const withPlaid = contentSecurityPolicy(
      loadConfig({ NODE_ENV: "test", PLAID_CLIENT_ID: "a", PLAID_SECRET: "b" }),
    );
    expect(withPlaid).toContain("script-src 'self' https://cdn.plaid.com");
    expect(withPlaid).toContain("frame-src https://cdn.plaid.com");
  });
});

describe("Plaid sync", () => {
  it("links to existing history, adopts duplicates, and keeps tokens encrypted", async () => {
    const { client, db, plaid } = await setup();
    // Existing history (e.g. from the Rocket Money import) for the same checking account.
    const chk = (
      await client.post("/api/accounts", {
        name: "MAIN ACCOUNT",
        type: "checking",
        institutionName: "Example Bank",
        mask: "1111",
      })
    ).json<Account>();
    await client.post("/api/transactions", {
      accountId: chk.id,
      postedDate: "2026-03-01",
      amountCents: -2000,
      description: "GROCER 42",
    });

    expect((await client.post("/api/connections/plaid/link-token")).json()).toEqual({
      linkToken: "link-new",
    });
    const start = (
      await client.post("/api/connections/plaid/exchange", { publicToken: "public-x" })
    ).json<LinkStart>();
    expect(start.institutionName).toBe("Example Bank");
    expect(start.accounts.map((a) => [a.ref, a.type, a.balanceCents, a.match?.id ?? null])).toEqual(
      [
        ["acc-chk", "checking", 100025, chk.id],
        ["acc-card", "credit", -12050, null],
        ["acc-ira", "investment", 500000, null],
      ],
    );

    // The access token is stored encrypted, never in plain text or in API output.
    const row = db.select().from(schema.connections).all()[0];
    expect(row?.credentialsEnc).toMatch(/^v1:/);
    expect(row?.credentialsEnc).not.toContain("access-sandbox");
    const list = await client.get("/api/connections");
    expect(list.body).not.toContain("access-sandbox");
    expect(list.json<ConnectionSummary[]>()[0]?.status).toBe("pending_setup");

    plaid.pages.push({
      added: [
        plaidTxn("t-dup", {
          amount: 20,
          date: "2026-03-01",
          authorized_date: null,
          name: "GROCER",
          original_description: "GROCER #42",
          merchant_name: null,
          personal_finance_category: null,
        }),
        plaidTxn("t-cafe"),
        plaidTxn("t-pend", {
          amount: 9.99,
          pending: true,
          date: "2026-03-05",
          original_description: "STREAMFLIX",
          merchant_name: "StreamFlix",
        }),
        plaidTxn("t-card", {
          account_id: "acc-card",
          amount: 30,
          original_description: "HARDWARE",
          merchant_name: null,
        }),
        plaidTxn("t-ira", { account_id: "acc-ira" }),
      ],
      modified: [],
      removed: [],
    });
    const linked = (
      await client.post(`/api/connections/${start.connectionId}/link`, {
        accounts: { "acc-chk": chk.id, "acc-card": "new", "acc-ira": "skip" },
      })
    ).json<LinkResult>();
    expect(linked.summary).toMatchObject({ added: 3, adopted: 1, accountsCreated: 0 });

    const accounts = (await client.get("/api/accounts")).json<Account[]>();
    expect(accounts.find((a) => a.id === chk.id)).toMatchObject({
      balanceCents: 100025,
      balanceSource: "reported",
      provider: "plaid",
    });
    const card = accounts.find((a) => a.mask === "2222");
    expect(card).toMatchObject({ type: "credit", balanceCents: -12050 });
    expect(accounts.some((a) => a.name === "IRA")).toBe(false);

    const items = await txns(client, chk.id);
    expect(items).toHaveLength(3); // the adopted row was not duplicated
    expect(items.find((t) => t.rawDescription === "GROCER 42")).toBeDefined();
    expect(items.find((t) => t.rawDescription.startsWith("SQ *CORNER"))).toMatchObject({
      amountCents: -450,
      payeeName: "Corner Cafe",
      categoryName: "Coffee",
      postedDate: "2026-03-02",
    });
    expect(items.find((t) => t.payeeName === "StreamFlix")?.pending).toBe(true);
    expect((await txns(client, card?.id ?? ""))[0]?.amountCents).toBe(-3000);

    const conn = (await client.get("/api/connections")).json<ConnectionSummary[]>()[0];
    expect(conn).toMatchObject({ status: "active", ignoredAccounts: 1, lastError: null });
    expect(conn?.accounts.map((a) => a.name).sort()).toEqual(["Card", "MAIN ACCOUNT"]);
  });

  it("handles modified, pending -> posted, and removed transactions without losing edits", async () => {
    const { client, plaid } = await setup();
    const start = (
      await client.post("/api/connections/plaid/exchange", { publicToken: "p" })
    ).json<LinkStart>();
    plaid.pages.push({
      added: [
        plaidTxn("t-pend", {
          amount: 9.99,
          pending: true,
          original_description: "STREAMFLIX PENDING",
        }),
        plaidTxn("t-gone", { amount: 1 }),
      ],
      modified: [],
      removed: [],
    });
    await client.post(`/api/connections/${start.connectionId}/link`, {
      accounts: { "acc-chk": "new", "acc-card": "skip", "acc-ira": "skip" },
    });
    const acc = (await client.get("/api/accounts")).json<Account[]>()[0] as Account;
    const pend = (await txns(client, acc.id)).find((t) => t.pending);
    const groups = (await client.get("/api/categories")).json<CategoryGroup[]>();
    const streaming = groups.flatMap((g) => g.categories).find((c) => c.name === "Streaming");
    await client.patch(`/api/transactions/${pend?.id}`, {
      categoryId: streaming?.id,
      notes: "family plan",
    });

    plaid.pages.push({
      added: [
        plaidTxn("t-posted", {
          amount: 10.49,
          pending: false,
          pending_transaction_id: "t-pend",
          original_description: "STREAMFLIX.COM",
        }),
      ],
      modified: [],
      removed: [{ transaction_id: "t-pend" }, { transaction_id: "t-gone" }],
    });
    const s = (await client.post(`/api/connections/${start.connectionId}/sync`)).json();
    expect(s).toMatchObject({ added: 0, updated: 1, removed: 1 });
    const items = await txns(client, acc.id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: pend?.id,
      pending: false,
      amountCents: -1049,
      categoryName: "Streaming",
      notes: "family plan",
    });
    // Cursor moves forward.
    expect(plaid.calls.filter((c) => c === "/transactions/sync")).toHaveLength(2);
  });

  it("marks logins that need attention and offers update mode", async () => {
    const { client, plaid } = await setup();
    const start = (
      await client.post("/api/connections/plaid/exchange", { publicToken: "p" })
    ).json<LinkStart>();
    await client.post(`/api/connections/${start.connectionId}/link`, {
      accounts: { "acc-chk": "new" },
    });
    plaid.error = {
      status: 400,
      body: {
        error_type: "ITEM_ERROR",
        error_code: "ITEM_LOGIN_REQUIRED",
        error_message: "the login details of this item have changed",
        display_message: null,
      },
    };
    const r = await client.post(`/api/connections/${start.connectionId}/sync`);
    expect(r.statusCode).toBe(502);
    const conn = (await client.get("/api/connections")).json<ConnectionSummary[]>()[0];
    expect(conn?.status).toBe("reauth_required");
    expect(conn?.lastError).toMatch(/ITEM_LOGIN_REQUIRED/);
    expect(conn?.lastError).not.toMatch(/access-sandbox|secret/);

    plaid.error = null;
    expect(
      (await client.post(`/api/connections/${start.connectionId}/plaid/update-token`)).json(),
    ).toEqual({ linkToken: "link-update" });
    expect((await client.post(`/api/connections/${start.connectionId}/reauthed`)).statusCode).toBe(
      200,
    );
    expect((await client.get("/api/connections")).json<ConnectionSummary[]>()[0]?.status).toBe(
      "active",
    );
  });

  it("disconnecting keeps accounts and history with the same balance", async () => {
    const { client, plaid, db } = await setup();
    const start = (
      await client.post("/api/connections/plaid/exchange", { publicToken: "p" })
    ).json<LinkStart>();
    plaid.pages.push({ added: [plaidTxn("t1")], modified: [], removed: [] });
    await client.post(`/api/connections/${start.connectionId}/link`, {
      accounts: { "acc-chk": "new" },
    });
    expect((await client.delete(`/api/connections/${start.connectionId}`)).statusCode).toBe(200);
    expect(plaid.calls).toContain("/item/remove");
    expect(db.select().from(schema.connections).all()).toHaveLength(0);
    const acc = (await client.get("/api/accounts")).json<Account[]>()[0];
    expect(acc).toMatchObject({
      balanceCents: 100025,
      balanceSource: "computed",
      provider: "manual",
      transactionCount: 1,
    });
  });

  it("refuses to store credentials without MUNY_SECRET_KEY", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      PLAID_CLIENT_ID: "client",
      PLAID_SECRET: "secret",
    });
    const p = fakePlaid();
    const app = await buildApp({
      config,
      db: openDb({ filename: ":memory:" }),
      providers: {
        plaid: new PlaidProvider(config.plaid as NonNullable<typeof config.plaid>, p.fetchFn),
      },
    });
    const client = new TestClient(app);
    await client.post("/api/auth/setup", OWNER);
    const r = await client.post("/api/connections/plaid/exchange", { publicToken: "p" });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/MUNY_SECRET_KEY/);
  });
});

describe("Plaid Investments (brokerage logins)", () => {
  const linkBrokerage = async (client: TestClient) => {
    const start = (
      await client.post("/api/connections/plaid/exchange", {
        publicToken: "public-x",
        kind: "brokerage",
      })
    ).json<LinkStart>();
    await client.post(`/api/connections/${start.connectionId}/link`, {
      accounts: { "acc-chk": "skip", "acc-card": "skip", "acc-ira": "new" },
    });
    return start;
  };

  it("links for Investments only and syncs holdings and history, not transactions", async () => {
    const { client, plaid } = await setup();
    await client.post("/api/connections/plaid/link-token", { kind: "brokerage" });
    expect(plaid.linkBodies.at(-1)).toMatchObject({ products: ["investments"] });
    expect(plaid.linkBodies.at(-1)).not.toHaveProperty("transactions");
    // Banks keep asking for Transactions.
    await client.post("/api/connections/plaid/link-token");
    expect(plaid.linkBodies.at(-1)).toMatchObject({ products: ["transactions"] });

    const start = await linkBrokerage(client);
    expect(plaid.calls).not.toContain("/transactions/sync");
    expect(plaid.calls).toContain("/investments/holdings/get");

    const s = (await client.get("/api/invest/summary")).json<InvestSummary>();
    expect(s.accounts).toHaveLength(1);
    // The reported balance ($5,000) is the value: the $1,484 not in a holding is cash.
    expect(s.valueCents).toBe(500000);
    expect(
      s.positions.map((p) => [p.symbol, p.type, p.quantity, p.valueCents, p.costBasisCents]),
    ).toEqual([
      ["VTI", "etf", "10", 250100, 200000],
      ["CASH", "cash", "1484", 148400, 148400],
      ["SPAXX", "cash", "1000", 100000, 100000],
      ["123456789", "mutual_fund", "1.5", 1500, null],
    ]);
    const tx = (await client.get("/api/invest/transactions")).json<InvestTxn[]>();
    expect(tx.map((t) => [t.date, t.type, t.symbol, t.quantity, t.amountCents])).toEqual([
      ["2026-10-15", "dividend", "VTI", null, 1234],
      ["2026-10-01", "buy", "VTI", "2", -50020],
    ]);

    // Syncing again adds nothing twice.
    await client.post(`/api/connections/${start.connectionId}/sync`);
    expect((await client.get("/api/invest/transactions")).json<InvestTxn[]>()).toHaveLength(2);
  });

  it("keeps holdings when history isn't ready yet", async () => {
    const { client, plaid } = await setup();
    plaid.investNotReady = true;
    await linkBrokerage(client);
    const s = (await client.get("/api/invest/summary")).json<InvestSummary>();
    expect(s.positions.length).toBeGreaterThan(0);
    const conns = (await client.get("/api/connections")).json<ConnectionSummary[]>();
    expect(conns[0]?.status).toBe("active");
  });
});

describe("Teller sync", () => {
  it("enrolls, links and re-reads a window, dropping vanished pending transactions", async () => {
    const txnsByAccount: Record<string, unknown[]> = {
      acc_t1: [
        {
          id: "tt1",
          account_id: "acc_t1",
          amount: "-12.34",
          date: "2026-03-03",
          description: "CORNER CAFE",
          status: "pending",
          details: { category: "dining", counterparty: { name: "CORNER CAFE" } },
        },
        {
          id: "tt2",
          account_id: "acc_t1",
          amount: "2500.00",
          date: "2026-03-01",
          description: "ACME PAYROLL",
          status: "posted",
          details: { category: "income", counterparty: null },
        },
      ],
    };
    const http: TellerHttp = async (path, token) => {
      if (token !== "token_abc")
        return { status: 401, body: { error: { code: "unauthorized", message: "bad token" } } };
      if (path === "/accounts")
        return {
          status: 200,
          body: [
            {
              id: "acc_t1",
              enrollment_id: "enr_1",
              name: "Total Checking",
              type: "depository",
              subtype: "checking",
              last_four: "9876",
              currency: "USD",
              institution: { id: "chase", name: "Chase" },
              status: "open",
            },
          ],
        };
      if (path === "/accounts/acc_t1/balances")
        return { status: 200, body: { ledger: "2487.66", available: "2400.00" } };
      if (path.startsWith("/accounts/acc_t1/transactions"))
        return { status: 200, body: txnsByAccount.acc_t1 };
      return { status: 404, body: null };
    };
    const { client } = await setup({ teller: http });
    const start = (
      await client.post("/api/connections/teller/enroll", {
        accessToken: "token_abc",
        enrollmentId: "enr_1",
      })
    ).json<LinkStart>();
    expect(start).toMatchObject({
      institutionName: "Chase",
      accounts: [{ ref: "acc_t1", mask: "9876", balanceCents: 248766 }],
    });
    const linked = (
      await client.post(`/api/connections/${start.connectionId}/link`, {
        accounts: { acc_t1: "new" },
      })
    ).json<LinkResult>();
    expect(linked.summary).toMatchObject({ added: 2 });
    const acc = (await client.get("/api/accounts")).json<Account[]>()[0] as Account;
    const items = await txns(client, acc.id);
    expect(items.find((t) => t.amountCents === 250000)?.categoryName).toBe("Other Income");

    // The pending one posts under the same id with a final amount; another pending vanishes.
    const today = new Date().toISOString().slice(0, 10);
    txnsByAccount.acc_t1 = [
      {
        id: "tt1",
        account_id: "acc_t1",
        amount: "-13.00",
        date: today,
        description: "CORNER CAFE",
        status: "posted",
        details: null,
      },
    ];
    const items1 = await txns(client, acc.id);
    expect(items1).toHaveLength(2);
    const s = (await client.post(`/api/connections/${start.connectionId}/sync`)).json();
    expect(s).toMatchObject({ added: 0, updated: 1 });
    const items2 = await txns(client, acc.id);
    expect(items2.find((t) => t.payeeName === "Corner Cafe")).toMatchObject({
      amountCents: -1300,
      pending: false,
    });

    // Bad token -> reconnect needed.
    const bad = await client.post("/api/connections/teller/enroll", {
      accessToken: "nope",
      enrollmentId: "enr_2",
    });
    expect(bad.statusCode).toBe(502);
  });
});

import { randomBytes } from "node:crypto";
import { openDb, schema } from "@muny/db";
import type { LinkStart, TransactionPage } from "@muny/shared";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { OWNER, TestClient } from "../test-utils.js";
import { type FetchLike, PayPalProvider } from "./paypal.js";

// Synthetic data only. A fake PayPal API; no network.

function fakePayPal() {
  const calls: string[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    const u = new URL(url);
    calls.push(u.pathname);
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });
    if (u.pathname === "/v1/oauth2/token") {
      const auth = String((init.headers as Record<string, string>).authorization ?? "");
      const ok =
        auth === `Basic ${Buffer.from("client-id-123456:secret-abcdefgh").toString("base64")}`;
      return ok ? json(200, { access_token: "tok", expires_in: 3600 }) : json(401, {});
    }
    if (u.pathname === "/v1/reporting/balances")
      return json(200, {
        account_id: "PP-ACCOUNT",
        balances: [{ currency: "USD", primary: true, total_balance: { value: "42.10" } }],
      });
    if (u.pathname === "/v1/reporting/transactions") {
      // Only the newest window has activity.
      const end = Date.parse(u.searchParams.get("end_date") ?? "");
      if (Date.now() - end > 2 * 86_400_000)
        return json(200, { transaction_details: [], total_pages: 1 });
      const today = new Date().toISOString().slice(0, 10);
      return json(200, {
        total_pages: 1,
        transaction_details: [
          {
            transaction_info: {
              transaction_id: "PAY1",
              transaction_event_code: "T0006",
              transaction_initiation_date: `${today}T10:00:00+0000`,
              transaction_amount: { currency_code: "USD", value: "-25.00" },
              transaction_status: "S",
            },
            payer_info: { payer_name: { alternate_full_name: "Example Store" } },
            cart_info: { item_details: [{ item_name: "Widget" }] },
          },
          {
            transaction_info: {
              transaction_id: "SALE1",
              transaction_event_code: "T0011",
              transaction_initiation_date: `${today}T11:00:00+0000`,
              transaction_amount: { currency_code: "USD", value: "100.00" },
              fee_amount: { currency_code: "USD", value: "-3.20" },
              transaction_status: "S",
            },
            payer_info: { payer_name: { given_name: "Pat", surname: "Example" } },
          },
          {
            transaction_info: {
              transaction_id: "DENIED",
              transaction_initiation_date: `${today}T12:00:00+0000`,
              transaction_amount: { currency_code: "USD", value: "-9.00" },
              transaction_status: "D",
            },
          },
          {
            transaction_info: {
              transaction_id: "EUR1",
              transaction_initiation_date: `${today}T12:00:00+0000`,
              transaction_amount: { currency_code: "EUR", value: "-5.00" },
              transaction_status: "S",
            },
          },
        ],
      });
    }
    return json(404, {});
  };
  return { calls, fetchFn };
}

async function setup() {
  const config = loadConfig({
    NODE_ENV: "test",
    MUNY_SECRET_KEY: randomBytes(32).toString("base64"),
  });
  const pp = fakePayPal();
  const db = openDb({ filename: ":memory:" });
  const app = await buildApp({ config, db, providers: { paypal: new PayPalProvider(pp.fetchFn) } });
  const client = new TestClient(app);
  await client.post("/api/auth/setup", OWNER);
  return { client, db, pp };
}

describe("PayPal", () => {
  it("connects with the app's keys and syncs activity net of fees", async () => {
    const { client, db, pp } = await setup();
    const bad = await client.post("/api/connections/paypal", {
      clientId: "client-id-123456",
      clientSecret: "wrong-secret-xx",
    });
    expect(bad.statusCode).toBeGreaterThanOrEqual(400);

    const start = (
      await client.post("/api/connections/paypal", {
        clientId: "client-id-123456",
        clientSecret: "secret-abcdefgh",
      })
    ).json<LinkStart>();
    expect(start.accounts).toEqual([
      expect.objectContaining({ ref: "PP-ACCOUNT", name: "PayPal", balanceCents: 4210 }),
    ]);
    // Keys are stored encrypted.
    const row = db.select().from(schema.connections).all()[0];
    expect(row?.credentialsEnc).not.toContain("secret-abcdefgh");

    await client.post(`/api/connections/${start.connectionId}/link`, {
      accounts: { "PP-ACCOUNT": "new" },
    });
    const items = (
      await client.get("/api/transactions?hidden=include&limit=100")
    ).json<TransactionPage>().items;
    expect(items.map((t) => [t.amountCents, t.rawDescription]).sort()).toEqual([
      [-2500, "Example Store · Widget"],
      [9680, "Pat Example"],
    ]);
    // First sync reads three years in 31-day windows.
    expect(pp.calls.filter((p) => p === "/v1/reporting/transactions").length).toBeGreaterThan(30);

    // Syncing again doesn't duplicate.
    await client.post(`/api/connections/${start.connectionId}/sync`);
    const again = (
      await client.get("/api/transactions?hidden=include&limit=100")
    ).json<TransactionPage>();
    expect(again.items).toHaveLength(2);
  });
});

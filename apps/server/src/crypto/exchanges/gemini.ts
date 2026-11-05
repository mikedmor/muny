import { createHmac } from "node:crypto";
import { Deltas, isZeroDec, movementsToTxns, normDec, type SyncedTxn } from "@muny/core";
import { SyncError } from "../chains/ctx.js";
import { type ExchangeAdapter, keyRefused, mulDec } from "./http.js";

/**
 * Gemini through its REST API: past trades (/v1/mytrades) and transfers
 * (/v1/transfers), both paged by timestamp, plus balances. Needs a key with
 * the Auditor role (read-only). Requests are signed with HMAC-SHA384 over the
 * base64 JSON payload.
 */

const API = "https://api.gemini.com";
const TRADES = 500;
const TRANSFERS = 50;

/** Quote currencies, longest first, to split "ethbtc" / "dogeusd" / "btcgusd". */
const QUOTES = [
  "gusd",
  "usdc",
  "usdt",
  "usd",
  "dai",
  "btc",
  "eth",
  "eur",
  "gbp",
  "sgd",
  "bch",
  "ltc",
  "fil",
  "sol",
];
export function geminiPair(symbol: string): [string, string] | null {
  const s = symbol.toLowerCase();
  for (const q of QUOTES)
    if (s.endsWith(q) && s.length > q.length)
      return [s.slice(0, -q.length).toUpperCase(), q.toUpperCase()];
  return null;
}

interface Trade {
  tid: number;
  timestampms: number;
  symbol?: string;
  price: string;
  amount: string;
  type: "Buy" | "Sell";
  fee_currency?: string;
  fee_amount?: string;
  break?: string;
}
interface Transfer {
  eid: number;
  type: string;
  status: string;
  timestampms: number;
  currency: string;
  amount: string;
  feeAmount?: string;
  feeCurrency?: string;
  txHash?: string;
  destination?: string;
  purpose?: string;
}

let lastNonce = 0;
const nonce = () => {
  lastNonce = Math.max(Date.now(), lastNonce + 1);
  return lastNonce;
};

export const gemini: ExchangeAdapter = async (ctx) => {
  // Gemini keys use either an increasing nonce (Muny's default: milliseconds)
  // or, if created with "Uses a time based nonce", seconds within 30 s of now.
  // Muny tries the first and switches once if Gemini rejects the nonce.
  let timeBased = false;
  /** A master key (for a group of accounts) names the account in each request. */
  let account: string | undefined;
  const call = async <T>(path: string, params: Record<string, unknown> = {}): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      const n = timeBased ? Date.now() / 1000 : nonce();
      const payload = Buffer.from(
        JSON.stringify({ request: path, nonce: n, ...(account ? { account } : {}), ...params }),
      ).toString("base64");
      const signature = createHmac("sha384", ctx.creds.secret.trim()).update(payload).digest("hex");
      const res = await ctx.request<T & { result?: string; reason?: string }>(`${API}${path}`, {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          "content-length": "0",
          "cache-control": "no-cache",
          "X-GEMINI-APIKEY": ctx.creds.key.trim(),
          "X-GEMINI-PAYLOAD": payload,
          "X-GEMINI-SIGNATURE": signature,
        },
      });
      const body = res.body as { result?: string; reason?: string } | null;
      if (body && !Array.isArray(body) && body.result === "error") {
        if (/Nonce/i.test(body.reason ?? "")) {
          if (attempt === 0) {
            timeBased = !timeBased;
            continue;
          }
          throw keyRefused(
            "Gemini",
            "its nonce was rejected; if another app uses this key, make Muny its own key",
          );
        }
        if (body.reason === "MissingAccounts") throw new MissingAccount();
        if (/Key|Signature|Role|Unauthorized/i.test(body.reason ?? ""))
          throw keyRefused(
            "Gemini",
            body.reason === "MissingRole" ? "it needs the Auditor role" : undefined,
          );
        throw new SyncError(`Gemini answered with an error (${(body.reason ?? "").slice(0, 40)})`);
      }
      if (res.status >= 400) throw keyRefused("Gemini");
      return res.body;
    }
  };

  const since = ctx.cursor?.height ?? 0;
  const mapped: SyncedTxn[] = [];
  let height = since;
  let unknownPairs = 0;
  const totals = new Deltas();

  /** Trades, transfers and balances of the account in `account` (or the key's own). */
  const syncAccount = async () => {
    // Trades: oldest-first pages from a timestamp (each page comes newest first).
    for (let from = since + 1; ; ) {
      const page = await call<Trade[]>("/v1/mytrades", { timestamp: from, limit_trades: TRADES });
      if (!page.length) break;
      for (const t of page) {
        if (t.break === "full") continue; // reversed: never happened
        const pair = t.symbol ? geminiPair(t.symbol) : null;
        if (!pair) {
          unknownPairs++;
          continue;
        }
        const [base, quote] = pair;
        const d = new Deltas();
        const cost = mulDec(normDec(t.amount), normDec(t.price));
        d.add(base, normDec(t.amount), t.type === "Buy" ? 1 : -1);
        d.add(quote, cost, t.type === "Buy" ? -1 : 1);
        const fee =
          t.fee_amount && t.fee_currency && !isZeroDec(t.fee_amount)
            ? { asset: t.fee_currency.toUpperCase(), amount: normDec(t.fee_amount) }
            : null;
        mapped.push(
          ...movementsToTxns({
            externalId: `gemini:t:${t.tid}`,
            at: t.timestampms,
            txHash: null,
            deltas: d.toStrings(),
            fee,
          }),
        );
      }
      const newest = Math.max(...page.map((t) => t.timestampms));
      height = Math.max(height, newest);
      if (page.length < TRADES) break;
      from = newest + 1;
      await ctx.pause(300);
    }

    // Deposits, withdrawals and rewards.
    for (let from = since + 1; ; ) {
      const page = await call<Transfer[]>("/v1/transfers", {
        timestamp: from,
        limit_transfers: TRANSFERS,
      });
      if (!page.length) break;
      for (const x of page) {
        if (!/complete|advanced/i.test(x.status)) continue;
        const out = /withdraw/i.test(x.type);
        const asset = x.currency.toUpperCase();
        const d = new Deltas().add(asset, normDec(x.amount), out ? -1 : 1);
        const fee =
          x.feeAmount && !isZeroDec(x.feeAmount)
            ? { asset: (x.feeCurrency ?? x.currency).toUpperCase(), amount: normDec(x.feeAmount) }
            : null;
        for (const m of movementsToTxns({
          externalId: `gemini:x:${x.eid}`,
          at: x.timestampms,
          txHash: x.txHash ?? null,
          deltas: d.toStrings(),
          fee,
          label: /reward|interest|earn/i.test(`${x.type} ${x.purpose ?? ""}`) ? "reward" : null,
        }))
          mapped.push({ ...m, counterparty: out ? (x.destination ?? null) : null });
      }
      const newest = Math.max(...page.map((x) => x.timestampms));
      height = Math.max(height, newest);
      if (page.length < TRANSFERS) break;
      from = newest + 1;
      await ctx.pause(300);
    }

    const bal = await call<{ currency: string; amount: string }[]>("/v1/balances");
    for (const b of bal ?? []) totals.add(b.currency.toUpperCase(), normDec(b.amount));
  };

  // An account key covers its own account; a master key covers the group's
  // exchange accounts (listed first), all synced into this one wallet.
  const accounts = async () => {
    const list = await call<{ account?: string; type?: string; status?: string }[]>(
      "/v1/account/list",
      { limit_accounts: 500 },
    );
    const names = (Array.isArray(list) ? list : [])
      .filter((a) => (!a.type || a.type === "exchange") && a.status !== "closed")
      .map((a) => a.account)
      .filter((a): a is string => !!a);
    return names.length ? names : ["primary"];
  };
  let group: string[] | null = ctx.creds.key.trim().startsWith("master-") ? await accounts() : null;
  if (!group)
    try {
      await syncAccount();
    } catch (err) {
      if (!(err instanceof MissingAccount)) throw err;
      group = await accounts();
    }
  for (const a of group ?? []) {
    account = a;
    await syncAccount();
  }

  const balances = [...totals.toStrings()]
    .filter(([, v]) => !/^-?0(\.0*)?$/.test(v))
    .map(([asset, amount]) => ({ asset, amount }));
  return {
    mapped,
    height,
    balances,
    ...(unknownPairs
      ? {
          notice: `${unknownPairs} Gemini trades came without a market Muny recognizes and were left out.`,
        }
      : {}),
  };
};

/** Gemini wants an account named (a master key): list the group's accounts. */
class MissingAccount extends Error {}

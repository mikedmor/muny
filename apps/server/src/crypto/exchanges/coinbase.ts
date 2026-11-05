import { createPrivateKey, randomBytes, sign } from "node:crypto";
import { Deltas, FIAT, movementsToTxns, normDec, type SyncedTxn, subDec } from "@muny/core";
import { SyncError } from "../chains/ctx.js";
import { type ExchangeAdapter, keyRefused } from "./http.js";

/**
 * Coinbase through its account API (api.coinbase.com/v2): every account's
 * transactions. Needs a CDP "Secret API key" with the View permission and the
 * ECDSA (ES256) signature algorithm; each request carries a JWT that lives for
 * two minutes. Both sides of a buy, sell, conversion or Advanced Trade fill are
 * grouped into one trade.
 */

const HOST = "api.coinbase.com";
const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

interface Money {
  amount: string;
  currency: string;
}
interface CbAccount {
  id: string;
  currency: { code: string } | string;
  balance: Money;
  created_at?: string;
  updated_at?: string;
}
interface CbTxn {
  id: string;
  type: string;
  status: string;
  amount: Money;
  native_amount?: Money;
  created_at: string;
  network?: { hash?: string; transaction_fee?: Money; transaction_amount?: Money };
  to?: { address?: string };
  from?: { address?: string };
  buy?: { id: string };
  sell?: { id: string };
  trade?: { id: string };
  advanced_trade_fill?: { order_id?: string };
}
interface Page<T> {
  data: T[];
  pagination?: { next_uri?: string | null };
}

/** Rewards and staking payouts: income when received. */
const STAKING = new Set(["staking_reward", "inflation_reward", "interest", "earn_payout"]);
const REWARD = new Set([
  "incentives_rewards_payout",
  "learning_reward",
  "coinbase_earn",
  "subscription_rebate",
  "airdrop",
]);

export const coinbase: ExchangeAdapter = async (ctx) => {
  let key: ReturnType<typeof createPrivateKey>;
  try {
    key = createPrivateKey(ctx.creds.secret.trim().replace(/\\n/g, "\n"));
  } catch {
    throw new SyncError(
      "That Coinbase private key isn't readable. Paste the whole key, from -----BEGIN EC PRIVATE KEY----- to the end; Ed25519 keys don't work with Coinbase's account API.",
    );
  }
  const name = ctx.creds.key.trim();
  const jwt = (method: string, path: string) => {
    const now = Math.floor(Date.now() / 1000);
    const head = b64url(
      JSON.stringify({
        alg: "ES256",
        kid: name,
        nonce: randomBytes(16).toString("hex"),
        typ: "JWT",
      }),
    );
    const body = b64url(
      JSON.stringify({
        sub: name,
        iss: "cdp",
        nbf: now,
        exp: now + 120,
        uri: `${method} ${HOST}${path}`,
      }),
    );
    const sig = sign("sha256", Buffer.from(`${head}.${body}`), { key, dsaEncoding: "ieee-p1363" });
    return `${head}.${body}.${b64url(sig)}`;
  };
  const get = async <T>(pathAndQuery: string): Promise<T> => {
    const path = pathAndQuery.split("?")[0] as string;
    const res = await ctx.request<T & { errors?: { id?: string }[] }>(
      `https://${HOST}${pathAndQuery}`,
      {
        headers: { authorization: `Bearer ${jwt("GET", path)}`, "cb-version": "2024-01-01" },
      },
    );
    if (res.status === 401 || res.status === 403) throw keyRefused("Coinbase");
    if (res.status >= 400) throw new SyncError(`Coinbase answered HTTP ${res.status}`);
    return res.body;
  };
  const all = async <T>(first: string, stop?: (x: T) => boolean): Promise<T[]> => {
    const out: T[] = [];
    let next: string | null | undefined = first;
    while (next) {
      const page: Page<T> = await get<Page<T>>(next);
      for (const x of page.data ?? []) {
        if (stop?.(x)) return out;
        out.push(x);
      }
      next = page.pagination?.next_uri;
    }
    return out;
  };

  const since = ctx.cursor?.height ?? 0;
  const accounts = await all<CbAccount>("/v2/accounts?limit=250");
  const code = (a: CbAccount) =>
    (typeof a.currency === "string" ? a.currency : (a.currency?.code ?? "")).toUpperCase();

  // Transactions newer than the last sync, from accounts that changed since.
  const txns: CbTxn[] = [];
  for (const a of accounts) {
    const empty = !a.balance?.amount || /^-?0(\.0*)?$/.test(a.balance.amount);
    if (since && empty && a.updated_at && Date.parse(a.updated_at) <= since) continue;
    // Coinbase lists a wallet for every coin it supports; empty, untouched ones have no history.
    if (empty && a.created_at && a.created_at === a.updated_at) continue;
    const list = await all<CbTxn>(
      `/v2/accounts/${encodeURIComponent(a.id)}/transactions?limit=100`,
      (x) => Date.parse(x.created_at) <= since,
    );
    txns.push(...list.filter((x) => x.status === "completed"));
  }

  // Both sides of one buy / sell / conversion / fill become one trade.
  const groupKey = (x: CbTxn) =>
    x.advanced_trade_fill?.order_id
      ? `fill:${x.advanced_trade_fill.order_id}:${x.created_at}`
      : x.buy?.id
        ? `buy:${x.buy.id}`
        : x.sell?.id
          ? `sell:${x.sell.id}`
          : x.trade?.id
            ? `trade:${x.trade.id}`
            : `tx:${x.id}`;
  const groups = new Map<string, CbTxn[]>();
  for (const x of txns) groups.set(groupKey(x), [...(groups.get(groupKey(x)) ?? []), x]);

  const mapped: SyncedTxn[] = [];
  let height = since;
  for (const [k, list] of groups) {
    const first = list[0] as CbTxn;
    const at = Math.min(...list.map((x) => Date.parse(x.created_at)));
    height = Math.max(height, ...list.map((x) => Date.parse(x.created_at)));
    const d = new Deltas();
    let fee: { asset: string; amount: string } | null = null;
    for (const x of list) {
      const cur = x.amount.currency.toUpperCase();
      const amt = normDec(x.amount.amount);
      const netFee = x.network?.transaction_fee;
      if (
        x.type === "send" &&
        amt.startsWith("-") &&
        netFee &&
        netFee.currency.toUpperCase() === cur
      ) {
        // A send's amount includes the network fee.
        const total = amt.slice(1);
        const sent = x.network?.transaction_amount?.amount ?? subDec(total, netFee.amount);
        d.add(cur, normDec(sent), -1);
        fee = { asset: cur, amount: normDec(netFee.amount) };
      } else d.add(cur, amt);
    }
    // A buy or sell paid with a card or bank has no cash side in any account.
    const coins = [...d.map.keys()];
    const native = first.native_amount;
    if (
      (k.startsWith("buy:") || k.startsWith("sell:")) &&
      native &&
      !coins.some((c) => FIAT.has(c))
    )
      d.add(
        native.currency.toUpperCase(),
        normDec(native.amount.replace(/^-/, "")),
        k.startsWith("buy:") ? -1 : 1,
      );
    const label = STAKING.has(first.type) ? "staking" : REWARD.has(first.type) ? "reward" : null;
    const txs = movementsToTxns({
      externalId: `coinbase:${k}`,
      at,
      txHash: first.network?.hash ?? null,
      deltas: d.toStrings(),
      fee,
      label,
    });
    for (const m of txs)
      mapped.push({
        ...m,
        counterparty:
          first.type === "send"
            ? ((m.receivedAsset ? first.from?.address : first.to?.address) ?? null)
            : null,
      });
  }

  const totals = new Deltas();
  for (const a of accounts) if (a.balance?.amount) totals.add(code(a), normDec(a.balance.amount));
  const balances = [...totals.toStrings()]
    .filter(([, v]) => !/^-?0(\.0*)?$/.test(v))
    .map(([asset, amount]) => ({ asset, amount }));
  return { mapped, height, balances };
};

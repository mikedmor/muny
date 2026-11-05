import { createHash, createHmac } from "node:crypto";
import { Deltas, movementsToTxns, normDec, type SyncedTxn } from "@muny/core";
import { SyncError } from "../chains/ctx.js";
import { type ExchangeAdapter, keyRefused } from "./http.js";

/**
 * Kraken through its ledger (POST /0/private/Ledgers): every balance change,
 * newest first, 50 per page, grouped by reference id (a trade's two sides
 * share one). Needs a key with Query Funds and Query Ledger Entries only.
 */

const API = "https://api.kraken.com";
const PAGE = 50;

/** Kraken's own asset codes → common symbols. */
const CODES: Record<string, string> = {
  XXBT: "BTC",
  XBT: "BTC",
  XXDG: "DOGE",
  XDG: "DOGE",
  ZUSD: "USD",
  ZEUR: "EUR",
  ZGBP: "GBP",
  ZCAD: "CAD",
  ZJPY: "JPY",
  ZAUD: "AUD",
  ZCHF: "CHF",
  XETH: "ETH",
  ETH2: "ETH",
  XETC: "ETC",
  XLTC: "LTC",
  XXRP: "XRP",
  XXLM: "XLM",
  XXMR: "XMR",
  XZEC: "ZEC",
  XREP: "REP",
  XMLN: "MLN",
  XNMC: "NMC",
  XXTZ: "XTZ",
};

/**
 * "XXBT" → BTC; staked and earn variants ("DOT.S", "ETH2.S", "USDC.M",
 * "SOL.F", "ADA.B") count as the coin itself, so moving into staking is no
 * change in what you hold.
 */
export function krakenAsset(code: string): string {
  const base = code.toUpperCase().replace(/\.(S|M|F|B|P|HOLD)$/, "");
  return CODES[base] ?? base;
}

interface LedgerEntry {
  refid: string;
  time: number;
  type: string;
  subtype?: string;
  asset: string;
  amount: string;
  fee: string;
}

let lastNonce = 0;
const nonce = () => {
  lastNonce = Math.max(Date.now() * 1000, lastNonce + 1);
  return String(lastNonce);
};

export const kraken: ExchangeAdapter = async (ctx) => {
  const secret = Buffer.from(ctx.creds.secret.trim(), "base64");
  const call = async <T>(path: string, params: Record<string, string> = {}): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      const n = nonce();
      const body = new URLSearchParams({ nonce: n, ...params }).toString();
      const sha = createHash("sha256")
        .update(n + body)
        .digest();
      const sign = createHmac("sha512", secret)
        .update(Buffer.concat([Buffer.from(path), sha]))
        .digest("base64");
      const res = await ctx.request<{ error?: string[]; result?: T }>(`${API}${path}`, {
        method: "POST",
        body,
        headers: {
          "API-Key": ctx.creds.key.trim(),
          "API-Sign": sign,
          "content-type": "application/x-www-form-urlencoded",
        },
      });
      const err = res.body?.error ?? [];
      if (err.some((e) => /Rate limit|Too many requests/i.test(e))) {
        if (!ctx.deps.delayMs || attempt >= 3)
          throw new SyncError("Kraken rate limit hit; try again later");
        await ctx.pause(15_000 * (attempt + 1));
        continue;
      }
      if (err.some((e) => /Invalid key|Invalid signature|Permission denied|Invalid nonce/i.test(e)))
        throw keyRefused(
          "Kraken",
          err.some((e) => /Permission/i.test(e))
            ? "it needs Query Funds and Query Ledger Entries"
            : undefined,
        );
      if (err.length || !res.body?.result)
        throw new SyncError(`Kraken answered with an error (${(err[0] ?? "").slice(0, 60)})`);
      return res.body.result;
    }
  };

  // History since the last sync (Kraken's `start` is exclusive, in seconds).
  const since = ctx.cursor?.height ?? 0;
  const entries: LedgerEntry[] = [];
  for (let ofs = 0; ; ofs += PAGE) {
    const r = await call<{ ledger: Record<string, LedgerEntry>; count: number }>(
      "/0/private/Ledgers",
      { ofs: String(ofs), ...(since ? { start: String(since) } : {}) },
    );
    const page = Object.values(r.ledger ?? {});
    entries.push(...page);
    if (page.length < PAGE || ofs + PAGE >= r.count) break;
    // Ledger calls cost 2 of a counter that refills about one point every 3 s.
    await ctx.pause(4_000);
  }

  const groups = new Map<string, LedgerEntry[]>();
  for (const e of entries) groups.set(e.refid, [...(groups.get(e.refid) ?? []), e]);
  const mapped: SyncedTxn[] = [];
  let height = since;
  for (const [refid, list] of groups) {
    const at = Math.round(Math.min(...list.map((e) => Number(e.time))) * 1000);
    height = Math.max(height, ...list.map((e) => Math.floor(Number(e.time))));
    const d = new Deltas();
    const fees = new Deltas();
    for (const e of list) {
      const asset = krakenAsset(e.asset);
      // Kraken's amount is gross; the fee comes off on top.
      d.add(asset, normDec(e.amount));
      if (e.fee) fees.add(asset, normDec(e.fee));
    }
    // One fee on the row; any other fee coin comes off its amount.
    const [fee, ...more] = [...fees.toStrings()]
      .filter(([, v]) => !v.startsWith("-"))
      .map(([asset, amount]) => ({ asset, amount }));
    for (const f of more) d.add(f.asset, f.amount, -1);
    const kinds = new Set(list.map((e) => e.type));
    const reward =
      kinds.has("staking") ||
      list.some((e) => e.type === "earn" && /reward/i.test(e.subtype ?? ""));
    mapped.push(
      ...movementsToTxns({
        externalId: `kraken:${refid}`,
        at,
        txHash: null,
        deltas: d.toStrings(),
        fee: fee ?? null,
        label: reward ? "staking" : null,
      }),
    );
  }

  const bal = await call<Record<string, string>>("/0/private/Balance");
  const totals = new Deltas();
  for (const [code, amount] of Object.entries(bal ?? {})) totals.add(krakenAsset(code), amount);
  const balances = [...totals.toStrings()]
    .filter(([, v]) => !/^-?0(\.0*)?$/.test(v))
    .map(([asset, amount]) => ({ asset, amount }));

  return { mapped, height, balances };
};

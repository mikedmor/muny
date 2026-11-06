import { createHmac } from "node:crypto";
import { Deltas, FIAT, isZeroDec, movementsToTxns, normDec, type SyncedTxn } from "@muny/core";
import { SyncError } from "../chains/ctx.js";
import { type ExchangeAdapter, keyRefused } from "./http.js";

/**
 * Binance US through its REST API, with a key that can only read. Its history
 * endpoints answer one coin (or one market) at a time, deposits and
 * withdrawals in windows of up to 90 days, so Muny asks only about coins this
 * wallet has held (balances, earlier rows, imports) and markets between them.
 * Covered: spot trades, quick buys/sells and conversions, crypto deposits and
 * withdrawals, staking rewards and distributions (airdrops, rebates).
 */

const API = "https://api.binance.us";
/** Binance.US opened in September 2019. */
const OPENED = Date.UTC(2019, 8, 1);
const WINDOW = 89 * 86_400_000;
const QUOTES = new Set(["USD", "USDT", "USDC", "BUSD", "BTC", "ETH"]);

interface ApiError {
  code?: number;
  msg?: string;
}

export const binanceus: ExchangeAdapter = async (ctx) => {
  const notes: string[] = [];
  const call = async <T>(
    path: string,
    params: Record<string, string | number | undefined> = {},
    signed = true,
  ): Promise<T> => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
    if (signed) {
      q.set("recvWindow", "10000");
      q.set("timestamp", String(Date.now()));
      q.set(
        "signature",
        createHmac("sha256", ctx.creds.secret.trim()).update(q.toString()).digest("hex"),
      );
    }
    const res = await ctx.request<T & ApiError>(`${API}${path}?${q}`, {
      headers: signed ? { "X-MBX-APIKEY": ctx.creds.key.trim() } : {},
    });
    const err = res.body as ApiError | null;
    if (res.status === 401 || err?.code === -2014 || err?.code === -2015 || err?.code === -1022)
      throw keyRefused("Binance US");
    if (err?.code === -1021)
      throw new SyncError("Binance US says this server's clock is off; check the NAS time");
    if (res.status >= 400 || (err && typeof err.code === "number" && err.code < 0))
      throw new BinanceError(err?.msg ?? `HTTP ${res.status}`);
    return res.body;
  };
  /** Optional parts: a refusal is noted, not fatal. */
  const optional = async <T>(what: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof BinanceError) {
        notes.push(what);
        return null;
      }
      throw err;
    }
  };

  const since = ctx.cursor?.height ?? 0;
  const start = since || OPENED;
  const now = Date.now();
  const pos = { ...(ctx.cursor?.pos ?? {}) };
  const mapped: SyncedTxn[] = [];
  let height = since;
  const add = (g: Parameters<typeof movementsToTxns>[0], counterparty?: string | null) => {
    height = Math.max(height, g.at);
    for (const m of movementsToTxns(g)) mapped.push({ ...m, counterparty: counterparty ?? null });
  };

  const account = await call<{ balances: { asset: string; free: string; locked: string }[] }>(
    "/api/v3/account",
  );
  const totals = new Deltas();
  for (const b of account.balances ?? []) {
    totals.add(b.asset.toUpperCase(), normDec(b.free));
    totals.add(b.asset.toUpperCase(), normDec(b.locked));
  }
  const balances = [...totals.toStrings()]
    .filter(([, v]) => !isZeroDec(v))
    .map(([asset, amount]) => ({ asset, amount }));
  const coins = new Set(
    [...ctx.knownAssets, ...balances.map((b) => b.asset)].map((a) => a.toUpperCase()),
  );

  // Deposits and withdrawals, coin by coin (whole range first; 90-day windows if refused).
  // Binance answers a longer range with just part of it (no error), so history
  // is always asked for in windows of at most 90 days.
  const windows = () => {
    const out: [number, number][] = [];
    for (let from = start; from < now; from += WINDOW)
      out.push([from, Math.min(now, from + WINDOW)]);
    return out;
  };
  const ranged = async <T>(path: string, coin: string): Promise<T[]> => {
    const out: T[] = [];
    for (let from = start; from < now; from += WINDOW) {
      out.push(
        ...(await call<T[]>(path, {
          coin,
          startTime: from,
          endTime: Math.min(now, from + WINDOW),
          limit: 1000,
        })),
      );
      await ctx.pause(250);
    }
    return out;
  };
  for (const coin of coins) {
    if (FIAT.has(coin)) continue;
    const deps = await optional(`${coin} deposits`, () =>
      ranged<{
        amount: string;
        coin: string;
        status: number;
        txId?: string;
        insertTime: number;
        address?: string;
      }>("/sapi/v1/capital/deposit/hisrec", coin),
    );
    for (const x of deps ?? []) {
      if (x.status !== 1 && x.status !== 6) continue;
      add({
        externalId: `binanceus:dep:${x.txId || `${coin}:${x.insertTime}`}`,
        at: x.insertTime,
        txHash: x.txId?.replace(/^Internal transfer.*$/i, "") || null,
        deltas: new Deltas().add(coin, normDec(x.amount)).toStrings(),
      });
    }
    const wds = await optional(`${coin} withdrawals`, () =>
      ranged<{
        id: string;
        amount: string;
        transactionFee?: string;
        coin: string;
        status: number;
        applyTime: string;
        address?: string;
        txId?: string;
      }>("/sapi/v1/capital/withdraw/history", coin),
    );
    for (const x of wds ?? []) {
      if (x.status !== 6) continue;
      const at = Date.parse(`${x.applyTime.replace(" ", "T")}Z`);
      add(
        {
          externalId: `binanceus:wd:${x.id}`,
          at,
          txHash: x.txId || null,
          deltas: new Deltas().add(coin, normDec(x.amount), -1).toStrings(),
          fee:
            x.transactionFee && !isZeroDec(x.transactionFee)
              ? { asset: coin, amount: normDec(x.transactionFee) }
              : null,
        },
        x.address ?? null,
      );
    }
    await ctx.pause(250);
  }

  // Spot trades, market by market, from where the last sync stopped.
  const info = await call<{ symbols: { symbol: string; baseAsset: string; quoteAsset: string }[] }>(
    "/api/v3/exchangeInfo",
    {},
    false,
  );
  const markets = (info.symbols ?? []).filter(
    (s) => coins.has(s.baseAsset) && (coins.has(s.quoteAsset) || QUOTES.has(s.quoteAsset)),
  );
  for (const s of markets) {
    let fromId = Number(pos[`t:${s.symbol}`] ?? 0);
    for (;;) {
      const page = await call<
        {
          id: number;
          qty: string;
          quoteQty: string;
          commission: string;
          commissionAsset: string;
          time: number;
          isBuyer: boolean;
        }[]
      >("/api/v3/myTrades", { symbol: s.symbol, fromId, limit: 1000 });
      for (const t of page) {
        const d = new Deltas()
          .add(s.baseAsset, normDec(t.qty), t.isBuyer ? 1 : -1)
          .add(s.quoteAsset, normDec(t.quoteQty), t.isBuyer ? -1 : 1);
        add({
          externalId: `binanceus:t:${s.symbol}:${t.id}`,
          at: t.time,
          txHash: null,
          deltas: d.toStrings(),
          fee:
            t.commission && !isZeroDec(t.commission)
              ? { asset: t.commissionAsset.toUpperCase(), amount: normDec(t.commission) }
              : null,
        });
        fromId = Math.max(fromId, t.id + 1);
      }
      pos[`t:${s.symbol}`] = fromId;
      // myTrades weighs 20 of 1,200 a minute.
      await ctx.pause(1_100);
      if (page.length < 1000) break;
    }
  }

  // Quick buys / sells (card, bank) and conversions.
  for (const [path, list, what] of [
    ["/sapi/v1/ocbs/orders", "dataList", "buys and sells with card or bank"],
    ["/sapi/v1/otc/orders", "rows", "conversions"],
  ] as const) {
    for (const [wFrom, wTo] of windows())
      for (let page = 1; ; page++) {
        const res = await optional(what, () =>
          call<Record<string, unknown>>(path, { startTime: wFrom, endTime: wTo, page, limit: 100 }),
        );
        const rows = (res?.[list] as Record<string, string | number>[] | undefined) ?? [];
        for (const r of rows) {
          if (/fail|cancel|expire|pending|process|reject/i.test(String(r.orderStatus ?? "")))
            continue;
          const d = new Deltas()
            .add(String(r.fromCoin).toUpperCase(), normDec(String(r.fromAmount)), -1)
            .add(String(r.toCoin).toUpperCase(), normDec(String(r.toAmount)));
          add({
            externalId: `binanceus:o:${r.orderId}`,
            at: Number(r.createTime),
            txHash: null,
            deltas: d.toStrings(),
            fee:
              r.feeAmount && !isZeroDec(String(r.feeAmount))
                ? { asset: String(r.feeCoin).toUpperCase(), amount: normDec(String(r.feeAmount)) }
                : null,
          });
        }
        if (rows.length < 100) break;
        await ctx.pause(250);
      }
  }

  // Staking rewards and distributions (airdrops, rebates).
  for (const [wFrom, wTo] of windows())
    for (let page = 1; ; page++) {
      const res = await optional("staking rewards", () =>
        call<{ data?: { asset: string; amount: string; time: number; tranId: number | string }[] }>(
          "/sapi/v1/staking/stakingRewardsHistory",
          { startTime: wFrom, endTime: wTo, page, limit: 500 },
        ),
      );
      const rows = res?.data ?? [];
      for (const r of rows)
        add({
          externalId: `binanceus:s:${r.tranId}`,
          at: r.time,
          txHash: null,
          deltas: new Deltas().add(r.asset.toUpperCase(), normDec(r.amount)).toStrings(),
          label: "staking",
        });
      if (rows.length < 500) break;
    }
  const dist: {
    rows: {
      asset: string;
      amount: string;
      divTime: number;
      tranId: number | string;
      category?: string;
    }[];
  } = { rows: [] };
  for (const [wFrom, wTo] of windows()) {
    const part = await optional("distributions", () =>
      call<{
        rows?: {
          asset: string;
          amount: string;
          divTime: number;
          tranId: number | string;
          category?: string;
        }[];
      }>("/sapi/v1/asset/assetDistributionHistory", { startTime: wFrom, endTime: wTo, limit: 500 }),
    );
    dist.rows.push(...(part?.rows ?? []));
    await ctx.pause(250);
  }
  for (const r of dist?.rows ?? [])
    add({
      externalId: `binanceus:d:${r.tranId}`,
      at: r.divTime,
      txHash: null,
      deltas: new Deltas().add(r.asset.toUpperCase(), normDec(r.amount)).toStrings(),
      label: /airdrop/i.test(r.category ?? "") ? "airdrop" : "reward",
    });

  return {
    mapped,
    height: Math.max(height, now - 60_000),
    balances,
    pos,
    ...(notes.length
      ? {
          notice: `Binance US didn't answer for ${[...new Set(notes)].slice(0, 4).join(", ")}${notes.length > 4 ? "…" : ""}; those aren't included.`,
        }
      : {}),
  };
};

/** Binance refused one request (not the key): the caller decides. */
class BinanceError extends Error {}

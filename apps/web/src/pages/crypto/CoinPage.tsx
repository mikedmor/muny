import { type CoinPage as CoinPageData, type CryptoTxn, formatMoney, liveKey } from "@muny/shared";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { CoinIcon } from "../../components/coins.js";
import { PriceAlertButton } from "../../components/PriceAlerts.js";
import { TradingChart } from "../../components/TradingChart.js";
import { Alert, Card, cx } from "../../components/ui.js";
import { api } from "../../lib/api.js";
import { fmtLive, useLiveQuotes } from "../../lib/live.js";
import { useCryptoOverview, useCryptoTxns } from "../../lib/queries.js";
import { NewsCard } from "../StockDetailPage.js";
import { Pct } from "./CryptoDashboard.js";
import { dayLabel, fmtAmount, fmtPrice, labelName } from "./common.js";

/**
 * One coin, like a stock's page: its price and trading chart, what you hold
 * of it in each wallet, its transactions, and (with news on) recent stories.
 */

/** What a transaction did with this coin: + received, - sent. */
function moved(t: CryptoTxn, asset: string): { amount: string; sign: 1 | -1 } | null {
  if (t.receivedAsset === asset && t.receivedAmount) return { amount: t.receivedAmount, sign: 1 };
  if (t.sentAsset === asset && t.sentAmount) return { amount: t.sentAmount, sign: -1 };
  if (t.feeAsset === asset && t.feeAmount) return { amount: t.feeAmount, sign: -1 };
  return null;
}

const TYPE: Record<string, string> = {
  deposit: "Received",
  withdrawal: "Sent",
  trade: "Trade",
  transfer: "Transfer",
};

export function CoinPage() {
  const { asset: raw } = useParams({ strict: false }) as { asset: string };
  const asset = decodeURIComponent(raw).toUpperCase();
  const page = useQuery({
    queryKey: ["coin", asset],
    queryFn: () => api.get<CoinPageData>(`/api/crypto/coins/${encodeURIComponent(asset)}`),
  });
  const overview = useCryptoOverview();
  const txns = useCryptoTxns({ asset, limit: 25 });
  const tick = useLiveQuotes([liveKey("crypto", asset)]).get(liveKey("crypto", asset));
  const h = overview.data?.holdings.find((x) => x.asset === asset);
  const p = page.data;
  const price = tick?.price ?? (h?.price ? Number(h.price) : (p?.history.at(-1)?.close ?? null));
  const change = tick?.changePct ?? h?.change24hPct ?? null;
  const gains =
    h && h.valueCents !== null && h.costCents !== null ? h.valueCents - h.costCents : null;
  const candlesOn = !!p?.liveOn && p.onCoinbase !== false;
  const held = (h?.wallets ?? []).filter((w) => Number(w.amount) > 0);

  return (
    <>
      <Link
        to="/crypto"
        className="mb-2 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
      >
        <ArrowLeft aria-hidden="true" className="size-4" /> Crypto
      </Link>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <CoinIcon asset={asset} />
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold">{asset}</h1>
            {h?.name && h.name !== asset && <p className="text-sm text-slate-500">{h.name}</p>}
          </div>
        </div>
        <PriceAlertButton
          kind="crypto"
          symbol={asset}
          price={price}
          className="rounded-lg border border-slate-300 p-2 dark:border-slate-700"
        />
      </div>
      {page.isError && <Alert>{page.error.message}</Alert>}

      <div className="space-y-5">
        <div>
          <p className="text-3xl font-semibold tabular-nums">
            {price !== null ? fmtLive(price) : "—"}
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 text-sm text-slate-500">
            <Pct v={change} />
            <span>24 hours</span>
            {tick && (
              <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                <span
                  aria-hidden="true"
                  className="size-1.5 animate-pulse rounded-full bg-current"
                />
                live
              </span>
            )}
          </p>
        </div>

        {p && (
          <TradingChart
            liveKey={liveKey("crypto", asset)}
            fallback={p.history}
            candlesOn={candlesOn}
            offNote={
              p.liveOn
                ? `Coinbase doesn't trade ${asset} in US dollars, so this is the daily closes Muny keeps.`
                : "Daily closes Muny keeps. Turn on live crypto prices in Settings → API for candles, volume and the 1-day view."
            }
            aria={`${asset} price`}
          />
        )}

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="min-w-0 space-y-5">
            {h ? (
              <Card className="space-y-3">
                <h2 className="font-semibold">Your position</h2>
                <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
                  {(
                    [
                      ["Amount", fmtAmount(h.amount)],
                      ["Value", h.valueCents !== null ? formatMoney(h.valueCents) : "—"],
                      [
                        "Cost",
                        h.costCents !== null
                          ? `${formatMoney(h.costCents)}${h.costIncomplete ? "*" : ""}`
                          : "—",
                      ],
                      [
                        "Of your crypto",
                        `${h.allocationPct.toFixed(h.allocationPct < 1 ? 1 : 0)}%`,
                      ],
                    ] as const
                  ).map(([k, v]) => (
                    <div key={k}>
                      <dt className="text-xs text-slate-500">{k}</dt>
                      <dd className="mt-0.5 font-medium tabular-nums">{v}</dd>
                    </div>
                  ))}
                </dl>
                {gains !== null && (
                  <p className="text-sm">
                    Gain{" "}
                    <span
                      className={cx(
                        "font-medium tabular-nums",
                        gains >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600",
                      )}
                    >
                      {gains >= 0 ? "+" : ""}
                      {formatMoney(gains)}
                      {h.costCents
                        ? ` (${gains >= 0 ? "+" : ""}${((gains / h.costCents) * 100).toFixed(1)}%)`
                        : ""}
                    </span>
                  </p>
                )}
                {h.costIncomplete && (
                  <p className="text-xs text-slate-500">
                    * Part of the cost is unknown (missing history or prices).
                  </p>
                )}
                {held.length > 0 && (
                  <ul className="divide-y divide-slate-100 border-t border-slate-100 text-sm dark:divide-slate-800 dark:border-slate-800">
                    {held.map((w) => (
                      <li key={w.walletId} className="flex justify-between gap-3 py-2">
                        <Link
                          to="/crypto/wallets/$walletId"
                          params={{ walletId: w.walletId }}
                          className="truncate hover:underline"
                        >
                          {w.walletName}
                        </Link>
                        <span className="shrink-0 tabular-nums text-slate-500">
                          {fmtAmount(w.amount)}
                          {w.valueCents !== null ? ` · ${formatMoney(w.valueCents)}` : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {h.price && (
                  <p className="text-xs text-slate-500">
                    Valued at today's price, {fmtPrice(h.price)}.
                  </p>
                )}
              </Card>
            ) : (
              overview.data && (
                <Card className="text-sm text-slate-500">
                  You don't hold any {asset} right now.
                </Card>
              )
            )}

            <Card className="p-0">
              <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-800">
                <h2 className="font-semibold">Your activity</h2>
                <Link
                  to="/crypto/transactions"
                  search={{ asset }}
                  className="text-sm text-brand-600 hover:underline dark:text-brand-500"
                >
                  All of it
                </Link>
              </div>
              {txns.data?.items.length === 0 && (
                <p className="px-4 py-6 text-sm text-slate-500">No transactions with {asset}.</p>
              )}
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {txns.data?.items.map((t) => {
                  const m = moved(t, asset);
                  return (
                    <li key={t.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                      <span className="w-24 shrink-0 text-xs text-slate-500 tabular-nums">
                        {dayLabel(t.at)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="font-medium">
                          {labelName(t.label) || TYPE[t.type] || t.type}
                        </span>
                        <span className="block truncate text-xs text-slate-500">
                          {t.walletName}
                        </span>
                      </span>
                      {m && (
                        <span
                          className={cx(
                            "shrink-0 text-right font-medium tabular-nums",
                            m.sign > 0 && "text-emerald-600 dark:text-emerald-400",
                          )}
                        >
                          {m.sign > 0 ? "+" : "−"}
                          {fmtAmount(m.amount)}
                          {t.valueCents !== null && (
                            <span className="block text-xs font-normal text-slate-500">
                              {formatMoney(Math.abs(t.valueCents))}
                            </span>
                          )}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </Card>
          </div>
          <div className="min-w-0">
            {p?.newsOn ? (
              <NewsCard news={p.news} failed={p.newsFailed} />
            ) : (
              p && (
                <Card className="text-sm text-slate-500">
                  Turn on <span className="font-medium">Stock details and news</span> in Settings →
                  API to see recent stories about {asset} here (from Yahoo Finance; only the coin's
                  symbol is sent).
                </Card>
              )
            )}
          </div>
        </div>
      </div>
    </>
  );
}

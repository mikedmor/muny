import {
  formatMoney,
  INVEST_TXN_LABELS,
  liveKey,
  SECURITY_TYPE_LABELS,
  type StockLive,
  type StockPage,
} from "@muny/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { ArrowLeft, ExternalLink, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { ApiLimitNotice, useApiLimit } from "../components/ApiLimit.js";
import { LineChart } from "../components/charts.js";
import { PriceAlertButton } from "../components/PriceAlerts.js";
import { Alert, Button, Card, cx } from "../components/ui.js";
import { useLiveQuotes } from "../lib/live.js";
import {
  fetchStockFresh,
  stockKey,
  useSetInvestSettings,
  useStock,
  useWatchAdd,
} from "../lib/queries.js";
import { Pct } from "./crypto/CryptoDashboard.js";
import { fmtAmount } from "./crypto/common.js";
import { StockLogo } from "./StocksMarket.js";

/**
 * One stock: your position and trades from Muny's own data, and, when turned
 * on, live details and recent news from Yahoo Finance (only the ticker is sent).
 */

const RANGES = [
  ["1M", 31],
  ["6M", 183],
  ["YTD", -1],
  ["1Y", 366],
  ["5Y", 0],
] as const;
type Range = (typeof RANGES)[number][0];

const price = (n: number | null | undefined, currency = "USD") =>
  n === null || n === undefined
    ? "—"
    : n.toLocaleString(undefined, {
        style: "currency",
        currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: n < 1 ? 4 : 2,
      });

const compact = (n: number | null) =>
  n === null ? "—" : n.toLocaleString(undefined, { notation: "compact", maximumFractionDigits: 1 });

const day = (d: string, withYear = true) =>
  new Date(`${d}T00:00:00`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {}),
  });

function ago(ms: number, now = Date.now()) {
  const m = Math.round((now - ms) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

/** Where the price sits between a low and a high. */
function RangeBar({
  low,
  high,
  at,
}: {
  low: number | null;
  high: number | null;
  at: number | null;
}) {
  if (low === null || high === null || high <= low) return <span>—</span>;
  const pos = at === null ? null : Math.min(100, Math.max(0, ((at - low) / (high - low)) * 100));
  return (
    <span className="block">
      <span className="flex justify-between text-sm tabular-nums">
        <span>{price(low)}</span>
        <span>{price(high)}</span>
      </span>
      <span className="relative mt-1.5 block h-1 rounded-full bg-slate-200 dark:bg-slate-700">
        {pos !== null && (
          <span
            aria-hidden="true"
            className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand-600 ring-2 ring-surface dark:ring-slate-900"
            style={{ left: `${pos}%` }}
          />
        )}
      </span>
    </span>
  );
}

function Chart({ page }: { page: StockPage }) {
  const [range, setRange] = useState<Range>("1Y");
  const all = page.live?.series.length ? page.live.series : page.history;
  const { points, partial } = useMemo(() => {
    const last = all.at(-1)?.date;
    if (!last) return { points: [], partial: false };
    const days = RANGES.find(([r]) => r === range)?.[1] ?? 0;
    const from =
      days === -1
        ? `${last.slice(0, 4)}-01-01`
        : days === 0
          ? ""
          : new Date(Date.parse(`${last}T00:00:00Z`) - days * 86_400_000)
              .toISOString()
              .slice(0, 10);
    const kept = all.filter((p) => p.date >= from);
    // Weekly past a year keeps the chart light.
    const thin =
      kept.length > 400
        ? kept.filter(
            (p, i) => i === kept.length - 1 || new Date(`${p.date}T00:00:00Z`).getUTCDay() === 5,
          )
        : kept;
    return {
      points: thin.map((p) => ({
        date: p.date,
        label: day(p.date, range === "5Y" || range === "1Y"),
        value: Math.round(p.close * 100),
      })),
      // Prices don't reach back that far: say where they start instead.
      partial: !from || (all[0]?.date ?? "") > from,
    };
  }, [all, range]);
  const first = points[0]?.value;
  const lastV = points.at(-1)?.value;
  const change = first && lastV !== undefined ? ((lastV - first) / first) * 100 : null;
  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm text-slate-500">
          {points.length > 1 ? (
            <>
              <Pct v={change} />{" "}
              {partial && points[0]
                ? `since ${day(points[0].date)}`
                : range === "YTD"
                  ? "this year"
                  : `over ${range}`}
            </>
          ) : null}
        </span>
        <div role="tablist" aria-label="Range" className="flex gap-1">
          {RANGES.map(([r]) => (
            <button
              key={r}
              type="button"
              role="tab"
              aria-selected={range === r}
              onClick={() => setRange(r)}
              className={cx(
                "rounded-md px-2 py-1 text-xs font-medium",
                range === r
                  ? "bg-brand-50 text-brand-700 dark:bg-brand-700/20 dark:text-brand-500"
                  : "text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800",
              )}
            >
              {r}
            </button>
          ))}
        </div>
      </div>
      {points.length > 1 ? (
        <LineChart ariaLabel={`${page.symbol} closing price`} height={220} points={points} fit />
      ) : (
        <p className="py-10 text-center text-sm text-slate-500">
          No price history for {page.symbol} yet.
        </p>
      )}
    </Card>
  );
}

function Stats({ live }: { live: StockLive }) {
  const cur = live.currency ?? "USD";
  const items: [string, React.ReactNode][] = [
    ["Previous close", price(live.previousClose, cur)],
    ["Volume", compact(live.volume)],
    ["Day's range", <RangeBar key="d" low={live.dayLow} high={live.dayHigh} at={live.price} />],
    ["52-week range", <RangeBar key="y" low={live.low52w} high={live.high52w} at={live.price} />],
  ];
  const returns: [string, number | null][] = [
    ["1 month", live.change1mPct],
    ["6 months", live.change6mPct],
    ["This year", live.changeYtdPct],
    ["1 year", live.change1yPct],
    ["5 years", live.change5yPct],
  ];
  return (
    <Card className="space-y-4">
      <dl className="grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2">
        {items.map(([k, v]) => (
          <div key={k}>
            <dt className="text-xs text-slate-500">{k}</dt>
            <dd className="mt-0.5 font-medium tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
      <dl className="grid grid-cols-3 gap-3 border-t border-slate-100 pt-4 text-sm sm:grid-cols-5 dark:border-slate-800">
        {returns.map(([k, v]) => (
          <div key={k}>
            <dt className="text-xs text-slate-500">{k}</dt>
            <dd className="mt-0.5">
              <Pct v={v} />
            </dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

function Position({ page }: { page: StockPage }) {
  const p = page.position;
  if (!p) return null;
  const shares = Number(p.quantity);
  const perShare = p.costBasisCents !== null && shares > 0 ? p.costBasisCents / 100 / shares : null;
  return (
    <Card className="space-y-3">
      <h2 className="font-semibold">Your position</h2>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
        {(
          [
            ["Shares", fmtAmount(p.quantity, 4)],
            ["Value", formatMoney(p.valueCents)],
            ["Cost", p.costBasisCents === null ? "—" : formatMoney(p.costBasisCents)],
            ["Cost / share", perShare === null ? "—" : price(perShare)],
          ] as const
        ).map(([k, v]) => (
          <div key={k}>
            <dt className="text-xs text-slate-500">{k}</dt>
            <dd className="mt-0.5 font-medium tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
      {p.gainCents !== null && (
        <p className="text-sm">
          Gain{" "}
          <span
            className={cx(
              "font-medium tabular-nums",
              p.gainCents >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600",
            )}
          >
            {p.gainCents >= 0 ? "+" : ""}
            {formatMoney(p.gainCents)}
            {p.costBasisCents
              ? ` (${p.gainCents >= 0 ? "+" : ""}${((p.gainCents / p.costBasisCents) * 100).toFixed(1)}%)`
              : ""}
          </span>
        </p>
      )}
      {p.accounts.length > 1 && (
        <ul className="divide-y divide-slate-100 border-t border-slate-100 text-sm dark:divide-slate-800 dark:border-slate-800">
          {p.accounts.map((a) => (
            <li key={a.accountId} className="flex justify-between gap-3 py-2">
              <span className="truncate">{a.accountName}</span>
              <span className="shrink-0 tabular-nums text-slate-500">
                {fmtAmount(a.quantity, 4)} sh · {formatMoney(a.valueCents)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Activity({ page }: { page: StockPage }) {
  if (!page.activity.length) return null;
  return (
    <Card className="p-0">
      <h2 className="border-b border-slate-200 px-4 py-3 font-semibold dark:border-slate-800">
        Your activity
      </h2>
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {page.activity.slice(0, 25).map((t) => (
          <li key={t.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
            <span className="w-24 shrink-0 text-xs text-slate-500 tabular-nums">{day(t.date)}</span>
            <span className="min-w-0 flex-1">
              <span className="font-medium">{INVEST_TXN_LABELS[t.type]}</span>
              {t.quantity && t.type !== "dividend" && (
                <span className="text-slate-500">
                  {" "}
                  · {fmtAmount(t.quantity, 4)} sh{t.price ? ` @ $${fmtAmount(t.price, 2)}` : ""}
                </span>
              )}
              <span className="block truncate text-xs text-slate-500">{t.accountName}</span>
            </span>
            <span
              className={cx(
                "shrink-0 font-medium tabular-nums",
                t.amountCents > 0 && "text-emerald-600 dark:text-emerald-400",
              )}
            >
              {t.amountCents ? formatMoney(t.amountCents) : ""}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function News({ live }: { live: StockLive }) {
  return (
    <Card className="p-0">
      <h2 className="border-b border-slate-200 px-4 py-3 font-semibold dark:border-slate-800">
        Recent news
      </h2>
      {live.news.length === 0 ? (
        <p className="px-4 py-6 text-sm text-slate-500">
          {live.newsFailed ? "The news couldn't be loaded. Try Refresh." : "No recent stories."}
        </p>
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {live.news.map((n) => (
            <li key={n.url}>
              <a
                href={n.url}
                target="_blank"
                rel="noopener noreferrer"
                className="group flex items-start gap-3 px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-800/40"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium group-hover:underline">{n.title}</span>
                  <span className="mt-0.5 block text-xs text-slate-500">
                    {[n.publisher, n.publishedAt ? ago(n.publishedAt) : null]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
                <ExternalLink
                  aria-hidden="true"
                  className="mt-0.5 size-3.5 shrink-0 text-slate-400"
                />
              </a>
            </li>
          ))}
        </ul>
      )}
      <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500 dark:border-slate-800">
        Stories open on the publisher's site.
      </p>
    </Card>
  );
}

function TurnOn() {
  const set = useSetInvestSettings();
  return (
    <Card className="flex flex-wrap items-center justify-between gap-3 text-sm">
      <p className="max-w-2xl text-slate-600 dark:text-slate-300">
        Muny can show this stock's live price, day and 52-week ranges, returns, five years of
        prices, and recent news. They come from Yahoo Finance; only the ticker is sent, never your
        holdings.
      </p>
      <Button disabled={set.isPending} onClick={() => set.mutate({ details: true })}>
        Show live details and news
      </Button>
    </Card>
  );
}

export function StockDetailPage() {
  const { symbol: raw } = useParams({ strict: false }) as { symbol: string };
  const symbol = decodeURIComponent(raw).toUpperCase();
  const qc = useQueryClient();
  const q = useStock(symbol);
  const watch = useWatchAdd();
  const limit = useApiLimit("yahoo");
  const refresh = useMutation({
    mutationFn: () => fetchStockFresh(symbol),
    onSuccess: (page) => qc.setQueryData(stockKey(symbol), page),
  });
  const page = q.data;
  const live = page?.live ?? null;
  const cur = live?.currency ?? "USD";
  const lastClose = page?.history.at(-1);
  const tick = useLiveQuotes([liveKey("stock", symbol)]).get(liveKey("stock", symbol));
  const shownPrice = tick?.price ?? live?.price ?? lastClose?.close ?? null;
  const dayPct = tick?.changePct ?? live?.change1dPct ?? null;

  return (
    <>
      <Link
        to="/stocks"
        className="mb-2 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
      >
        <ArrowLeft aria-hidden="true" className="size-4" /> Stocks
      </Link>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          {!symbol.startsWith("^") && <StockLogo symbol={symbol} />}
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold">{symbol}</h1>
            <p className="truncate text-sm text-slate-500">
              {[
                page?.name !== symbol ? page?.name : null,
                live?.exchange,
                page?.type && page.type !== "equity" ? SECURITY_TYPE_LABELS[page.type] : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <PriceAlertButton
            kind="stock"
            symbol={symbol}
            price={shownPrice}
            className="rounded-lg border border-slate-300 p-2 dark:border-slate-700"
          />
          {page && !page.watching && !page.position && (
            <Button
              variant="secondary"
              disabled={watch.isPending}
              onClick={() => watch.mutate(symbol)}
            >
              {watch.isPending ? "Adding…" : "Add to watch list"}
            </Button>
          )}
          {page?.liveOn && (
            <Button
              variant="secondary"
              disabled={refresh.isPending}
              onClick={() => refresh.mutate()}
              title="Get the latest price and news"
            >
              <RefreshCw
                aria-hidden="true"
                className={cx("mr-1.5 inline size-4", refresh.isPending && "animate-spin")}
              />
              {refresh.isPending ? "Refreshing…" : "Refresh"}
            </Button>
          )}
        </div>
      </div>

      {q.isError && <Alert>{q.error.message}</Alert>}
      {refresh.isError && <Alert>{refresh.error.message}</Alert>}
      {watch.isError && <Alert>{watch.error.message}</Alert>}
      {page && (
        <div className="space-y-5">
          <div>
            <p className="text-3xl font-semibold tabular-nums">{price(shownPrice, cur)}</p>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 text-sm text-slate-500">
              {tick ? (
                <>
                  <Pct v={dayPct} />
                  <span className="inline-flex items-center gap-1.5">
                    today
                    <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                      <span
                        aria-hidden="true"
                        className="size-1.5 animate-pulse rounded-full bg-current"
                      />
                      {tick.source === "yahoo" ? "every few minutes" : "live"}
                    </span>
                    · {ago(tick.at)}
                  </span>
                </>
              ) : live ? (
                <>
                  <Pct v={live.change1dPct} />
                  <span>today · updated {ago(live.updatedAt)}</span>
                </>
              ) : lastClose ? (
                <span>Close on {day(lastClose.date)}</span>
              ) : null}
            </p>
            {page.liveError && (
              <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                {live ? "Showing the last details Muny got. " : ""}
                {page.liveError}
              </p>
            )}
            {limit && <ApiLimitNotice limit={limit} className="mt-1" />}
          </div>

          {!page.liveOn && <TurnOn />}
          <Chart page={page} />

          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="min-w-0 space-y-5">
              {live && <Stats live={live} />}
              <Position page={page} />
              <Activity page={page} />
              {!live && !page.position && !page.activity.length && page.liveOn === false && (
                <p className="text-sm text-slate-500">
                  You don't hold {symbol}, and Muny has no trades in it.
                </p>
              )}
            </div>
            {live && (
              <div className="min-w-0">
                <News live={live} />
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

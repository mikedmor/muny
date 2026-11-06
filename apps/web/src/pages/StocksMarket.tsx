import type { MarketQuote } from "@muny/shared";
import { useState } from "react";
import { LineChart } from "../components/charts.js";
import { Card, cx } from "../components/ui.js";
import { MerchantAvatar } from "../components/visuals.js";
import {
  useInvestSettings,
  useMarket,
  useMarketIntraday,
  useSetInvestSettings,
} from "../lib/queries.js";

/** A company logo (when logos are on), else the letter badge. */
export function StockLogo({ symbol, size = "md" }: { symbol: string; size?: "sm" | "md" }) {
  const settings = useInvestSettings();
  const logos = settings.data?.logos ?? false;
  const [failed, setFailed] = useState(false);
  if (!logos || failed || !/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol))
    return <MerchantAvatar name={symbol} size={size} />;
  return (
    <img
      src={`/api/invest/logo/${encodeURIComponent(symbol)}`}
      alt=""
      aria-hidden="true"
      loading="lazy"
      onError={() => setFailed(true)}
      className={cx(
        "shrink-0 rounded-full bg-white object-contain p-1 ring-1 ring-slate-200 dark:ring-slate-700",
        size === "sm" ? "size-7" : "size-9",
      )}
    />
  );
}

const RANGES = [
  ["1D", 0],
  ["1W", 7],
  ["1M", 31],
  ["3M", 92],
  ["6M", 183],
  ["YTD", -1],
  ["1Y", 366],
] as const;
type Range = (typeof RANGES)[number][0];

/** A percentage on a soft colored pill (green up, red down). */
function PctPill({ v }: { v: number | null }) {
  if (v === null) return <span className="text-slate-400">—</span>;
  const up = v >= 0;
  return (
    <span
      className={cx(
        "inline-block min-w-16 rounded-md px-2 py-0.5 text-right text-xs font-medium tabular-nums",
        up
          ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
          : "bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400",
      )}
    >
      {up ? "+" : ""}
      {v.toFixed(2)}%
    </span>
  );
}

const fmt = (n: number) =>
  n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function IndexChip({
  q,
  active,
  onClick,
}: {
  q: MarketQuote;
  active: boolean;
  onClick?: () => void;
}) {
  const up = (q.change1dPct ?? 0) >= 0;
  const isFund = !q.symbol.startsWith("^");
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      aria-pressed={onClick ? active : undefined}
      className={cx(
        "flex min-w-36 flex-col items-start rounded-xl border px-3 py-2 text-left text-sm transition-colors",
        active
          ? "border-brand-500 bg-brand-50 dark:bg-brand-700/15"
          : "border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800/60",
        !onClick && "cursor-default hover:bg-transparent",
      )}
    >
      <span className="text-xs font-medium text-slate-500">
        {q.name}
        {isFund && <span className="ml-1 text-slate-400">{q.symbol}</span>}
      </span>
      <span className="flex items-baseline gap-2">
        <span className="font-semibold tabular-nums">
          {isFund ? "$" : ""}
          {fmt(q.price)}
        </span>
        {q.change1dPct !== null && (
          <span
            className={cx(
              "text-xs font-medium tabular-nums",
              up ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400",
            )}
          >
            {up ? "+" : ""}
            {q.change1dPct.toFixed(2)}%
          </span>
        )}
      </span>
    </button>
  );
}

function IndexChart({ q }: { q: MarketQuote }) {
  const [range, setRange] = useState<Range>("1M");
  const intraday = useMarketIntraday(q.symbol, range === "1D");
  const days = RANGES.find(([r]) => r === range)?.[1] ?? 31;
  const last = q.series.at(-1)?.date ?? new Date().toISOString().slice(0, 10);
  const from =
    days === -1
      ? `${last.slice(0, 4)}-01-01`
      : new Date(Date.parse(`${last}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
  const points =
    range === "1D"
      ? (intraday.data?.points ?? []).map((p) => ({
          date: String(p.t),
          label: new Date(p.t).toLocaleTimeString(undefined, {
            hour: "numeric",
            minute: "2-digit",
          }),
          value: Math.round(p.close * 100),
        }))
      : q.series
          .filter((p) => p.date >= from)
          .map((p) => ({
            date: p.date,
            label: new Date(`${p.date}T00:00:00`).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
            }),
            value: Math.round(p.close * 100),
          }));
  const first = points[0]?.value;
  const end = points.at(-1)?.value;
  const change =
    range === "1D" && intraday.data?.previousClose && end
      ? ((end / 100 - intraday.data.previousClose) / intraday.data.previousClose) * 100
      : first && end
        ? ((end - first) / first) * 100
        : null;
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm">
          <span className="font-medium">{q.name}</span>{" "}
          {change !== null && (
            <span
              className={cx(
                "text-xs font-medium tabular-nums",
                change >= 0
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-red-600 dark:text-red-400",
              )}
            >
              {change >= 0 ? "+" : ""}
              {change.toFixed(2)}% {range === "1D" ? "today" : `over ${range}`}
            </span>
          )}
        </p>
        <fieldset className="m-0 flex gap-1 border-0 p-0">
          <legend className="sr-only">Range</legend>
          {RANGES.map(([r]) => (
            <button
              key={r}
              type="button"
              aria-pressed={range === r}
              onClick={() => setRange(r)}
              className={cx(
                "rounded-md px-2 py-1 text-xs font-medium",
                range === r
                  ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
                  : "text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800",
              )}
            >
              {r}
            </button>
          ))}
        </fieldset>
      </div>
      {points.length >= 2 ? (
        <LineChart ariaLabel={`${q.name} over ${range}`} height={200} points={points} />
      ) : (
        <p className="py-10 text-center text-sm text-slate-500">
          {range === "1D" && intraday.isLoading
            ? "Loading today's prices…"
            : "No prices for this range."}
        </p>
      )}
    </div>
  );
}

/** Major indexes and sectors, like a brokerage's "Markets" page. */
export function MarketCard() {
  const market = useMarket(true);
  const [selected, setSelected] = useState("SPY");
  const m = market.data;
  const q = m?.indexes.find((x) => x.symbol === selected) ?? m?.indexes[0];
  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">Markets</h2>
        {m && (
          <span className="text-xs text-slate-500">
            Updated{" "}
            {new Date(m.updatedAt).toLocaleTimeString(undefined, {
              hour: "numeric",
              minute: "2-digit",
            })}
            {m.failed > 0 && ` · ${m.failed} couldn't be loaded`}
          </span>
        )}
      </div>
      {market.isLoading && <p className="py-6 text-sm text-slate-500">Loading the markets…</p>}
      {market.error && <p className="py-6 text-sm text-red-600">{market.error.message}</p>}
      {m && (
        <>
          <div className="mb-4 flex gap-2 overflow-x-auto pb-1">
            {m.indexes.map((x) => (
              <IndexChip
                key={x.symbol}
                q={x}
                active={x.symbol === q?.symbol}
                onClick={
                  x.series.length && !x.symbol.startsWith("^")
                    ? () => setSelected(x.symbol)
                    : undefined
                }
              />
            ))}
          </div>
          {q && <IndexChart key={q.symbol} q={q} />}
          {m.sectors.length > 0 && (
            <div className="mt-6 overflow-x-auto">
              <h3 className="mb-2 text-sm font-semibold">Sectors</h3>
              <table className="w-full min-w-[36rem] text-sm">
                <thead className="text-left text-xs text-slate-500">
                  <tr>
                    <th className="py-2 pr-2 font-medium">Sector</th>
                    <th className="px-2 py-2 text-right font-medium">1D</th>
                    <th className="px-2 py-2 text-right font-medium">1M</th>
                    <th className="px-2 py-2 text-right font-medium">6M</th>
                    <th className="px-2 py-2 text-right font-medium">1Y</th>
                    <th className="px-2 py-2 text-right font-medium">5Y</th>
                  </tr>
                </thead>
                <tbody>
                  {m.sectors.map((s) => (
                    <tr key={s.symbol} className="border-t border-slate-100 dark:border-slate-800">
                      <td className="py-2 pr-2">
                        <span className="font-medium">{s.name}</span>{" "}
                        <span className="text-xs text-slate-500">{s.symbol}</span>
                      </td>
                      <td className="px-2 py-2 text-right">
                        <PctPill v={s.change1dPct} />
                      </td>
                      <td className="px-2 py-2 text-right">
                        <PctPill v={s.change1mPct} />
                      </td>
                      <td className="px-2 py-2 text-right">
                        <PctPill v={s.change6mPct} />
                      </td>
                      <td className="px-2 py-2 text-right">
                        <PctPill v={s.change1yPct} />
                      </td>
                      <td className="px-2 py-2 text-right">
                        <PctPill v={s.change5yPct} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-slate-500">
                Index funds (SPY, QQQ, DIA, IWM) and Vanguard sector funds, from Yahoo Finance.
              </p>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

/** Offer the opt-in extras once (they fetch from outside services), and switches to change them later. */
export function StocksExtrasBanner({ onDismiss }: { onDismiss: () => void }) {
  const settings = useInvestSettings();
  const set = useSetInvestSettings();
  const d = settings.data;
  if (!d || (d.logos && d.market)) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-brand-500/30 bg-brand-50 px-4 py-3 text-sm dark:bg-brand-700/10">
      <p className="max-w-2xl text-slate-700 dark:text-slate-300">
        Muny can show company logos and a market overview (major indexes and sectors). They come
        from outside services: logos once per ticker, market prices at most hourly while you look.
        Only ticker symbols are sent, never your holdings.
      </p>
      <div className="flex flex-wrap gap-2">
        {!d.logos && (
          <button
            type="button"
            disabled={set.isPending}
            onClick={() => set.mutate({ logos: true })}
            className="rounded-lg bg-brand-600 px-3 py-1.5 font-medium text-white hover:bg-brand-700"
          >
            Show logos
          </button>
        )}
        {!d.market && (
          <button
            type="button"
            disabled={set.isPending}
            onClick={() => set.mutate({ market: true })}
            className="rounded-lg bg-brand-600 px-3 py-1.5 font-medium text-white hover:bg-brand-700"
          >
            Show market overview
          </button>
        )}
        <button
          type="button"
          onClick={onDismiss}
          className="rounded-lg px-3 py-1.5 text-slate-500 hover:bg-white/60 dark:hover:bg-slate-800"
        >
          Not now
        </button>
      </div>
    </div>
  );
}

export function StocksExtrasSwitches() {
  const settings = useInvestSettings();
  const set = useSetInvestSettings();
  const d = settings.data;
  if (!d) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-slate-500">
      <span className="font-medium">Extras</span>
      {(
        [
          ["logos", "Company logos"],
          ["market", "Market overview"],
        ] as const
      ).map(([k, label]) => (
        <label key={k} className="inline-flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={d[k]}
            onChange={(e) => set.mutate({ [k]: e.target.checked })}
            className="size-3.5 accent-brand-600"
          />
          {label}
        </label>
      ))}
      <span>
        Logos come from Financial Modeling Prep or Parqet, prices from Yahoo Finance; only tickers
        are sent.
      </span>
    </div>
  );
}

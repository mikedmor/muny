import type { MarketIntraday, MarketQuote } from "@muny/shared";
import { useQueries } from "@tanstack/react-query";
import { useState } from "react";
import { PercentLinesChart, type PercentSeries } from "../components/charts.js";
import { Card, cx } from "../components/ui.js";
import { MerchantAvatar } from "../components/visuals.js";
import { api } from "../lib/api.js";
import { investKeys, useInvestSettings, useMarket, useSetInvestSettings } from "../lib/queries.js";

/** A company logo (when logos are on), else the letter badge. */
/**
 * How to show a logo: "fill" when it has its own background (its corners are
 * painted), else "dark" or "light" backing depending on how bright the mark is.
 */
type LogoLook = "fill" | "dark" | "light";
const looks = new Map<string, LogoLook>();

function lookOf(img: HTMLImageElement): LogoLook {
  const n = 32;
  const c = document.createElement("canvas");
  c.width = n;
  c.height = n;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return "light";
  ctx.drawImage(img, 0, 0, n, n);
  const px = ctx.getImageData(0, 0, n, n).data;
  const alpha = (x: number, y: number) => px[(y * n + x) * 4 + 3] ?? 0;
  const corners = [alpha(1, 1), alpha(n - 2, 1), alpha(1, n - 2), alpha(n - 2, n - 2)];
  if (corners.every((a) => a > 200)) return "fill";
  let lum = 0;
  let count = 0;
  for (let i = 0; i < px.length; i += 4) {
    if ((px[i + 3] ?? 0) < 128) continue;
    lum += 0.2126 * (px[i] ?? 0) + 0.7152 * (px[i + 1] ?? 0) + 0.0722 * (px[i + 2] ?? 0);
    count++;
  }
  return count && lum / count > 180 ? "dark" : "light";
}

export function StockLogo({ symbol, size = "md" }: { symbol: string; size?: "sm" | "md" }) {
  const settings = useInvestSettings();
  const logos = settings.data?.logos ?? false;
  const [failed, setFailed] = useState(false);
  const [look, setLook] = useState<LogoLook | undefined>(() => looks.get(symbol));
  if (!logos || failed || !/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol))
    return <MerchantAvatar name={symbol} size={size} />;
  return (
    <img
      src={`/api/invest/logo/${encodeURIComponent(symbol)}`}
      alt=""
      aria-hidden="true"
      loading="lazy"
      onError={() => setFailed(true)}
      onLoad={(e) => {
        if (looks.has(symbol)) return;
        try {
          const l = lookOf(e.currentTarget);
          looks.set(symbol, l);
          setLook(l);
        } catch {
          setLook("light");
        }
      }}
      className={cx(
        "shrink-0 rounded-full ring-1 ring-slate-200 dark:ring-slate-700",
        size === "sm" ? "size-7" : "size-9",
        look === "fill"
          ? "object-cover"
          : look === "dark"
            ? "bg-slate-900 object-contain p-1.5"
            : "bg-white object-contain p-1.5",
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

/** Each index keeps a clearly different color. */
const INDEX_COLORS = [
  "var(--viz-series-1)",
  "var(--viz-series-2)",
  "var(--viz-series-3)",
  "var(--viz-series-5)",
  "var(--viz-series-7)",
];

const shortDay = (d: string) =>
  new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** All indexes on one percent axis, compared from the start of the range. */
function MarketChart({ indexes }: { indexes: MarketQuote[] }) {
  const [range, setRange] = useState<Range>("1M");
  const [focus, setFocus] = useState<string | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const intraday = useQueries({
    queries: indexes.map((q) => ({
      queryKey: [...investKeys.all, "market", "intraday", q.symbol],
      queryFn: () =>
        api.get<MarketIntraday>(
          `/api/invest/market/intraday?symbol=${encodeURIComponent(q.symbol)}`,
        ),
      enabled: range === "1D",
      staleTime: 5 * 60_000,
    })),
  });

  // Points shared by all lines: dates (or 5-minute times today), with each index's price.
  let keysList: string[] = [];
  let labels: string[] = [];
  const priceAt: Map<string, number>[] = indexes.map(() => new Map());
  const base: (number | null)[] = indexes.map(() => null);
  if (range === "1D") {
    const slot = (t: number) => String(Math.floor(t / 300_000) * 300_000);
    intraday.forEach((r, i) => {
      for (const p of r.data?.points ?? []) priceAt[i]?.set(slot(p.t), p.close);
      base[i] = r.data?.previousClose ?? r.data?.points[0]?.close ?? null;
    });
    keysList = [...new Set(priceAt.flatMap((m) => [...m.keys()]))].sort();
    labels = keysList.map((k) =>
      new Date(Number(k)).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }),
    );
  } else {
    const days = RANGES.find(([r]) => r === range)?.[1] ?? 31;
    const last = indexes[0]?.series.at(-1)?.date ?? new Date().toISOString().slice(0, 10);
    const from =
      days === -1
        ? `${Number(last.slice(0, 4)) - 1}-12-31`
        : new Date(Date.parse(`${last}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
    indexes.forEach((q, i) => {
      // The close on or before the start is the base.
      let b: number | null = null;
      for (const p of q.series) {
        if (p.date <= from) b = p.close;
        else priceAt[i]?.set(p.date, p.close);
      }
      base[i] = b ?? q.series.find((p) => p.date > from)?.close ?? null;
    });
    keysList = [...new Set(priceAt.flatMap((m) => [...m.keys()]))].sort();
    labels = keysList.map(shortDay);
  }
  // Fill gaps with the last price so every line is continuous.
  const prices = indexes.map((_, i) => {
    let lastSeen: number | null = null;
    return keysList.map((k) => {
      const v = priceAt[i]?.get(k);
      if (v !== undefined) lastSeen = v;
      return lastSeen;
    });
  });
  const series: PercentSeries[] = indexes.map((q, i) => ({
    key: q.symbol,
    label: q.name,
    color: INDEX_COLORS[i] ?? "var(--viz-other)",
    values: (prices[i] ?? []).map((v) => {
      const b0 = base[i];
      return v === null || !b0 ? null : ((v - b0) / b0) * 100;
    }),
  }));
  const at = hover ?? keysList.length - 1;
  const loading = range === "1D" && intraday.some((r) => r.isLoading);

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-2">
        {indexes.map((q, i) => {
          const price = prices[i]?.[at] ?? q.price;
          const change = series[i]?.values[at] ?? null;
          const up = (change ?? 0) >= 0;
          const isFund = !q.symbol.startsWith("^");
          return (
            <button
              key={q.symbol}
              type="button"
              onMouseEnter={() => setFocus(q.symbol)}
              onMouseLeave={() => setFocus(null)}
              onFocus={() => setFocus(q.symbol)}
              onBlur={() => setFocus(null)}
              className={cx(
                "flex items-center gap-2 rounded-xl border px-3 py-2 text-sm transition-opacity",
                "border-slate-200 dark:border-slate-700",
                focus !== null && focus !== q.symbol && "opacity-40",
              )}
            >
              <span
                aria-hidden="true"
                className="size-2.5 rounded-full"
                style={{ background: INDEX_COLORS[i] }}
              />
              <span className="font-medium">{q.name}</span>
              <span className="tabular-nums text-slate-500">
                {isFund ? "$" : ""}
                {fmt(price)}
              </span>
              {change !== null && (
                <span
                  className={cx(
                    "font-medium tabular-nums",
                    up
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-red-600 dark:text-red-400",
                  )}
                >
                  {up ? "+" : ""}
                  {change.toFixed(2)}%
                </span>
              )}
            </button>
          );
        })}
      </div>
      {keysList.length >= 2 ? (
        <PercentLinesChart
          labels={labels}
          series={series}
          ariaLabel={`Major indexes compared over ${range}`}
          focus={focus}
          onFocus={setFocus}
          onHover={setHover}
        />
      ) : (
        <p className="py-10 text-center text-sm text-slate-500">
          {loading ? "Loading today's prices…" : "No prices for this range yet."}
        </p>
      )}
      <fieldset className="m-0 mt-2 flex gap-1 border-0 p-0">
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
  );
}

/** Major indexes and sectors, like a brokerage's "Markets" page. */
export function MarketCard() {
  const market = useMarket(true);
  const m = market.data;
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
          {m.indexes.length > 0 && <MarketChart indexes={m.indexes} />}
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

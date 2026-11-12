import {
  CANDLE_RANGE_LABELS,
  CANDLE_RANGES,
  type Candle,
  type CandleRange,
  type CandleSet,
  type LiveKey,
} from "@muny/shared";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api.js";
import { fmtLive, useLiveQuotes } from "../lib/live.js";
import { Card, cx } from "./ui.js";

/**
 * The trading chart on a stock's or coin's page: candles with volume below,
 * a 20-bar average and Bollinger bands (20, 2), the previous close and the
 * latest price as dashed lines, and the bar under the pointer in a tooltip.
 * One price axis. Without bars (the extra is off, or Coinbase doesn't list a
 * coin) it draws the daily closes Muny keeps as a line.
 */

const UP = "#16a34a";
const DOWN = "#ef4444";
const AVG = "#f59e0b";
const BAND = "#3b82f6";
const PRICE_H = 280;
const VOL_H = 56;
const AXIS_H = 22;
const PAD_R = 64;
const PAD_L = 4;
const PAD_T = 8;

const fmtVol = (n: number) =>
  n ? n.toLocaleString(undefined, { notation: "compact", maximumFractionDigits: 1 }) : "—";

function niceStep(span: number) {
  const raw = span / 4 || 1;
  const pow = 10 ** Math.floor(Math.log10(raw));
  return ([1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw) as number;
}

/** The 20-bar average and two standard deviations either side. */
function bands(closes: number[], n = 20) {
  return closes.map((_, i) => {
    if (i + 1 < n) return null;
    const w = closes.slice(i + 1 - n, i + 1);
    const mean = w.reduce((s, x) => s + x, 0) / n;
    const sd = Math.sqrt(w.reduce((s, x) => s + (x - mean) ** 2, 0) / n);
    return { mean, upper: mean + 2 * sd, lower: mean - 2 * sd };
  });
}

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(600);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => e && setW(Math.max(280, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, w };
}

const DAY_MS = 86_400_000;

/** Daily closes as flat bars, for the line when there are no candles. */
function fromCloses(list: { date: string; close: number }[], range: CandleRange): Candle[] {
  const last = list.at(-1)?.date;
  if (!last) return [];
  const end = Date.parse(`${last}T00:00:00Z`);
  const days: Record<CandleRange, number> = {
    "1d": 1,
    "1w": 7,
    "1m": 31,
    "3m": 92,
    "6m": 183,
    ytd: 0,
    "1y": 366,
    "5y": 1830,
  };
  const from =
    range === "ytd"
      ? `${last.slice(0, 4)}-01-01`
      : new Date(end - days[range] * DAY_MS).toISOString().slice(0, 10);
  return list
    .filter((p) => p.date >= from)
    .map((p) => {
      const t = Date.parse(`${p.date}T00:00:00Z`);
      return { t, o: p.close, h: p.close, l: p.close, c: p.close, v: 0 };
    });
}

export function TradingChart({
  liveKey: key,
  fallback,
  candlesOn,
  offNote,
  aria,
}: {
  liveKey: LiveKey;
  /** Daily closes Muny keeps, oldest first. */
  fallback: { date: string; close: number }[];
  /** Candles can be asked for (the extra is on). */
  candlesOn: boolean;
  /** Said under the chart when there are no candles. */
  offNote?: ReactNode;
  aria: string;
}) {
  const [range, setRange] = useState<CandleRange>(candlesOn ? "1d" : "1y");
  const [showBands, setShowBands] = useState(true);
  const q = useQuery({
    queryKey: ["candles", key, range],
    queryFn: () =>
      api.get<CandleSet>(`/api/live/candles?key=${encodeURIComponent(key)}&range=${range}`),
    enabled: candlesOn,
    retry: false,
    staleTime: 60_000,
    refetchInterval: range === "1d" ? 60_000 : false,
  });
  const tick = useLiveQuotes([key]).get(key);
  const set = candlesOn && q.data ? q.data : null;
  const lineMode = !set;
  const { ref, w } = useWidth();
  const [hover, setHover] = useState<number | null>(null);

  const bars = useMemo(() => {
    if (!set) return fromCloses(fallback, range);
    const list = set.candles.map((c) => ({ ...c }));
    // The live price moves the last short bar along.
    const last = list.at(-1);
    if (tick && last && set.barMinutes < 1440 && tick.at >= last.t) {
      last.c = tick.price;
      last.h = Math.max(last.h, tick.price);
      last.l = Math.min(last.l, tick.price);
    }
    return list;
  }, [set, fallback, range, tick]);
  const bb = useMemo(() => bands(bars.map((b) => b.c)), [bars]);

  const plotW = Math.max(100, w - PAD_L - PAD_R);
  const n = bars.length;
  const slot = n ? plotW / n : plotW;
  const x = (i: number) => PAD_L + slot * i + slot / 2;
  const prevClose = set?.previousClose ?? null;
  const last = bars.at(-1);
  const lastPrice = tick?.price ?? last?.c ?? null;
  const values = bars.flatMap((b) => [b.h, b.l]);
  if (showBands && !lineMode) for (const b of bb) if (b) values.push(b.upper, b.lower);
  if (prevClose) values.push(prevClose);
  const lo0 = values.length ? Math.min(...values) : 0;
  const hi0 = values.length ? Math.max(...values) : 1;
  const padY = (hi0 - lo0) * 0.06 || hi0 * 0.01 || 1;
  const step = niceStep(hi0 - lo0 + 2 * padY);
  const lo = Math.floor((lo0 - padY) / step) * step;
  const hi = Math.ceil((hi0 + padY) / step) * step;
  const y = (v: number) => PAD_T + (PRICE_H - PAD_T) * (1 - (v - lo) / (hi - lo || 1));
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(v);
  const vMax = Math.max(1, ...bars.map((b) => b.v));
  const volTop = PRICE_H + 6;
  const height = PRICE_H + 6 + VOL_H + AXIS_H;
  const minutes = set?.barMinutes ?? 1440;

  const label = (t: number, withTime = minutes < 1440) =>
    withTime
      ? new Date(t).toLocaleString(undefined, {
          ...(range === "1w" ? { weekday: "short" } : {}),
          hour: "numeric",
          minute: "2-digit",
        })
      : new Date(lineMode ? t + 12 * 3600_000 : t).toLocaleDateString(undefined, {
          month: "short",
          day: range === "5y" ? undefined : "numeric",
          year: range === "5y" || range === "1y" ? "numeric" : undefined,
          timeZone: lineMode ? "UTC" : undefined,
        });
  const xTicks = n
    ? [...new Set([0, 0.2, 0.4, 0.6, 0.8, 1].map((f) => Math.min(n - 1, Math.round(f * (n - 1)))))]
    : [];
  const first = bars[0];
  const base = range === "1d" && prevClose ? prevClose : first?.o;
  const change = base && lastPrice !== null ? lastPrice - base : null;
  const changePct = change !== null && base ? (change / base) * 100 : null;
  const linePath = bars.map((b, i) => `${i ? "L" : "M"}${x(i)},${y(b.c)}`).join(" ");
  const bandPath = (k: "upper" | "lower" | "mean") =>
    bb
      .map((b, i) => (b ? `${bb[i - 1] ? "L" : "M"}${x(i)},${y(b[k])}` : ""))
      .filter(Boolean)
      .join(" ");
  const bandArea = (() => {
    const pts = bb.map((b, i) => (b ? [i, b] : null)).filter(Boolean) as [
      number,
      { upper: number; lower: number },
    ][];
    if (pts.length < 2) return "";
    return `M${pts.map(([i, b]) => `${x(i)},${y(b.upper)}`).join(" L")} L${[...pts]
      .reverse()
      .map(([i, b]) => `${x(i)},${y(b.lower)}`)
      .join(" L")} Z`;
  })();
  const h = hover !== null ? bars[hover] : null;
  const unavailable = candlesOn && q.isError;

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm">
          {change !== null && changePct !== null && (
            <span
              className={change >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600"}
            >
              {change >= 0 ? "▲" : "▼"} {fmtLive(Math.abs(change))} (
              {Math.abs(changePct).toFixed(2)}%)
            </span>
          )}{" "}
          <span className="text-slate-500">
            {range === "1d"
              ? "today"
              : range === "ytd"
                ? "this year"
                : `over ${CANDLE_RANGE_LABELS[range]}`}
          </span>
        </span>
        <div className="flex flex-wrap items-center gap-3">
          {!lineMode && (
            <label className="flex items-center gap-1.5 text-xs text-slate-500">
              <input
                type="checkbox"
                checked={showBands}
                onChange={(e) => setShowBands(e.target.checked)}
                className="size-3.5 accent-brand-600"
              />
              Average and bands
            </label>
          )}
          <div role="tablist" aria-label="Range" className="flex gap-0.5">
            {CANDLE_RANGES.map((r) => {
              const off = !candlesOn && (r === "1d" || r === "1w");
              return (
                <button
                  key={r}
                  type="button"
                  role="tab"
                  aria-selected={range === r}
                  disabled={off}
                  title={off ? "Needs the chart's extra turned on" : undefined}
                  onClick={() => setRange(r)}
                  className={cx(
                    "rounded-md px-2 py-1 text-xs font-medium disabled:opacity-40",
                    range === r
                      ? "bg-brand-50 text-brand-700 dark:bg-brand-700/20 dark:text-brand-500"
                      : "text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800",
                  )}
                >
                  {CANDLE_RANGE_LABELS[r]}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div ref={ref} className="relative w-full">
        {candlesOn && q.isLoading ? (
          <p className="py-24 text-center text-sm text-slate-500">Loading the chart…</p>
        ) : n < 2 ? (
          <p className="py-24 text-center text-sm text-slate-500">
            {unavailable ? (q.error as Error).message : "No prices for this range yet."}
          </p>
        ) : (
          <svg
            role="img"
            aria-label={`${aria}: ${lineMode ? "daily closes" : "price bars"} over ${CANDLE_RANGE_LABELS[range]}${lastPrice !== null ? `, now ${fmtLive(lastPrice)}` : ""}`}
            width={w}
            height={height}
            className="block select-none"
            onMouseLeave={() => setHover(null)}
            onMouseMove={(e) => {
              const box = e.currentTarget.getBoundingClientRect();
              const i = Math.floor((e.clientX - box.left - PAD_L) / slot);
              setHover(i >= 0 && i < n ? i : null);
            }}
          >
            {/* Grid and price axis (recessive). */}
            {ticks.map((v) => (
              <g key={v}>
                <line
                  x1={PAD_L}
                  x2={PAD_L + plotW}
                  y1={y(v)}
                  y2={y(v)}
                  className="stroke-slate-200 dark:stroke-slate-800"
                  strokeDasharray="3 4"
                />
                <text
                  x={PAD_L + plotW + 6}
                  y={y(v) + 4}
                  className="fill-slate-500 text-[10px] tabular-nums"
                >
                  {fmtLive(v)}
                </text>
              </g>
            ))}

            {!lineMode && showBands && (
              <>
                <path d={bandArea} fill={BAND} opacity={0.08} />
                <path
                  d={bandPath("upper")}
                  fill="none"
                  stroke={BAND}
                  strokeWidth={1}
                  opacity={0.7}
                />
                <path
                  d={bandPath("lower")}
                  fill="none"
                  stroke={BAND}
                  strokeWidth={1}
                  opacity={0.7}
                />
                <path d={bandPath("mean")} fill="none" stroke={AVG} strokeWidth={1.5} />
              </>
            )}

            {prevClose !== null && (
              <line
                x1={PAD_L}
                x2={PAD_L + plotW}
                y1={y(prevClose)}
                y2={y(prevClose)}
                className="stroke-slate-400"
                strokeDasharray="2 3"
              />
            )}

            {lineMode ? (
              <>
                <path
                  d={`${linePath} L${x(n - 1)},${PRICE_H} L${x(0)},${PRICE_H} Z`}
                  fill={BAND}
                  opacity={0.1}
                />
                <path d={linePath} fill="none" stroke={BAND} strokeWidth={2} />
              </>
            ) : (
              bars.map((b, i) => {
                const up = b.c >= b.o;
                const color = up ? UP : DOWN;
                const bw = Math.max(1, Math.min(12, slot * 0.7));
                const top = y(Math.max(b.o, b.c));
                const bh = Math.max(1, Math.abs(y(b.o) - y(b.c)));
                return (
                  <g key={b.t}>
                    <line
                      x1={x(i)}
                      x2={x(i)}
                      y1={y(b.h)}
                      y2={y(b.l)}
                      stroke={color}
                      strokeWidth={1}
                    />
                    <rect
                      x={x(i) - bw / 2}
                      y={top}
                      width={bw}
                      height={bh}
                      fill={color}
                      rx={bw > 4 ? 1 : 0}
                    />
                  </g>
                );
              })
            )}

            {/* Volume, in its own band below the prices. */}
            {!lineMode &&
              bars.map((b, i) =>
                b.v ? (
                  <rect
                    key={`v${b.t}`}
                    x={x(i) - Math.max(1, Math.min(12, slot * 0.7)) / 2}
                    y={volTop + VOL_H - (b.v / vMax) * VOL_H}
                    width={Math.max(1, Math.min(12, slot * 0.7))}
                    height={(b.v / vMax) * VOL_H}
                    fill={b.c >= b.o ? UP : DOWN}
                    opacity={0.35}
                  />
                ) : null,
              )}

            {/* The latest price. */}
            {lastPrice !== null && (
              <g>
                <line
                  x1={PAD_L}
                  x2={PAD_L + plotW}
                  y1={y(lastPrice)}
                  y2={y(lastPrice)}
                  stroke={change !== null && change < 0 ? DOWN : UP}
                  strokeDasharray="4 3"
                  opacity={0.8}
                />
                <rect
                  x={PAD_L + plotW + 2}
                  y={y(lastPrice) - 9}
                  width={PAD_R - 4}
                  height={18}
                  rx={3}
                  fill={change !== null && change < 0 ? DOWN : UP}
                />
                <text
                  x={PAD_L + plotW + 6}
                  y={y(lastPrice) + 4}
                  className="fill-white text-[10px] font-semibold tabular-nums"
                >
                  {fmtLive(lastPrice)}
                </text>
              </g>
            )}

            {xTicks.map((i, k) => (
              <text
                key={(bars[i] as Candle).t}
                x={x(i)}
                y={height - 6}
                textAnchor={k === 0 ? "start" : k === xTicks.length - 1 ? "end" : "middle"}
                className="fill-slate-500 text-[10px]"
              >
                {label((bars[i] as Candle).t)}
              </text>
            ))}

            {h && hover !== null && (
              <line
                x1={x(hover)}
                x2={x(hover)}
                y1={PAD_T}
                y2={volTop + VOL_H}
                className="stroke-slate-400"
                strokeDasharray="2 2"
              />
            )}
          </svg>
        )}
        {h && hover !== null && (
          <div
            className="pointer-events-none absolute top-2 z-10 rounded-lg border border-slate-200 bg-surface px-3 py-2 text-xs shadow-md dark:border-slate-700 dark:bg-slate-900"
            style={x(hover) > w / 2 ? { left: 8 } : { right: PAD_R + 4 }}
          >
            <p className="mb-1 font-medium">
              {label(h.t, minutes < 1440)}
              {minutes < 1440 ? ` · ${new Date(h.t).toLocaleDateString()}` : ""}
            </p>
            {lineMode ? (
              <p className="tabular-nums">Close {fmtLive(h.c)}</p>
            ) : (
              <dl className="grid grid-cols-[auto_auto] gap-x-3 tabular-nums">
                <dt className="text-slate-500">Open</dt>
                <dd>{fmtLive(h.o)}</dd>
                <dt className="text-slate-500">High</dt>
                <dd>{fmtLive(h.h)}</dd>
                <dt className="text-slate-500">Low</dt>
                <dd>{fmtLive(h.l)}</dd>
                <dt className="text-slate-500">Close</dt>
                <dd
                  className={h.c >= h.o ? "text-emerald-600 dark:text-emerald-400" : "text-red-600"}
                >
                  {fmtLive(h.c)}
                </dd>
                <dt className="text-slate-500">Volume</dt>
                <dd>{fmtVol(h.v)}</dd>
                {bb[hover] && showBands && (
                  <>
                    <dt style={{ color: AVG }}>Average</dt>
                    <dd>{fmtLive((bb[hover] as { mean: number }).mean)}</dd>
                  </>
                )}
              </dl>
            )}
          </div>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
        {!lineMode && showBands && (
          <>
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-0.5 w-4" style={{ background: AVG }} />
              20-bar average
            </span>
            <span className="flex items-center gap-1.5">
              <span
                className="inline-block h-2.5 w-4 rounded-sm border"
                style={{ borderColor: BAND, background: `${BAND}22` }}
              />
              Bollinger bands (20, 2)
            </span>
          </>
        )}
        {prevClose !== null && (
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-4 border-t border-dashed border-slate-400" />
            Previous close {fmtLive(prevClose)}
          </span>
        )}
        {set && (
          <span>
            {set.source === "yahoo" ? "Yahoo Finance" : "Coinbase"} ·{" "}
            {minutes < 60
              ? `${minutes}-minute`
              : minutes < 1440
                ? `${minutes / 60}-hour`
                : minutes === 1440
                  ? "daily"
                  : "weekly"}{" "}
            bars
          </span>
        )}
        {lineMode && (
          <span>
            {unavailable
              ? `${(q.error as Error).message} Showing the daily closes Muny keeps.`
              : (offNote ?? "Daily closes Muny keeps.")}
          </span>
        )}
      </div>
    </Card>
  );
}

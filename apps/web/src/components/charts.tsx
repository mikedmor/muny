import type { OverviewDayItem as DayItem } from "@muny/shared";
import { formatMoney } from "@muny/shared";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useUiPrefs } from "../lib/queries.js";
import { cx } from "./ui.js";

/**
 * Small hand-rolled charts (SVG/HTML) following the dataviz method:
 * one hue for magnitude, emphasis instead of rainbows, thin marks with
 * rounded data ends, recessive grid, hover tooltip on every chart, and a
 * table view nearby. Colors come from --viz-* tokens (light/dark).
 */

/** "$1.2k" style for axis ticks. */
export function compactMoney(cents: number): string {
  const v = Math.abs(cents) / 100;
  const sign = cents < 0 ? "−" : "";
  if (v >= 1_000_000) return `${sign}$${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1)}M`;
  if (v >= 1000) return `${sign}$${(v / 1000).toFixed(v >= 10_000 ? 0 : 1)}k`;
  return `${sign}$${Math.round(v)}`;
}

/** Nice round axis max + 3 ticks. */
function niceTicks(max: number, min = 0): number[] {
  const span = Math.max(1, max - min);
  const raw = span / 3;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw;
  const start = Math.floor(min / step) * step;
  const ticks: number[] = [];
  // Go one tick past the max so the data never pokes above the top gridline.
  for (let v = start; ticks.length < 12; v += step) {
    ticks.push(v);
    if (v >= max && ticks.length >= 2) break;
  }
  return ticks;
}

function Tooltip({
  x,
  y,
  width,
  children,
  contentWidth,
}: {
  x: number;
  y: number;
  width: number;
  children: ReactNode;
  /** About how wide the content is, for one wide enough to run off a small chart. */
  contentWidth?: number;
}) {
  // Keep inside the chart: flip to the left near the right edge.
  const fitsRight = contentWidth !== undefined && x + 12 + contentWidth <= width;
  const fitsLeft = contentWidth !== undefined && x - 12 - contentWidth >= 0;
  const left = contentWidth === undefined ? x > width * 0.6 : !fitsRight && fitsLeft;
  const pinned = contentWidth !== undefined && !fitsRight && !fitsLeft;
  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute z-10 whitespace-nowrap rounded-lg border border-slate-200 bg-surface px-2.5 py-1.5 text-xs shadow-md dark:border-slate-700 dark:bg-slate-900"
      style={{
        top: Math.max(0, y - 8),
        ...(pinned ? { left: 0 } : left ? { right: width - x + 12 } : { left: x + 12 }),
      }}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ranked horizontal bars (part-to-whole, compare parts)
// ---------------------------------------------------------------------------

export interface BarItem {
  key: string;
  label: string;
  sublabel?: string;
  /** Decorative icon shown before the label. */
  icon?: ReactNode;
  cents: number;
}

export function RankedBars({
  items,
  total,
  onSelect,
  limit = 12,
}: {
  items: BarItem[];
  total: number;
  onSelect?: (item: BarItem) => void;
  limit?: number;
}) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? items : items.slice(0, limit);
  const max = Math.max(1, ...items.map((i) => i.cents));
  if (items.length === 0)
    return <p className="py-6 text-center text-sm text-slate-500">No spending in this period.</p>;
  return (
    <div>
      <ul className="space-y-1">
        {shown.map((i) => {
          const pct = total > 0 ? (i.cents / total) * 100 : 0;
          const body = (
            <>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="flex min-w-0 items-baseline gap-1.5 truncate">
                  {i.icon}
                  <span className="truncate">{i.label}</span>
                  {i.sublabel && (
                    <span className="ml-1.5 text-xs text-slate-500">{i.sublabel}</span>
                  )}
                </span>
                <span className="shrink-0 tabular-nums">
                  {formatMoney(i.cents)}
                  <span className="ml-2 inline-block w-10 text-right text-xs text-slate-500">
                    {pct.toFixed(pct < 10 ? 1 : 0)}%
                  </span>
                </span>
              </div>
              <div className="mt-1 h-2 w-full">
                <div
                  className="h-full rounded-r-[4px]"
                  style={{
                    width: `${Math.max(0.5, (i.cents / max) * 100)}%`,
                    background: "var(--viz-series-1)",
                  }}
                />
              </div>
            </>
          );
          return (
            <li key={i.key}>
              {onSelect ? (
                <button
                  type="button"
                  onClick={() => onSelect(i)}
                  title={`${i.label}: ${formatMoney(i.cents)} (${pct.toFixed(1)}%)`}
                  className="w-full rounded-lg px-2 py-1.5 text-left hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  {body}
                </button>
              ) : (
                <div
                  title={`${i.label}: ${formatMoney(i.cents)} (${pct.toFixed(1)}%)`}
                  className="rounded-lg px-2 py-1.5 hover:bg-slate-50 dark:hover:bg-slate-800/50"
                >
                  {body}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {items.length > limit && (
        <button
          type="button"
          onClick={() => setShowAll((s) => !s)}
          className="mt-2 px-2 text-sm text-brand-600 hover:underline"
        >
          {showAll ? "Show fewer" : `Show all ${items.length}`}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Column chart (one series over time) with emphasis on a selected column
// ---------------------------------------------------------------------------

const H = 200;
const PAD = { top: 12, right: 8, bottom: 24, left: 48 };

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(320);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      if (e) setW(Math.max(200, Math.round(e.contentRect.width)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width: w };
}

export interface ColumnDatum {
  key: string;
  label: string;
  /** Full label for the tooltip. */
  title: string;
  values: number[];
  /**
   * Single series: where the column is expected to end up (e.g. once pending
   * charges post), drawn as a dashed outline when above the value.
   */
  expected?: number;
}

/**
 * Columns per x position. One series = emphasis chart (selected column in
 * the accent, others de-emphasized). Two series = grouped (series 1/2).
 */
export function ColumnChart({
  data,
  seriesNames,
  selectedKey,
  onSelect,
  ariaLabel,
}: {
  data: ColumnDatum[];
  seriesNames: string[];
  selectedKey?: string;
  onSelect?: (key: string) => void;
  ariaLabel: string;
}) {
  const { ref, width } = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const multi = seriesNames.length > 1;
  const max = Math.max(1, ...data.flatMap((d) => [...d.values, d.expected ?? 0]));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1] ?? max;
  const plotW = width - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const band = plotW / Math.max(1, data.length);
  const gap = 2;
  const barW = Math.max(3, Math.min(36, (band * 0.7) / seriesNames.length - (multi ? gap : 0)));
  const y = (v: number) => PAD.top + plotH - (Math.max(0, v) / top) * plotH;
  const colors = ["var(--viz-series-1)", "var(--viz-series-2)"];
  const labelEvery = Math.ceil(data.length / Math.max(1, Math.floor(plotW / 44)));
  const hovered = hover !== null ? data[hover] : undefined;

  return (
    <div ref={ref} className="relative w-full min-w-0 select-none overflow-visible">
      {multi && (
        <div className="mb-2 flex gap-4 text-xs text-slate-600 dark:text-slate-400">
          {seriesNames.map((n, i) => (
            <span key={n} className="flex items-center gap-1.5">
              <span
                className="inline-block size-2.5 rounded-sm"
                style={{ background: colors[i] }}
              />
              {n}
            </span>
          ))}
        </div>
      )}
      <svg
        width={width}
        className="block max-w-full"
        height={H}
        role="img"
        aria-label={ariaLabel}
        onMouseLeave={() => setHover(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={PAD.left}
              x2={width - PAD.right}
              y1={y(t)}
              y2={y(t)}
              stroke={t === 0 ? "var(--viz-axis)" : "var(--viz-grid)"}
              strokeWidth={1}
            />
            <text
              x={PAD.left - 6}
              y={y(t)}
              dy="0.32em"
              textAnchor="end"
              fontSize={11}
              fill="var(--viz-muted)"
            >
              {compactMoney(t)}
            </text>
          </g>
        ))}
        {data.map((d, i) => {
          const x0 =
            PAD.left + band * i + (band - (barW + (multi ? gap : 0)) * seriesNames.length) / 2;
          const emphasized = multi || !selectedKey || d.key === selectedKey;
          return (
            <g key={d.key}>
              {d.values.map((v, s) => {
                const h = Math.max(0, y(0) - y(v));
                const x = x0 + s * (barW + gap);
                const r = Math.min(4, barW / 2, h);
                // Rounded data end (top), square at the baseline.
                const path =
                  h <= 0
                    ? ""
                    : `M${x},${y(0)} V${y(v) + r} Q${x},${y(v)} ${x + r},${y(v)} H${x + barW - r} Q${x + barW},${y(v)} ${x + barW},${y(v) + r} V${y(0)} Z`;
                return (
                  <path
                    // biome-ignore lint/suspicious/noArrayIndexKey: series index is stable
                    key={s}
                    d={path}
                    fill={multi ? colors[s] : emphasized ? colors[0] : "var(--viz-deemph)"}
                  />
                );
              })}
              {!multi && d.expected !== undefined && d.expected > (d.values[0] ?? 0) && (
                <rect
                  x={x0 + 0.75}
                  y={y(d.expected)}
                  width={Math.max(0, barW - 1.5)}
                  height={Math.max(0, y(d.values[0] ?? 0) - y(d.expected))}
                  rx={Math.min(4, barW / 2)}
                  fill="none"
                  stroke={emphasized ? colors[0] : "var(--viz-deemph)"}
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                  pointerEvents="none"
                />
              )}
              {i % labelEvery === 0 && (
                <text
                  x={PAD.left + band * i + band / 2}
                  y={H - 6}
                  textAnchor="middle"
                  fontSize={11}
                  fill="var(--viz-muted)"
                >
                  {d.label}
                </text>
              )}
              {/* Hit target: the whole column band. */}
              {/* biome-ignore lint/a11y/useSemanticElements: SVG has no <button>; role+tabIndex+keys make the rect one */}
              <rect
                x={PAD.left + band * i}
                y={PAD.top}
                width={band}
                height={plotH}
                fill={hover === i ? "var(--viz-grid)" : "transparent"}
                fillOpacity={0.35}
                style={{ cursor: onSelect ? "pointer" : "default", outline: "none" }}
                role="button"
                tabIndex={0}
                aria-label={`${d.title}: ${d.values.map((v, s) => `${multi ? `${seriesNames[s]} ` : ""}${formatMoney(v)}`).join(", ")}${d.expected !== undefined && d.expected > (d.values[0] ?? 0) ? `, about ${formatMoney(d.expected)} once pending charges post` : ""}`}
                onMouseEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                onClick={() => onSelect?.(d.key)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect?.(d.key);
                  }
                }}
              />
            </g>
          );
        })}
      </svg>
      {hovered && hover !== null && (
        <Tooltip
          x={PAD.left + band * hover + band / 2}
          y={y(Math.max(...hovered.values, hovered.expected ?? 0))}
          width={width}
        >
          <p className="font-medium">{hovered.title}</p>
          {hovered.values.map((v, s) => (
            <p key={seriesNames[s]} className="flex items-center gap-1.5 tabular-nums">
              {multi && (
                <span
                  className="inline-block size-2 rounded-sm"
                  style={{ background: colors[s] }}
                />
              )}
              {multi && `${seriesNames[s]}: `}
              {formatMoney(v)}
            </p>
          ))}
          {!multi &&
            hovered.expected !== undefined &&
            hovered.expected > (hovered.values[0] ?? 0) && (
              <p className="text-slate-500 tabular-nums">
                About {formatMoney(hovered.expected)} with pending
              </p>
            )}
          {multi && hovered.values.length === 2 && (
            <p className="text-slate-500 tabular-nums">
              Net {formatMoney((hovered.values[0] ?? 0) - (hovered.values[1] ?? 0))}
            </p>
          )}
        </Tooltip>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stacked bands (a total split into parts: categories, coins, holdings)
// ---------------------------------------------------------------------------

export interface StackBand {
  key: string;
  label: string;
  /** CSS color (a --viz-* token); the same thing keeps the same color everywhere. */
  color: string;
  /** One value per point, same length as the chart's points. */
  values: number[];
}

/** Filled bands stacked from the baseline, the first band at the bottom. */
function StackBands({
  stack,
  x,
  y,
  count,
  focus,
  onFocus,
}: {
  stack: StackBand[];
  x: (i: number) => number;
  y: (v: number) => number;
  count: number;
  focus: string | null;
  onFocus: (key: string | null) => void;
}) {
  const base = new Array<number>(count).fill(0);
  return (
    <g>
      {stack.map((b) => {
        const lower = [...base];
        for (let i = 0; i < count; i++) base[i] = (base[i] ?? 0) + Math.max(0, b.values[i] ?? 0);
        const top = base.map((v, i) => `${i ? "L" : "M"}${x(i)},${y(v)}`).join(" ");
        const back = lower
          .map((_, j) => {
            const i = count - 1 - j;
            return `L${x(i)},${y(lower[i] ?? 0)}`;
          })
          .join(" ");
        return (
          // biome-ignore lint/a11y/noStaticElementInteractions: hovering a band is a mouse shortcut; the legend buttons do the same with the keyboard
          <path
            key={b.key}
            d={`${top} ${back} Z`}
            fill={b.color}
            fillOpacity={focus === null ? 0.9 : focus === b.key ? 1 : 0.18}
            stroke="var(--viz-surface)"
            strokeWidth={0.75}
            strokeLinejoin="round"
            onMouseEnter={() => onFocus(b.key)}
            onMouseLeave={() => onFocus(null)}
            style={{ transition: "fill-opacity 120ms" }}
          />
        );
      })}
    </g>
  );
}

/** Legend for stacked bands, with each part's latest value; hover one to highlight it. */
export function StackLegend({
  stack,
  at,
  focus = null,
  onFocus,
}: {
  stack: StackBand[];
  at?: number;
  focus?: string | null;
  onFocus?: (key: string | null) => void;
}) {
  return (
    <ul className="mt-3 flex flex-wrap gap-x-1 gap-y-1 text-xs text-slate-600 dark:text-slate-400">
      {stack.map((b) => {
        const v = b.values[at ?? b.values.length - 1] ?? 0;
        return (
          <li key={b.key}>
            <button
              type="button"
              onMouseEnter={() => onFocus?.(b.key)}
              onMouseLeave={() => onFocus?.(null)}
              onFocus={() => onFocus?.(b.key)}
              onBlur={() => onFocus?.(null)}
              className={cx(
                "inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 transition-opacity hover:bg-slate-100 dark:hover:bg-slate-800",
                focus !== null && focus !== b.key && "opacity-40",
              )}
            >
              <span
                aria-hidden="true"
                className="inline-block size-2.5 rounded-sm"
                style={{ background: b.color }}
              />
              <span className="font-medium text-slate-700 dark:text-slate-300">{b.label}</span>
              <span className="tabular-nums">{formatMoney(Math.max(0, v))}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Tooltip lines for the bands at one point, largest first. */
function StackTooltipRows({ stack, i }: { stack: StackBand[]; i: number }) {
  return (
    <>
      {[...stack]
        .map((b) => ({ b, v: b.values[i] ?? 0 }))
        .filter((r) => r.v > 0)
        .sort((a, c) => c.v - a.v)
        .map(({ b, v }) => (
          <p key={b.key} className="flex items-center gap-1.5 tabular-nums">
            <span
              aria-hidden="true"
              className="inline-block size-2 rounded-sm"
              style={{ background: b.color }}
            />
            <span className="text-slate-500">{b.label}</span>
            <span className="ml-auto pl-3">{formatMoney(v)}</span>
          </p>
        ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Line chart (one series over time) with crosshair tooltip
// ---------------------------------------------------------------------------

export interface LinePoint {
  date: string;
  label: string;
  value: number;
  /** A second, dashed line on the same axis (e.g. cost basis). */
  compare?: number;
}

export function LineChart({
  points,
  ariaLabel,
  height = H,
  compareLabel,
  stack: stackIn,
  projectedFrom,
}: {
  points: LinePoint[];
  ariaLabel: string;
  height?: number;
  /** Name of the dashed line (shown in the tooltip and legend). */
  compareLabel?: string;
  /** Points from this index on are a projection: drawn dashed, without fill. */
  projectedFrom?: number;
  /** Split the area under the line into colored parts (they should add up to the line). */
  stack?: StackBand[];
}) {
  // Settings → Display can turn the split off.
  const prefs = useUiPrefs();
  const stack = prefs.data?.splitCharts ? stackIn : undefined;
  const { ref, width } = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const gradId = useId();
  const values = points.flatMap((p) =>
    p.compare !== undefined ? [p.value, p.compare] : [p.value],
  );
  const hasCompare = !!compareLabel && points.some((p) => p.compare !== undefined);
  const lo = Math.min(0, ...values);
  const hi = Math.max(1, ...values);
  const ticks = niceTicks(hi, lo);
  const top = ticks[ticks.length - 1] ?? hi;
  const bottom = ticks[0] ?? lo;
  const plotW = width - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom;
  const x = (i: number) =>
    PAD.left + (points.length <= 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const y = (v: number) => PAD.top + plotH - ((v - bottom) / Math.max(1, top - bottom)) * plotH;
  // Actual points end where the projection starts (the projection continues from the last one).
  const actualN =
    projectedFrom !== undefined
      ? Math.max(1, Math.min(points.length, projectedFrom))
      : points.length;
  const line = points
    .slice(0, actualN)
    .map((p, i) => `${i ? "L" : "M"}${x(i)},${y(p.value)}`)
    .join(" ");
  const projectedLine =
    actualN < points.length
      ? points
          .slice(actualN - 1)
          .map((p, j) => `${j ? "L" : "M"}${x(actualN - 1 + j)},${y(p.value)}`)
          .join(" ")
      : "";
  const compareLine = hasCompare
    ? points.map((p, i) => `${i ? "L" : "M"}${x(i)},${y(p.compare ?? 0)}`).join(" ")
    : "";
  const area = points.length
    ? `${line} L${x(actualN - 1)},${y(Math.max(bottom, 0))} L${x(0)},${y(Math.max(bottom, 0))} Z`
    : "";
  // Room for the longest label (about 6.5px a character at the axis font size), so they never overlap.
  const labelW = Math.max(56, Math.max(0, ...points.map((p) => p.label.length)) * 6.5 + 16);
  const labelEvery = Math.ceil(points.length / Math.max(1, Math.floor(plotW / labelW)));
  const hp = hover !== null ? points[hover] : undefined;

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const i = Math.round(((px - PAD.left) / Math.max(1, plotW)) * (points.length - 1));
    setHover(Math.max(0, Math.min(points.length - 1, i)));
  };

  return (
    <div ref={ref} className="relative w-full min-w-0 select-none overflow-visible">
      <svg
        width={width}
        className="block max-w-full"
        height={height}
        role="img"
        aria-label={ariaLabel}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--viz-series-1)" stopOpacity={0.18} />
            <stop offset="100%" stopColor="var(--viz-series-1)" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={PAD.left}
              x2={width - PAD.right}
              y1={y(t)}
              y2={y(t)}
              stroke={t === 0 ? "var(--viz-axis)" : "var(--viz-grid)"}
              strokeWidth={1}
            />
            <text
              x={PAD.left - 6}
              y={y(t)}
              dy="0.32em"
              textAnchor="end"
              fontSize={11}
              fill="var(--viz-muted)"
            >
              {compactMoney(t)}
            </text>
          </g>
        ))}
        {points.map((p, i) =>
          (i % labelEvery === 0 && x(points.length - 1) - x(i) >= labelW) ||
          i === points.length - 1 ? (
            <text
              key={p.date}
              x={x(i)}
              y={height - 6}
              textAnchor={i === points.length - 1 ? "end" : i === 0 ? "start" : "middle"}
              fontSize={11}
              fill="var(--viz-muted)"
            >
              {p.label}
            </text>
          ) : null,
        )}
        {stack?.length ? (
          <StackBands stack={stack} x={x} y={y} count={actualN} focus={focus} onFocus={setFocus} />
        ) : (
          <path d={area} fill={`url(#${gradId})`} />
        )}
        {hasCompare && (
          <path
            d={compareLine}
            fill="none"
            stroke="var(--viz-muted)"
            strokeWidth={1.5}
            strokeDasharray="5 4"
          />
        )}
        {!stack?.length && (
          <path
            d={line}
            fill="none"
            stroke="var(--viz-series-1)"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}
        {projectedLine && (
          <path
            d={projectedLine}
            fill="none"
            stroke="var(--viz-series-1)"
            strokeWidth={2}
            strokeDasharray="5 4"
            strokeLinejoin="round"
            strokeLinecap="round"
            opacity={0.8}
          />
        )}
        {hp && hover !== null && (
          <g>
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={PAD.top}
              y2={PAD.top + plotH}
              stroke="var(--viz-axis)"
              strokeWidth={1}
            />
            <circle
              cx={x(hover)}
              cy={y(hp.value)}
              r={4}
              fill={stack?.length ? "var(--viz-ink-2)" : "var(--viz-series-1)"}
              stroke="var(--viz-surface)"
              strokeWidth={2}
            />
          </g>
        )}
      </svg>
      {hp && hover !== null && (
        <Tooltip x={x(hover)} y={y(hp.value)} width={width}>
          <p className="font-medium">
            {hp.label}
            {hover >= actualN && (
              <span className="ml-1 font-normal text-slate-500">(projected)</span>
            )}
          </p>
          <p className="tabular-nums">
            {hasCompare || stack?.length ? "Value: " : ""}
            {formatMoney(hp.value)}
          </p>
          {stack?.length && hover < actualN ? <StackTooltipRows stack={stack} i={hover} /> : null}
          {hasCompare && hp.compare !== undefined && (
            <>
              <p className="tabular-nums">
                {compareLabel}: {formatMoney(hp.compare)}
              </p>
              <p className="tabular-nums">
                Gain/loss: {hp.value - hp.compare < 0 ? "−" : ""}
                {formatMoney(Math.abs(hp.value - hp.compare))}
                {hp.compare > 0 &&
                  ` (${(((hp.value - hp.compare) / hp.compare) * 100).toFixed(1)}%)`}
              </p>
            </>
          )}
        </Tooltip>
      )}
      {stack?.length ? (
        <StackLegend stack={stack} at={hover ?? undefined} focus={focus} onFocus={setFocus} />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Month pace: running total this month vs. last month, by day of month
// ---------------------------------------------------------------------------

/** One group of a day's transactions in the tooltip: the biggest few, then a count. */
function DayItems({ title, items }: { title: string; items: DayItem[] }) {
  if (!items.length) return null;
  const MAX = 5;
  const sorted = [...items].sort((a, b) => Math.abs(b.amountCents) - Math.abs(a.amountCents));
  const more = sorted.length - MAX;
  return (
    <div className="mt-1.5 border-t border-slate-200 pt-1 dark:border-slate-700">
      <p className="text-slate-500">{title}</p>
      {sorted.slice(0, MAX).map((i, k) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: two charges can match exactly
        <p key={k} className="flex justify-between gap-4 tabular-nums">
          <span className="max-w-36 truncate">{i.name}</span>
          <span className={i.amountCents > 0 ? "text-emerald-700 dark:text-emerald-400" : ""}>
            {formatMoney(i.amountCents)}
          </span>
        </p>
      ))}
      {more > 0 && <p className="text-slate-500">and {more} more</p>}
    </div>
  );
}

/**
 * Two cumulative series on one axis: this month (emphasized, area) through
 * today, last month (de-emphasized, dashed) for the whole month. Legend and
 * crosshair tooltip name both, so identity never rests on color alone.
 */
export function PaceChart({
  current,
  previous,
  days,
  currentLabel,
  previousLabel,
  dayLabel,
  ariaLabel,
  height = 180,
  stack: stackIn,
  income,
  anticipated,
  dayItems,
}: {
  /** What happened, or is expected, on each day of the month. */
  dayItems?: DayItem[];
  /** Where this month is headed from today: index 0 = today, through month end. */
  anticipated?: { label: string; values: number[] };
  /**
   * Earnings to compare against: the running total so far (index 0 = day 1,
   * through today), then where it should end up (index 0 = today, to month end).
   */
  income?: { label: string; actual: number[]; expected: number[]; expectedLabel: string };
  /** Running totals, index 0 = day 1, through today. */
  current: number[];
  /** This month's running total split into parts (e.g. categories), adding up to `current`. */
  stack?: StackBand[];
  /** Running totals for the whole comparison month. */
  previous: number[];
  /** Days in the current month. */
  days: number;
  currentLabel: string;
  previousLabel: string;
  /** Tooltip heading for a day number (1-based). */
  dayLabel: (day: number) => string;
  ariaLabel: string;
  height?: number;
}) {
  // Settings → Display can turn the split off.
  const prefs = useUiPrefs();
  const stack = prefs.data?.splitCharts ? stackIn : undefined;
  const { ref, width } = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const gradId = useId();
  const n = Math.max(days, previous.length, current.length, 2);
  const lineColor = stack?.length ? "var(--viz-ink-2)" : "var(--viz-series-1)";
  const hi = Math.max(
    1,
    ...current,
    ...previous,
    ...(income?.actual ?? []),
    ...(income?.expected ?? []),
    ...(anticipated?.values ?? []),
  );
  const ticks = niceTicks(hi, 0);
  const top = ticks[ticks.length - 1] ?? hi;
  const plotW = width - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (i / (n - 1)) * plotW;
  const y = (v: number) => PAD.top + plotH - (Math.max(0, v) / Math.max(1, top)) * plotH;
  const path = (vals: number[]) => vals.map((v, i) => `${i ? "L" : "M"}${x(i)},${y(v)}`).join(" ");
  const cur = path(current);
  const area = current.length ? `${cur} L${x(current.length - 1)},${y(0)} L${x(0)},${y(0)} Z` : "";
  const lastI = current.length - 1;
  const dayTicks = [1, 8, 15, 22, n].filter((d, i, a) => d <= n && a.indexOf(d) === i);

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const i = Math.round(((e.clientX - rect.left - PAD.left) / Math.max(1, plotW)) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };
  const hv = hover !== null ? current[hover] : undefined;
  const hp = hover !== null ? previous[hover] : undefined;
  // Earnings: what's arrived through today, then what's expected after it.
  const incomeStart = (income?.actual.length ?? 0) - 1;
  const hasIncome = !!income && Math.max(0, ...income.actual, ...income.expected) > 0;
  const incomeAt = (i: number) =>
    !income ? undefined : i <= incomeStart ? income.actual[i] : income.expected[i - incomeStart];
  const incomeEnd = income?.expected.at(-1) ?? income?.actual.at(-1) ?? 0;
  const incomeNow = income?.actual.at(-1) ?? 0;
  const hi$ = hover !== null && hasIncome ? incomeAt(hover) : undefined;
  const expectedPath = income
    ? income.expected.map((v, k) => `${k ? "L" : "M"}${x(incomeStart + k)},${y(v)}`).join(" ")
    : "";
  // Spending ahead: starts where the solid line stops, even if a late bill counts today.
  const spentNow = current[lastI] ?? 0;
  const headedTo = anticipated?.values.at(-1) ?? spentNow;
  const hasAnticipated = !!anticipated && headedTo > spentNow;
  const anticipatedPath =
    hasAnticipated && anticipated
      ? `M${x(lastI)},${y(spentNow)} ${anticipated.values
          .map((v, k) => `L${x(lastI + k)},${y(v)}`)
          .join(" ")}`
      : "";
  const ha =
    hover !== null && hasAnticipated && anticipated && hover >= lastI
      ? anticipated.values[hover - lastI]
      : undefined;
  const hoverItems = hover === null ? [] : (dayItems ?? []).filter((i) => i.day === hover + 1);
  const happened = hoverItems.filter((i) => !i.expected);
  const dueThatDay = hoverItems.filter((i) => i.expected);
  // The two end labels sit at the right edge: when they'd collide, the lower
  // total's label goes under its line.
  const labelsClash = hasIncome && hasAnticipated && Math.abs(y(incomeEnd) - y(headedTo)) < 18;
  const incomeLabelY = labelsClash && incomeEnd <= headedTo ? y(incomeEnd) + 15 : y(incomeEnd) - 6;
  const anticipatedLabelY =
    labelsClash && headedTo < incomeEnd ? y(headedTo) + 15 : y(headedTo) - 6;

  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600 dark:text-slate-400">
        <span className="inline-flex items-center gap-1.5">
          <svg width="18" height="6" aria-hidden="true">
            <line
              x1="1"
              x2="17"
              y1="3"
              y2="3"
              stroke={stack?.length ? "var(--viz-ink-2)" : "var(--viz-series-1)"}
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
          {currentLabel}
        </span>
        {hasAnticipated && anticipated && (
          <span className="inline-flex items-center gap-1.5">
            <svg width="18" height="6" aria-hidden="true">
              <line
                x1="1"
                x2="17"
                y1="3"
                y2="3"
                stroke={lineColor}
                strokeWidth="2"
                strokeDasharray="5 3"
              />
            </svg>
            {anticipated.label}
          </span>
        )}
        <span className="inline-flex items-center gap-1.5">
          <svg width="18" height="6" aria-hidden="true">
            <line
              x1="1"
              x2="17"
              y1="3"
              y2="3"
              stroke="var(--viz-muted)"
              strokeWidth="2"
              strokeDasharray="4 3"
            />
          </svg>
          {previousLabel}
        </span>
        {hasIncome && income && (
          <span className="inline-flex items-center gap-1.5">
            <svg width="18" height="6" aria-hidden="true">
              <line
                x1="1"
                x2="17"
                y1="3"
                y2="3"
                stroke="var(--viz-positive)"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
            {income.label}
          </span>
        )}
        {hasIncome && income && incomeEnd > incomeNow && (
          <span className="inline-flex items-center gap-1.5">
            <svg width="18" height="6" aria-hidden="true">
              <line
                x1="1"
                x2="17"
                y1="3"
                y2="3"
                stroke="var(--viz-positive)"
                strokeWidth="2"
                strokeDasharray="5 3"
              />
            </svg>
            {income.expectedLabel}
          </span>
        )}
      </div>
      <div ref={ref} className="relative w-full min-w-0 select-none overflow-visible">
        <svg
          width={width}
          className="block max-w-full"
          height={height}
          role="img"
          aria-label={ariaLabel}
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
        >
          <defs>
            <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="var(--viz-series-1)" stopOpacity={0.18} />
              <stop offset="100%" stopColor="var(--viz-series-1)" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={PAD.left}
                x2={width - PAD.right}
                y1={y(t)}
                y2={y(t)}
                stroke={t === 0 ? "var(--viz-axis)" : "var(--viz-grid)"}
                strokeWidth={1}
              />
              <text
                x={PAD.left - 6}
                y={y(t)}
                dy="0.32em"
                textAnchor="end"
                fontSize={11}
                fill="var(--viz-muted)"
              >
                {compactMoney(t)}
              </text>
            </g>
          ))}
          {dayTicks.map((d) => (
            <text
              key={d}
              x={x(d - 1)}
              y={height - 6}
              textAnchor={d === 1 ? "start" : d === n ? "end" : "middle"}
              fontSize={11}
              fill="var(--viz-muted)"
            >
              {d}
            </text>
          ))}
          <path
            d={path(previous)}
            fill="none"
            stroke="var(--viz-muted)"
            strokeWidth={2}
            strokeDasharray="4 3"
            strokeLinejoin="round"
          />
          {hasIncome && income && (
            <g>
              <path
                d={path(income.actual)}
                fill="none"
                stroke="var(--viz-positive)"
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {incomeEnd > incomeNow && (
                <path
                  d={expectedPath}
                  fill="none"
                  stroke="var(--viz-positive)"
                  strokeWidth={2}
                  strokeDasharray="5 3"
                  strokeLinejoin="round"
                />
              )}
              <text
                x={width - PAD.right}
                y={incomeLabelY}
                textAnchor="end"
                fontSize={11}
                fontWeight={500}
                fill="var(--viz-ink-2)"
                stroke="var(--viz-surface)"
                strokeWidth={3}
                paintOrder="stroke"
              >
                {incomeEnd > incomeNow ? income.expectedLabel : income.label}{" "}
                {compactMoney(incomeEnd)}
              </text>
            </g>
          )}
          {hasAnticipated && anticipated && (
            <g>
              <path
                d={anticipatedPath}
                fill="none"
                stroke={lineColor}
                strokeWidth={2}
                strokeDasharray="5 3"
                strokeLinejoin="round"
              />
              <text
                x={width - PAD.right}
                y={anticipatedLabelY}
                textAnchor="end"
                fontSize={11}
                fontWeight={500}
                fill="var(--viz-ink-2)"
                stroke="var(--viz-surface)"
                strokeWidth={3}
                paintOrder="stroke"
              >
                {anticipated.label} {compactMoney(headedTo)}
              </text>
            </g>
          )}
          {stack?.length ? (
            <StackBands
              stack={stack}
              x={x}
              y={y}
              count={current.length}
              focus={focus}
              onFocus={setFocus}
            />
          ) : (
            <path d={area} fill={`url(#${gradId})`} />
          )}
          {!stack?.length && (
            <path
              d={cur}
              fill="none"
              stroke="var(--viz-series-1)"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          )}
          {lastI >= 0 && hover === null && (
            <circle
              cx={x(lastI)}
              cy={y(current[lastI] ?? 0)}
              r={4}
              fill="var(--viz-series-1)"
              stroke="var(--viz-surface)"
              strokeWidth={2}
            />
          )}
          {hover !== null && (
            <g>
              <line
                x1={x(hover)}
                x2={x(hover)}
                y1={PAD.top}
                y2={PAD.top + plotH}
                stroke="var(--viz-axis)"
                strokeWidth={1}
              />
              {hp !== undefined && (
                <circle
                  cx={x(hover)}
                  cy={y(hp)}
                  r={4}
                  fill="var(--viz-muted)"
                  stroke="var(--viz-surface)"
                  strokeWidth={2}
                />
              )}
              {hi$ !== undefined && (
                <circle
                  cx={x(hover)}
                  cy={y(hi$)}
                  r={4}
                  fill="var(--viz-positive)"
                  stroke="var(--viz-surface)"
                  strokeWidth={2}
                />
              )}
              {ha !== undefined && hover > lastI && (
                <circle
                  cx={x(hover)}
                  cy={y(ha)}
                  r={4}
                  fill={lineColor}
                  stroke="var(--viz-surface)"
                  strokeWidth={2}
                />
              )}
              {hv !== undefined && (
                <circle
                  cx={x(hover)}
                  cy={y(hv)}
                  r={4}
                  fill={stack?.length ? "var(--viz-ink-2)" : "var(--viz-series-1)"}
                  stroke="var(--viz-surface)"
                  strokeWidth={2}
                />
              )}
            </g>
          )}
        </svg>
        {hover !== null && (
          <Tooltip
            x={x(hover)}
            y={y(Math.max(hv ?? 0, hp ?? 0, hi$ ?? 0, ha ?? 0))}
            width={width}
            contentWidth={hoverItems.length ? 252 : undefined}
          >
            <p className="font-medium">{dayLabel(hover + 1)}</p>
            {hv !== undefined && (
              <p className="tabular-nums">
                {currentLabel}: {formatMoney(hv)}
              </p>
            )}
            {stack?.length && hover < current.length ? (
              <StackTooltipRows stack={stack} i={hover} />
            ) : null}
            {ha !== undefined && hover > lastI && anticipated && (
              <p className="tabular-nums">
                {anticipated.label}: {formatMoney(ha)}
              </p>
            )}
            {hp !== undefined && (
              <p className="tabular-nums text-slate-500">
                {previousLabel}: {formatMoney(hp)}
              </p>
            )}
            {hi$ !== undefined && income && (
              <p className="tabular-nums">
                {hover !== null && hover > incomeStart ? income.expectedLabel : income.label}:{" "}
                {formatMoney(hi$)}
              </p>
            )}
            <DayItems title="Transactions" items={happened} />
            <DayItems title="Expected" items={dueThatDay} />
          </Tooltip>
        )}
      </div>
      {stack?.length ? (
        <StackLegend
          stack={stack}
          at={hover !== null && hover < current.length ? hover : undefined}
          focus={focus}
          onFocus={setFocus}
        />
      ) : null}
    </div>
  );
}

/** Collapsible table view for a chart (accessibility + exact numbers). */
export function TableToggle({
  children,
  label = "Show as table",
}: {
  children: ReactNode;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-xs text-slate-500 underline"
      >
        {open ? "Hide table" : label}
      </button>
      {open && <div className="mt-2 overflow-x-auto">{children}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Donut (part-to-whole, ≤ 8 slices: fold the rest into "Other")
// ---------------------------------------------------------------------------

export interface DonutSlice {
  key: string;
  label: string;
  cents: number;
  /** CSS color (a --viz-* token). */
  color: string;
}

/**
 * Donut with a 2px surface gap between slices. Hovering or focusing a slice
 * shows it in the center; otherwise the center shows `children`. Always pair
 * it with a table/legend that names each slice (identity isn't color-only).
 */
export function Donut({
  slices,
  ariaLabel,
  size = 260,
  thickness = 44,
  children,
}: {
  slices: DonutSlice[];
  ariaLabel: string;
  size?: number;
  thickness?: number;
  children?: ReactNode;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const total = slices.reduce((s, x) => s + Math.max(0, x.cents), 0);
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const gap = slices.length > 1 ? 2 : 0;
  let acc = 0;
  const hp = hover !== null ? slices[hover] : undefined;
  return (
    <div className="relative mx-auto" style={{ width: size, height: size }}>
      <svg width={size} height={size} role="img" aria-label={ariaLabel} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--viz-grid)"
          strokeWidth={thickness}
        />
        {total > 0 &&
          slices.map((s, i) => {
            const len = (Math.max(0, s.cents) / total) * c;
            const start = acc;
            acc += len;
            if (len <= 0) return null;
            return (
              // biome-ignore lint/a11y/noStaticElementInteractions: hover detail duplicates the table
              <circle
                key={s.key}
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                stroke={s.color}
                strokeWidth={hover === i ? thickness + 6 : thickness}
                strokeDasharray={`${Math.max(0.5, len - gap)} ${c}`}
                strokeDashoffset={-start}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                style={{ transition: "stroke-width 120ms" }}
              />
            );
          })}
      </svg>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-10 text-center">
        {hp ? (
          <>
            <span className="text-xs text-slate-500">{hp.label}</span>
            <span className="text-2xl font-semibold tabular-nums">{formatMoney(hp.cents)}</span>
            <span className="text-xs text-slate-500">
              {total > 0 ? `${Math.round((hp.cents / total) * 100)}% of spend` : ""}
            </span>
          </>
        ) : (
          children
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Percent change lines (several series compared from the same start)
// ---------------------------------------------------------------------------

export interface PercentSeries {
  key: string;
  label: string;
  color: string;
  /** Percent change from the start, one per point (null = no data). */
  values: (number | null)[];
}

function pctTicks(lo: number, hi: number): number[] {
  const span = Math.max(1, hi - lo);
  const step = [0.5, 1, 2, 5, 10, 20, 25, 50, 100, 200].find((s) => span / s <= 5) ?? 500;
  const out: number[] = [];
  for (let v = Math.floor(lo / step) * step; v <= hi + 1e-9; v += step)
    out.push(Number(v.toFixed(2)));
  if (out[out.length - 1] !== undefined && (out[out.length - 1] as number) < hi)
    out.push((out[out.length - 1] as number) + step);
  return out;
}

/**
 * Several lines on one percent axis (like a brokerage's market chart). Hover
 * reports the point under the pointer (`onHover`), and `focus` brings one
 * series forward while the others fade.
 */
export function PercentLinesChart({
  labels,
  series,
  ariaLabel,
  focus,
  onFocus,
  onHover,
  height = 220,
}: {
  /** One label per point (for the axis). */
  labels: string[];
  series: PercentSeries[];
  ariaLabel: string;
  focus: string | null;
  onFocus: (key: string | null) => void;
  onHover: (i: number | null) => void;
  height?: number;
}) {
  const { ref, width } = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const n = labels.length;
  const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const ticks = pctTicks(Math.min(0, ...all), Math.max(0, ...all));
  const lo = ticks[0] ?? 0;
  const hi = ticks[ticks.length - 1] ?? 1;
  const pad = { top: 12, right: 44, bottom: 24, left: 8 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const x = (i: number) => pad.left + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v: number) => pad.top + plotH - ((v - lo) / Math.max(1e-9, hi - lo)) * plotH;
  const labelW = Math.max(56, Math.max(0, ...labels.map((l) => l.length)) * 6.5 + 16);
  const every = Math.ceil(n / Math.max(1, Math.floor(plotW / labelW)));
  const path = (vals: (number | null)[]) => {
    let d = "";
    let pen = false;
    vals.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(i)},${y(v)} `;
      pen = true;
    });
    return d;
  };
  const ordered = focus
    ? [...series.filter((s) => s.key !== focus), ...series.filter((s) => s.key === focus)]
    : series;
  const move = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const i = Math.round(((e.clientX - rect.left - pad.left) / Math.max(1, plotW)) * (n - 1));
    const c = Math.max(0, Math.min(n - 1, i));
    setHover(c);
    onHover(c);
  };
  return (
    <div ref={ref} className="relative w-full min-w-0 select-none">
      <svg
        width={width}
        className="block max-w-full"
        height={height}
        role="img"
        aria-label={ariaLabel}
        onMouseMove={move}
        onMouseLeave={() => {
          setHover(null);
          onHover(null);
        }}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={pad.left}
              x2={width - pad.right}
              y1={y(t)}
              y2={y(t)}
              stroke={t === 0 ? "var(--viz-axis)" : "var(--viz-grid)"}
              strokeDasharray={t === 0 ? undefined : "3 4"}
            />
            <text
              x={width - pad.right + 6}
              y={y(t)}
              dy="0.32em"
              fontSize={11}
              fill="var(--viz-muted)"
            >
              {t > 0 ? "+" : ""}
              {t}%
            </text>
          </g>
        ))}
        {labels.map((l, i) =>
          (i % every === 0 && x(n - 1) - x(i) >= labelW) || i === n - 1 ? (
            <text
              key={`${l}@${Math.round(x(i))}`}
              x={x(i)}
              y={height - 6}
              textAnchor={i === n - 1 ? "end" : i === 0 ? "start" : "middle"}
              fontSize={11}
              fill="var(--viz-muted)"
            >
              {l}
            </text>
          ) : null,
        )}
        {ordered.map((s) => (
          // biome-ignore lint/a11y/noStaticElementInteractions: hovering a line is a mouse shortcut; the chips do the same with the keyboard
          <path
            key={s.key}
            d={path(s.values)}
            fill="none"
            stroke={s.color}
            strokeWidth={focus === s.key ? 2.5 : 1.75}
            strokeOpacity={focus === null || focus === s.key ? 1 : 0.2}
            strokeLinejoin="round"
            strokeLinecap="round"
            onMouseEnter={() => onFocus(s.key)}
            onMouseLeave={() => onFocus(null)}
            style={{ transition: "stroke-opacity 120ms" }}
          />
        ))}
        {hover !== null && (
          <g>
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={pad.top}
              y2={pad.top + plotH}
              stroke="var(--viz-axis)"
            />
            {series.map((s) => {
              const v = s.values[hover];
              return v === null || v === undefined ? null : (
                <circle
                  key={s.key}
                  cx={x(hover)}
                  cy={y(v)}
                  r={3.5}
                  fill={s.color}
                  stroke="var(--viz-surface)"
                  strokeWidth={1.5}
                  opacity={focus === null || focus === s.key ? 1 : 0.3}
                />
              );
            })}
          </g>
        )}
      </svg>
      {hover !== null && (
        <Tooltip x={x(hover)} y={pad.top + 8} width={width}>
          <p className="font-medium">{labels[hover]}</p>
        </Tooltip>
      )}
    </div>
  );
}

import { formatMoney } from "@muny/shared";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";

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
}: {
  x: number;
  y: number;
  width: number;
  children: ReactNode;
}) {
  // Keep inside the chart: flip to the left near the right edge.
  const left = x > width * 0.6;
  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute z-10 whitespace-nowrap rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs shadow-md dark:border-slate-700 dark:bg-slate-900"
      style={{
        top: Math.max(0, y - 8),
        ...(left ? { right: width - x + 12 } : { left: x + 12 }),
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
      if (e) setW(Math.max(280, Math.round(e.contentRect.width)));
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
  const max = Math.max(1, ...data.flatMap((d) => d.values));
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
                aria-label={`${d.title}: ${d.values.map((v, s) => `${multi ? `${seriesNames[s]} ` : ""}${formatMoney(v)}`).join(", ")}`}
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
          y={y(Math.max(...hovered.values))}
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
// Line chart (one series over time) with crosshair tooltip
// ---------------------------------------------------------------------------

export interface LinePoint {
  date: string;
  label: string;
  value: number;
}

export function LineChart({
  points,
  ariaLabel,
  height = H,
}: {
  points: LinePoint[];
  ariaLabel: string;
  height?: number;
}) {
  const { ref, width } = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const gradId = useId();
  const values = points.map((p) => p.value);
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
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(i)},${y(p.value)}`).join(" ");
  const area = points.length
    ? `${line} L${x(points.length - 1)},${y(Math.max(bottom, 0))} L${x(0)},${y(Math.max(bottom, 0))} Z`
    : "";
  const labelEvery = Math.ceil(points.length / Math.max(1, Math.floor(plotW / 56)));
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
          (i % labelEvery === 0 && points.length - 1 - i >= labelEvery / 2) ||
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
        <path d={area} fill={`url(#${gradId})`} />
        <path
          d={line}
          fill="none"
          stroke="var(--viz-series-1)"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
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
              fill="var(--viz-series-1)"
              stroke="var(--viz-surface)"
              strokeWidth={2}
            />
          </g>
        )}
      </svg>
      {hp && hover !== null && (
        <Tooltip x={x(hover)} y={y(hp.value)} width={width}>
          <p className="font-medium">{hp.label}</p>
          <p className="tabular-nums">{formatMoney(hp.value)}</p>
        </Tooltip>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Month pace: running total this month vs. last month, by day of month
// ---------------------------------------------------------------------------

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
}: {
  /** Running totals, index 0 = day 1, through today. */
  current: number[];
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
  const { ref, width } = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const gradId = useId();
  const n = Math.max(days, previous.length, current.length, 2);
  const hi = Math.max(1, ...current, ...previous);
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
              stroke="var(--viz-series-1)"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
          {currentLabel}
        </span>
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
      </div>
      <div ref={ref} className="relative w-full min-w-0 select-none overflow-visible">
        <svg
          width={width}
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
          <path d={area} fill={`url(#${gradId})`} />
          <path
            d={cur}
            fill="none"
            stroke="var(--viz-series-1)"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
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
              {hv !== undefined && (
                <circle
                  cx={x(hover)}
                  cy={y(hv)}
                  r={4}
                  fill="var(--viz-series-1)"
                  stroke="var(--viz-surface)"
                  strokeWidth={2}
                />
              )}
            </g>
          )}
        </svg>
        {hover !== null && (
          <Tooltip x={x(hover)} y={y(Math.max(hv ?? 0, hp ?? 0))} width={width}>
            <p className="font-medium">{dayLabel(hover + 1)}</p>
            {hv !== undefined && (
              <p className="tabular-nums">
                {currentLabel}: {formatMoney(hv)}
              </p>
            )}
            {hp !== undefined && (
              <p className="tabular-nums text-slate-500">
                {previousLabel}: {formatMoney(hp)}
              </p>
            )}
          </Tooltip>
        )}
      </div>
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

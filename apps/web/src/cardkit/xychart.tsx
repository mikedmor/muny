import {
  type BlockOptions,
  type BlockResult,
  type CardCell,
  type CardColor,
  type CardMark,
  type FieldType,
  formatCell,
  formatCompact,
  formatMonth,
  type QueryResult,
  type ResultColumn,
} from "@muny/shared";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { OTHER_COLOR, SERIES_SLOTS, seriesColor } from "../lib/series.js";

/**
 * Lines, areas and columns on one shared axis, from any number of queries.
 * Follows the dataviz method: one axis only, thin marks, rounded data ends, a 2px
 * gap between fills, fixed color order with the rest folded into Other, a legend
 * from two series, a hover layer, and a table for screen readers. Colors are theme
 * roles, so every chart follows the theme.
 */

export function cardColor(color: CardColor | undefined, slot: number): string {
  switch (color) {
    case undefined:
    case "auto":
      return seriesColor(slot);
    case "positive":
      return "var(--viz-positive)";
    case "negative":
      return "var(--viz-negative)";
    case "warning":
      return "var(--viz-warning)";
    case "muted":
      return "var(--viz-muted)";
    default:
      return seriesColor(Number(color.slice(6)) - 1);
  }
}

export function useWidth(initial = 320) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      if (e) setWidth(Math.max(120, Math.round(e.contentRect.width)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

export function niceTicks(lo: number, hi: number, count = 3): number[] {
  const span = Math.max(hi - lo, 1e-9);
  const raw = span / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.floor(lo / step) * step; out.length < 14; v += step) {
    out.push(Math.abs(v) < step / 1e6 ? 0 : v);
    if (v >= hi) break;
  }
  return out;
}

export interface ChartSeries {
  key: string;
  label: string;
  mark: Exclude<CardMark, "auto">;
  color: string;
  type: FieldType;
  values: (number | null)[];
  /** Adds up with the others of its mark. */
  stacked: boolean;
}

export interface ChartData {
  /** label is the whole thing, for the tooltip; tick is what fits on the axis. */
  x: { key: string; label: string; tick: string }[];
  series: ChartSeries[];
  /** What the x values are called, for the table. */
  xLabel: string;
}

const compareCell = (a: CardCell, b: CardCell) =>
  typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b));

const TIME = new Set(["date", "month"]);

/** Turn query results into an axis and series, folding what doesn't fit into Other. */
export function buildChart(
  queries: QueryResult[],
  kind: "line" | "area" | "column",
  options: BlockOptions,
): ChartData {
  // The axis: every x value any query has.
  const seen = new Map<string, { raw: CardCell; label: string; tick: string }>();
  let sortable = false;
  let xLabel = "";
  for (const q of queries) {
    const xCol = q.columns.find((c) => c.role === "dimension");
    if (!xCol) continue;
    xLabel ||= xCol.label;
    if (xCol.bucket || TIME.has(xCol.type)) sortable = true;
    const i = q.columns.indexOf(xCol);
    for (const row of q.rows) {
      const raw = row[i] ?? null;
      const key = String(raw);
      if (!seen.has(key))
        seen.set(key, {
          raw,
          label: formatCell(raw, xCol.type, xCol.bucket),
          tick:
            xCol.type === "date" && !xCol.bucket
              ? formatCell(raw, "text", "day")
              : xCol.bucket === "month"
                ? String(formatMonth(String(raw), true))
                : formatCell(raw, xCol.type, xCol.bucket),
        });
    }
  }
  const entries = [...seen.entries()];
  if (sortable) entries.sort((a, b) => compareCell(a[1].raw, b[1].raw));
  // A query with no dimension is one value: draw it as one point.
  if (entries.length === 0 && queries.some((q) => q.rows.length))
    entries.push(["", { raw: "", label: "Total", tick: "Total" }]);
  const months = new Set(entries.map(([key]) => key.slice(0, 4)));
  const x = entries.map(([key, v]) => ({
    key,
    label: v.label,
    // Months need their year once they run across more than one.
    tick: v.tick !== v.label && months.size > 1 && /^\d{4}-\d{2}$/.test(key) ? v.label : v.tick,
  }));
  const xIndex = new Map(x.map((p, i) => [p.key, i]));

  const series: ChartSeries[] = [];
  let slot = 0;
  queries.forEach((q, layer) => {
    const dims = q.columns.filter((c) => c.role === "dimension");
    const measures = q.columns.filter((c) => c.role === "measure" && !c.hidden);
    const xi = dims[0] ? q.columns.indexOf(dims[0]) : -1;
    const si = dims[1] ? q.columns.indexOf(dims[1]) : -1;
    const sCol = dims[1];

    const markFor = (m: ResultColumn): ChartSeries["mark"] =>
      !m.mark || m.mark === "auto" ? kind : m.mark;
    const add = (
      m: ResultColumn,
      key: string,
      label: string,
      get: (row: CardCell[]) => boolean,
    ) => {
      const values = new Array<number | null>(x.length).fill(null);
      const col = q.columns.indexOf(m);
      for (const row of q.rows) {
        if (!get(row)) continue;
        const at = xi >= 0 ? xIndex.get(String(row[xi] ?? null)) : 0;
        const v = row[col];
        if (at !== undefined && typeof v === "number") values[at] = (values[at] ?? 0) + v;
      }
      const mark = markFor(m);
      series.push({
        key: `${layer}:${key}`,
        label,
        mark,
        color: cardColor(m.color, slot),
        type: m.type,
        values,
        stacked: !!options.stacked && (mark === "area" || mark === "column"),
      });
      if (!m.color || m.color === "auto") slot++;
    };

    if (si >= 0 && sCol) {
      // Every value for every split that has anything in it, largest first.
      const totals = new Map<string, number>();
      const seenSplits = new Map<string, CardCell>();
      for (const row of q.rows) {
        const split = String(row[si] ?? "");
        seenSplits.set(split, row[si] ?? null);
        for (const m of measures) {
          const v = row[q.columns.indexOf(m)];
          // With a running total the latest value says more than adding them up.
          if (typeof v === "number" && v !== 0) {
            const k = `${split}\u0000${m.id}`;
            totals.set(k, Math.max(totals.get(k) ?? 0, Math.abs(v)));
          }
        }
      }
      const names = [...totals.entries()].sort((p, n) => n[1] - p[1]).map(([k]) => k);
      const room = SERIES_SLOTS - slot;
      const keep = names.length > room ? names.slice(0, Math.max(0, room - 1)) : names;
      const start = series.length;
      // Color follows the name, never the rank, so a filter doesn't repaint anything.
      for (const k of [...keep].sort((p, n) => p.localeCompare(n))) {
        const [split = "", id = ""] = k.split("\u0000");
        const m = measures.find((c) => c.id === id);
        if (!m) continue;
        const name = formatCell(seenSplits.get(split) ?? null, sCol.type, sCol.bucket);
        add(
          m,
          k,
          measures.length > 1 ? `${name} · ${m.label}` : name,
          (r) => String(r[si] ?? "") === split,
        );
      }
      const rest = names.filter((n) => !keep.includes(n));
      const firstMeasure = measures[0];
      if (rest.length && firstMeasure) {
        const splits = new Set(rest.map((k) => k.split("\u0000")[0] ?? ""));
        add(firstMeasure, "__other", "Other", (r) => splits.has(String(r[si] ?? "")));
        const last = series[series.length - 1];
        if (last) last.color = OTHER_COLOR;
      }
      // Largest band at the bottom, Other always on top.
      const own = series.slice(start);
      own.sort((p, n) =>
        p.key.endsWith("__other")
          ? 1
          : n.key.endsWith("__other")
            ? -1
            : Math.max(...n.values.map((v) => v ?? 0)) - Math.max(...p.values.map((v) => v ?? 0)),
      );
      series.splice(start, own.length, ...own);
    } else {
      for (const m of measures) add(m, m.id, m.label, () => true);
    }
  });

  return { x, series, xLabel };
}

const H = 200;
const PAD = { top: 12, right: 10, bottom: 24, left: 50 };

const line = (points: ([number, number] | null)[]) => {
  let d = "";
  let pen = false;
  for (const p of points) {
    if (!p) {
      pen = false;
      continue;
    }
    d += `${pen ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)} `;
    pen = true;
  }
  return d;
};

export function XYChart({
  queries,
  kind,
  options,
  references,
  ariaLabel,
}: {
  queries: QueryResult[];
  kind: "line" | "area" | "column";
  options: BlockOptions;
  references?: BlockResult["references"];
  ariaLabel: string;
}) {
  const { ref, width } = useWidth();
  const clipId = useId();
  const [hover, setHover] = useState<number | null>(null);
  const data = useMemo(() => buildChart(queries, kind, options), [queries, kind, options]);
  const height = options.height ?? H;
  const { x, series } = data;
  const type = series[0]?.type ?? "number";

  // Stacked series add up within each mark.
  const stacks = useMemo(() => {
    const out = new Map<string, { lo: number; hi: number }[]>();
    for (const mark of ["area", "column"] as const) {
      const base = new Array<number>(x.length).fill(0);
      for (const s of series) {
        if (s.mark !== mark || !s.stacked) continue;
        out.set(
          s.key,
          s.values.map((v, i) => {
            const lo = base[i] ?? 0;
            const hi = lo + (v ?? 0);
            base[i] = hi;
            return { lo, hi };
          }),
        );
      }
    }
    return out;
  }, [series, x.length]);

  if (x.length === 0 || series.length === 0)
    return <p className="py-6 text-center text-sm text-slate-500">Nothing to show yet.</p>;

  const all: number[] = [0];
  for (const s of series) {
    const st = stacks.get(s.key);
    if (st) for (const p of st) all.push(p.hi);
    else for (const v of s.values) if (v !== null) all.push(v);
  }
  for (const r of references ?? []) if (r.value !== null) all.push(r.value);
  const ticks = niceTicks(Math.min(...all), Math.max(...all));
  const lo = ticks[0] ?? 0;
  const hi = ticks[ticks.length - 1] ?? 1;
  const innerW = Math.max(40, width - PAD.left - PAD.right);
  const innerH = height - PAD.top - PAD.bottom;
  const y = (v: number) => PAD.top + innerH - ((v - lo) / Math.max(hi - lo, 1e-9)) * innerH;
  const hasColumns = series.some((s) => s.mark === "column");
  const band = innerW / x.length;
  // Points sit in the middle of their band when there are columns, and edge to edge otherwise.
  const px = (i: number) =>
    hasColumns || x.length === 1
      ? PAD.left + band * (i + 0.5)
      : PAD.left + (innerW * i) / Math.max(1, x.length - 1);
  const longest = Math.max(1, ...x.map((p) => p.tick.length));
  const fits = Math.max(2, Math.floor(innerW / (longest * 6.5 + 12)));
  const step = Math.max(1, Math.ceil(x.length / fits));

  const columnSeries = series.filter((s) => s.mark === "column");
  const groups = new Set(columnSeries.map((s) => (s.stacked ? "stack" : s.key)));
  const groupKeys = [...groups];
  const groupW = Math.min(36, (band * 0.72) / Math.max(1, groupKeys.length));
  const barX = (s: ChartSeries, i: number) => {
    const g = groupKeys.indexOf(s.stacked ? "stack" : s.key);
    return px(i) - (groupW * groupKeys.length) / 2 + groupW * g + 1;
  };

  const showLegend = options.legend ?? series.length + (references?.length ?? 0) > 1;
  const hovered = hover !== null ? x[hover] : null;

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const mouse = ((e.clientX - box.left) / box.width) * width;
    let best = 0;
    let dist = Number.POSITIVE_INFINITY;
    x.forEach((_, i) => {
      const d = Math.abs(px(i) - mouse);
      if (d < dist) {
        dist = d;
        best = i;
      }
    });
    setHover(best);
  };

  return (
    <div>
      {showLegend && (
        <ul className="mb-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-600 dark:text-slate-400">
          {series.map((s) => (
            <li key={s.key} className="flex items-center gap-1.5">
              <LegendMark mark={s.mark} color={s.color} />
              {s.label}
            </li>
          ))}
          {references?.map((r, i) => (
            <li key={r.label} className="flex items-center gap-1.5">
              <LegendMark mark="dashed" color={cardColor(r.color, series.length + i)} />
              {r.label}
            </li>
          ))}
        </ul>
      )}
      <div ref={ref} className="relative">
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={ariaLabel}
          className="block touch-none"
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        >
          <defs>
            <clipPath id={clipId}>
              <rect x={PAD.left} y={PAD.top} width={innerW} height={innerH} />
            </clipPath>
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
                y={y(t) + 4}
                textAnchor="end"
                fontSize={11}
                fill="var(--viz-muted)"
              >
                {formatCompact(t, type)}
              </text>
            </g>
          ))}
          {x.map((p, i) =>
            i % step === 0 ? (
              <text
                key={p.key}
                x={px(i)}
                y={height - 6}
                textAnchor={
                  hasColumns || x.length === 1
                    ? "middle"
                    : i === 0
                      ? "start"
                      : i === x.length - 1
                        ? "end"
                        : "middle"
                }
                fontSize={11}
                fill="var(--viz-muted)"
              >
                {p.tick}
              </text>
            ) : null,
          )}

          {hover !== null && hasColumns && (
            <rect
              x={px(hover) - band / 2}
              y={PAD.top}
              width={band}
              height={innerH}
              fill="var(--viz-grid)"
              opacity={0.5}
            />
          )}

          {/* Fills first, so lines stay on top. */}
          {series
            .filter((s) => s.mark === "area")
            .map((s) => {
              const st = stacks.get(s.key);
              const top = s.values.map((v, i) => {
                if (st) return [px(i), y(st[i]?.hi ?? 0)] as [number, number];
                return v === null ? null : ([px(i), y(v)] as [number, number]);
              });
              // A band stops where its data does, rather than dropping to nothing.
              const known = top.map((_, i) => i).filter((i) => s.values[i] !== null);
              const first = known[0];
              const last = known[known.length - 1];
              if (first === undefined || last === undefined) return null;
              const bottom = st
                ? known.map((i) => `L${px(i).toFixed(1)} ${y(st[i]?.lo ?? 0).toFixed(1)}`).reverse()
                : [
                    `L${px(last).toFixed(1)} ${y(Math.max(0, lo)).toFixed(1)}`,
                    `L${px(first).toFixed(1)} ${y(Math.max(0, lo)).toFixed(1)}`,
                  ];
              const path = `${line(known.map((i) => top[i] ?? null))}${bottom.join(" ")} Z`;
              return (
                <path
                  key={s.key}
                  d={path}
                  fill={s.color}
                  fillOpacity={st ? 0.85 : 0.18}
                  stroke={st ? "var(--viz-surface)" : "none"}
                  strokeWidth={st ? 1 : 0}
                />
              );
            })}

          {series
            .filter((s) => s.mark === "column")
            .flatMap((s) => {
              const st = stacks.get(s.key);
              return s.values.map((v, i) => {
                if (v === null || v === 0) return null;
                const top = st ? (st[i]?.hi ?? 0) : v;
                const bottom = st ? (st[i]?.lo ?? 0) : 0;
                const yTop = y(Math.max(top, bottom));
                const yBottom = y(Math.min(top, bottom));
                const w = Math.max(2, groupW - 2);
                const barH = Math.max(1, yBottom - yTop - (st ? 2 : 0));
                return (
                  <rect
                    key={`${s.key}-${x[i]?.key}`}
                    x={barX(s, i)}
                    y={yTop}
                    width={w}
                    height={barH}
                    rx={Math.min(4, w / 2)}
                    fill={s.color}
                  />
                );
              });
            })}

          {series
            .filter(
              (s) => s.mark === "line" || s.mark === "dashed" || (s.mark === "area" && !s.stacked),
            )
            .map((s) => (
              <path
                key={s.key}
                d={line(s.values.map((v, i) => (v === null ? null : [px(i), y(v)])))}
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                strokeDasharray={s.mark === "dashed" ? "5 4" : undefined}
                clipPath={`url(#${clipId})`}
              />
            ))}

          {references?.map((r, i) =>
            r.value === null ? null : (
              <line
                key={r.label}
                x1={PAD.left}
                x2={width - PAD.right}
                y1={y(r.value)}
                y2={y(r.value)}
                stroke={cardColor(r.color, series.length + i)}
                strokeWidth={2}
                strokeDasharray="5 4"
              />
            ),
          )}

          {hover !== null && !hasColumns && (
            <>
              <line
                x1={px(hover)}
                x2={px(hover)}
                y1={PAD.top}
                y2={PAD.top + innerH}
                stroke="var(--viz-axis)"
              />
              {series.map((s) => {
                if (s.values[hover] === null) return null;
                const st = stacks.get(s.key);
                const v = st ? st[hover]?.hi : s.values[hover];
                if (v === null || v === undefined) return null;
                return (
                  <circle
                    key={s.key}
                    cx={px(hover)}
                    cy={y(v)}
                    r={4}
                    fill={s.color}
                    stroke="var(--viz-surface)"
                    strokeWidth={2}
                  />
                );
              })}
            </>
          )}
        </svg>

        {hover !== null && hovered && (
          <div
            role="tooltip"
            className="pointer-events-none absolute z-10 max-w-64 rounded-lg border border-slate-200 bg-surface px-2.5 py-1.5 text-xs shadow-md dark:border-slate-700 dark:bg-slate-900"
            style={{
              top: 4,
              ...(px(hover) > width * 0.6
                ? { right: width - px(hover) + 12 }
                : { left: px(hover) + 12 }),
            }}
          >
            <p className="mb-1 font-medium">{hovered.label}</p>
            <ul className="space-y-0.5">
              {[...series]
                .filter((s) => s.values[hover] !== null)
                .sort((a, b) => (b.values[hover] ?? 0) - (a.values[hover] ?? 0))
                .slice(0, 12)
                .map((s) => (
                  <li key={s.key} className="flex items-center justify-between gap-3">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <LegendMark mark={s.mark} color={s.color} />
                      <span className="truncate">{s.label}</span>
                    </span>
                    <span className="tabular-nums">
                      {formatCell(s.values[hover] ?? null, s.type)}
                    </span>
                  </li>
                ))}
            </ul>
          </div>
        )}
      </div>

      <table className="sr-only">
        <caption>{ariaLabel}</caption>
        <thead>
          <tr>
            <th>{data.xLabel}</th>
            {series.map((s) => (
              <th key={s.key}>{s.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {x.map((p, i) => (
            <tr key={p.key}>
              <th>{p.label}</th>
              {series.map((s) => (
                <td key={s.key}>{formatCell(s.values[i] ?? null, s.type)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LegendMark({ mark, color }: { mark: ChartSeries["mark"]; color: string }) {
  if (mark === "line" || mark === "dashed")
    return (
      <svg aria-hidden="true" width="14" height="4" className="shrink-0">
        <line
          x1="0"
          x2="14"
          y1="2"
          y2="2"
          stroke={color}
          strokeWidth="2"
          strokeDasharray={mark === "dashed" ? "4 2" : undefined}
        />
      </svg>
    );
  return (
    <span
      aria-hidden="true"
      className="size-2.5 shrink-0 rounded-sm"
      style={{ background: color }}
    />
  );
}

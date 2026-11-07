import {
  type BlockResult,
  type CardBlock,
  type CardCell,
  type CardDoc,
  type CardResult,
  type CardTone,
  formatCell,
  formatCompact,
  INTERNAL_LINK,
  type QueryResult,
  type ResultColumn,
} from "@muny/shared";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { CoinIcon } from "../components/coins.js";
import { Button, cx } from "../components/ui.js";
import { CategoryIcon, MerchantAvatar } from "../components/visuals.js";
import { OTHER_COLOR, seriesColor } from "../lib/series.js";
import { cardColor, niceTicks, useWidth, XYChart } from "./xychart.js";

/** Every kind of block. All of it is plain text and numbers, in the theme's colors. */

const TONE: Record<CardTone, string> = {
  normal: "",
  muted: "text-slate-500",
  positive: "text-emerald-700 dark:text-emerald-400",
  negative: "text-red-600 dark:text-red-400",
  warning: "text-amber-700 dark:text-amber-400",
};

const SIZE = {
  sm: "text-base font-medium",
  md: "text-2xl font-semibold",
  lg: "text-3xl font-semibold tracking-tight",
  xl: "text-4xl font-semibold tracking-tight",
};

const nothing = <p className="py-4 text-center text-sm text-slate-500">Nothing to show yet.</p>;

const visible = (q: QueryResult, role: ResultColumn["role"]) =>
  q.columns.filter((c) => c.role === role && !c.hidden);

const colIndex = (q: QueryResult, name: string | undefined, fallback?: ResultColumn) => {
  const lower = name?.toLowerCase();
  const found = lower
    ? q.columns.find((c) => c.id.toLowerCase() === lower || c.label.toLowerCase() === lower)
    : undefined;
  const col = found ?? fallback;
  return col ? { col, i: q.columns.indexOf(col) } : null;
};

function StatBlock({ block, result }: { block: CardBlock; result: BlockResult }) {
  const o = block.options ?? {};
  const size = SIZE[o.size ?? "lg"];
  const delta = result.delta;
  const raw = typeof delta?.value === "number" ? delta.value : null;
  const good =
    raw === null || raw === 0 || o.goodWhen === "either" || !o.goodWhen
      ? null
      : o.goodWhen === "up"
        ? raw > 0
        : raw < 0;
  const q = result.queries[0];
  const sparkMeasure = q ? visible(q, "measure")[0] : undefined;
  const sparkValues =
    o.spark && q && sparkMeasure
      ? q.rows
          .map((r) => r[q.columns.indexOf(sparkMeasure)])
          .filter((v): v is number => typeof v === "number")
      : [];
  return (
    <div className="min-w-0">
      {o.label && <p className="text-sm font-medium text-slate-500">{o.label}</p>}
      <p className={cx("tabular-nums", size, result.tone && TONE[result.tone])}>
        {result.value?.text ?? "—"}
      </p>
      {delta && raw !== null && (
        <p
          className={cx(
            "mt-0.5 text-sm",
            good === null
              ? "text-slate-500"
              : good
                ? "text-emerald-700 dark:text-emerald-400"
                : "text-red-600 dark:text-red-400",
          )}
        >
          {raw === 0
            ? `The same as ${o.compareLabel ?? "before"}`
            : `${raw > 0 ? "▲" : "▼"} ${delta.text.replace(/^-/, "")} ${raw > 0 ? "more" : "less"} than ${o.compareLabel ?? "before"}`}
        </p>
      )}
      {result.text && <p className="mt-0.5 text-xs text-slate-500">{result.text}</p>}
      {sparkValues.length > 1 && <Spark values={sparkValues} />}
    </div>
  );
}

function Spark({ values }: { values: number[] }) {
  const { ref, width } = useWidth();
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const H = 36;
  const d = values
    .map((v, i) => {
      const x = (i / Math.max(1, values.length - 1)) * (width - 4) + 2;
      const y = H - 3 - ((v - lo) / Math.max(hi - lo, 1e-9)) * (H - 6);
      return `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <div ref={ref} className="mt-2">
      <svg aria-hidden="true" width={width} height={H} className="block">
        <path
          d={d}
          fill="none"
          stroke="var(--viz-series-1)"
          strokeWidth={2}
          strokeLinecap="round"
        />
      </svg>
    </div>
  );
}

function ProgressBar({
  value,
  target,
  marker,
  overIsBad,
}: {
  value: number;
  target: number | null;
  marker?: number | null;
  overIsBad?: boolean;
}) {
  const max = Math.max(target ?? 0, 1);
  const pct = (v: number) => Math.min(100, Math.max(0, (v / max) * 100));
  const over = target !== null && value > target;
  return (
    <div className="relative h-2.5 rounded-full bg-slate-100 dark:bg-slate-800">
      <div
        className="h-full rounded-full"
        style={{
          width: `${pct(value)}%`,
          background: over && overIsBad ? "var(--viz-negative)" : "var(--viz-series-1)",
        }}
      />
      {marker !== null && marker !== undefined && (
        <div
          aria-hidden="true"
          className="absolute -top-1 h-4.5 w-0.5 rounded bg-slate-500 dark:bg-slate-300"
          style={{ left: `calc(${pct(marker)}% - 1px)` }}
        />
      )}
    </div>
  );
}

const numeric = (v: CardCell | undefined) => (typeof v === "number" ? v : null);

function ProgressBlock({ block, result }: { block: CardBlock; result: BlockResult }) {
  const o = block.options ?? {};
  const q = result.queries[0];
  const dim = q ? visible(q, "dimension")[0] : undefined;
  if (q && dim) {
    const measures = visible(q, "measure");
    const value = colIndex(q, o.value, measures[0]);
    const target = colIndex(q, o.target, measures[1]);
    const marker = colIndex(q, o.marker);
    if (!value) return nothing;
    if (q.rows.length === 0) return nothing;
    return (
      <ul className="space-y-3">
        {q.rows.map((row) => {
          const label = formatCell(row[q.columns.indexOf(dim)] ?? null, dim.type, dim.bucket);
          const v = numeric(row[value.i]) ?? 0;
          const t = target ? numeric(row[target.i]) : null;
          return (
            <li key={label} className="text-sm">
              <div className="mb-1 flex items-baseline justify-between gap-3">
                <span className="truncate">{label}</span>
                <span className="shrink-0 text-xs text-slate-500 tabular-nums">
                  {formatCell(v, value.col.type)}
                  {target && t !== null && ` of ${formatCell(t, target.col.type)}`}
                </span>
              </div>
              <ProgressBar
                value={v}
                target={t}
                marker={marker ? numeric(row[marker.i]) : undefined}
                overIsBad={o.overIsBad}
              />
            </li>
          );
        })}
      </ul>
    );
  }
  const v = numeric(result.value?.value) ?? 0;
  const t = numeric(result.target?.value);
  return (
    <div className="text-sm">
      {o.label && <p className="mb-1 text-slate-500">{o.label}</p>}
      <ProgressBar
        value={v}
        target={t}
        marker={numeric(result.marker?.value)}
        overIsBad={o.overIsBad}
      />
      {result.text && <p className="mt-1.5 text-xs text-slate-500">{result.text}</p>}
    </div>
  );
}

function RowIcon({
  kind,
  name,
  rank,
}: {
  kind: NonNullable<CardBlock["options"]>["icon"];
  name: string;
  rank: number;
}) {
  switch (kind) {
    case "merchant":
      return <MerchantAvatar name={name} />;
    case "category":
      return <CategoryIcon name={name} />;
    case "coin":
      return <CoinIcon asset={name} size="sm" />;
    case "rank":
      return <span className="w-4 text-right text-xs text-slate-400 tabular-nums">{rank}</span>;
    default:
      return null;
  }
}

function ListBlock({ block, result }: { block: CardBlock; result: BlockResult }) {
  const o = block.options ?? {};
  const q = result.queries[0];
  if (!q || q.rows.length === 0) return nothing;
  const dims = visible(q, "dimension");
  const measures = visible(q, "measure");
  const group = o.groupBy ? colIndex(q, o.groupBy) : null;
  const rest = dims.filter((d) => d !== group?.col);
  const title = colIndex(q, o.title, rest[0]);
  const subtitle = colIndex(q, o.subtitle, rest[1]);
  const amount = colIndex(q, o.amount, measures[0]);
  const subamount = colIndex(q, o.subamount, measures[1]);
  const sign = o.flip ? -1 : 1;
  const max = Math.max(1, ...q.rows.map((r) => Math.abs(numeric(r[amount?.i ?? -1]) ?? 0)));

  const row = (r: CardCell[], i: number, indent: boolean) => {
    const name = title ? formatCell(r[title.i] ?? null, title.col.type, title.col.bucket) : "";
    const v = amount ? numeric(r[amount.i]) : null;
    const shown = v === null ? null : v * sign;
    return (
      <li key={i} className={cx("flex items-center gap-3 py-2", indent && "pl-6")}>
        <RowIcon kind={o.icon} name={name} rank={i + 1} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{name}</span>
          {subtitle && r[subtitle.i] !== null && (
            <span className="block truncate text-xs text-slate-500">
              {formatCell(r[subtitle.i] ?? null, subtitle.col.type, subtitle.col.bucket)}
            </span>
          )}
          {o.bar && v !== null && (
            <span className="mt-1 block h-1.5 rounded-full bg-slate-100 dark:bg-slate-800">
              <span
                className="block h-full rounded-full"
                style={{
                  width: `${Math.max(2, (Math.abs(v) / max) * 100)}%`,
                  background: "var(--viz-series-1)",
                }}
              />
            </span>
          )}
        </span>
        <span className="shrink-0 text-right">
          {amount && (
            <span
              className={cx(
                "block text-sm font-medium tabular-nums",
                o.signColors && (shown ?? 0) > 0 && "text-emerald-700 dark:text-emerald-400",
              )}
            >
              {o.signColors && shown !== null
                ? `${shown > 0 ? "+" : ""}${formatCell(Math.abs(shown), amount.col.type)}`
                : formatCell(shown, amount.col.type)}
            </span>
          )}
          {subamount && (
            <span className="block text-xs text-slate-500 tabular-nums">
              {formatCell(r[subamount.i] ?? null, subamount.col.type)}{" "}
              {subamount.col.label.toLowerCase()}
            </span>
          )}
        </span>
      </li>
    );
  };

  if (group) {
    const groups = new Map<string, CardCell[][]>();
    for (const r of q.rows) {
      const k = formatCell(r[group.i] ?? null, group.col.type, group.col.bucket);
      const list = groups.get(k);
      if (list) list.push(r);
      else groups.set(k, [r]);
    }
    return (
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {[...groups.entries()].map(([label, rows]) => (
          <ListGroup
            key={label}
            label={label}
            count={rows.length}
            total={
              amount
                ? formatCell(
                    rows.reduce((s, r) => s + (numeric(r[amount.i]) ?? 0), 0) * sign,
                    amount.col.type,
                  )
                : ""
            }
          >
            {rows.map((r, i) => row(r, i, true))}
          </ListGroup>
        ))}
      </ul>
    );
  }
  return (
    <ul className="divide-y divide-slate-100 dark:divide-slate-800">
      {q.rows.map((r, i) => row(r, i, false))}
    </ul>
  );
}

function ListGroup({
  label,
  count,
  total,
  children,
}: {
  label: string;
  count: number;
  total: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-3 py-2.5 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800/50"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden="true"
            className={cx("text-xs text-slate-400 transition-transform", open && "rotate-90")}
          >
            ▶
          </span>
          <span className="truncate font-medium">{label}</span>
          <span className="text-xs text-slate-500">{count}</span>
        </span>
        <span className="tabular-nums">{total}</span>
      </button>
      {open && <ul className="divide-y divide-slate-100 dark:divide-slate-800">{children}</ul>}
    </li>
  );
}

function TableBlock({ block, result }: { block: CardBlock; result: BlockResult }) {
  const o = block.options ?? {};
  const q = result.queries[0];
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null);
  const rows = useMemo(() => {
    if (!q) return [];
    if (!sort) return q.rows;
    return [...q.rows].sort((a, b) => {
      const x = a[sort.col] ?? null;
      const y = b[sort.col] ?? null;
      if (x === y) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      if (typeof x === "number" && typeof y === "number") return (x - y) * sort.dir;
      return String(x).localeCompare(String(y)) * sort.dir;
    });
  }, [q, sort]);
  if (!q || q.rows.length === 0) return nothing;
  const cols = q.columns.map((c, i) => ({ c, i })).filter(({ c }) => !c.hidden);
  const isNumber = (c: ResultColumn) =>
    c.type === "money" || c.type === "number" || c.type === "percent";
  return (
    <div className="max-h-[32rem] overflow-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-surface text-xs text-slate-500 dark:bg-slate-900">
          <tr>
            {cols.map(({ c, i }) => (
              <th
                key={c.id}
                scope="col"
                aria-sort={
                  sort?.col === i ? (sort.dir === 1 ? "ascending" : "descending") : undefined
                }
                className={cx("px-2 py-1.5 font-medium", isNumber(c) ? "text-right" : "text-left")}
              >
                <button
                  type="button"
                  className="hover:underline"
                  onClick={() =>
                    setSort((s) => ({
                      col: i,
                      dir:
                        s?.col === i && s.dir === (isNumber(c) ? -1 : 1)
                          ? isNumber(c)
                            ? 1
                            : -1
                          : isNumber(c)
                            ? -1
                            : 1,
                    }))
                  }
                >
                  {c.label}
                  {sort?.col === i && (sort.dir === 1 ? " ↑" : " ↓")}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {rows.map((r, n) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows of a result have no identity of their own.
            <tr key={n}>
              {cols.map(({ c, i }) => (
                <td
                  key={c.id}
                  className={cx(
                    "px-2 py-1.5",
                    isNumber(c) ? "text-right tabular-nums" : "text-left",
                  )}
                >
                  {formatCell(r[i] ?? null, c.type, c.bucket)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {o.totals && (
          <tfoot className="border-t-2 border-slate-200 font-medium dark:border-slate-700">
            <tr>
              {cols.map(({ c }, n) => (
                <td
                  key={c.id}
                  className={cx(
                    "px-2 py-1.5",
                    isNumber(c) ? "text-right tabular-nums" : "text-left",
                  )}
                >
                  {c.role === "measure"
                    ? formatCell(q.totals[c.id] ?? null, c.type)
                    : n === 0
                      ? "Total"
                      : ""}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
      {q.truncated && <p className="px-2 pt-2 text-xs text-slate-500">Showing the first rows.</p>}
    </div>
  );
}

/** A dimension and a measure from a query, which most chart blocks start from. */
function pairs(q: QueryResult | undefined) {
  if (!q) return null;
  const dim = visible(q, "dimension")[0];
  const measure = visible(q, "measure")[0];
  if (!dim || !measure) return null;
  const di = q.columns.indexOf(dim);
  const mi = q.columns.indexOf(measure);
  const items = q.rows.map((r) => ({
    key: String(r[di] ?? "—"),
    label: formatCell(r[di] ?? null, dim.type, dim.bucket),
    value: numeric(r[mi]) ?? 0,
    isOther: r[di] === "Other",
  }));
  return { dim, measure, items };
}

function BarsBlock({ block, result }: { block: CardBlock; result: BlockResult }) {
  const o = block.options ?? {};
  const p = pairs(result.queries[0]);
  if (!p || p.items.length === 0) return nothing;
  const max = Math.max(1, ...p.items.map((i) => Math.abs(i.value)));
  const total = p.items.reduce((s, i) => s + Math.max(0, i.value), 0);
  return (
    <ul className="space-y-2">
      {p.items.map((i) => (
        <li
          key={i.key}
          title={`${i.label}: ${formatCell(i.value, p.measure.type)}`}
          className="text-sm"
        >
          <div className="flex items-baseline justify-between gap-3">
            <span className="truncate">{i.label}</span>
            <span className="shrink-0 tabular-nums">
              {formatCell(i.value, p.measure.type)}
              {o.percent && total > 0 && (
                <span className="ml-2 inline-block w-9 text-right text-xs text-slate-500">
                  {Math.round((Math.max(0, i.value) / total) * 100)}%
                </span>
              )}
            </span>
          </div>
          <div className="mt-1 h-2 w-full">
            <div
              className="h-full rounded-r-[4px]"
              style={{
                width: `${Math.max(0.5, (Math.abs(i.value) / max) * 100)}%`,
                background: i.isOther ? OTHER_COLOR : cardColor(p.measure.color, 0),
              }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

function PieBlock({ block, result }: { block: CardBlock; result: BlockResult }) {
  const o = block.options ?? {};
  const [hover, setHover] = useState<string | null>(null);
  const p = pairs(result.queries[0]);
  const items = (p?.items ?? []).filter((i) => i.value > 0);
  if (!p || items.length === 0) return nothing;
  // A handful of slices read as parts of a whole; the rest are folded together.
  const sorted = [...items].sort((a, b) => b.value - a.value);
  const top = sorted.length > 8 ? sorted.slice(0, 7) : sorted;
  const rest = sorted.slice(top.length);
  const named = [...top].sort((a, b) => a.key.localeCompare(b.key));
  const slices = [
    ...sorted
      .slice(0, top.length)
      .map((s) => ({ ...s, color: s.isOther ? OTHER_COLOR : seriesColor(named.indexOf(s)) })),
    ...(rest.length
      ? [
          {
            key: "__rest",
            label: "Other",
            value: rest.reduce((s, x) => s + x.value, 0),
            isOther: true,
            color: OTHER_COLOR,
          },
        ]
      : []),
  ];
  const total = slices.reduce((s, x) => s + x.value, 0);
  const size = 180;
  const thickness = o.donut === false ? size / 2 : 28;
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const gap = slices.length > 1 ? 2 : 0;
  let acc = 0;
  const shown = slices.find((s) => s.key === hover);
  return (
    <div className="flex flex-wrap items-center justify-center gap-4">
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg
          width={size}
          height={size}
          role="img"
          aria-label={block.title ?? `${p.measure.label} by ${p.dim.label}`}
          className="-rotate-90"
        >
          {slices.map((s) => {
            const len = (s.value / total) * c;
            const el = (
              <circle
                key={s.key}
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                stroke={s.color}
                strokeWidth={thickness}
                strokeDasharray={`${Math.max(0, len - gap)} ${c}`}
                strokeDashoffset={-acc}
                onPointerEnter={() => setHover(s.key)}
                onPointerLeave={() => setHover(null)}
              />
            );
            acc += len;
            return el;
          })}
        </svg>
        {o.donut !== false && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-8 text-center">
            <span className="text-sm font-semibold tabular-nums">
              {shown
                ? formatCell(shown.value, p.measure.type)
                : (result.center ?? formatCell(total, p.measure.type))}
            </span>
            {shown && <span className="truncate text-xs text-slate-500">{shown.label}</span>}
          </div>
        )}
      </div>
      <ul className="min-w-40 flex-1 space-y-1 text-sm">
        {slices.map((s) => (
          <li key={s.key} className="flex items-center justify-between gap-3">
            <span className="flex min-w-0 items-center gap-1.5">
              <span
                aria-hidden="true"
                className="size-2.5 shrink-0 rounded-sm"
                style={{ background: s.color }}
              />
              <span className="truncate">{s.label}</span>
            </span>
            <span className="shrink-0 tabular-nums">{formatCell(s.value, p.measure.type)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Squarified treemap layout. */
function squarify(
  items: { value: number; key: string }[],
  box: { x: number; y: number; w: number; h: number },
) {
  const out = new Map<string, { x: number; y: number; w: number; h: number }>();
  const total = items.reduce((s, i) => s + i.value, 0);
  if (total <= 0) return out;
  const scale = (box.w * box.h) / total;
  const rest = items.map((i) => ({ ...i, area: i.value * scale }));
  let { x, y, w, h } = box;
  while (rest.length) {
    const side = Math.min(w, h);
    const row: typeof rest = [];
    let best = Number.POSITIVE_INFINITY;
    while (rest.length) {
      const next = rest[0] as (typeof rest)[number];
      const areas = [...row, next].map((r) => r.area);
      const sum = areas.reduce((s, a) => s + a, 0);
      const worst = Math.max(
        ...areas.map((a) =>
          Math.max((side * side * a) / (sum * sum), (sum * sum) / (side * side * a)),
        ),
      );
      if (worst > best) break;
      best = worst;
      row.push(next);
      rest.shift();
    }
    const sum = row.reduce((s, r) => s + r.area, 0);
    const thick = sum / side;
    let at = 0;
    for (const r of row) {
      const len = r.area / thick;
      out.set(
        r.key,
        w >= h ? { x, y: y + at, w: thick, h: len } : { x: x + at, y, w: len, h: thick },
      );
      at += len;
    }
    if (w >= h) {
      x += thick;
      w -= thick;
    } else {
      y += thick;
      h -= thick;
    }
  }
  return out;
}

function TreemapBlock({ block, result }: { block: CardBlock; result: BlockResult }) {
  const { ref, width } = useWidth();
  const p = pairs(result.queries[0]);
  const items = (p?.items ?? []).filter((i) => i.value > 0).sort((a, b) => b.value - a.value);
  const height = block.options?.height ?? 240;
  const rects = useMemo(
    () => squarify(items, { x: 0, y: 0, w: width, h: height }),
    [items, width, height],
  );
  if (!p || items.length === 0) return nothing;
  const named = items
    .slice(0, 7)
    .map((i) => i.key)
    .sort((a, b) => a.localeCompare(b));
  return (
    <div ref={ref} className="relative overflow-hidden rounded-lg" style={{ height }}>
      {items.map((i) => {
        const r = rects.get(i.key);
        if (!r) return null;
        const slot = named.indexOf(i.key);
        const room = r.w > 64 && r.h > 34;
        return (
          <div
            key={i.key}
            title={`${i.label}: ${formatCell(i.value, p.measure.type)}`}
            className="absolute overflow-hidden rounded-[4px] border-2 border-surface p-1.5 text-xs text-white dark:border-slate-900"
            style={{
              left: r.x,
              top: r.y,
              width: r.w,
              height: r.h,
              background: slot >= 0 ? seriesColor(slot) : OTHER_COLOR,
            }}
          >
            {room && (
              <>
                <span className="block truncate font-medium">{i.label}</span>
                <span className="block truncate tabular-nums">
                  {formatCell(i.value, p.measure.type)}
                </span>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

function HeatmapBlock({ result }: { result: BlockResult }) {
  const q = result.queries[0];
  if (!q) return nothing;
  const [xCol, yCol] = visible(q, "dimension");
  const measure = visible(q, "measure")[0];
  if (!xCol || !yCol || !measure) return nothing;
  const xi = q.columns.indexOf(xCol);
  const yi = q.columns.indexOf(yCol);
  const mi = q.columns.indexOf(measure);
  const order = (i: number) =>
    [...new Set(q.rows.map((r) => r[i] ?? null))].sort((a, b) =>
      typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b)),
    );
  const xs = order(xi);
  const ys = order(yi);
  const cells = new Map(q.rows.map((r) => [`${r[xi]}|${r[yi]}`, numeric(r[mi])]));
  const values = [...cells.values()].filter((v): v is number => v !== null);
  const max = Math.max(1, ...values.map(Math.abs));
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-separate border-spacing-0.5 text-xs">
        <thead>
          <tr>
            <th />
            {xs.map((x) => (
              <th key={String(x)} scope="col" className="px-0.5 font-normal text-slate-500">
                {formatCell(x, xCol.type, xCol.bucket)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ys.map((y) => (
            <tr key={String(y)}>
              <th
                scope="row"
                className="max-w-28 truncate pr-2 text-right font-normal text-slate-500"
              >
                {formatCell(y, yCol.type, yCol.bucket)}
              </th>
              {xs.map((x) => {
                const v = cells.get(`${x}|${y}`) ?? null;
                const pct = v === null ? 0 : Math.round((Math.abs(v) / max) * 100);
                const text = `${formatCell(x, xCol.type, xCol.bucket)}, ${formatCell(y, yCol.type, yCol.bucket)}: ${formatCell(v, measure.type)}`;
                return (
                  <td
                    key={String(x)}
                    title={text}
                    aria-label={text}
                    className="h-7 min-w-6 rounded-[4px]"
                    style={{
                      background: `color-mix(in oklab, var(--viz-series-1) ${pct}%, var(--viz-grid))`,
                    }}
                  />
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ScatterBlock({ block, result }: { block: CardBlock; result: BlockResult }) {
  const { ref, width } = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const q = result.queries[0];
  const measures = q ? visible(q, "measure") : [];
  const dim = q ? visible(q, "dimension")[0] : undefined;
  const xCol = measures[0];
  const yCol = measures[1];
  if (!q || !xCol || !yCol) return nothing;
  const xi = q.columns.indexOf(xCol);
  const yi = q.columns.indexOf(yCol);
  const points = q.rows
    .map((r, i) => ({ i, x: numeric(r[xi]), y: numeric(r[yi]) }))
    .filter((p): p is { i: number; x: number; y: number } => p.x !== null && p.y !== null);
  if (!points.length) return nothing;
  const height = block.options?.height ?? 240;
  const xTicks = niceTicks(
    Math.min(0, ...points.map((p) => p.x)),
    Math.max(...points.map((p) => p.x)),
  );
  const yTicks = niceTicks(
    Math.min(0, ...points.map((p) => p.y)),
    Math.max(...points.map((p) => p.y)),
  );
  const PAD = { top: 10, right: 12, bottom: 34, left: 52 };
  const span = (t: number[]) => Math.max((t[t.length - 1] ?? 1) - (t[0] ?? 0), 1e-9);
  const px = (v: number) =>
    PAD.left + ((v - (xTicks[0] ?? 0)) / span(xTicks)) * (width - PAD.left - PAD.right);
  const py = (v: number) =>
    height - PAD.bottom - ((v - (yTicks[0] ?? 0)) / span(yTicks)) * (height - PAD.top - PAD.bottom);
  const hovered = hover !== null ? q.rows[hover] : null;
  return (
    <div ref={ref} className="relative">
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={`${yCol.label} against ${xCol.label}`}
      >
        {yTicks.map((t) => (
          <g key={t}>
            <line
              x1={PAD.left}
              x2={width - PAD.right}
              y1={py(t)}
              y2={py(t)}
              stroke="var(--viz-grid)"
            />
            <text
              x={PAD.left - 6}
              y={py(t) + 4}
              textAnchor="end"
              fontSize={11}
              fill="var(--viz-muted)"
            >
              {formatCompact(t, yCol.type)}
            </text>
          </g>
        ))}
        {xTicks.map((t) => (
          <text
            key={t}
            x={px(t)}
            y={height - PAD.bottom + 16}
            textAnchor="middle"
            fontSize={11}
            fill="var(--viz-muted)"
          >
            {formatCompact(t, xCol.type)}
          </text>
        ))}
        <text
          x={(width + PAD.left) / 2}
          y={height - 4}
          textAnchor="middle"
          fontSize={11}
          fill="var(--viz-muted)"
        >
          {xCol.label}
        </text>
        {points.map((p) => (
          <circle
            key={p.i}
            cx={px(p.x)}
            cy={py(p.y)}
            r={5}
            fill="var(--viz-series-1)"
            stroke="var(--viz-surface)"
            strokeWidth={2}
            onPointerEnter={() => setHover(p.i)}
            onPointerLeave={() => setHover(null)}
          />
        ))}
      </svg>
      {hovered && (
        <div
          role="tooltip"
          className="pointer-events-none absolute top-1 right-1 rounded-lg border border-slate-200 bg-surface px-2.5 py-1.5 text-xs shadow-md dark:border-slate-700 dark:bg-slate-900"
        >
          {dim && (
            <p className="font-medium">
              {formatCell(hovered[q.columns.indexOf(dim)] ?? null, dim.type, dim.bucket)}
            </p>
          )}
          <p className="tabular-nums">
            {xCol.label}: {formatCell(hovered[xi] ?? null, xCol.type)}
          </p>
          <p className="tabular-nums">
            {yCol.label}: {formatCell(hovered[yi] ?? null, yCol.type)}
          </p>
        </div>
      )}
    </div>
  );
}

function WaterfallBlock({ block, result }: { block: CardBlock; result: BlockResult }) {
  const { ref, width } = useWidth();
  const p = pairs(result.queries[0]);
  if (!p || p.items.length === 0) return nothing;
  const height = block.options?.height ?? 220;
  const PAD = { top: 10, right: 8, bottom: 24, left: 50 };
  let run = 0;
  const steps = p.items.map((i) => {
    const from = run;
    run += i.value;
    return { ...i, from, to: run };
  });
  const total = run;
  const bars = [
    ...steps,
    { key: "__total", label: "Total", value: total, from: 0, to: total, isOther: false },
  ];
  const ticks = niceTicks(
    Math.min(0, ...bars.map((b) => Math.min(b.from, b.to))),
    Math.max(...bars.map((b) => Math.max(b.from, b.to)), 1),
  );
  const lo = ticks[0] ?? 0;
  const hi = ticks[ticks.length - 1] ?? 1;
  const y = (v: number) =>
    PAD.top + (height - PAD.top - PAD.bottom) * (1 - (v - lo) / Math.max(hi - lo, 1e-9));
  const band = (width - PAD.left - PAD.right) / bars.length;
  const w = Math.min(44, band * 0.7);
  const every = Math.max(1, Math.ceil(bars.length / Math.max(2, Math.floor((width - 58) / 60))));
  return (
    <div ref={ref}>
      <ul className="mb-2 flex flex-wrap gap-x-3 text-xs text-slate-600 dark:text-slate-400">
        {[
          ["Up", "var(--viz-positive)"],
          ["Down", "var(--viz-negative)"],
          ["Total", "var(--viz-series-1)"],
        ].map(([label, color]) => (
          <li key={label} className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="size-2.5 rounded-sm"
              style={{ background: color }}
            />
            {label}
          </li>
        ))}
      </ul>
      <svg width={width} height={height} role="img" aria-label={`How ${p.measure.label} builds up`}>
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={PAD.left}
              x2={width - PAD.right}
              y1={y(t)}
              y2={y(t)}
              stroke={t === 0 ? "var(--viz-axis)" : "var(--viz-grid)"}
            />
            <text
              x={PAD.left - 6}
              y={y(t) + 4}
              textAnchor="end"
              fontSize={11}
              fill="var(--viz-muted)"
            >
              {formatCompact(t, p.measure.type)}
            </text>
          </g>
        ))}
        {bars.map((b, i) => {
          const cx0 = PAD.left + band * (i + 0.5);
          const top = y(Math.max(b.from, b.to));
          const bottom = y(Math.min(b.from, b.to));
          const isTotal = b.key === "__total";
          return (
            <g key={b.key}>
              <rect
                x={cx0 - w / 2}
                y={top}
                width={w}
                height={Math.max(1, bottom - top)}
                rx={Math.min(4, w / 2)}
                fill={
                  isTotal
                    ? "var(--viz-series-1)"
                    : b.value >= 0
                      ? "var(--viz-positive)"
                      : "var(--viz-negative)"
                }
              >
                <title>{`${b.label}: ${formatCell(b.value, p.measure.type)}`}</title>
              </rect>
              {i % every === 0 && (
                <text
                  x={cx0}
                  y={height - 6}
                  textAnchor="middle"
                  fontSize={11}
                  fill="var(--viz-muted)"
                >
                  {b.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

const pad = (n: number) => String(n).padStart(2, "0");

function CalendarBlock({ result, today }: { result: BlockResult; today: string }) {
  const q = result.queries[0];
  const [cursor, setCursor] = useState(() => ({
    y: Number(today.slice(0, 4)),
    m: Number(today.slice(5, 7)) - 1,
  }));
  if (!q) return nothing;
  const dims = visible(q, "dimension");
  const dateCol = dims.find((d) => d.type === "date") ?? dims[0];
  const nameCol = dims.find((d) => d !== dateCol);
  const measure = visible(q, "measure")[0];
  if (!dateCol) return nothing;
  const di = q.columns.indexOf(dateCol);
  const ni = nameCol ? q.columns.indexOf(nameCol) : -1;
  const mi = measure ? q.columns.indexOf(measure) : -1;
  const byDay = new Map<string, CardCell[][]>();
  for (const r of q.rows) {
    const k = String(r[di] ?? "").slice(0, 10);
    const list = byDay.get(k);
    if (list) list.push(r);
    else byDay.set(k, [r]);
  }
  const first = new Date(Date.UTC(cursor.y, cursor.m, 1));
  const days = new Date(Date.UTC(cursor.y, cursor.m + 1, 0)).getUTCDate();
  const cells: (string | null)[] = Array.from({ length: first.getUTCDay() }, () => null);
  for (let d = 1; d <= days; d++) cells.push(`${cursor.y}-${pad(cursor.m + 1)}-${pad(d)}`);
  while (cells.length % 7) cells.push(null);
  const move = (by: number) =>
    setCursor((c) => {
      const t = c.y * 12 + c.m + by;
      return { y: Math.floor(t / 12), m: t % 12 };
    });
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <Button variant="ghost" aria-label="Previous month" onClick={() => move(-1)}>
          ‹
        </Button>
        <p className="font-medium">
          {first.toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" })}
        </p>
        <Button variant="ghost" aria-label="Next month" onClick={() => move(1)}>
          ›
        </Button>
      </div>
      <div className="grid grid-cols-7 gap-px overflow-hidden rounded-lg bg-slate-200 text-xs dark:bg-slate-800">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
          <div key={d} className="bg-slate-50 py-1 text-center font-medium dark:bg-slate-900">
            {d}
          </div>
        ))}
        {cells.map((iso, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: calendar cells are positions.
            key={i}
            className={cx(
              "min-h-16 min-w-0 bg-surface p-1 dark:bg-slate-900",
              iso === today && "ring-2 ring-inset ring-brand-600",
            )}
          >
            {iso && (
              <>
                <p className="text-slate-500">{Number(iso.slice(8))}</p>
                {(byDay.get(iso) ?? []).slice(0, 3).map((r, n) => {
                  const name = ni >= 0 ? String(r[ni] ?? "") : "";
                  const amount = mi >= 0 && measure ? formatCell(r[mi] ?? null, measure.type) : "";
                  return (
                    <p
                      // biome-ignore lint/suspicious/noArrayIndexKey: items in a day have no identity of their own.
                      key={n}
                      title={`${name} ${amount}`}
                      className="truncate rounded bg-slate-100 px-1 dark:bg-slate-800"
                    >
                      {name || amount}
                    </p>
                  );
                })}
                {(byDay.get(iso)?.length ?? 0) > 3 && (
                  <p className="text-slate-500">+{(byDay.get(iso)?.length ?? 0) - 3} more</p>
                )}
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export function BlockView({
  block,
  result,
  today,
}: {
  block: CardBlock;
  result: BlockResult | undefined;
  today: string;
}) {
  if (!result)
    return <div className="h-12 animate-pulse rounded-lg bg-slate-100 dark:bg-slate-800" />;
  if (result.error) return <p className="text-sm text-red-600 dark:text-red-400">{result.error}</p>;
  const o = block.options ?? {};
  const chartLabel = block.title ?? `${block.kind} chart`;
  switch (block.kind) {
    case "stat":
      return <StatBlock block={block} result={result} />;
    case "progress":
      return <ProgressBlock block={block} result={result} />;
    case "text":
      return (
        <p
          className={cx(
            "whitespace-pre-line",
            o.size === "lg" ? "text-base" : "text-sm",
            result.tone ? TONE[result.tone] : "text-slate-600 dark:text-slate-300",
          )}
        >
          {result.text}
        </p>
      );
    case "heading":
      return (
        <div className="flex items-baseline justify-between gap-3">
          <h3 className={cx("font-semibold", o.size === "lg" && "text-lg")}>{result.text}</h3>
          {o.link && INTERNAL_LINK.test(o.link.to) && (
            <Link
              to={o.link.to}
              {...(o.link.hash ? { hash: o.link.hash } : {})}
              className="shrink-0 text-sm text-brand-600 hover:underline dark:text-brand-500"
            >
              {o.link.label}
            </Link>
          )}
        </div>
      );
    case "divider":
      return <hr className="border-slate-200 dark:border-slate-800" />;
    case "list":
      return <ListBlock block={block} result={result} />;
    case "table":
      return <TableBlock block={block} result={result} />;
    case "bars":
      return <BarsBlock block={block} result={result} />;
    case "line":
    case "area":
    case "column":
      return (
        <XYChart
          queries={result.queries}
          kind={block.kind}
          options={o}
          references={result.references}
          ariaLabel={chartLabel}
        />
      );
    case "pie":
      return <PieBlock block={block} result={result} />;
    case "treemap":
      return <TreemapBlock block={block} result={result} />;
    case "heatmap":
      return <HeatmapBlock result={result} />;
    case "scatter":
      return <ScatterBlock block={block} result={result} />;
    case "waterfall":
      return <WaterfallBlock block={block} result={result} />;
    case "calendar":
      return <CalendarBlock result={result} today={today} />;
  }
}

/** A card's blocks, on its 12-column grid. Narrow cards let blocks take more of the width. */
export function CardBlocks({
  doc,
  result,
  today,
}: {
  doc: CardDoc;
  result: CardResult | undefined;
  today: string;
}) {
  const { ref, width } = useWidth(480);
  const narrow = width < 380;
  return (
    <div ref={ref} className="grid grid-cols-12 gap-x-4 gap-y-3">
      {doc.blocks.map((b) => (
        <div
          key={b.id}
          data-block={b.id}
          className="min-w-0"
          style={{ gridColumn: `span ${spanFor(b.w, narrow)}` }}
        >
          {b.title && <p className="mb-2 text-sm font-medium">{b.title}</p>}
          <BlockView block={b} result={result?.blocks[b.id]} today={result?.today ?? today} />
        </div>
      ))}
    </div>
  );
}

export const spanFor = (w: number, narrow: boolean) =>
  !narrow ? w : w <= 3 ? 6 : w <= 6 ? 12 : 12;

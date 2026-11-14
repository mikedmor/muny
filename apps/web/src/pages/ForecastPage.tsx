import { type BalanceForecast, type ForecastItem, formatMoney } from "@muny/shared";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearch } from "@tanstack/react-router";
import { AlertTriangle } from "lucide-react";
import { useState } from "react";
import { compactMoney, niceTicks, useWidth } from "../components/charts.js";
import { Alert, Card, cx, PageHeader } from "../components/ui.js";
import { api } from "../lib/api.js";

/**
 * Balance forecast (D-090): where a checking or savings account is headed,
 * day by day, from what's pending, recurring bills and income, card payments
 * and everyday spending. An estimate.
 */

export const useForecast = (accountId: string | undefined, days: number) =>
  useQuery({
    queryKey: ["forecast", accountId ?? "default", days],
    queryFn: () =>
      api.get<BalanceForecast>(
        `/api/forecast?days=${days}${accountId ? `&accountId=${encodeURIComponent(accountId)}` : ""}`,
      ),
    placeholderData: (prev) => prev,
  });

const short = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const weekday = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
const signed = (c: number) => (c < 0 ? `−${formatMoney(-c)}` : `+${formatMoney(c)}`);

const PAD = { top: 12, right: 12, bottom: 24, left: 52 };

/** The day-by-day balance, with the alert line, the low point and what happens each day. */
export function ForecastChart({
  f,
  height = 220,
  compact = false,
}: {
  f: BalanceForecast;
  height?: number;
  compact?: boolean;
}) {
  const { ref, width } = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const pts = f.points;
  if (!pts.length) return null;
  const values = pts.map((p) => p.balanceCents);
  const lo = Math.min(0, ...values, f.thresholdCents ?? 0);
  const hi = Math.max(...values, f.thresholdCents ?? 0, 1);
  const ticks = niceTicks(hi, lo);
  const top = ticks.at(-1) ?? hi;
  const bottom = ticks[0] ?? lo;
  const w = width - PAD.left - PAD.right;
  const h = height - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (i / Math.max(1, pts.length - 1)) * w;
  const y = (v: number) => PAD.top + h - ((v - bottom) / Math.max(1, top - bottom)) * h;
  const line = pts
    .map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.balanceCents).toFixed(1)}`)
    .join(" ");
  const area = `${line} L${x(pts.length - 1)},${y(bottom)} L${x(0)},${y(bottom)} Z`;
  const byDate = new Map<string, ForecastItem[]>();
  for (const it of f.items) byDate.set(it.date, [...(byDate.get(it.date) ?? []), it]);
  const lowI = pts.findIndex((p) => p.date === f.lowest.date);
  const floor = f.thresholdCents ?? 0;
  const hp = hover !== null ? pts[hover] : undefined;
  const hItems = hp ? (byDate.get(hp.date) ?? []) : [];
  const ticksX = [0, Math.round((pts.length - 1) / 2), pts.length - 1];
  return (
    <div ref={ref} className="relative">
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={`${f.account?.name ?? "Balance"} forecast: ${formatMoney(f.startCents)} today, lowest ${formatMoney(f.lowest.balanceCents)} on ${short(f.lowest.date)}, ${formatMoney(f.endCents)} in ${f.days} days`}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const i = Math.round(
            ((e.clientX - r.left - PAD.left) / Math.max(1, w)) * (pts.length - 1),
          );
          setHover(Math.max(0, Math.min(pts.length - 1, i)));
        }}
        onMouseLeave={() => setHover(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={PAD.left}
              x2={width - PAD.right}
              y1={y(t)}
              y2={y(t)}
              stroke="var(--viz-grid)"
            />
            <text
              x={PAD.left - 6}
              y={y(t) + 3}
              textAnchor="end"
              className="fill-slate-500 text-[10px]"
            >
              {compactMoney(t)}
            </text>
          </g>
        ))}
        {floor !== 0 || values.some((v) => v < 0) ? (
          <line
            x1={PAD.left}
            x2={width - PAD.right}
            y1={y(floor)}
            y2={y(floor)}
            stroke="var(--viz-negative)"
            strokeDasharray="4 3"
            strokeWidth={1.5}
          />
        ) : null}
        <path d={area} fill="var(--viz-series-1)" fillOpacity={0.12} />
        <path
          d={line}
          fill="none"
          stroke="var(--viz-series-1)"
          strokeWidth={2}
          strokeLinejoin="round"
        />
        {!compact &&
          pts.map((p, i) =>
            byDate.has(p.date) && i > 0 ? (
              <circle
                key={p.date}
                cx={x(i)}
                cy={y(p.balanceCents)}
                r={3}
                fill={
                  (byDate.get(p.date) ?? []).reduce((s, it) => s + it.amountCents, 0) >= 0
                    ? "var(--viz-positive)"
                    : "var(--viz-negative)"
                }
                stroke="var(--viz-surface)"
                strokeWidth={1.5}
              />
            ) : null,
          )}
        {lowI >= 0 && (
          <circle
            cx={x(lowI)}
            cy={y(f.lowest.balanceCents)}
            r={4.5}
            fill="none"
            stroke="var(--viz-negative)"
            strokeWidth={2}
          />
        )}
        <circle cx={x(0)} cy={y(pts[0]?.balanceCents ?? 0)} r={4} fill="var(--viz-series-1)" />
        {ticksX.map((i) => (
          <text
            key={i}
            x={x(i)}
            y={height - 6}
            textAnchor={i === 0 ? "start" : i === pts.length - 1 ? "end" : "middle"}
            className="fill-slate-500 text-[10px]"
          >
            {i === 0 ? "Today" : short(pts[i]?.date ?? "")}
          </text>
        ))}
        {hover !== null && (
          <line
            x1={x(hover)}
            x2={x(hover)}
            y1={PAD.top}
            y2={PAD.top + h}
            stroke="var(--viz-muted)"
            strokeDasharray="2 2"
          />
        )}
      </svg>
      {hp && hover !== null && (
        <div
          className="pointer-events-none absolute top-1 z-10 w-56 rounded-lg border border-slate-200 bg-surface p-2 text-xs shadow-lg dark:border-slate-700 dark:bg-slate-900"
          style={{ left: Math.min(Math.max(0, x(hover) - 112), width - 224) }}
        >
          <p className="font-semibold">{weekday(hp.date)}</p>
          <p className="tabular-nums">
            About <span className="font-medium">{formatMoney(hp.balanceCents)}</span>
          </p>
          {hItems.map((it) => (
            <p key={`${it.name}-${it.ref}`} className="flex justify-between gap-2 text-slate-500">
              <span className="truncate">{it.name}</span>
              <span
                className={cx(
                  "shrink-0 tabular-nums",
                  it.amountCents > 0 && "text-emerald-600 dark:text-emerald-400",
                )}
              >
                {signed(it.amountCents)}
                {it.estimate ? "*" : ""}
              </span>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

const KIND_LABEL: Record<ForecastItem["kind"], string> = {
  income: "Income",
  bill: "Bill",
  subscription: "Subscription",
  card: "Card payment",
  pending: "Pending",
};

export function ForecastPage() {
  const search = useSearch({ strict: false }) as { accountId?: string };
  const [accountId, setAccountId] = useState<string | undefined>(search.accountId);
  const [days, setDays] = useState(60);
  const q = useForecast(accountId, days);
  const f = q.data;
  // Running balance alongside each scheduled item.
  const running = new Map<string, number>(f?.points.map((p) => [p.date, p.balanceCents]) ?? []);
  const byDate = new Map<string, ForecastItem[]>();
  for (const it of f?.items ?? []) byDate.set(it.date, [...(byDate.get(it.date) ?? []), it]);
  const short0 = f?.firstBelow;
  return (
    <>
      <PageHeader
        title="Forecast"
        actions={
          f && f.accounts.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              <select
                aria-label="Account"
                value={f.account?.id ?? ""}
                onChange={(e) => setAccountId(e.target.value)}
                className="rounded-lg border border-slate-300 bg-surface px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
              >
                {f.accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
              <div
                className="flex rounded-lg border border-slate-300 p-0.5 text-sm dark:border-slate-700"
                role="tablist"
                aria-label="How far ahead"
              >
                {[30, 60, 90].map((d) => (
                  <button
                    key={d}
                    type="button"
                    role="tab"
                    aria-selected={days === d}
                    onClick={() => setDays(d)}
                    className={cx(
                      "rounded-md px-3 py-1.5",
                      days === d ? "bg-brand-600 text-on-brand" : "text-slate-500",
                    )}
                  >
                    {d} days
                  </button>
                ))}
              </div>
            </div>
          ) : null
        }
      />
      {q.error && <Alert>{q.error.message}</Alert>}
      {f && !f.account && (
        <Card className="text-sm text-slate-500">
          Add a checking or savings account to see where its balance is headed.
        </Card>
      )}
      {f?.account && (
        <div className="space-y-6">
          {short0 && (
            <div className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
              <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <span>
                {f.account.name} is expected to drop below{" "}
                {f.thresholdCents !== null ? `your ${formatMoney(f.thresholdCents)} alert` : "zero"}{" "}
                on <strong>{weekday(short0.date)}</strong> (about {formatMoney(short0.balanceCents)}
                ).{" "}
                {f.thresholdCents === null && (
                  <>
                    Set a low-balance amount on the{" "}
                    <Link to="/accounts" className="underline">
                      Accounts
                    </Link>{" "}
                    page to be warned ahead of time.
                  </>
                )}
              </span>
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card>
              <p className="text-sm text-slate-500">Today</p>
              <p className="text-2xl font-semibold tabular-nums">{formatMoney(f.startCents)}</p>
              <p className="text-xs text-slate-500">
                {f.pendingCents ? `With ${signed(f.pendingCents)} pending` : "Nothing pending"}
              </p>
            </Card>
            <Card>
              <p className="text-sm text-slate-500">Lowest</p>
              <p
                className={cx(
                  "text-2xl font-semibold tabular-nums",
                  f.lowest.balanceCents < (f.thresholdCents ?? 0) &&
                    "text-red-600 dark:text-red-400",
                )}
              >
                {formatMoney(f.lowest.balanceCents)}
              </p>
              <p className="text-xs text-slate-500">
                {f.lowest.date === f.today ? "Today" : weekday(f.lowest.date)}
              </p>
            </Card>
            <Card>
              <p className="text-sm text-slate-500">In {f.days} days</p>
              <p className="text-2xl font-semibold tabular-nums">{formatMoney(f.endCents)}</p>
              <p
                className={cx(
                  "text-xs",
                  f.endCents >= f.startCents
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-red-600 dark:text-red-400",
                )}
              >
                {signed(f.endCents - f.startCents)} from today
              </p>
            </Card>
            <Card>
              <p className="text-sm text-slate-500">Everyday spending</p>
              <p className="text-2xl font-semibold tabular-nums">
                {formatMoney(f.dailySpendCents)}
              </p>
              <p className="text-xs text-slate-500">a day, from the last 90 days</p>
            </Card>
          </div>
          <Card>
            <ForecastChart f={f} />
            <p className="mt-2 text-xs text-slate-500">
              Today&apos;s balance and what&apos;s pending, then recurring bills and income on this
              account, credit card payments made from it, and your usual everyday spending (without
              bills, card payments and one-off big charges). A dot marks a day with something
              scheduled; the circle is the low point
              {f.thresholdCents !== null
                ? `, and the dashed line is your ${formatMoney(f.thresholdCents)} alert`
                : ""}
              . An estimate: anything new won&apos;t be in it.
            </p>
          </Card>
          <Card className="p-0">
            <h2 className="border-b border-slate-200 px-4 py-3 font-semibold dark:border-slate-800">
              What&apos;s scheduled
            </h2>
            {f.items.length === 0 ? (
              <p className="px-4 py-6 text-sm text-slate-500">
                Nothing recurring on this account in the next {f.days} days. Bills and income show
                up here once Muny finds them on the{" "}
                <Link to="/recurring" className="text-brand-600 hover:underline">
                  Recurring
                </Link>{" "}
                page.
              </p>
            ) : (
              <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
                {[...byDate].map(([date, list]) => (
                  <li key={date} className="px-4 py-2.5">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-xs font-medium text-slate-500">
                        {date === f.today ? "Today" : weekday(date)}
                      </span>
                      <span className="text-xs text-slate-500 tabular-nums">
                        about {formatMoney(running.get(date) ?? 0)} after
                      </span>
                    </div>
                    {list.map((it) => (
                      <div
                        key={`${it.name}-${it.ref}`}
                        className="mt-1 flex items-center justify-between gap-3"
                      >
                        <span className="min-w-0 truncate">
                          {it.name}
                          <span className="ml-2 text-xs text-slate-500">
                            {KIND_LABEL[it.kind]}
                            {it.estimate && " · estimated"}
                          </span>
                        </span>
                        <span
                          className={cx(
                            "shrink-0 font-medium tabular-nums",
                            it.amountCents > 0 && "text-emerald-600 dark:text-emerald-400",
                          )}
                        >
                          {signed(it.amountCents)}
                        </span>
                      </div>
                    ))}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
    </>
  );
}

/** The Overview card: the next 30 days of the main account, small. */
export function ForecastOverviewCard() {
  const q = useForecast(undefined, 30);
  const f = q.data;
  if (!f?.account) return null;
  const below = f.firstBelow;
  return (
    <Card>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <h2 className="font-semibold">Balance forecast</h2>
        <Link to="/forecast" className="text-sm text-brand-600 hover:underline dark:text-brand-500">
          Details
        </Link>
      </div>
      <p className="mb-2 text-sm text-slate-500">
        {f.account.name}: {formatMoney(f.startCents)} today, lowest{" "}
        <span
          className={cx(
            "font-medium",
            f.lowest.balanceCents < (f.thresholdCents ?? 0) && "text-red-600 dark:text-red-400",
          )}
        >
          {formatMoney(f.lowest.balanceCents)}
        </span>{" "}
        {f.lowest.date === f.today ? "today" : `on ${short(f.lowest.date)}`}
        {below &&
          below.date !== f.lowest.date &&
          `, below ${f.thresholdCents !== null ? formatMoney(f.thresholdCents) : "zero"} from ${short(below.date)}`}
        .
      </p>
      <ForecastChart f={f} height={150} compact />
    </Card>
  );
}

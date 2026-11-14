import { formatMoney, type YearReview } from "@muny/shared";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { ColumnChart, LineChart, RankedBars } from "../components/charts.js";
import { Alert, Card, cx, PageHeader } from "../components/ui.js";
import { api } from "../lib/api.js";

/**
 * Year in review (D-092): a year of your own money, as a story. This year so
 * far, or any past year Muny has data for.
 */

export const useYearReview = (year: number) =>
  useQuery({
    queryKey: ["review", year],
    queryFn: () => api.get<YearReview>(`/api/review/${year}`),
    placeholderData: (prev) => prev,
  });

const monthName = (m: string, style: "long" | "short" = "long") =>
  new Date(`${m}-01T00:00:00`).toLocaleDateString(undefined, { month: style });
const dayName = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: "long", day: "numeric" });
const WEEKDAYS = [
  "Sundays",
  "Mondays",
  "Tuesdays",
  "Wednesdays",
  "Thursdays",
  "Fridays",
  "Saturdays",
];

/** "up $120 (8%)" against last year, worded for spending or earning. */
function Change({
  now,
  then,
  good,
}: {
  now: number;
  then: number | null | undefined;
  good: "up" | "down";
}) {
  if (then === null || then === undefined || then === 0) return null;
  const d = now - then;
  if (d === 0) return <span className="text-slate-500">the same as last year</span>;
  const pct = Math.round((Math.abs(d) / Math.abs(then)) * 100);
  const isGood = d > 0 === (good === "up");
  return (
    <span
      className={
        isGood ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"
      }
    >
      {d > 0 ? "up" : "down"} {formatMoney(Math.abs(d))} ({pct}%) on last year
    </span>
  );
}

function Big({
  label,
  value,
  children,
  tone,
}: {
  label: string;
  value: string;
  children?: React.ReactNode;
  tone?: string;
}) {
  return (
    <Card>
      <p className="text-sm text-slate-500">{label}</p>
      <p className={cx("mt-1 text-3xl font-semibold tabular-nums", tone)}>{value}</p>
      {children && <p className="mt-1 text-xs">{children}</p>}
    </Card>
  );
}

function Section({
  title,
  children,
  sub,
}: {
  title: string;
  sub?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold">{title}</h2>
        {sub && <p className="text-sm text-slate-500">{sub}</p>}
      </div>
      {children}
    </section>
  );
}

export function ReviewPage() {
  const search = useSearch({ strict: false }) as { year?: number };
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(search.year ?? thisYear);
  const q = useYearReview(year);
  const r = q.data;
  const firstYear = r?.dataFrom ? Number(r.dataFrom.slice(0, 4)) : thisYear;
  const years = Array.from(
    { length: Math.max(1, thisYear - firstYear + 1) },
    (_, i) => thisYear - i,
  );
  const nwChange =
    r && r.netWorth.startCents !== null && r.netWorth.endCents !== null
      ? r.netWorth.endCents - r.netWorth.startCents
      : null;
  const debtDown =
    r && r.netWorth.debtStartCents !== null && r.netWorth.debtEndCents !== null
      ? r.netWorth.debtStartCents - r.netWorth.debtEndCents
      : null;
  const hasData = !!r && (r.spentCents > 0 || r.earnedCents > 0);
  return (
    <>
      <PageHeader
        title={`Your ${year}`}
        actions={
          <select
            aria-label="Year"
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            className="rounded-lg border border-slate-300 bg-surface px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
          >
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        }
      />
      {q.error && <Alert>{q.error.message}</Alert>}
      {r && (
        <p className="-mt-2 mb-6 text-sm text-slate-500">
          {r.partial ? `January to ${dayName(r.to)}, so far.` : "The whole year."}
          {r.dataFrom &&
            r.dataFrom > r.from &&
            ` Muny's history starts ${dayName(r.dataFrom)}, ${r.dataFrom.slice(0, 4)}.`}
          {r.lastYear && r.partial && " Compared with the same months last year."}
        </p>
      )}
      {r && !hasData && (
        <Card className="text-sm text-slate-500">Muny has nothing for {year} yet.</Card>
      )}
      {r && hasData && (
        <div className="space-y-10">
          <div className="grid gap-4 md:grid-cols-3">
            <Big label="You earned" value={formatMoney(r.earnedCents)}>
              <Change now={r.earnedCents} then={r.lastYear?.earnedCents} good="up" />
            </Big>
            <Big label="You spent" value={formatMoney(r.spentCents)}>
              <Change now={r.spentCents} then={r.lastYear?.spentCents} good="down" />
            </Big>
            <Big
              label="You kept"
              value={`${r.keptCents < 0 ? "−" : ""}${formatMoney(Math.abs(r.keptCents))}`}
              tone={
                r.keptCents >= 0
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-red-600 dark:text-red-400"
              }
            >
              {r.savingsRatePct !== null && (
                <span className="text-slate-500">
                  {r.keptCents >= 0
                    ? `${r.savingsRatePct}% of what came in`
                    : "more went out than came in"}
                </span>
              )}
            </Big>
          </div>

          <Section
            title="Month by month"
            sub={
              r.lightestMonth && r.heaviestMonth ? (
                <>
                  {monthName(r.heaviestMonth.month)} cost the most (
                  {formatMoney(r.heaviestMonth.cents)}), {monthName(r.lightestMonth.month)} the
                  least ({formatMoney(r.lightestMonth.cents)}).
                </>
              ) : undefined
            }
          >
            <Card>
              <ColumnChart
                ariaLabel={`Earned and spent each month of ${year}`}
                seriesNames={["Earned", "Spent"]}
                data={r.months.map((m) => ({
                  key: m.month,
                  label: monthName(m.month, "short"),
                  title: monthName(m.month),
                  values: [m.earnedCents, m.spentCents],
                }))}
              />
            </Card>
          </Section>

          {r.netWorth.points.length > 1 && (
            <Section
              title="Net worth"
              sub={
                nwChange !== null ? (
                  <>
                    From {formatMoney(r.netWorth.startCents ?? 0)} to{" "}
                    {formatMoney(r.netWorth.endCents ?? 0)}:{" "}
                    <span
                      className={
                        nwChange >= 0
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-red-600 dark:text-red-400"
                      }
                    >
                      {nwChange >= 0 ? "up" : "down"} {formatMoney(Math.abs(nwChange))}
                    </span>
                    {debtDown !== null &&
                      debtDown > 0 &&
                      `, with ${formatMoney(debtDown)} less debt`}
                    {debtDown !== null &&
                      debtDown < 0 &&
                      `, with ${formatMoney(-debtDown)} more debt`}
                    .
                  </>
                ) : undefined
              }
            >
              <Card>
                <LineChart
                  ariaLabel={`Net worth through ${year}`}
                  height={180}
                  points={r.netWorth.points.map((p) => ({
                    date: p.date,
                    label: new Date(`${p.date}T00:00:00`).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                    }),
                    value: p.cents,
                  }))}
                />
              </Card>
            </Section>
          )}

          <div className="grid gap-6 lg:grid-cols-2">
            <Section title="Where it went">
              <Card>
                <RankedBars
                  total={r.spentCents}
                  limit={10}
                  items={r.categories.map((c) => ({
                    key: c.id ?? c.name,
                    label: c.name,
                    sublabel:
                      c.lastYearCents === null || c.lastYearCents === undefined
                        ? undefined
                        : c.lastYearCents === 0
                          ? "new this year"
                          : `${c.cents >= c.lastYearCents ? "+" : "−"}${formatMoney(Math.abs(c.cents - c.lastYearCents))} on last year`,
                    cents: c.cents,
                  }))}
                />
              </Card>
            </Section>
            <Section
              title="Your regulars"
              sub={
                r.regular ? (
                  <>
                    You went to {r.regular.name} {r.regular.count} times,{" "}
                    {formatMoney(r.regular.cents)} in all.
                  </>
                ) : undefined
              }
            >
              <Card className="p-0">
                <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
                  {r.merchants.map((m) => (
                    <li
                      key={m.name}
                      className="flex items-center justify-between gap-3 px-4 py-2.5"
                    >
                      <span className="min-w-0 truncate">
                        {m.name}
                        <span className="ml-2 text-xs text-slate-500">{m.count}×</span>
                      </span>
                      <span className="shrink-0 font-medium tabular-nums">
                        {formatMoney(m.cents)}
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>
            </Section>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Section title="The big ones">
              <Card className="p-0">
                <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
                  {r.biggest.map((b) => (
                    <li
                      key={`${b.date}-${b.name}-${b.cents}`}
                      className="flex items-center justify-between gap-3 px-4 py-2.5"
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{b.name}</span>
                        <span className="block text-xs text-slate-500">
                          {dayName(b.date)}
                          {b.category && ` · ${b.category}`}
                        </span>
                      </span>
                      <span className="shrink-0 font-medium tabular-nums">
                        {formatMoney(b.cents)}
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>
            </Section>
            <Section
              title="Bills and subscriptions"
              sub={<>{formatMoney(r.recurring.paidCents)} went to bills and subscriptions.</>}
            >
              <Card className="space-y-3 text-sm">
                {r.recurring.started.length > 0 && (
                  <div>
                    <p className="font-medium">New this year</p>
                    <ul className="mt-1 space-y-0.5 text-slate-600 dark:text-slate-300">
                      {r.recurring.started.map((s) => (
                        <li key={s.name} className="flex justify-between gap-3">
                          <span className="truncate">{s.name}</span>
                          <span className="shrink-0 tabular-nums">
                            {formatMoney(s.monthlyCents)}/mo
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {r.recurring.cancelled.length > 0 && (
                  <div>
                    <p className="font-medium">Cancelled</p>
                    <ul className="mt-1 space-y-0.5 text-slate-600 dark:text-slate-300">
                      {r.recurring.cancelled.map((s) => (
                        <li key={s.name} className="flex justify-between gap-3">
                          <span className="truncate">{s.name}</span>
                          <span className="shrink-0 tabular-nums text-emerald-600 dark:text-emerald-400">
                            {formatMoney(s.monthlyCents)}/mo saved
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {r.recurring.priceIncreases.length > 0 && (
                  <div>
                    <p className="font-medium">Went up</p>
                    <ul className="mt-1 space-y-0.5 text-slate-600 dark:text-slate-300">
                      {r.recurring.priceIncreases.map((p) => (
                        <li key={p.name} className="flex justify-between gap-3">
                          <span className="truncate">
                            {p.name}{" "}
                            <span className="text-xs text-slate-500">
                              in {monthName(p.date.slice(0, 7))}
                            </span>
                          </span>
                          <span className="shrink-0 tabular-nums">
                            {formatMoney(p.fromCents)} →{" "}
                            <span className="text-red-600 dark:text-red-400">
                              {formatMoney(p.toCents)}
                            </span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {!r.recurring.started.length &&
                  !r.recurring.cancelled.length &&
                  !r.recurring.priceIncreases.length && (
                    <p className="text-slate-500">
                      No new, cancelled or pricier subscriptions this year.
                    </p>
                  )}
                <Link
                  to="/recurring"
                  className="inline-block text-brand-600 hover:underline dark:text-brand-500"
                >
                  All recurring
                </Link>
              </Card>
            </Section>
          </div>

          <Section title="A few facts">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Big label="Transactions" value={r.facts.transactions.toLocaleString()} />
              <Big label="Days without spending" value={String(r.facts.noSpendDays)}>
                <span className="text-slate-500">
                  {r.facts.longestNoSpendStreak > 1
                    ? `The longest run: ${r.facts.longestNoSpendStreak} days in a row`
                    : "No two in a row"}
                </span>
              </Big>
              <Big
                label="You spend most on"
                value={
                  r.facts.busiestWeekday !== null ? (WEEKDAYS[r.facts.busiestWeekday] ?? "") : "—"
                }
              />
              <Big
                label="Your biggest day"
                value={r.facts.biggestDay ? formatMoney(r.facts.biggestDay.cents) : "—"}
              >
                {r.facts.biggestDay && (
                  <span className="text-slate-500">{dayName(r.facts.biggestDay.date)}</span>
                )}
              </Big>
            </div>
          </Section>

          {r.investing &&
          (r.investing.dividendsCents ||
            r.investing.stockGainsCents ||
            r.investing.cryptoGainsCents) ? (
            <Section
              title="Investing"
              sub="From taxable accounts and your crypto, as on the Taxes page."
            >
              <div className="grid gap-4 sm:grid-cols-3">
                <Big label="Dividends" value={formatMoney(r.investing.dividendsCents)} />
                <Big
                  label="Stock gains you took"
                  value={`${r.investing.stockGainsCents < 0 ? "−" : ""}${formatMoney(Math.abs(r.investing.stockGainsCents))}`}
                />
                <Big
                  label="Crypto gains you took"
                  value={`${r.investing.cryptoGainsCents < 0 ? "−" : ""}${formatMoney(Math.abs(r.investing.cryptoGainsCents))}`}
                />
              </div>
            </Section>
          ) : null}
        </div>
      )}
    </>
  );
}

/** Late in the year and early in the next: a nudge on the Overview to look back. */
export function ReviewBanner({ today, onDismiss }: { today: string; onDismiss: () => void }) {
  const month = Number(today.slice(5, 7));
  const year = month === 12 ? Number(today.slice(0, 4)) : Number(today.slice(0, 4)) - 1;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-brand-500/40 bg-brand-50 px-4 py-3 text-sm dark:bg-brand-700/15">
      <span>
        ✨ Your {year} in review is ready: what you earned, spent and kept, your regulars and a few
        facts.
      </span>
      <span className="flex items-center gap-3">
        <Link
          to="/review"
          search={{ year }}
          className="font-medium text-brand-700 hover:underline dark:text-brand-500"
        >
          Take a look
        </Link>
        <button
          type="button"
          onClick={onDismiss}
          className="text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
        >
          Not now
        </button>
      </span>
    </div>
  );
}

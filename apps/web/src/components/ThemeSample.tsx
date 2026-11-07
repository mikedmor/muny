import { CHART_COLOR_KEYS, formatMoney, THEME_COLOR_LABELS, type Theme } from "@muny/shared";
import { ThemeScope } from "../lib/theme.js";
import { ColumnChart, RankedBars } from "./charts.js";
import { Alert, Button, Card, cx, Field } from "./ui.js";

/**
 * Real components with made-up numbers, for seeing a theme before using it.
 * Everything here comes from the same components the app uses, so what you see
 * is what you get.
 */
export function ThemeSample({ theme }: { theme: Theme }) {
  return (
    <ThemeScope
      theme={theme}
      className="overflow-hidden rounded-xl border border-slate-200 bg-slate-50 text-slate-900 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100"
    >
      <div className="flex min-h-[32rem]">
        <div className="hidden w-40 shrink-0 flex-col gap-1 border-r border-slate-200 bg-surface p-3 text-sm sm:flex dark:border-slate-800 dark:bg-slate-900">
          <p className="mb-2 px-2 font-semibold">Muny</p>
          <span className="rounded-lg bg-brand-50 px-2 py-1.5 font-medium text-brand-700 dark:bg-brand-700/20 dark:text-brand-500">
            Overview
          </span>
          {["Transactions", "Budgets", "Reports"].map((n) => (
            <span key={n} className="rounded-lg px-2 py-1.5 text-slate-600 dark:text-slate-400">
              {n}
            </span>
          ))}
        </div>
        <div className="min-w-0 flex-1 space-y-4 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xl font-semibold">Overview</p>
            <div className="flex gap-2">
              <Button variant="secondary">Customize</Button>
              <Button>Add money</Button>
            </div>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <p className="text-sm font-medium text-slate-500">Spent this month</p>
              <p className="mt-1 text-3xl font-semibold tracking-tight tabular-nums">
                {formatMoney(248_316)}
              </p>
              <p className="mt-1 text-sm text-emerald-700 dark:text-emerald-400">
                ▼ {formatMoney(31_200)} less than last month
              </p>
              <div className="mt-3">
                <ColumnChart
                  ariaLabel="Sample chart"
                  seriesNames={["Income", "Spending"]}
                  data={SAMPLE_MONTHS}
                />
              </div>
            </Card>
            <Card>
              <p className="mb-2 font-semibold">Where it went</p>
              <RankedBars total={100_000} items={SAMPLE_BARS} />
            </Card>
          </div>
          <Card>
            <p className="mb-2 font-semibold">Chart colors</p>
            <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {CHART_COLOR_KEYS.map((key, i) => (
                <li key={key} className="flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className="size-3 rounded-sm"
                    style={{ background: `var(--viz-series-${i + 1})` }}
                  />
                  {THEME_COLOR_LABELS[key].label}
                </li>
              ))}
            </ul>
          </Card>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="space-y-3">
              <Field label="A form field" defaultValue="Text you typed" hint="Quiet help text." />
              <p className="text-sm">
                A <span className="text-brand-600 underline dark:text-brand-500">link</span> in a
                sentence.
              </p>
            </Card>
            <div className="space-y-3">
              <Alert>Something went wrong.</Alert>
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                3 transactions need a category.
              </div>
              <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-surface text-sm dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
                {SAMPLE_ROWS.map((r) => (
                  <li key={r.name} className="flex justify-between gap-3 px-3 py-2">
                    <span>{r.name}</span>
                    <span
                      className={cx(
                        "tabular-nums",
                        r.cents > 0 && "text-emerald-700 dark:text-emerald-400",
                        r.cents < 0 && "text-red-600 dark:text-red-400",
                      )}
                    >
                      {formatMoney(r.cents)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>
    </ThemeScope>
  );
}

/** A tiny picture of a theme for the gallery. Drawn, so it costs almost nothing. */
export function ThemeThumbnail({ theme }: { theme: Theme }) {
  const c = theme.colors;
  return (
    <div
      aria-hidden="true"
      className="flex h-24 overflow-hidden"
      style={{ background: c.background }}
    >
      <div
        className="w-1/4 space-y-1 p-1.5"
        style={{ background: c.surface, borderRight: `1px solid ${c.border}` }}
      >
        <div className="h-1.5 rounded" style={{ background: c.primary }} />
        <div className="h-1.5 rounded" style={{ background: c.border }} />
        <div className="h-1.5 rounded" style={{ background: c.border }} />
      </div>
      <div className="flex-1 p-2">
        <div
          className="flex h-full flex-col justify-between rounded p-1.5"
          style={{ background: c.surface, border: `1px solid ${c.border}` }}
        >
          <div className="h-1.5 w-1/2 rounded" style={{ background: c.text }} />
          <div className="flex h-8 items-end gap-1">
            {[c.chart1, c.chart2, c.chart3, c.chart4, c.chart5].map((color, i) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: a fixed little picture.
                key={i}
                className="flex-1 rounded-t-sm"
                style={{ background: color, height: `${[80, 45, 100, 60, 30][i]}%` }}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

const SAMPLE_MONTHS = ["Jun", "Jul", "Aug", "Sep", "Oct", "Nov"].map((label, i) => ({
  key: label,
  label,
  title: label,
  values: [420_000 + i * 8000, 310_000 + ((i * 37_000) % 90_000)],
}));

const SAMPLE_BARS = [
  { key: "a", label: "Groceries", cents: 42_000 },
  { key: "b", label: "Dining out", cents: 26_000 },
  { key: "c", label: "Transport", cents: 18_000 },
  { key: "d", label: "Fun", cents: 14_000 },
];

const SAMPLE_ROWS = [
  { name: "Paycheck", cents: 310_000 },
  { name: "Corner Market", cents: -4_218 },
  { name: "Balance", cents: 0 },
];

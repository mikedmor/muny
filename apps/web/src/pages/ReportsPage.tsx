import {
  ACCOUNT_TYPE_LABELS,
  type AccountType,
  formatMoney,
  type MonthlyReport,
  type NetWorthReport,
  type SpendingGroupBy,
  type SpendingReport,
} from "@muny/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { ColumnChart, LineChart, RankedBars, TableToggle } from "../components/charts.js";
import { Alert, Button, Card, cx, PageHeader } from "../components/ui.js";
import { api } from "../lib/api.js";

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const monthShort = (m: string) =>
  new Date(`${m.slice(0, 7)}-15T00:00:00`).toLocaleDateString(undefined, { month: "short" });
const monthLong = (m: string) =>
  new Date(`${m.slice(0, 7)}-15T00:00:00`).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
const monthYear = (m: string) =>
  new Date(`${m.slice(0, 7)}-15T00:00:00`).toLocaleDateString(undefined, {
    month: "short",
    year: "2-digit",
  });

const PRESETS = {
  thisMonth: "This month",
  lastMonth: "Last month",
  last3: "Last 3 months",
  last6: "Last 6 months",
  last12: "Last 12 months",
  ytd: "Year to date",
  lastYear: "Last year",
  custom: "Custom…",
} as const;
type Preset = keyof typeof PRESETS;

function presetRange(p: Preset): { from: string; to: string } {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const today = iso(now);
  switch (p) {
    case "thisMonth":
      return { from: iso(new Date(y, m, 1)), to: today };
    case "lastMonth":
      return { from: iso(new Date(y, m - 1, 1)), to: iso(new Date(y, m, 0)) };
    case "last3":
      return { from: iso(new Date(y, m - 2, 1)), to: today };
    case "last6":
      return { from: iso(new Date(y, m - 5, 1)), to: today };
    case "last12":
      return { from: iso(new Date(y, m - 11, 1)), to: today };
    case "ytd":
      return { from: `${y}-01-01`, to: today };
    case "lastYear":
      return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` };
    default:
      return { from: iso(new Date(y, m, 1)), to: today };
  }
}

const TABS = [
  ["spending", "Spending"],
  ["trends", "Trends"],
  ["cash-flow", "Cash flow"],
  ["net-worth", "Net worth"],
] as const;
type Tab = (typeof TABS)[number][0];

const selectClass =
  "rounded-lg border border-slate-300 bg-surface px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950";
const th = "px-2 py-1.5 text-left font-medium text-slate-500";
const td = "whitespace-nowrap px-2 py-1.5 tabular-nums";

// ---------------------------------------------------------------------------

function SpendingTab() {
  const [preset, setPreset] = useState<Preset>("thisMonth");
  const [custom, setCustom] = useState(presetRange("thisMonth"));
  const [by, setBy] = useState<SpendingGroupBy>("category");
  const [drill, setDrill] = useState<{ id: string; name: string } | null>(null);
  const range = preset === "custom" ? custom : presetRange(preset);
  const params = new URLSearchParams({
    from: range.from,
    to: range.to,
    by: drill ? "merchant" : by,
  });
  if (drill) params.set("categoryId", drill.id);
  const q = useQuery({
    queryKey: ["reports", "spending", params.toString()],
    queryFn: () => api.get<SpendingReport>(`/api/reports/spending?${params}`),
    placeholderData: keepPreviousData,
    enabled: range.from <= range.to,
  });
  const r = q.data;

  return (
    <Card>
      <div className="mb-4 flex flex-wrap items-end gap-2">
        <select
          aria-label="Period"
          value={preset}
          onChange={(e) => setPreset(e.target.value as Preset)}
          className={selectClass}
        >
          {Object.entries(PRESETS).map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
        {preset === "custom" && (
          <>
            <input
              type="date"
              aria-label="From"
              value={custom.from}
              onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))}
              className={selectClass}
            />
            <input
              type="date"
              aria-label="To"
              value={custom.to}
              onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))}
              className={selectClass}
            />
          </>
        )}
        {!drill && (
          <select
            aria-label="Group by"
            value={by}
            onChange={(e) => setBy(e.target.value as SpendingGroupBy)}
            className={selectClass}
          >
            <option value="category">By category</option>
            <option value="group">By category group</option>
            <option value="merchant">By merchant</option>
          </select>
        )}
        {drill && (
          <Button variant="ghost" onClick={() => setDrill(null)}>
            ← All categories
          </Button>
        )}
      </div>
      {q.isError && <Alert>{q.error.message}</Alert>}
      {r && (
        <>
          <p className="mb-3 text-sm text-slate-500">
            {drill ? (
              <span className="font-medium text-slate-800 dark:text-slate-200">{drill.name}: </span>
            ) : null}
            <span className="text-lg font-semibold text-slate-900 dark:text-slate-100">
              {formatMoney(r.totalCents)}
            </span>{" "}
            spent
            {drill ? " by merchant" : ""}
          </p>
          <RankedBars
            total={r.totalCents}
            items={r.items.map((i) => ({
              key: i.id ?? "uncategorized",
              label: i.name,
              sublabel: by === "merchant" || drill ? `${i.count}×` : undefined,
              cents: i.cents,
            }))}
            onSelect={
              !drill && by === "category"
                ? (i) => setDrill({ id: i.key, name: i.label })
                : undefined
            }
          />
          {!drill && by === "category" && r.items.length > 0 && (
            <p className="mt-3 text-xs text-slate-500">Click a category to see its merchants.</p>
          )}
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------

function useMonthly(months: number) {
  return useQuery({
    queryKey: ["reports", "monthly", months],
    queryFn: () => api.get<MonthlyReport>("/api/reports/monthly"),
    placeholderData: keepPreviousData,
  });
}

function TrendsTab() {
  const q = useMonthly(12);
  const months = q.data?.months ?? [];
  const [selected, setSelected] = useState<string | null>(null);
  const sel = selected ?? months[months.length - 1]?.month ?? null;
  useEffect(() => {
    if (!selected && months.length) setSelected(months[months.length - 1]?.month ?? null);
  }, [months, selected]);
  const idx = months.findIndex((m) => m.month === sel);
  const cur = months[idx];
  const prev = months[idx - 1];
  const prev3 = months.slice(Math.max(0, idx - 3), idx);

  const rows = useMemo(() => {
    if (!cur || !q.data) return [];
    const names = new Map(q.data.categories.map((c) => [c.id, c.name]));
    const ids = new Set([...Object.keys(cur.byCategory), ...Object.keys(prev?.byCategory ?? {})]);
    return [...ids]
      .map((id) => {
        const now = cur.byCategory[id] ?? 0;
        const before = prev?.byCategory[id] ?? 0;
        const avg = prev3.length
          ? prev3.reduce((s, m) => s + (m.byCategory[id] ?? 0), 0) / prev3.length
          : 0;
        return {
          id,
          name: id ? (names.get(id) ?? "?") : "Uncategorized",
          now,
          before,
          avg: Math.round(avg),
          change: now - before,
        };
      })
      .filter((r) => r.now > 0 || r.before > 0)
      .sort((a, b) => b.now - a.now);
  }, [cur, prev, prev3, q.data]);

  return (
    <div className="space-y-6">
      <Card>
        <h2 className="mb-1 font-semibold">Spending per month</h2>
        <p className="mb-3 text-xs text-slate-500">
          Click a month to compare it with the month before.
        </p>
        <ColumnChart
          ariaLabel="Spending per month for the last 12 months"
          seriesNames={["Spending"]}
          selectedKey={sel ?? undefined}
          onSelect={setSelected}
          data={months.map((m) => ({
            key: m.month,
            label: monthShort(m.month),
            title: monthLong(m.month),
            values: [m.spendingCents],
          }))}
        />
      </Card>
      {cur && (
        <Card className="overflow-x-auto">
          <h2 className="mb-3 font-semibold">
            {monthLong(cur.month)}: {formatMoney(cur.spendingCents)}
            {prev && (
              <span className="ml-2 text-sm font-normal text-slate-500">
                {cur.spendingCents >= prev.spendingCents ? "▲" : "▼"}{" "}
                {formatMoney(Math.abs(cur.spendingCents - prev.spendingCents))}{" "}
                {cur.spendingCents >= prev.spendingCents ? "more" : "less"} than{" "}
                {monthShort(prev.month)}
              </span>
            )}
          </h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800">
                <th className={th}>Category</th>
                <th className={cx(th, "text-right")}>{monthShort(cur.month)}</th>
                <th className={cx(th, "text-right")}>
                  {prev ? monthShort(prev.month) : "Previous"}
                </th>
                <th className={cx(th, "text-right")}>Change</th>
                <th className={cx(th, "hidden text-right sm:table-cell")}>3-mo avg</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-slate-100 dark:border-slate-800/60">
                  <td className="px-2 py-1.5">{r.name}</td>
                  <td className={cx(td, "text-right")}>{formatMoney(r.now)}</td>
                  <td className={cx(td, "text-right text-slate-500")}>{formatMoney(r.before)}</td>
                  <td
                    className={cx(
                      td,
                      "text-right",
                      r.change > 0
                        ? "text-red-600"
                        : r.change < 0
                          ? "text-emerald-700 dark:text-emerald-400"
                          : "",
                    )}
                  >
                    {r.change === 0
                      ? "–"
                      : `${r.change > 0 ? "+" : "−"}${formatMoney(Math.abs(r.change))}`}
                  </td>
                  <td className={cx(td, "hidden text-right text-slate-500 sm:table-cell")}>
                    {formatMoney(r.avg)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function CashFlowTab() {
  const q = useMonthly(12);
  const months = q.data?.months ?? [];
  const income = months.reduce((s, m) => s + m.incomeCents, 0);
  const spending = months.reduce((s, m) => s + m.spendingCents, 0);
  const rate = income > 0 ? ((income - spending) / income) * 100 : null;
  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Income, 12 months
          </p>
          <p className="mt-1 text-xl font-semibold">{formatMoney(income)}</p>
        </Card>
        <Card>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Spending, 12 months
          </p>
          <p className="mt-1 text-xl font-semibold">{formatMoney(spending)}</p>
        </Card>
        <Card>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Saved</p>
          <p className="mt-1 text-xl font-semibold">{formatMoney(income - spending)}</p>
          {rate !== null && <p className="text-xs text-slate-500">{rate.toFixed(0)}% of income</p>}
        </Card>
      </div>
      <Card>
        <h2 className="mb-3 font-semibold">Income vs spending</h2>
        <ColumnChart
          ariaLabel="Income and spending per month for the last 12 months"
          seriesNames={["Income", "Spending"]}
          data={months.map((m) => ({
            key: m.month,
            label: monthShort(m.month),
            title: monthLong(m.month),
            values: [m.incomeCents, m.spendingCents],
          }))}
        />
        <TableToggle>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800">
                <th className={th}>Month</th>
                <th className={cx(th, "text-right")}>Income</th>
                <th className={cx(th, "text-right")}>Spending</th>
                <th className={cx(th, "text-right")}>Net</th>
              </tr>
            </thead>
            <tbody>
              {[...months].reverse().map((m) => (
                <tr key={m.month} className="border-b border-slate-100 dark:border-slate-800/60">
                  <td className="px-2 py-1.5">{monthLong(m.month)}</td>
                  <td className={cx(td, "text-right")}>{formatMoney(m.incomeCents)}</td>
                  <td className={cx(td, "text-right")}>{formatMoney(m.spendingCents)}</td>
                  <td className={cx(td, "text-right")}>
                    {formatMoney(m.incomeCents - m.spendingCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableToggle>
        <p className="mt-2 text-xs text-slate-500">
          Transfers between your own accounts aren't counted as income or spending.
        </p>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------

function NetWorthTab() {
  const [months, setMonths] = useState(24);
  const q = useQuery({
    queryKey: ["reports", "net-worth", months],
    queryFn: () => api.get<NetWorthReport>(`/api/reports/net-worth?months=${months}`),
    placeholderData: keepPreviousData,
  });
  const r = q.data;
  const last = r?.points[r.points.length - 1];
  const first = r?.points[0];
  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Net worth</p>
          <p className="mt-1 text-xl font-semibold">{last ? formatMoney(last.netCents) : "–"}</p>
          {last && first && (
            <p className="text-xs text-slate-500">
              {last.netCents >= first.netCents ? "▲" : "▼"}{" "}
              {formatMoney(Math.abs(last.netCents - first.netCents))} since {monthYear(first.date)}
            </p>
          )}
        </Card>
        <Card>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Assets</p>
          <p className="mt-1 text-xl font-semibold">{last ? formatMoney(last.assetsCents) : "–"}</p>
        </Card>
        <Card>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Debts</p>
          <p className="mt-1 text-xl font-semibold">{last ? formatMoney(last.debtsCents) : "–"}</p>
        </Card>
      </div>
      <Card>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold">Net worth over time</h2>
          <select
            aria-label="Range"
            value={months}
            onChange={(e) => setMonths(Number(e.target.value))}
            className={selectClass}
          >
            <option value={12}>1 year</option>
            <option value={24}>2 years</option>
            <option value={60}>5 years</option>
            <option value={120}>10 years</option>
          </select>
        </div>
        {r && (
          <>
            <LineChart
              ariaLabel={`Net worth over the last ${months} months`}
              points={r.points.map((p) => ({
                date: p.date,
                label: monthYear(p.date),
                value: p.netCents,
              }))}
            />
            <TableToggle>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800">
                    <th className={th}>Date</th>
                    <th className={cx(th, "text-right")}>Assets</th>
                    <th className={cx(th, "text-right")}>Debts</th>
                    <th className={cx(th, "text-right")}>Net worth</th>
                  </tr>
                </thead>
                <tbody>
                  {[...r.points].reverse().map((p) => (
                    <tr key={p.date} className="border-b border-slate-100 dark:border-slate-800/60">
                      <td className="px-2 py-1.5">
                        {p.date}
                        {p.estimated && <span className="ml-1 text-xs text-slate-500">est.</span>}
                      </td>
                      <td className={cx(td, "text-right")}>{formatMoney(p.assetsCents)}</td>
                      <td className={cx(td, "text-right")}>{formatMoney(p.debtsCents)}</td>
                      <td className={cx(td, "text-right font-medium")}>
                        {formatMoney(p.netCents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableToggle>
          </>
        )}
        <p className="mt-2 text-xs text-slate-500">
          Past values are worked out from today's balances and your transaction history. Assets
          include crypto. Property changes evenly between the values you've entered, so those dates
          are marked est. in the table.
        </p>
      </Card>
      {r && r.byType.length > 0 && (
        <Card>
          <h2 className="mb-3 font-semibold">By account type</h2>
          <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
            {r.byType
              .sort((a, b) => b.cents - a.cents)
              .map((b) => (
                <li key={b.type} className="flex justify-between py-1.5">
                  <span>
                    {b.type === "crypto"
                      ? "Crypto"
                      : (ACCOUNT_TYPE_LABELS[b.type as AccountType] ?? b.type)}
                  </span>
                  <span className="tabular-nums">{formatMoney(b.cents)}</span>
                </li>
              ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

const tabFromHash = (): Tab =>
  (TABS.find(([k]) => k === window.location.hash.slice(1))?.[0] ?? "spending") as Tab;

export function ReportsPage() {
  const [tab, setTab] = useState<Tab>(tabFromHash);
  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return (
    <>
      <PageHeader title="Reports" />
      <div
        role="tablist"
        className="mb-6 flex gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden border-b border-slate-200 dark:border-slate-800"
      >
        {TABS.map(([k, label]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            onClick={() => {
              setTab(k);
              window.history.replaceState(null, "", `#${k}`);
            }}
            className={cx(
              "-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium",
              tab === k
                ? "border-brand-600 text-brand-700 dark:text-brand-500"
                : "border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "spending" && <SpendingTab />}
      {tab === "trends" && <TrendsTab />}
      {tab === "cash-flow" && <CashFlowTab />}
      {tab === "net-worth" && <NetWorthTab />}
    </>
  );
}

import { formatMoney, type NetWorthReport, type Overview } from "@muny/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { LineChart, RankedBars } from "../components/charts.js";
import { Alert, Card, cx, PageHeader } from "../components/ui.js";
import { api } from "../lib/api.js";
import { useAccounts } from "../lib/queries.js";

const monthLabel = (iso: string) =>
  new Date(`${iso.slice(0, 7)}-15T00:00:00`).toLocaleDateString(undefined, {
    month: "short",
    year: "2-digit",
  });
const dayLabel = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

function Tile({
  label,
  value,
  children,
}: {
  label: string;
  value: string;
  children?: React.ReactNode;
}) {
  return (
    <Card>
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
      {children && <div className="mt-1 text-xs text-slate-500">{children}</div>}
    </Card>
  );
}

/** Text delta; `goodWhenDown` for spending. Never color alone: always says more/less. */
function Delta({
  cents,
  goodWhenDown,
  suffix,
}: {
  cents: number;
  goodWhenDown?: boolean;
  suffix: string;
}) {
  if (cents === 0) return <span>Same as {suffix}</span>;
  const good = goodWhenDown ? cents < 0 : cents > 0;
  return (
    <span
      className={good ? "text-emerald-700 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}
    >
      {cents > 0 ? "▲" : "▼"} {formatMoney(Math.abs(cents))} {cents > 0 ? "more" : "less"} than{" "}
      {suffix}
    </span>
  );
}

export function OverviewPage() {
  const accounts = useAccounts();
  const o = useQuery({ queryKey: ["overview"], queryFn: () => api.get<Overview>("/api/overview") });
  const nw = useQuery({
    queryKey: ["reports", "net-worth", 12],
    queryFn: () => api.get<NetWorthReport>("/api/reports/net-worth?months=12"),
  });
  const d = o.data;

  if (accounts.isSuccess && accounts.data.length === 0) {
    return (
      <>
        <PageHeader title="Overview" />
        <Card className="text-center">
          <p className="font-medium">Welcome to Muny</p>
          <p className="mt-1 text-sm text-slate-500">
            Start by{" "}
            <Link to="/import" className="text-brand-600 underline">
              importing your Rocket Money history
            </Link>{" "}
            or a bank file, or{" "}
            <Link to="/accounts" className="text-brand-600 underline">
              connect a bank
            </Link>
            .
          </p>
        </Card>
      </>
    );
  }

  const attention = d
    ? [
        d.attention.connectionsNeedingLogin > 0 && (
          <Link key="c" to="/accounts" className="underline">
            {d.attention.connectionsNeedingLogin} bank connection
            {d.attention.connectionsNeedingLogin === 1 ? " needs" : "s need"} attention
          </Link>
        ),
        d.attention.uncategorized > 0 && (
          <Link key="u" to="/transactions" className="underline">
            {d.attention.uncategorized} uncategorized transaction
            {d.attention.uncategorized === 1 ? "" : "s"}
          </Link>
        ),
        d.attention.newRecurring > 0 && (
          <Link key="r" to="/recurring" className="underline">
            {d.attention.newRecurring} new recurring charge
            {d.attention.newRecurring === 1 ? "" : "s"} to review
          </Link>
        ),
      ].filter(Boolean)
    : [];

  return (
    <>
      <PageHeader title="Overview" />
      {o.isError && <Alert>Couldn't load the overview.</Alert>}
      {d && (
        <div className="space-y-6">
          {attention.length > 0 && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              <span className="font-medium">To do:</span>
              {attention.map((a, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed small list
                <span key={i}>{a}</span>
              ))}
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Tile label="Net worth" value={formatMoney(d.netWorth.nowCents)}>
              {d.netWorth.monthAgoCents !== null && (
                <Delta
                  cents={d.netWorth.nowCents - d.netWorth.monthAgoCents}
                  suffix="30 days ago"
                />
              )}
            </Tile>
            <Tile label="Spent this month" value={formatMoney(d.spending.monthToDateCents)}>
              <Delta
                cents={d.spending.monthToDateCents - d.spending.lastMonthSameDayCents}
                goodWhenDown
                suffix="this point last month"
              />
            </Tile>
            <Tile label="Income this month" value={formatMoney(d.incomeMonthToDateCents)} />
            {d.budget ? (
              <Card>
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Budget</p>
                <p className="mt-1 text-2xl font-semibold">
                  {formatMoney(Math.max(0, (d.budget.budgetCents ?? 0) - d.budget.spentCents))}
                  <span className="text-sm font-normal text-slate-500"> left</span>
                </p>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                  <div
                    className={cx(
                      "h-full rounded-full",
                      d.budget.spentCents > (d.budget.budgetCents ?? 0)
                        ? "bg-red-500"
                        : "bg-emerald-500",
                    )}
                    style={{
                      width: `${Math.min(100, (d.budget.spentCents / Math.max(1, d.budget.budgetCents ?? 1)) * 100)}%`,
                    }}
                  />
                </div>
                <p className="mt-1 text-xs text-slate-500">
                  {formatMoney(d.budget.spentCents)} of {formatMoney(d.budget.budgetCents ?? 0)} ·{" "}
                  <Link to="/budgets" className="underline">
                    budgets
                  </Link>
                </p>
              </Card>
            ) : (
              <Tile label="Last month" value={formatMoney(d.spending.lastMonthTotalCents)}>
                spent ·{" "}
                <Link to="/budgets" className="underline">
                  set a budget
                </Link>
              </Tile>
            )}
          </div>

          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
            <Card>
              <div className="mb-2 flex items-baseline justify-between">
                <h2 className="font-semibold">Net worth, last 12 months</h2>
                <Link
                  to="/reports"
                  hash="net-worth"
                  className="text-sm text-brand-600 hover:underline"
                >
                  Details
                </Link>
              </div>
              {nw.data && (
                <LineChart
                  ariaLabel="Net worth over the last 12 months"
                  height={180}
                  points={nw.data.points.map((p) => ({
                    date: p.date,
                    label: monthLabel(p.date),
                    value: p.netCents,
                  }))}
                />
              )}
            </Card>
            <Card className="p-0">
              <div className="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
                <h2 className="font-semibold">Coming up this week</h2>
              </div>
              <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
                {d.upcoming.map((u) => (
                  <li
                    key={`${u.seriesId}-${u.date}`}
                    className="flex justify-between gap-3 px-4 py-2"
                  >
                    <span className="min-w-0">
                      <span className="block truncate">{u.name}</span>
                      <span className="text-xs text-slate-500">
                        {u.date === d.today ? "Today" : dayLabel(u.date)}
                      </span>
                    </span>
                    <span className="tabular-nums">{formatMoney(u.amountCents)}</span>
                  </li>
                ))}
                {d.upcoming.length === 0 && (
                  <li className="px-4 py-3 text-slate-500">
                    No bills expected in the next 7 days.
                  </li>
                )}
              </ul>
              <div className="border-t border-slate-200 px-4 py-2 text-right text-sm dark:border-slate-800">
                <Link to="/recurring" className="text-brand-600 hover:underline">
                  All recurring
                </Link>
              </div>
            </Card>
          </div>

          <Card>
            <div className="mb-2 flex items-baseline justify-between">
              <h2 className="font-semibold">Where your money went this month</h2>
              <Link to="/reports" className="text-sm text-brand-600 hover:underline">
                Reports
              </Link>
            </div>
            <RankedBars
              total={d.spending.monthToDateCents}
              items={d.topCategories.map((c) => ({
                key: c.id ?? "uncategorized",
                label: c.name,
                cents: c.cents,
              }))}
            />
          </Card>
        </div>
      )}
    </>
  );
}

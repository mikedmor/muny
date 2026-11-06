import { formatMoney, type SavingsAccountInfo, type SavingsAccountsReport } from "@muny/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil } from "lucide-react";
import { useState } from "react";
import { ColumnChart, LineChart, type StackBand, StackLegend } from "../components/charts.js";
import { Alert, Button, Card, cx } from "../components/ui.js";
import { api } from "../lib/api.js";
import { keys } from "../lib/queries.js";

/** Savings accounts: balances, interest, rate and where they're heading. */

const savingsAccountsKey = [...keys.accounts, "savings-report"] as const;

const pctOf = (bps: number | null) => (bps === null ? "—" : `${(bps / 100).toFixed(2)}%`);
const monthLabel = (m: string, year = false) =>
  new Date(`${m}-01T00:00:00`).toLocaleDateString(undefined, {
    month: "short",
    ...(year ? { year: "2-digit" } : {}),
  });

/**
 * Month-by-month growth at a yearly rate with a fixed monthly deposit. An
 * estimate for display (floats are fine here; nothing is stored).
 */
export function project(
  startCents: number,
  apyBps: number,
  monthlyCents: number,
  months: number,
): { balanceCents: number; interestCents: number } {
  const r = (1 + apyBps / 10000) ** (1 / 12) - 1;
  let b = startCents;
  let interest = 0;
  for (let i = 0; i < months; i++) {
    const earned = b * r;
    interest += earned;
    b += earned + monthlyCents;
  }
  return { balanceCents: Math.round(b), interestCents: Math.round(interest) };
}

function Stat({
  label,
  children,
  sub,
}: {
  label: string;
  children: React.ReactNode;
  sub?: string;
}) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="font-medium tabular-nums">{children}</dd>
      {sub && <dd className="text-xs text-slate-500">{sub}</dd>}
    </div>
  );
}

function ApyEditor({ a, onSaved }: { a: SavingsAccountInfo; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(a.apyBps === null ? "" : (a.apyBps / 100).toFixed(2));
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    const v = text.trim();
    const n = v === "" ? null : Number(v.replace("%", ""));
    if (n !== null && (!Number.isFinite(n) || n < 0 || n > 50)) {
      setError("Enter a rate like 4.35");
      return;
    }
    try {
      await api.put(`/api/savings/accounts/${a.id}/apy`, {
        apyBps: n === null ? null : Math.round(n * 100),
      });
      setEditing(false);
      setError(null);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save");
    }
  };
  if (!editing)
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="inline-flex items-center gap-1 hover:text-brand-600"
        title="Enter your account's advertised APY"
      >
        {a.apyBps === null ? (
          <span className="text-slate-400">Add APY</span>
        ) : (
          `${pctOf(a.apyBps)} APY`
        )}
        <Pencil aria-hidden="true" className="size-3 text-slate-400" />
      </button>
    );
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <input
        aria-label="APY in percent"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void save();
          if (e.key === "Escape") setEditing(false);
        }}
        placeholder="4.35"
        inputMode="decimal"
        className="w-16 rounded border border-slate-300 bg-white px-1.5 py-0.5 text-sm dark:border-slate-700 dark:bg-slate-950"
      />
      <span className="text-xs text-slate-500">%</span>
      <Button className="px-2 py-0.5 text-xs" onClick={() => void save()}>
        Save
      </Button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </span>
  );
}

function Projection({ a }: { a: SavingsAccountInfo }) {
  const defaultRate = a.apyBps ?? a.earnedApyBps ?? 0;
  const [rate, setRate] = useState((defaultRate / 100).toFixed(2));
  const [monthly, setMonthly] = useState(
    String(Math.max(0, Math.round(a.avgMonthlyContributionCents / 100))),
  );
  const bps = Math.max(0, Math.round((Number(rate) || 0) * 100));
  const perMonth = Math.round((Number(monthly) || 0) * 100);
  const rows = [12, 60, 120].map((m) => ({ m, ...project(a.balanceCents, bps, perMonth, m) }));
  return (
    <div className="rounded-xl bg-slate-50 p-4 dark:bg-slate-800/40">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <span className="font-medium">Where it's heading</span>
        <label className="inline-flex items-center gap-1 text-slate-600 dark:text-slate-400">
          Rate
          <input
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            inputMode="decimal"
            className="w-16 rounded border border-slate-300 bg-white px-1.5 py-0.5 dark:border-slate-700 dark:bg-slate-950"
          />
          %
        </label>
        <label className="inline-flex items-center gap-1 text-slate-600 dark:text-slate-400">
          Adding $
          <input
            value={monthly}
            onChange={(e) => setMonthly(e.target.value)}
            inputMode="decimal"
            className="w-20 rounded border border-slate-300 bg-white px-1.5 py-0.5 dark:border-slate-700 dark:bg-slate-950"
          />
          a month
        </label>
      </div>
      <dl className="mt-3 grid grid-cols-3 gap-3 text-sm">
        {rows.map((r) => (
          <div key={r.m}>
            <dt className="text-xs text-slate-500">
              In {r.m / 12} year{r.m === 12 ? "" : "s"}
            </dt>
            <dd className="font-semibold tabular-nums">{formatMoney(r.balanceCents)}</dd>
            <dd className="text-xs text-emerald-700 tabular-nums dark:text-emerald-400">
              +{formatMoney(Math.max(0, r.interestCents))} interest
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-xs text-slate-500">
        An estimate: interest compounds monthly at this rate, and the same amount is added every
        month. Rates on savings accounts change.
      </p>
    </div>
  );
}

function AccountCard({ a, onSaved }: { a: SavingsAccountInfo; onSaved: () => void }) {
  // Balance split into what you put in and the interest it earned (cumulative).
  let earned = 0;
  const start = a.months.findIndex((m) => m.balanceCents !== 0);
  const months = start < 0 ? [] : a.months.slice(start);
  const interestSoFar = months.map((m) => {
    earned += m.interestCents;
    return earned;
  });
  const stack: StackBand[] = [
    {
      key: "added",
      label: "Money you added",
      color: "var(--viz-series-1)",
      values: months.map((m, i) => Math.max(0, m.balanceCents - (interestSoFar[i] ?? 0))),
    },
    {
      key: "interest",
      label: "Interest earned",
      color: "var(--viz-series-3)",
      values: months.map((m, i) => Math.min(Math.max(0, m.balanceCents), interestSoFar[i] ?? 0)),
    },
  ];
  const last12 = a.months.slice(-12);
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold">{a.name}</h3>
          <p className="text-xs text-slate-500">
            {[a.institutionName, a.mask && `••${a.mask}`].filter(Boolean).join(" · ")}
          </p>
        </div>
        <p className="text-2xl font-semibold tabular-nums">{formatMoney(a.balanceCents)}</p>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-5">
        <Stat label="Rate">
          <ApyEditor a={a} onSaved={onSaved} />
        </Stat>
        <Stat label="Earned over the last year" sub="Interest ÷ average balance">
          {pctOf(a.earnedApyBps)}
        </Stat>
        <Stat
          label="Interest, last 30 days"
          sub={a.lastInterestDate ? `Last paid ${a.lastInterestDate}` : "None found yet"}
        >
          {formatMoney(a.interest.last30Cents)}
        </Stat>
        <Stat
          label="Interest this year"
          sub={`${formatMoney(a.interest.last12Cents)} last 12 months`}
        >
          {formatMoney(a.interest.ytdCents)}
        </Stat>
        <Stat label="Added per month" sub="Average, not counting interest">
          <span
            className={cx(a.avgMonthlyContributionCents < 0 && "text-red-600 dark:text-red-400")}
          >
            {formatMoney(a.avgMonthlyContributionCents)}
          </span>
        </Stat>
      </dl>
      <div className="mt-5 grid gap-6 lg:grid-cols-2">
        <div>
          <p className="mb-2 text-xs font-medium text-slate-500">Balance</p>
          {months.length >= 2 ? (
            <>
              <LineChart
                ariaLabel={`${a.name} balance by month`}
                height={180}
                stack={stack}
                points={months.map((m) => ({
                  date: m.month,
                  label: monthLabel(m.month, true),
                  value: m.balanceCents,
                }))}
              />
              <StackLegend stack={stack} />
            </>
          ) : (
            <p className="py-8 text-center text-sm text-slate-500">Not enough history yet.</p>
          )}
        </div>
        <div>
          <p className="mb-2 text-xs font-medium text-slate-500">Interest by month</p>
          <ColumnChart
            ariaLabel={`${a.name} interest by month`}
            seriesNames={["Interest"]}
            data={last12.map((m) => ({
              key: m.month,
              label: monthLabel(m.month),
              title: monthLabel(m.month, true),
              values: [m.interestCents],
            }))}
          />
        </div>
      </div>
      <div className="mt-5">
        <Projection a={a} />
      </div>
    </Card>
  );
}

export function SavingsAccountsTab() {
  const q = useQuery({
    queryKey: savingsAccountsKey,
    queryFn: () => api.get<SavingsAccountsReport>("/api/savings/accounts"),
  });
  const qc = useQueryClient();
  const r = q.data;
  if (q.error) return <Alert>{q.error.message}</Alert>;
  if (!r) return <p className="text-sm text-slate-500">Loading…</p>;
  if (!r.accounts.length)
    return (
      <Card className="text-center">
        <h2 className="text-lg font-semibold">No savings accounts yet</h2>
        <p className="mx-auto mt-2 max-w-lg text-sm text-slate-600 dark:text-slate-400">
          Accounts of type "Savings" show up here with the interest they earn and where they're
          heading. Connect your bank, import its transactions, or set an account's type to Savings
          on the Accounts page.
        </p>
      </Card>
    );
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {(
          [
            ["In savings", formatMoney(r.totalBalanceCents)],
            ["Interest this year", formatMoney(r.interestYtdCents)],
            ["Interest, last 12 months", formatMoney(r.interest12Cents)],
            ["Average rate", r.blendedApyBps === null ? "—" : pctOf(r.blendedApyBps)],
          ] as const
        ).map(([label, value]) => (
          <Card key={label}>
            <p className="text-xs font-medium tracking-wide text-slate-500 uppercase">{label}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
          </Card>
        ))}
      </div>
      {r.accounts.map((a) => (
        <AccountCard
          key={a.id}
          a={a}
          onSaved={() => void qc.invalidateQueries({ queryKey: savingsAccountsKey })}
        />
      ))}
    </div>
  );
}

import { formatMoney, type SavingsAccountInfo, type SavingsAccountsReport } from "@muny/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil } from "lucide-react";
import { useState } from "react";
import { ColumnChart, LineChart, type StackBand } from "../components/charts.js";
import { Modal } from "../components/forms.js";
import { Alert, Button, Card, cx } from "../components/ui.js";
import { api } from "../lib/api.js";
import { keys } from "../lib/queries.js";
import { SavingsBucketsSection } from "./SavingsBuckets.js";

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
  // Start from what you entered, else the rate actually earned.
  const start = a.apyBps ?? a.earnedApyBps;
  const [text, setText] = useState(start === null ? "" : (start / 100).toFixed(2));
  const [error, setError] = useState<string | null>(null);
  const save = async (value = text) => {
    const v = value.trim();
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
  if (!editing && a.apyBps === null && a.earnedApyBps !== null)
    // Suggest the rate worked out from the interest it paid.
    return (
      <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
        <span title="Worked out from the interest paid over the last year">
          ≈{pctOf(a.earnedApyBps)} APY
        </span>
        <button
          type="button"
          onClick={() => void save(`${(a.earnedApyBps as number) / 100}`)}
          className="text-xs font-normal text-brand-600 hover:underline dark:text-brand-500"
        >
          Use it
        </button>
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="text-xs font-normal text-slate-500 hover:underline"
        >
          Enter another
        </button>
      </span>
    );
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

/** Month by month: what's there to start, what you add, and the interest it earns. */
function growth(startCents: number, rateBps: number, monthlyCents: number, months: number) {
  const r = (1 + rateBps / 10000) ** (1 / 12) - 1;
  let b = startCents;
  let added = 0;
  let interest = 0;
  const out = [{ m: 0, balance: b, added, interest }];
  for (let i = 1; i <= months; i++) {
    const earned = b * r;
    interest += earned;
    added += monthlyCents;
    b += earned + monthlyCents;
    out.push({ m: i, balance: b, added, interest });
  }
  return out;
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  show,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  show: string;
}) {
  return (
    <label className="block">
      <span className="flex items-baseline justify-between text-sm">
        <span className="text-slate-600 dark:text-slate-400">{label}</span>
        <span className="font-semibold tabular-nums">{show}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1 w-full accent-brand-600"
      />
    </label>
  );
}

/** Plan & project: sliders for the rate, monthly deposit and years, with the growth charted. */
function PlanDialog({
  a,
  onClose,
  onSaved,
}: {
  a: SavingsAccountInfo;
  onClose: () => void;
  onSaved: () => void;
}) {
  const defaultRate = a.plan?.rateBps ?? a.apyBps ?? a.earnedApyBps ?? 0;
  const defaultMonthly = a.plan?.monthlyCents ?? Math.max(0, a.avgMonthlyContributionCents);
  const [rate, setRate] = useState(defaultRate / 100);
  const [monthly, setMonthly] = useState(Math.round(defaultMonthly / 100));
  const [years, setYears] = useState(10);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const months = years * 12;
  const rows = growth(a.balanceCents, Math.round(rate * 100), monthly * 100, months);
  const end = rows.at(-1) ?? { balance: a.balanceCents, added: 0, interest: 0 };
  const now = new Date();
  const label = (m: number) =>
    new Date(now.getFullYear(), now.getMonth() + m, 1).toLocaleDateString(undefined, {
      month: "short",
      year: "2-digit",
    });
  const step = months > 120 ? 3 : 1;
  const shown = rows.filter((r) => r.m % step === 0 || r.m === months);
  const stack: StackBand[] = [
    {
      key: "start",
      label: "Today's balance",
      color: "var(--viz-series-1)",
      values: shown.map(() => Math.max(0, a.balanceCents)),
    },
    {
      key: "added",
      label: "Your deposits",
      color: "var(--viz-series-2)",
      values: shown.map((r) => Math.round(r.added)),
    },
    {
      key: "interest",
      label: "Interest",
      color: "var(--viz-series-3)",
      values: shown.map((r) => Math.max(0, Math.round(r.interest))),
    },
  ];
  const maxMonthly = Math.max(
    2000,
    Math.ceil(((Math.max(0, defaultMonthly) / 100) * 3) / 100) * 100,
  );
  const save = async () => {
    setSaving(true);
    try {
      await api.put(`/api/savings/accounts/${a.id}/plan`, {
        monthlyCents: monthly * 100,
        rateBps: Math.round(rate * 100),
      });
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save");
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-3 gap-3 text-center">
        {(
          [
            [`In ${years} year${years === 1 ? "" : "s"}`, end.balance, ""],
            ["You'd add", end.added, ""],
            ["Interest earned", end.interest, "text-emerald-700 dark:text-emerald-400"],
          ] as const
        ).map(([k, v, c]) => (
          <div key={k} className="rounded-xl bg-slate-50 p-3 dark:bg-slate-800/50">
            <p className="text-xs text-slate-500">{k}</p>
            <p className={cx("text-lg font-semibold tabular-nums", c)}>
              {formatMoney(Math.round(v))}
            </p>
          </div>
        ))}
      </div>
      <LineChart
        ariaLabel={`Projected balance of ${a.name}`}
        height={220}
        stack={stack}
        points={shown.map((r) => ({
          date: String(r.m),
          label: label(r.m),
          value: Math.round(r.balance),
        }))}
      />
      <div className="grid gap-4 sm:grid-cols-3">
        <Slider
          label="Interest rate"
          value={rate}
          min={0}
          max={10}
          step={0.05}
          onChange={setRate}
          show={`${rate.toFixed(2)}%`}
        />
        <Slider
          label="Monthly deposit"
          value={monthly}
          min={0}
          max={maxMonthly}
          step={25}
          onChange={setMonthly}
          show={formatMoney(monthly * 100)}
        />
        <Slider
          label="Years"
          value={years}
          min={1}
          max={30}
          step={1}
          onChange={setYears}
          show={String(years)}
        />
      </div>
      <p className="text-xs text-slate-500">
        An estimate: interest compounds monthly at this rate and the same amount is added every
        month. Savings rates change over time.
      </p>
      {error && <Alert>{error}</Alert>}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
        <Button disabled={saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save as my plan"}
        </Button>
      </div>
    </div>
  );
}

/** The saved plan's projections, with the button that opens the planner. */
function PlanSummary({ a, onSaved }: { a: SavingsAccountInfo; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const rate = a.plan?.rateBps ?? a.apyBps ?? a.earnedApyBps ?? 0;
  const monthly = a.plan?.monthlyCents ?? Math.max(0, a.avgMonthlyContributionCents);
  const at = (years: number) => growth(a.balanceCents, rate, monthly, years * 12).at(-1);
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl bg-slate-50 p-4 dark:bg-slate-800/40">
      <div>
        <p className="text-sm font-medium">
          {a.plan ? "Your plan" : "If you keep going"}:{" "}
          <span className="font-normal text-slate-600 dark:text-slate-400">
            {formatMoney(monthly)} a month at {(rate / 100).toFixed(2)}%
          </span>
        </p>
        <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm">
          {[1, 5, 10].map((y) => (
            <div key={y}>
              <dt className="inline text-slate-500">
                In {y} year{y === 1 ? "" : "s"}:{" "}
              </dt>
              <dd className="inline font-semibold tabular-nums">
                {formatMoney(Math.round(at(y)?.balance ?? 0))}
              </dd>
            </div>
          ))}
        </dl>
      </div>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Plan &amp; project
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title={`Plan for ${a.name}`}>
        {open && <PlanDialog a={a} onClose={() => setOpen(false)} onSaved={onSaved} />}
      </Modal>
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
  // The next 12 months on your plan, or at the current pace and rate.
  const planRate = a.plan?.rateBps ?? a.apyBps ?? a.earnedApyBps ?? 0;
  const planMonthly = a.plan?.monthlyCents ?? Math.max(0, a.avgMonthlyContributionCents);
  const lastMonth = a.months.at(-1)?.month ?? new Date().toISOString().slice(0, 7);
  const [ly, lm] = lastMonth.split("-").map(Number) as [number, number];
  const ahead = growth(a.balanceCents, planRate, planMonthly, 12)
    .slice(1)
    .map((g) => ({
      month: new Date(Date.UTC(ly, lm - 1 + g.m, 1)).toISOString().slice(0, 7),
      balanceCents: Math.round(g.balance),
    }));
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
                ariaLabel={`${a.name} balance by month, with the next 12 months projected`}
                height={180}
                stack={stack}
                projectedFrom={months.length}
                points={[
                  ...months.map((m) => ({
                    date: m.month,
                    label: monthLabel(m.month, true),
                    value: m.balanceCents,
                  })),
                  ...ahead.map((p) => ({
                    date: p.month,
                    label: monthLabel(p.month, true),
                    value: p.balanceCents,
                  })),
                ]}
              />
              <p className="mt-1 text-xs text-slate-500">
                Dashed: the next 12 months at {formatMoney(planMonthly)} a month and{" "}
                {(planRate / 100).toFixed(2)}%{a.plan ? " (your plan)" : ""}.
              </p>
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
      <SavingsBucketsSection accountId={a.id} />
      <div className="mt-5">
        <PlanSummary a={a} onSaved={onSaved} />
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

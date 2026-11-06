import {
  amortizedPayment,
  currentPlan,
  DEFAULT_LOAN_PLAN,
  extraNeeded,
  formatMoney,
  type Loan,
  type LoanPlanSettings,
  type LoansReport,
  orderLoans,
  PLAN_STRATEGY_LABELS,
  type PlanLoan,
  type PlanStrategy,
  simulatePlan,
} from "@muny/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Lightbulb, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { LineChart, type StackBand } from "../../components/charts.js";
import { Button, Card, cx } from "../../components/ui.js";
import { api } from "../../lib/api.js";
import { assignColors, OTHER_COLOR } from "../../lib/series.js";

/**
 * Loans → Payoff plan: pick a goal (least interest, quick wins, or your own
 * order), add money each month, set dates you'd like loans gone by, and see
 * what it does, with suggestions for adjusting payments. Nothing is paid:
 * Muny only plans (it never moves money).
 */

const planKey = ["loan-plan"] as const;

const monthYear = (d: Date) => d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
const inMonths = (n: number) => {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  return d;
};
const whenLabel = (m: number | null) =>
  m === null ? "Not within 50 years" : monthYear(inMonths(m));
const monthsUntil = (iso: string) => {
  const now = new Date();
  const [y, m] = iso.split("-").map(Number);
  return Math.max(1, ((y ?? 0) - now.getFullYear()) * 12 + ((m ?? 1) - 1 - now.getMonth()));
};
const span = (m: number) => {
  const y = Math.floor(m / 12);
  const r = m % 12;
  return [y && `${y} yr`, r && `${r} mo`].filter(Boolean).join(" ") || "0 mo";
};

const STRATEGY_HELP: Record<PlanStrategy, string> = {
  avalanche: "Pay the least interest: extra money goes to the highest rate first.",
  snowball: "Quick wins: the smallest balance first, then its payment rolls into the next.",
  custom: "You choose which loans come first (use the arrows below).",
};

/** The plan's loans: what each costs now. A mortgage counts its principal and interest part. */
function toPlanLoan(l: Loan): PlanLoan {
  const payment = l.principalInterestCents ?? l.monthlyPaymentCents ?? l.minimumPaymentCents ?? 0;
  const minimum = Math.min(payment, l.minimumPaymentCents ?? payment);
  return {
    id: l.accountId,
    name: l.name,
    balanceCents: l.balanceCents,
    aprBps: l.aprBps ?? 0,
    paymentCents: payment,
    minimumCents: minimum,
  };
}

export function PayoffPlan({ report }: { report: LoansReport }) {
  const qc = useQueryClient();
  const saved = useQuery({
    queryKey: planKey,
    queryFn: () => api.get<LoanPlanSettings>("/api/loans/plan"),
  });
  const [p, setP] = useState<LoanPlanSettings | null>(null);
  useEffect(() => {
    if (saved.data && !p) setP(saved.data);
  }, [saved.data, p]);

  // Save a moment after the last change (sliders change a lot).
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const update = (patch: Partial<LoanPlanSettings>) =>
    setP((cur) => {
      const next = { ...(cur ?? DEFAULT_LOAN_PLAN), ...patch };
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        void api.put("/api/loans/plan", next).then(() => qc.setQueryData(planKey, next));
      }, 600);
      return next;
    });

  if (!p) return <p className="text-sm text-slate-500">Loading…</p>;
  return <Planner report={report} p={p} update={update} />;
}

function Planner({
  report,
  p,
  update,
}: {
  report: LoansReport;
  p: LoanPlanSettings;
  update: (patch: Partial<LoanPlanSettings>) => void;
}) {
  const open = report.loans.filter((l) => l.balanceCents > 0);
  const inPlan = (l: Loan) =>
    l.kind === "mortgage" ? p.included.includes(l.accountId) : !p.excluded.includes(l.accountId);
  const loans = open.filter(inPlan);
  const left = open.filter((l) => !inPlan(l));
  const leftMortgages = left.filter((l) => l.kind === "mortgage");
  const leftOther = left.filter((l) => l.kind !== "mortgage");
  const planLoans = loans.map(toPlanLoan);
  const byId = new Map(loans.map((l) => [l.accountId, l]));

  const calc = (() => {
    const order = orderLoans(planLoans, p.strategy, p.order);
    const opts = { order, minimumsOnly: p.minimumsOnly, rollover: p.rollover };
    const now = currentPlan(planLoans);
    const plan = simulatePlan(planLoans, { ...opts, extraCents: p.extraCents });
    const other = (s: PlanStrategy) =>
      simulatePlan(planLoans, {
        extraCents: p.extraCents,
        order: orderLoans(planLoans, s, p.order),
        minimumsOnly: p.minimumsOnly,
        rollover: p.rollover,
      });
    const strategies = (["avalanche", "snowball"] as const).map((s) => ({ s, r: other(s) }));
    const moved = p.minimumsOnly
      ? null
      : simulatePlan(planLoans, { ...opts, extraCents: p.extraCents, minimumsOnly: true });
    const goalMonths = p.debtFreeBy ? monthsUntil(p.debtFreeBy) : null;
    const needed = goalMonths !== null ? extraNeeded(planLoans, goalMonths, opts) : null;
    // Rolling payments over vs not.
    const rolled = p.rollover
      ? null
      : simulatePlan(planLoans, { ...opts, extraCents: p.extraCents, rollover: true });
    // A quick win: the loan closest to done (not already first) cleared first frees its payment sooner.
    const quick = [...planLoans]
      .filter((l) => l.id !== order[0] && l.paymentCents > 0 && l.balanceCents > 0)
      .sort((a, b) => a.balanceCents / a.paymentCents - b.balanceCents / b.paymentCents)[0];
    const quickPlan = quick
      ? simulatePlan(planLoans, {
          ...opts,
          extraCents: p.extraCents,
          order: [quick.id, ...order.filter((id) => id !== quick.id)],
        })
      : null;
    return { order, now, plan, strategies, moved, goalMonths, needed, rolled, quick, quickPlan };
  })();
  const { order, now, plan, strategies, moved, goalMonths, needed, rolled, quick, quickPlan } =
    calc;

  if (open.length === 0)
    return (
      <Card className="text-center text-sm text-slate-500">
        Nothing owed: there's nothing to plan.
      </Card>
    );

  const saved = now.totalInterestCents - plan.totalInterestCents;
  const sooner = now.months !== null && plan.months !== null ? now.months - plan.months : null;
  const maxExtra = Math.max(
    1000,
    Math.ceil(planLoans.reduce((s, l) => s + l.paymentCents, 0) / 100 / 100) * 100,
  );

  // Suggestions for adjusting payments.
  const tips: { text: React.ReactNode; action?: { label: string; run: () => void } }[] = [];
  const best = [...strategies].sort((a, b) => a.r.totalInterestCents - b.r.totalInterestCents)[0];
  if (best && p.strategy !== best.s && plan.totalInterestCents - best.r.totalInterestCents > 100)
    tips.push({
      text: (
        <>
          <strong>{PLAN_STRATEGY_LABELS[best.s]}</strong> would save{" "}
          {formatMoney(plan.totalInterestCents - best.r.totalInterestCents)} more interest than your
          current order.
        </>
      ),
      action: { label: "Switch", run: () => update({ strategy: best.s }) },
    });
  if (moved && plan.totalInterestCents - moved.totalInterestCents > 100) {
    const above = planLoans
      .filter((l) => l.paymentCents > l.minimumCents && l.id !== order[0])
      .reduce((s, l) => s + l.paymentCents - l.minimumCents, 0);
    if (above > 0)
      tips.push({
        text: (
          <>
            You pay {formatMoney(above)} a month above the minimums on loans that aren't first.
            Paying only their minimums and putting that toward{" "}
            <strong>{byId.get(order[0] ?? "")?.name}</strong> saves{" "}
            {formatMoney(plan.totalInterestCents - moved.totalInterestCents)}
            {moved.months !== null && plan.months !== null && plan.months > moved.months
              ? ` and finishes ${span(plan.months - moved.months)} sooner`
              : ""}
            .
          </>
        ),
        action: { label: "Do that", run: () => update({ minimumsOnly: true }) },
      });
  }
  if (rolled && plan.totalInterestCents - rolled.totalInterestCents > 100)
    tips.push({
      text: (
        <>
          Rolling each paid-off loan's payment into the next would save{" "}
          {formatMoney(plan.totalInterestCents - rolled.totalInterestCents)}
          {rolled.months !== null && plan.months !== null && plan.months > rolled.months
            ? ` and finish ${span(plan.months - rolled.months)} sooner`
            : ""}
          .
        </>
      ),
      action: { label: "Roll them over", run: () => update({ rollover: true }) },
    });
  if (
    p.rollover &&
    quick &&
    quickPlan &&
    quickPlan.payoffMonth[quick.id] !== null &&
    (plan.payoffMonth[quick.id] ?? 999) - (quickPlan.payoffMonth[quick.id] ?? 999) >= 2 &&
    quickPlan.totalInterestCents - plan.totalInterestCents < 5_000
  ) {
    const freed = (plan.payoffMonth[quick.id] ?? 0) - (quickPlan.payoffMonth[quick.id] ?? 0);
    const diff = quickPlan.totalInterestCents - plan.totalInterestCents;
    tips.push({
      text: (
        <>
          Quick win: <strong>{quick.name}</strong> has only {formatMoney(quick.balanceCents)} left.
          Clearing it first frees its {formatMoney(quick.paymentCents)} payment {span(freed)} sooner
          for the rest
          {diff <= 0
            ? `, and saves ${formatMoney(-diff)} in interest`
            : `, for ${formatMoney(diff)} more interest overall`}
          .
        </>
      ),
      action: {
        label: "Put it first",
        run: () =>
          update({
            strategy: "custom",
            order: [quick.id, ...order.filter((id) => id !== quick.id)],
          }),
      },
    });
  }
  if (p.debtFreeBy && goalMonths !== null) {
    if (needed === null)
      tips.push({
        text: (
          <>Debt-free by {monthYear(inMonths(goalMonths))} isn't reachable by paying extra alone.</>
        ),
      });
    else if (needed > p.extraCents)
      tips.push({
        text: (
          <>
            To be debt-free by <strong>{monthYear(inMonths(goalMonths))}</strong>, put{" "}
            <strong>{formatMoney(needed)}</strong> extra toward the plan each month (
            {formatMoney(needed - p.extraCents)} more than now).
          </>
        ),
        action: { label: `Use ${formatMoney(needed)}`, run: () => update({ extraCents: needed }) },
      });
    else if (p.extraCents - needed >= 1_000)
      tips.push({
        text: (
          <>
            You're ahead of your goal: <strong>{formatMoney(needed)}</strong> extra a month is
            enough to be debt-free by {monthYear(inMonths(goalMonths))} (
            {formatMoney(p.extraCents - needed)} a month less than now)
            {plan.months !== null && plan.months < goalMonths
              ? `. At ${formatMoney(p.extraCents)} you'd finish ${span(goalMonths - plan.months)} early`
              : ""}
            .
          </>
        ),
        action: { label: `Use ${formatMoney(needed)}`, run: () => update({ extraCents: needed }) },
      });
    else
      tips.push({
        text: <>You're on track to be debt-free by {monthYear(inMonths(goalMonths))}.</>,
      });
  }
  for (const [id, date] of Object.entries(p.targets)) {
    const l = byId.get(id);
    const pl = planLoans.find((x) => x.id === id);
    if (!l || !pl) continue;
    const months = monthsUntil(date);
    const at = plan.payoffMonth[id] ?? null;
    if (at !== null && at <= months) {
      tips.push({
        text: (
          <>
            <strong>{l.name}</strong> is paid off by {monthYear(inMonths(months))} with this plan.
          </>
        ),
      });
      continue;
    }
    const need = amortizedPayment(pl.balanceCents, pl.aprBps, months);
    tips.push({
      text: (
        <>
          To pay off <strong>{l.name}</strong> by {monthYear(inMonths(months))}, pay about{" "}
          <strong>{formatMoney(need)}</strong> a month on it (
          {formatMoney(Math.max(0, need - pl.paymentCents))} more than now), or move it to the front
          of your order.
        </>
      ),
      action:
        order[0] !== id
          ? {
              label: "Put it first",
              run: () =>
                update({ strategy: "custom", order: [id, ...order.filter((x) => x !== id)] }),
            }
          : undefined,
    });
  }
  const priciest = [...planLoans].sort(
    (a, b) => b.balanceCents * b.aprBps - a.balanceCents * a.aprBps,
  )[0];
  if (priciest && priciest.aprBps > 0)
    tips.push({
      text: (
        <>
          <strong>{priciest.name}</strong> costs the most: about{" "}
          {formatMoney(Math.round((priciest.balanceCents * priciest.aprBps) / 120_000))} interest a
          month at {(priciest.aprBps / 100).toFixed(2)}%.
        </>
      ),
    });
  const noRate = loans.filter((l) => l.aprBps === null);
  if (noRate.length)
    tips.push({
      text: (
        <>
          No rate set for {noRate.map((l) => l.name).join(", ")}: counted at 0%. Add it in Edit
          details.
        </>
      ),
    });

  // Chart: the plan's balances, one band per loan.
  const months = plan.months ?? 600;
  const step = months > 120 ? 3 : 1;
  const idx = Array.from({ length: months + 1 }, (_, i) => i).filter(
    (i) => i % step === 0 || i === months,
  );
  const colors = assignColors(
    planLoans.map((l) => ({ key: l.id, value: l.balanceCents, order: l.name })),
  );
  const stack: StackBand[] = order.map((id) => ({
    key: id,
    label: byId.get(id)?.name ?? "",
    color: colors.get(id) ?? OTHER_COLOR,
    values: idx.map((i) => plan.balances[id]?.[i] ?? 0),
  }));
  const points = idx.map((i) => ({
    date: String(i),
    label: monthYear(inMonths(i)),
    value: order.reduce((s, id) => s + (plan.balances[id]?.[i] ?? 0), 0),
  }));

  const move = (id: string, by: number) => {
    const o = [...order];
    const i = o.indexOf(id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= o.length) return;
    [o[i], o[j]] = [o[j] as string, o[i] as string];
    update({ strategy: "custom", order: o });
  };
  const toggle = (l: Loan, on: boolean) => {
    if (l.kind === "mortgage")
      update({
        included: on ? [...p.included, l.accountId] : p.included.filter((x) => x !== l.accountId),
      });
    else
      update({
        excluded: on ? p.excluded.filter((x) => x !== l.accountId) : [...p.excluded, l.accountId],
      });
  };

  return (
    <div className="space-y-6">
      <Card className="space-y-5">
        <div>
          <h2 className="font-semibold">Your goal</h2>
          <p className="mt-1 text-xs text-slate-500">
            A plan only: Muny never pays anything. Every loan keeps its payment; extra money, and
            the payments of loans you finish, go to the loans in this order.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          {(Object.keys(PLAN_STRATEGY_LABELS) as PlanStrategy[]).map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={p.strategy === s}
              onClick={() => update({ strategy: s, order: s === "custom" ? order : p.order })}
              className={cx(
                "rounded-xl border p-3 text-left text-sm",
                p.strategy === s
                  ? "border-brand-600 bg-brand-50 dark:bg-brand-700/20"
                  : "border-slate-200 hover:border-slate-300 dark:border-slate-800 dark:hover:border-slate-700",
              )}
            >
              <span className="font-medium">{PLAN_STRATEGY_LABELS[s]}</span>
              <span className="mt-1 block text-xs text-slate-500">{STRATEGY_HELP[s]}</span>
            </button>
          ))}
        </div>
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_auto]">
          <label className="block">
            <span className="flex items-baseline justify-between text-sm">
              <span className="text-slate-600 dark:text-slate-400">Extra each month</span>
              <span className="font-semibold tabular-nums">{formatMoney(p.extraCents)}</span>
            </span>
            <input
              type="range"
              min={0}
              max={maxExtra}
              step={10}
              value={Math.min(maxExtra, p.extraCents / 100)}
              onChange={(e) => update({ extraCents: Number(e.target.value) * 100 })}
              className="mt-1 w-full accent-brand-600"
            />
          </label>
          <label className="block text-sm">
            <span className="text-slate-600 dark:text-slate-400">Debt-free by (optional)</span>
            <span className="mt-1 flex items-center gap-1">
              <input
                type="month"
                value={p.debtFreeBy?.slice(0, 7) ?? ""}
                onChange={(e) =>
                  update({ debtFreeBy: e.target.value ? `${e.target.value}-01` : null })
                }
                className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 dark:border-slate-700 dark:bg-slate-950"
              />
              {p.debtFreeBy && (
                <button
                  type="button"
                  aria-label="Clear the date"
                  onClick={() => update({ debtFreeBy: null })}
                  className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                >
                  <X aria-hidden="true" className="size-4" />
                </button>
              )}
            </span>
          </label>
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={p.minimumsOnly}
            onChange={(e) => update({ minimumsOnly: e.target.checked })}
            className="mt-0.5 accent-brand-600"
          />
          <span>
            Pay only the minimum on the others
            <span className="block text-xs text-slate-500">
              What you pay above the minimums goes to the first loan in the order instead.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={p.rollover}
            onChange={(e) => update({ rollover: e.target.checked })}
            className="mt-0.5 accent-brand-600"
          />
          <span>
            Roll paid-off loans into the next
            <span className="block text-xs text-slate-500">
              When a loan is paid off, keep paying its amount toward the next loan in the order (the
              snowball). Off: that money stops when the loan does.
            </span>
          </span>
        </label>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Debt-free"
          value={whenLabel(plan.months)}
          sub={`As you pay now: ${whenLabel(now.months)}`}
        />
        <Stat
          label="Interest left"
          value={formatMoney(plan.totalInterestCents)}
          sub={`As you pay now: ${formatMoney(now.totalInterestCents)}`}
        />
        <Stat
          label="You'd save"
          value={formatMoney(Math.max(0, saved))}
          sub={sooner !== null && sooner > 0 ? `Done ${span(sooner)} sooner` : undefined}
          good={saved > 0}
        />
        <Stat
          label="Each month"
          value={formatMoney(plan.monthlyCents)}
          sub={p.extraCents ? `Includes ${formatMoney(p.extraCents)} extra` : "What you pay now"}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card>
          <h2 className="mb-3 font-semibold">Balances with this plan</h2>
          {points.length > 2 ? (
            <LineChart
              ariaLabel="Loan balances with this plan"
              height={240}
              points={points}
              stack={stack}
            />
          ) : (
            <p className="text-sm text-slate-500">Paid off within a month.</p>
          )}
        </Card>
        <Card>
          <h2 className="mb-3 flex items-center gap-2 font-semibold">
            <Lightbulb aria-hidden="true" className="size-4 text-amber-500" /> Suggestions
          </h2>
          {tips.length === 0 ? (
            <p className="text-sm text-slate-500">
              This plan is already the best for your goal. Paying extra each month is the only way
              to do better.
            </p>
          ) : (
            <ul className="space-y-3 text-sm">
              {tips
                .map((t, n) => ({ ...t, id: `tip-${n}` }))
                .map((t) => (
                  <li key={t.id} className="flex items-start justify-between gap-3">
                    <span className="text-slate-700 dark:text-slate-300">{t.text}</span>
                    {t.action && (
                      <Button
                        variant="secondary"
                        className="shrink-0 px-2 py-1 text-xs"
                        onClick={t.action.run}
                      >
                        {t.action.label}
                      </Button>
                    )}
                  </li>
                ))}
            </ul>
          )}
        </Card>
      </div>

      <Card>
        <h2 className="font-semibold">Order</h2>
        <p className="mt-1 mb-3 text-xs text-slate-500">
          First month: what each loan gets with this plan. Set a date to get a loan gone by then.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[46rem] text-sm">
            <thead className="text-xs text-slate-500">
              <tr>
                <th className="py-1.5 text-left font-medium">#</th>
                <th className="py-1.5 text-left font-medium">Loan</th>
                <th className="py-1.5 text-right font-medium">Rate</th>
                <th className="py-1.5 text-right font-medium">Owed</th>
                <th className="py-1.5 text-right font-medium">Pay now</th>
                <th className="py-1.5 text-right font-medium">First month</th>
                <th className="py-1.5 text-right font-medium">Paid off</th>
                <th className="py-1.5 pl-4 text-left font-medium">Goal: paid off by</th>
                <th />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {order.map((id, i) => {
                const l = byId.get(id);
                const pl = planLoans.find((x) => x.id === id);
                if (!l || !pl) return null;
                const first = plan.firstPayment[id] ?? 0;
                const target = p.targets[id];
                return (
                  <tr key={id}>
                    <td className="py-2 text-slate-500 tabular-nums">{i + 1}</td>
                    <td className="py-2">
                      <span className="font-medium">{l.name}</span>
                      {l.lender && <span className="block text-xs text-slate-500">{l.lender}</span>}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {l.aprBps === null ? "—" : `${(l.aprBps / 100).toFixed(2)}%`}
                    </td>
                    <td className="py-2 text-right tabular-nums">{formatMoney(l.balanceCents)}</td>
                    <td className="py-2 text-right tabular-nums text-slate-500">
                      {formatMoney(pl.paymentCents)}
                    </td>
                    <td
                      className={cx(
                        "py-2 text-right font-medium tabular-nums",
                        first > pl.paymentCents && "text-emerald-700 dark:text-emerald-400",
                      )}
                    >
                      {formatMoney(first)}
                    </td>
                    <td className="py-2 text-right whitespace-nowrap">
                      {whenLabel(plan.payoffMonth[id] ?? null)}
                      <span className="block text-xs text-slate-500">
                        now {whenLabel(now.payoffMonth[id] ?? null)}
                      </span>
                    </td>
                    <td className="py-2 pl-4">
                      <span className="flex items-center gap-1">
                        <input
                          type="month"
                          aria-label={`${l.name}: paid off by`}
                          value={target?.slice(0, 7) ?? ""}
                          onChange={(e) => {
                            const t = { ...p.targets };
                            if (e.target.value) t[id] = `${e.target.value}-01`;
                            else delete t[id];
                            update({ targets: t });
                          }}
                          className="w-36 rounded border border-slate-300 bg-white px-1.5 py-1 text-xs dark:border-slate-700 dark:bg-slate-950"
                        />
                      </span>
                    </td>
                    <td className="py-2 text-right whitespace-nowrap">
                      <button
                        type="button"
                        aria-label={`Move ${l.name} up`}
                        disabled={i === 0}
                        onClick={() => move(id, -1)}
                        className="p-1 text-slate-400 hover:text-slate-700 disabled:opacity-30 dark:hover:text-slate-200"
                      >
                        <ArrowUp aria-hidden="true" className="size-4" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Move ${l.name} down`}
                        disabled={i === order.length - 1}
                        onClick={() => move(id, 1)}
                        className="p-1 text-slate-400 hover:text-slate-700 disabled:opacity-30 dark:hover:text-slate-200"
                      >
                        <ArrowDown aria-hidden="true" className="size-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => toggle(l, false)}
                        className="ml-1 text-xs text-slate-500 hover:underline"
                      >
                        Leave out
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {left.length > 0 && (
          <p className="mt-3 text-xs text-slate-500">
            Not in the plan:{" "}
            {leftOther.map((l, i) => (
              <span key={l.accountId}>
                {i > 0 && ", "}
                {l.name}{" "}
                <button
                  type="button"
                  onClick={() => toggle(l, true)}
                  className="text-brand-600 hover:underline dark:text-brand-500"
                >
                  add
                </button>
                {i === leftOther.length - 1 && ". "}
              </span>
            ))}
            {leftMortgages.length > 0 && (
              <>
                Mortgages are left out unless you{" "}
                <button
                  type="button"
                  onClick={() =>
                    update({
                      included: [...p.included, ...leftMortgages.map((l) => l.accountId)],
                    })
                  }
                  className="text-brand-600 hover:underline dark:text-brand-500"
                >
                  add them
                </button>
                .
              </>
            )}
          </p>
        )}
      </Card>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  good,
}: {
  label: string;
  value: string;
  sub?: string;
  good?: boolean;
}) {
  return (
    <Card>
      <p className="text-xs font-medium tracking-wide text-slate-500 uppercase">{label}</p>
      <p
        className={cx(
          "mt-1 text-2xl font-semibold tabular-nums",
          good && "text-emerald-700 dark:text-emerald-400",
        )}
      >
        {value}
      </p>
      {sub && <p className="mt-1 text-xs text-slate-500">{sub}</p>}
    </Card>
  );
}

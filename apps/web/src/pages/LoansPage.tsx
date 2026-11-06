import {
  type Asset,
  formatMoney,
  LOAN_KIND_LABELS,
  LOAN_KINDS,
  type Loan,
  type LoanDetailsInput,
  type LoanKind,
  type LoansReport,
  payoff,
} from "@muny/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Download, Pencil, Plus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { LineChart } from "../components/charts.js";
import { Modal } from "../components/forms.js";
import { Alert, Button, Card, cx, Field, PageHeader } from "../components/ui.js";
import { api } from "../lib/api.js";
import { openPlaidLink } from "../lib/bankWidgets.js";
import { keys, linkApi } from "../lib/queries.js";

/** Loans: what you owe, the terms, when each is paid off, and what paying extra would do (D-040, D-042). */

const loansKey = [...keys.accounts, "loans"] as const;
const assetsKey = [...keys.accounts, "assets"] as const;
const pct = (bps: number | null) => (bps === null ? "—" : `${(bps / 100).toFixed(2)}%`);
const money = (c: number | null) => (c === null ? "—" : formatMoney(c));
const day = (d: string | null) =>
  d
    ? new Date(`${d}T00:00:00`).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "—";
const monthYear = (d: string | Date | null) =>
  d
    ? (typeof d === "string" ? new Date(`${d}T00:00:00`) : d).toLocaleDateString(undefined, {
        month: "long",
        year: "numeric",
      })
    : "—";
const monthsLabel = (m: number) => {
  const y = Math.floor(m / 12);
  const r = m % 12;
  return [y && `${y} yr`, r && `${r} mo`].filter(Boolean).join(" ") || "0 mo";
};
const addMonths = (n: number) => {
  const d = new Date();
  d.setMonth(d.getMonth() + n);
  return d;
};

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card>
      <p className="text-xs font-medium tracking-wide text-slate-500 uppercase">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {sub && <p className="mt-1 text-xs text-slate-500">{sub}</p>}
    </Card>
  );
}

/** Money typed as dollars ("1,234.56") → cents; null when empty; NaN when invalid. */
const toCents = (s: string) => {
  const v = s.trim().replace(/[$,]/g, "");
  if (!v) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(v)) return Number.NaN;
  const [w = "0", f = ""] = v.split(".");
  return Number(w) * 100 + Number(f.padEnd(2, "0"));
};
const toBps = (s: string) => {
  const v = s.trim().replace("%", "");
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n * 100) : Number.NaN;
};
const toInt = (s: string) => {
  const v = s.trim();
  if (!v) return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : Number.NaN;
};
const fromCents = (c: number | null | undefined) => (c == null ? "" : (c / 100).toFixed(2));

function Select({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-sm">
      <span className="font-medium text-slate-700 dark:text-slate-300">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-950"
      >
        {children}
      </select>
    </label>
  );
}

/** Add a loan Muny tracks from your payments, or edit any loan's details. */
function LoanForm({ loan, onDone }: { loan?: Loan; onDone: () => void }) {
  const qc = useQueryClient();
  const assets = useQuery({ queryKey: assetsKey, queryFn: () => api.get<Asset[]>("/api/assets") });
  const manual = !loan?.connected;
  const [f, setF] = useState({
    name: loan?.name ?? "",
    kind: (loan?.kind ?? "personal") as LoanKind,
    lender: loan?.lender ?? "",
    balance: fromCents(loan?.startBalanceCents),
    startDate: loan?.startDate ?? new Date().toISOString().slice(0, 10),
    apr: loan?.aprBps == null ? "" : (loan.aprBps / 100).toFixed(2),
    payment: fromCents(loan?.monthlyPaymentCents),
    minimum: fromCents(loan?.minimumPaymentCents),
    nextDue: loan?.nextDueDate ?? "",
    original: fromCents(loan?.originalPrincipalCents),
    termYears: loan?.termMonths ? String(Math.round(loan.termMonths / 12)) : "",
    match: loan?.paymentMatch ?? "",
    matchAmount: fromCents(loan?.paymentAmountCents),
    homeValue: fromCents(loan?.originalValueCents),
    pmi: fromCents(loan?.pmiMonthlyCents),
    property: loan?.propertyAccountId ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF((x) => ({ ...x, [k]: e.target.value }));
  const mortgage = f.kind === "mortgage";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const nums = {
      aprBps: toBps(f.apr),
      monthlyPaymentCents: toCents(f.payment),
      minimumPaymentCents: toCents(f.minimum),
      originalPrincipalCents: toCents(f.original),
      paymentAmountCents: toCents(f.matchAmount),
      originalValueCents: mortgage ? toCents(f.homeValue) : null,
      pmiMonthlyCents: mortgage ? toCents(f.pmi) : null,
    };
    const years = toInt(f.termYears);
    const balance = toCents(f.balance);
    if ([...Object.values(nums), years, balance].some((v) => Number.isNaN(v))) {
      setError("Check the amounts, rate and years (numbers like 1234.56, 6.49 and 30).");
      return;
    }
    const details: LoanDetailsInput = {
      ...nums,
      kind: f.kind,
      lender: f.lender.trim() || null,
      nextDueDate: f.nextDue || null,
      termMonths: years === null ? null : years * 12,
      paymentMatch: f.match.trim() || null,
      propertyAccountId: f.property || null,
      ...(manual ? { startBalanceCents: balance, startDate: f.startDate || null } : {}),
    };
    try {
      if (loan) await api.patch(`/api/loans/${loan.accountId}`, details);
      else {
        if (!f.name.trim() || balance === null) {
          setError("Give the loan a name and what you owe.");
          return;
        }
        await api.post("/api/loans", { ...details, name: f.name, startBalanceCents: balance });
      }
      await qc.invalidateQueries({ queryKey: keys.accounts });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save");
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      {error && <Alert>{error}</Alert>}
      {!loan && (
        <p className="text-sm text-slate-600 dark:text-slate-400">
          For lenders your bank connection can't reach. Muny finds your payments to the lender in
          your other accounts and works the balance down, splitting each payment into interest and
          principal at the loan's rate.
        </p>
      )}
      {loan?.connected && (
        <p className="text-xs text-slate-500">
          The balance comes from your bank connection. Add the terms below for payoff dates and the
          interest/principal split.
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        {!loan && (
          <Field label="Name" value={f.name} onChange={set("name")} placeholder="e.g. Car loan" />
        )}
        <Select
          label="Kind"
          value={f.kind}
          onChange={(v) => setF((x) => ({ ...x, kind: v as LoanKind }))}
        >
          {LOAN_KINDS.map((k) => (
            <option key={k} value={k}>
              {LOAN_KIND_LABELS[k]}
            </option>
          ))}
        </Select>
        <Field
          label="Lender"
          value={f.lender}
          onChange={set("lender")}
          placeholder="e.g. Seaview"
        />
        {manual && (
          <>
            <Field
              label="What you owe"
              value={f.balance}
              onChange={set("balance")}
              inputMode="decimal"
              placeholder="12,345.67"
              hint="On the date below (a recent statement)."
            />
            <Field label="As of" type="date" value={f.startDate} onChange={set("startDate")} />
          </>
        )}
        <Field
          label="Interest rate (APR %)"
          value={f.apr}
          onChange={set("apr")}
          inputMode="decimal"
          placeholder="6.49"
        />
        <Field
          label="Your monthly payment"
          value={f.payment}
          onChange={set("payment")}
          inputMode="decimal"
          placeholder="350.00"
        />
        <Field
          label="Minimum payment"
          value={f.minimum}
          onChange={set("minimum")}
          inputMode="decimal"
          hint="From your statement, if it differs."
        />
        <Field label="Next payment due" type="date" value={f.nextDue} onChange={set("nextDue")} />
        <Field
          label="Original amount"
          value={f.original}
          onChange={set("original")}
          inputMode="decimal"
          hint="Shows how much is paid off."
        />
        <Field
          label="Term (years)"
          value={f.termYears}
          onChange={set("termYears")}
          inputMode="numeric"
          placeholder="30"
        />
      </div>
      {mortgage && (
        <div className="grid gap-4 rounded-xl bg-slate-50 p-3 sm:grid-cols-2 dark:bg-slate-800/40">
          <Field
            label="Original home value"
            value={f.homeValue}
            onChange={set("homeValue")}
            inputMode="decimal"
            hint="The lower of the price and the appraisal: mortgage insurance ends at 20% equity on it."
          />
          <Field
            label="Mortgage insurance (PMI) a month"
            value={f.pmi}
            onChange={set("pmi")}
            inputMode="decimal"
            placeholder="47.95"
          />
          <Select
            label="The home"
            value={f.property}
            onChange={(v) => setF((x) => ({ ...x, property: v }))}
          >
            <option value="">Not linked</option>
            {(assets.data ?? []).map((a) => (
              <option key={a.accountId} value={a.accountId}>
                {a.name}
              </option>
            ))}
          </Select>
          <p className="self-end text-xs text-slate-500">
            Add your home on the{" "}
            <Link to="/assets" className="text-brand-600 underline">
              Assets
            </Link>{" "}
            page to see its value and your equity.
          </p>
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Words in your payments"
          value={f.match}
          onChange={set("match")}
          placeholder="e.g. SEAVIEW RESORTS"
          hint="How the payment appears in checking. Loans with the same words share each payment."
        />
        <Field
          label="Only payments of about"
          value={f.matchAmount}
          onChange={set("matchAmount")}
          inputMode="decimal"
          placeholder="e.g. 245.00"
          hint="For a lender with several loans (or dues) paid separately under one name."
        />
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit">{loan ? "Save" : "Add loan"}</Button>
      </div>
    </form>
  );
}

function PayoffPlanner({ loan }: { loan: Loan }) {
  const [extra, setExtra] = useState(0);
  const paying = loan.principalInterestCents ?? loan.monthlyPaymentCents;
  if (loan.aprBps === null || !paying)
    return (
      <p className="rounded-xl bg-slate-50 p-4 text-sm text-slate-500 dark:bg-slate-800/40">
        Add the interest rate and monthly payment (Edit details) to see when it's paid off and what
        paying extra would save.
      </p>
    );
  const base = payoff(loan.balanceCents, loan.aprBps, paying);
  const plan = payoff(loan.balanceCents, loan.aprBps, paying, extra * 100);
  const saved =
    base.months !== null && plan.months !== null
      ? base.totalInterestCents - plan.totalInterestCents
      : null;
  const step = plan.balances.length > 120 ? 3 : 1;
  const shown = plan.balances
    .map((b, m) => ({ b, m }))
    .filter((p) => p.m % step === 0 || p.m === plan.balances.length - 1);
  return (
    <div className="rounded-xl bg-slate-50 p-4 dark:bg-slate-800/40">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium">Payoff</p>
        <p className="text-sm">
          {plan.months === null ? (
            <span className="text-red-600">The payment doesn't cover the interest.</span>
          ) : (
            <>
              Paid off <strong>{monthYear(addMonths(plan.months))}</strong>{" "}
              <span className="text-slate-500">
                ({monthsLabel(plan.months)}, {formatMoney(plan.totalInterestCents)} interest)
              </span>
            </>
          )}
        </p>
      </div>
      {loan.principalInterestCents !== null && (
        <p className="mt-1 text-xs text-slate-500">
          At the {formatMoney(loan.principalInterestCents)} principal and interest part of the
          payment.
        </p>
      )}
      {plan.balances.length > 2 && (
        <div className="mt-2">
          <LineChart
            ariaLabel={`${loan.name} balance until paid off`}
            height={160}
            projectedFrom={1}
            points={shown.map((p) => ({
              date: String(p.m),
              label: addMonths(p.m).toLocaleDateString(undefined, {
                month: "short",
                year: "2-digit",
              }),
              value: p.b,
            }))}
          />
        </div>
      )}
      <label className="mt-3 block">
        <span className="flex items-baseline justify-between text-sm">
          <span className="text-slate-600 dark:text-slate-400">Pay extra each month</span>
          <span className="font-semibold tabular-nums">{formatMoney(extra * 100)}</span>
        </span>
        <input
          type="range"
          min={0}
          max={Math.max(500, Math.round((paying / 100) * 2))}
          step={10}
          value={extra}
          onChange={(e) => setExtra(Number(e.target.value))}
          className="mt-1 w-full accent-brand-600"
        />
      </label>
      {extra > 0 && base.months !== null && plan.months !== null && (
        <p className="mt-1 text-sm text-emerald-700 dark:text-emerald-400">
          {monthsLabel(base.months - plan.months)} sooner, {formatMoney(Math.max(0, saved ?? 0))}{" "}
          less interest.
        </p>
      )}
    </div>
  );
}

/** Mortgage insurance until 20% equity on the original value (like a servicer's "manage PMI"). */
function MortgageInsurance({ loan }: { loan: Loan }) {
  const p = loan.pmi;
  if (!p) return null;
  const toward = Math.min(100, (p.equityPct / 20) * 100);
  return (
    <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-700">
      <p className="text-sm font-semibold">Mortgage insurance</p>
      {p.monthlyCents !== null && (
        <p className="mt-1 text-sm">
          {formatMoney(p.monthlyCents)} monthly until you reach 20% equity
        </p>
      )}
      <div className="mt-3 flex items-center gap-2 text-xs text-slate-500">
        <span>0%</span>
        <div className="h-3 flex-1 overflow-hidden rounded bg-slate-300 dark:bg-slate-600">
          <div className="h-full bg-emerald-600" style={{ width: `${toward}%` }} />
        </div>
        <span>20%</span>
      </div>
      <p className="mt-1 text-xs">Currently at {p.equityPct.toFixed(1)}%</p>
      <p className="mt-3 rounded-lg bg-slate-50 p-3 text-sm text-slate-600 dark:bg-slate-800/50 dark:text-slate-300">
        {p.equityPct >= 20 ? (
          <>You've reached 20% equity: you can ask your lender to cancel it.</>
        ) : (
          <>
            Based on the original home value of{" "}
            <strong>{formatMoney(loan.originalValueCents ?? 0)}</strong>, you can ask to cancel it
            around <strong>{monthYear(p.requestDate)}</strong>
            {p.autoEndDate && (
              <>
                , and it ends on its own around <strong>{monthYear(p.autoEndDate)}</strong> (22%)
              </>
            )}
            . Paying extra toward principal gets you there sooner.
          </>
        )}
      </p>
    </div>
  );
}

function LoanCard({ loan }: { loan: Loan }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [fetching, setFetching] = useState<string | null>(null);
  const payments = showAll ? loan.payments : loan.payments.slice(0, 6);
  const tracked = loan.source === "manual" || loan.splitEstimated;
  const shared = loan.payments.some((p) => p.totalCents !== null);
  const mortgage = loan.principalInterestCents !== null;

  // Ask the lender (through Plaid) for the loan's terms.
  const getDetails = async () => {
    if (!loan.connectionId) return;
    setFetching("Opening…");
    try {
      const { linkToken } = await api.post<{ linkToken: string }>(
        `/api/connections/${loan.connectionId}/plaid/liabilities-token`,
      );
      if (await openPlaidLink(linkToken)) {
        setFetching("Syncing…");
        await linkApi.plaidReauthed(loan.connectionId);
        await qc.invalidateQueries({ queryKey: keys.accounts });
      }
      setFetching(null);
    } catch (e) {
      setFetching(e instanceof Error ? e.message : "Couldn't get them");
    }
  };

  const stats: [string, string, string | null][] = [
    ["Rate", pct(loan.aprBps), null],
    [
      "Payment",
      loan.monthlyPaymentCents ? `${formatMoney(loan.monthlyPaymentCents)}/mo` : "—",
      mortgage && loan.escrowCents !== null
        ? `${formatMoney(loan.principalInterestCents ?? 0)} principal & interest + ${formatMoney(loan.escrowCents)} escrow`
        : null,
    ],
    [
      "Minimum",
      money(loan.minimumPaymentCents),
      loan.minimumPaymentCents === null ? "Not reported" : null,
    ],
    ["Next due", day(loan.nextDueDate), null],
    [
      "Interest this year",
      money(loan.interestThisYearCents),
      loan.splitEstimated ? "Estimated" : null,
    ],
    ["Interest left", money(loan.interestRemainingCents), null],
  ];

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold">{loan.name}</h3>
          <p className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <span>
              {[LOAN_KIND_LABELS[loan.kind], loan.lender, loan.mask && `••${loan.mask}`]
                .filter(Boolean)
                .join(" · ")}
            </span>
            <span
              className={cx(
                "rounded px-1.5 py-0.5 text-[10px] font-medium",
                loan.connected
                  ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
                  : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
              )}
            >
              {loan.connected ? "Synced" : "Tracked from your payments"}
            </span>
          </p>
        </div>
        <div className="text-right">
          <p className="text-2xl font-semibold tabular-nums">{formatMoney(loan.balanceCents)}</p>
          <span className="flex flex-wrap justify-end gap-3 text-xs">
            {loan.connectionId && loan.aprBps === null && (
              <button
                type="button"
                onClick={() => void getDetails()}
                title="Ask the lender, through Plaid, for the rate, payment and due date"
                className="inline-flex items-center gap-1 text-brand-600 hover:underline dark:text-brand-500"
              >
                <Download aria-hidden="true" className="size-3" />
                {fetching ?? "Get details from your lender"}
              </button>
            )}
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="inline-flex items-center gap-1 text-brand-600 hover:underline dark:text-brand-500"
            >
              <Pencil aria-hidden="true" className="size-3" /> Edit details
            </button>
          </span>
        </div>
      </div>
      {loan.paidOffPct !== null && (
        <div className="mt-3">
          <div className="h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
            <div className="h-full bg-emerald-500" style={{ width: `${loan.paidOffPct}%` }} />
          </div>
          <p className="mt-1 text-xs text-slate-500">
            {Math.round(loan.paidOffPct)}% of {formatMoney(loan.originalPrincipalCents ?? 0)} paid
            off
          </p>
        </div>
      )}
      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3 lg:grid-cols-6">
        {stats.map(([k, v, sub]) => (
          <div key={k}>
            <dt className="text-xs text-slate-500">{k}</dt>
            <dd className="font-medium tabular-nums">{v}</dd>
            {sub && <dd className="text-xs text-slate-500">{sub}</dd>}
          </div>
        ))}
      </dl>
      {loan.property && (
        <p className="mt-3 text-sm">
          <Link
            to="/assets"
            className="font-medium text-brand-600 hover:underline dark:text-brand-500"
          >
            {loan.property.name}
          </Link>{" "}
          worth {formatMoney(loan.property.valueCents)} · your equity{" "}
          <strong>{formatMoney(loan.property.equityCents)}</strong>
          {loan.property.loanToValuePct !== null &&
            ` · ${loan.property.loanToValuePct.toFixed(0)}% loan-to-value`}
        </p>
      )}
      {loan.sharedWith.length > 0 && (
        <p className="mt-2 text-xs text-slate-500">
          Payments are shared with {loan.sharedWith.join(", ")}; this loan's part is in proportion
          to its monthly payment.
        </p>
      )}
      <div className="mt-5 grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <PayoffPlanner loan={loan} />
          <MortgageInsurance loan={loan} />
        </div>
        <div>
          <p className="mb-2 text-xs font-medium text-slate-500">
            Payments
            {loan.splitEstimated && " · interest and principal are estimates from today's balance"}
          </p>
          {loan.payments.length === 0 ? (
            <p className="text-sm text-slate-500">
              {loan.paymentMatch
                ? `No payments containing "${loan.paymentMatch}" found${loan.paymentAmountCents ? ` of about ${formatMoney(loan.paymentAmountCents)}` : ""}.`
                : "No payments found. Add the words your payments use (Edit details) so Muny can find them."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[30rem] text-sm">
                <thead className="text-xs text-slate-500">
                  <tr>
                    <th className="py-1 text-left font-medium">Date</th>
                    <th className="py-1 text-left font-medium">From</th>
                    <th className="py-1 text-right font-medium">Paid</th>
                    {mortgage && <th className="py-1 text-right font-medium">Escrow</th>}
                    {tracked && (
                      <>
                        <th className="py-1 text-right font-medium">Interest</th>
                        <th className="py-1 text-right font-medium">Principal</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {payments.map((p) => (
                    <tr key={p.transactionId}>
                      <td className="py-1.5 whitespace-nowrap">{day(p.date)}</td>
                      <td className="max-w-40 truncate py-1.5 text-slate-500" title={p.description}>
                        {p.fromAccountName}
                      </td>
                      <td className="py-1.5 text-right tabular-nums">
                        {formatMoney(p.amountCents)}
                        {p.totalCents !== null && (
                          <span className="block text-[11px] text-slate-500">
                            of {formatMoney(p.totalCents)}
                          </span>
                        )}
                      </td>
                      {mortgage && (
                        <td className="py-1.5 text-right tabular-nums text-slate-500">
                          {money(p.escrowCents)}
                        </td>
                      )}
                      {tracked && (
                        <>
                          <td className="py-1.5 text-right tabular-nums text-slate-500">
                            {money(p.interestCents)}
                          </td>
                          <td className="py-1.5 text-right tabular-nums">
                            {money(p.principalCents)}
                          </td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {loan.payments.length > 6 && (
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="mt-2 text-xs text-slate-500 underline"
            >
              {showAll ? "Show fewer" : `Show all ${loan.payments.length}`}
            </button>
          )}
          {shared && <p className="mt-2 text-xs text-slate-500">"of" is the whole payment.</p>}
        </div>
      </div>
      <Modal open={editing} onClose={() => setEditing(false)} title={`Edit ${loan.name}`}>
        {editing && <LoanForm loan={loan} onDone={() => setEditing(false)} />}
      </Modal>
    </Card>
  );
}

export function LoansPage() {
  const q = useQuery({ queryKey: loansKey, queryFn: () => api.get<LoansReport>("/api/loans") });
  const [adding, setAdding] = useState(false);
  const r = q.data;
  return (
    <>
      <PageHeader
        title="Loans"
        actions={
          <Button onClick={() => setAdding(true)}>
            <Plus aria-hidden="true" className="mr-1 inline size-4" /> Add a loan
          </Button>
        }
      />
      {q.error && <Alert>{q.error.message}</Alert>}
      {r && r.loans.length === 0 && (
        <Card className="text-center">
          <h2 className="text-lg font-semibold">No loans yet</h2>
          <p className="mx-auto mt-2 max-w-lg text-sm text-slate-600 dark:text-slate-400">
            Connect your lender on the Accounts page (student loans, mortgages and more come with
            their rate and due date), or add a loan Muny tracks from your payments.
          </p>
        </Card>
      )}
      {r && r.loans.length > 0 && (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Tile label="Total owed" value={formatMoney(r.totalOwedCents)} />
            <Tile label="Monthly payments" value={formatMoney(r.monthlyPaymentsCents)} />
            <Tile
              label="Next payment"
              value={r.nextDue ? day(r.nextDue.date) : "—"}
              sub={
                r.nextDue
                  ? `${r.nextDue.name}${r.nextDue.amountCents ? ` · ${formatMoney(r.nextDue.amountCents)}` : ""}`
                  : undefined
              }
            />
            <Tile
              label="Interest this year"
              value={formatMoney(r.loans.reduce((s, l) => s + (l.interestThisYearCents ?? 0), 0))}
            />
          </div>
          {r.loans.map((l) => (
            <LoanCard key={l.accountId} loan={l} />
          ))}
        </div>
      )}
      <Modal open={adding} onClose={() => setAdding(false)} title="Add a loan">
        {adding && <LoanForm onDone={() => setAdding(false)} />}
      </Modal>
    </>
  );
}

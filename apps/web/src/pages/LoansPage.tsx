import {
  type Asset,
  formatMoney,
  type LenderFee,
  type LenderFeeInput,
  type LenderPayment,
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
import { Download, Pencil, Plus, X } from "lucide-react";
import { type FormEvent, useState } from "react";
import { LineChart } from "../components/charts.js";
import { Modal } from "../components/forms.js";
import {
  ImportStatementsButton,
  StatementBadge,
  useStatementStatus,
} from "../components/StatementImporter.js";
import { Alert, Button, Card, cx, Field, PageHeader } from "../components/ui.js";
import { api } from "../lib/api.js";
import { openPlaidLink } from "../lib/bankWidgets.js";
import { keys, linkApi, useAccounts } from "../lib/queries.js";
import { LenderLoansForm, LenderPaymentsStrip } from "./loans/LenderLoans.js";
import { LoanLinkPaymentsButton } from "./loans/LoanStatementImport.js";
import { PayoffPlan } from "./loans/PayoffPlan.js";
import { StatementImportButton, StatementStatus } from "./loans/StatementImport.js";

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
  const payFrom = useAccounts();
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
    paidFrom: loan?.paymentFromAccountId ?? "",
    homeValue: fromCents(loan?.originalValueCents),
    pmi: fromCents(loan?.pmiMonthlyCents),
    property: loan?.propertyAccountId ?? "",
  });
  const [past, setPast] = useState<number[]>(loan?.pastPaymentAmounts ?? []);
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
      paymentFromAccountId: f.paidFrom || null,
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
      pastPaymentAmounts: past,
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
          hint="For a lender with several loans (or dues) paid separately under one name. If your payment changes, enter the new amount: earlier payments of the old amount still count."
        />
        <Select
          label="Paid from"
          value={f.paidFrom}
          onChange={(v) => setF((x) => ({ ...x, paidFrom: v }))}
        >
          <option value="">Any account</option>
          {(payFrom.data ?? [])
            .filter((a) => a.type !== "credit" && a.type !== "loan" && !a.hidden)
            .map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.mask ? ` ••${a.mask}` : ""}
              </option>
            ))}
        </Select>
        {past.length > 0 && (
          <div className="text-xs text-slate-500 sm:col-span-2">
            Earlier payment amounts still counted:{" "}
            {past.map((c) => (
              <span
                key={c}
                className="mr-1.5 inline-flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 tabular-nums dark:bg-slate-800"
              >
                {formatMoney(c)}
                <button
                  type="button"
                  aria-label={`Stop counting ${formatMoney(c)}`}
                  onClick={() => setPast((x) => x.filter((y) => y !== c))}
                  className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                >
                  <X aria-hidden="true" className="size-3" />
                </button>
              </span>
            ))}
          </div>
        )}
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

/** Each loan's payoff at today's payment (shared by the facts row and the planner). */
function basePlan(loan: Loan) {
  const paying = loan.principalInterestCents ?? loan.monthlyPaymentCents;
  if (loan.aprBps === null || !paying) return null;
  return { paying, plan: payoff(loan.balanceCents, loan.aprBps, paying) };
}

function PayoffPlanner({ loan }: { loan: Loan }) {
  const [extra, setExtra] = useState(0);
  const base = basePlan(loan);
  if (!base)
    return (
      <Section title="Payoff">
        <p className="text-sm text-slate-500">
          Add the interest rate and monthly payment (Edit details) to see when it's paid off and
          what paying extra would save.
        </p>
      </Section>
    );
  const plan = payoff(loan.balanceCents, loan.aprBps ?? 0, base.paying, extra * 100);
  const saved =
    base.plan.months !== null && plan.months !== null
      ? base.plan.totalInterestCents - plan.totalInterestCents
      : null;
  const step = plan.balances.length > 120 ? 3 : 1;
  // Past balances (after each payment), up to today's (the projection's start).
  const past = loan.history.slice(0, -1).slice(-24);
  const shown = plan.balances
    .map((b, m) => ({ b, m }))
    .filter((p) => p.m % step === 0 || p.m === plan.balances.length - 1);
  return (
    <Section
      title="Payoff"
      aside={
        plan.months === null ? (
          <span className="text-red-600">The payment doesn't cover the interest</span>
        ) : (
          <span>
            <strong>{monthYear(addMonths(plan.months))}</strong>{" "}
            <span className="text-slate-500">
              · {formatMoney(plan.totalInterestCents)} interest left
            </span>
          </span>
        )
      }
    >
      {plan.balances.length + past.length > 2 && (
        <LineChart
          ariaLabel={`${loan.name} balance: your payments, then until paid off`}
          height={210}
          projectedFrom={past.length}
          points={[
            ...past.map((h) => ({
              date: h.date,
              label: new Date(`${h.date}T00:00:00`).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
                year: "2-digit",
              }),
              value: h.balanceCents,
            })),
            ...shown.map((p) => ({
              date: String(p.m),
              label:
                p.m === 0
                  ? "Today"
                  : addMonths(p.m).toLocaleDateString(undefined, {
                      month: "short",
                      year: "2-digit",
                    }),
              value: p.b,
            })),
          ]}
        />
      )}
      {past.length > 0 && (
        <p className="mt-1 text-xs text-slate-500">
          Solid: after each payment since {day(past[0]?.date ?? null)}. Dashed: until paid off.
        </p>
      )}
      <label className="mt-3 block">
        <span className="flex items-baseline justify-between text-sm">
          <span className="text-slate-600 dark:text-slate-400">Pay extra each month</span>
          <span className="font-semibold tabular-nums">{formatMoney(extra * 100)}</span>
        </span>
        <input
          type="range"
          min={0}
          max={Math.max(500, Math.round((base.paying / 100) * 2))}
          step={10}
          value={extra}
          onChange={(e) => setExtra(Number(e.target.value))}
          className="mt-1 w-full accent-brand-600"
        />
      </label>
      <p className="mt-1 min-h-5 text-xs text-slate-500">
        {extra > 0 && base.plan.months !== null && plan.months !== null ? (
          <span className="text-sm text-emerald-700 dark:text-emerald-400">
            {monthsLabel(base.plan.months - plan.months)} sooner,{" "}
            {formatMoney(Math.max(0, saved ?? 0))} less interest.
          </span>
        ) : loan.principalInterestCents !== null ? (
          `Projected at the ${formatMoney(loan.principalInterestCents)} principal and interest part of the payment.`
        ) : null}
      </p>
    </Section>
  );
}

/** A lender's yearly fee (dues, maintenance): set once for the lender, not per loan. */
function FeeForm({
  lender,
  fee,
  words,
  onDone,
}: {
  lender: string;
  fee?: LenderFee;
  /** The lender's loans' payment words (used when the fee's own are left empty). */
  words: string | null;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    min: fromCents(fee?.minCents),
    match: fee?.paymentMatch ?? "",
    nextDue: fee?.nextDueDate ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF((x) => ({ ...x, [k]: e.target.value }));
  const done = async () => {
    await qc.invalidateQueries({ queryKey: keys.accounts });
    onDone();
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const min = toCents(f.min);
    if (min === null || Number.isNaN(min) || min <= 0) {
      setError("Enter the fee amount, like 2200.00.");
      return;
    }
    const body: LenderFeeInput = {
      lender,
      minCents: min,
      paymentMatch: f.match.trim() || null,
      nextDueDate: f.nextDue || null,
    };
    try {
      await api.put("/api/loans/lender-fees", body);
      await done();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save");
    }
  };
  const remove = async () => {
    try {
      await api.delete(`/api/loans/lender-fees?lender=${encodeURIComponent(lender)}`);
      await done();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't remove it");
    }
  };
  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      {error && <Alert>{error}</Alert>}
      <p className="text-sm text-slate-600 dark:text-slate-400">
        Dues or a maintenance fee {lender} charges once a year. Muny lists the payments and never
        counts them toward a loan. The amount can change from year to year.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Payments of at least"
          value={f.min}
          onChange={set("min")}
          inputMode="decimal"
          placeholder="2,200.00"
        />
        <Field
          label="Next due"
          type="date"
          value={f.nextDue}
          onChange={set("nextDue")}
          hint="If you know it."
        />
        <div className="sm:col-span-2">
          <Field
            label="Words in the fee payments"
            value={f.match}
            onChange={set("match")}
            placeholder={words ?? "e.g. SEAVIEW DUES"}
            hint={
              words
                ? `Leave empty to use the loans' words ("${words}").`
                : "How the fee appears in checking."
            }
          />
        </div>
      </div>
      <div className="flex justify-between gap-2">
        {fee ? (
          <Button variant="ghost" className="text-red-600" onClick={() => void remove()}>
            Remove
          </Button>
        ) : (
          <span />
        )}
        <span className="flex gap-2">
          <Button variant="secondary" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit">Save</Button>
        </span>
      </div>
    </form>
  );
}

/** The lender's yearly fee: the last one, when the next is due, a month's worth to set aside. */
function FeeStrip({
  lender,
  fee,
  words,
  showAdd,
}: {
  lender: string;
  fee: LenderFee | undefined;
  words: string | null;
  /** Offer to add one when there's none (lender cards). */
  showAdd?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const modal = (
    <Modal open={editing} onClose={() => setEditing(false)} title={`${lender} yearly fee`}>
      {editing && (
        <FeeForm lender={lender} fee={fee} words={words} onDone={() => setEditing(false)} />
      )}
    </Modal>
  );
  if (!fee)
    return showAdd ? (
      <div>
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="inline-flex items-center gap-1 text-xs text-brand-600 hover:underline dark:text-brand-500"
        >
          <Plus aria-hidden="true" className="size-3" /> Add a yearly fee (dues, maintenance)
        </button>
        {modal}
      </div>
    ) : null;
  const last = fee.fees[0];
  return (
    <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 rounded-xl bg-slate-50 px-4 py-3 text-sm dark:bg-slate-800/40">
      <span className="font-medium">Yearly fee</span>
      {last ? (
        <span>
          <span className="text-slate-500">Last </span>
          <strong className="tabular-nums">{formatMoney(last.amountCents)}</strong>
          <span className="text-slate-500"> on {day(last.date)}</span>
        </span>
      ) : (
        <span className="text-slate-500">
          No payments of {formatMoney(fee.minCents)} or more found yet
        </span>
      )}
      {fee.expectedDate && (
        <span>
          <span className="text-slate-500">{fee.nextDueDate ? "Next due " : "Next around "}</span>
          <strong>{fee.nextDueDate ? day(fee.expectedDate) : monthYear(fee.expectedDate)}</strong>
        </span>
      )}
      {last && (
        <span>
          <span className="text-slate-500">Set aside </span>
          <strong className="tabular-nums">{formatMoney(Math.round(last.amountCents / 12))}</strong>
          <span className="text-slate-500"> a month</span>
        </span>
      )}
      {fee.fees.length > 1 && (
        <span className="text-xs text-slate-500">
          Before:{" "}
          {fee.fees
            .slice(1)
            .map((x) => `${formatMoney(x.amountCents)} (${monthYear(x.date)})`)
            .join(", ")}
        </span>
      )}
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="ml-auto inline-flex items-center gap-1 text-xs text-brand-600 hover:underline dark:text-brand-500"
      >
        <Pencil aria-hidden="true" className="size-3" /> Edit
      </button>
      {modal}
    </div>
  );
}

/** A titled panel inside a loan card. */
function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2 text-sm">
        <h4 className="font-semibold">{title}</h4>
        {aside && <div className="text-sm">{aside}</div>}
      </div>
      {children}
    </section>
  );
}

/** Mortgage insurance until 20% equity on the original value (like a servicer's "manage PMI"). */
function MortgageInsurance({ loan }: { loan: Loan }) {
  const p = loan.pmi;
  if (!p) return null;
  const toward = Math.min(100, (p.equityPct / 20) * 100);
  return (
    <Section
      title="Mortgage insurance"
      aside={
        p.monthlyCents !== null ? (
          <span className="tabular-nums">{formatMoney(p.monthlyCents)}/mo</span>
        ) : undefined
      }
    >
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
          <div className="h-full rounded-full bg-emerald-500" style={{ width: `${toward}%` }} />
        </div>
        <span className="tabular-nums">{p.equityPct.toFixed(1)}% of 20% equity</span>
      </div>
      <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">
        {p.equityPct >= 20 ? (
          <>You've reached 20% equity: you can ask your lender to cancel it.</>
        ) : (
          <>
            You can ask to cancel it around <strong>{monthYear(p.requestDate)}</strong>
            {p.autoEndDate && (
              <>
                ; it ends on its own around <strong>{monthYear(p.autoEndDate)}</strong>
              </>
            )}
            .
          </>
        )}
      </p>
      <p className="mt-1 text-xs text-slate-500">
        Based on the original home value of {formatMoney(loan.originalValueCents ?? 0)}. Paying
        extra toward principal gets you there sooner.
      </p>
    </Section>
  );
}

/** The home this loan pays for: its value, your equity, and how much of it is borrowed. */
function HomeEquity({ loan }: { loan: Loan }) {
  const p = loan.property;
  if (!p) return null;
  const ltv = p.loanToValuePct;
  return (
    <Section
      title="Home equity"
      aside={
        <Link to="/assets" className="text-brand-600 hover:underline dark:text-brand-500">
          {p.name}
        </Link>
      }
    >
      <dl className="grid grid-cols-3 gap-3 text-sm">
        <div>
          <dt className="text-xs text-slate-500">Worth</dt>
          <dd className="font-semibold tabular-nums">{formatMoney(p.valueCents)}</dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">Your equity</dt>
          <dd className="font-semibold tabular-nums text-emerald-700 dark:text-emerald-400">
            {formatMoney(p.equityCents)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">Loan-to-value</dt>
          <dd className="font-semibold tabular-nums">
            {ltv === null ? "—" : `${ltv.toFixed(0)}%`}
          </dd>
        </div>
      </dl>
      {ltv !== null && (
        <div
          className="mt-3 flex h-2.5 overflow-hidden rounded-full bg-emerald-500"
          title={`Owed ${Math.round(ltv)}%, yours ${Math.round(100 - ltv)}%`}
        >
          <div
            className="h-full bg-slate-400 dark:bg-slate-500"
            style={{ width: `${Math.min(100, ltv)}%` }}
          />
        </div>
      )}
      <p className="mt-1 flex justify-between text-xs text-slate-500">
        <span>Owed</span>
        <span>Yours</span>
      </p>
    </Section>
  );
}

/** Where the latest payment went: principal, interest, escrow. */
function LastPaymentSplit({ loan }: { loan: Loan }) {
  const p = loan.payments[0];
  if (!p || p.interestCents === null || p.principalCents === null) return null;
  const parts = [
    { label: "Principal", cents: p.principalCents, color: "bg-emerald-500" },
    { label: "Interest", cents: p.interestCents, color: "bg-amber-500" },
    ...(p.escrowCents ? [{ label: "Escrow", cents: p.escrowCents, color: "bg-slate-400" }] : []),
  ];
  const total = parts.reduce((s, x) => s + x.cents, 0) || 1;
  return (
    <div>
      <p className="mb-1.5 text-xs text-slate-500">
        Your last payment ({day(p.date)}){loan.splitEstimated ? ", estimated" : ""}
      </p>
      <div className="flex h-2.5 overflow-hidden rounded-full">
        {parts.map((x) => (
          <div key={x.label} className={x.color} style={{ width: `${(x.cents / total) * 100}%` }} />
        ))}
      </div>
      <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {parts.map((x) => (
          <li key={x.label} className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className={cx("size-2 rounded-sm", x.color)} />
            <span className="text-slate-500">{x.label}</span>
            <span className="font-medium tabular-nums">{formatMoney(x.cents)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Payments({ loan }: { loan: Loan }) {
  const split = loan.payments.some((p) => p.interestCents !== null);
  const escrow = loan.principalInterestCents !== null;
  const shared = loan.payments.some((p) => p.totalCents !== null);
  return (
    <Section
      title={`Payments${loan.payments.length ? ` (${loan.payments.length})` : ""}`}
      aside={
        <span className="flex flex-wrap items-baseline gap-x-3">
          {loan.splitEstimated && (
            <span className="text-xs text-slate-500">Interest and principal are estimates</span>
          )}
          <LoanLinkPaymentsButton loan={loan} />
        </span>
      }
    >
      {loan.payments.length === 0 ? (
        <p className="text-sm text-slate-500">
          {loan.paymentMatch
            ? `No payments containing "${loan.paymentMatch}" found${loan.paymentAmountCents ? ` of about ${formatMoney(loan.paymentAmountCents)}` : ""}.`
            : "No payments found. Add the words your payments use (Edit details) so Muny can find them."}
        </p>
      ) : (
        <div className="max-h-72 overflow-auto">
          <table className="w-full min-w-[32rem] text-sm">
            <thead className="sticky top-0 bg-white text-xs text-slate-500 dark:bg-slate-900">
              <tr>
                <th className="py-1.5 text-left font-medium">Date</th>
                <th className="py-1.5 text-left font-medium">From</th>
                <th className="py-1.5 text-right font-medium">Paid</th>
                {split && <th className="py-1.5 text-right font-medium">Principal</th>}
                {split && <th className="py-1.5 text-right font-medium">Interest</th>}
                {escrow && <th className="py-1.5 text-right font-medium">Escrow</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {loan.payments.map((p) => (
                <tr key={p.transactionId}>
                  <td className="py-2 whitespace-nowrap">{day(p.date)}</td>
                  <td className="max-w-48 truncate py-2 text-slate-500" title={p.description}>
                    {p.fromAccountName}
                  </td>
                  <td className="py-2 text-right font-medium tabular-nums">
                    {formatMoney(p.amountCents)}
                    {p.totalCents !== null && (
                      <span className="block text-[11px] font-normal text-slate-500">
                        of {formatMoney(p.totalCents)}
                      </span>
                    )}
                  </td>
                  {split && (
                    <td className="py-2 text-right tabular-nums">{money(p.principalCents)}</td>
                  )}
                  {split && (
                    <td className="py-2 text-right tabular-nums text-slate-500">
                      {money(p.interestCents)}
                    </td>
                  )}
                  {escrow && (
                    <td className="py-2 text-right tabular-nums text-slate-500">
                      {money(p.escrowCents)}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {shared && (
        <p className="mt-2 text-xs text-slate-500">
          Shared with {loan.sharedWith.join(", ")}: "of" is the whole payment.
        </p>
      )}
    </Section>
  );
}

function LoanCard({
  loan,
  embedded = false,
  fee,
  viaLender = false,
}: {
  loan: Loan;
  embedded?: boolean;
  /** Paid through the lender's payments (split by set parts). */
  viaLender?: boolean;
  /** The lender's yearly fee (lone loans; a lender's group card shows it once). */
  fee?: LenderFee;
}) {
  const qc = useQueryClient();
  const statements = useStatementStatus();
  const [editing, setEditing] = useState(false);
  const [addingFee, setAddingFee] = useState(false);
  const canAddFee = !embedded && !fee && !!loan.lender && loan.kind !== "mortgage";
  const [fetching, setFetching] = useState<string | null>(null);
  const base = basePlan(loan);

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

  const minimumDiffers =
    loan.minimumPaymentCents !== null && loan.minimumPaymentCents !== loan.monthlyPaymentCents;
  const facts: { label: string; value: string; sub?: string | null }[] = [
    { label: "Rate", value: pct(loan.aprBps) },
    {
      label: "Monthly payment",
      value: money(loan.monthlyPaymentCents),
      sub: minimumDiffers ? `Minimum ${formatMoney(loan.minimumPaymentCents ?? 0)}` : null,
    },
    {
      label: "Next due",
      value: day(loan.nextDueDate),
      sub:
        loan.nextDueDate &&
        new Date(`${loan.nextDueDate}T00:00:00`).getTime() - Date.now() > 45 * 86_400_000
          ? "Paid ahead: regular payments go elsewhere until then"
          : null,
    },
    {
      label: "Paid off",
      value: base?.plan.months != null ? monthYear(addMonths(base.plan.months)) : "—",
      sub: base?.plan.months != null ? monthsLabel(base.plan.months) : null,
    },
    {
      label: "Interest this year",
      value: money(loan.interestThisYearCents),
      sub: loan.splitEstimated ? "Estimated" : null,
    },
  ];
  const side = loan.property || loan.pmi;
  // Mortgages (and loans tied to a home) get the full layout; others a compact one.
  const full = loan.kind === "mortgage" || !!side;
  const Wrap = embedded ? "div" : Card;

  return (
    <Wrap className={full ? "space-y-5" : "space-y-4"}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex flex-wrap items-center gap-2 text-lg font-semibold">
            {loan.name}
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
          </h3>
          <p className="text-xs text-slate-500">
            {[LOAN_KIND_LABELS[loan.kind], loan.lender, loan.mask && `••${loan.mask}`]
              .filter(Boolean)
              .join(" · ")}
          </p>
          <StatementBadge status={statements.data?.get(loan.accountId)} className="block" />
        </div>
        <div className="text-right">
          <p className="text-xs text-slate-500">Owed</p>
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
            {loan.kind === "student" ? (
              !embedded &&
              !loan.connected &&
              loan.lender && <StatementImportButton lender={loan.lender} loans={[loan]} />
            ) : (
              <ImportStatementsButton
                forAccount={{ id: loan.accountId, name: loan.name, type: "loan" }}
                variant="link"
              />
            )}
            {canAddFee && (
              <button
                type="button"
                onClick={() => setAddingFee(true)}
                title="Dues or a maintenance fee the lender charges once a year"
                className="inline-flex items-center gap-1 text-brand-600 hover:underline dark:text-brand-500"
              >
                <Plus aria-hidden="true" className="size-3" /> Yearly fee
              </button>
            )}
          </span>
        </div>
      </div>

      {loan.paidOffPct !== null && (
        <div>
          <div className="h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
            <div
              className="h-full rounded-full bg-emerald-500"
              style={{ width: `${loan.paidOffPct}%` }}
            />
          </div>
          <p className="mt-1 flex justify-between text-xs text-slate-500">
            <span>{Math.round(loan.paidOffPct)}% paid off</span>
            <span className="tabular-nums">
              {formatMoney(Math.max(0, (loan.originalPrincipalCents ?? 0) - loan.balanceCents))} of{" "}
              {formatMoney(loan.originalPrincipalCents ?? 0)}
            </span>
          </p>
        </div>
      )}

      <dl
        className={
          full
            ? "grid grid-cols-2 divide-slate-200 overflow-hidden rounded-xl border border-slate-200 sm:grid-cols-3 lg:grid-cols-5 lg:divide-x dark:divide-slate-800 dark:border-slate-800"
            : "flex flex-wrap gap-x-8 gap-y-2"
        }
      >
        {facts.map((f) => (
          <div key={f.label} className={full ? "px-4 py-3" : ""}>
            <dt className="text-xs text-slate-500">{f.label}</dt>
            <dd className="mt-0.5 font-semibold tabular-nums">{f.value}</dd>
            {f.sub && <dd className="text-xs text-slate-500">{f.sub}</dd>}
          </div>
        ))}
      </dl>

      {(loan.principalInterestCents !== null || loan.payments[0]?.interestCents != null) && (
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <LastPaymentSplit loan={loan} />
          {loan.principalInterestCents !== null && loan.escrowCents !== null && (
            <p className="text-xs text-slate-500 sm:text-right">
              Each payment: {formatMoney(loan.principalInterestCents)} principal & interest +{" "}
              {formatMoney(loan.escrowCents)} escrow
            </p>
          )}
        </div>
      )}

      {loan.sharedWith.length > 0 && (
        <p className="text-xs text-slate-500">
          {viaLender
            ? `Paid together with ${loan.sharedWith.join(", ")}: this loan's part of each payment is set under Payments on the lender's card.`
            : `Payments are shared with ${loan.sharedWith.join(", ")}; this loan's part is in proportion to its monthly payment.`}
        </p>
      )}

      {full ? (
        <>
          <div className={cx("grid gap-4", side && "lg:grid-cols-2")}>
            <PayoffPlanner loan={loan} />
            {side && (
              <div className="space-y-4">
                <HomeEquity loan={loan} />
                <MortgageInsurance loan={loan} />
              </div>
            )}
          </div>
          <Payments loan={loan} />
        </>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <PayoffPlanner loan={loan} />
          <Payments loan={loan} />
        </div>
      )}

      {!embedded && loan.lender && (
        <FeeStrip lender={loan.lender} fee={fee} words={loan.paymentMatch} />
      )}

      <Modal open={editing} onClose={() => setEditing(false)} title={`Edit ${loan.name}`}>
        {editing && <LoanForm loan={loan} onDone={() => setEditing(false)} />}
      </Modal>
      {canAddFee && loan.lender && (
        <Modal
          open={addingFee}
          onClose={() => setAddingFee(false)}
          title={`${loan.lender} yearly fee`}
        >
          {addingFee && (
            <FeeForm
              lender={loan.lender}
              words={loan.paymentMatch}
              onDone={() => setAddingFee(false)}
            />
          )}
        </Modal>
      )}
    </Wrap>
  );
}

/** Several loans from one lender (e.g. a timeshare's loans): one card, a tab per loan. */
function LenderGroup({
  lender,
  loans,
  fee,
  payments,
  servicer,
}: {
  lender: string;
  loans: Loan[];
  fee: LenderFee | undefined;
  /** Payments covering several of these loans. */
  payments: LenderPayment[];
  /** Split like the servicer does (from statements). */
  servicer: boolean;
}) {
  const [sel, setSel] = useState(loans[0]?.accountId ?? "");
  const loan = loans.find((l) => l.accountId === sel) ?? loans[0];
  if (!loan) return null;
  const owed = loans.reduce((s, l) => s + l.balanceCents, 0);
  const monthly = loans.reduce((s, l) => s + (l.monthlyPaymentCents ?? 0), 0);
  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold">{lender}</h3>
          <p className="text-xs text-slate-500">
            {loans.length} loans · {formatMoney(monthly)} a month together
          </p>
        </div>
        <div className="text-right">
          <p className="text-xs text-slate-500">Owed in all</p>
          <p className="text-2xl font-semibold tabular-nums">{formatMoney(owed)}</p>
          {loans.some((l) => l.kind === "student" && !l.connected) && (
            <StatementImportButton lender={lender} loans={loans} />
          )}
        </div>
      </div>
      <div
        role="tablist"
        className="flex flex-wrap gap-1 border-b border-slate-200 dark:border-slate-800"
      >
        {loans.map((l) => (
          <button
            key={l.accountId}
            type="button"
            role="tab"
            aria-selected={l.accountId === loan.accountId}
            onClick={() => setSel(l.accountId)}
            className={cx(
              "-mb-px border-b-2 px-3 py-2 text-left text-sm",
              l.accountId === loan.accountId
                ? "border-brand-600 font-medium text-brand-700 dark:text-brand-500"
                : "border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200",
            )}
          >
            {l.name}
            <span className="block text-xs font-normal tabular-nums text-slate-500">
              {formatMoney(l.balanceCents)}
              {l.monthlyPaymentCents ? ` · ${formatMoney(l.monthlyPaymentCents)}/mo` : ""}
            </span>
          </button>
        ))}
      </div>
      <LoanCard
        key={loan.accountId}
        loan={loan}
        embedded
        viaLender={payments.some((p) => loan.accountId in p.parts)}
      />
      <StatementStatus loans={loans} />
      <LenderPaymentsStrip lender={lender} loans={loans} payments={payments} servicer={servicer} />
      <FeeStrip
        lender={lender}
        fee={fee}
        words={loans.find((l) => l.paymentMatch)?.paymentMatch ?? null}
        showAdd
      />
    </Card>
  );
}

/** Mortgages and lone loans get their own card; other lenders with several loans are grouped. */
function groupLoans(
  loans: Loan[],
): ({ kind: "one"; loan: Loan } | { kind: "group"; lender: string; loans: Loan[] })[] {
  const byLender = new Map<string, Loan[]>();
  for (const l of loans) {
    if (l.kind === "mortgage" || !l.lender) continue;
    const k = l.lender.trim().toLowerCase();
    byLender.set(k, [...(byLender.get(k) ?? []), l]);
  }
  const out: ReturnType<typeof groupLoans> = [];
  const done = new Set<string>();
  for (const l of loans) {
    const k = l.lender?.trim().toLowerCase() ?? "";
    const group = l.kind !== "mortgage" && k ? byLender.get(k) : undefined;
    if (group && group.length > 1) {
      if (done.has(k)) continue;
      done.add(k);
      out.push({ kind: "group", lender: l.lender ?? "", loans: group });
    } else out.push({ kind: "one", loan: l });
  }
  return out;
}

const TABS = [
  ["loans", "Loans"],
  ["plan", "Payoff plan"],
] as const;
type Tab = (typeof TABS)[number][0];

export function LoansPage() {
  const q = useQuery({ queryKey: loansKey, queryFn: () => api.get<LoansReport>("/api/loans") });
  const [adding, setAdding] = useState(false);
  const [addMode, setAddMode] = useState<"one" | "several">("one");
  const [tab, setTab] = useState<Tab>(() => (window.location.hash === "#plan" ? "plan" : "loans"));
  const r = q.data;
  const feeFor = (lender: string | null) =>
    r?.lenderFees.find((x) => x.lenderKey === lender?.trim().toLowerCase());
  return (
    <>
      <PageHeader
        title="Loans"
        actions={
          <span className="flex flex-wrap gap-2">
            <ImportStatementsButton defaultType="loan" />
            <Button onClick={() => setAdding(true)}>
              <Plus aria-hidden="true" className="mr-1 inline size-4" /> Add a loan
            </Button>
          </span>
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
        <div
          role="tablist"
          className="mb-6 flex gap-1 border-b border-slate-200 dark:border-slate-800"
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
                "-mb-px border-b-2 px-3 py-2 text-sm font-medium",
                tab === k
                  ? "border-brand-600 text-brand-700 dark:text-brand-500"
                  : "border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {r && r.loans.length > 0 && tab === "plan" && <PayoffPlan report={r} />}
      {r && r.loans.length > 0 && tab === "loans" && (
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
          {groupLoans(r.loans).map((g) =>
            g.kind === "one" ? (
              <LoanCard key={g.loan.accountId} loan={g.loan} fee={feeFor(g.loan.lender)} />
            ) : (
              <LenderGroup
                key={g.lender}
                lender={g.lender}
                loans={g.loans}
                fee={feeFor(g.lender)}
                payments={(r.lenderPayments ?? []).filter(
                  (x) => x.lenderKey === g.lender.trim().toLowerCase(),
                )}
                servicer={(r.servicerLenders ?? []).includes(g.lender.trim().toLowerCase())}
              />
            ),
          )}
        </div>
      )}
      <Modal
        open={adding}
        onClose={() => setAdding(false)}
        title={addMode === "several" ? "Add loans from one lender" : "Add a loan"}
        wide={addMode === "several"}
      >
        {adding && (
          <>
            <div className="mb-4 inline-flex rounded-lg border border-slate-200 p-0.5 text-sm dark:border-slate-800">
              {(
                [
                  ["one", "One loan"],
                  ["several", "Several from one lender"],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={addMode === k}
                  onClick={() => setAddMode(k)}
                  className={cx(
                    "rounded-md px-3 py-1",
                    addMode === k
                      ? "bg-brand-600 text-white"
                      : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            {addMode === "one" ? (
              <LoanForm onDone={() => setAdding(false)} />
            ) : (
              <LenderLoansForm onDone={() => setAdding(false)} />
            )}
          </>
        )}
      </Modal>
    </>
  );
}

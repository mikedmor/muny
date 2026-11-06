import {
  type CreateLenderLoansInput,
  formatMoney,
  type LenderPayment,
  type LenderPaymentInput,
  LOAN_KIND_LABELS,
  LOAN_KINDS,
  type Loan,
  type LoanKind,
} from "@muny/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Copy, Pencil, Plus, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Modal } from "../../components/forms.js";
import { Alert, Button, Field } from "../../components/ui.js";
import { api } from "../../lib/api.js";
import { keys } from "../../lib/queries.js";

/**
 * Several loans from one lender, paid together: e.g. student loans in groups
 * AA-AE paid by two scheduled payments, each applied across some of them.
 * Each payment lists what it puts toward each loan (from the servicer's
 * payment details); Muny finds it by its words, total and day, and splits it.
 */

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
const fromCents = (c: number | null | undefined) => (c == null ? "" : (c / 100).toFixed(2));
const ordinal = (n: number) => {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
};

let seq = 0;
const nextKey = () => `k${++seq}`;

interface PaymentDraft {
  key: string;
  dueDay: string;
  words: string;
  /** YYYY-MM-DD or "": only payments from / until these dates. */
  from: string;
  until: string;
  /** Loan key → dollars typed. */
  parts: Record<string, string>;
}
const emptyPayment = (): PaymentDraft => ({
  key: nextKey(),
  dueDay: "",
  words: "",
  from: "",
  until: "",
  parts: {},
});
const shortDate = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
/** The day before a date (the old split ends when the new one starts). */
const dayBefore = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

/** Parse drafts: payments with parts by loan key, or an error. */
function parsePayments(
  drafts: PaymentDraft[],
): { ok: true; payments: LenderPaymentInput[] } | { ok: false; error: string } {
  const payments: LenderPaymentInput[] = [];
  for (const [i, d] of drafts.entries()) {
    const parts: Record<string, number> = {};
    for (const [k, v] of Object.entries(d.parts)) {
      const c = toCents(v);
      if (c === null || c === 0) continue;
      if (Number.isNaN(c)) return { ok: false, error: `Payment ${i + 1}: check the amounts.` };
      parts[k] = c;
    }
    if (!Object.keys(parts).length) continue;
    const day = d.dueDay.trim() ? Number(d.dueDay) : null;
    if (day !== null && !(Number.isInteger(day) && day >= 1 && day <= 31))
      return { ok: false, error: `Payment ${i + 1}: the day is a number from 1 to 31.` };
    if (d.from && d.until && d.until < d.from)
      return { ok: false, error: `Payment ${i + 1}: "Until" is before "From".` };
    payments.push({
      dueDay: day,
      paymentMatch: d.words.trim() || null,
      startDate: d.from || null,
      endDate: d.until || null,
      parts,
    });
  }
  return { ok: true, payments };
}

/** Each payment: the day, and what it puts toward each loan. */
function PaymentsEditor({
  loans,
  value,
  onChange,
  words,
}: {
  loans: { key: string; name: string }[];
  value: PaymentDraft[];
  onChange: (v: PaymentDraft[]) => void;
  words: string | null;
}) {
  const set = (key: string, patch: Partial<PaymentDraft>) =>
    onChange(value.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  return (
    <div className="space-y-3">
      {value.map((p, i) => {
        const total = Object.values(p.parts).reduce((t, v) => {
          const c = toCents(v);
          return t + (c && !Number.isNaN(c) ? c : 0);
        }, 0);
        return (
          <div
            key={p.key}
            className="space-y-3 rounded-xl border border-slate-200 p-3 dark:border-slate-800"
          >
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="font-medium">
                Payment {i + 1}
                {total > 0 && (
                  <span className="ml-2 font-normal text-slate-500 tabular-nums">
                    {formatMoney(total)}
                    {p.dueDay && /^\d+$/.test(p.dueDay)
                      ? ` around the ${ordinal(Number(p.dueDay))}`
                      : ""}
                  </span>
                )}
              </span>
              <span className="flex items-center gap-3">
                <button
                  type="button"
                  title="The servicer changed how it splits this payment: keep this one for earlier payments and start a copy from a date"
                  onClick={() => {
                    const start = new Date().toISOString().slice(0, 10);
                    const copy = { ...p, key: nextKey(), from: start, until: p.until };
                    onChange(
                      value.flatMap((x) =>
                        x.key === p.key ? [{ ...x, until: dayBefore(start) }, copy] : [x],
                      ),
                    );
                  }}
                  className="inline-flex items-center gap-1 text-xs text-brand-600 hover:underline dark:text-brand-500"
                >
                  <Copy aria-hidden="true" className="size-3" /> Split changed
                </button>
                <button
                  type="button"
                  aria-label={`Remove payment ${i + 1}`}
                  onClick={() => onChange(value.filter((x) => x.key !== p.key))}
                  className="text-slate-400 hover:text-red-600"
                >
                  <Trash2 aria-hidden="true" className="size-4" />
                </button>
              </span>
            </div>
            <div className="grid gap-3 sm:grid-cols-[7rem_minmax(0,1fr)_9.5rem_9.5rem]">
              <Field
                label="Day of the month"
                value={p.dueDay}
                onChange={(e) => set(p.key, { dueDay: e.target.value })}
                inputMode="numeric"
                placeholder="28"
              />
              <Field
                label="Words, if different"
                value={p.words}
                onChange={(e) => set(p.key, { words: e.target.value })}
                placeholder={words ?? "How it appears in checking"}
              />
              <Field
                label="From"
                type="date"
                value={p.from}
                onChange={(e) => set(p.key, { from: e.target.value })}
              />
              <Field
                label="Until"
                type="date"
                value={p.until}
                onChange={(e) => set(p.key, { until: e.target.value })}
              />
            </div>
            <div>
              <p className="text-xs text-slate-500">
                What it puts toward each loan (leave empty for loans it doesn't cover):
              </p>
              <div className="mt-2 grid gap-2 sm:grid-cols-3">
                {loans.map((l) => (
                  <label key={l.key} className="block text-xs">
                    <span className="block truncate text-slate-600 dark:text-slate-400">
                      {l.name}
                    </span>
                    <input
                      value={p.parts[l.key] ?? ""}
                      onChange={(e) =>
                        set(p.key, { parts: { ...p.parts, [l.key]: e.target.value } })
                      }
                      inputMode="decimal"
                      placeholder="0.00"
                      className="mt-0.5 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm tabular-nums dark:border-slate-700 dark:bg-slate-950"
                    />
                  </label>
                ))}
              </div>
            </div>
          </div>
        );
      })}
      <button
        type="button"
        onClick={() => onChange([...value, emptyPayment()])}
        className="inline-flex items-center gap-1 text-sm text-brand-600 hover:underline dark:text-brand-500"
      >
        <Plus aria-hidden="true" className="size-4" /> Add a payment
      </button>
    </div>
  );
}

interface LoanRow {
  key: string;
  name: string;
  balance: string;
  apr: string;
}
const emptyRow = (): LoanRow => ({ key: nextKey(), name: "", balance: "", apr: "" });

/** Add several loans from one lender, and the payments that cover them. */
export function LenderLoansForm({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const [lender, setLender] = useState("");
  const [kind, setKind] = useState<LoanKind>("student");
  const [words, setWords] = useState("");
  const [asOf, setAsOf] = useState(new Date().toISOString().slice(0, 10));
  const [rows, setRows] = useState<LoanRow[]>([emptyRow(), emptyRow()]);
  const [payments, setPayments] = useState<PaymentDraft[]>([emptyPayment()]);
  const [error, setError] = useState<string | null>(null);
  const setRow = (key: string, patch: Partial<LoanRow>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!lender.trim()) return setError("Name the lender.");
    const loans = rows.filter((r) => r.name.trim() || r.balance.trim());
    if (!loans.length) return setError("Add at least one loan.");
    const parsed: CreateLenderLoansInput["loans"] = [];
    for (const r of loans) {
      const balance = toCents(r.balance);
      const apr = toBps(r.apr);
      if (!r.name.trim() || balance === null || Number.isNaN(balance) || Number.isNaN(apr))
        return setError("Give each loan a name, what you owe, and its rate (like 4.25).");
      parsed.push({ name: r.name.trim(), startBalanceCents: balance, aprBps: apr });
    }
    const pays = parsePayments(payments);
    if (!pays.ok) return setError(pays.error);
    // Parts by the loan's index.
    const index = new Map(loans.map((r, i) => [r.key, String(i)]));
    const body: CreateLenderLoansInput = {
      lender: lender.trim(),
      kind,
      paymentMatch: words.trim() || null,
      startDate: asOf || null,
      loans: parsed,
      payments: pays.payments.map((p) => ({
        ...p,
        parts: Object.fromEntries(
          Object.entries(p.parts)
            .filter(([k]) => index.has(k))
            .map(([k, c]) => [index.get(k) as string, c]),
        ),
      })),
    };
    try {
      await api.post("/api/loans/batch", body);
      await qc.invalidateQueries({ queryKey: keys.accounts });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't add them");
    }
  };

  const named = rows.map((r, i) => ({ key: r.key, name: r.name.trim() || `Loan ${i + 1}` }));
  return (
    <form onSubmit={submit} className="space-y-5" noValidate>
      {error && <Alert>{error}</Alert>}
      <p className="text-sm text-slate-600 dark:text-slate-400">
        For a lender with several loans, like student loans in groups, paid by one or more payments
        that each cover some of them. They share one card on the Loans page.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Lender"
          value={lender}
          onChange={(e) => setLender(e.target.value)}
          placeholder="e.g. Nelnet"
        />
        <label className="block text-sm">
          <span className="font-medium text-slate-700 dark:text-slate-300">Kind</span>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as LoanKind)}
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-950"
          >
            {LOAN_KINDS.map((k) => (
              <option key={k} value={k}>
                {LOAN_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
        <Field
          label="Words in your payments"
          value={words}
          onChange={(e) => setWords(e.target.value)}
          placeholder="e.g. DEPT EDUCATION"
          hint="How the payments appear in checking."
        />
        <Field
          label="Balances as of"
          type="date"
          value={asOf}
          onChange={(e) => setAsOf(e.target.value)}
          hint="The date of the balances below."
        />
      </div>

      <div>
        <h3 className="text-sm font-semibold">Loans</h3>
        <div className="mt-2 space-y-2">
          {rows.map((r, i) => (
            <div
              key={r.key}
              className="grid grid-cols-[minmax(0,2fr)_minmax(0,1.3fr)_5.5rem_auto] items-end gap-2"
            >
              <Field
                label={i === 0 ? "Name" : ""}
                aria-label={`Loan ${i + 1} name`}
                value={r.name}
                onChange={(e) => setRow(r.key, { name: e.target.value })}
                placeholder={`e.g. Group ${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`}
              />
              <Field
                label={i === 0 ? "What you owe" : ""}
                aria-label={`Loan ${i + 1}: what you owe`}
                value={r.balance}
                onChange={(e) => setRow(r.key, { balance: e.target.value })}
                inputMode="decimal"
                placeholder="1,234.56"
              />
              <Field
                label={i === 0 ? "Rate %" : ""}
                aria-label={`Loan ${i + 1}: rate`}
                value={r.apr}
                onChange={(e) => setRow(r.key, { apr: e.target.value })}
                inputMode="decimal"
                placeholder="4.25"
              />
              <button
                type="button"
                aria-label={`Remove loan ${i + 1}`}
                disabled={rows.length === 1}
                onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
                className="mb-2 text-slate-400 hover:text-red-600 disabled:opacity-30"
              >
                <Trash2 aria-hidden="true" className="size-4" />
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setRows((rs) => [...rs, emptyRow()])}
          className="mt-2 inline-flex items-center gap-1 text-sm text-brand-600 hover:underline dark:text-brand-500"
        >
          <Plus aria-hidden="true" className="size-4" /> Add a loan
        </button>
        <p className="mt-1 text-xs text-slate-500">
          For student loans, use the effective rate (after any autopay discount).
        </p>
      </div>

      <div>
        <h3 className="text-sm font-semibold">How you pay them</h3>
        <p className="mt-1 mb-2 text-xs text-slate-500">
          One entry per scheduled payment. From your servicer's payment details, copy what each
          payment applied to each loan (the total applied, principal and interest together). A loan
          paid on its own is a payment with just that loan.
        </p>
        <PaymentsEditor
          loans={named}
          value={payments}
          onChange={setPayments}
          words={words.trim() || null}
        />
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit">Add loans</Button>
      </div>
    </form>
  );
}

/** Edit a lender's payments for loans already added. */
function LenderPaymentsForm({
  lender,
  loans,
  payments,
  onDone,
}: {
  lender: string;
  loans: Loan[];
  payments: LenderPayment[];
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [drafts, setDrafts] = useState<PaymentDraft[]>(() =>
    payments.length
      ? payments.map((p) => ({
          key: nextKey(),
          dueDay: p.dueDay ? String(p.dueDay) : "",
          from: p.startDate ?? "",
          until: p.endDate ?? "",
          words: p.paymentMatch ?? "",
          parts: Object.fromEntries(Object.entries(p.parts).map(([id, c]) => [id, fromCents(c)])),
        }))
      : [emptyPayment()],
  );
  const [error, setError] = useState<string | null>(null);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const pays = parsePayments(drafts);
    if (!pays.ok) return setError(pays.error);
    try {
      await api.put("/api/loans/lender-payments", { lender, payments: pays.payments });
      await qc.invalidateQueries({ queryKey: keys.accounts });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save");
    }
  };
  return (
    <form onSubmit={save} className="space-y-4" noValidate>
      {error && <Alert>{error}</Alert>}
      <p className="text-sm text-slate-600 dark:text-slate-400">
        One entry per scheduled payment, with what it puts toward each loan. Muny finds each payment
        by its words, its total and the day, and splits it by these amounts. Loans in a payment here
        get their payments only from these. If your servicer changes how it splits a payment (say a
        loan stops getting a share), click Split changed: the old split keeps the earlier payments,
        and you set the new one from the date it changed.
      </p>
      <PaymentsEditor
        loans={loans.map((l) => ({ key: l.accountId, name: l.name }))}
        value={drafts}
        onChange={setDrafts}
        words={loans.find((l) => l.paymentMatch)?.paymentMatch ?? null}
      />
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit">Save</Button>
      </div>
    </form>
  );
}

/** On a lender's card: the payments that cover several of its loans. */
export function LenderPaymentsStrip({
  lender,
  loans,
  payments,
}: {
  lender: string;
  loans: Loan[];
  payments: LenderPayment[];
}) {
  const [editing, setEditing] = useState(false);
  const name = new Map(loans.map((l) => [l.accountId, l.name]));
  const modal = (
    <Modal open={editing} onClose={() => setEditing(false)} title={`${lender} payments`} wide>
      {editing && (
        <LenderPaymentsForm
          lender={lender}
          loans={loans}
          payments={payments}
          onDone={() => setEditing(false)}
        />
      )}
    </Modal>
  );
  if (!payments.length)
    return (
      <div>
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="inline-flex items-center gap-1 text-xs text-brand-600 hover:underline dark:text-brand-500"
        >
          <Plus aria-hidden="true" className="size-3" /> Set up payments that cover several of these
          loans
        </button>
        {modal}
      </div>
    );
  return (
    <div className="rounded-xl bg-slate-50 px-4 py-3 text-sm dark:bg-slate-800/40">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-medium">Payments</span>
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="inline-flex items-center gap-1 text-xs text-brand-600 hover:underline dark:text-brand-500"
        >
          <Pencil aria-hidden="true" className="size-3" /> Edit
        </button>
      </div>
      <ul className="mt-1 space-y-1">
        {payments.map((p) => (
          <li key={p.id} className="flex flex-wrap items-baseline gap-x-3">
            <strong className="tabular-nums">{formatMoney(p.totalCents)}</strong>
            <span className="text-slate-500">
              {p.dueDay ? `around the ${ordinal(p.dueDay)}` : "any day"}
              {p.startDate && ` · from ${shortDate(p.startDate)}`}
              {p.endDate && ` · until ${shortDate(p.endDate)}`}
            </span>
            <span className="text-xs text-slate-500">
              {Object.entries(p.parts)
                .map(([id, c]) => `${name.get(id) ?? "?"} ${formatMoney(c)}`)
                .join(" · ")}
            </span>
            <span className="text-xs text-slate-500">
              {p.foundCount ? `${p.foundCount} found` : "none found yet"}
            </span>
          </li>
        ))}
      </ul>
      {modal}
    </div>
  );
}

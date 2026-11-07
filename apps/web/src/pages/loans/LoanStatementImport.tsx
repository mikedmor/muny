import type { Loan, LoanDetailsInput } from "@muny/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Link2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Modal } from "../../components/forms.js";
import { Alert, Button, Field } from "../../components/ui.js";
import { api } from "../../lib/api.js";
import { keys, useAccounts } from "../../lib/queries.js";

/**
 * How one loan's payments are found in your accounts. (Its statements are
 * imported with the shared statement importer.)
 */

const toCents = (s: string) => {
  const v = s.trim().replace(/[$,]/g, "");
  if (!v) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(v)) return Number.NaN;
  const [w = "0", f = ""] = v.split(".");
  return Number(w) * 100 + Number(f.padEnd(2, "0"));
};
const fromCents = (c: number | null | undefined) => (c == null ? "" : (c / 100).toFixed(2));

/** How this loan's payments are found: words, about how much, the due day, the paying account. */
function LinkForm({ loan, onDone }: { loan: Loan; onDone: () => void }) {
  const qc = useQueryClient();
  const accounts = useAccounts();
  const [words, setWords] = useState(loan.paymentMatch ?? "");
  const [amount, setAmount] = useState(fromCents(loan.paymentAmountCents));
  const [due, setDue] = useState(loan.nextDueDate ?? "");
  const [from, setFrom] = useState(loan.paymentFromAccountId ?? "");
  const [error, setError] = useState<string | null>(null);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const cents = toCents(amount);
    if (Number.isNaN(cents)) return setError("Check the amount, like 250.00.");
    const body: LoanDetailsInput = {
      paymentMatch: words.trim() || null,
      paymentAmountCents: cents,
      nextDueDate: due || null,
      paymentFromAccountId: from || null,
    };
    try {
      await api.patch(`/api/loans/${loan.accountId}`, body);
      await qc.invalidateQueries({ queryKey: keys.accounts });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save");
    }
  };
  return (
    <form onSubmit={save} className="space-y-3" noValidate>
      {error && <Alert>{error}</Alert>}
      <p className="text-sm text-slate-600 dark:text-slate-400">
        Muny finds this loan's payments in your accounts by the words they use there. When another
        loan or card uses the same words, narrow it down with any of the rest; a payment that fits
        two goes to the closer match.
      </p>
      <Field
        label="Words in your payments"
        value={words}
        onChange={(e) => setWords(e.target.value)}
        placeholder="e.g. SEAVIEW RESORTS"
      />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field
          label="About this much"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          inputMode="decimal"
          placeholder="Any amount"
        />
        <Field
          label="Next payment due"
          type="date"
          value={due}
          onChange={(e) => setDue(e.target.value)}
          hint="Payments within about a week of this day count."
        />
        <label className="block text-sm">
          <span className="font-medium text-slate-700 dark:text-slate-300">Paid from</span>
          <select
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-950"
          >
            <option value="">Any account</option>
            {(accounts.data ?? [])
              .filter((a) => a.type !== "credit" && a.type !== "loan" && !a.hidden)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.mask ? ` ••${a.mask}` : ""}
                </option>
              ))}
          </select>
        </label>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit">Save</Button>
      </div>
    </form>
  );
}

export function LoanLinkPaymentsButton({ loan }: { loan: Loan }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 text-xs font-normal text-brand-600 hover:underline dark:text-brand-500"
      >
        <Link2 aria-hidden="true" className="size-3" />
        {loan.paymentMatch ? `Found by "${loan.paymentMatch}"` : "Link payments"}
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={`Payments to ${loan.name}`}>
        {open && <LinkForm loan={loan} onDone={() => setOpen(false)} />}
      </Modal>
    </>
  );
}

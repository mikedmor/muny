import {
  formatMoney,
  type Loan,
  type LoanDetailsInput,
  type LoanStatementRead,
  type SingleLoanStatement,
} from "@muny/shared";
import { useQueryClient } from "@tanstack/react-query";
import { FileText, Link2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Modal } from "../../components/forms.js";
import { Alert, Button, Field } from "../../components/ui.js";
import { api } from "../../lib/api.js";
import { keys, useAccounts } from "../../lib/queries.js";

/**
 * Statements for one loan (mortgage, auto, personal…), and how its payments
 * are found in your accounts. A statement covering several loan groups (a
 * student loan servicer's) is imported on the lender's card instead.
 */

const day = (iso: string | null) =>
  iso
    ? new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "—";
const money = (c: number | null) => (c === null ? "—" : formatMoney(c));
const toCents = (s: string) => {
  const v = s.trim().replace(/[$,]/g, "");
  if (!v) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(v)) return Number.NaN;
  const [w = "0", f = ""] = v.split(".");
  return Number(w) * 100 + Number(f.padEnd(2, "0"));
};
const fromCents = (c: number | null | undefined) => (c == null ? "" : (c / 100).toFixed(2));

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(new Error("Couldn't read the file"));
    r.readAsDataURL(file);
  });
}

interface Item {
  name: string;
  base64: string;
  statement: SingleLoanStatement | null;
  error: string | null;
}

function Import({ loan, onDone }: { loan: Loan; onDone: () => void }) {
  const qc = useQueryClient();
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const read = async (files: FileList | null) => {
    if (!files?.length) return;
    const out: Item[] = [];
    let i = 0;
    for (const file of [...files]) {
      setBusy(`Reading ${++i} of ${files.length}…`);
      try {
        const base64 = await toBase64(file);
        const r = await api.post<LoanStatementRead>(
          `/api/loans/${loan.accountId}/statement/preview`,
          { pdfBase64: base64 },
        );
        out.push(
          r.kind === "single"
            ? { name: file.name, base64, statement: r.statement, error: null }
            : {
                name: file.name,
                base64: "",
                statement: null,
                error: `Covers several loans (${r.groups.join(", ")}): use Import statements on the lender's card.`,
              },
        );
      } catch (err) {
        out.push({
          name: file.name,
          base64: "",
          statement: null,
          error: err instanceof Error ? err.message : "Couldn't read it",
        });
      }
    }
    out.sort((a, b) =>
      (a.statement?.statementDate ?? "").localeCompare(b.statement?.statementDate ?? ""),
    );
    setItems(out);
    setBusy(null);
  };
  const apply = async () => {
    setError(null);
    try {
      const ok = items.filter((x) => x.statement);
      let i = 0;
      for (const it of ok) {
        setBusy(`Updating from statement ${++i} of ${ok.length}…`);
        await api.post(`/api/loans/${loan.accountId}/statement/apply`, {
          statement: it.statement,
          pdfBase64: it.base64,
          fileName: it.name,
          lender: loan.lender ?? loan.name,
        });
      }
      await qc.invalidateQueries({ queryKey: keys.accounts });
      await qc.invalidateQueries({ queryKey: ["documents"] });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't apply them");
      setBusy(null);
    }
  };
  return (
    <div className="space-y-4">
      {error && <Alert>{error}</Alert>}
      <p className="text-sm text-slate-600 dark:text-slate-400">
        Choose one or more statement PDFs for this loan. Muny reads the statement and due dates,
        what you owe, the rate, the regular payment and the last payment. The newest sets the loan's
        rate, payment and due date (and, for a loan tracked from your payments, what you owe from
        its date); each records what you owed that day. Each PDF is kept under Insights → Documents.
      </p>
      <input
        type="file"
        multiple
        accept="application/pdf,.pdf"
        disabled={!!busy}
        onChange={(e) => void read(e.target.files)}
        className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-brand-600 file:px-3 file:py-1.5 file:text-white"
      />
      {busy && <p className="text-sm text-slate-500">{busy}</p>}
      {items.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[36rem] text-sm">
            <thead className="text-xs text-slate-500">
              <tr>
                <th className="py-1.5 text-left font-medium">File</th>
                <th className="py-1.5 text-right font-medium">Statement</th>
                <th className="py-1.5 text-right font-medium">Owed</th>
                <th className="py-1.5 text-right font-medium">Rate</th>
                <th className="py-1.5 text-right font-medium">Payment</th>
                <th className="py-1.5 text-right font-medium">Due</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {items.map((it) => {
                const s = it.statement;
                return (
                  <tr key={it.name}>
                    <td className="max-w-40 truncate py-2">{it.name}</td>
                    {s ? (
                      <>
                        <td className="py-2 text-right whitespace-nowrap">
                          {day(s.statementDate)}
                        </td>
                        <td className="py-2 text-right tabular-nums">{money(s.balanceCents)}</td>
                        <td className="py-2 text-right tabular-nums">
                          {s.aprBps === null ? "—" : `${(s.aprBps / 100).toFixed(2)}%`}
                        </td>
                        <td className="py-2 text-right tabular-nums">{money(s.paymentCents)}</td>
                        <td className="py-2 text-right whitespace-nowrap">{day(s.dueDate)}</td>
                      </>
                    ) : (
                      <td colSpan={5} className="py-2 text-red-600">
                        {it.error}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onDone}>
          Cancel
        </Button>
        <Button disabled={!items.some((x) => x.statement) || !!busy} onClick={() => void apply()}>
          Update loan
        </Button>
      </div>
    </div>
  );
}

export function LoanStatementButton({ loan }: { loan: Loan }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 text-brand-600 hover:underline dark:text-brand-500"
      >
        <FileText aria-hidden="true" className="size-3" /> Import statements
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={`${loan.name} statements`} wide>
        {open && <Import loan={loan} onDone={() => setOpen(false)} />}
      </Modal>
    </>
  );
}

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

import { formatMoney, type Loan, type LoanStatementPreview } from "@muny/shared";
import { useQueryClient } from "@tanstack/react-query";
import { FileText } from "lucide-react";
import { useState } from "react";
import { Modal } from "../../components/forms.js";
import { Alert, Button } from "../../components/ui.js";
import { api } from "../../lib/api.js";
import { keys } from "../../lib/queries.js";

/**
 * Import a loan statement (PDF): each group's rate, balance, regular payment
 * and due date, and exactly what was applied to it since the last statement.
 * The PDF is read on your Muny server and not kept.
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

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(new Error("Couldn't read the file"));
    r.readAsDataURL(file);
  });
}

export function StatementImportButton({ lender, loans }: { lender: string; loans: Loan[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Update these loans from a statement (PDF)"
        className="inline-flex items-center gap-1 text-xs text-brand-600 hover:underline dark:text-brand-500"
      >
        <FileText aria-hidden="true" className="size-3" /> Import a statement
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={`Import a ${lender} statement`} wide>
        {open && <StatementImport lender={lender} loans={loans} onDone={() => setOpen(false)} />}
      </Modal>
    </>
  );
}

function StatementImport({
  lender,
  loans,
  onDone,
}: {
  lender: string;
  loans: Loan[];
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [preview, setPreview] = useState<LoanStatementPreview | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const read = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setPreview(null);
    if (file.size > 10 * 1024 * 1024) return setError("That file is over 10 MB.");
    setBusy(true);
    try {
      const p = await api.post<LoanStatementPreview>("/api/loans/statements/preview", {
        lender,
        pdfBase64: await toBase64(file),
      });
      setPreview(p);
      setMapping(p.matches);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't read it");
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      await api.post("/api/loans/statements/apply", {
        lender,
        statement: preview.statement,
        mapping,
      });
      await qc.invalidateQueries({ queryKey: keys.accounts });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't apply it");
      setBusy(false);
    }
  };

  const s = preview?.statement;
  return (
    <div className="space-y-4">
      {error && <Alert>{error}</Alert>}
      <p className="text-sm text-slate-600 dark:text-slate-400">
        Choose a statement PDF. Muny reads each loan group's rate, what you owe, its regular payment
        and due date, and what was applied to it since the last statement, split into interest and
        principal. Your loans then count from the statement date. The PDF is read on your Muny
        server and not kept.
      </p>
      <input
        type="file"
        accept="application/pdf,.pdf"
        disabled={busy}
        onChange={(e) => void read(e.target.files?.[0])}
        className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-brand-600 file:px-3 file:py-1.5 file:text-white"
      />
      {busy && !preview && <p className="text-sm text-slate-500">Reading…</p>}
      {s && (
        <>
          <p className="text-sm">
            Statement of <strong>{day(s.statementDate)}</strong>
            {s.lastPayment && (
              <>
                {" "}
                · last payment {formatMoney(s.lastPayment.amountCents)} on {day(s.lastPayment.date)}
              </>
            )}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[44rem] text-sm">
              <thead className="text-xs text-slate-500">
                <tr>
                  <th className="py-1.5 text-left font-medium">Group</th>
                  <th className="py-1.5 text-left font-medium">Loan in Muny</th>
                  <th className="py-1.5 text-right font-medium">Rate</th>
                  <th className="py-1.5 text-right font-medium">Owed</th>
                  <th className="py-1.5 text-right font-medium">Payment</th>
                  <th className="py-1.5 text-right font-medium">Due</th>
                  <th className="py-1.5 text-right font-medium">Applied since last</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {s.groups.map((g) => (
                  <tr key={g.name}>
                    <td className="py-2 font-medium">{g.name}</td>
                    <td className="py-2">
                      <select
                        aria-label={`Loan for group ${g.name}`}
                        value={mapping[g.name] ?? "new"}
                        onChange={(e) => setMapping((m) => ({ ...m, [g.name]: e.target.value }))}
                        className="rounded border border-slate-300 bg-white px-1.5 py-1 text-xs dark:border-slate-700 dark:bg-slate-950"
                      >
                        {loans.map((l) => (
                          <option key={l.accountId} value={l.accountId}>
                            {l.name}
                          </option>
                        ))}
                        <option value="new">Add as a new loan</option>
                        <option value="skip">Skip</option>
                      </select>
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {g.aprBps === null ? "—" : `${(g.aprBps / 100).toFixed(2)}%`}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {money((g.principalCents ?? 0) + (g.accruedInterestCents ?? 0))}
                    </td>
                    <td className="py-2 text-right tabular-nums">{money(g.monthlyPaymentCents)}</td>
                    <td className="py-2 text-right whitespace-nowrap">{day(g.dueDate)}</td>
                    <td className="py-2 text-right tabular-nums">
                      {money(g.paidCents)}
                      {g.paidCents ? (
                        <span className="block text-[11px] text-slate-500">
                          {money(g.paidPrincipalCents)} principal · {money(g.paidInterestCents)}{" "}
                          interest
                        </span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-slate-500">
            Owed is the principal plus the interest built up on the statement date. Payments after
            it are counted from your bank as before, until the next statement.
          </p>
        </>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onDone}>
          Cancel
        </Button>
        <Button disabled={!preview || busy} onClick={() => void apply()}>
          Update loans
        </Button>
      </div>
    </div>
  );
}

import {
  formatMoney,
  type Loan,
  type LoanStatementGroup,
  type LoanStatementPreview,
} from "@muny/shared";
import { useQueryClient } from "@tanstack/react-query";
import { FileText } from "lucide-react";
import { useState } from "react";
import { Modal } from "../../components/forms.js";
import { Alert, Button } from "../../components/ui.js";
import { api } from "../../lib/api.js";
import { keys } from "../../lib/queries.js";

/**
 * Import loan statements (PDFs, one or many, any months): each group's rate,
 * balance, regular payment and due date, and exactly what was applied to it
 * since the previous statement. Applied oldest first; only the newest moves
 * the balance. Each PDF is kept under Insights → Documents.
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
        title="Update these loans from statements (PDF)"
        className="inline-flex items-center gap-1 text-xs text-brand-600 hover:underline dark:text-brand-500"
      >
        <FileText aria-hidden="true" className="size-3" /> Import statements
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={`Import ${lender} statements`} wide>
        {open && <StatementImport lender={lender} loans={loans} onDone={() => setOpen(false)} />}
      </Modal>
    </>
  );
}

interface Item {
  name: string;
  base64: string;
  preview: LoanStatementPreview | null;
  error: string | null;
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
  const [items, setItems] = useState<Item[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const read = async (files: FileList | null) => {
    if (!files?.length) return;
    setError(null);
    const out: Item[] = [];
    let i = 0;
    for (const file of [...files]) {
      setBusy(`Reading ${++i} of ${files.length}…`);
      if (file.size > 10 * 1024 * 1024) {
        out.push({ name: file.name, base64: "", preview: null, error: "Over 10 MB" });
        continue;
      }
      try {
        const base64 = await toBase64(file);
        const preview = await api.post<LoanStatementPreview>("/api/loans/statements/preview", {
          lender,
          pdfBase64: base64,
        });
        out.push({ name: file.name, base64, preview, error: null });
      } catch (err) {
        out.push({
          name: file.name,
          base64: "",
          preview: null,
          error: err instanceof Error ? err.message : "Couldn't read it",
        });
      }
    }
    // Oldest first: that's the order they're applied in.
    out.sort((a, b) =>
      (a.preview?.statement.statementDate ?? "").localeCompare(
        b.preview?.statement.statementDate ?? "",
      ),
    );
    setItems(out);
    const m: Record<string, string> = {};
    for (const it of out)
      for (const [g, id] of Object.entries(it.preview?.matches ?? {}))
        if (!m[g] || m[g] === "new") m[g] = id;
    setMapping(m);
    setBusy(null);
  };

  const ok = items.filter((i) => i.preview);
  // Each group's figures from its newest statement.
  const latest = new Map<string, { g: LoanStatementGroup; date: string }>();
  for (const it of ok)
    for (const g of it.preview?.statement.groups ?? [])
      latest.set(g.name, { g, date: it.preview?.statement.statementDate ?? "" });
  const groups = [...latest.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  const apply = async () => {
    setError(null);
    try {
      let i = 0;
      for (const it of ok) {
        setBusy(`Updating from statement ${++i} of ${ok.length}…`);
        await api.post("/api/loans/statements/apply", {
          lender,
          statement: it.preview?.statement,
          // A new group is added once (by the first statement); later ones use it.
          mapping: i === 1 ? mapping : await settledMapping(),
          pdfBase64: it.base64,
          fileName: it.name,
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

  /** After the first statement, groups marked "new" exist as loans: point them there. */
  const settledMapping = async () => {
    const report = await api.get<{ loans: Loan[] }>("/api/loans");
    const key = lender.trim().toLowerCase();
    const out = { ...mapping };
    for (const [g, id] of Object.entries(mapping)) {
      if (id !== "new") continue;
      const made = report.loans.find(
        (l) => l.lender?.trim().toLowerCase() === key && l.name === `Group ${g}`,
      );
      if (made) out[g] = made.accountId;
    }
    return out;
  };

  return (
    <div className="space-y-4">
      {error && <Alert>{error}</Alert>}
      <p className="text-sm text-slate-600 dark:text-slate-400">
        Choose one or more statement PDFs, from any months. Muny reads each loan group's rate, what
        you owe, its regular payment and due date, and what was applied to it, split into interest
        and principal. Older statements fill in the history; the newest sets today's balance. Each
        PDF is kept under Insights → Documents.
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
        <ul className="space-y-1 text-sm">
          {items.map((it) => (
            <li key={it.name} className="flex flex-wrap justify-between gap-x-3">
              <span className="truncate">{it.name}</span>
              {it.preview ? (
                <span className="text-slate-500">
                  {day(it.preview.statement.statementDate)} ·{" "}
                  {it.preview.statement.groups.map((g) => g.name).join(", ")}
                  {it.preview.statement.lastPayment &&
                    ` · paid ${formatMoney(it.preview.statement.lastPayment.amountCents)}`}
                </span>
              ) : (
                <span className="text-red-600">{it.error}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {groups.length > 0 && (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <thead className="text-xs text-slate-500">
                <tr>
                  <th className="py-1.5 text-left font-medium">Group</th>
                  <th className="py-1.5 text-left font-medium">Loan in Muny</th>
                  <th className="py-1.5 text-right font-medium">Rate</th>
                  <th className="py-1.5 text-right font-medium">Owed</th>
                  <th className="py-1.5 text-right font-medium">Payment</th>
                  <th className="py-1.5 text-right font-medium">Due</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {groups.map(([name, { g, date }]) => (
                  <tr key={name}>
                    <td className="py-2 font-medium">{name}</td>
                    <td className="py-2">
                      <select
                        aria-label={`Loan for group ${name}`}
                        value={mapping[name] ?? "new"}
                        onChange={(e) => setMapping((m) => ({ ...m, [name]: e.target.value }))}
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
                    <td className="py-2 text-right tabular-nums" title={`On ${day(date)}`}>
                      {money((g.principalCents ?? 0) + (g.accruedInterestCents ?? 0))}
                    </td>
                    <td className="py-2 text-right tabular-nums">{money(g.monthlyPaymentCents)}</td>
                    <td className="py-2 text-right whitespace-nowrap">{day(g.dueDate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-slate-500">
            Figures are from each group's newest statement. Owed is the principal plus the interest
            built up on that date.
          </p>
        </>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onDone}>
          Cancel
        </Button>
        <Button disabled={!ok.length || !!busy} onClick={() => void apply()}>
          {ok.length > 1 ? `Update from ${ok.length} statements` : "Update loans"}
        </Button>
      </div>
    </div>
  );
}

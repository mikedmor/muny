import {
  type CardDetailsInput,
  type CardStatementPreview,
  type CardsReport,
  type CreditCard,
  formatMoney,
  payoff,
} from "@muny/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Pencil } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Modal } from "../components/forms.js";
import { Alert, Button, Card, cx, Field, PageHeader } from "../components/ui.js";
import { api } from "../lib/api.js";
import { keys } from "../lib/queries.js";

/**
 * Credit cards: what you owe against each limit, the statement (balance,
 * minimum, due date), the rate, payments, and what paying more would save.
 * Details come from your bank connection, a statement PDF, or you.
 */

export const cardsKey = [...keys.accounts, "cards"] as const;

const day = (d: string | null) =>
  d
    ? new Date(`${d}T00:00:00`).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "—";
const money = (c: number | null) => (c === null ? "—" : formatMoney(c));
const pct = (bps: number | null) => (bps === null ? "—" : `${(bps / 100).toFixed(2)}%`);
const daysUntil = (d: string) =>
  Math.round((new Date(`${d}T00:00:00`).getTime() - new Date().setHours(0, 0, 0, 0)) / 86_400_000);
const monthsLabel = (m: number) => {
  const y = Math.floor(m / 12);
  const r = m % 12;
  return [y && `${y} yr`, r && `${r} mo`].filter(Boolean).join(" ") || "under a month";
};
const toCents = (s: string) => {
  const v = s.trim().replace(/[$,]/g, "");
  if (!v) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(v)) return Number.NaN;
  const [w = "0", f = ""] = v.split(".");
  return Number(w) * 100 + Number(f.padEnd(2, "0"));
};
const fromCents = (c: number | null | undefined) => (c == null ? "" : (c / 100).toFixed(2));

/** Utilization: under 30% is good, under 50% fair, above that high (with words, not color alone). */
function usage(p: number) {
  if (p < 30) return { bar: "bg-emerald-500", label: "Good" };
  if (p < 50) return { bar: "bg-amber-500", label: "Fair" };
  return { bar: "bg-red-500", label: "High" };
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card>
      <p className="text-xs font-medium tracking-wide text-slate-500 uppercase">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {sub && <p className="mt-1 text-xs text-slate-500">{sub}</p>}
    </Card>
  );
}

function CardForm({ card, onDone }: { card: CreditCard; onDone: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    issuer: card.issuer ?? "",
    limit: fromCents(card.creditLimitCents),
    apr: card.aprBps === null ? "" : (card.aprBps / 100).toFixed(2),
    statement: fromCents(card.statementBalanceCents),
    closing: card.statementDate ?? "",
    minimum: fromCents(card.minimumPaymentCents),
    due: card.dueDate ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF((x) => ({ ...x, [k]: e.target.value }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const apr = f.apr.trim() ? Math.round(Number(f.apr) * 100) : null;
    const body: CardDetailsInput = {
      issuer: f.issuer.trim() || null,
      creditLimitCents: toCents(f.limit),
      aprBps: apr,
      statementBalanceCents: toCents(f.statement),
      statementDate: f.closing || null,
      minimumPaymentCents: toCents(f.minimum),
      dueDate: f.due || null,
    };
    if (Object.values(body).some((v) => typeof v === "number" && Number.isNaN(v)))
      return setError("Check the amounts and rate (numbers like 1234.56 and 24.99).");
    try {
      await api.patch(`/api/cards/${card.accountId}`, body);
      await qc.invalidateQueries({ queryKey: keys.accounts });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save");
    }
  };
  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      {error && <Alert>{error}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Issuer" value={f.issuer} onChange={set("issuer")} placeholder="e.g. Chase" />
        <Field label="Credit limit" value={f.limit} onChange={set("limit")} inputMode="decimal" />
        <Field
          label="Purchase APR (%)"
          value={f.apr}
          onChange={set("apr")}
          inputMode="decimal"
          placeholder="24.99"
        />
        <Field
          label="Statement balance"
          value={f.statement}
          onChange={set("statement")}
          inputMode="decimal"
        />
        <Field label="Statement closed" type="date" value={f.closing} onChange={set("closing")} />
        <Field
          label="Minimum payment"
          value={f.minimum}
          onChange={set("minimum")}
          inputMode="decimal"
        />
        <Field label="Payment due" type="date" value={f.due} onChange={set("due")} />
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

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(new Error("Couldn't read the file"));
    r.readAsDataURL(file);
  });
}

/** One or more card statement PDFs: each matched to a card by its last 4 digits. */
function StatementImport({ cards, onDone }: { cards: CreditCard[]; onDone: () => void }) {
  const qc = useQueryClient();
  const [items, setItems] = useState<
    {
      name: string;
      base64: string;
      preview: CardStatementPreview | null;
      error: string | null;
      accountId: string;
    }[]
  >([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const read = async (files: FileList | null) => {
    if (!files?.length) return;
    const out: typeof items = [];
    let i = 0;
    for (const file of [...files]) {
      setBusy(`Reading ${++i} of ${files.length}…`);
      try {
        const base64 = await toBase64(file);
        const preview = await api.post<CardStatementPreview>("/api/cards/statements/preview", {
          pdfBase64: base64,
        });
        out.push({
          name: file.name,
          base64,
          preview,
          error: null,
          accountId: preview.accountId ?? cards[0]?.accountId ?? "",
        });
      } catch (err) {
        out.push({
          name: file.name,
          base64: "",
          preview: null,
          error: err instanceof Error ? err.message : "Couldn't read it",
          accountId: "",
        });
      }
    }
    out.sort((a, b) =>
      (a.preview?.statement.closingDate ?? "").localeCompare(
        b.preview?.statement.closingDate ?? "",
      ),
    );
    setItems(out);
    setBusy(null);
  };
  const apply = async () => {
    setError(null);
    try {
      let i = 0;
      const ok = items.filter((x) => x.preview && x.accountId);
      for (const it of ok) {
        setBusy(`Updating from statement ${++i} of ${ok.length}…`);
        await api.post("/api/cards/statements/apply", {
          accountId: it.accountId,
          statement: it.preview?.statement,
          pdfBase64: it.base64,
          fileName: it.name,
          cardName: cards.find((c) => c.accountId === it.accountId)?.name,
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
        Choose one or more card statement PDFs. Muny reads the new balance, minimum payment, due
        date, credit limit and purchase APR (US statements all use the same labels), and picks the
        card by its last 4 digits. The newest statement sets the card's figures; each PDF is kept
        under Insights → Documents.
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
          <table className="w-full min-w-[40rem] text-sm">
            <thead className="text-xs text-slate-500">
              <tr>
                <th className="py-1.5 text-left font-medium">File</th>
                <th className="py-1.5 text-left font-medium">Card</th>
                <th className="py-1.5 text-right font-medium">Closed</th>
                <th className="py-1.5 text-right font-medium">Balance</th>
                <th className="py-1.5 text-right font-medium">Minimum</th>
                <th className="py-1.5 text-right font-medium">Due</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {items.map((it, k) => {
                const s = it.preview?.statement;
                return (
                  <tr key={it.name}>
                    <td className="max-w-40 truncate py-2">{it.name}</td>
                    {s ? (
                      <>
                        <td className="py-2">
                          <select
                            aria-label={`Card for ${it.name}`}
                            value={it.accountId}
                            onChange={(e) =>
                              setItems((xs) =>
                                xs.map((x, j) =>
                                  j === k ? { ...x, accountId: e.target.value } : x,
                                ),
                              )
                            }
                            className="rounded border border-slate-300 bg-white px-1.5 py-1 text-xs dark:border-slate-700 dark:bg-slate-950"
                          >
                            {cards.map((c) => (
                              <option key={c.accountId} value={c.accountId}>
                                {c.name}
                                {c.mask ? ` ••${c.mask}` : ""}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="py-2 text-right whitespace-nowrap">{day(s.closingDate)}</td>
                        <td className="py-2 text-right tabular-nums">{money(s.newBalanceCents)}</td>
                        <td className="py-2 text-right tabular-nums">
                          {money(s.minimumPaymentCents)}
                        </td>
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
        <Button disabled={!items.some((x) => x.preview) || !!busy} onClick={() => void apply()}>
          Update cards
        </Button>
      </div>
    </div>
  );
}

/** Paying more than the minimum: how long, and how much interest. */
function PayDown({ card }: { card: CreditCard }) {
  const min = card.minimumPaymentCents ?? Math.max(2_500, Math.round(card.balanceCents * 0.02));
  const [pay, setPay] = useState(Math.ceil(Math.max(min, card.balanceCents / 12) / 1000) * 10);
  if (card.aprBps === null || card.balanceCents <= 0) return null;
  const atMin = payoff(card.balanceCents, card.aprBps, min);
  const atPay = payoff(card.balanceCents, card.aprBps, pay * 100);
  return (
    <div className="rounded-xl border border-slate-200 p-4 text-sm dark:border-slate-800">
      <p className="font-semibold">Paying it off</p>
      <p className="mt-1 text-slate-600 dark:text-slate-300">
        At the minimum ({formatMoney(min)}):{" "}
        {atMin.months === null ? (
          <strong className="text-red-600">it never gets paid off</strong>
        ) : (
          <>
            <strong>{monthsLabel(atMin.months)}</strong>, {formatMoney(atMin.totalInterestCents)} in
            interest
          </>
        )}
        .
      </p>
      <label className="mt-3 block">
        <span className="flex items-baseline justify-between">
          <span className="text-slate-600 dark:text-slate-400">Pay each month</span>
          <span className="font-semibold tabular-nums">{formatMoney(pay * 100)}</span>
        </span>
        <input
          type="range"
          min={Math.ceil(min / 100)}
          max={Math.max(Math.ceil(min / 100) + 10, Math.ceil(card.balanceCents / 100))}
          step={5}
          value={pay}
          onChange={(e) => setPay(Number(e.target.value))}
          className="mt-1 w-full accent-brand-600"
        />
      </label>
      {atPay.months !== null && (
        <p className="text-slate-600 dark:text-slate-300">
          Paid off in <strong>{monthsLabel(atPay.months)}</strong> with{" "}
          {formatMoney(atPay.totalInterestCents)} interest
          {atMin.months !== null && atMin.totalInterestCents > atPay.totalInterestCents && (
            <span className="text-emerald-700 dark:text-emerald-400">
              {" "}
              ({formatMoney(atMin.totalInterestCents - atPay.totalInterestCents)} less)
            </span>
          )}
          .
        </p>
      )}
    </div>
  );
}

function CardTile({ card }: { card: CreditCard }) {
  const [editing, setEditing] = useState(false);
  const u = card.utilizationPct;
  const due = card.dueDate ? daysUntil(card.dueDate) : null;
  const facts = [
    {
      label: "Statement balance",
      value: money(card.statementBalanceCents),
      sub: card.statementDate ? `Closed ${day(card.statementDate)}` : null,
    },
    { label: "Minimum due", value: money(card.minimumPaymentCents) },
    {
      label: "Due",
      value: day(card.dueDate),
      sub: due === null ? null : due < 0 ? "Past" : due === 0 ? "Today" : `In ${due} days`,
    },
    { label: "Purchase APR", value: pct(card.aprBps) },
    {
      label: "Last payment",
      value: card.lastPayment ? formatMoney(card.lastPayment.amountCents) : "—",
      sub: card.lastPayment ? day(card.lastPayment.date) : null,
    },
    {
      label: "Spent since statement",
      value: formatMoney(card.spentSinceStatementCents),
    },
  ];
  const paidStatement =
    card.statementBalanceCents !== null &&
    card.lastPayment &&
    card.statementDate &&
    card.lastPayment.date > card.statementDate &&
    card.lastPayment.amountCents >= card.statementBalanceCents;
  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex flex-wrap items-center gap-2 text-lg font-semibold">
            {card.name}
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
              {card.connected ? "Synced" : "Imported"}
              {card.source === "statement" ? " · from statement" : ""}
            </span>
          </h3>
          <p className="text-xs text-slate-500">
            {[card.issuer, card.mask && `••${card.mask}`].filter(Boolean).join(" · ")}
          </p>
        </div>
        <div className="text-right">
          <p className="text-xs text-slate-500">Owed</p>
          <p className="text-2xl font-semibold tabular-nums">{formatMoney(card.balanceCents)}</p>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="inline-flex items-center gap-1 text-xs text-brand-600 hover:underline dark:text-brand-500"
          >
            <Pencil aria-hidden="true" className="size-3" /> Edit details
          </button>
        </div>
      </div>

      {card.creditLimitCents ? (
        <div>
          <div className="h-2.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
            <div
              className={cx("h-full rounded-full", usage(u ?? 0).bar)}
              style={{ width: `${Math.min(100, u ?? 0)}%` }}
            />
          </div>
          <p className="mt-1 flex flex-wrap justify-between gap-2 text-xs text-slate-500">
            <span>
              {(u ?? 0).toFixed(0)}% of the limit used · {usage(u ?? 0).label}
            </span>
            <span className="tabular-nums">
              {formatMoney(card.availableCents ?? 0)} available of{" "}
              {formatMoney(card.creditLimitCents)}
            </span>
          </p>
        </div>
      ) : (
        <p className="text-xs text-slate-500">
          Add the credit limit (Edit details or a statement) to see how much of it you're using.
        </p>
      )}

      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
        {facts.map((f) => (
          <div key={f.label}>
            <dt className="text-xs text-slate-500">{f.label}</dt>
            <dd className="mt-0.5 font-semibold tabular-nums">{f.value}</dd>
            {f.sub && <dd className="text-xs text-slate-500">{f.sub}</dd>}
          </div>
        ))}
      </dl>

      {card.statementBalanceCents !== null && card.statementBalanceCents > 0 && (
        <p className="text-sm text-slate-600 dark:text-slate-300">
          {paidStatement ? (
            <span className="text-emerald-700 dark:text-emerald-400">
              Statement balance paid: no interest on these purchases.
            </span>
          ) : (
            <>
              Pay the statement balance of{" "}
              <strong>{formatMoney(card.statementBalanceCents)}</strong>
              {card.dueDate && <> by {day(card.dueDate)}</>} to avoid interest.
            </>
          )}
          {card.interestThisYearCents > 0 && (
            <span className="text-slate-500">
              {" "}
              Interest charged this year: {formatMoney(card.interestThisYearCents)}.
            </span>
          )}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <PayDown card={card} />
        <div className="rounded-xl border border-slate-200 p-4 text-sm dark:border-slate-800">
          <p className="mb-2 font-semibold">Payments</p>
          {card.payments.length === 0 ? (
            <p className="text-slate-500">No payments found in the last year.</p>
          ) : (
            <ul className="max-h-56 divide-y divide-slate-100 overflow-y-auto dark:divide-slate-800">
              {card.payments.map((p) => (
                <li key={p.transactionId} className="flex justify-between gap-3 py-1.5">
                  <span>
                    {day(p.date)}
                    {p.fromAccountName && (
                      <span className="block text-xs text-slate-500">{p.fromAccountName}</span>
                    )}
                  </span>
                  <span className="font-medium tabular-nums">{formatMoney(p.amountCents)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <Modal open={editing} onClose={() => setEditing(false)} title={`Edit ${card.name}`}>
        {editing && <CardForm card={card} onDone={() => setEditing(false)} />}
      </Modal>
    </Card>
  );
}

export function CardsPage() {
  const q = useQuery({ queryKey: cardsKey, queryFn: () => api.get<CardsReport>("/api/cards") });
  const [importing, setImporting] = useState(false);
  const r = q.data;
  return (
    <>
      <PageHeader
        title="Credit cards"
        actions={
          r?.cards.length ? (
            <Button onClick={() => setImporting(true)}>
              <FileText aria-hidden="true" className="mr-1 inline size-4" /> Import statements
            </Button>
          ) : undefined
        }
      />
      {q.error && <Alert>{q.error.message}</Alert>}
      {r && r.cards.length === 0 && (
        <Card className="text-center">
          <h2 className="text-lg font-semibold">No credit cards yet</h2>
          <p className="mx-auto mt-2 max-w-lg text-sm text-slate-600 dark:text-slate-400">
            Connect your card on the Accounts page, or add it there as a credit card account and
            import its transactions. Then import its statement PDFs here for the limit, minimum
            payment, due date and rate.
          </p>
        </Card>
      )}
      {r && r.cards.length > 0 && (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Tile label="Total owed" value={formatMoney(r.totalOwedCents)} />
            <Tile
              label="Limit used"
              value={r.utilizationPct === null ? "—" : `${r.utilizationPct.toFixed(0)}%`}
              sub={
                r.totalLimitCents
                  ? `Of ${formatMoney(r.totalLimitCents)}${r.utilizationPct !== null ? ` · ${usage(r.utilizationPct).label}` : ""}`
                  : "Add your limits"
              }
            />
            <Tile
              label="Next payment"
              value={r.nextDue ? day(r.nextDue.date) : "—"}
              sub={
                r.nextDue
                  ? `${r.nextDue.name}${r.nextDue.amountCents ? ` · minimum ${formatMoney(r.nextDue.amountCents)}` : ""}`
                  : undefined
              }
            />
            <Tile label="Interest this year" value={formatMoney(r.interestThisYearCents)} />
          </div>
          {r.cards.map((c) => (
            <CardTile key={c.accountId} card={c} />
          ))}
        </div>
      )}
      <Modal
        open={importing}
        onClose={() => setImporting(false)}
        title="Import card statements"
        wide
      >
        {importing && r && <StatementImport cards={r.cards} onDone={() => setImporting(false)} />}
      </Modal>
    </>
  );
}

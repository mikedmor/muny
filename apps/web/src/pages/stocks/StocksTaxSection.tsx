import {
  type B1099Doc,
  type B1099Summary,
  type B1099Totals,
  BOX_LABELS,
  boxTerm,
  FORM_8949_BOXES,
  type Form8949Box,
  formatMoney,
  parseAmount,
  type StockTaxAccount,
  type TaxTerm,
  toDecimalString,
} from "@muny/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { FileText } from "lucide-react";
import { useState } from "react";
import { Alert, Button, Card, cx } from "../../components/ui.js";
import { api } from "../../lib/api.js";
import {
  investKeys,
  useB1099Docs,
  useInvalidatingMutation,
  useStockTax,
} from "../../lib/queries.js";
import { fmtAmount } from "../crypto/common.js";
import { day, money, tone } from "./common.js";

/**
 * Stocks on the Taxes page: the year's realized gains by holding period,
 * wash sales, dividends and interest from taxable accounts, a Form 8949
 * export, and each brokerage's 1099-B (read, compared with Muny's numbers).
 */

const TERM_LABEL: Record<TaxTerm, string> = {
  short: "Short term",
  long: "Long term",
  unknown: "Not known",
};

export function StocksTaxSection({ year }: { year: number }) {
  const q = useStockTax(year);
  const [showSales, setShowSales] = useState(false);
  const r = q.data;
  if (!r || r.accounts.length === 0) return null;
  const taxable = r.accounts.filter((a) => a.treatment === "taxable");
  const net = (t: TaxTerm) => r.realized[t].profitCents + r.realized[t].lossCents;
  const capital = net("short") + net("long") + net("unknown");
  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="p-0">
          <div className="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
            <h2 className="flex items-center gap-2 font-semibold">
              <span aria-hidden="true">📈</span> Stocks in {year}
            </h2>
            <p className="text-xs text-slate-500">
              From your trades in taxable accounts, first in, first out. Your 1099-B below is the
              official record.
            </p>
          </div>
          <div className="space-y-3 px-4 py-3">
            <dl className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
              {(
                [
                  ["Capital gains", capital, `${r.sales.length} sale lines`],
                  ["Wash sale losses deferred", r.washCents, "Estimated, across all accounts"],
                  ["Dividends", r.dividendsCents, "From your trade history"],
                  ["Interest", r.interestCents, "Cash in brokerage accounts"],
                ] as const
              ).map(([k, v, help]) => (
                <div key={k} className="flex justify-between gap-3 py-2" title={help}>
                  <dt>{k}</dt>
                  <dd className="font-medium tabular-nums">{money(v)}</dd>
                </div>
              ))}
            </dl>
            <table className="w-full text-xs text-slate-600 dark:text-slate-300">
              <thead className="text-slate-500">
                <tr>
                  <th className="text-left font-medium" />
                  <th className="text-right font-medium">Short term</th>
                  <th className="text-right font-medium">Long term</th>
                  {(r.realized.unknown.profitCents || r.realized.unknown.lossCents) !== 0 && (
                    <th className="text-right font-medium">Not known</th>
                  )}
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {(["profitCents", "lossCents"] as const).map((k) => (
                  <tr key={k}>
                    <td>{k === "profitCents" ? "Gains" : "Losses"}</td>
                    <td className="text-right">{money(r.realized.short[k])}</td>
                    <td className="text-right">{money(r.realized.long[k])}</td>
                    {(r.realized.unknown.profitCents || r.realized.unknown.lossCents) !== 0 && (
                      <td className="text-right">{money(r.realized.unknown[k])}</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            {r.sheltered.deferredCents + r.sheltered.exemptCents > 0 && (
              <p className="text-xs text-slate-500">
                Sales and dividends in IRAs and other tax-advantaged accounts aren&apos;t taxed and
                are left out.{" "}
                <Link to="/stocks/settings" className="text-brand-600 hover:underline">
                  Account tax treatment
                </Link>
              </p>
            )}
            {r.needsReconcile > 0 && (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                {r.needsReconcile} holding{r.needsReconcile === 1 ? "" : "s"} with incomplete
                history: some costs or dates are estimates.{" "}
                <Link to="/stocks/reconcile" className="underline">
                  Reconcile
                </Link>
              </p>
            )}
            {r.sales.length > 0 && (
              <button
                type="button"
                onClick={() => setShowSales((s) => !s)}
                className="text-sm text-brand-600 hover:underline"
                aria-expanded={showSales}
              >
                {showSales
                  ? "Hide the sales"
                  : `Show the ${r.sales.length === 1 ? "sale" : `${r.sales.length} sales`}`}
              </button>
            )}
          </div>
          {showSales && (
            <div className="overflow-x-auto border-t border-slate-200 dark:border-slate-800">
              <table className="w-full min-w-[44rem] text-xs">
                <thead className="text-slate-500">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium">Sold</th>
                    <th className="px-2 py-2 text-left font-medium">Holding</th>
                    <th className="px-2 py-2 text-left font-medium">Bought</th>
                    <th className="px-2 py-2 text-right font-medium">Proceeds</th>
                    <th className="px-2 py-2 text-right font-medium">Cost</th>
                    <th className="px-4 py-2 text-right font-medium">Gain</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 tabular-nums dark:divide-slate-800">
                  {r.sales.map((s) => (
                    <tr key={`${s.txnId}-${s.term}`}>
                      <td className="px-4 py-1.5">{day(s.date)}</td>
                      <td className="px-2 py-1.5">
                        {fmtAmount(s.quantity, 4)} {s.symbol}
                        <span className="block text-slate-500">
                          {s.accountName} · {TERM_LABEL[s.term]}
                        </span>
                      </td>
                      <td className="px-2 py-1.5">{s.various ? "Various" : day(s.acquired)}</td>
                      <td className="px-2 py-1.5 text-right">{formatMoney(s.proceedsCents)}</td>
                      <td className="px-2 py-1.5 text-right">
                        {s.costCents === null ? "—" : formatMoney(s.costCents)}
                      </td>
                      <td
                        className={cx(
                          "px-4 py-1.5 text-right",
                          s.gainCents !== null && tone(s.gainCents),
                        )}
                      >
                        {s.gainCents === null ? "—" : money(s.gainCents)}
                        {s.washCents > 0 && (
                          <span
                            className="block text-amber-700 dark:text-amber-400"
                            title={
                              s.washInRetirement
                                ? "Bought back in a retirement account: this part of the loss is lost for good."
                                : "Bought back within 30 days: this part of the loss moves onto the new shares."
                            }
                          >
                            wash {formatMoney(s.washCents)}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card className="space-y-3">
          <h2 className="font-semibold">Form 8949 lines</h2>
          <p className="text-sm text-slate-500">
            A CSV of every stock sale for {year}, by part and box, for tax software or your
            accountant. Accounts with a 1099-B read sale by sale (TXF or CSV) use the form&apos;s
            lines; the rest use Muny&apos;s own, marked as estimates. Muny doesn&apos;t fill in IRS
            PDF forms.
          </p>
          <a
            href={`/api/invest/tax/${year}/8949.csv`}
            className="inline-block rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-on-brand hover:bg-brand-700"
          >
            ⤓ Download {year} (CSV)
          </a>
        </Card>
      </div>
      {taxable.length > 0 && <B1099Forms year={year} accounts={taxable} />}
    </div>
  );
}

function B1099Forms({ year, accounts }: { year: number; accounts: StockTaxAccount[] }) {
  const docs = useB1099Docs(year);
  const byAccount = new Map<string, B1099Doc[]>();
  for (const d of docs.data ?? [])
    byAccount.set(d.accountId ?? "", [...(byAccount.get(d.accountId ?? "") ?? []), d]);
  return (
    <Card className="space-y-3">
      <h2 className="font-semibold">1099-B forms</h2>
      <p className="text-sm text-slate-500">
        Upload each brokerage&apos;s 1099-B for {year}. The <strong>TXF</strong> file most brokers
        offer for tax software (or a CSV of the sales) is read sale by sale; from a PDF, Muny reads
        the summary totals when it can, and you can type them in. Muny keeps the files encrypted and
        compares each form with its own numbers, so you can spot missing history before you file.
      </p>
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {accounts.map((a) => (
          <AccountForms key={a.id} year={year} account={a} docs={byAccount.get(a.id) ?? []} />
        ))}
      </ul>
    </Card>
  );
}

function toBase64(buf: Uint8Array) {
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000)
    bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

function AccountForms({
  year,
  account,
  docs,
}: {
  year: number;
  account: StockTaxAccount;
  docs: B1099Doc[];
}) {
  const write = [investKeys.all] as const;
  const upload = useInvalidatingMutation(async (file: File) => {
    const buf = new Uint8Array(await file.arrayBuffer());
    return api.post(`/api/invest/tax/${year}/docs`, {
      accountId: account.id,
      filename: file.name,
      contentType: file.type || "application/octet-stream",
      base64: toBase64(buf),
    });
  }, write);
  const del = useInvalidatingMutation(
    (id: string) => api.delete(`/api/invest/tax/docs/${id}`),
    write,
  );
  return (
    <li className="space-y-2 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">
          {account.name}
          {account.institutionName && (
            <span className="ml-1 text-xs font-normal text-slate-500">
              {account.institutionName}
            </span>
          )}
        </span>
        <label className="cursor-pointer rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-on-brand hover:bg-brand-700">
          {upload.isPending ? "Reading…" : docs.length ? "Upload another" : "Upload"}
          <input
            type="file"
            accept=".txf,.csv,.pdf,text/csv,text/plain,application/pdf,image/png,image/jpeg"
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) upload.mutate(f);
              e.target.value = "";
            }}
          />
        </label>
      </div>
      {docs.map((d) => (
        <DocCard
          key={d.id}
          d={d}
          onDelete={() => window.confirm(`Delete ${d.filename}?`) && del.mutate(d.id)}
        />
      ))}
      {(upload.error ?? del.error) && <Alert>{(upload.error ?? del.error)?.message}</Alert>}
    </li>
  );
}

/** The form's totals by term (boxes A–C short, D–F long). */
function byTerm(summary: B1099Summary): Record<TaxTerm, B1099Totals | null> {
  const out: Record<TaxTerm, B1099Totals | null> = { short: null, long: null, unknown: null };
  for (const [box, t] of Object.entries(summary) as [Form8949Box | "?", B1099Totals][]) {
    const term = boxTerm(box);
    const cur = out[term] ?? {
      proceedsCents: 0,
      costCents: 0,
      washCents: 0,
      gainCents: 0,
      count: 0,
    };
    cur.proceedsCents += t.proceedsCents;
    cur.costCents += t.costCents;
    cur.washCents += t.washCents;
    cur.gainCents += t.gainCents;
    cur.count += t.count;
    out[term] = cur;
  }
  return out;
}

function DocCard({ d, onDelete }: { d: B1099Doc; onDelete: () => void }) {
  const [editing, setEditing] = useState(false);
  const form = byTerm(d.summary);
  const terms = (["short", "long", "unknown"] as const).filter(
    (t) => form[t] || d.muny[t].count > 0,
  );
  const has = Object.keys(d.summary).length > 0;
  return (
    <div className="space-y-2 rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-800">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <a
          href={`/api/invest/tax/docs/${d.id}/file`}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1.5 text-brand-600 hover:underline"
        >
          <FileText aria-hidden="true" className="size-4" />
          {d.filename}
        </a>
        <span className="flex items-center gap-3 text-xs text-slate-500">
          <span>
            {d.format.toUpperCase()}
            {d.saleCount ? ` · ${d.saleCount} sales` : ""}
            {d.summarySource === "read" && " · totals read from the PDF: check them"}
            {d.summarySource === "entered" && " · totals typed in"}
          </span>
          {d.saleCount === 0 && (
            <Button variant="ghost" onClick={() => setEditing((e) => !e)}>
              {has ? "Edit totals" : "Enter totals"}
            </Button>
          )}
          <Button variant="ghost" className="text-red-600" onClick={onDelete}>
            Delete
          </Button>
        </span>
      </div>
      {editing && <SummaryEditor d={d} onDone={() => setEditing(false)} />}
      {!has && !editing && (
        <p className="text-xs text-slate-500">
          Muny couldn&apos;t read the totals from this file. Enter them from the form&apos;s summary
          page (proceeds, cost, wash sale loss disallowed and gain for each box) to compare.
        </p>
      )}
      {has && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] text-xs">
            <thead className="text-slate-500">
              <tr>
                <th className="text-left font-medium" />
                <th className="text-right font-medium">Proceeds</th>
                <th className="text-right font-medium">Cost</th>
                <th className="text-right font-medium">Wash sale</th>
                <th className="text-right font-medium">Gain</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {terms.map((t) => {
                const f = form[t];
                const m = d.muny[t];
                const diff = f ? m.gainCents - f.gainCents : null;
                return <FragmentRows key={t} label={TERM_LABEL[t]} form={f} muny={m} diff={diff} />;
              })}
            </tbody>
          </table>
          <p className="mt-1 text-[11px] text-slate-500">
            A difference usually means missing history (see Reconcile), lots chosen differently from
            first in, first out, or a wash sale only one side found.
          </p>
        </div>
      )}
    </div>
  );
}

function FragmentRows({
  label,
  form,
  muny,
  diff,
}: {
  label: string;
  form: B1099Totals | null;
  muny: B1099Totals;
  diff: number | null;
}) {
  const cell = (v: number | undefined) => (v === undefined ? "—" : money(v));
  return (
    <>
      <tr className="border-t border-slate-100 dark:border-slate-800">
        <td className="pt-1.5 font-medium">{label}: 1099-B</td>
        <td className="pt-1.5 text-right">{cell(form?.proceedsCents)}</td>
        <td className="pt-1.5 text-right">{cell(form?.costCents)}</td>
        <td className="pt-1.5 text-right">{cell(form?.washCents)}</td>
        <td className="pt-1.5 text-right">{cell(form?.gainCents)}</td>
      </tr>
      <tr>
        <td className="text-slate-500">Muny</td>
        <td className="text-right text-slate-500">{money(muny.proceedsCents)}</td>
        <td className="text-right text-slate-500">{money(muny.costCents)}</td>
        <td className="text-right text-slate-500">{money(muny.washCents)}</td>
        <td className="text-right text-slate-500">
          {money(muny.gainCents)}
          {diff !== null && Math.abs(diff) > 100 && (
            <span className="block text-amber-700 dark:text-amber-400">
              {diff > 0 ? "+" : "−"}
              {formatMoney(Math.abs(diff))} vs the form
            </span>
          )}
        </td>
      </tr>
    </>
  );
}

const FIELDS = [
  ["proceedsCents", "Proceeds"],
  ["costCents", "Cost"],
  ["washCents", "Wash sale"],
  ["gainCents", "Gain"],
] as const;

function SummaryEditor({ d, onDone }: { d: B1099Doc; onDone: () => void }) {
  const qc = useQueryClient();
  const [text, setText] = useState<Record<string, string>>(() => {
    const t: Record<string, string> = {};
    for (const box of FORM_8949_BOXES)
      for (const [k] of FIELDS) {
        const v = d.summary[box]?.[k];
        if (v !== undefined) t[`${box}.${k}`] = toDecimalString(v);
      }
    return t;
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    const summary: B1099Summary = {};
    try {
      for (const box of FORM_8949_BOXES) {
        const vals = FIELDS.map(([k]) => (text[`${box}.${k}`] ?? "").trim());
        if (vals.every((v) => !v)) continue;
        const [p, c, w, g] = vals.map((v) => (v ? parseAmount(v) : 0)) as [
          number,
          number,
          number,
          number,
        ];
        summary[box] = {
          proceedsCents: p,
          costCents: c,
          washCents: Math.abs(w),
          gainCents: vals[3] ? g : p - c + Math.abs(w),
          count: 0,
        };
      }
    } catch {
      setError("Enter amounts like 1234.56");
      return;
    }
    setSaving(true);
    try {
      await api.put(`/api/invest/tax/docs/${d.id}/summary`, { summary });
      await qc.invalidateQueries({ queryKey: investKeys.all });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save");
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[36rem] text-xs">
          <thead className="text-slate-500">
            <tr>
              <th className="text-left font-medium">Box</th>
              {FIELDS.map(([k, l]) => (
                <th key={k} className="text-right font-medium">
                  {l}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {FORM_8949_BOXES.map((box) => (
              <tr key={box}>
                <td className="pr-2" title={BOX_LABELS[box]}>
                  {box}{" "}
                  <span className="text-slate-500">({TERM_LABEL[boxTerm(box)].toLowerCase()})</span>
                </td>
                {FIELDS.map(([k, l]) => (
                  <td key={k} className="py-0.5 pl-1">
                    <input
                      inputMode="decimal"
                      aria-label={`Box ${box} ${l}`}
                      value={text[`${box}.${k}`] ?? ""}
                      onChange={(e) => setText((t) => ({ ...t, [`${box}.${k}`]: e.target.value }))}
                      className="w-full rounded border border-slate-300 bg-surface px-1.5 py-1 text-right dark:border-slate-700 dark:bg-slate-950"
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-slate-500">
        Leave the gain empty to work it out (proceeds − cost + wash sale).
      </p>
      {error && <Alert>{error}</Alert>}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onDone}>
          Cancel
        </Button>
        <Button onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save totals"}
        </Button>
      </div>
    </div>
  );
}

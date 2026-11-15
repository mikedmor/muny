import { formatMoney, type PayYear, type TaxSection, type TaxYear } from "@muny/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Alert, Card, PageHeader } from "../components/ui.js";
import { api } from "../lib/api.js";
import { keys } from "../lib/queries.js";
import { CryptoTaxSection } from "./crypto/CryptoTaxSection.js";
import { StocksTaxSection } from "./stocks/StocksTaxSection.js";

/**
 * Tax year summary: totals from your own data to hand to tax software or an
 * accountant. Not tax advice; the page says what each total is based on.
 */

const ICON: Record<TaxSection["key"], string> = {
  income: "💰",
  deductible: "🧾",
  mortgage: "🏠",
  charity: "🎁",
  medical: "💊",
  taxes: "🏛️",
};

const nice = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });

function Section({ s }: { s: TaxSection }) {
  const [open, setOpen] = useState(false);
  return (
    <Card className="p-0">
      <section id={`tax-${s.key}`} aria-labelledby={`tax-${s.key}-title`}>
        <div className="flex flex-wrap items-start justify-between gap-3 px-4 pt-4">
          <div className="min-w-0">
            <h2 id={`tax-${s.key}-title`} className="flex items-center gap-2 font-semibold">
              <span aria-hidden="true">{ICON[s.key]}</span>
              {s.title}
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">{s.basis}</p>
          </div>
          <p className="text-2xl font-semibold tabular-nums">{formatMoney(s.totalCents)}</p>
        </div>
        {s.byCategory.length > 1 && (
          <ul className="flex flex-wrap gap-2 px-4 pt-3 text-xs">
            {s.byCategory.map((c) => (
              <li key={c.name} className="rounded-full bg-slate-100 px-2.5 py-1 dark:bg-slate-800">
                {c.name} <span className="font-medium tabular-nums">{formatMoney(c.cents)}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="px-4 py-3">
          {s.items.length > 0 ? (
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
              className="text-sm text-brand-600 hover:underline"
            >
              {open ? "Hide" : "Show"} {s.items.length} transaction{s.items.length === 1 ? "" : "s"}
            </button>
          ) : (
            <p className="text-sm text-slate-500">Nothing for this year.</p>
          )}
        </div>
        {open && (
          <div className="overflow-x-auto border-t border-slate-200 dark:border-slate-800">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-slate-500">
                <tr>
                  <th className="px-4 py-2 font-medium">Date</th>
                  <th className="px-2 py-2 font-medium">Payee</th>
                  <th className="hidden px-2 py-2 font-medium sm:table-cell">Category</th>
                  <th className="hidden px-2 py-2 font-medium md:table-cell">Account</th>
                  <th className="px-4 py-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {s.items.map((i, n) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: split parts share a transaction id
                  <tr key={`${i.id}-${n}`}>
                    <td className="px-4 py-2 whitespace-nowrap text-slate-500">{nice(i.date)}</td>
                    <td className="px-2 py-2">
                      {i.name}
                      {i.notes && <span className="block text-xs text-slate-500">{i.notes}</span>}
                    </td>
                    <td className="hidden px-2 py-2 text-slate-600 sm:table-cell dark:text-slate-300">
                      {i.categoryName ?? "—"}
                    </td>
                    <td className="hidden px-2 py-2 text-slate-600 md:table-cell dark:text-slate-300">
                      {i.accountName}
                    </td>
                    <td className="px-4 py-2 text-right font-medium tabular-nums">
                      {formatMoney(i.cents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </Card>
  );
}

/** Wages and withholding from the Pay page: the W-2 when there is one, else the stubs so far. */
function WagesSection({ year }: { year: number }) {
  const q = useQuery({
    queryKey: ["pay", year],
    queryFn: () => api.get<PayYear>(`/api/pay/${year}`),
  });
  const p = q.data;
  if (!p?.breakdown && !p?.w2s.length) return null;
  const w2 = p.w2s[0];
  const rows: [string, number | null][] = w2
    ? [
        ["Wages (box 1)", w2.boxes.wagesCents],
        ["Federal income tax withheld (box 2)", w2.boxes.federalCents],
        [`${w2.boxes.state ?? "State"} income tax withheld (box 17)`, w2.boxes.stateCents],
        ["Local income tax withheld (box 19)", w2.boxes.localCents],
      ]
    : (p.breakdown?.taxes ?? []).map((t): [string, number] => [t.name, t.cents]);
  return (
    <Card className="p-0">
      <section aria-labelledby="tax-wages-title">
        <div className="flex flex-wrap items-start justify-between gap-3 px-4 pt-4">
          <div>
            <h2 id="tax-wages-title" className="flex items-center gap-2 font-semibold">
              <span aria-hidden="true">💼</span> Wages and withholding
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              {w2
                ? `From your ${year} W-2${p.w2s.length > 1 ? ` (and ${p.w2s.length - 1} more)` : ""}.`
                : `So far, from your pay stub for ${p.breakdown?.asOf ?? ""}. Add your W-2 when it comes.`}
            </p>
          </div>
          {!w2 && p.breakdown && (
            <p className="text-2xl font-semibold tabular-nums">
              {formatMoney(p.breakdown.grossCents)}
            </p>
          )}
        </div>
        <dl className="divide-y divide-slate-100 px-4 py-2 text-sm dark:divide-slate-800">
          {rows
            .filter(([, v]) => v !== null)
            .map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3 py-1.5">
                <dt>{k}</dt>
                <dd className="font-medium tabular-nums">{formatMoney(v as number)}</dd>
              </div>
            ))}
        </dl>
        <div className="px-4 pb-3">
          <Link to="/pay" className="text-sm text-brand-600 hover:underline">
            See it all on Pay
          </Link>
        </div>
      </section>
    </Card>
  );
}

export function TaxesPage() {
  const [year, setYear] = useState(() => new Date().getFullYear());
  const q = useQuery({
    queryKey: [...keys.reports, "tax", year],
    queryFn: () => api.get<TaxYear>(`/api/tax/${year}`),
    placeholderData: keepPreviousData,
  });
  const t = q.data;
  const years = t
    ? [...new Set([new Date().getFullYear(), ...t.years])].sort((a, b) => b - a)
    : [year];
  return (
    <>
      <PageHeader
        title="Taxes"
        actions={
          <div className="flex items-center gap-2">
            <select
              aria-label="Tax year"
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
              className="rounded-lg border border-slate-300 bg-surface px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
            >
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
            <a
              href={`/api/tax/${year}/export.csv`}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              ⤓ Export for my accountant
            </a>
          </div>
        }
      />
      <p className="-mt-3 mb-5 max-w-3xl text-sm text-slate-500">
        Totals from your own transactions for {year}, as a starting point for tax software or an
        accountant. This isn't tax advice: what's deductible depends on your situation. Tag
        transactions <span className="font-medium">#tax-deductible</span> on the{" "}
        <Link to="/transactions" className="text-brand-600 underline">
          Transactions
        </Link>{" "}
        page to collect them here.
      </p>
      {q.isError && <Alert>{q.error.message}</Alert>}
      {t && (
        <div className="space-y-6">
          <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
            {t.sections.map((s) => (
              <a
                key={s.key}
                href={`#tax-${s.key}`}
                className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm hover:border-brand-500 dark:border-slate-800 dark:bg-slate-900"
              >
                <span className="flex items-center gap-1.5 text-xs text-slate-500">
                  <span aria-hidden="true">{ICON[s.key]}</span>
                  {s.title}
                </span>
                <span className="mt-1 block text-xl font-semibold tabular-nums">
                  {formatMoney(s.totalCents)}
                </span>
                <span className="text-xs text-slate-500">
                  {s.items.length} transaction{s.items.length === 1 ? "" : "s"}
                </span>
              </a>
            ))}
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            {t.sections.map((s) => (
              <Section key={s.key} s={s} />
            ))}
          </div>
          <WagesSection year={year} />
          <StocksTaxSection year={year} />
          <CryptoTaxSection year={year} />
        </div>
      )}
    </>
  );
}

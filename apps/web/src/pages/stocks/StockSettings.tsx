import {
  formatMoney,
  TAX_TREATMENT_HELP,
  TAX_TREATMENT_LABELS,
  TAX_TREATMENTS,
  type TaxTreatment,
} from "@muny/shared";
import { Alert, Card } from "../../components/ui.js";
import { useSetTaxTreatment, useStockTax } from "../../lib/queries.js";
import { StocksExtrasSwitches } from "../StocksMarket.js";
import { StocksHeader } from "./common.js";

/**
 * Stocks settings: how each account is taxed (which decides what the tax
 * views count), how lots are matched, and the opt-in extras.
 */
export function StockSettings() {
  const year = new Date().getFullYear();
  const tax = useStockTax(year);
  const set = useSetTaxTreatment();
  const accounts = tax.data?.accounts ?? [];
  return (
    <>
      <StocksHeader />
      <div className="space-y-6">
        <Card className="space-y-3 p-0">
          <div className="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
            <h2 className="font-semibold">How each account is taxed</h2>
            <p className="text-sm text-slate-500">
              Only taxable accounts count toward realized gains, dividends, tax optimization and
              asset maturity. Muny guesses from the account type your bank sync reports, or the
              account&apos;s name; change it if the guess is wrong.
            </p>
          </div>
          {tax.error && <Alert>{tax.error.message}</Alert>}
          {set.error && <Alert>{set.error.message}</Alert>}
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {accounts.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{a.name}</span>
                  <span className="block text-xs text-slate-500">
                    {[a.institutionName, a.mask && `••${a.mask}`, formatMoney(a.valueCents)]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
                <select
                  aria-label={`How ${a.name} is taxed`}
                  value={a.guessed ? "" : a.treatment}
                  disabled={set.isPending}
                  onChange={(e) =>
                    set.mutate({
                      accountId: a.id,
                      treatment: (e.target.value || null) as TaxTreatment | null,
                    })
                  }
                  className="rounded-lg border border-slate-300 bg-surface px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950"
                >
                  <option value="">Automatic ({TAX_TREATMENT_LABELS[a.guess]})</option>
                  {TAX_TREATMENTS.map((t) => (
                    <option key={t} value={t}>
                      {TAX_TREATMENT_LABELS[t]}
                    </option>
                  ))}
                </select>
              </li>
            ))}
            {tax.data && accounts.length === 0 && (
              <li className="px-4 py-6 text-sm text-slate-500">No investment accounts yet.</li>
            )}
          </ul>
          <dl className="grid gap-2 border-t border-slate-200 px-4 py-3 text-xs text-slate-500 sm:grid-cols-3 dark:border-slate-800">
            {TAX_TREATMENTS.map((t) => (
              <div key={t}>
                <dt className="font-medium text-slate-700 dark:text-slate-300">
                  {TAX_TREATMENT_LABELS[t]}
                </dt>
                <dd>{TAX_TREATMENT_HELP[t]}</dd>
              </div>
            ))}
          </dl>
        </Card>

        <Card className="space-y-2 text-sm">
          <h2 className="font-semibold">Cost basis</h2>
          <p className="text-slate-600 dark:text-slate-300">
            Muny matches sales to purchases first in, first out, within each account, the default at
            most brokers. If you pick specific lots or use average cost for funds, your
            broker&apos;s numbers will differ: the 1099-B on the Taxes page is the official record,
            and Muny compares the two.
          </p>
          <p className="text-slate-600 dark:text-slate-300">
            Wash sales are estimated across all your accounts, IRAs included (a broker only sees its
            own). A loss is deferred when you buy the same stock within 30 days before or after
            selling it; when the new shares are in an IRA, the loss is lost for good.
          </p>
        </Card>

        <StocksExtrasSwitches />
      </div>
    </>
  );
}

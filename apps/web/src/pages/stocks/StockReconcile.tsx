import {
  formatMoney,
  type ReconcileRow,
  type ReconcileStatus,
  TAX_TREATMENT_LABELS,
} from "@muny/shared";
import { Link } from "@tanstack/react-router";
import { CheckCircle2 } from "lucide-react";
import { useState } from "react";
import { Modal } from "../../components/forms.js";
import { Alert, Button, Card, cx } from "../../components/ui.js";
import { useInvestReconcile } from "../../lib/queries.js";
import { fmtAmount } from "../crypto/common.js";
import { day, fx, StocksHeader } from "./common.js";
import { AddTradeDialog, type TradeDraft } from "./StockTransactions.js";

/**
 * Does each holding's trade history add up to what the broker reports? Lots,
 * holding periods and gains depend on it. Read-only, with a way to add the
 * trade that's missing.
 */

const STATUS: Record<ReconcileStatus, { label: string; tone: string; help: string }> = {
  ok: {
    label: "Matches",
    tone: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
    help: "Your trades add up to what the broker reports.",
  },
  missing_buys: {
    label: "Missing purchases",
    tone: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
    help: "The broker reports more shares than your trades add up to. They were probably bought before the history Muny has: add those purchases (date and cost) so their holding period and gain are right.",
  },
  missing_sales: {
    label: "Missing sale",
    tone: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
    help: "Your trades add up to more shares than the broker reports: a sale or transfer out is missing. Muny assumes the oldest shares left first until you add it.",
  },
  closed: {
    label: "Not held",
    tone: "bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200",
    help: "Your trades say you still hold some, but the broker reports none: a sale or transfer out is missing.",
  },
  no_trades: {
    label: "No history",
    tone: "bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200",
    help: "Held, but there are no trades for it. Muny uses the broker's cost, but doesn't know when you bought it. Import your broker's history or add the purchases.",
  },
  cost_differs: {
    label: "Cost differs",
    tone: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300",
    help: "Shares match, but your trades' cost differs from the broker's by more than 1%. Brokers adjust cost for wash sales, return of capital and reinvested dividends; check for a missing buy.",
  },
};

function draftFor(r: ReconcileRow): TradeDraft | null {
  const diff = fx(r.differenceQuantity);
  if (r.status === "missing_buys" || r.status === "no_trades")
    return {
      accountId: r.accountId,
      symbol: r.symbol,
      type: "buy",
      quantity: r.status === "no_trades" ? (r.heldQuantity ?? undefined) : r.differenceQuantity,
    };
  if (r.status === "missing_sales" || r.status === "closed")
    return {
      accountId: r.accountId,
      symbol: r.symbol,
      type: "sell",
      quantity: diff < 0n ? r.differenceQuantity.replace(/^-/, "") : r.tradesQuantity,
    };
  return null;
}

export function StockReconcile() {
  const q = useInvestReconcile();
  const [all, setAll] = useState(false);
  const [draft, setDraft] = useState<TradeDraft | null>(null);
  const d = q.data;
  const rows = (d?.rows ?? []).filter((r) => all || r.status !== "ok");
  return (
    <>
      <StocksHeader />
      {q.error && <Alert>{q.error.message}</Alert>}
      {d && (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Card>
              <p className="text-sm text-slate-500">Holdings that add up</p>
              <p className="text-2xl font-semibold tabular-nums">{d.ok}</p>
            </Card>
            <Card>
              <p className="text-sm text-slate-500">Need a look</p>
              <p
                className={cx(
                  "text-2xl font-semibold tabular-nums",
                  d.problems ? "text-amber-600 dark:text-amber-400" : "",
                )}
              >
                {d.problems}
              </p>
            </Card>
          </div>
          <Card className="text-sm text-slate-600 dark:text-slate-300">
            Muny works out each holding&apos;s tax lots from its trades. When the trades don&apos;t
            add up to what your broker reports, some purchase dates or costs are missing, and the
            holding periods and gains on the tax views are estimates. Fix it by importing your
            broker&apos;s full history (Stocks → Import) or adding the missing trade here.
          </Card>
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-semibold">{all ? "Every holding" : "Holdings that need a look"}</h2>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
              Show matching ones too
            </label>
          </div>
          {rows.length === 0 ? (
            <Card className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 aria-hidden="true" className="size-5" />
              {d.rows.length
                ? "Every holding's trades add up to what the broker reports."
                : "No holdings or trades yet."}
            </Card>
          ) : (
            <Card className="overflow-x-auto p-0">
              <table className="w-full min-w-[56rem] text-sm">
                <thead className="text-xs text-slate-500">
                  <tr className="border-b border-slate-200 dark:border-slate-800">
                    <th className="px-4 py-2 text-left font-medium">Holding</th>
                    <th className="px-2 py-2 text-left font-medium">Status</th>
                    <th className="px-2 py-2 text-right font-medium">Broker reports</th>
                    <th className="px-2 py-2 text-right font-medium">Trades add up to</th>
                    <th className="px-2 py-2 text-right font-medium">Cost (broker / trades)</th>
                    <th className="px-2 py-2 text-left font-medium">Trades</th>
                    <th className="px-4 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 tabular-nums dark:divide-slate-800">
                  {rows.map((r) => {
                    const s = STATUS[r.status];
                    const fix = draftFor(r);
                    return (
                      <tr key={`${r.accountId}|${r.securityId}`}>
                        <td className="px-4 py-2">
                          <Link
                            to="/stocks/$symbol"
                            params={{ symbol: r.symbol }}
                            className="font-medium hover:underline"
                          >
                            {r.symbol}
                          </Link>
                          <span className="block text-xs text-slate-500">
                            {r.accountName}
                            {r.treatment !== "taxable" && ` · ${TAX_TREATMENT_LABELS[r.treatment]}`}
                          </span>
                        </td>
                        <td className="px-2 py-2">
                          <span
                            className={cx("rounded px-1.5 py-0.5 text-xs font-medium", s.tone)}
                            title={s.help}
                          >
                            {s.label}
                          </span>
                          {r.unknownCost && r.status === "ok" && (
                            <span className="block text-[11px] text-slate-500">
                              Some shares came in by transfer, with no cost
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-2 text-right font-mono">
                          {r.heldQuantity ? fmtAmount(r.heldQuantity, 4) : "—"}
                        </td>
                        <td className="px-2 py-2 text-right font-mono">
                          {fmtAmount(r.tradesQuantity, 4)}
                        </td>
                        <td className="px-2 py-2 text-right text-xs">
                          {r.brokerCostCents === null ? "—" : formatMoney(r.brokerCostCents)} /{" "}
                          {r.tradesCostCents === null ? "—" : formatMoney(r.tradesCostCents)}
                        </td>
                        <td className="px-2 py-2 text-xs text-slate-500">
                          {r.trades
                            ? `${r.trades} · ${day(r.firstTrade)}${r.lastTrade !== r.firstTrade ? ` – ${day(r.lastTrade)}` : ""}`
                            : "none"}
                        </td>
                        <td className="px-4 py-2 text-right">
                          {fix && (
                            <Button variant="secondary" onClick={() => setDraft(fix)}>
                              {fix.type === "buy" ? "Add the purchase" : "Add the sale"}
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Card>
          )}
          <dl className="grid gap-2 text-xs text-slate-500 sm:grid-cols-2">
            {(Object.keys(STATUS) as ReconcileStatus[]).map((k) => (
              <div key={k}>
                <dt className="font-medium text-slate-700 dark:text-slate-300">
                  {STATUS[k].label}
                </dt>
                <dd>{STATUS[k].help}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      <Modal open={!!draft} onClose={() => setDraft(null)} title="Add a trade">
        {draft && <AddTradeDialog draft={draft} onClose={() => setDraft(null)} />}
      </Modal>
    </>
  );
}

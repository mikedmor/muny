import { formatMoney, INVEST_TXN_LABELS, INVEST_TXN_TYPES, type InvestTxnKind } from "@muny/shared";
import { Link, useSearch } from "@tanstack/react-router";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Modal, MoneyField, SelectField } from "../../components/forms.js";
import { Alert, Button, Card, cx, Field } from "../../components/ui.js";
import {
  useAddInvestTxn,
  useDeleteInvestTxn,
  useInvestSummary,
  useInvestTxnPage,
} from "../../lib/queries.js";
import { fmtAmount } from "../crypto/common.js";
import { day, fx, StocksHeader } from "./common.js";

/**
 * Every trade, dividend and transfer across your brokerage accounts, with
 * filters, plus trades you add by hand (to fill in history your broker's
 * sync or export didn't include). Synced rows can't be deleted here: they'd
 * only come back.
 */

const PAGE = 50;
const SHARE_TYPES = new Set<InvestTxnKind>(["buy", "sell", "split", "transfer_in", "transfer_out"]);
const ADDABLE: InvestTxnKind[] = [
  "buy",
  "sell",
  "dividend",
  "interest",
  "split",
  "transfer_in",
  "transfer_out",
  "fee",
];

export interface TradeDraft {
  accountId?: string;
  symbol?: string;
  type?: InvestTxnKind;
  quantity?: string;
}

/** Cents of `shares` at `price` (exact). */
const centsOf = (shares: string, price: string) =>
  Number((fx(shares) * fx(price) + 5n * 10n ** 33n) / 10n ** 34n);

export function AddTradeDialog({ draft, onClose }: { draft: TradeDraft; onClose: () => void }) {
  const summary = useInvestSummary();
  const add = useAddInvestTxn();
  const accounts = summary.data?.accounts ?? [];
  const [accountId, setAccountId] = useState(draft.accountId ?? accounts[0]?.id ?? "");
  const [type, setType] = useState<InvestTxnKind>(draft.type ?? "buy");
  const [symbol, setSymbol] = useState(draft.symbol ?? "");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [quantity, setQuantity] = useState(draft.quantity ?? "");
  const [price, setPrice] = useState("");
  const [fees, setFees] = useState<number | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const shares = SHARE_TYPES.has(type);
  const money = !["split", "transfer_in", "transfer_out"].includes(type);
  // A buy's total includes fees; a sale's is what you got after them.
  const auto =
    shares && quantity && price && /^\d+(\.\d+)?$/.test(quantity) && /^\d+(\.\d+)?$/.test(price)
      ? Math.max(0, centsOf(quantity, price) + (type === "buy" ? 1 : -1) * (fees ?? 0))
      : null;
  const shown = auto ?? total;
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        add.mutate(
          {
            accountId: accountId || (accounts[0]?.id ?? ""),
            type,
            date,
            symbol: symbol.trim() || undefined,
            quantity: shares ? quantity.trim() || undefined : undefined,
            price: shares && price.trim() ? price.trim() : undefined,
            totalCents: money ? (shown ?? undefined) : undefined,
            feesCents: fees ?? undefined,
          },
          { onSuccess: onClose },
        );
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField
          label="Account"
          value={accountId || (accounts[0]?.id ?? "")}
          onChange={(e) => setAccountId(e.target.value)}
        >
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Type"
          value={type}
          onChange={(e) => setType(e.target.value as InvestTxnKind)}
        >
          {ADDABLE.map((t) => (
            <option key={t} value={t}>
              {INVEST_TXN_LABELS[t]}
            </option>
          ))}
        </SelectField>
        <Field
          label="Ticker"
          value={symbol}
          onChange={(e) => setSymbol(e.target.value.toUpperCase())}
          placeholder="VTI"
          required={type !== "interest" && type !== "fee"}
        />
        <Field
          label="Date"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          required
        />
        {shares && (
          <Field
            label={type === "split" ? "Shares added by the split" : "Shares"}
            inputMode="decimal"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value.replace(/[^0-9.]/g, ""))}
            required
          />
        )}
        {(type === "buy" || type === "sell") && (
          <Field
            label="Price per share"
            inputMode="decimal"
            value={price}
            onChange={(e) => setPrice(e.target.value.replace(/[^0-9.]/g, ""))}
            hint="Optional: fills in the total"
          />
        )}
        {(type === "buy" || type === "sell") && (
          <MoneyField label="Fees" cents={fees} onChange={setFees} />
        )}
        {money && auto === null && (
          <MoneyField
            label={
              type === "buy"
                ? "Total cost (with fees)"
                : type === "sell"
                  ? "Proceeds (after fees)"
                  : "Amount"
            }
            cents={total}
            onChange={(c) => setTotal(c)}
          />
        )}
        {auto !== null && (
          <p className="self-end pb-2 text-sm">
            {type === "buy" ? "Total cost" : "Proceeds"}:{" "}
            <span className="font-medium tabular-nums">{formatMoney(auto)}</span>
            <span className="block text-xs text-slate-500">
              Shares × price {type === "buy" ? "plus" : "less"} fees
            </span>
          </p>
        )}
      </div>
      {type === "transfer_in" && (
        <p className="text-xs text-slate-500">
          Shares that arrive by transfer have no known cost or purchase date. If you know them, add
          the original purchase as a buy instead.
        </p>
      )}
      {add.error && <Alert>{add.error.message}</Alert>}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={add.isPending || !accounts.length}>
          {add.isPending ? "Adding…" : "Add"}
        </Button>
      </div>
    </form>
  );
}

const SOURCE: Record<string, string> = {
  plaid: "Synced",
  import: "Imported",
  manual: "Added by you",
};

export function StockTransactions() {
  const search = useSearch({ strict: false }) as { accountId?: string; q?: string; type?: string };
  const summary = useInvestSummary();
  const [accountId, setAccountId] = useState(search.accountId ?? "");
  const [type, setType] = useState(search.type ?? "");
  const [q, setQ] = useState(search.q ?? "");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [offset, setOffset] = useState(0);
  const [adding, setAdding] = useState(false);
  const page = useInvestTxnPage({ accountId, type, q, from, to, offset, limit: PAGE });
  const del = useDeleteInvestTxn();
  const d = page.data;
  const reset =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setOffset(0);
    };
  const input =
    "rounded-lg border border-slate-300 bg-surface px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950";
  return (
    <>
      <StocksHeader
        actions={
          <Button onClick={() => setAdding(true)} disabled={!summary.data?.accounts.length}>
            <Plus aria-hidden="true" className="mr-1 inline size-4" />
            Add a trade
          </Button>
        }
      />
      <div className="mb-4 flex flex-wrap items-end gap-2">
        <select
          aria-label="Account"
          value={accountId}
          onChange={(e) => reset(setAccountId)(e.target.value)}
          className={input}
        >
          <option value="">All accounts</option>
          {summary.data?.accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Type"
          value={type}
          onChange={(e) => reset(setType)(e.target.value)}
          className={input}
        >
          <option value="">All types</option>
          {INVEST_TXN_TYPES.map((t) => (
            <option key={t} value={t}>
              {INVEST_TXN_LABELS[t]}
            </option>
          ))}
        </select>
        <input
          type="search"
          aria-label="Find ticker or description"
          placeholder="Find ticker or description"
          value={q}
          onChange={(e) => reset(setQ)(e.target.value)}
          className={cx(input, "w-56")}
        />
        <label className="flex items-center gap-1 text-sm text-slate-500">
          From
          <input
            type="date"
            value={from}
            onChange={(e) => reset(setFrom)(e.target.value)}
            className={input}
          />
        </label>
        <label className="flex items-center gap-1 text-sm text-slate-500">
          to
          <input
            type="date"
            value={to}
            onChange={(e) => reset(setTo)(e.target.value)}
            className={input}
          />
        </label>
      </div>
      {page.error && <Alert>{page.error.message}</Alert>}
      {del.error && <Alert>{del.error.message}</Alert>}
      <Card className="overflow-x-auto p-0">
        <table className="w-full min-w-[52rem] text-sm">
          <thead className="text-xs text-slate-500">
            <tr className="border-b border-slate-200 dark:border-slate-800">
              <th className="px-4 py-2 text-left font-medium">Date</th>
              <th className="px-2 py-2 text-left font-medium">What</th>
              <th className="px-2 py-2 text-left font-medium">Account</th>
              <th className="px-2 py-2 text-right font-medium">Shares</th>
              <th className="px-2 py-2 text-right font-medium">Price</th>
              <th className="px-2 py-2 text-right font-medium">Amount</th>
              <th className="px-2 py-2 text-left font-medium">Source</th>
              <th className="w-10 px-2 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 tabular-nums dark:divide-slate-800">
            {d?.items.map((t) => (
              <tr key={t.id}>
                <td className="px-4 py-2 whitespace-nowrap text-slate-500">{day(t.date)}</td>
                <td className="px-2 py-2">
                  <span className="font-medium">{INVEST_TXN_LABELS[t.type]}</span>{" "}
                  {t.symbol && t.symbol !== "CASH" ? (
                    <Link
                      to="/stocks/$symbol"
                      params={{ symbol: t.symbol }}
                      className="hover:underline"
                    >
                      {t.symbol}
                    </Link>
                  ) : null}
                  {t.description && (
                    <span className="block max-w-xs truncate text-xs text-slate-500">
                      {t.description}
                    </span>
                  )}
                </td>
                <td className="px-2 py-2 text-slate-500">{t.accountName}</td>
                <td className="px-2 py-2 text-right font-mono">
                  {t.quantity && SHARE_TYPES.has(t.type) ? fmtAmount(t.quantity, 4) : ""}
                </td>
                <td className="px-2 py-2 text-right">
                  {t.price ? `$${fmtAmount(t.price, 4)}` : ""}
                </td>
                <td
                  className={cx(
                    "px-2 py-2 text-right font-medium",
                    t.amountCents > 0 && "text-emerald-600 dark:text-emerald-400",
                  )}
                >
                  {t.amountCents ? formatMoney(t.amountCents) : ""}
                  {t.feesCents > 0 && (
                    <span className="block text-xs font-normal text-slate-500">
                      fees {formatMoney(t.feesCents)}
                    </span>
                  )}
                </td>
                <td className="px-2 py-2 text-xs text-slate-500">{SOURCE[t.source] ?? t.source}</td>
                <td className="px-2 py-2">
                  {t.source !== "plaid" && (
                    <button
                      type="button"
                      aria-label={`Delete ${INVEST_TXN_LABELS[t.type]} ${t.symbol ?? ""} on ${t.date}`}
                      title="Delete"
                      disabled={del.isPending}
                      onClick={() =>
                        window.confirm(
                          `Delete this ${INVEST_TXN_LABELS[t.type].toLowerCase()}${t.symbol ? ` of ${t.symbol}` : ""}?`,
                        ) && del.mutate(t.id)
                      }
                      className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-red-600 dark:hover:bg-slate-800"
                    >
                      <Trash2 aria-hidden="true" className="size-4" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {d && d.items.length === 0 && (
          <p className="px-4 py-8 text-center text-sm text-slate-500">
            {d.total === 0 && !accountId && !type && !q && !from && !to
              ? "No activity yet. Sync a brokerage, import your broker's history, or add a trade."
              : "Nothing matches these filters."}
          </p>
        )}
      </Card>
      {d && d.total > PAGE && (
        <div className="mt-3 flex items-center justify-between text-sm text-slate-500">
          <span>
            {d.offset + 1}–{Math.min(d.total, d.offset + d.items.length)} of {d.total}
          </span>
          <span className="flex gap-2">
            <Button
              variant="secondary"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE))}
            >
              Newer
            </Button>
            <Button
              variant="secondary"
              disabled={offset + PAGE >= d.total}
              onClick={() => setOffset(offset + PAGE)}
            >
              Older
            </Button>
          </span>
        </div>
      )}
      <Modal open={adding} onClose={() => setAdding(false)} title="Add a trade">
        {adding && <AddTradeDialog draft={{}} onClose={() => setAdding(false)} />}
      </Modal>
    </>
  );
}

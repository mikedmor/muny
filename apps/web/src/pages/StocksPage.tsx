import {
  formatMoney,
  INVEST_TXN_LABELS,
  type InvestImportPreview,
  type InvestImportResult,
  type InvestPosition,
  SECURITY_TYPE_LABELS,
  type SecurityKind,
} from "@muny/shared";
import { Link } from "@tanstack/react-router";
import { ChevronRight, FileUp, Link2 } from "lucide-react";
import { type ChangeEvent, useMemo, useState } from "react";
import { Donut, LineChart } from "../components/charts.js";
import { Modal } from "../components/forms.js";
import { Alert, Button, Card, cx, PageHeader } from "../components/ui.js";
import { api } from "../lib/api.js";
import { useInvestImport, useInvestSummary, useInvestTxns } from "../lib/queries.js";
import { fmtAmount } from "./crypto/common.js";

/** Each kind keeps its color whatever else is held. */
const KIND_COLOR: Record<SecurityKind, string> = {
  equity: "var(--viz-series-1)",
  etf: "var(--viz-series-2)",
  mutual_fund: "var(--viz-series-3)",
  bond: "var(--viz-series-4)",
  option: "var(--viz-series-5)",
  cash: "var(--viz-series-6)",
  other: "var(--viz-other)",
};

const pct = (part: number, whole: number) =>
  whole ? `${((part / whole) * 100).toFixed(Math.abs(part / whole) < 0.1 ? 1 : 0)}%` : "–";

function Gain({ cents, base }: { cents: number | null; base?: number | null }) {
  if (cents === null) return <span className="text-slate-400">–</span>;
  return (
    <span className={cents >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600"}>
      {cents >= 0 ? "+" : ""}
      {formatMoney(cents)}
      {base ? (
        <span className="ml-1 text-xs">
          ({cents >= 0 ? "+" : ""}
          {((cents / base) * 100).toFixed(1)}%)
        </span>
      ) : null}
    </span>
  );
}

function Tile({
  label,
  children,
  sub,
}: {
  label: string;
  children: React.ReactNode;
  sub?: string;
}) {
  return (
    <Card>
      <p className="text-xs font-medium tracking-wide text-slate-500 uppercase">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{children}</p>
      {sub && <p className="mt-1 text-xs text-slate-500">{sub}</p>}
    </Card>
  );
}

type Sort = { key: "symbol" | "value" | "gain" | "weight"; dir: 1 | -1 };

function HoldingsTable({ positions, total }: { positions: InvestPosition[]; total: number }) {
  const [sort, setSort] = useState<Sort>({ key: "value", dir: -1 });
  const [open, setOpen] = useState<string | null>(null);
  const rows = useMemo(() => {
    const v = (p: InvestPosition) =>
      sort.key === "symbol"
        ? p.symbol
        : sort.key === "gain"
          ? (p.gainCents ?? Number.NEGATIVE_INFINITY)
          : p.valueCents;
    return [...positions].sort((a, b) => {
      const x = v(a);
      const y = v(b);
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
    });
  }, [positions, sort]);
  const th = (key: Sort["key"], label: string, right = true) => (
    <th className={cx("px-3 py-2 font-medium", right && "text-right")}>
      <button
        type="button"
        onClick={() =>
          setSort((s) => ({
            key,
            dir: s.key === key ? (s.dir === 1 ? -1 : 1) : key === "symbol" ? 1 : -1,
          }))
        }
        className="hover:text-slate-900 dark:hover:text-slate-100"
      >
        {label}
        {sort.key === key && <span aria-hidden="true"> {sort.dir === 1 ? "↑" : "↓"}</span>}
      </button>
    </th>
  );
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[44rem] text-sm">
        <thead className="text-left text-xs text-slate-500">
          <tr>
            {th("symbol", "Holding", false)}
            <th className="px-3 py-2 text-right font-medium">Shares</th>
            <th className="px-3 py-2 text-right font-medium">Price</th>
            {th("value", "Value")}
            <th className="px-3 py-2 text-right font-medium">Cost</th>
            {th("gain", "Gain")}
            {th("weight", "Weight")}
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <HoldingRow
              key={p.securityId}
              p={p}
              total={total}
              open={open === p.securityId}
              onToggle={() => setOpen(open === p.securityId ? null : p.securityId)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HoldingRow({
  p,
  total,
  open,
  onToggle,
}: {
  p: InvestPosition;
  total: number;
  open: boolean;
  onToggle: () => void;
}) {
  const cash = p.type === "cash";
  return (
    <>
      <tr
        onClick={onToggle}
        className="cursor-pointer border-t border-slate-100 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/40"
      >
        <td className="px-3 py-2.5">
          <span className="flex items-center gap-2">
            <ChevronRight
              aria-hidden="true"
              className={cx(
                "size-3.5 shrink-0 text-slate-400 transition-transform",
                open && "rotate-90",
              )}
            />
            <span
              aria-hidden="true"
              className="size-2.5 shrink-0 rounded-full"
              style={{ background: KIND_COLOR[p.type] }}
            />
            <span className="min-w-0">
              <button type="button" aria-expanded={open} className="block font-semibold">
                {cash ? "Cash" : p.symbol}
              </button>
              <span className="block max-w-64 truncate text-xs text-slate-500">{p.name}</span>
            </span>
          </span>
        </td>
        <td className="px-3 py-2.5 text-right tabular-nums">
          {cash ? "" : fmtAmount(p.quantity, 4)}
        </td>
        <td className="px-3 py-2.5 text-right tabular-nums">
          {cash || !p.price ? "" : `$${fmtAmount(p.price, 2)}`}
        </td>
        <td className="px-3 py-2.5 text-right font-medium tabular-nums">
          {formatMoney(p.valueCents)}
        </td>
        <td className="px-3 py-2.5 text-right tabular-nums text-slate-500">
          {cash ? "" : p.costBasisCents === null ? "–" : formatMoney(p.costBasisCents)}
        </td>
        <td className="px-3 py-2.5 text-right tabular-nums">
          {cash ? "" : <Gain cents={p.gainCents} base={p.costBasisCents} />}
        </td>
        <td className="px-3 py-2.5 text-right tabular-nums text-slate-500">
          {pct(p.valueCents, total)}
        </td>
      </tr>
      {open &&
        p.accounts.map((a) => (
          <tr
            key={a.accountId}
            className="bg-slate-50/60 text-xs text-slate-500 dark:bg-slate-800/30"
          >
            <td className="py-1.5 pr-3 pl-14">{a.accountName}</td>
            <td className="px-3 py-1.5 text-right tabular-nums">
              {cash ? "" : fmtAmount(a.quantity, 4)}
            </td>
            <td />
            <td className="px-3 py-1.5 text-right tabular-nums">{formatMoney(a.valueCents)}</td>
            <td colSpan={3} />
          </tr>
        ))}
    </>
  );
}

function Activity({ accounts }: { accounts: { id: string; name: string }[] }) {
  const [accountId, setAccountId] = useState("");
  const txns = useInvestTxns(accountId || undefined);
  return (
    <Card className="p-0">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <h2 className="font-semibold">Activity</h2>
        <select
          aria-label="Account"
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
          className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-950"
        >
          <option value="">All accounts</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </div>
      {txns.data?.length === 0 && (
        <p className="px-4 py-6 text-sm text-slate-500">
          No activity yet. Import your broker's account history to see buys, sales and dividends.
        </p>
      )}
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {txns.data?.map((t) => (
          <li key={t.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
            <span className="w-24 shrink-0 text-xs text-slate-500 tabular-nums">
              {new Date(`${t.date}T00:00:00`).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </span>
            <span className="min-w-0 flex-1">
              <span className="font-medium">
                {INVEST_TXN_LABELS[t.type]}
                {t.symbol && ` ${t.symbol}`}
              </span>
              {t.quantity && t.type !== "dividend" && (
                <span className="text-slate-500">
                  {" "}
                  · {fmtAmount(t.quantity, 4)} sh{t.price ? ` @ $${fmtAmount(t.price, 2)}` : ""}
                </span>
              )}
              <span className="block truncate text-xs text-slate-500">{t.accountName}</span>
            </span>
            <span
              className={cx(
                "shrink-0 font-medium tabular-nums",
                t.amountCents > 0 && "text-emerald-600 dark:text-emerald-400",
              )}
            >
              {t.amountCents ? formatMoney(t.amountCents) : ""}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function ImportDialog({ onClose }: { onClose: () => void }) {
  const [content, setContent] = useState<string | null>(null);
  const [preview, setPreview] = useState<InvestImportPreview | null>(null);
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<InvestImportResult | null>(null);
  const summary = useInvestSummary();
  const commit = useInvestImport();

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setPreview(null);
    const text = await file.text();
    setContent(text);
    try {
      const p = await api.post<InvestImportPreview>("/api/invest/import/preview", {
        content: text,
      });
      setPreview(p);
      setTargets(Object.fromEntries(p.accounts.map((a) => [a.ref, a.matchId ?? "new"])));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't read the file");
    }
  };

  if (result)
    return (
      <div className="space-y-4">
        <p
          role="status"
          className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300"
        >
          Imported: {result.holdingsUpdated} account{result.holdingsUpdated === 1 ? "" : "s"}'
          holdings updated, {result.added} transaction{result.added === 1 ? "" : "s"} added
          {result.duplicates ? ` (${result.duplicates} already here)` : ""}
          {result.accountsCreated
            ? `, ${result.accountsCreated} new account${result.accountsCreated === 1 ? "" : "s"}`
            : ""}
          .
        </p>
        <div className="flex justify-end">
          <Button onClick={onClose}>Done</Button>
        </div>
      </div>
    );

  return (
    <div className="space-y-4 text-sm">
      <p className="text-slate-600 dark:text-slate-400">
        Export <strong>positions</strong> (what you hold) and <strong>account history</strong>{" "}
        (buys, sales, dividends) as CSV from your broker's website, then add them here. Fidelity,
        Schwab, Vanguard, Robinhood, Webull and most other brokers' exports work. Importing the same
        file again only adds what's new.
      </p>
      <label className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed border-slate-300 px-4 py-6 text-center hover:border-brand-500 dark:border-slate-700">
        <FileUp aria-hidden="true" className="size-6 text-slate-400" />
        <span className="font-medium">Choose a CSV file</span>
        <input type="file" accept=".csv,text/csv" onChange={onFile} className="sr-only" />
      </label>
      {error && <Alert>{error}</Alert>}
      {preview && (
        <div className="space-y-3">
          <p>
            <strong>{preview.broker}</strong>: {preview.positions} position
            {preview.positions === 1 ? "" : "s"}, {preview.activity} transaction
            {preview.activity === 1 ? "" : "s"}
            {preview.firstDate && ` from ${preview.firstDate} to ${preview.lastDate}`}
            {preview.skipped ? ` (${preview.skipped} rows skipped)` : ""}.
          </p>
          {preview.accounts.map((a) => (
            <div
              key={a.ref}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-800"
            >
              <span>
                <span className="font-medium">{a.label}</span>
                <span className="block text-xs text-slate-500">
                  {[
                    a.positions && `${a.positions} positions · ${formatMoney(a.valueCents)}`,
                    a.activity && `${a.activity} transactions`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
              <select
                aria-label={`Account for ${a.label}`}
                value={targets[a.ref] ?? "new"}
                onChange={(e) => setTargets((t) => ({ ...t, [a.ref]: e.target.value }))}
                className="rounded-lg border border-slate-300 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-950"
              >
                <option value="new">New account</option>
                {summary.data?.accounts.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
                <option value="">Skip</option>
              </select>
            </div>
          ))}
          {commit.error && <Alert>{commit.error.message}</Alert>}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          disabled={!preview || !content || commit.isPending}
          onClick={() =>
            content &&
            commit.mutate(
              {
                content,
                targets: Object.fromEntries(Object.entries(targets).filter(([, v]) => v)),
              },
              { onSuccess: setResult },
            )
          }
        >
          {commit.isPending ? "Importing…" : "Import"}
        </Button>
      </div>
    </div>
  );
}

export function StocksPage() {
  const summary = useInvestSummary();
  const [importing, setImporting] = useState(false);
  const s = summary.data;
  const empty = s && s.accounts.length === 0;

  return (
    <>
      <PageHeader
        title="Stocks"
        actions={
          <div className="flex gap-2">
            <Link
              to="/accounts"
              title="Connect a brokerage through Plaid on the Accounts page"
              className="inline-flex items-center rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              <Link2 aria-hidden="true" className="mr-1.5 size-4" />
              Connect a brokerage
            </Link>
            <Button onClick={() => setImporting(true)}>
              <FileUp aria-hidden="true" className="mr-1.5 inline size-4" />
              Import
            </Button>
          </div>
        }
      />
      {summary.error && <Alert>{summary.error.message}</Alert>}

      {empty && (
        <Card className="text-center">
          <h2 className="text-lg font-semibold">Track your brokerage accounts</h2>
          <p className="mx-auto mt-2 max-w-lg text-sm text-slate-600 dark:text-slate-400">
            Connect a brokerage through Plaid (Accounts → Connect a brokerage) to sync holdings and
            history automatically, or import positions and history exported from Fidelity, Schwab,
            Vanguard, Robinhood, Webull and others.
          </p>
          <Button className="mt-4" onClick={() => setImporting(true)}>
            Import a CSV
          </Button>
        </Card>
      )}

      {s && !empty && (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Tile label="Portfolio value">{formatMoney(s.valueCents)}</Tile>
            <Tile
              label="Unrealized gain"
              sub={
                s.unknownCostValueCents
                  ? `${formatMoney(s.unknownCostValueCents)} with no reported cost left out`
                  : `On ${formatMoney(s.costBasisCents)} invested`
              }
            >
              <Gain cents={s.gainCents} base={s.costBasisCents} />
            </Tile>
            <Tile label="Cash" sub={`${pct(s.cashCents, s.valueCents)} of the portfolio`}>
              {formatMoney(s.cashCents)}
            </Tile>
            <Tile label="Dividends & interest" sub="Last 12 months">
              {formatMoney(s.incomeLast12Cents)}
            </Tile>
          </div>

          <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <Card>
              <h2 className="mb-3 font-semibold">Value over time</h2>
              {s.history.length >= 2 ? (
                <LineChart
                  ariaLabel="Portfolio value over time"
                  height={220}
                  points={s.history.map((p) => ({
                    date: p.date,
                    label: new Date(`${p.date}T00:00:00`).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                    }),
                    value: p.valueCents,
                  }))}
                />
              ) : (
                <p className="py-10 text-center text-sm text-slate-500">
                  The chart fills in as your holdings are updated over time.
                </p>
              )}
            </Card>
            <Card>
              <h2 className="mb-3 font-semibold">Allocation</h2>
              <div className="flex flex-col items-center gap-4">
                <Donut
                  ariaLabel="Allocation by kind"
                  size={180}
                  thickness={30}
                  slices={s.allocation.map((a) => ({
                    key: a.type,
                    label: SECURITY_TYPE_LABELS[a.type],
                    cents: a.valueCents,
                    color: KIND_COLOR[a.type],
                  }))}
                />
                <ul className="w-full space-y-1 text-sm">
                  {s.allocation.map((a) => (
                    <li key={a.type} className="flex items-center gap-2">
                      <span
                        aria-hidden="true"
                        className="size-2.5 rounded-full"
                        style={{ background: KIND_COLOR[a.type] }}
                      />
                      <span className="flex-1">{SECURITY_TYPE_LABELS[a.type]}</span>
                      <span className="tabular-nums text-slate-500">
                        {pct(a.valueCents, s.valueCents)}
                      </span>
                      <span className="w-24 text-right tabular-nums">
                        {formatMoney(a.valueCents)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </Card>
          </div>

          <Card className="p-0">
            <h2 className="border-b border-slate-200 px-4 py-3 font-semibold dark:border-slate-800">
              Holdings
            </h2>
            {s.positions.length ? (
              <HoldingsTable positions={s.positions} total={s.valueCents} />
            ) : (
              <p className="px-4 py-6 text-sm text-slate-500">
                No holdings yet. Import a positions export to see what each account holds.
              </p>
            )}
          </Card>

          <Card className="p-0">
            <h2 className="border-b border-slate-200 px-4 py-3 font-semibold dark:border-slate-800">
              Accounts
            </h2>
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {s.accounts.map((a) => (
                <li key={a.id} className="flex items-center gap-3 px-4 py-3 text-sm">
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{a.name}</span>
                    <span className="block text-xs text-slate-500">
                      {[
                        a.institutionName,
                        a.mask && `••${a.mask}`,
                        a.holdings
                          ? `${a.holdings} holding${a.holdings === 1 ? "" : "s"}`
                          : "No holdings imported",
                        a.asOf && `as of ${a.asOf}`,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                  <span className="text-right">
                    <span className="block font-medium tabular-nums">
                      {formatMoney(a.valueCents)}
                    </span>
                    <span className="block text-xs tabular-nums">
                      <Gain cents={a.gainCents} />
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </Card>

          <Activity accounts={s.accounts} />
        </div>
      )}

      <Modal open={importing} onClose={() => setImporting(false)} title="Import from your broker">
        {importing && <ImportDialog onClose={() => setImporting(false)} />}
      </Modal>
    </>
  );
}

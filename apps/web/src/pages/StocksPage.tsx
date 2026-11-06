import {
  formatMoney,
  INVEST_TXN_LABELS,
  type InvestImportPreview,
  type InvestImportResult,
  type InvestPosition,
  SECURITY_TYPE_LABELS,
} from "@muny/shared";
import { Link } from "@tanstack/react-router";
import { ChevronRight, FileUp, Link2, X } from "lucide-react";
import { type ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { Donut, LineChart, type StackBand, StackLegend } from "../components/charts.js";
import { Modal } from "../components/forms.js";
import { Alert, Button, Card, cx, PageHeader } from "../components/ui.js";
import { MerchantAvatar } from "../components/visuals.js";
import { api } from "../lib/api.js";
import {
  useInvestBackfill,
  useInvestImport,
  useInvestSummary,
  useInvestTxns,
  useSecurityPrices,
  useWatchAdd,
  useWatchlist,
  useWatchRefresh,
  useWatchRemove,
} from "../lib/queries.js";
import { assignColors, OTHER_COLOR, seriesColor } from "../lib/series.js";
import { Pct, Sparkline } from "./crypto/CryptoDashboard.js";
import { fmtAmount } from "./crypto/common.js";

const RANGES = [
  ["1M", 31],
  ["3M", 92],
  ["1Y", 366],
  ["All", 0],
] as const;

const shortDate = (d: string, withYear = false) =>
  new Date(`${d}T00:00:00`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {}),
  });

/** Keep a long daily series light: every point for a year or less, else weekly. */
function thin<T extends { date: string }>(list: T[]): T[] {
  if (list.length <= 400) return list;
  return list.filter(
    (p, i) => i === list.length - 1 || new Date(`${p.date}T00:00:00Z`).getUTCDay() === 5,
  );
}

function ValueChart({
  history,
  estimatedUntil,
  bySecurity,
  colors,
}: {
  history: { date: string; valueCents: number }[];
  estimatedUntil: string | null;
  bySecurity: { key: string; label: string; values: number[] }[];
  colors: Map<string, string>;
}) {
  const [range, setRange] = useState<(typeof RANGES)[number][0]>("All");
  const backfill = useInvestBackfill();
  const days = RANGES.find((r) => r[0] === range)?.[1] ?? 0;
  const cutoff = days ? new Date(Date.now() - days * 86400000).toISOString().slice(0, 10) : "";
  const shown = thin(history.map((p, i) => ({ ...p, i })).filter((p) => p.date >= cutoff));
  const stack: StackBand[] = bySecurity
    .map((b) => ({
      key: b.key,
      label: b.label,
      color: b.key === "other" ? OTHER_COLOR : (colors.get(b.key) ?? OTHER_COLOR),
      values: shown.map((p) => b.values[p.i] ?? 0),
    }))
    .filter((b) => b.values.some((v) => v > 0));
  const first = shown[0];
  const last = shown[shown.length - 1];
  const change = first && last ? last.valueCents - first.valueCents : null;
  const res = backfill.data;
  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-semibold">Value over time</h2>
          {change !== null && shown.length >= 2 && (
            <p className="text-xs text-slate-500">
              <Gain cents={change} base={first?.valueCents || null} /> since{" "}
              {shortDate(first?.date ?? "", true)}
            </p>
          )}
        </div>
        <fieldset className="m-0 flex items-center gap-1 border-0 p-0">
          <legend className="sr-only">Range</legend>
          {RANGES.map(([r]) => (
            <button
              key={r}
              type="button"
              aria-pressed={range === r}
              onClick={() => setRange(r)}
              className={cx(
                "rounded-md px-2 py-1 text-xs font-medium",
                range === r
                  ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
                  : "text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800",
              )}
            >
              {r}
            </button>
          ))}
        </fieldset>
      </div>
      {shown.length >= 2 ? (
        <LineChart
          ariaLabel="Portfolio value over time"
          height={220}
          stack={stack}
          points={shown.map((p) => ({
            date: p.date,
            label: shortDate(p.date, days === 0 || days > 92),
            value: p.valueCents,
          }))}
        />
      ) : (
        <p className="py-10 text-center text-sm text-slate-500">
          Not enough history yet. Fill it in from your trades and past prices below.
        </p>
      )}
      {shown.length >= 2 && stack.length > 0 && <StackLegend stack={stack} />}
      {estimatedUntil ? (
        // Filled in: a quiet note, with a way to redo it after importing older trades.
        <p className="mt-3 text-xs text-slate-500">
          Values up to {shortDate(estimatedUntil, true)} are estimated from your trades and closing
          prices.{" "}
          <button
            type="button"
            disabled={backfill.isPending}
            onClick={() => backfill.mutate()}
            title="After importing older trades, work the estimates out again"
            className="text-brand-600 hover:underline disabled:opacity-60 dark:text-brand-500"
          >
            {backfill.isPending ? "Recalculating…" : "Recalculate"}
          </button>
        </p>
      ) : (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3 text-xs text-slate-500 dark:border-slate-800">
          <span>
            See values from before you connected: Muny works them out from your trades and each
            day's closing price. Only ticker symbols are sent to Yahoo Finance, once.
          </span>
          <Button
            variant="secondary"
            className="px-2.5 py-1 text-xs"
            disabled={backfill.isPending}
            onClick={() => backfill.mutate()}
          >
            {backfill.isPending ? "Filling in…" : "Fill in history"}
          </Button>
        </div>
      )}
      {backfill.error && <Alert>{backfill.error.message}</Alert>}
      {res && res.missing.length > 0 && (
        <p role="status" className="mt-2 text-xs text-slate-500">
          No past prices for {res.missing.join(", ")}, so they're left out of the estimates.
        </p>
      )}
      {res && !res.accounts && (
        <p role="status" className="mt-2 text-xs text-slate-500">
          Nothing to fill in: no trades found. Import or sync your account history first.
        </p>
      )}
    </Card>
  );
}

/** A holding's daily closes since it was first priced. */
function PriceChart({ securityId, symbol }: { securityId: string; symbol: string }) {
  const prices = useSecurityPrices(securityId);
  const list = thin(
    (prices.data ?? []).map((p) => ({ ...p, valueCents: Math.round(Number(p.close) * 100) })),
  );
  if (prices.isLoading) return <p className="py-4 text-xs text-slate-500">Loading prices…</p>;
  if (list.length < 2)
    return (
      <p className="py-4 text-xs text-slate-500">
        No price history for {symbol} yet. Use "Fill in history" on the chart above.
      </p>
    );
  return (
    <LineChart
      ariaLabel={`${symbol} closing price`}
      height={160}
      points={list.map((p) => ({
        date: p.date,
        label: shortDate(p.date, true),
        value: p.valueCents,
      }))}
    />
  );
}

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

function HoldingsTable({
  positions,
  total,
  colors,
}: {
  positions: InvestPosition[];
  total: number;
  colors: Map<string, string>;
}) {
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
      <table className="w-full min-w-[36rem] text-sm">
        <thead className="text-left text-xs text-slate-500">
          <tr>
            <th className="w-8 pl-4">
              <span className="sr-only">Details</span>
            </th>
            {th("symbol", "Holding", false)}
            <th className="px-2 py-2 text-right font-medium">Shares</th>
            <th className="hidden px-2 py-2 text-right font-medium md:table-cell">Cost</th>
            {th("value", "Value")}
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
              color={colors.get(p.securityId) ?? OTHER_COLOR}
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
  color,
  open,
  onToggle,
}: {
  p: InvestPosition;
  total: number;
  color: string;
  open: boolean;
  onToggle: () => void;
}) {
  const cash = p.type === "cash";
  const shares = Number(p.quantity);
  const perShareCost =
    !cash && p.costBasisCents !== null && shares > 0 ? p.costBasisCents / 100 / shares : null;
  const usd = (n: number) =>
    `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: n < 1 ? 4 : 2 })}`;
  const accountTotal = p.accounts.reduce((t, a) => t + a.valueCents, 0);
  const share = (cents: number) => (accountTotal > 0 ? (cents / accountTotal) * 100 : 0);
  const pctLabel = (v: number) => (v === 0 ? "0%" : v < 1 ? "<1%" : `${Math.round(v)}%`);
  const name = cash ? "Cash" : p.symbol;
  return (
    <>
      <tr
        onClick={onToggle}
        className="cursor-pointer border-t border-slate-100 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/40"
      >
        <td className="w-8 py-3 pl-4">
          <button
            type="button"
            aria-expanded={open}
            aria-label={`${open ? "Hide" : "Show"} ${name} details`}
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            className={cx("text-slate-400 transition-transform", open && "rotate-90")}
          >
            <ChevronRight aria-hidden="true" className="size-3.5" />
          </button>
        </td>
        <td className="py-3 pr-2">
          <span className="flex items-center gap-3">
            <span className="relative">
              <MerchantAvatar name={name} />
              <span
                aria-hidden="true"
                className="absolute -right-0.5 -bottom-0.5 size-3 rounded-full ring-2 ring-white dark:ring-slate-900"
                style={{ background: color }}
              />
            </span>
            <span className="min-w-0">
              <span className="block font-semibold">{name}</span>
              <span className="block max-w-64 truncate text-xs text-slate-500">{p.name}</span>
            </span>
          </span>
        </td>
        <td className="px-2 text-right font-mono text-sm tabular-nums">
          {cash ? "" : fmtAmount(p.quantity, 4)}
        </td>
        <td className="hidden px-2 text-right tabular-nums md:table-cell">
          {cash ? (
            ""
          ) : p.costBasisCents === null ? (
            <span className="text-slate-400">—</span>
          ) : (
            <>
              <span className="block">{formatMoney(p.costBasisCents)}</span>
              {perShareCost !== null && (
                <span className="text-xs text-slate-500">{usd(perShareCost)} / share</span>
              )}
            </>
          )}
        </td>
        <td className="px-2 text-right tabular-nums">
          <span className="block font-medium">{formatMoney(p.valueCents)}</span>
          {!cash && p.price && (
            <span className="text-xs text-slate-500">{usd(Number(p.price))} / share</span>
          )}
        </td>
        <td className="hidden px-2 text-right text-sm tabular-nums sm:table-cell">
          {cash ? "" : <Gain cents={p.gainCents} base={p.costBasisCents} />}
        </td>
        <td className="py-3 pr-4 text-right text-sm tabular-nums text-slate-500">
          {pct(p.valueCents, total)}
        </td>
      </tr>
      {open && (
        <tr className="bg-slate-50/60 dark:bg-slate-800/30">
          <td colSpan={7} className="px-4 pt-3 pb-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <dl className="grid flex-1 grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
                {(
                  [
                    ["Price", !cash && p.price ? usd(Number(p.price)) : "—"],
                    ["Shares", cash ? "—" : fmtAmount(p.quantity, 4)],
                    ["Kind", SECURITY_TYPE_LABELS[p.type]],
                    ["Share of portfolio", pct(p.valueCents, total)],
                    ["Total cost", p.costBasisCents !== null ? formatMoney(p.costBasisCents) : "—"],
                    ["Cost / share", perShareCost !== null ? usd(perShareCost) : "—"],
                    ["Total value", formatMoney(p.valueCents)],
                    [
                      "Gains",
                      p.gainCents !== null && !cash
                        ? `${p.gainCents >= 0 ? "+" : "−"}${formatMoney(Math.abs(p.gainCents))}`
                        : "—",
                    ],
                  ] as const
                ).map(([k, v]) => (
                  <div key={k}>
                    <dt className="text-xs text-slate-500">{k}</dt>
                    <dd
                      className={cx(
                        "font-medium tabular-nums",
                        k === "Gains" &&
                          p.gainCents !== null &&
                          !cash &&
                          (p.gainCents >= 0
                            ? "text-emerald-700 dark:text-emerald-400"
                            : "text-red-600 dark:text-red-400"),
                      )}
                    >
                      {v}
                    </dd>
                  </div>
                ))}
              </dl>
              {!cash && (
                <div className="w-full sm:w-72">
                  <PriceChart securityId={p.securityId} symbol={p.symbol} />
                </div>
              )}
            </div>
            {p.costBasisCents === null && !cash && (
              <p className="mt-2 text-xs text-slate-500">
                Your broker doesn't report what you paid for this holding, so it's left out of the
                gain.
              </p>
            )}
            {p.accounts.length > 0 && (
              <div
                className="mt-4 flex h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700"
                aria-hidden="true"
              >
                {p.accounts.map((a, i) => (
                  <span
                    key={a.accountId}
                    style={{ width: `${share(a.valueCents)}%`, background: seriesColor(i) }}
                  />
                ))}
              </div>
            )}
            <table className="mt-3 w-full text-sm">
              <caption className="sr-only">{name} by account</caption>
              <thead className="text-xs text-slate-500">
                <tr>
                  <th className="py-1 text-left font-medium">Account</th>
                  <th className="py-1 text-right font-medium">{cash ? "" : "Shares"}</th>
                  <th className="py-1 text-right font-medium">Value</th>
                  <th className="py-1 text-right font-medium">Allocation</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200/70 dark:divide-slate-700/60">
                {p.accounts.map((a, i) => (
                  <tr key={a.accountId}>
                    <td className="py-1.5">{a.accountName}</td>
                    <td className="py-1.5 text-right font-mono tabular-nums">
                      {cash ? "" : fmtAmount(a.quantity, 4)}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{formatMoney(a.valueCents)}</td>
                    <td className="py-1.5 text-right tabular-nums">
                      <span className="inline-flex items-center gap-2">
                        {pctLabel(share(a.valueCents))}
                        <span
                          aria-hidden="true"
                          className="inline-block size-2.5 rounded-sm"
                          style={{ background: seriesColor(i) }}
                        />
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
  );
}

/** Tickers you follow, owned or not, with their recent moves. */
function WatchList() {
  const list = useWatchlist();
  const add = useWatchAdd();
  const remove = useWatchRemove();
  const refresh = useWatchRefresh();
  const [symbol, setSymbol] = useState("");
  const stale = list.data?.stale;
  // Prices refresh at most once a day, when the page is opened.
  const tried = useRef(false);
  const { mutate: refreshNow } = refresh;
  useEffect(() => {
    if (stale && !tried.current) {
      tried.current = true;
      refreshNow();
    }
  }, [stale, refreshNow]);
  const items = list.data?.items ?? [];
  const usd = (n: number) =>
    `${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: n < 1 ? 4 : 2 })}`;
  return (
    <Card className="p-0">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <h2 className="font-semibold">Watch list</h2>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (symbol.trim()) add.mutate(symbol.trim(), { onSuccess: () => setSymbol("") });
          }}
        >
          <input
            aria-label="Ticker to watch"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            placeholder="Ticker, e.g. NVDA"
            maxLength={12}
            className="w-36 rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm uppercase placeholder:normal-case dark:border-slate-700 dark:bg-slate-950"
          />
          <Button type="submit" className="px-3 py-1 text-sm" disabled={add.isPending}>
            {add.isPending ? "Adding…" : "Watch"}
          </Button>
        </form>
      </div>
      {add.error && (
        <div className="px-4 pt-3">
          <Alert>{add.error.message}</Alert>
        </div>
      )}
      {items.length === 0 ? (
        <p className="px-4 py-6 text-sm text-slate-500">
          Follow stocks you're interested in, even ones you don't own. Prices update once a day from
          Yahoo Finance (only the ticker is sent).
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] text-sm">
            <thead className="text-left text-xs text-slate-500">
              <tr>
                <th className="px-4 py-2 font-medium">Ticker</th>
                <th className="px-2 py-2 text-right font-medium">Price</th>
                <th className="px-2 py-2 text-right font-medium">Day</th>
                <th className="hidden px-2 py-2 text-right font-medium sm:table-cell">1 month</th>
                <th className="hidden px-2 py-2 text-right font-medium md:table-cell">1 year</th>
                <th className="hidden px-2 py-2 text-right font-medium lg:table-cell">3 months</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {items.map((w) => (
                <tr key={w.securityId} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="px-4 py-2.5">
                    <span className="flex items-center gap-3">
                      <MerchantAvatar name={w.symbol} size="sm" />
                      <span className="min-w-0">
                        <span className="block font-semibold">
                          {w.symbol}
                          {w.ownedValueCents !== null && (
                            <span className="ml-2 rounded bg-brand-50 px-1.5 py-0.5 text-[10px] font-medium text-brand-700 dark:bg-brand-700/20 dark:text-brand-500">
                              You own {formatMoney(w.ownedValueCents)}
                            </span>
                          )}
                        </span>
                        <span className="block max-w-56 truncate text-xs text-slate-500">
                          {w.name}
                        </span>
                      </span>
                    </span>
                  </td>
                  <td className="px-2 text-right font-medium tabular-nums">
                    {w.price ? usd(Number(w.price)) : "—"}
                    {w.priceDate && (
                      <span className="block text-[11px] font-normal text-slate-500">
                        {shortDate(w.priceDate)}
                      </span>
                    )}
                  </td>
                  <td className="px-2 text-right">
                    <Pct v={w.change1dPct} />
                  </td>
                  <td className="hidden px-2 text-right sm:table-cell">
                    <Pct v={w.change1mPct} />
                  </td>
                  <td className="hidden px-2 text-right md:table-cell">
                    <Pct v={w.change1yPct} />
                  </td>
                  <td className="hidden px-2 lg:table-cell">
                    <span className="flex justify-end">
                      <Sparkline values={w.spark} />
                    </span>
                  </td>
                  <td className="pr-3 text-right">
                    <button
                      type="button"
                      aria-label={`Stop watching ${w.symbol}`}
                      title="Remove from the watch list"
                      disabled={remove.isPending}
                      onClick={() => remove.mutate(w.securityId)}
                      className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800"
                    >
                      <X aria-hidden="true" className="size-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
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
  // One color per holding, shared by the table and the allocation chart.
  const colors = useMemo(
    () =>
      assignColors(
        (s?.positions ?? []).map((p) => ({
          key: p.securityId,
          value: p.valueCents,
          order: p.type === "cash" ? "~" : p.symbol,
        })),
      ),
    [s],
  );
  const slices = useMemo(() => {
    const list: { key: string; label: string; cents: number; color: string }[] = [];
    let other = 0;
    for (const p of s?.positions ?? []) {
      if (p.valueCents <= 0) continue;
      const color = colors.get(p.securityId) ?? OTHER_COLOR;
      if (color === OTHER_COLOR) other += p.valueCents;
      else
        list.push({
          key: p.securityId,
          label: p.type === "cash" ? `Cash (${p.symbol})` : p.symbol,
          cents: p.valueCents,
          color,
        });
    }
    list.sort((a, b) => b.cents - a.cents);
    if (other) list.push({ key: "other", label: "Other", cents: other, color: OTHER_COLOR });
    return list;
  }, [s, colors]);

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
            <ValueChart
              history={s.history}
              estimatedUntil={s.estimatedUntil}
              bySecurity={s.historyBySecurity}
              colors={colors}
            />
            <Card>
              <h2 className="mb-3 font-semibold">Allocation</h2>
              <div className="flex flex-col items-center gap-4">
                <Donut
                  ariaLabel="Allocation by holding"
                  size={180}
                  thickness={30}
                  slices={slices}
                />
                <ul className="w-full space-y-1 text-sm">
                  {slices.map((a) => (
                    <li key={a.key} className="flex items-center gap-2">
                      <span
                        aria-hidden="true"
                        className="size-2.5 rounded-full"
                        style={{ background: a.color }}
                      />
                      <span className="flex-1 truncate">{a.label}</span>
                      <span className="tabular-nums text-slate-500">
                        {pct(a.cents, s.valueCents)}
                      </span>
                      <span className="w-24 text-right tabular-nums">{formatMoney(a.cents)}</span>
                    </li>
                  ))}
                </ul>
                <p className="w-full text-xs text-slate-500">
                  {s.allocation
                    .map(
                      (a) => `${SECURITY_TYPE_LABELS[a.type]} ${pct(a.valueCents, s.valueCents)}`,
                    )
                    .join(" · ")}
                </p>
              </div>
            </Card>
          </div>

          <Card className="p-0">
            <h2 className="border-b border-slate-200 px-4 py-3 font-semibold dark:border-slate-800">
              Holdings
            </h2>
            {s.positions.length ? (
              <HoldingsTable positions={s.positions} total={s.valueCents} colors={colors} />
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

          <WatchList />

          <Activity accounts={s.accounts} />
        </div>
      )}

      <Modal open={importing} onClose={() => setImporting(false)} title="Import from your broker">
        {importing && <ImportDialog onClose={() => setImporting(false)} />}
      </Modal>
    </>
  );
}

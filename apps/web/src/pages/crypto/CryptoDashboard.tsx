import { type CryptoHolding, formatMoney } from "@muny/shared";
import { Link } from "@tanstack/react-router";
import { Fragment, useMemo, useState } from "react";
import {
  Donut,
  type DonutSlice,
  LineChart,
  type StackBand,
  StackLegend,
} from "../../components/charts.js";
import { CoinIcon, WalletIcon } from "../../components/coins.js";
import { Alert, Button, Card, cx } from "../../components/ui.js";
import { api } from "../../lib/api.js";
import { useCryptoMutation, useCryptoOverview, useCryptoTax } from "../../lib/queries.js";
import { assignColors, OTHER_COLOR } from "../../lib/series.js";
import { FlowsStrip, MaturityView, NftsView, TaxOptimizationView } from "./CryptoTaxViews.js";
import {
  agoTime,
  CryptoHeader,
  DismissButton,
  fmtAmount,
  fmtPrice,
  useDismissed,
} from "./common.js";

/** Crypto dashboard: total value over time, movers, allocation and holdings (Koinly-style). */

const RANGES = [
  ["1M", 31],
  ["1Y", 366],
  ["YTD", -1],
  ["All", 0],
  ["Custom", -2],
] as const;
const TABS = [
  ["overview", "Overview"],
  ["nfts", "NFTs"],
  ["tax", "Tax optimization"],
  ["maturity", "Asset maturity"],
] as const;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const SLOTS = 7;
const color = (i: number) => (i < SLOTS ? `var(--viz-series-${i + 1})` : "var(--viz-other)");

export function Pct({ v }: { v: number | null }) {
  if (v === null) return <span className="text-slate-400">—</span>;
  const up = v >= 0;
  return (
    <span
      className={up ? "text-emerald-700 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}
    >
      {up ? "▲" : "▼"} {Math.abs(v).toFixed(1)}%
    </span>
  );
}

/** A tiny trend line from daily closes (display only; green up, red down). */
export function Sparkline({
  values,
  width = 96,
  height = 28,
}: {
  values: number[];
  width?: number;
  height?: number;
}) {
  if (values.length < 2) return <span className="inline-block" style={{ width }} />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values
    .map(
      (v, i) =>
        `${((i / (values.length - 1)) * width).toFixed(1)},${(height - 2 - ((v - min) / span) * (height - 4)).toFixed(1)}`,
    )
    .join(" ");
  const up = (values[values.length - 1] ?? 0) >= (values[0] ?? 0);
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      className="inline-block"
    >
      <polyline
        points={pts}
        fill="none"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
        className={up ? "stroke-emerald-500" : "stroke-red-500"}
      />
    </svg>
  );
}

const compactUsd = (n: number) =>
  new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(n);

/** Below this a wallet's balance shows as 0 (8 decimals), so it counts as empty. */
const isDust = (amount: string) => Math.abs(Number(amount)) < 1e-8;

function HoldingRow({ h }: { h: CryptoHolding }) {
  const [open, setOpen] = useState(false);
  const [showEmpty, setShowEmpty] = useState(false);
  const held = h.wallets.filter((w) => !isDust(w.amount));
  const empty = h.wallets.length - held.length;
  const shown = showEmpty ? h.wallets : held;
  const gains = h.valueCents !== null && h.costCents !== null ? h.valueCents - h.costCents : null;
  const roi = gains !== null && h.costCents ? (gains / h.costCents) * 100 : null;
  const perUnitCost =
    h.costCents !== null && Number(h.amount) > 0 ? h.costCents / 100 / Number(h.amount) : null;
  const total = held.reduce((s, w) => s + Number(w.amount), 0);
  const share = (amount: string) => (total > 0 ? (Number(amount) / total) * 100 : 0);
  const pctLabel = (p: number) => (p === 0 ? "0%" : p < 1 ? "<1%" : `${Math.round(p)}%`);
  return (
    <>
      <tr
        className="cursor-pointer border-t border-slate-100 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/40"
        onClick={() => setOpen((o) => !o)}
      >
        <td className="w-8 py-3 pl-4">
          <button
            type="button"
            aria-expanded={open}
            aria-label={`${open ? "Hide" : "Show"} ${h.asset} details`}
            onClick={(e) => {
              e.stopPropagation();
              setOpen((o) => !o);
            }}
            className={cx("text-xs text-slate-400 transition-transform", open && "rotate-90")}
          >
            ▶
          </button>
        </td>
        <td className="py-3 pr-2">
          <span className="flex items-center gap-3">
            <CoinIcon asset={h.asset} />
            <span>
              <span className="block font-semibold">{h.asset}</span>
              <span className="text-xs text-slate-500">{h.name}</span>
            </span>
          </span>
        </td>
        <td className="px-2 text-right font-mono text-sm tabular-nums">{fmtAmount(h.amount)}</td>
        <td className="hidden px-2 text-right tabular-nums md:table-cell">
          {h.costCents !== null ? (
            <>
              <span className="block">
                {formatMoney(h.costCents)}
                {h.costIncomplete && (
                  <span
                    title="Part of the cost is unknown (missing history or prices)"
                    className="text-amber-600"
                  >
                    *
                  </span>
                )}
              </span>
              {perUnitCost !== null && (
                <span className="text-xs text-slate-500">
                  {fmtPrice(String(perUnitCost))} / unit
                </span>
              )}
            </>
          ) : (
            <span className="text-slate-400">—</span>
          )}
        </td>
        <td className="px-2 text-right tabular-nums">
          <span className="block font-medium">
            {h.valueCents !== null ? formatMoney(h.valueCents) : "—"}
          </span>
          {h.price && <span className="text-xs text-slate-500">{fmtPrice(h.price)} / unit</span>}
        </td>
        <td className="hidden px-2 text-right text-sm tabular-nums sm:table-cell">
          <Pct v={roi} />
        </td>
        <td className="py-3 pr-4 text-right text-sm tabular-nums">
          <span className="flex items-center justify-end gap-2">
            <span className="hidden lg:inline-block">
              <Sparkline values={h.spark} />
            </span>
            <Pct v={h.change24hPct} />
          </span>
        </td>
      </tr>
      {open && (
        <tr className="bg-slate-50/60 dark:bg-slate-800/30">
          <td colSpan={7} className="px-4 pt-3 pb-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <dl className="grid flex-1 grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
                {(
                  [
                    ["Price", h.price ? fmtPrice(h.price) : "—"],
                    ["Market cap", h.marketCapUsd ? compactUsd(h.marketCapUsd) : "—"],
                    ["24h", h.change24hPct !== null ? `${h.change24hPct.toFixed(1)}%` : "—"],
                    ["Share of portfolio", pctLabel(h.allocationPct)],
                    [
                      "Total cost",
                      h.costCents !== null
                        ? `${formatMoney(h.costCents)}${h.costIncomplete ? "*" : ""}`
                        : "—",
                    ],
                    ["Cost / unit", perUnitCost !== null ? fmtPrice(String(perUnitCost)) : "—"],
                    ["Total value", h.valueCents !== null ? formatMoney(h.valueCents) : "—"],
                    [
                      "Gains",
                      gains !== null
                        ? `${gains >= 0 ? "+" : "−"}${formatMoney(Math.abs(gains))}`
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
                          gains !== null &&
                          (gains >= 0
                            ? "text-emerald-700 dark:text-emerald-400"
                            : "text-red-600 dark:text-red-400"),
                      )}
                    >
                      {v}
                    </dd>
                  </div>
                ))}
              </dl>
              <div className="hidden sm:block">
                <Sparkline values={h.spark} width={200} height={56} />
                <p className="text-right text-xs text-slate-500">30 days</p>
              </div>
            </div>
            {h.costIncomplete && h.costCents !== null && (
              <p className="mt-2 text-xs text-slate-500">
                * Part of the cost is unknown: some history or prices are missing (see Reconcile).
                Cost is first-in, first-out across all wallets.
              </p>
            )}
            {held.length > 0 && (
              <div
                className="mt-4 flex h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700"
                aria-hidden="true"
              >
                {held.map((w, i) => (
                  <span
                    key={w.walletId}
                    style={{ width: `${share(w.amount)}%`, background: color(i) }}
                  />
                ))}
              </div>
            )}
            <table className="mt-3 w-full text-sm">
              <caption className="sr-only">{h.asset} by wallet</caption>
              <thead className="text-xs text-slate-500">
                <tr>
                  <th className="py-1 text-left font-medium">Wallet</th>
                  <th className="py-1 text-right font-medium">Balance</th>
                  <th className="py-1 text-right font-medium">Value</th>
                  <th className="py-1 text-right font-medium">Allocation</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200/70 dark:divide-slate-700/60">
                {shown.map((w) => {
                  const i = held.indexOf(w);
                  const zero = i < 0;
                  return (
                    <tr
                      key={w.walletId}
                      className={zero ? "text-slate-400 dark:text-slate-500" : ""}
                    >
                      <td className="py-1.5">
                        <Link
                          to="/crypto/wallets/$walletId"
                          params={{ walletId: w.walletId }}
                          className="flex items-center gap-2 hover:underline"
                        >
                          <WalletIcon
                            name={w.walletName}
                            chain={w.chain}
                            kind={w.walletKind}
                            size="sm"
                          />
                          {w.walletName}
                        </Link>
                      </td>
                      <td className="py-1.5 text-right font-mono tabular-nums">
                        {zero ? "0" : fmtAmount(w.amount)}
                      </td>
                      <td className="py-1.5 text-right tabular-nums">
                        {zero ? "—" : w.valueCents !== null ? formatMoney(w.valueCents) : "—"}
                      </td>
                      <td className="py-1.5 text-right tabular-nums">
                        <span className="inline-flex items-center gap-2">
                          {pctLabel(zero ? 0 : share(w.amount))}
                          <span
                            aria-hidden="true"
                            className="inline-block size-2.5 rounded-sm"
                            style={{ background: zero ? "transparent" : color(i) }}
                          />
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {empty > 0 && (
              <button
                type="button"
                onClick={() => setShowEmpty((v) => !v)}
                className="mt-2 text-xs text-slate-500 underline hover:text-slate-700 dark:hover:text-slate-300"
              >
                {showEmpty
                  ? "Hide empty wallets"
                  : `${empty} empty ${empty === 1 ? "wallet" : "wallets"} hidden · Show`}
              </button>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * Prices and wallets refresh on their own once a day when Crypto is opened;
 * this button updates prices now (each update is counted against the
 * provider's free request budget).
 */
function RefreshStatus() {
  const o = useCryptoOverview();
  const refresh = useCryptoMutation(() => api.post("/api/crypto/prices/refresh"));
  const d = o.data;
  if (!d || d.walletCount === 0) return null;
  const busy = d.pricesRefreshing || refresh.isPending;
  return (
    <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-xs text-slate-500">
      <span aria-live="polite">
        {d.syncing
          ? "Syncing wallets…"
          : d.walletsSyncedAt
            ? `Wallets synced ${agoTime(d.walletsSyncedAt)}`
            : null}
        {d.pricesEnabled && (
          <>
            {(d.syncing || d.walletsSyncedAt) && " · "}
            {busy ? "Updating prices…" : `Prices ${agoTime(d.pricesUpdatedAt)}`}
          </>
        )}
      </span>
      {d.pricesEnabled && (
        <Button variant="secondary" disabled={busy} onClick={() => refresh.mutate(undefined)}>
          <span className={cx("inline-block", busy && "animate-spin")}>↻</span> Refresh prices
        </Button>
      )}
      {refresh.error && <span className="text-red-600">{refresh.error.message}</span>}
    </div>
  );
}

type SortKey = "asset" | "amount" | "cost" | "value" | "roi" | "change";
type HoldingSort = { key: SortKey; desc: boolean };

/** Holdings in the chosen order; coins without a number go last either way. */
function sortHoldings(list: CryptoHolding[], s: HoldingSort): CryptoHolding[] {
  const num = (h: CryptoHolding): number | null => {
    switch (s.key) {
      case "amount":
        return Number(h.amount);
      case "cost":
        return h.costCents;
      case "value":
        return h.valueCents;
      case "roi":
        return h.costCents && h.valueCents !== null
          ? (h.valueCents - h.costCents) / h.costCents
          : null;
      case "change":
        return h.change24hPct;
      default:
        return null;
    }
  };
  return [...list].sort((a, b) => {
    if (s.key === "asset") return (s.desc ? -1 : 1) * a.asset.localeCompare(b.asset);
    const x = num(a);
    const y = num(b);
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return s.desc ? y - x : x - y;
  });
}

function SortTh({
  k,
  sort,
  setSort,
  className,
  children,
}: {
  k: SortKey;
  sort: HoldingSort;
  setSort: (s: HoldingSort) => void;
  className?: string;
  children: React.ReactNode;
}) {
  const on = sort.key === k;
  return (
    <th
      className={cx("font-medium", className)}
      aria-sort={on ? (sort.desc ? "descending" : "ascending") : "none"}
    >
      <button
        type="button"
        onClick={() => setSort({ key: k, desc: on ? !sort.desc : k !== "asset" })}
        className={cx(
          "hover:text-slate-800 dark:hover:text-slate-200",
          on && "text-slate-800 dark:text-slate-200",
        )}
      >
        {children}
        <span aria-hidden="true" className="ml-1 inline-block w-2">
          {on ? (sort.desc ? "↓" : "↑") : ""}
        </span>
      </button>
    </th>
  );
}

/** This year so far: transactions, income, realized gains, fees. */
function ThisYear() {
  const year = new Date().getFullYear();
  const t = useCryptoTax(`${year}-01-01`, new Date().toISOString().slice(0, 10));
  const s = t.data?.summary;
  const r = t.data?.realized;
  const realized = r
    ? r.short.profitCents + r.short.lossCents + r.long.profitCents + r.long.lossCents
    : null;
  return (
    <div className="mt-4 border-t border-slate-100 pt-3 dark:border-slate-800">
      <p className="mb-2 text-xs font-medium tracking-wide text-slate-500 uppercase">
        {year} so far
      </p>
      <dl className="space-y-2 text-sm">
        {(
          [
            ["Transactions", t.data ? String(t.data.txnCount) : "…"],
            ["Income", s ? formatMoney(s.incomeCents) : "…"],
            [
              "Realized gains",
              realized !== null
                ? `${realized < 0 ? "−" : ""}${formatMoney(Math.abs(realized))}`
                : "…",
            ],
            ["Fees", s ? formatMoney(s.feesCents) : "…"],
          ] as const
        ).map(([k, v]) => (
          <div key={k} className="flex justify-between">
            <dt className="text-slate-500">{k}</dt>
            <dd className="font-medium tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function CryptoDashboard() {
  const o = useCryptoOverview();
  const [range, setRange] = useState<(typeof RANGES)[number][0]>("YTD");
  const [tab, setTab] = useState<(typeof TABS)[number][0]>("overview");
  const [sort, setSort] = useState<HoldingSort>({ key: "value", desc: true });
  const [pricesGone, dismissPrices] = useDismissed("pricesOff");
  const [missingGone, dismissMissing] = useDismissed(
    `missingHistory.${o.data?.missingHistory.length ?? 0}`,
  );
  const [custom, setCustom] = useState({
    from: `${new Date().getFullYear()}-01-01`,
    to: isoDay(Date.now()),
  });
  const d = o.data;

  // The range as dates (for the chart and the flows below it).
  const [rangeFrom, rangeTo] = useMemo((): [string, string] => {
    if (range === "Custom") return [custom.from, custom.to];
    const [, days] = RANGES.find(([k]) => k === range) ?? RANGES[2];
    const today = isoDay(Date.now());
    if (days === -1) return [`${new Date().getFullYear()}-01-01`, today];
    if (days > 0) return [isoDay(Date.now() - days * 86_400_000), today];
    return ["", today];
  }, [range, custom]);
  // Indexes into the history for the chosen range (the per-coin series share them).
  const shownIdx = useMemo(
    () =>
      (d?.history ?? []).flatMap((p, i) => (p.date >= rangeFrom && p.date <= rangeTo ? [i] : [])),
    [d, rangeFrom, rangeTo],
  );
  const points = useMemo(
    () => shownIdx.map((i) => d?.history[i]).filter((p) => p !== undefined),
    [d, shownIdx],
  );
  // One color per coin (largest few, in a stable order), used by the bands and the donut.
  const coinColors = useMemo(
    () =>
      assignColors(
        (d?.holdings ?? []).map((h) => ({
          key: h.asset,
          value: h.valueCents ?? 0,
          order: h.asset,
        })),
      ),
    [d],
  );
  const stack: StackBand[] = useMemo(
    () =>
      (d?.historyByAsset ?? [])
        .map((a) => ({
          key: a.asset,
          label: a.asset,
          color: a.asset === "Other" ? OTHER_COLOR : (coinColors.get(a.asset) ?? OTHER_COLOR),
          values: shownIdx.map((i) => a.values[i] ?? 0),
        }))
        .filter((b) => b.values.some((v) => v > 0)),
    [d, shownIdx, coinColors],
  );
  const first = points[0]?.valueCents ?? 0;
  const last = d?.totalValueCents ?? 0;
  const changePct = first > 0 ? ((last - first) / first) * 100 : null;

  const slices: DonutSlice[] = [];
  if (d) {
    let rest = 0;
    for (const h of d.holdings.filter((x) => (x.valueCents ?? 0) > 0)) {
      const c = coinColors.get(h.asset) ?? OTHER_COLOR;
      if (c === OTHER_COLOR) rest += h.valueCents ?? 0;
      else slices.push({ key: h.asset, label: h.asset, cents: h.valueCents ?? 0, color: c });
    }
    if (rest > 0) slices.push({ key: "other", label: "Other", cents: rest, color: OTHER_COLOR });
  }
  const movers = (d?.holdings ?? [])
    .filter((h) => h.change24hPct !== null && (h.valueCents ?? 0) > 0)
    .map((h) => ({
      h,
      delta: Math.round(
        ((h.valueCents ?? 0) * (h.change24hPct ?? 0)) / (100 + (h.change24hPct ?? 0)),
      ),
    }))
    .sort((a, b) => Math.abs(b.h.change24hPct ?? 0) - Math.abs(a.h.change24hPct ?? 0))
    .slice(0, 5);

  return (
    <>
      <CryptoHeader actions={<RefreshStatus />} />
      {o.isError && <Alert>{o.error.message}</Alert>}
      {d && d.walletCount === 0 && (
        <Card className="text-center">
          <p className="font-medium">No crypto yet</p>
          <p className="mt-1 text-sm text-slate-500">
            Add a wallet address to sync from the blockchain, or import your Koinly history, on the{" "}
            <Link to="/crypto/wallets" className="text-brand-600 underline">
              Wallets
            </Link>{" "}
            tab.
          </p>
        </Card>
      )}
      {d && d.walletCount > 0 && (
        <div
          className="mb-4 flex flex-wrap gap-1 border-b border-slate-200 dark:border-slate-800"
          role="tablist"
        >
          {TABS.map(([k, label]) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={tab === k}
              onClick={() => setTab(k)}
              className={cx(
                "-mb-px border-b-2 px-3 py-2 text-sm",
                tab === k
                  ? "border-brand-600 font-semibold text-brand-700 dark:text-brand-500"
                  : "border-transparent text-slate-500 hover:text-slate-700 dark:hover:text-slate-300",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {d && d.walletCount > 0 && tab === "nfts" && <NftsView />}
      {d && d.walletCount > 0 && tab === "tax" && <TaxOptimizationView />}
      {d && d.walletCount > 0 && tab === "maturity" && <MaturityView />}
      {d && d.walletCount > 0 && tab === "overview" && (
        <div className="space-y-6">
          {!d.pricesEnabled && !pricesGone && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-brand-500/40 bg-brand-50 px-4 py-3 text-sm dark:bg-brand-700/15">
              <span>
                Values need prices. Turn on crypto prices to see what your crypto is worth (Muny
                only sends coin names like “bitcoin”, never balances or addresses).
              </span>
              <span className="flex items-center gap-2">
                <Link
                  to="/crypto/settings"
                  className="font-medium text-brand-700 underline dark:text-brand-500"
                >
                  Price settings
                </Link>
                <DismissButton onClick={dismissPrices} />
              </span>
            </div>
          )}
          {/* Only what needs fixing: coins without a price are listed in Reconcile. */}
          {d.missingHistory.length > 0 && !missingGone && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
              <span>
                {d.missingHistory.length} wallet{" "}
                {d.missingHistory.length === 1 ? "balance is" : "balances are"} missing history.
                Values may be off until that's sorted out.
              </span>
              <span className="flex items-center gap-2">
                <Link to="/crypto/reconcile" className="font-medium underline">
                  Review and fix
                </Link>
                <DismissButton onClick={dismissMissing} />
              </span>
            </div>
          )}

          <Card>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-sm text-slate-500">Total value</p>
                <p className="text-4xl font-semibold tracking-tight tabular-nums">
                  {formatMoney(last)}
                </p>
                {changePct !== null && (
                  <p className="text-sm">
                    <Pct v={changePct} />{" "}
                    <span className="text-slate-500">
                      {range === "YTD"
                        ? "this year"
                        : range === "All"
                          ? "since the start"
                          : range === "Custom"
                            ? "over this range"
                            : `over ${range}`}
                    </span>
                  </p>
                )}
              </div>
              <fieldset className="flex rounded-lg bg-slate-100 p-1 dark:bg-slate-800">
                <legend className="sr-only">Time range</legend>
                {RANGES.map(([k]) => (
                  <button
                    key={k}
                    type="button"
                    aria-pressed={range === k}
                    onClick={() => setRange(k)}
                    className={cx(
                      "rounded-md px-3 py-1 text-sm",
                      range === k
                        ? "bg-white font-semibold shadow-sm dark:bg-slate-900"
                        : "text-slate-500",
                    )}
                  >
                    {k}
                  </button>
                ))}
              </fieldset>
            </div>
            {range === "Custom" && (
              <div className="mt-3 flex flex-wrap items-center justify-end gap-2 text-sm">
                <input
                  type="date"
                  aria-label="From"
                  value={custom.from}
                  max={custom.to}
                  onChange={(e) =>
                    e.target.value && setCustom((c) => ({ ...c, from: e.target.value }))
                  }
                  className="rounded-lg border border-slate-300 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-950"
                />
                <span className="text-slate-500">to</span>
                <input
                  type="date"
                  aria-label="To"
                  value={custom.to}
                  min={custom.from}
                  onChange={(e) =>
                    e.target.value && setCustom((c) => ({ ...c, to: e.target.value }))
                  }
                  className="rounded-lg border border-slate-300 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-950"
                />
              </div>
            )}
            <div className="mt-4">
              {points.length > 1 ? (
                <LineChart
                  ariaLabel="Portfolio value over time"
                  height={220}
                  compareLabel="Cost basis"
                  stack={stack}
                  points={points.map((p) => ({
                    compare: p.costCents,
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
                  {d.pricesEnabled
                    ? "Price history is loading; check back in a few minutes."
                    : "Turn on prices to see your portfolio over time."}
                </p>
              )}
            </div>
            {points.length > 1 && stack.length > 0 && <StackLegend stack={stack} />}
            <FlowsStrip from={rangeFrom || undefined} to={rangeTo} />
            <p className="mt-2 text-xs text-slate-500">
              Cost is first-in, first-out across all wallets; long term means held more than a year.
              {d.pricesUpdatedAt &&
                ` Prices updated ${new Date(d.pricesUpdatedAt).toLocaleString()}.`}
            </p>
          </Card>

          <div className="grid gap-6 lg:grid-cols-3">
            <Card>
              <h2 className="mb-3 font-semibold">
                Top movers <span className="text-xs font-normal text-slate-500">24h</span>
              </h2>
              <ul className="space-y-2 text-sm">
                {movers.map(({ h, delta }) => (
                  <li key={h.asset} className="flex items-center gap-3">
                    <CoinIcon asset={h.asset} size="sm" />
                    <span className="flex-1 font-medium">{h.asset}</span>
                    <span className="tabular-nums text-slate-600 dark:text-slate-300">
                      {delta >= 0 ? "+" : "−"}
                      {formatMoney(Math.abs(delta))}
                    </span>
                    <span className="w-16 text-right tabular-nums">
                      <Pct v={h.change24hPct} />
                    </span>
                  </li>
                ))}
                {movers.length === 0 && (
                  <li className="text-slate-500">No 24h price changes yet.</li>
                )}
              </ul>
            </Card>
            <Card>
              <h2 className="mb-3 font-semibold">Allocation</h2>
              {slices.length ? (
                <div className="flex flex-wrap items-center justify-center gap-6">
                  <Donut slices={slices} ariaLabel="Allocation by coin" size={160} thickness={28}>
                    <span className="text-xs text-slate-500">{d.holdings.length} coins</span>
                  </Donut>
                  <ul className="space-y-1.5 text-sm">
                    {slices.map((s) => (
                      <li key={s.key} className="flex items-center gap-2">
                        <span
                          aria-hidden="true"
                          className="size-2.5 rounded-full"
                          style={{ background: s.color }}
                        />
                        <span className="w-14 font-medium">{s.label}</span>
                        <span className="tabular-nums text-slate-500">
                          {Math.round((s.cents / Math.max(1, last)) * 100)}%
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="text-sm text-slate-500">Needs prices.</p>
              )}
            </Card>
            <Card>
              <h2 className="mb-3 font-semibold">Summary</h2>
              <dl className="space-y-2 text-sm">
                {[
                  ["Wallets", String(d.walletCount)],
                  ["Transactions", String(d.txnCount)],
                  ["Coins held", String(d.holdings.length)],
                ].map(([k, v]) => (
                  <div key={k} className="flex justify-between">
                    <dt className="text-slate-500">{k}</dt>
                    <dd className="font-medium tabular-nums">{v}</dd>
                  </div>
                ))}
              </dl>
              <ThisYear />
              <div className="mt-4 flex gap-2">
                <Link to="/crypto/wallets">
                  <Button variant="secondary">Wallets</Button>
                </Link>
                <Link to="/crypto/transactions">
                  <Button variant="secondary">Transactions</Button>
                </Link>
              </div>
            </Card>
          </div>

          <Card className="p-0">
            <h2 className="px-4 pt-4 pb-2 font-semibold">Holdings</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-left sm:min-w-[34rem]">
                <thead className="text-xs text-slate-500">
                  <tr>
                    <th className="w-8" />
                    <SortTh k="asset" sort={sort} setSort={setSort} className="py-2 pr-2">
                      Asset
                    </SortTh>
                    <SortTh k="amount" sort={sort} setSort={setSort} className="px-2 text-right">
                      Balance
                    </SortTh>
                    <SortTh
                      k="cost"
                      sort={sort}
                      setSort={setSort}
                      className="hidden px-2 text-right md:table-cell"
                    >
                      Cost (USD)
                    </SortTh>
                    <SortTh k="value" sort={sort} setSort={setSort} className="px-2 text-right">
                      Market value
                    </SortTh>
                    <SortTh
                      k="roi"
                      sort={sort}
                      setSort={setSort}
                      className="hidden px-2 text-right sm:table-cell"
                    >
                      ROI
                    </SortTh>
                    <SortTh k="change" sort={sort} setSort={setSort} className="pr-4 text-right">
                      24h
                    </SortTh>
                  </tr>
                </thead>
                <tbody>
                  {sortHoldings(d.holdings, sort).map((h) => (
                    <Fragment key={h.asset}>
                      <HoldingRow h={h} />
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}
    </>
  );
}

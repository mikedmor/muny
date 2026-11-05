import { type CryptoHolding, formatMoney } from "@muny/shared";
import { Link } from "@tanstack/react-router";
import { Fragment, useMemo, useState } from "react";
import { Donut, type DonutSlice, LineChart } from "../../components/charts.js";
import { Alert, Button, Card, cx } from "../../components/ui.js";
import { MerchantAvatar } from "../../components/visuals.js";
import { useCryptoOverview } from "../../lib/queries.js";
import { CryptoHeader, fmtAmount, fmtPrice } from "./common.js";

/** Crypto dashboard: total value over time, movers, allocation and holdings (Koinly-style). */

const RANGES = [
  ["1M", 31],
  ["1Y", 366],
  ["YTD", -1],
  ["All", 0],
] as const;
const SLOTS = 7;
const color = (i: number) => (i < SLOTS ? `var(--viz-series-${i + 1})` : "var(--viz-other)");

function Pct({ v }: { v: number | null }) {
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

function HoldingRow({ h }: { h: CryptoHolding }) {
  const [open, setOpen] = useState(false);
  const multi = h.wallets.length > 1;
  return (
    <>
      <tr className="border-t border-slate-100 dark:border-slate-800">
        <td className="w-8 py-3 pl-4">
          {multi && (
            <button
              type="button"
              aria-expanded={open}
              aria-label={`${open ? "Hide" : "Show"} ${h.asset} by wallet`}
              onClick={() => setOpen((o) => !o)}
              className={cx("text-xs text-slate-400 transition-transform", open && "rotate-90")}
            >
              ▶
            </button>
          )}
        </td>
        <td className="py-3 pr-2">
          <span className="flex items-center gap-3">
            <MerchantAvatar name={h.asset} />
            <span>
              <span className="block font-semibold">{h.asset}</span>
              <span className="text-xs text-slate-500">{h.name}</span>
            </span>
          </span>
        </td>
        <td className="px-2 text-right font-mono text-sm tabular-nums">{fmtAmount(h.amount)}</td>
        <td className="px-2 text-right tabular-nums">
          <span className="block font-medium">
            {h.valueCents !== null ? formatMoney(h.valueCents) : "—"}
          </span>
          {h.price && <span className="text-xs text-slate-500">{fmtPrice(h.price)} / unit</span>}
        </td>
        <td className="hidden px-2 text-right text-sm tabular-nums sm:table-cell">
          {h.allocationPct > 0
            ? `${h.allocationPct < 1 ? "<1" : Math.round(h.allocationPct)}%`
            : "—"}
        </td>
        <td className="py-3 pr-4 text-right text-sm tabular-nums">
          <Pct v={h.change24hPct} />
        </td>
      </tr>
      {open &&
        h.wallets.map((w) => (
          <tr key={w.walletId} className="bg-slate-50/60 text-sm dark:bg-slate-800/30">
            <td />
            <td className="py-1.5 pl-12 text-slate-600 dark:text-slate-300">{w.walletName}</td>
            <td className="px-2 text-right font-mono tabular-nums">{fmtAmount(w.amount)}</td>
            <td colSpan={3} />
          </tr>
        ))}
    </>
  );
}

export function CryptoDashboard() {
  const o = useCryptoOverview();
  const [range, setRange] = useState<(typeof RANGES)[number][0]>("YTD");
  const d = o.data;

  const points = useMemo(() => {
    const h = d?.history ?? [];
    const [, days] = RANGES.find(([k]) => k === range) ?? RANGES[2];
    let from = "";
    if (days === -1) from = `${new Date().getFullYear()}-01-01`;
    else if (days > 0) from = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    return h.filter((p) => p.date >= from);
  }, [d, range]);
  const first = points[0]?.valueCents ?? 0;
  const last = d?.totalValueCents ?? 0;
  const changePct = first > 0 ? ((last - first) / first) * 100 : null;

  const slices: DonutSlice[] = [];
  if (d) {
    const priced = d.holdings.filter((h) => (h.valueCents ?? 0) > 0);
    for (const [i, h] of priced.slice(0, SLOTS).entries())
      slices.push({ key: h.asset, label: h.asset, cents: h.valueCents ?? 0, color: color(i) });
    const rest = priced.slice(SLOTS).reduce((s, h) => s + (h.valueCents ?? 0), 0);
    if (rest > 0) slices.push({ key: "other", label: "Other", cents: rest, color: color(SLOTS) });
  }
  const movers = (d?.holdings ?? [])
    .filter((h) => h.change24hPct !== null && (h.valueCents ?? 0) > 0)
    .map((h) => ({
      h,
      delta: Math.round(
        ((h.valueCents ?? 0) * (h.change24hPct ?? 0)) / (100 + (h.change24hPct ?? 0)),
      ),
    }))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 5);

  return (
    <>
      <CryptoHeader />
      {o.isError && <Alert>{o.error.message}</Alert>}
      {d && d.walletCount === 0 && (
        <Card className="text-center">
          <p className="font-medium">No crypto yet</p>
          <p className="mt-1 text-sm text-slate-500">
            Add a wallet or import your Koinly transaction history on the{" "}
            <Link to="/crypto/wallets" className="text-brand-600 underline">
              Wallets
            </Link>{" "}
            tab.
          </p>
        </Card>
      )}
      {d && d.walletCount > 0 && (
        <div className="space-y-6">
          {!d.pricesEnabled && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-brand-500/40 bg-brand-50 px-4 py-3 text-sm dark:bg-brand-700/15">
              <span>
                Values need prices. Turn on CoinGecko prices to see what your crypto is worth (Muny
                only sends coin names like “bitcoin”, never balances or addresses).
              </span>
              <Link
                to="/crypto/settings"
                className="font-medium text-brand-700 underline dark:text-brand-500"
              >
                Price settings
              </Link>
            </div>
          )}
          {(d.missingHistory.length > 0 || d.unpricedAssets.length > 0) && (
            <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
              {d.missingHistory.length > 0 && (
                <p>
                  <span className="font-semibold">Missing history:</span> more left these wallets
                  than arrived, so earlier transactions are missing:{" "}
                  {d.missingHistory.map((m) => `${m.asset} in ${m.walletName}`).join(", ")}. Import
                  older history or add the deposits.
                </p>
              )}
              {d.unpricedAssets.length > 0 && d.pricesEnabled && (
                <p className={d.missingHistory.length ? "mt-1" : ""}>
                  <span className="font-semibold">No price for:</span> {d.unpricedAssets.join(", ")}{" "}
                  (map them in{" "}
                  <Link to="/crypto/settings" className="underline">
                    Settings
                  </Link>
                  ).
                </p>
              )}
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
            <div className="mt-4">
              {points.length > 1 ? (
                <LineChart
                  ariaLabel="Portfolio value over time"
                  height={220}
                  points={points.map((p) => ({
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
            <p className="mt-2 border-t border-slate-100 pt-3 text-xs text-slate-500 dark:border-slate-800">
              Cost basis, unrealized and realized gains arrive with the tax engine (next phase).
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
                    <MerchantAvatar name={h.asset} size="sm" />
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
              <table className="w-full min-w-[34rem] text-left">
                <thead className="text-xs text-slate-500">
                  <tr>
                    <th className="w-8" />
                    <th className="py-2 pr-2 font-medium">Asset</th>
                    <th className="px-2 text-right font-medium">Balance</th>
                    <th className="px-2 text-right font-medium">Value (USD)</th>
                    <th className="hidden px-2 text-right font-medium sm:table-cell">Share</th>
                    <th className="pr-4 text-right font-medium">24h</th>
                  </tr>
                </thead>
                <tbody>
                  {d.holdings.map((h) => (
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

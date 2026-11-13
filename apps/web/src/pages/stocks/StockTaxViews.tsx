import {
  formatMoney,
  type RealizedByTerm,
  type StockTaxAsset,
  type StockTaxReport,
  type TaxTerm,
} from "@muny/shared";
import { Link } from "@tanstack/react-router";
import { AlertTriangle } from "lucide-react";
import { useMemo, useState } from "react";
import { Card, cx } from "../../components/ui.js";
import { fmtAmount } from "../crypto/common.js";
import { day, fx, money, tone } from "./common.js";

/**
 * The Stocks dashboard's tax views, like Crypto's: what selling would
 * realize (with wash sale warnings), and when what you hold turns long term.
 * Only taxable accounts; sale scenarios are worked out here from the lots,
 * oldest first, in exact fixed-point. Muny never sells anything.
 */

const keyOf = (a: StockTaxAsset) => `${a.accountId}|${a.securityId}`;

/** Realized gains if `shares` of a holding were sold today, oldest lots first, by term. */
function simulate(a: StockTaxAsset, shares: bigint, today: string) {
  const out: Record<TaxTerm, number> = { short: 0, long: 0, unknown: 0 };
  let unknownCost = false;
  const held = fx(a.quantity);
  if (held <= 0n) return { ...out, unknownCost };
  let left = shares;
  for (const l of a.lots) {
    if (left <= 0n) break;
    const q = fx(l.quantity);
    const take = q < left ? q : left;
    // At today's value, shared out by shares.
    const proceeds = Number((BigInt(a.valueCents) * take) / held);
    const cost = l.costCents === null ? null : Number((BigInt(l.costCents) * take) / (q || 1n));
    if (cost === null) unknownCost = true;
    const term: TaxTerm = !l.longFrom ? "unknown" : today >= l.longFrom ? "long" : "short";
    out[term] += proceeds - (cost ?? 0);
    left -= take;
  }
  return { ...out, unknownCost };
}

function GainsBox({ title, r, note }: { title: string; r: RealizedByTerm; note?: string }) {
  const net = (t: TaxTerm) => r[t].profitCents + r[t].lossCents;
  const terms: TaxTerm[] =
    r.unknown.profitCents || r.unknown.lossCents ? ["short", "long", "unknown"] : ["short", "long"];
  const total = terms.reduce((s, t) => s + net(t), 0);
  const label: Record<TaxTerm, string> = {
    short: "Short term",
    long: "Long term",
    unknown: "Not known",
  };
  return (
    <Card className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <p className="font-medium">{title}</p>
        <p className={cx("text-2xl font-semibold tabular-nums", tone(total))}>{money(total)}</p>
      </div>
      {note && <p className="text-xs text-orange-600 dark:text-orange-400">{note}</p>}
      <table className="w-full text-sm">
        <thead className="text-xs text-slate-500">
          <tr>
            <th className="text-left font-medium" />
            {terms.map((t) => (
              <th key={t} className="text-right font-medium">
                {label[t]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="tabular-nums">
          <tr>
            <td className="text-slate-500">Profit</td>
            {terms.map((t) => (
              <td key={t} className="text-right">
                {money(r[t].profitCents)}
              </td>
            ))}
          </tr>
          <tr>
            <td className="text-slate-500">Loss</td>
            {terms.map((t) => (
              <td key={t} className="text-right">
                {money(r[t].lossCents)}
              </td>
            ))}
          </tr>
          <tr className="font-semibold">
            <td>Net gains</td>
            {terms.map((t) => (
              <td key={t} className={cx("text-right", tone(net(t)))}>
                {money(net(t))}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </Card>
  );
}

/** A note on why a loss sale now would be a wash sale. */
function WashNote({ a, today }: { a: StockTaxAsset; today: string }) {
  if (!a.washUntil || !a.recentBuy) return null;
  const all = simulate(a, fx(a.quantity), today);
  if (all.short + all.long + all.unknown >= 0) return null;
  const sheltered = a.recentBuy.treatment !== "taxable";
  return (
    <span
      className="inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
      title={`Bought ${day(a.recentBuy.date)} in ${a.recentBuy.accountName}. Selling at a loss through ${day(a.washUntil)} would be a wash sale${sheltered ? ", and because that purchase was in a retirement account the loss would be lost for good" : ": the loss moves onto the new shares instead"}.`}
    >
      <AlertTriangle aria-hidden="true" className="size-3" />
      Wash sale through {day(a.washUntil)}
    </span>
  );
}

function Shelter({ r }: { r: StockTaxReport }) {
  const sheltered = r.sheltered.deferredCents + r.sheltered.exemptCents;
  if (!sheltered && !r.needsReconcile) return null;
  return (
    <p className="text-xs text-slate-500">
      {sheltered > 0 && (
        <>
          {formatMoney(sheltered)} in IRAs and other tax-advantaged accounts is left out (selling
          there isn&apos;t taxed).{" "}
          <Link to="/stocks/settings" className="text-brand-600 hover:underline">
            Check each account&apos;s tax treatment
          </Link>
          .{" "}
        </>
      )}
      {r.needsReconcile > 0 && (
        <>
          {r.needsReconcile} holding{r.needsReconcile === 1 ? " isn't" : "s aren't"} fully explained
          by your trades, so some purchase dates or costs are missing.{" "}
          <Link to="/stocks/reconcile" className="text-brand-600 hover:underline">
            Reconcile
          </Link>
        </>
      )}
    </p>
  );
}

export function StockTaxOptimization({ r }: { r: StockTaxReport }) {
  const [sell, setSell] = useState<Record<string, string>>({});
  const [find, setFind] = useState("");
  const [lossesOnly, setLossesOnly] = useState(false);
  const today = r.today;
  const rows = useMemo(
    () =>
      r.assets.filter((a) => {
        if (
          find &&
          !`${a.symbol} ${a.name} ${a.accountName}`.toLowerCase().includes(find.toLowerCase())
        )
          return false;
        if (lossesOnly) {
          const all = simulate(a, fx(a.quantity), today);
          if (all.short + all.long + all.unknown >= 0) return false;
        }
        return true;
      }),
    [r, find, lossesOnly, today],
  );
  const after = structuredClone(r.realized);
  let washRisk = 0;
  for (const a of r.assets) {
    const v = sell[keyOf(a)];
    if (v === undefined) continue;
    const q = fx(v);
    if (q <= 0n) continue;
    const g = simulate(a, q > fx(a.quantity) ? fx(a.quantity) : q, today);
    for (const t of ["short", "long", "unknown"] as const) {
      if (g[t] >= 0) after[t].profitCents += g[t];
      else after[t].lossCents += g[t];
    }
    if (a.washUntil && g.short + g.long + g.unknown < 0) washRisk++;
  }
  const harvest = r.assets.reduce((s, a) => {
    const g = simulate(a, fx(a.quantity), today);
    const total = g.short + g.long + g.unknown;
    return total < 0 ? s + total : s;
  }, 0);
  const selling = Object.keys(sell).length > 0;
  if (!r.assets.length)
    return (
      <Card className="text-sm text-slate-500">
        Nothing held in a taxable account.{" "}
        {r.accounts.length > 0 && (
          <>
            If one of your accounts is a regular brokerage account,{" "}
            <Link to="/stocks/settings" className="text-brand-600 hover:underline">
              mark it taxable
            </Link>
            .
          </>
        )}
      </Card>
    );
  return (
    <div className="space-y-4">
      <Card className="border-brand-500/40 bg-brand-50 text-sm dark:bg-brand-700/15">
        Your realized gains for {r.year} so far are on the left. Tick what you might sell (and how
        many shares) to see what it would do to your taxes, on the right. Muny sells the oldest
        shares first in each account, as most brokers do unless you pick lots; long term means held
        more than a year. A loss is a wash sale if you bought the same stock within 30 days, in any
        account. Muny never sells anything: this is only a what-if.
      </Card>
      <div className="grid gap-4 md:grid-cols-2">
        <GainsBox title={`Before (${r.year} so far)`} r={r.realized} />
        <GainsBox
          title="After the sales you picked"
          r={after}
          note={
            !selling
              ? "Pick holdings below to see the difference."
              : washRisk
                ? `${washRisk} of the losses you picked would be a wash sale (marked below), so you couldn't take them yet.`
                : undefined
          }
        />
      </div>
      <p className="text-sm text-slate-500">
        {harvest < 0 ? (
          <>
            Losses you could harvest today:{" "}
            <span className="font-medium text-red-600 dark:text-red-400">{money(harvest)}</span>{" "}
            across what you hold. Losses offset gains, then up to $3,000 a year of other income.
          </>
        ) : (
          "Nothing you hold is at a loss right now."
        )}
        {r.washCents > 0 && (
          <>
            {" "}
            This year&apos;s wash sales so far: about {formatMoney(r.washCents)} of losses deferred.
          </>
        )}
      </p>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <input
          type="search"
          value={find}
          onChange={(e) => setFind(e.target.value)}
          placeholder="Find stock or account"
          aria-label="Find stock or account"
          className="w-64 rounded-lg border border-slate-300 bg-surface px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
        />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={lossesOnly}
            onChange={(e) => setLossesOnly(e.target.checked)}
          />
          Only holdings at a loss
        </label>
      </div>
      <Card className="overflow-x-auto p-0">
        <table className="w-full min-w-[60rem] text-sm">
          <thead className="text-xs text-slate-500">
            <tr className="border-b border-slate-200 dark:border-slate-800">
              <th className="w-8 px-3 py-2" />
              <th className="px-2 py-2 text-left font-medium">Holding</th>
              <th className="px-2 py-2 text-right font-medium">Shares</th>
              <th className="px-2 py-2 text-right font-medium">Value</th>
              <th className="border-l border-slate-200 px-2 py-2 text-right font-medium dark:border-slate-800">
                Short-term gain
              </th>
              <th className="px-2 py-2 text-right font-medium">Short-term shares</th>
              <th className="border-l border-slate-200 px-2 py-2 text-right font-medium dark:border-slate-800">
                Long-term gain
              </th>
              <th className="px-2 py-2 text-right font-medium">Long-term shares</th>
              <th className="border-l border-slate-200 px-2 py-2 text-right font-medium dark:border-slate-800">
                Shares to sell
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 tabular-nums dark:divide-slate-800">
            {rows.map((a) => {
              const k = keyOf(a);
              const s = simulate(a, fx(a.quantity), today);
              const picked = sell[k] !== undefined;
              const unknown = fx(a.unknown.quantity) > 0n;
              return (
                <tr key={k} className={cx(picked && "bg-orange-50/60 dark:bg-orange-950/20")}>
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      aria-label={`Sell ${a.symbol} in ${a.accountName}`}
                      checked={picked}
                      onChange={(e) =>
                        setSell((x) => {
                          const n = { ...x };
                          if (e.target.checked) n[k] = a.quantity;
                          else delete n[k];
                          return n;
                        })
                      }
                    />
                  </td>
                  <td className="px-2 py-2">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <Link
                        to="/stocks/$symbol"
                        params={{ symbol: a.symbol }}
                        className="font-medium hover:underline"
                      >
                        {a.symbol}
                      </Link>
                      {(a.missingCost || unknown) && (
                        <span
                          className="text-xs text-amber-600"
                          title={
                            a.missingCost
                              ? "Some shares have no known cost: their gain is uncertain. See Reconcile."
                              : "Some shares were bought before your history: their holding period isn't known."
                          }
                        >
                          *
                        </span>
                      )}
                      <WashNote a={a} today={today} />
                    </span>
                    <span className="block text-xs text-slate-500">{a.accountName}</span>
                  </td>
                  <td className="px-2 py-2 text-right font-mono">{fmtAmount(a.quantity, 4)}</td>
                  <td className="px-2 py-2 text-right">{formatMoney(a.valueCents)}</td>
                  <td
                    className={cx(
                      "border-l border-slate-100 px-2 py-2 text-right dark:border-slate-800",
                      tone(s.short),
                    )}
                  >
                    {fx(a.short.quantity) > 0n ? money(s.short) : "—"}
                  </td>
                  <td className="px-2 py-2 text-right font-mono text-slate-500">
                    {fmtAmount(a.short.quantity, 4)}
                  </td>
                  <td
                    className={cx(
                      "border-l border-slate-100 px-2 py-2 text-right dark:border-slate-800",
                      tone(s.long),
                    )}
                  >
                    {fx(a.long.quantity) > 0n ? money(s.long) : "—"}
                  </td>
                  <td className="px-2 py-2 text-right font-mono text-slate-500">
                    {fmtAmount(a.long.quantity, 4)}
                    {unknown && (
                      <span className="block text-[11px]" title="Holding period not known">
                        +{fmtAmount(a.unknown.quantity, 4)} ?
                      </span>
                    )}
                  </td>
                  <td className="border-l border-slate-100 px-2 py-2 text-right dark:border-slate-800">
                    {picked ? (
                      <input
                        inputMode="decimal"
                        aria-label={`Shares of ${a.symbol} to sell`}
                        value={sell[k]}
                        onChange={(e) =>
                          setSell((x) => ({ ...x, [k]: e.target.value.replace(/[^0-9.]/g, "") }))
                        }
                        className="w-28 rounded border border-orange-300 bg-surface px-2 py-1 text-right font-mono text-xs dark:border-orange-800 dark:bg-slate-950"
                      />
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
      <Shelter r={r} />
    </div>
  );
}

export function StockMaturity({ r }: { r: StockTaxReport }) {
  const today = r.today;
  const total = r.assets.reduce((s, a) => s + a.valueCents, 0);
  const part = (t: "short" | "long" | "unknown") => {
    let value = 0;
    let gain = 0;
    for (const a of r.assets) {
      value += a[t].valueCents ?? 0;
      gain += (a[t].valueCents ?? 0) - a[t].costCents;
    }
    return { value, gain };
  };
  const short = part("short");
  const long = part("long");
  const unknown = part("unknown");
  const w = 1200;
  const h = 200;
  const pts = r.maturity.map(
    (m, i) => [(i / Math.max(1, r.maturity.length - 1)) * w, h - (m.longPct / 100) * h] as const,
  );
  const area = `M0,${h} ${pts.map(([x, y]) => `L${x.toFixed(1)},${y.toFixed(1)}`).join(" ")} L${w},${h} Z`;
  if (!r.assets.length)
    return <Card className="text-sm text-slate-500">Nothing held in a taxable account.</Card>;
  return (
    <div className="space-y-4">
      <div className={cx("grid gap-4", unknown.value ? "sm:grid-cols-4" : "sm:grid-cols-3")}>
        <Card>
          <p className="text-sm text-slate-500">Value in taxable accounts</p>
          <p className="text-2xl font-semibold tabular-nums">{formatMoney(total)}</p>
        </Card>
        <Card>
          <p className="text-sm text-slate-500">Short term (held a year or less)</p>
          <p className="text-2xl font-semibold tabular-nums">{formatMoney(short.value)}</p>
          <p className={cx("text-sm tabular-nums", tone(short.gain))}>
            {money(short.gain)} unrealized
          </p>
        </Card>
        <Card>
          <p className="text-sm text-slate-500">Long term (held more than a year)</p>
          <p className="text-2xl font-semibold tabular-nums">{formatMoney(long.value)}</p>
          <p className={cx("text-sm tabular-nums", tone(long.gain))}>
            {money(long.gain)} unrealized
          </p>
        </Card>
        {unknown.value > 0 && (
          <Card>
            <p className="text-sm text-slate-500">Purchase date not known</p>
            <p className="text-2xl font-semibold tabular-nums">{formatMoney(unknown.value)}</p>
            <Link to="/stocks/reconcile" className="text-sm text-brand-600 hover:underline">
              Fill in the history
            </Link>
          </Card>
        )}
      </div>
      <Card>
        <h2 className="mb-2 font-semibold">Share held long term, over the next year</h2>
        <svg
          viewBox={`0 0 ${w} ${h + 20}`}
          className="w-full"
          role="img"
          aria-label="Long-term share by month"
        >
          <path d={area} fill="var(--viz-series-1)" fillOpacity="0.15" />
          <polyline
            points={pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ")}
            fill="none"
            stroke="var(--viz-series-1)"
            strokeWidth="2"
          />
          {r.maturity.map((m, i) =>
            i % 2 === 0 ? (
              <text
                key={m.date}
                x={(i / Math.max(1, r.maturity.length - 1)) * w}
                y={h + 15}
                textAnchor={i === 0 ? "start" : i === r.maturity.length - 1 ? "end" : "middle"}
                className="fill-slate-500 text-[10px]"
              >
                {i === 0
                  ? "Now"
                  : new Date(`${m.date}T00:00:00`).toLocaleDateString(undefined, {
                      month: "short",
                      year: "2-digit",
                    })}
              </text>
            ) : null,
          )}
        </svg>
        <p className="mt-1 text-xs text-slate-500">
          At today&apos;s prices: {Math.round(r.maturity[0]?.longPct ?? 0)}% long term now,{" "}
          {Math.round(r.maturity.at(-1)?.longPct ?? 0)}% in a year if you hold everything
          {unknown.value > 0 ? " (shares with no known purchase date aren't counted)" : ""}.
        </p>
      </Card>
      <Card className="overflow-x-auto p-0">
        <table className="w-full min-w-[48rem] text-sm">
          <thead className="text-xs text-slate-500">
            <tr className="border-b border-slate-200 dark:border-slate-800">
              <th className="px-3 py-2 text-left font-medium">Holding</th>
              <th className="px-2 py-2 text-right font-medium">Value</th>
              <th className="px-2 py-2 text-right font-medium">Short term</th>
              <th className="px-2 py-2 text-right font-medium">Long term</th>
              <th className="px-2 py-2 text-left font-medium">Next to turn long term</th>
              <th className="px-3 py-2 text-left font-medium">Short vs long</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 tabular-nums dark:divide-slate-800">
            {r.assets.map((a) => {
              const all = fx(a.quantity);
              const pct = all > 0n ? Number((fx(a.long.quantity) * 1000n) / all) / 10 : 0;
              const next = a.lots
                .filter((l) => l.longFrom && l.longFrom > today)
                .sort((x, y) => (x.longFrom ?? "").localeCompare(y.longFrom ?? ""))[0];
              return (
                <tr key={keyOf(a)}>
                  <td className="px-3 py-2">
                    <Link
                      to="/stocks/$symbol"
                      params={{ symbol: a.symbol }}
                      className="font-medium hover:underline"
                    >
                      {a.symbol}
                    </Link>
                    <span className="block text-xs text-slate-500">{a.accountName}</span>
                  </td>
                  <td className="px-2 py-2 text-right">{formatMoney(a.valueCents)}</td>
                  <td className="px-2 py-2 text-right font-mono">
                    {fmtAmount(a.short.quantity, 4)}
                  </td>
                  <td className="px-2 py-2 text-right font-mono">
                    {fmtAmount(a.long.quantity, 4)}
                  </td>
                  <td className="px-2 py-2 text-xs text-slate-500">
                    {next
                      ? `${fmtAmount(next.quantity, 4)} on ${day(next.longFrom)}`
                      : fx(a.short.quantity) > 0n
                        ? "—"
                        : fx(a.unknown.quantity) > 0n
                          ? "purchase dates not known"
                          : "all long term"}
                  </td>
                  <td className="px-3 py-2">
                    <div
                      className="flex h-2 w-40 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700"
                      title={`${pct}% long term`}
                    >
                      <div className="bg-emerald-500" style={{ width: `${pct}%` }} />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
      <Shelter r={r} />
    </div>
  );
}

/** On a stock's page: its lots in taxable accounts, with each one's holding period. */
export function StockLotsCard({ r, securityId }: { r: StockTaxReport; securityId: string }) {
  const mine = r.assets.filter((a) => a.securityId === securityId);
  const lots = mine.flatMap((a) =>
    a.lots.map((l) => ({
      ...l,
      valueCents: Number((BigInt(a.valueCents) * fx(l.quantity)) / (fx(a.quantity) || 1n)),
    })),
  );
  if (!lots.length) return null;
  const today = r.today;
  return (
    <Card className="p-0">
      <div className="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <h2 className="font-semibold">Tax lots</h2>
        <p className="text-xs text-slate-500">
          In taxable accounts, oldest first (sold first). Long term after a year.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[36rem] text-sm">
          <thead className="text-xs text-slate-500">
            <tr>
              <th className="px-4 py-2 text-left font-medium">Bought</th>
              <th className="px-2 py-2 text-right font-medium">Shares</th>
              <th className="px-2 py-2 text-right font-medium">Cost</th>
              <th className="px-2 py-2 text-right font-medium">Gain</th>
              <th className="px-4 py-2 text-left font-medium">Term</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 tabular-nums dark:divide-slate-800">
            {lots.map((l) => {
              const gain = l.costCents === null ? null : l.valueCents - l.costCents;
              const long = !!l.longFrom && today >= l.longFrom;
              return (
                <tr key={`${l.accountId}|${l.acquired}|${l.quantity}|${l.costCents}`}>
                  <td className="px-4 py-2">
                    {l.acquired ? day(l.acquired) : "Before your history"}
                    {mine.length > 1 && (
                      <span className="block text-xs text-slate-500">{l.accountName}</span>
                    )}
                  </td>
                  <td className="px-2 py-2 text-right font-mono">{fmtAmount(l.quantity, 4)}</td>
                  <td className="px-2 py-2 text-right">
                    {l.costCents === null ? "—" : formatMoney(l.costCents)}
                  </td>
                  <td className={cx("px-2 py-2 text-right", gain !== null && tone(gain))}>
                    {gain === null ? "—" : money(gain)}
                  </td>
                  <td className="px-4 py-2 text-xs">
                    {!l.longFrom ? (
                      <span className="text-slate-500">Not known</span>
                    ) : long ? (
                      <span className="text-emerald-600 dark:text-emerald-400">Long term</span>
                    ) : (
                      <span className="text-slate-500">Short term until {day(l.longFrom)}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

import { type CryptoTaxReport, formatMoney } from "@muny/shared";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { CoinIcon, WalletIcon } from "../../components/coins.js";
import { Card, cx } from "../../components/ui.js";
import { useCryptoNfts, useCryptoSettings, useCryptoTax } from "../../lib/queries.js";
import { DismissButton, fmtAmount, useDismissed } from "./common.js";

/**
 * The dashboard's other views (Koinly-style): the range's money flows, NFTs,
 * tax optimization (what selling would realize) and asset maturity (short vs
 * long term). All read-only; sale scenarios are worked out in the browser
 * from the tax lots, in exact fixed-point like the server.
 */

// ---- exact decimals (18 places) ------------------------------------------------
const SCALE = 10n ** 18n;
function fx(s: string | null | undefined): bigint {
  if (!s) return 0n;
  const neg = s.startsWith("-");
  const [w = "0", f = ""] = (neg ? s.slice(1) : s).split(".");
  const v = BigInt(w || "0") * SCALE + BigInt((f + "0".repeat(18)).slice(0, 18) || "0");
  return neg ? -v : v;
}
/** Cents of `amount` (fixed) at `price` USD. */
const cents = (amount: bigint, price: string) => Number((amount * fx(price)) / 10n ** 34n);

const money = (c: number) => (c < 0 ? `−${formatMoney(-c)}` : formatMoney(c));
const tone = (c: number) =>
  c > 0
    ? "text-emerald-600 dark:text-emerald-400"
    : c < 0
      ? "text-red-600 dark:text-red-400"
      : "text-slate-500";

// ---- In / Out / Income / Expenses / Fees / Realized ------------------------------
export function FlowsStrip({ from, to }: { from?: string; to?: string }) {
  const q = useCryptoTax(from, to);
  const s = q.data?.summary;
  const cells: [string, number | undefined, string][] = [
    ["In", s?.inCents, "Deposits from outside your wallets (not income)"],
    ["Out", s?.outCents, "Withdrawals to outside your wallets"],
    ["Income", s?.incomeCents, "Rewards, staking, mining, airdrops and other income"],
    ["Expenses", s?.expensesCents, "Coins spent (tagged Cost)"],
    ["Fees", s?.feesCents, "Network and trading fees"],
    ["Realized gains", s?.realizedCents, "Gains and losses from sales, spending and fees (FIFO)"],
  ];
  return (
    <div className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 sm:grid-cols-3 lg:grid-cols-6 dark:border-slate-800 dark:bg-slate-800">
      {cells.map(([label, v, title]) => (
        <div key={label} className="bg-surface px-3 py-2 dark:bg-slate-900" title={title}>
          <p className="text-xs text-slate-500">{label}</p>
          <p
            className={cx(
              "font-semibold tabular-nums",
              label === "Realized gains" && v !== undefined && tone(v),
            )}
          >
            {v === undefined ? "…" : money(v)}
          </p>
        </div>
      ))}
    </div>
  );
}

// ---- NFTs -----------------------------------------------------------------------
const EXPLORER: Record<string, string> = {
  eth: "https://eth.blockscout.com",
  base: "https://base.blockscout.com",
  op: "https://optimism.blockscout.com",
  arb: "https://arbitrum.blockscout.com",
  polygon: "https://polygon.blockscout.com",
  gnosis: "https://gnosis.blockscout.com",
};
/** A short fingerprint of the image link: a new image gets a new address (no stale cache). */
const imageVersion = (u: string) => {
  let h = 0;
  for (let i = 0; i < u.length; i++) h = (h * 31 + u.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};

export function NftsView() {
  const q = useCryptoNfts();
  const settings = useCryptoSettings();
  const images = !!settings.data?.nftImages;
  const [dismissed, dismiss] = useDismissed("nftImagesOff");
  const list = q.data ?? [];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-500">
          NFTs in your synced Ethereum-style wallets (Ethereum, Polygon, Base, Optimism, Arbitrum,
          Gnosis), as of each wallet&apos;s last sync. Domains (e.g. Unstoppable Domains) are NFTs
          too: if yours lives on Polygon, add the same address as a Polygon wallet.
        </p>
      </div>
      {!images && !dismissed && list.some((n) => n.image) && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-2 text-sm dark:border-slate-700 dark:bg-slate-900">
          <span>
            NFT images are off: they live on other sites. Turn them on in{" "}
            <Link to="/crypto/settings" className="text-brand-600 underline">
              Crypto settings
            </Link>
            ; your Muny server then fetches them for you.
          </span>
          <DismissButton onClick={dismiss} />
        </div>
      )}
      {q.isSuccess && list.length === 0 && (
        <Card className="py-10 text-center text-sm text-slate-500">
          No NFTs found yet. They appear after a sync of an Ethereum-style wallet that holds them.
        </Card>
      )}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {list.map((n) => {
          const link = n.chain && EXPLORER[n.chain];
          return (
            <Card key={`${n.walletId}:${n.contract}:${n.tokenId}`} className="space-y-2 p-3">
              <div className="flex aspect-square items-center justify-center overflow-hidden rounded-lg bg-slate-100 dark:bg-slate-800">
                {images && n.image ? (
                  <img
                    src={`/api/crypto/nft-image?${new URLSearchParams({ w: n.walletId, c: n.contract, t: n.tokenId, v: imageVersion(n.image) })}`}
                    alt={n.name ?? "NFT"}
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <span className="text-3xl text-slate-400" aria-hidden="true">
                    ◈
                  </span>
                )}
              </div>
              <p className="truncate font-medium" title={n.name ?? undefined}>
                {n.name ?? `#${n.tokenId.length > 12 ? `${n.tokenId.slice(0, 10)}…` : n.tokenId}`}
              </p>
              <p className="truncate text-xs text-slate-500">
                {n.collection ?? n.contract}
                {n.amount !== "1" && ` · ×${n.amount}`}
              </p>
              <p className="flex items-center justify-between gap-2 text-xs text-slate-500">
                <span className="flex min-w-0 items-center gap-1">
                  <WalletIcon name={n.walletName} chain={n.chain} kind="blockchain" size="sm" />
                  <span className="truncate">{n.walletName}</span>
                </span>
                {link && (
                  <a
                    href={`${link}/token/${n.contract}/instance/${encodeURIComponent(n.tokenId)}`}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-brand-600 hover:underline"
                  >
                    View ↗
                  </a>
                )}
              </p>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

// ---- Tax optimization ------------------------------------------------------------
type Asset = CryptoTaxReport["assets"][number];

/** Realized gains if `amount` of the asset were sold now (FIFO lots), by term. */
function simulate(a: Asset, amount: bigint, now: number) {
  let left = amount;
  let short = 0;
  let long = 0;
  if (!a.priceUsd) return { short, long };
  for (const l of a.lots) {
    if (left <= 0n) break;
    const lotAmt = fx(l.amount);
    const take = lotAmt < left ? lotAmt : left;
    const cost = Number((BigInt(l.costCents) * take) / (lotAmt || 1n));
    const gain = cents(take, a.priceUsd) - cost;
    if (now >= l.longFrom) long += gain;
    else short += gain;
    left -= take;
  }
  return { short, long };
}

function GainsBox({
  title,
  r,
  note,
}: {
  title: string;
  r: CryptoTaxReport["realized"];
  note?: string;
}) {
  const net = (t: "short" | "long") => r[t].profitCents + r[t].lossCents;
  const total = net("short") + net("long");
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
            <th className="text-right font-medium">Short term</th>
            <th className="text-right font-medium">Long term</th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          <tr>
            <td className="text-slate-500">Profit</td>
            <td className="text-right">{money(r.short.profitCents)}</td>
            <td className="text-right">{money(r.long.profitCents)}</td>
          </tr>
          <tr>
            <td className="text-slate-500">Loss</td>
            <td className="text-right">{money(r.short.lossCents)}</td>
            <td className="text-right">{money(r.long.lossCents)}</td>
          </tr>
          <tr className="font-semibold">
            <td>Net gains</td>
            <td className={cx("text-right", tone(net("short")))}>{money(net("short"))}</td>
            <td className={cx("text-right", tone(net("long")))}>{money(net("long"))}</td>
          </tr>
        </tbody>
      </table>
    </Card>
  );
}

export function TaxOptimizationView() {
  const q = useCryptoTax();
  const [sell, setSell] = useState<Record<string, string>>({});
  const [find, setFind] = useState("");
  const [unpriced, setUnpriced] = useState(false);
  const [positive, setPositive] = useState(true);
  const now = Date.now();
  const r = q.data;
  const rows = useMemo(
    () =>
      (r?.assets ?? []).filter((a) => {
        if (!unpriced && !a.priceUsd) return false;
        if (find && !`${a.asset} ${a.name}`.toLowerCase().includes(find.toLowerCase()))
          return false;
        if (!positive && a.priceUsd) {
          const all = simulate(a, fx(a.amount), now);
          if (all.short + all.long >= 0) return false;
        }
        return true;
      }),
    [r, unpriced, positive, find, now],
  );
  if (!r)
    return <p className="text-sm text-slate-500">{q.isError ? q.error.message : "Loading…"}</p>;
  const after = structuredClone(r.realized);
  for (const a of r.assets) {
    const v = sell[a.asset];
    if (v === undefined) continue;
    const amt = fx(v);
    if (amt <= 0n) continue;
    const g = simulate(a, amt > fx(a.amount) ? fx(a.amount) : amt, now);
    for (const t of ["short", "long"] as const) {
      if (g[t] >= 0) after[t].profitCents += g[t];
      else after[t].lossCents += g[t];
    }
  }
  const selling = Object.keys(sell).length > 0;
  return (
    <div className="space-y-4">
      <Card className="border-brand-500/40 bg-brand-50 text-sm dark:bg-brand-700/15">
        Your realized gains for {r.year} so far are on the left. Tick the coins you might sell (and
        how much) to see what that would do to your taxes, on the right. Gains are first-in,
        first-out across all wallets; long term means held more than a year. Muny never sells
        anything: this is only a what-if.
      </Card>
      <div className="grid gap-4 md:grid-cols-2">
        <GainsBox title={`Before (${r.year} so far)`} r={r.realized} />
        <GainsBox
          title="After the sales you picked"
          r={after}
          note={selling ? undefined : "Pick coins below to see the difference."}
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <input
          type="search"
          value={find}
          onChange={(e) => setFind(e.target.value)}
          placeholder="Find coin"
          aria-label="Find coin"
          className="w-56 rounded-lg border border-slate-300 bg-surface px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
        />
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={unpriced}
              onChange={(e) => setUnpriced(e.target.checked)}
            />
            Coins with no price
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={positive}
              onChange={(e) => setPositive(e.target.checked)}
            />
            Coins with gains
          </label>
        </div>
      </div>
      <Card className="overflow-x-auto p-0">
        <table className="w-full min-w-[56rem] text-sm">
          <thead className="text-xs text-slate-500">
            <tr className="border-b border-slate-200 dark:border-slate-800">
              <th className="w-8 px-3 py-2" />
              <th className="px-2 py-2 text-left font-medium">Coin</th>
              <th className="px-2 py-2 text-right font-medium">Held</th>
              <th className="px-2 py-2 text-right font-medium">Price</th>
              <th className="px-2 py-2 text-right font-medium">Value</th>
              <th className="border-l border-slate-200 px-2 py-2 text-right font-medium dark:border-slate-800">
                Short-term gain
              </th>
              <th className="px-2 py-2 text-right font-medium">Short-term held</th>
              <th className="border-l border-slate-200 px-2 py-2 text-right font-medium dark:border-slate-800">
                Long-term gain
              </th>
              <th className="px-2 py-2 text-right font-medium">Long-term held</th>
              <th className="border-l border-slate-200 px-2 py-2 text-right font-medium dark:border-slate-800">
                Amount to sell
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 tabular-nums dark:divide-slate-800">
            {rows.map((a) => {
              const s = a.priceUsd
                ? simulate(a, fx(a.short.amount) + fx(a.long.amount), now)
                : null;
              const picked = sell[a.asset] !== undefined;
              return (
                <tr key={a.asset} className={cx(picked && "bg-orange-50/60 dark:bg-orange-950/20")}>
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      aria-label={`Sell ${a.asset}`}
                      checked={picked}
                      disabled={!a.priceUsd}
                      onChange={(e) =>
                        setSell((x) => {
                          const n = { ...x };
                          if (e.target.checked) n[a.asset] = a.amount;
                          else delete n[a.asset];
                          return n;
                        })
                      }
                    />
                  </td>
                  <td className="px-2 py-2">
                    <span className="flex items-center gap-2">
                      <CoinIcon asset={a.asset} size="sm" />
                      <span className="font-medium">{a.name}</span>
                      <span className="text-xs text-slate-500">{a.asset}</span>
                      {a.missingCost && (
                        <span
                          className="text-xs text-amber-600"
                          title="Some of it has no known cost (missing purchase history or prices): gains are overstated."
                        >
                          *
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="px-2 py-2 text-right font-mono">{fmtAmount(a.amount, 4)}</td>
                  <td className="px-2 py-2 text-right">
                    {a.priceUsd ? `$${fmtAmount(a.priceUsd, 4)}` : "—"}
                  </td>
                  <td className="px-2 py-2 text-right">
                    {a.valueCents !== null ? formatMoney(a.valueCents) : "—"}
                  </td>
                  <td
                    className={cx(
                      "border-l border-slate-100 px-2 py-2 text-right dark:border-slate-800",
                      s && tone(s.short),
                    )}
                  >
                    {s ? money(s.short) : "—"}
                  </td>
                  <td className="px-2 py-2 text-right font-mono text-slate-500">
                    {fmtAmount(a.short.amount, 4)}
                  </td>
                  <td
                    className={cx(
                      "border-l border-slate-100 px-2 py-2 text-right dark:border-slate-800",
                      s && tone(s.long),
                    )}
                  >
                    {s ? money(s.long) : "—"}
                  </td>
                  <td className="px-2 py-2 text-right font-mono text-slate-500">
                    {fmtAmount(a.long.amount, 4)}
                  </td>
                  <td className="border-l border-slate-100 px-2 py-2 text-right dark:border-slate-800">
                    {picked ? (
                      <input
                        inputMode="decimal"
                        aria-label={`Amount of ${a.asset} to sell`}
                        value={sell[a.asset]}
                        onChange={(e) =>
                          setSell((x) => ({
                            ...x,
                            [a.asset]: e.target.value.replace(/[^0-9.]/g, ""),
                          }))
                        }
                        className="w-32 rounded border border-orange-300 bg-surface px-2 py-1 text-right font-mono text-xs dark:border-orange-800 dark:bg-slate-950"
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
    </div>
  );
}

// ---- Asset maturity --------------------------------------------------------------
export function MaturityView() {
  const q = useCryptoTax();
  const r = q.data;
  if (!r)
    return <p className="text-sm text-slate-500">{q.isError ? q.error.message : "Loading…"}</p>;
  const now = Date.now();
  const total = r.assets.reduce((s, a) => s + (a.valueCents ?? 0), 0);
  const part = (t: "short" | "long") => {
    let value = 0;
    let gain = 0;
    for (const a of r.assets) {
      if (!a.priceUsd) continue;
      value += a[t].valueCents ?? 0;
      gain += (a[t].valueCents ?? 0) - a[t].costCents;
    }
    return { value, gain };
  };
  const short = part("short");
  const long = part("long");
  const w = 1200;
  const h = 200;
  const pts = r.maturity.map(
    (m, i) => [(i / (r.maturity.length - 1)) * w, h - (m.longPct / 100) * h] as const,
  );
  const path = `M0,${h} ${pts.map(([x, y]) => `L${x.toFixed(1)},${y.toFixed(1)}`).join(" ")} L${w},${h} Z`;
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <p className="text-sm text-slate-500">Total value</p>
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
      </div>
      <Card>
        <h2 className="mb-2 font-semibold">Share held long term, over the next year</h2>
        <svg
          viewBox={`0 0 ${w} ${h + 20}`}
          className="w-full"
          role="img"
          aria-label="Long-term share by month"
        >
          <path d={path} fill="var(--viz-series-1)" fillOpacity="0.15" />
          <polyline
            points={pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ")}
            fill="none"
            stroke="var(--viz-series-1)"
            strokeWidth="2"
          />
          {r.maturity.map((m, i) =>
            i % 2 === 0 ? (
              <text
                key={m.at}
                x={(i / (r.maturity.length - 1)) * w}
                y={h + 15}
                textAnchor={i === 0 ? "start" : i === r.maturity.length - 1 ? "end" : "middle"}
                className="fill-slate-500 text-[10px]"
              >
                {i === 0
                  ? "Now"
                  : new Date(m.at).toLocaleDateString(undefined, {
                      month: "short",
                      year: "2-digit",
                    })}
              </text>
            ) : null,
          )}
        </svg>
        <p className="mt-1 text-xs text-slate-500">
          At today&apos;s prices: {Math.round(r.maturity[0]?.longPct ?? 0)}% long term now,{" "}
          {Math.round(r.maturity.at(-1)?.longPct ?? 0)}% in a year if you hold everything.
        </p>
      </Card>
      <Card className="overflow-x-auto p-0">
        <table className="w-full min-w-[48rem] text-sm">
          <thead className="text-xs text-slate-500">
            <tr className="border-b border-slate-200 dark:border-slate-800">
              <th className="px-3 py-2 text-left font-medium">Coin</th>
              <th className="px-2 py-2 text-right font-medium">Value</th>
              <th className="px-2 py-2 text-right font-medium">Short term</th>
              <th className="px-2 py-2 text-right font-medium">Long term</th>
              <th className="px-2 py-2 text-left font-medium">Next to turn long term</th>
              <th className="px-3 py-2 text-left font-medium">Short vs long</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 tabular-nums dark:divide-slate-800">
            {r.assets.map((a) => {
              const lt = fx(a.long.amount);
              const all = fx(a.amount);
              const pct = all > 0n ? Number((lt * 1000n) / all) / 10 : 0;
              const next = a.lots.find((l) => l.longFrom > now);
              return (
                <tr key={a.asset}>
                  <td className="px-3 py-2">
                    <span className="flex items-center gap-2">
                      <CoinIcon asset={a.asset} size="sm" />
                      <span className="font-medium">{a.asset}</span>
                    </span>
                  </td>
                  <td className="px-2 py-2 text-right">
                    {a.valueCents !== null ? formatMoney(a.valueCents) : "—"}
                  </td>
                  <td className="px-2 py-2 text-right font-mono">{fmtAmount(a.short.amount, 4)}</td>
                  <td className="px-2 py-2 text-right font-mono">{fmtAmount(a.long.amount, 4)}</td>
                  <td className="px-2 py-2 text-xs text-slate-500">
                    {next
                      ? `${fmtAmount(next.amount, 4)} on ${new Date(next.longFrom).toLocaleDateString()}`
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
    </div>
  );
}

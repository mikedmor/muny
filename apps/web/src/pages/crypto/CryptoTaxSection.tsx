import { CRYPTO_TAX_REPORTS, type CryptoTaxDoc, formatMoney } from "@muny/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { RotateCcw } from "lucide-react";
import { useState } from "react";
import { CoinIcon, WalletIcon } from "../../components/coins.js";
import { Alert, Button, Card, cx } from "../../components/ui.js";
import { api } from "../../lib/api.js";
import {
  useCryptoMutation,
  useCryptoOverview,
  useCryptoTax,
  useCryptoTxns,
  useCryptoWallets,
} from "../../lib/queries.js";
import { fmtAmount } from "./common.js";

/**
 * Crypto on the main pages: a card for the Overview, and the tax year's
 * crypto for the Taxes page (Koinly's tax summary, reports and 1099-DA forms).
 */

const money = (c: number) => (c < 0 ? `−${formatMoney(-c)}` : formatMoney(c));

// ---- Overview card ----------------------------------------------------------------
export function CryptoOverviewCard() {
  const o = useCryptoOverview();
  const year = new Date().getFullYear();
  const tax = useCryptoTax(`${year}-01-01`, new Date().toISOString().slice(0, 10));
  const recent = useCryptoTxns({ limit: 5, offset: 0 });
  const d = o.data;
  if (!d || d.walletCount === 0) return null;
  const top = d.holdings.filter((h) => (h.valueCents ?? 0) > 0).slice(0, 4);
  // 24h change of the whole portfolio, from each coin's change.
  const before = d.holdings.reduce((s, h) => {
    const v = h.valueCents ?? 0;
    return s + (h.change24hPct !== null ? v / (1 + h.change24hPct / 100) : v);
  }, 0);
  const pct = before > 0 ? ((d.totalValueCents - before) / before) * 100 : null;
  const r = tax.data?.realized;
  const realized = r
    ? r.short.profitCents + r.short.lossCents + r.long.profitCents + r.long.lossCents
    : null;
  return (
    <Card className="space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="font-semibold">Crypto</h2>
        <Link to="/crypto" className="text-sm text-brand-600 hover:underline">
          Open Crypto →
        </Link>
      </div>
      <div>
        <p className="text-2xl font-semibold tabular-nums">{formatMoney(d.totalValueCents)}</p>
        {pct !== null && (
          <p className={cx("text-sm tabular-nums", pct >= 0 ? "text-emerald-600" : "text-red-600")}>
            {pct >= 0 ? "▲" : "▼"} {Math.abs(pct).toFixed(1)}% today
          </p>
        )}
      </div>
      <ul className="space-y-1.5 text-sm">
        {top.map((h) => (
          <li key={h.asset} className="flex items-center gap-2">
            <CoinIcon asset={h.asset} size="sm" />
            <span className="flex-1 font-medium">{h.asset}</span>
            <span className="tabular-nums">{formatMoney(h.valueCents ?? 0)}</span>
          </li>
        ))}
      </ul>
      {realized !== null && (
        <p className="text-xs text-slate-500">
          Realized gains in {year}: <span className="font-medium">{money(realized)}</span> ·{" "}
          <Link to="/taxes" className="text-brand-600 hover:underline">
            Taxes
          </Link>
        </p>
      )}
      {(recent.data?.items.length ?? 0) > 0 && (
        <div className="border-t border-slate-100 pt-2 dark:border-slate-800">
          <p className="mb-1 text-xs font-medium tracking-wide text-slate-500 uppercase">
            Recent activity
          </p>
          <ul className="space-y-1 text-sm">
            {recent.data?.items.map((t) => {
              const asset = t.receivedAsset ?? t.sentAsset ?? t.feeAsset ?? "";
              const amount = t.receivedAmount ?? t.sentAmount ?? t.feeAmount ?? "0";
              return (
                <li key={t.id} className="flex items-center gap-2">
                  <span className="w-14 text-xs text-slate-500">
                    {new Date(t.at).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                    })}
                  </span>
                  <span className="flex-1 truncate">{t.walletName}</span>
                  <span
                    className={cx(
                      "font-mono text-xs tabular-nums",
                      t.receivedAmount ? "text-emerald-600" : "",
                    )}
                  >
                    {t.receivedAmount ? "+" : "−"}
                    {fmtAmount(amount, 6)} {asset}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Card>
  );
}

// ---- Taxes page section -----------------------------------------------------------
export function CryptoTaxSection({ year }: { year: number }) {
  const o = useCryptoOverview();
  const tax = useCryptoTax(`${year}-01-01`, `${year}-12-31`);
  if (!o.data || o.data.walletCount === 0) return null;
  const t = tax.data;
  const r = t?.realized;
  const capital = r
    ? r.short.profitCents + r.short.lossCents + r.long.profitCents + r.long.lossCents
    : null;
  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="p-0">
          <div className="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
            <h2 className="flex items-center gap-2 font-semibold">
              <span aria-hidden="true">🪙</span> Crypto in {year}
            </h2>
            <p className="text-xs text-slate-500">
              From your full crypto history, using the cost basis method in Crypto → Settings. The
              reports have the detail for your tax return.
            </p>
          </div>
          {t && (
            <div className="space-y-3 px-4 py-3">
              <div className="flex flex-wrap gap-1.5 text-xs">
                {(
                  [
                    ["transactions", t.counts.total],
                    ["deposits", t.counts.deposit],
                    ["withdrawals", t.counts.withdrawal],
                    ["trades", t.counts.trade],
                    ["transfers", t.counts.transfer],
                  ] as const
                ).map(([k, n], i) => (
                  <Link
                    key={k}
                    to="/crypto/transactions"
                    search={{
                      from: `${year}-01-01`,
                      to: `${year}-12-31`,
                      ...(i ? { type: k.slice(0, -1) as "deposit" } : {}),
                    }}
                    className={cx(
                      "rounded-md px-2 py-1 font-medium",
                      i ? "bg-slate-200 dark:bg-slate-700" : "bg-brand-600 text-white",
                    )}
                  >
                    {n} {k}
                  </Link>
                ))}
              </div>
              <dl className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
                {(
                  [
                    [
                      "Capital gains / P&L",
                      capital,
                      "Sales, spending and fees (first in, first out unless you chose otherwise)",
                    ],
                    ["Other gains (futures, derivatives)", 0, "Muny doesn't track derivatives"],
                    ["Income", t.summary.incomeCents, "Rewards, staking, mining, airdrops"],
                    ["Costs & expenses", t.summary.expensesCents, "Coins spent (tagged Cost)"],
                    [
                      "Gifts, donations & lost coins",
                      t.summary.giftsCents,
                      "At their value when they left",
                    ],
                  ] as const
                ).map(([k, v, help]) => (
                  <div key={k} className="flex justify-between gap-3 py-2" title={help}>
                    <dt>{k}</dt>
                    <dd className="font-medium tabular-nums">{v === null ? "…" : money(v)}</dd>
                  </div>
                ))}
              </dl>
              {r && (
                <table className="w-full text-xs text-slate-600 dark:text-slate-300">
                  <thead className="text-slate-500">
                    <tr>
                      <th className="text-left font-medium" />
                      <th className="text-right font-medium">Short term</th>
                      <th className="text-right font-medium">Long term</th>
                    </tr>
                  </thead>
                  <tbody className="tabular-nums">
                    <tr>
                      <td>Gains</td>
                      <td className="text-right">{money(r.short.profitCents)}</td>
                      <td className="text-right">{money(r.long.profitCents)}</td>
                    </tr>
                    <tr>
                      <td>Losses</td>
                      <td className="text-right">{money(r.short.lossCents)}</td>
                      <td className="text-right">{money(r.long.lossCents)}</td>
                    </tr>
                  </tbody>
                </table>
              )}
              <p className="text-xs text-slate-500">
                An indication of your taxable crypto, not tax advice. Download the reports below for
                the short/long-term detail, cost basis and each disposal.
              </p>
            </div>
          )}
        </Card>
        <Reports year={year} />
      </div>
      <TaxDocs year={year} />
    </div>
  );
}

function Reports({ year }: { year: number }) {
  const [kind, setKind] = useState<string>(CRYPTO_TAX_REPORTS[0][0]);
  const info = CRYPTO_TAX_REPORTS.find(([k]) => k === kind);
  return (
    <Card className="space-y-3">
      <h2 className="font-semibold">Crypto tax reports</h2>
      <label className="block text-sm">
        <span className="text-slate-500">Report</span>
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-950"
        >
          {CRYPTO_TAX_REPORTS.map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {info && <p className="text-xs text-slate-500">{info[2]}</p>}
      <a
        href={`/api/crypto/tax/${year}/report/${kind}`}
        className="inline-block rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700"
      >
        ⤓ Download {year} (CSV)
      </a>
      <p className="text-xs text-slate-500">
        CSV files for tax software or your accountant. Form 8949 lines are grouped by part and box
        (from the 1099-DA forms below); Muny doesn&apos;t fill in IRS PDF forms.
      </p>
    </Card>
  );
}

// ---- 1099-DA forms ------------------------------------------------------------------
function TaxDocs({ year }: { year: number }) {
  const wallets = useCryptoWallets();
  const docs = useQuery({
    queryKey: ["crypto", "taxdocs", year],
    queryFn: () => api.get<CryptoTaxDoc[]>(`/api/crypto/tax/${year}/docs`),
  });
  const notReceived = useQuery({
    queryKey: ["crypto", "taxdocs", year, "not-received"],
    queryFn: () => api.get<string[]>(`/api/crypto/tax/${year}/not-received`),
  });
  const [tab, setTab] = useState<"pending" | "done">("pending");
  const exchanges = (wallets.data ?? []).filter((w) => w.kind === "exchange" || w.exchange);
  const byWallet = new Map<string, CryptoTaxDoc[]>();
  for (const d of docs.data ?? [])
    byWallet.set(d.walletId, [...(byWallet.get(d.walletId) ?? []), d]);
  const flagged = new Set(notReceived.data ?? []);
  // Done: a form is uploaded, or you've said none is coming.
  const done = (id: string) => byWallet.has(id) || flagged.has(id);
  const list = exchanges.filter((w) => (tab === "done") === done(w.id));
  return (
    <Card className="space-y-3">
      <h2 className="font-semibold">1099-DA forms</h2>
      <p className="text-sm text-slate-500">
        Upload the 1099-DA forms your exchanges send for {year}. Muny keeps them encrypted, and uses
        them to put each sale in the right Form 8949 box: G/J when the form reports your cost basis
        to the IRS, H/K when it doesn&apos;t, I/L for sales no 1099-DA covers.
      </p>
      <div className="flex gap-1">
        {(["pending", "done"] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className={cx(
              "rounded-full px-3 py-1 text-sm",
              tab === k ? "bg-slate-200 font-medium dark:bg-slate-700" : "text-slate-500",
            )}
          >
            {k === "pending" ? "Pending" : "Completed"}
          </button>
        ))}
      </div>
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {list.map((w) => (
          <DocRow
            key={w.id}
            year={year}
            wallet={w}
            docs={byWallet.get(w.id) ?? []}
            notReceived={flagged.has(w.id)}
          />
        ))}
        {list.length === 0 && (
          <li className="py-4 text-center text-sm text-slate-500">
            {tab === "pending"
              ? "Every exchange has a form or is marked as not sending one."
              : "No forms uploaded or marked yet."}
          </li>
        )}
      </ul>
    </Card>
  );
}

function DocRow({
  year,
  wallet,
  docs,
  notReceived,
}: {
  year: number;
  wallet: { id: string; name: string; chain: string | null; kind: string };
  docs: CryptoTaxDoc[];
  notReceived: boolean;
}) {
  const qc = useQueryClient();
  const mark = useMutation({
    mutationFn: (on: boolean) =>
      api.put(`/api/crypto/tax/${year}/not-received/${wallet.id}`, { notReceived: on }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["crypto", "taxdocs", year, "not-received"] }),
  });
  const [basis, setBasis] = useState(true);
  const upload = useCryptoMutation(async (file: File) => {
    const buf = new Uint8Array(await file.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000)
      bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return api.post(`/api/crypto/tax/${year}/docs`, {
      walletId: wallet.id,
      filename: file.name,
      contentType: file.type || "application/pdf",
      base64: btoa(bin),
      basisReported: basis,
    });
  });
  const del = useCryptoMutation((id: string) => api.delete(`/api/crypto/tax/docs/${id}`));
  const toggle = useCryptoMutation((d: CryptoTaxDoc) =>
    api.patch(`/api/crypto/tax/docs/${d.id}`, { basisReported: !d.basisReported }),
  );
  return (
    <li className="space-y-2 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2 font-medium">
          <WalletIcon name={wallet.name} chain={wallet.chain} kind={wallet.kind} size="sm" />
          {wallet.name}
          {notReceived && docs.length === 0 && (
            <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[11px] font-medium text-slate-600 dark:bg-slate-700 dark:text-slate-300">
              Not received
            </span>
          )}
        </span>
        {notReceived && docs.length === 0 ? (
          <button
            type="button"
            title="Undo: back to pending"
            aria-label={`Undo not received for ${wallet.name}`}
            disabled={mark.isPending}
            onClick={() => mark.mutate(false)}
            className="rounded-lg border border-slate-300 p-1.5 text-slate-500 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            <RotateCcw aria-hidden="true" className="size-4" />
          </button>
        ) : (
          <span className="flex flex-wrap items-center gap-2 text-sm">
            {docs.length === 0 && (
              <button
                type="button"
                title="This exchange didn't send a 1099-DA for this year"
                disabled={mark.isPending}
                onClick={() => mark.mutate(true)}
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                Not received
              </button>
            )}
            {docs.length === 0 && (
              <label className="flex items-center gap-1 text-xs text-slate-500">
                <input
                  type="checkbox"
                  checked={basis}
                  onChange={(e) => setBasis(e.target.checked)}
                />
                Reports cost basis
              </label>
            )}
            <label className="cursor-pointer rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700">
              {upload.isPending ? "Uploading…" : "Upload"}
              <input
                type="file"
                accept="application/pdf,image/png,image/jpeg"
                className="sr-only"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) upload.mutate(f);
                  e.target.value = "";
                }}
              />
            </label>
          </span>
        )}
      </div>
      {docs.map((d) => (
        <div
          key={d.id}
          className="flex flex-wrap items-center justify-between gap-2 pl-8 text-xs text-slate-500"
        >
          <a
            href={`/api/crypto/tax/docs/${d.id}/file`}
            target="_blank"
            rel="noreferrer"
            className="text-brand-600 hover:underline"
          >
            📄 {d.filename}
          </a>
          <span className="flex items-center gap-3">
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={d.basisReported}
                disabled={toggle.isPending}
                onChange={() => toggle.mutate(d)}
              />
              Reports cost basis
            </label>
            <Button
              variant="ghost"
              className="text-red-600"
              onClick={() => window.confirm(`Delete ${d.filename}?`) && del.mutate(d.id)}
            >
              Delete
            </Button>
          </span>
        </div>
      ))}
      {(upload.error ?? del.error) && <Alert>{(upload.error ?? del.error)?.message}</Alert>}
    </li>
  );
}

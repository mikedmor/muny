import {
  ASSET_KIND_LABELS,
  ASSET_KINDS,
  type Asset,
  type AssetKind,
  formatMoney,
} from "@muny/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Pencil, Plus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { LineChart } from "../components/charts.js";
import { Modal } from "../components/forms.js";
import { Alert, Button, Card, Field, PageHeader } from "../components/ui.js";
import { api } from "../lib/api.js";
import { keys } from "../lib/queries.js";

/** Assets: a home, a car, other things of value; what they're worth and your equity (D-042). */

const assetsKey = [...keys.accounts, "assets"] as const;
const toCents = (s: string) => {
  const v = s.trim().replace(/[$,]/g, "");
  if (!v) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(v)) return Number.NaN;
  const [w = "0", f = ""] = v.split(".");
  return Number(w) * 100 + Number(f.padEnd(2, "0"));
};
const fromCents = (c: number | null | undefined) => (c == null ? "" : (c / 100).toFixed(2));

function AssetForm({ asset, onDone }: { asset?: Asset; onDone: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    name: asset?.name ?? "",
    kind: (asset?.kind ?? "home") as AssetKind,
    value: fromCents(asset?.valueCents),
    price: fromCents(asset?.purchasePriceCents),
    date: asset?.purchaseDate ?? "",
    address: asset?.address ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF((x) => ({ ...x, [k]: e.target.value }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const value = toCents(f.value);
    const price = toCents(f.price);
    if (!f.name.trim() || value === null || Number.isNaN(value) || Number.isNaN(price)) {
      setError("Give it a name and a value (like 350000).");
      return;
    }
    const body = {
      name: f.name,
      kind: f.kind,
      valueCents: value,
      purchasePriceCents: price,
      purchaseDate: f.date || null,
      address: f.address.trim() || null,
    };
    try {
      if (asset) await api.patch(`/api/assets/${asset.accountId}`, body);
      else await api.post("/api/assets", body);
      await qc.invalidateQueries({ queryKey: keys.accounts });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save");
    }
  };
  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      {error && <Alert>{error}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" value={f.name} onChange={set("name")} placeholder="e.g. Home" />
        <label className="block text-sm">
          <span className="font-medium text-slate-700 dark:text-slate-300">Kind</span>
          <select
            value={f.kind}
            onChange={(e) => setF((x) => ({ ...x, kind: e.target.value as AssetKind }))}
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-950"
          >
            {ASSET_KINDS.map((k) => (
              <option key={k} value={k}>
                {ASSET_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
        <Field
          label="What it's worth now"
          value={f.value}
          onChange={set("value")}
          inputMode="decimal"
          hint="An estimate is fine (e.g. from a home value site); update it now and then."
        />
        <Field label="What you paid" value={f.price} onChange={set("price")} inputMode="decimal" />
        <Field label="Bought on" type="date" value={f.date} onChange={set("date")} />
        <Field label="Address (optional)" value={f.address} onChange={set("address")} />
      </div>
      <p className="text-xs text-slate-500">
        To see your equity, link the loan that pays for it (Loans → Edit details → The home).
      </p>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit">{asset ? "Save" : "Add"}</Button>
      </div>
    </form>
  );
}

function UpdateValue({ asset }: { asset: Asset }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(fromCents(asset.valueCents));
  if (!open)
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs text-brand-600 hover:underline dark:text-brand-500"
      >
        Update value
      </button>
    );
  return (
    <form
      className="inline-flex items-center gap-1"
      onSubmit={async (e) => {
        e.preventDefault();
        const v = toCents(text);
        if (v === null || Number.isNaN(v)) return;
        await api.patch(`/api/assets/${asset.accountId}`, { valueCents: v });
        await qc.invalidateQueries({ queryKey: keys.accounts });
        setOpen(false);
      }}
    >
      <span className="text-xs text-slate-500">$</span>
      <input
        aria-label="Value today"
        value={text}
        onChange={(e) => setText(e.target.value)}
        inputMode="decimal"
        className="w-28 rounded border border-slate-300 bg-white px-1.5 py-0.5 text-sm dark:border-slate-700 dark:bg-slate-950"
      />
      <Button type="submit" className="px-2 py-0.5 text-xs">
        Save
      </Button>
    </form>
  );
}

function AssetCard({ asset }: { asset: Asset }) {
  const [editing, setEditing] = useState(false);
  const gain =
    asset.purchasePriceCents !== null ? asset.valueCents - asset.purchasePriceCents : null;
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold">{asset.name}</h3>
          <p className="text-xs text-slate-500">
            {[ASSET_KIND_LABELS[asset.kind], asset.address].filter(Boolean).join(" · ")}
          </p>
        </div>
        <div className="text-right">
          <p className="text-2xl font-semibold tabular-nums">{formatMoney(asset.valueCents)}</p>
          <span className="flex justify-end gap-3">
            <UpdateValue asset={asset} />
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="inline-flex items-center gap-1 text-xs text-brand-600 hover:underline dark:text-brand-500"
            >
              <Pencil aria-hidden="true" className="size-3" /> Edit
            </button>
          </span>
        </div>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs text-slate-500">You paid</dt>
          <dd className="font-medium tabular-nums">
            {asset.purchasePriceCents === null ? "—" : formatMoney(asset.purchasePriceCents)}
          </dd>
          {asset.purchaseDate && <dd className="text-xs text-slate-500">{asset.purchaseDate}</dd>}
        </div>
        <div>
          <dt className="text-xs text-slate-500">Change</dt>
          <dd
            className={
              gain === null
                ? "font-medium"
                : gain >= 0
                  ? "font-medium text-emerald-700 dark:text-emerald-400"
                  : "font-medium text-red-600"
            }
          >
            {gain === null ? "—" : `${gain >= 0 ? "+" : "−"}${formatMoney(Math.abs(gain))}`}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">Owed on it</dt>
          <dd className="font-medium tabular-nums">
            {asset.loans.length
              ? formatMoney(asset.loans.reduce((s, l) => s + l.balanceCents, 0))
              : "—"}
          </dd>
          {asset.loans.map((l) => (
            <dd key={l.accountId} className="text-xs">
              <Link to="/loans" className="text-brand-600 hover:underline dark:text-brand-500">
                {l.name}
              </Link>
            </dd>
          ))}
        </div>
        <div>
          <dt className="text-xs text-slate-500">Your equity</dt>
          <dd className="font-semibold tabular-nums">{formatMoney(asset.equityCents)}</dd>
        </div>
      </dl>
      {asset.history.length >= 2 && (
        <div className="mt-4">
          <LineChart
            ariaLabel={`${asset.name} value over time`}
            height={160}
            points={asset.history.map((h) => ({
              date: h.date,
              label: new Date(`${h.date}T00:00:00`).toLocaleDateString(undefined, {
                month: "short",
                year: "2-digit",
              }),
              value: h.valueCents,
            }))}
          />
        </div>
      )}
      <Modal open={editing} onClose={() => setEditing(false)} title={`Edit ${asset.name}`}>
        {editing && <AssetForm asset={asset} onDone={() => setEditing(false)} />}
      </Modal>
    </Card>
  );
}

export function AssetsPage() {
  const q = useQuery({ queryKey: assetsKey, queryFn: () => api.get<Asset[]>("/api/assets") });
  const [adding, setAdding] = useState(false);
  const list = q.data ?? [];
  return (
    <>
      <PageHeader
        title="Assets"
        actions={
          <Button onClick={() => setAdding(true)}>
            <Plus aria-hidden="true" className="mr-1 inline size-4" /> Add an asset
          </Button>
        }
      />
      {q.error && <Alert>{q.error.message}</Alert>}
      {q.data && list.length === 0 && (
        <Card className="text-center">
          <h2 className="text-lg font-semibold">Your home, car and other things of value</h2>
          <p className="mx-auto mt-2 max-w-lg text-sm text-slate-600 dark:text-slate-400">
            Add what they're worth and Muny counts them in your net worth. Link a mortgage or car
            loan to see your equity.
          </p>
        </Card>
      )}
      {list.length > 0 && (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-3">
            {(
              [
                ["Worth", list.reduce((s, a) => s + a.valueCents, 0)],
                [
                  "Owed on them",
                  list.reduce((s, a) => s + a.loans.reduce((t, l) => t + l.balanceCents, 0), 0),
                ],
                ["Your equity", list.reduce((s, a) => s + a.equityCents, 0)],
              ] as const
            ).map(([k, v]) => (
              <Card key={k}>
                <p className="text-xs font-medium tracking-wide text-slate-500 uppercase">{k}</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">{formatMoney(v)}</p>
              </Card>
            ))}
          </div>
          {list.map((a) => (
            <AssetCard key={a.accountId} asset={a} />
          ))}
        </div>
      )}
      <Modal open={adding} onClose={() => setAdding(false)} title="Add an asset">
        {adding && <AssetForm onDone={() => setAdding(false)} />}
      </Modal>
    </>
  );
}

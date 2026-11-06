import {
  ASSET_KIND_LABELS,
  ASSET_KINDS,
  type Asset,
  type AssetKind,
  type AssetValuationSettings,
  formatMoney,
} from "@muny/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Pencil, Plus } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { LineChart } from "../components/charts.js";
import { Modal } from "../components/forms.js";
import { Alert, Button, Card, cx, Field, PageHeader } from "../components/ui.js";
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
  // Suggestions from NHTSA's public vehicle database, only while filling in a vehicle.
  const [kindNow, setKindNow] = useState<AssetKind>(asset?.kind ?? "home");
  const makes = useQuery({
    queryKey: ["vehicle-makes"],
    queryFn: () => api.get<string[]>("/api/assets/vehicle-makes"),
    enabled: kindNow === "vehicle",
    staleTime: Number.POSITIVE_INFINITY,
  });
  const qc = useQueryClient();
  const [f, setF] = useState({
    name: asset?.name ?? "",
    kind: (asset?.kind ?? "home") as AssetKind,
    value: fromCents(asset?.valueCents),
    price: fromCents(asset?.purchasePriceCents),
    date: asset?.purchaseDate ?? "",
    address: asset?.address ?? "",
    year: asset?.vehicle.year ? String(asset.vehicle.year) : "",
    make: asset?.vehicle.make ?? "",
    model: asset?.vehicle.model ?? "",
    mileage: asset?.vehicle.mileage != null ? String(asset.vehicle.mileage) : "",
    vin: asset?.vehicle.vin ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF((x) => ({ ...x, [k]: e.target.value }));
  useEffect(() => setKindNow(f.kind), [f.kind]);
  const knownMake = (makes.data ?? []).some((m) => m.toLowerCase() === f.make.trim().toLowerCase());
  const year = /^\d{4}$/.test(f.year.trim()) ? Number(f.year) : null;
  const models = useQuery({
    queryKey: ["vehicle-models", f.make.trim().toLowerCase(), year],
    queryFn: () =>
      api.get<string[]>(
        `/api/assets/vehicle-models?make=${encodeURIComponent(f.make.trim())}${year ? `&year=${year}` : ""}`,
      ),
    enabled: f.kind === "vehicle" && knownMake,
    staleTime: Number.POSITIVE_INFINITY,
  });
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
      ...(f.kind === "vehicle"
        ? {
            vehicleYear: f.year.trim() ? Number(f.year) : null,
            vehicleMake: f.make.trim() || null,
            vehicleModel: f.model.trim() || null,
            mileage: f.mileage.trim() ? Number(f.mileage.replace(/,/g, "")) : null,
            vin: f.vin.trim().toUpperCase() || null,
          }
        : {}),
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
        {f.kind !== "vehicle" && (
          <Field
            label={f.kind === "home" ? "Address" : "Address (optional)"}
            value={f.address}
            onChange={set("address")}
            placeholder={f.kind === "home" ? "Street, city, state ZIP" : undefined}
            hint={f.kind === "home" ? "As Zillow shows it, for automatic values." : undefined}
          />
        )}
        {f.kind === "vehicle" && (
          <>
            <Field
              label="Year"
              value={f.year}
              onChange={set("year")}
              inputMode="numeric"
              placeholder="2020"
            />
            <Field
              label="Make"
              value={f.make}
              onChange={set("make")}
              placeholder="Honda"
              list="vehicle-makes"
              autoComplete="off"
            />
            <Field
              label="Model"
              value={f.model}
              onChange={set("model")}
              placeholder="Civic"
              list="vehicle-models"
              autoComplete="off"
            />
            <datalist id="vehicle-makes">
              {(makes.data ?? []).map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            <datalist id="vehicle-models">
              {(models.data ?? []).map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            <Field
              label="Mileage"
              value={f.mileage}
              onChange={set("mileage")}
              inputMode="numeric"
              placeholder="30000"
            />
            <Field
              label="VIN (optional)"
              value={f.vin}
              onChange={set("vin")}
              placeholder="17 characters"
            />
          </>
        )}
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

const SOURCE_LABEL = {
  apillow: "Zillow estimate (APillow)",
  carapi: "Market value (CarAPI)",
} as const;

/** Look the value up now, for homes (APillow) and vehicles (CarAPI) once the key is added. */
function LookupValue({ asset }: { asset: Asset }) {
  const qc = useQueryClient();
  const settings = useQuery({
    queryKey: [...keys.accounts, "asset-valuation"],
    queryFn: () => api.get<AssetValuationSettings>("/api/assets/valuation"),
  });
  const [state, setState] = useState<string | null>(null);
  const can =
    (asset.kind === "home" && settings.data?.apillow) ||
    (asset.kind === "vehicle" && settings.data?.carapi);
  if (!can) return null;
  const run = async () => {
    setState(asset.kind === "home" ? "Looking up… (up to a minute)" : "Looking up…");
    try {
      const r = await api.post<{ valueCents: number | null }>(
        `/api/assets/${asset.accountId}/lookup`,
      );
      await qc.invalidateQueries({ queryKey: keys.accounts });
      setState(r.valueCents === null ? "No estimate (see below)" : null);
    } catch (e) {
      setState(e instanceof Error ? e.message : "Couldn't look it up");
    }
  };
  return (
    <button
      type="button"
      onClick={() => void run()}
      disabled={state?.startsWith("Looking") ?? false}
      title={
        asset.kind === "home"
          ? "Uses one of your APillow lookups"
          : "Uses one of your CarAPI requests"
      }
      className="max-w-56 text-left text-xs text-brand-600 hover:underline disabled:opacity-60 dark:text-brand-500"
    >
      {state ?? "Look up value"}
    </button>
  );
}

function ValueSource({ asset }: { asset: Asset }) {
  const v = asset.vehicle;
  const car = asset.kind === "vehicle" && (v.year || v.make || v.model);
  const src =
    asset.valueSource === "apillow" || asset.valueSource === "carapi" ? asset.valueSource : null;
  if (!car && !src && !asset.details?.note) return null;
  return (
    <p className="mt-3 text-xs text-slate-500">
      {car && (
        <span className="mr-3">
          {[v.year, v.make, v.model].filter(Boolean).join(" ")}
          {v.mileage != null && ` · ${v.mileage.toLocaleString()} mi`}
        </span>
      )}
      {src && (
        <span>
          Value: {SOURCE_LABEL[src]}
          {asset.valueCheckedAt &&
            `, ${new Date(asset.valueCheckedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`}
          . Updated monthly when you open Assets.
        </span>
      )}
      {asset.details?.note && <span className="ml-1 text-amber-600">{asset.details.note}</span>}
    </p>
  );
}

/** What Zillow knows about the home. */
function HomeDetails({ asset }: { asset: Asset }) {
  const d = asset.details;
  if (asset.kind !== "home" || !d) return null;
  const items: [string, string | null][] = [
    ["Beds", d.bedrooms != null ? String(d.bedrooms) : null],
    ["Baths", d.bathrooms != null ? String(d.bathrooms) : null],
    ["Living area", d.livingArea != null ? `${d.livingArea.toLocaleString()} sq ft` : null],
    ["Lot", d.lotSize != null ? `${d.lotSize.toLocaleString()} sq ft` : null],
    ["Built", d.yearBuilt != null ? String(d.yearBuilt) : null],
    [
      "Last sold",
      d.lastSoldPriceCents != null
        ? `${formatMoney(d.lastSoldPriceCents)}${d.lastSoldDate ? ` (${d.lastSoldDate})` : ""}`
        : null,
    ],
    ["Property tax", d.annualTaxCents != null ? `${formatMoney(d.annualTaxCents)}/yr` : null],
    [
      "Rent estimate",
      d.rentZestimateCents != null ? `${formatMoney(d.rentZestimateCents)}/mo` : null,
    ],
  ];
  const shown = items.filter(([, v]) => v !== null);
  if (!shown.length) return null;
  return (
    <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 rounded-xl bg-slate-50 p-3 text-sm sm:grid-cols-4 dark:bg-slate-800/40">
      {shown.map(([k, v]) => (
        <div key={k}>
          <dt className="text-xs text-slate-500">{k}</dt>
          <dd className="font-medium tabular-nums">{v}</dd>
        </div>
      ))}
      {d.zillowUrl && (
        <a
          href={d.zillowUrl}
          target="_blank"
          rel="noreferrer"
          className="col-span-full text-xs text-brand-600 hover:underline dark:text-brand-500"
        >
          See it on Zillow
        </a>
      )}
    </dl>
  );
}

/** Your keys for automatic values (opt-in): APillow for homes, CarAPI for vehicles. */
function ValuationKeys() {
  const qc = useQueryClient();
  const settings = useQuery({
    queryKey: [...keys.accounts, "asset-valuation"],
    queryFn: () => api.get<AssetValuationSettings>("/api/assets/valuation"),
  });
  const [editing, setEditing] = useState<"apillow" | "carapi" | null>(null);
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const save = async (service: "apillow" | "carapi", value: string | null) => {
    setError(null);
    try {
      await api.put(`/api/assets/valuation/${service}`, { key: value });
      await qc.invalidateQueries({ queryKey: [...keys.accounts, "asset-valuation"] });
      setEditing(null);
      setKey("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save");
    }
  };
  const rows = [
    {
      id: "apillow" as const,
      name: "Home values: APillow (Zillow data)",
      help: "Free plan: 50 lookups a month. Get a key at apillow.co. Sends only the home's address.",
    },
    {
      id: "carapi" as const,
      name: "Vehicle values: CarAPI.dev",
      help: "Free plan: 100 requests a month. Get a key at carapi.dev. Sends only year, make, model and mileage.",
    },
  ];
  return (
    <Card>
      <h2 className="font-semibold">Automatic values</h2>
      <p className="mt-1 text-xs text-slate-500">
        Optional: with your own keys, Muny looks values up when you ask, then about once a month.
        Keys are stored encrypted and sent only to their service.
      </p>
      {error && <Alert>{error}</Alert>}
      <ul className="mt-3 divide-y divide-slate-100 dark:divide-slate-800">
        {rows.map((r) => {
          const on = settings.data?.[r.id] ?? false;
          return (
            <li
              key={r.id}
              className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
            >
              <span>
                <span className="font-medium">{r.name}</span>
                <span className="block text-xs text-slate-500">{r.help}</span>
              </span>
              {editing === r.id ? (
                <form
                  className="flex items-center gap-1"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (key.trim()) void save(r.id, key.trim());
                  }}
                >
                  <input
                    type="password"
                    aria-label={`${r.name} key`}
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                    autoComplete="off"
                    className="w-56 rounded border border-slate-300 bg-white px-2 py-1 font-mono text-xs dark:border-slate-700 dark:bg-slate-950"
                  />
                  <Button type="submit" className="px-2 py-1 text-xs">
                    Save
                  </Button>
                  <button
                    type="button"
                    onClick={() => setEditing(null)}
                    className="text-xs text-slate-500"
                  >
                    Cancel
                  </button>
                </form>
              ) : (
                <span className="flex items-center gap-3 text-xs">
                  <span
                    className={on ? "text-emerald-700 dark:text-emerald-400" : "text-slate-500"}
                  >
                    {on ? "Key added" : "Off"}
                  </span>
                  <button
                    type="button"
                    onClick={() => setEditing(r.id)}
                    className="text-brand-600 hover:underline dark:text-brand-500"
                  >
                    {on ? "Replace key" : "Add key"}
                  </button>
                  {on && (
                    <button
                      type="button"
                      onClick={() => void save(r.id, null)}
                      className="text-red-600 hover:underline"
                    >
                      Remove
                    </button>
                  )}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/** What's owed on an asset with no linked loan: enter it, or mark it paid off. */
function OwedEditor({ asset }: { asset: Asset }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(fromCents(asset.owedCents));
  const save = async (owedCents: number | null) => {
    await api.patch(`/api/assets/${asset.accountId}`, { owedCents });
    await qc.invalidateQueries({ queryKey: keys.accounts });
    setEditing(false);
  };
  if (editing)
    return (
      <dd>
        <form
          className="inline-flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            const v = toCents(text);
            if (Number.isNaN(v)) return;
            void save(v);
          }}
        >
          <span className="text-xs text-slate-500">$</span>
          <input
            aria-label="Owed on it"
            value={text}
            onChange={(e) => setText(e.target.value)}
            inputMode="decimal"
            className="w-24 rounded border border-slate-300 bg-white px-1.5 py-0.5 text-sm dark:border-slate-700 dark:bg-slate-950"
          />
          <Button type="submit" className="px-2 py-0.5 text-xs">
            Save
          </Button>
        </form>
      </dd>
    );
  return (
    <>
      <dd className="font-medium tabular-nums">
        {asset.owedCents === 0 ? (
          <span className="text-emerald-700 dark:text-emerald-400">Paid off</span>
        ) : asset.owedCents === null ? (
          "—"
        ) : (
          formatMoney(asset.owedCents)
        )}
      </dd>
      <dd className="flex gap-2 text-xs">
        {asset.owedCents !== 0 && (
          <button
            type="button"
            onClick={() => void save(0)}
            className="text-brand-600 hover:underline dark:text-brand-500"
          >
            Paid off
          </button>
        )}
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="text-brand-600 hover:underline dark:text-brand-500"
        >
          {asset.owedCents === null ? "Enter" : "Change"}
        </button>
      </dd>
    </>
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
            <LookupValue asset={asset} />
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
          {asset.loans.length ? (
            <dd className="font-medium tabular-nums">
              {formatMoney(asset.loans.reduce((s, l) => s + l.balanceCents, 0))}
            </dd>
          ) : (
            <OwedEditor asset={asset} />
          )}
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
      <ValueSource asset={asset} />
      <HomeDetails asset={asset} />
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

const TABS = [
  ["assets", "Assets"],
  ["settings", "Settings"],
] as const;
type Tab = (typeof TABS)[number][0];

export function AssetsPage() {
  const q = useQuery({ queryKey: assetsKey, queryFn: () => api.get<Asset[]>("/api/assets") });
  const [adding, setAdding] = useState(false);
  const [tab, setTab] = useState<Tab>(() =>
    window.location.hash === "#settings" ? "settings" : "assets",
  );
  const list = q.data ?? [];
  const qc = useQueryClient();
  const refreshed = useRef(false);
  useEffect(() => {
    if (refreshed.current) return;
    refreshed.current = true;
    void api
      .post<{ started: number }>("/api/assets/refresh-due")
      .then((r) => {
        // Lookups run in the background; check back after they've had time.
        if (r.started)
          setTimeout(() => void qc.invalidateQueries({ queryKey: keys.accounts }), 90_000);
      })
      .catch(() => {});
  }, [qc]);
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
      <div
        role="tablist"
        className="mb-6 flex gap-1 border-b border-slate-200 dark:border-slate-800"
      >
        {TABS.map(([k, label]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            onClick={() => {
              setTab(k);
              window.history.replaceState(null, "", `#${k}`);
            }}
            className={cx(
              "-mb-px border-b-2 px-3 py-2 text-sm font-medium",
              tab === k
                ? "border-brand-600 text-brand-700 dark:text-brand-500"
                : "border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "settings" && <ValuationKeys />}
      {q.error && <Alert>{q.error.message}</Alert>}
      {tab === "assets" && q.data && list.length === 0 && (
        <Card className="text-center">
          <h2 className="text-lg font-semibold">Your home, car and other things of value</h2>
          <p className="mx-auto mt-2 max-w-lg text-sm text-slate-600 dark:text-slate-400">
            Add what they're worth and Muny counts them in your net worth. Link a mortgage or car
            loan to see your equity.
          </p>
        </Card>
      )}
      {tab === "assets" && list.length > 0 && (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-3">
            {(
              [
                ["Worth", list.reduce((s, a) => s + a.valueCents, 0)],
                ["Owed on them", list.reduce((s, a) => s + (a.valueCents - a.equityCents), 0)],
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

import {
  type AlternativeSuggestion,
  DIY_STATUSES,
  type DiyProject,
  type DiyStatus,
  formatMoney,
  INFRA_KINDS,
  type InfraInput,
  type InfraKind,
  SAVING_KINDS,
  type Saving,
  type SavingKind,
} from "@muny/shared";
import { type FormEvent, useEffect, useState } from "react";
import { MoneyField, SelectField } from "../components/forms.js";
import { Alert, Button, Card, cx, Field, PageHeader } from "../components/ui.js";
import { MerchantAvatar } from "../components/visuals.js";
import {
  useAlternativeSuggestions,
  useDeleteDiy,
  useDeleteInfra,
  useDeleteSaving,
  useDiyProjects,
  useInfraCosts,
  useRecordSaving,
  useSaveDiy,
  useSaveInfra,
  useSavings,
  useSavingsSummary,
  useUpdateSaving,
} from "../lib/queries.js";

const today = () => new Date().toLocaleDateString("en-CA");
const nice = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

const KIND_LABEL: Record<SavingKind, string> = {
  cancelled: "Cancelled",
  downgraded: "Downgraded",
  negotiated: "Negotiated",
  replaced: "Replaced (DIY)",
  other: "Other",
};

function Tile({
  label,
  value,
  children,
}: {
  label: string;
  value: string;
  children?: React.ReactNode;
}) {
  return (
    <Card>
      <p className="text-sm text-slate-500">{label}</p>
      <p className="mt-1 text-3xl font-semibold tracking-tight tabular-nums">{value}</p>
      {children && <div className="mt-1 text-xs text-slate-500">{children}</div>}
    </Card>
  );
}

function StatusBadge({ s }: { s: Saving }) {
  const style = {
    verified: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200",
    projected: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
    failed: "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-200",
  }[s.status];
  const label = {
    verified: "✓ Confirmed",
    projected: "Waiting to confirm",
    failed: "⚠ Still charged",
  }[s.status];
  return (
    <span className={cx("rounded px-1.5 py-0.5 text-[11px] font-semibold", style)}>{label}</span>
  );
}

// ---------------------------------------------------------------------------
// Savings ledger
// ---------------------------------------------------------------------------

function AddSaving({ onDone }: { onDone: () => void }) {
  const add = useRecordSaving();
  const [kind, setKind] = useState<SavingKind>("negotiated");
  const [name, setName] = useState("");
  const [before, setBefore] = useState<number | null>(null);
  const [after, setAfter] = useState<number | null>(0);
  const [date, setDate] = useState(today());
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (before === null) return;
    add.mutate(
      {
        kind,
        name,
        beforeMonthlyCents: before,
        afterMonthlyCents: after ?? 0,
        effectiveDate: date,
      },
      { onSuccess: onDone },
    );
  };
  return (
    <Card>
      <form onSubmit={submit} className="space-y-3" noValidate>
        <h3 className="font-semibold">Record a saving</h3>
        <p className="text-sm text-slate-500">
          For subscriptions Muny already tracks, use{" "}
          <span className="font-medium">I cancelled it</span> or{" "}
          <span className="font-medium">Price went down</span> on the Recurring page instead: Muny
          then confirms the saving from your bank data.
        </p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <SelectField
            label="What happened"
            value={kind}
            onChange={(e) => setKind(e.target.value as SavingKind)}
          >
            {SAVING_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </SelectField>
          <Field
            label="What"
            placeholder="e.g. Car insurance"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <MoneyField
            label="Cost per month before"
            cents={before}
            onChange={(c, ok) => ok && setBefore(c)}
          />
          <MoneyField
            label="Cost per month now"
            cents={after}
            onChange={(c, ok) => ok && setAfter(c)}
          />
          <Field label="Since" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        {add.error && <Alert>{add.error.message}</Alert>}
        <div className="flex gap-2">
          <Button type="submit" disabled={add.isPending || !name.trim() || before === null}>
            Add
          </Button>
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

function SavingsTab() {
  const summary = useSavingsSummary();
  const list = useSavings();
  const update = useUpdateSaving();
  const del = useDeleteSaving();
  const [adding, setAdding] = useState(false);
  const s = summary.data;
  return (
    <div className="space-y-6">
      {s && (
        <div className="grid gap-4 sm:grid-cols-3">
          <Tile label="Saving every month" value={formatMoney(s.verifiedMonthlyCents)}>
            Confirmed by your bank data
            {s.projectedMonthlyCents > 0 &&
              ` · ${formatMoney(s.projectedMonthlyCents)} more waiting to confirm`}
          </Tile>
          <Tile label="Saved so far" value={formatMoney(s.realizedCents)}>
            {formatMoney(s.verifiedMonthlyCents * 12)} a year at this rate
          </Tile>
          <Tile
            label="Self-hosting, net"
            value={`${s.diyNetMonthlyCents < 0 ? "−" : ""}${formatMoney(Math.abs(s.diyNetMonthlyCents))}/mo`}
          >
            {formatMoney(s.diyMonthlyCents)} replaced − {formatMoney(s.infraMonthlyCents)} running
            costs
          </Tile>
        </div>
      )}
      <div className="flex justify-end">
        {!adding && (
          <Button variant="secondary" onClick={() => setAdding(true)}>
            Record a saving
          </Button>
        )}
      </div>
      {adding && <AddSaving onDone={() => setAdding(false)} />}
      {(update.error || del.error) && <Alert>{(update.error ?? del.error)?.message}</Alert>}
      <Card className="p-0">
        <div className="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
          <h3 className="font-semibold">Savings ledger</h3>
        </div>
        <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
          {list.data?.map((x) => (
            <li key={x.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <MerchantAvatar name={x.name} />
              <span className="min-w-48 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{x.name}</span>
                  <StatusBadge s={x} />
                </span>
                <span className="block text-xs text-slate-500">
                  {KIND_LABEL[x.kind]} {nice(x.effectiveDate)}
                  {x.statusNote && ` · ${x.statusNote}`}
                  {!x.seriesId &&
                    x.status === "projected" &&
                    " · Not linked to a bank charge; confirm it yourself"}
                </span>
              </span>
              <span className="text-right">
                <span className="block font-semibold tabular-nums text-emerald-700 dark:text-emerald-400">
                  {formatMoney(x.monthlyCents)}/mo
                </span>
                {x.realizedCents > 0 && (
                  <span className="block text-xs text-slate-500">
                    {formatMoney(x.realizedCents)} saved
                  </span>
                )}
              </span>
              <span className="flex gap-1">
                {x.status !== "verified" && !x.seriesId && (
                  <Button
                    variant="ghost"
                    onClick={() => update.mutate({ id: x.id, status: "verified" })}
                  >
                    Confirm
                  </Button>
                )}
                <Button
                  variant="ghost"
                  className="text-red-600"
                  onClick={() => {
                    if (window.confirm(`Remove "${x.name}" from the ledger?`)) del.mutate(x.id);
                  }}
                >
                  Remove
                </Button>
              </span>
            </li>
          ))}
          {list.isSuccess && list.data.length === 0 && (
            <li className="px-4 py-6 text-center text-slate-500">
              Nothing yet. Cancel or downgrade something on the Recurring page, or record a saving
              above, and it shows up here.
            </li>
          )}
        </ul>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Self-host alternatives & DIY projects
// ---------------------------------------------------------------------------

const DIY_LABEL: Record<DiyStatus, string> = {
  idea: "Idea",
  testing: "Testing",
  migrated: "Migrated",
  cancelled: "Paid plan cancelled",
  abandoned: "Abandoned",
};

function Suggestion({ s }: { s: AlternativeSuggestion }) {
  const save = useSaveDiy();
  const [pick, setPick] = useState(s.alternatives[0]?.name ?? "");
  return (
    <li className="space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <MerchantAvatar name={s.seriesName} />
        <span className="min-w-48 flex-1">
          <span className="block font-medium">{s.seriesName}</span>
          <span className="text-xs text-slate-500">
            {s.category} · {formatMoney(s.monthlyCents)}/mo · {formatMoney(s.monthlyCents * 12)}/yr
          </span>
        </span>
        {s.projectId ? (
          <span className="text-xs text-slate-500">Switch planned below</span>
        ) : (
          <span className="flex items-center gap-2">
            <select
              aria-label={`Alternative to ${s.seriesName}`}
              value={pick}
              onChange={(e) => setPick(e.target.value)}
              className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950"
            >
              {s.alternatives.map((a) => (
                <option key={a.name}>{a.name}</option>
              ))}
            </select>
            <Button
              variant="secondary"
              disabled={save.isPending}
              onClick={() =>
                save.mutate({
                  serviceName: s.seriesName,
                  seriesId: s.seriesId,
                  alternative: pick,
                  effort: s.alternatives.find((a) => a.name === pick)?.effort ?? null,
                })
              }
            >
              Plan a switch
            </Button>
          </span>
        )}
      </div>
      <ul className="flex flex-wrap gap-2 pl-12">
        {s.alternatives.map((a) => (
          <li key={a.name}>
            <a
              href={a.url}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 px-2.5 py-1 text-xs hover:border-brand-500 dark:border-slate-700"
              title={a.note}
            >
              <span className="font-medium">{a.name}</span>
              <span className="text-slate-500">
                {a.kind} · {a.effort} effort
              </span>
            </a>
          </li>
        ))}
      </ul>
      {s.tradeoff && <p className="pl-12 text-xs text-slate-500">Tradeoff: {s.tradeoff}</p>}
    </li>
  );
}

function Project({ p }: { p: DiyProject }) {
  const save = useSaveDiy();
  const del = useDeleteDiy();
  const [running, setRunning] = useState<number | null>(p.runningMonthlyCents);
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3">
      <span className="min-w-48 flex-1">
        <span className="block font-medium">
          {p.serviceName} → {p.alternative}
        </span>
        <span className="text-xs text-slate-500">
          {p.serviceMonthlyCents
            ? `Saves up to ${formatMoney(p.serviceMonthlyCents)}/mo`
            : "Not linked to a charge"}
          {p.effort && ` · ${p.effort} effort`}
          {p.savingId && " · saving recorded"}
        </span>
      </span>
      <div className="w-36">
        <MoneyField
          label="Extra cost /mo"
          cents={running}
          onChange={(c, ok) => ok && setRunning(c)}
        />
      </div>
      {running !== p.runningMonthlyCents && running !== null && (
        <Button
          variant="ghost"
          onClick={() => save.mutate({ id: p.id, runningMonthlyCents: running })}
        >
          Save
        </Button>
      )}
      <select
        aria-label={`Status of ${p.serviceName} switch`}
        value={p.status}
        onChange={(e) => save.mutate({ id: p.id, status: e.target.value as DiyStatus })}
        className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950"
      >
        {DIY_STATUSES.map((s) => (
          <option key={s} value={s}>
            {DIY_LABEL[s]}
          </option>
        ))}
      </select>
      <Button
        variant="ghost"
        className="text-red-600"
        onClick={() => {
          if (window.confirm(`Delete the ${p.serviceName} → ${p.alternative} project?`))
            del.mutate(p.id);
        }}
      >
        Delete
      </Button>
    </li>
  );
}

function AlternativesTab() {
  const sugg = useAlternativeSuggestions();
  const projects = useDiyProjects();
  const save = useSaveDiy();
  const [service, setService] = useState("");
  const [alt, setAlt] = useState("");
  return (
    <div className="space-y-6">
      <Card className="p-0">
        <div className="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
          <h3 className="font-semibold">Subscriptions you could self-host</h3>
          <p className="text-sm text-slate-500">
            Matched against Muny's built-in catalog of self-hosted and free alternatives. Links open
            the project's own site.
          </p>
        </div>
        <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
          {sugg.data?.map((s) => (
            <Suggestion key={s.seriesId} s={s} />
          ))}
          {sugg.isSuccess && sugg.data.length === 0 && (
            <li className="px-4 py-6 text-center text-slate-500">
              None of your current subscriptions are in the catalog yet.
            </li>
          )}
        </ul>
      </Card>

      <Card className="p-0">
        <div className="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
          <h3 className="font-semibold">Your switches</h3>
          <p className="text-sm text-slate-500">
            Idea → Testing → Migrated → Paid plan cancelled. Setting "Paid plan cancelled" records
            the saving and marks the subscription cancelled, so Muny can confirm the charge stops.
          </p>
        </div>
        <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
          {projects.data?.map((p) => (
            <Project key={p.id} p={p} />
          ))}
        </ul>
        <form
          className="flex flex-wrap items-end gap-2 border-t border-slate-200 p-4 dark:border-slate-800"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(
              { serviceName: service, alternative: alt },
              {
                onSuccess: () => {
                  setService("");
                  setAlt("");
                },
              },
            );
          }}
        >
          <Field
            label="Replacing"
            placeholder="e.g. Dropbox"
            value={service}
            onChange={(e) => setService(e.target.value)}
          />
          <Field
            label="With"
            placeholder="e.g. Synology Drive"
            value={alt}
            onChange={(e) => setAlt(e.target.value)}
          />
          <Button
            type="submit"
            variant="secondary"
            disabled={!service.trim() || !alt.trim() || save.isPending}
          >
            Add a switch
          </Button>
        </form>
        {save.error && (
          <div className="px-4 pb-4">
            <Alert>{save.error.message}</Alert>
          </div>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Self-hosting costs
// ---------------------------------------------------------------------------

const INFRA_LABEL: Record<InfraKind, string> = {
  power: "Power",
  hardware: "Hardware",
  domain: "Domain",
  hosting: "Hosting / VPS",
  storage: "Off-site storage",
  software: "Software / licenses",
  other: "Other",
};

function AddInfra() {
  const save = useSaveInfra();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<InfraKind>("power");
  const [watts, setWatts] = useState("30");
  const [price, setPrice] = useState("15.5");
  const [amount, setAmount] = useState<number | null>(null);
  const [period, setPeriod] = useState<"monthly" | "annual" | "once">("annual");
  const [months, setMonths] = useState("60");
  const [start, setStart] = useState(today());
  useEffect(() => {
    if (kind === "hardware") setPeriod("once");
    else if (kind === "domain") setPeriod("annual");
    else if (kind !== "power") setPeriod("monthly");
  }, [kind]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body: InfraInput =
      kind === "power"
        ? {
            name,
            kind,
            watts: Number(watts),
            // ¢/kWh with one decimal → tenths of a cent (integer).
            priceDeciCentsPerKwh: Math.round(Number(price) * 10),
            amountCents: null,
            period: null,
            amortizeMonths: null,
            startDate: start,
            endDate: null,
            notes: null,
          }
        : {
            name,
            kind,
            amountCents: amount,
            period,
            amortizeMonths: period === "once" ? Number(months) : null,
            watts: null,
            priceDeciCentsPerKwh: null,
            startDate: start,
            endDate: null,
            notes: null,
          };
    save.mutate(body, { onSuccess: () => setName("") });
  };
  return (
    <form
      onSubmit={submit}
      className="space-y-3 border-t border-slate-200 p-4 dark:border-slate-800"
      noValidate
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field
          label="Name"
          placeholder="e.g. NAS power"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <SelectField
          label="Kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as InfraKind)}
        >
          {INFRA_KINDS.map((k) => (
            <option key={k} value={k}>
              {INFRA_LABEL[k]}
            </option>
          ))}
        </SelectField>
        {kind === "power" ? (
          <>
            <Field
              label="Average draw (watts)"
              inputMode="numeric"
              value={watts}
              onChange={(e) => setWatts(e.target.value)}
              hint="A DS920+ with 4 drives idles around 30 W"
            />
            <Field
              label="Electricity price (¢/kWh)"
              inputMode="decimal"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              hint="From your power bill"
            />
          </>
        ) : (
          <>
            <MoneyField label="Amount" cents={amount} onChange={(c, ok) => ok && setAmount(c)} />
            <div className="grid grid-cols-2 gap-2">
              <SelectField
                label="How often"
                value={period}
                onChange={(e) => setPeriod(e.target.value as typeof period)}
              >
                <option value="monthly">Monthly</option>
                <option value="annual">Yearly</option>
                <option value="once">One-time</option>
              </SelectField>
              {period === "once" && (
                <Field
                  label="Spread over (months)"
                  inputMode="numeric"
                  value={months}
                  onChange={(e) => setMonths(e.target.value)}
                />
              )}
            </div>
          </>
        )}
        <Field label="Since" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
      </div>
      {save.error && <Alert>{save.error.message}</Alert>}
      <Button type="submit" variant="secondary" disabled={!name.trim() || save.isPending}>
        Add cost
      </Button>
    </form>
  );
}

function CostsTab() {
  const costs = useInfraCosts();
  const del = useDeleteInfra();
  const total = (costs.data ?? []).reduce((s, c) => s + c.monthlyCents, 0);
  const describe = (c: NonNullable<typeof costs.data>[number]) =>
    c.kind === "power"
      ? `${c.watts} W at ${((c.priceDeciCentsPerKwh ?? 0) / 10).toFixed(1)}¢/kWh`
      : c.period === "once"
        ? `${formatMoney(c.amountCents ?? 0)} over ${c.amortizeMonths} months from ${nice(c.startDate)}`
        : `${formatMoney(c.amountCents ?? 0)} ${c.period === "annual" ? "a year" : "a month"}`;
  return (
    <Card className="p-0">
      <div className="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <h3 className="font-semibold">What self-hosting costs you</h3>
        <p className="text-sm text-slate-500">
          Power, hardware (spread over its life), domains, off-site backups… so your DIY savings are
          shown net of what it takes to run them. Currently {formatMoney(total)}/mo.
        </p>
      </div>
      <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
        {costs.data?.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
            <span className="min-w-48 flex-1">
              <span className="block font-medium">{c.name}</span>
              <span className="text-xs text-slate-500">
                {INFRA_LABEL[c.kind]} · {describe(c)}
              </span>
            </span>
            <span className="font-medium tabular-nums">{formatMoney(c.monthlyCents)}/mo</span>
            <Button
              variant="ghost"
              className="text-red-600"
              onClick={() => {
                if (window.confirm(`Remove ${c.name}?`)) del.mutate(c.id);
              }}
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
      <AddInfra />
    </Card>
  );
}

// ---------------------------------------------------------------------------

const TABS = [
  ["savings", "Savings"],
  ["alternatives", "Self-host alternatives"],
  ["costs", "Self-hosting costs"],
] as const;
type Tab = (typeof TABS)[number][0];

export function SavingsPage() {
  const fromHash = () =>
    (TABS.find(([k]) => `#${k}` === window.location.hash)?.[0] ?? "savings") as Tab;
  const [tab, setTab] = useState<Tab>(fromHash);
  useEffect(() => {
    const on = () => setTab(fromHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  });
  return (
    <>
      <PageHeader title="Savings" />
      <div
        role="tablist"
        className="mb-6 flex gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden border-b border-slate-200 dark:border-slate-800"
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
              "-mb-px shrink-0 border-b-2 px-3 py-2 text-sm font-medium",
              tab === k
                ? "border-brand-600 text-brand-700 dark:text-brand-500"
                : "border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="max-w-6xl">
        {tab === "savings" && <SavingsTab />}
        {tab === "alternatives" && <AlternativesTab />}
        {tab === "costs" && <CostsTab />}
      </div>
    </>
  );
}

import {
  formatMoney,
  type PayAmount,
  type PayBreakdown,
  type PayPeriodView,
  type PayStubInfo,
  type PayUploadResult,
  type PayYear,
  type W2Info,
} from "@muny/shared";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, FileText, Trash2 } from "lucide-react";
import { useState } from "react";
import { Alert, Card, cx, PageHeader } from "../components/ui.js";
import { api } from "../lib/api.js";

/**
 * Pay (D-093): pay stubs and W-2s, read into gross pay, taxes, benefits and
 * take-home. The bank only sees take-home; this is the rest of the story.
 */

const payKey = ["pay"] as const;

const day = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
const money = (c: number) => formatMoney(c);
const pct = (part: number, whole: number) =>
  whole > 0 ? `${Math.round((part / whole) * 1000) / 10}%` : "—";
const sum = (list: PayAmount[]) => list.reduce((t, a) => t + a.cents, 0);

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(new Error("Couldn't read the file"));
    r.readAsDataURL(file);
  });
}

type Outcome = { file: string; ok: PayUploadResult[] } | { file: string; error: string };

function Upload({ onDone }: { onDone: (year: number | null) => void }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  async function run(files: File[]) {
    const out: Outcome[] = [];
    let year: number | null = null;
    for (const f of files) {
      setBusy(f.name);
      try {
        const ok = await api.post<PayUploadResult[]>("/api/pay/documents", {
          filename: f.name,
          base64: await toBase64(f),
        });
        out.push({ file: f.name, ok });
        const m = ok[0]?.label.match(/(\d{4})/);
        if (m) year = Number(m[1]);
      } catch (e) {
        out.push({ file: f.name, error: e instanceof Error ? e.message : "Couldn't add it" });
      }
    }
    setBusy(null);
    setOutcomes(out);
    await qc.invalidateQueries({ queryKey: payKey });
    await qc.invalidateQueries({ queryKey: ["documents"] });
    onDone(year);
  }
  return (
    <div className="space-y-2">
      <label className="inline-block cursor-pointer rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-on-brand hover:bg-brand-700">
        {busy ? `Reading ${busy}…` : "Add pay stubs or W-2s"}
        <input
          type="file"
          multiple
          accept="application/pdf,.pdf"
          className="sr-only"
          disabled={!!busy}
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = "";
            if (files.length) void run(files);
          }}
        />
      </label>
      {outcomes.length > 0 && (
        <ul className="space-y-1 text-sm">
          {outcomes.map((o) => (
            <li key={o.file} className="flex items-start gap-2">
              {"error" in o ? (
                <>
                  <AlertTriangle
                    className="mt-0.5 size-4 shrink-0 text-red-600"
                    aria-hidden="true"
                  />
                  <span>
                    <span className="font-medium">{o.file}</span>: {o.error}
                  </span>
                </>
              ) : (
                <>
                  <Check className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden="true" />
                  <span>
                    {o.ok.map((r) => r.label).join(", ")}
                    {o.ok.some((r) => r.problems.length) && (
                      <span className="text-amber-700 dark:text-amber-400">
                        {" "}
                        (doesn't add up, see below)
                      </span>
                    )}
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const SEGMENTS = [
  { key: "take", label: "Take-home", color: "var(--viz-series-1)" },
  { key: "tax", label: "Taxes", color: "var(--viz-series-2)" },
  { key: "ded", label: "Benefits & deductions", color: "var(--viz-series-3)" },
] as const;

/** Gross pay split into take-home, taxes and deductions: one bar, a legend and the numbers. */
function Split({
  gross,
  take,
  tax,
  ded,
}: {
  gross: number;
  take: number;
  tax: number;
  ded: number;
}) {
  const values = { take, tax, ded };
  return (
    <div className="space-y-2">
      <div className="flex h-4 w-full gap-0.5" role="img" aria-label="How gross pay splits">
        {SEGMENTS.map((s) => {
          const v = Math.max(0, values[s.key]);
          if (!v || gross <= 0) return null;
          return (
            <div
              key={s.key}
              title={`${s.label}: ${money(values[s.key])} (${pct(values[s.key], gross)})`}
              className="h-full first:rounded-l last:rounded-r"
              style={{ width: `${(v / gross) * 100}%`, background: s.color }}
            />
          );
        })}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600 dark:text-slate-300">
        {SEGMENTS.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <span
              className="size-2.5 rounded-sm"
              style={{ background: s.color }}
              aria-hidden="true"
            />
            {s.label} <span className="font-medium tabular-nums">{pct(values[s.key], gross)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AmountList({ title, items, total }: { title: string; items: PayAmount[]; total: number }) {
  return (
    <div>
      <h3 className="mb-1 flex justify-between text-sm font-semibold">
        {title} <span className="tabular-nums">{money(total)}</span>
      </h3>
      <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
        {items.map((a) => (
          <li key={a.name} className="flex justify-between gap-3 py-1.5">
            <span>
              {a.name}
              {a.preTax && (
                <span
                  className="ml-1.5 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                  title="Taken out before federal income tax"
                >
                  pre-tax
                </span>
              )}
              {a.fromStubs && (
                <span
                  className="ml-1.5 text-xs text-amber-700 dark:text-amber-400"
                  title="The stub shows no year-to-date amount, so this adds up only the stubs you added"
                >
                  from your stubs
                </span>
              )}
            </span>
            <span className="tabular-nums">{money(a.cents)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function YearCard({ year, b }: { year: number; b: PayBreakdown }) {
  const tax = sum(b.taxes);
  const ded = sum(b.deductions);
  const fromW2 = b.source === "w2";
  const tiles: [string, number, string][] = [
    ["Gross pay", b.grossCents, "Before anything comes out"],
    ["Taxes", tax, pct(tax, b.grossCents)],
    [fromW2 ? "Pre-tax benefits" : "Benefits & deductions", ded, pct(ded, b.grossCents)],
    [
      fromW2 ? "Take-home and after-tax deductions" : "Take-home",
      b.takeHomeCents,
      pct(b.takeHomeCents, b.grossCents),
    ],
  ];
  return (
    <Card className="space-y-4">
      <div>
        <h2 className="font-semibold">
          {fromW2 ? `${year} from your W-2` : `${year} so far`}
          {b.employers.length > 0 && (
            <span className="ml-2 text-sm font-normal text-slate-500">
              {b.employers.join(", ")}
            </span>
          )}
        </h2>
        <p className="text-xs text-slate-500">
          {fromW2
            ? "From the W-2's boxes and the earnings summary printed with it."
            : `Year to date on your pay stub for ${day(b.asOf)}.`}
        </p>
      </div>
      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {tiles.map(([k, v, sub]) => (
          <div key={k} className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
            <dt className="text-xs text-slate-500">{k}</dt>
            <dd className="text-xl font-semibold tabular-nums">{money(v)}</dd>
            <dd className="text-xs text-slate-500">{sub}</dd>
          </div>
        ))}
      </dl>
      <Split gross={b.grossCents} take={b.takeHomeCents} tax={tax} ded={ded} />
      <div className="grid gap-6 md:grid-cols-2">
        <AmountList title="Taxes" items={b.taxes} total={tax} />
        <AmountList
          title={fromW2 ? "Taken out before tax" : "Benefits & deductions"}
          items={b.deductions}
          total={ded}
        />
      </div>
      {b.healthCoverageCents !== null && (
        <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm dark:bg-slate-800/60">
          Your health coverage cost{" "}
          <span className="font-semibold">{money(b.healthCoverageCents)}</span> in {year} in all,
          counting your share and your employer's (W-2 box 12, code DD).
        </p>
      )}
    </Card>
  );
}

function PeriodCard({ p }: { p: PayPeriodView }) {
  const n = p.periodsPerYear;
  const every = n === 52 ? "week" : n === 26 ? "two weeks" : n === 24 ? "half month" : "month";
  const rows: [string, number, boolean?][] = [
    ["Gross pay", p.grossCents, true],
    ...p.taxes.map((t): [string, number] => [t.name, -t.cents]),
    ...p.deductions.map((d): [string, number] => [d.name, -d.cents]),
    ["Take-home", p.netCents, true],
  ];
  return (
    <Card className="p-0">
      <div className="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <h2 className="font-semibold">Each paycheck</h2>
        <p className="text-xs text-slate-500">
          Your pay stub for {day(p.payDate)}, paid every {every}, and the same for a year ({n}{" "}
          paychecks).
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-slate-500">
            <tr>
              <th className="px-4 py-2 font-medium" />
              <th className="px-4 py-2 text-right font-medium">Each paycheck</th>
              <th className="px-4 py-2 text-right font-medium">A year</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {rows.map(([name, c, strong]) => (
              <tr key={name} className={cx(strong && "font-semibold")}>
                <td className="px-4 py-1.5">{name}</td>
                <td className="px-4 py-1.5 text-right tabular-nums">{money(c)}</td>
                <td className="px-4 py-1.5 text-right tabular-nums">{money(c * n)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot className="text-xs text-slate-500">
            <tr>
              <td className="px-4 py-2">Benefits & deductions</td>
              <td className="px-4 py-2 text-right tabular-nums">{money(p.deductionsCents)}</td>
              <td className="px-4 py-2 text-right tabular-nums">{money(p.deductionsCents * n)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </Card>
  );
}

function W2Card({ w, onDelete }: { w: W2Info; onDelete: () => void }) {
  const b = w.boxes;
  const boxes: [string, number | null][] = [
    ["1 Wages", b.wagesCents],
    ["2 Federal income tax", b.federalCents],
    ["3 Social Security wages", b.ssWagesCents],
    ["4 Social Security tax", b.ssCents],
    ["5 Medicare wages", b.medicareWagesCents],
    ["6 Medicare tax", b.medicareCents],
    [`16 ${b.state ?? "State"} wages`, b.stateWagesCents],
    [`17 ${b.state ?? "State"} income tax`, b.stateCents],
    ["18 Local wages", b.localWagesCents],
    ["19 Local income tax", b.localCents],
    ...w.box12.map((x): [string, number] => [`12 ${x.code}`, x.cents]),
  ];
  const lastOfYear = w.check && w.check.stubDate >= `${w.year}-12-15`;
  return (
    <Card className="p-0">
      <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <div>
          <h2 className="font-semibold">
            {w.year} W-2
            {w.employer && <span className="font-normal text-slate-500"> · {w.employer}</span>}
          </h2>
          <p className="text-xs text-slate-500">{w.filename}</p>
        </div>
        <div className="flex gap-1">
          <a
            href={`/api/pay/w2/${w.id}/file`}
            target="_blank"
            rel="noreferrer"
            className="rounded p-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
            title="Open the PDF"
          >
            <FileText className="size-4" aria-hidden="true" />
            <span className="sr-only">Open the PDF</span>
          </a>
          <button
            type="button"
            onClick={onDelete}
            className="rounded p-1.5 text-slate-500 hover:bg-slate-100 hover:text-red-600 dark:hover:bg-slate-800"
            title="Delete"
          >
            <Trash2 className="size-4" aria-hidden="true" />
            <span className="sr-only">Delete this W-2</span>
          </button>
        </div>
      </div>
      <dl className="grid grid-cols-1 gap-x-6 px-4 py-3 text-sm sm:grid-cols-2">
        {boxes
          .filter(([, v]) => v !== null)
          .map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3 py-1">
              <dt className="text-slate-600 dark:text-slate-300">{k}</dt>
              <dd className="tabular-nums">{money(v as number)}</dd>
            </div>
          ))}
      </dl>
      {w.check && (
        <div className="border-t border-slate-200 px-4 py-3 dark:border-slate-800">
          <h3 className="text-sm font-semibold">Against your pay stubs</h3>
          <p className="mb-2 text-xs text-slate-500">
            Year to date on your stub for {day(w.check.stubDate)}.
            {!lastOfYear && " That isn't the year's last paycheck, so these won't match yet."}
          </p>
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-slate-500">
              <tr>
                <th className="py-1 font-medium" />
                <th className="py-1 text-right font-medium">W-2</th>
                <th className="py-1 text-right font-medium">Stub</th>
                <th className="py-1 text-right font-medium">Difference</th>
              </tr>
            </thead>
            <tbody>
              {w.check.rows.map((r) => {
                const diff = r.stubCents === null ? null : r.w2Cents - r.stubCents;
                return (
                  <tr key={r.label}>
                    <td className="py-1">{r.label}</td>
                    <td className="py-1 text-right tabular-nums">{money(r.w2Cents)}</td>
                    <td className="py-1 text-right tabular-nums">
                      {r.stubCents === null ? "—" : money(r.stubCents)}
                    </td>
                    <td className="py-1 text-right tabular-nums">
                      {diff === null ? (
                        "—"
                      ) : diff === 0 ? (
                        <span className="text-emerald-700 dark:text-emerald-400">Matches</span>
                      ) : (
                        money(diff)
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function StubRow({ s, onDelete }: { s: PayStubInfo; onDelete: () => void }) {
  const taxes = s.lines.filter((l) => l.kind === "tax").reduce((t, l) => t + (l.cents ?? 0), 0);
  const ded = s.lines.filter((l) => l.kind === "deduction").reduce((t, l) => t + (l.cents ?? 0), 0);
  return (
    <tr className="align-top">
      <td className="px-4 py-2 whitespace-nowrap">
        {day(s.payDate)}
        {s.problems.map((p) => (
          <p
            key={p}
            className="flex max-w-xs items-start gap-1 text-xs whitespace-normal text-amber-700 dark:text-amber-400"
          >
            <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden="true" /> {p}
          </p>
        ))}
      </td>
      <td className="px-2 py-2 text-right tabular-nums">{money(s.grossCents)}</td>
      <td className="hidden px-2 py-2 text-right tabular-nums sm:table-cell">{money(taxes)}</td>
      <td className="hidden px-2 py-2 text-right tabular-nums sm:table-cell">{money(ded)}</td>
      <td className="px-2 py-2 text-right font-medium tabular-nums">{money(s.netCents)}</td>
      <td className="hidden px-2 py-2 text-xs md:table-cell">
        <ul className="space-y-0.5">
          {s.deposits.map((d, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: deposits have no id; order is the stub's
            <li key={i} className="flex items-center gap-1">
              <span className="tabular-nums">{money(d.cents)}</span>
              {d.last4 && <span className="text-slate-500">…{d.last4}</span>}
              {d.transaction ? (
                <span
                  className="flex items-center gap-0.5 text-emerald-700 dark:text-emerald-400"
                  title={`Arrived ${day(d.transaction.date)}`}
                >
                  <Check className="size-3" aria-hidden="true" />
                  {d.transaction.accountName}
                </span>
              ) : (
                <span className="text-slate-500">not found in your accounts</span>
              )}
            </li>
          ))}
        </ul>
      </td>
      <td className="px-4 py-2 text-right whitespace-nowrap">
        <a
          href={`/api/pay/stubs/${s.id}/file`}
          target="_blank"
          rel="noreferrer"
          className="inline-block rounded p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
          title="Open the PDF"
        >
          <FileText className="size-4" aria-hidden="true" />
          <span className="sr-only">Open the PDF</span>
        </a>
        <button
          type="button"
          onClick={onDelete}
          className="rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-red-600 dark:hover:bg-slate-800"
          title="Delete"
        >
          <Trash2 className="size-4" aria-hidden="true" />
          <span className="sr-only">Delete the stub for {day(s.payDate)}</span>
        </button>
      </td>
    </tr>
  );
}

export function PayPage() {
  const qc = useQueryClient();
  const [year, setYear] = useState(() => new Date().getFullYear());
  const q = useQuery({
    queryKey: [...payKey, year],
    queryFn: () => api.get<PayYear>(`/api/pay/${year}`),
    placeholderData: keepPreviousData,
  });
  const [error, setError] = useState<string | null>(null);
  const p = q.data;
  const years = [...new Set([new Date().getFullYear(), ...(p?.years ?? [])])].sort((a, b) => b - a);
  async function remove(kind: "stubs" | "w2", id: string, what: string) {
    if (!window.confirm(`Delete ${what}?`)) return;
    try {
      await api.delete(`/api/pay/${kind}/${id}`);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't delete it");
    }
    await qc.invalidateQueries({ queryKey: payKey });
  }
  return (
    <>
      <PageHeader
        title="Pay"
        actions={
          <select
            aria-label="Year"
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            className="rounded-lg border border-slate-300 bg-surface px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
          >
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        }
      />
      <p className="-mt-3 mb-5 max-w-3xl text-sm text-slate-500">
        Your bank only sees take-home pay. Add the pay stubs (earnings statements) and W-2s you
        download from your payroll site to see what you earn, what goes to taxes and what your
        benefits cost. Muny reads ADP's PDFs; files are kept encrypted.
      </p>
      <div className="space-y-6">
        <Upload onDone={(y) => y && setYear(y)} />
        {q.isError && <Alert>{q.error.message}</Alert>}
        {error && <Alert>{error}</Alert>}
        {p && !p.breakdown && !p.stubs.length && !p.w2s.length && (
          <Card>
            <p className="text-sm text-slate-500">
              Nothing for {year} yet. Your latest pay stub is enough to see the year so far: its
              year-to-date column covers every paycheck before it. Add older stubs to check each
              deposit, and your W-2 when the year is over.
            </p>
          </Card>
        )}
        {p?.breakdown && <YearCard year={year} b={p.breakdown} />}
        {p?.latest?.payDate.startsWith(`${year}-`) && <PeriodCard p={p.latest} />}
        {p?.w2s.map((w) => (
          <W2Card key={w.id} w={w} onDelete={() => void remove("w2", w.id, `the ${w.year} W-2`)} />
        ))}
        {p && p.stubs.length > 0 && (
          <Card className="p-0">
            <div className="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
              <h2 className="font-semibold">Pay stubs</h2>
              <p className="text-xs text-slate-500">
                Each deposit is matched to your bank transactions by amount, date and the account's
                last 4 digits.
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-slate-500">
                  <tr>
                    <th className="px-4 py-2 font-medium">Pay date</th>
                    <th className="px-2 py-2 text-right font-medium">Gross</th>
                    <th className="hidden px-2 py-2 text-right font-medium sm:table-cell">Taxes</th>
                    <th className="hidden px-2 py-2 text-right font-medium sm:table-cell">
                      Deductions
                    </th>
                    <th className="px-2 py-2 text-right font-medium">Take-home</th>
                    <th className="hidden px-2 py-2 font-medium md:table-cell">Deposited</th>
                    <th className="px-4 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {p.stubs.map((s) => (
                    <StubRow
                      key={s.id}
                      s={s}
                      onDelete={() =>
                        void remove("stubs", s.id, `the pay stub for ${day(s.payDate)}`)
                      }
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>
    </>
  );
}

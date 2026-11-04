import {
  ACCOUNT_TYPE_LABELS,
  type AccountTarget,
  type CsvMapping,
  formatMoney,
  type ImportPreview,
  type ImportResult,
} from "@muny/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { CsvMappingCard } from "../components/CsvMappingCard.js";
import { Alert, Button, Card, cx, PageHeader } from "../components/ui.js";
import { api } from "../lib/api.js";
import { keys, useAccounts } from "../lib/queries.js";

interface LoadedFile {
  filename: string;
  content: string;
}

const FORMAT_LABEL: Record<string, string> = {
  rocket_money: "Rocket Money export",
  csv: "Bank CSV",
  ofx: "OFX/QFX",
};

function fmtDate(iso: string | null) {
  if (!iso) return "?";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y ?? 0, (m ?? 1) - 1, d ?? 1).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function ImportPage() {
  const qc = useQueryClient();
  const accounts = useAccounts();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<LoadedFile | null>(null);
  const [map, setMap] = useState<Record<string, AccountTarget>>({});
  const [csv, setCsv] = useState<CsvMapping | undefined>();
  const [applyBalances, setApplyBalances] = useState<Set<string>>(new Set());
  const [dragging, setDragging] = useState(false);

  const preview = useMutation({
    mutationFn: (req: LoadedFile & { csv?: CsvMapping }) =>
      api.post<ImportPreview>("/api/import/preview", req),
    onSuccess: (p) => {
      setMap(Object.fromEntries(p.accounts.map((a) => [a.key, a.match?.id ?? "new"])));
      setApplyBalances(new Set(p.accounts.filter((a) => a.statementBalance).map((a) => a.key)));
    },
  });
  const commit = useMutation({
    mutationFn: () =>
      api.post<ImportResult>("/api/import/commit", {
        ...file,
        csv,
        accountMap: map,
        applyBalances: [...applyBalances],
      }),
    onSuccess: () =>
      Promise.all(
        [keys.accounts, keys.transactions, keys.categories, keys.tags].map((queryKey) =>
          qc.invalidateQueries({ queryKey }),
        ),
      ),
  });

  const load = async (f: File) => {
    commit.reset();
    const loaded = { filename: f.name, content: await f.text() };
    setFile(loaded);
    setCsv(undefined);
    preview.mutate(loaded);
  };

  const reset = () => {
    setFile(null);
    setMap({});
    setCsv(undefined);
    preview.reset();
    commit.reset();
    if (inputRef.current) inputRef.current.value = "";
  };

  const p = preview.data;
  const importing = p
    ? p.accounts.filter((a) => map[a.key] !== "skip").reduce((s, a) => s + a.transactionCount, 0)
    : 0;

  return (
    <>
      <PageHeader title="Import" />

      {commit.data ? (
        <Card className="max-w-xl">
          <h2 className="text-lg font-semibold">Import complete</h2>
          <ul className="mt-3 space-y-1 text-sm">
            <li>
              <strong>{commit.data.imported.toLocaleString()}</strong> transactions imported
            </li>
            {commit.data.duplicates > 0 && (
              <li>{commit.data.duplicates.toLocaleString()} already in Muny (skipped)</li>
            )}
            {commit.data.skipped > 0 && (
              <li>{commit.data.skipped.toLocaleString()} from accounts you chose not to import</li>
            )}
            {commit.data.failed > 0 && (
              <li className="text-amber-600">{commit.data.failed} rows couldn't be read</li>
            )}
            {commit.data.accountsCreated > 0 && (
              <li>{commit.data.accountsCreated} accounts created</li>
            )}
            {commit.data.categoriesCreated > 0 && (
              <li>{commit.data.categoriesCreated} categories created</li>
            )}
            {commit.data.rulesApplied > 0 && (
              <li>
                {commit.data.rulesApplied.toLocaleString()} changed by your{" "}
                <Link to="/settings" hash="rules" className="underline">
                  rules
                </Link>
              </li>
            )}
            {commit.data.balancesUpdated > 0 && (
              <li>
                {commit.data.balancesUpdated} account balance
                {commit.data.balancesUpdated === 1 ? "" : "s"} updated from the statement
              </li>
            )}
          </ul>
          {commit.data.accountsCreated > commit.data.balancesUpdated && (
            <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-300">
              New accounts start from a $0 opening balance. Open each one on the{" "}
              <Link to="/accounts" className="underline">
                Accounts
              </Link>{" "}
              page and set its current balance to match your bank.
            </p>
          )}
          <div className="mt-4 flex gap-2">
            <Link to="/transactions">
              <Button>View transactions</Button>
            </Link>
            <Button variant="secondary" onClick={reset}>
              Import another file
            </Button>
          </div>
        </Card>
      ) : !file ? (
        <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
          <label
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const f = e.dataTransfer.files[0];
              if (f) void load(f);
            }}
            className={cx(
              "flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-16 text-center transition-colors",
              dragging
                ? "border-brand-500 bg-brand-50 dark:bg-brand-700/10"
                : "border-slate-300 bg-white hover:border-brand-500 dark:border-slate-700 dark:bg-slate-900",
            )}
          >
            <span className="text-3xl" aria-hidden>
              ⇪
            </span>
            <span className="mt-2 font-medium">Drop a file here or click to choose</span>
            <span className="mt-1 text-sm text-slate-500">
              Rocket Money export, bank CSV, or OFX / QFX / QBO
            </span>
            <input
              ref={inputRef}
              type="file"
              accept=".csv,.ofx,.qfx,.qbo,text/csv"
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void load(f);
              }}
            />
          </label>
          <Card>
            <h2 className="font-semibold">Moving from Rocket Money</h2>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-slate-600 dark:text-slate-400">
              <li>In Rocket Money on the web, open Transactions.</li>
              <li>Set the date range to all time.</li>
              <li>Click Export and save the CSV.</li>
              <li>Drop it here. You'll review everything before anything is saved.</li>
            </ol>
            <h2 className="mt-5 font-semibold">From your bank</h2>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
              Download activity from your bank's website. Prefer <strong>OFX</strong>,{" "}
              <strong>QFX</strong> or <strong>QBO</strong> (often labelled "Quicken" or "Money"):
              they include the balance. CSV works too, with presets for Chase, Ally and PayPal.
            </p>
            <p className="mt-3 text-xs text-slate-500">
              Re-importing is safe: transactions already in Muny, including ones from Rocket Money
              with the same date and amount, are skipped.
            </p>
          </Card>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-slate-600 dark:text-slate-400">
              <strong>{file.filename}</strong>
              {p && ` · ${FORMAT_LABEL[p.format] ?? p.format}`}
            </p>
            <Button variant="ghost" onClick={reset}>
              Choose a different file
            </Button>
          </div>

          {preview.isPending && <Card>Reading file…</Card>}
          {preview.error && <Alert>{preview.error.message}</Alert>}

          {p?.csv && (
            <CsvMappingCard
              key={file.filename}
              info={p.csv}
              busy={preview.isPending}
              onApply={(m) => {
                setCsv(m);
                preview.mutate({ ...file, csv: m });
              }}
            />
          )}

          {p && (p.accounts.length > 0 || !p.csv) && (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <Card>
                  <p className="text-xs uppercase tracking-wide text-slate-500">Transactions</p>
                  <p className="mt-1 text-2xl font-semibold">
                    {p.transactionCount.toLocaleString()}
                  </p>
                  <p className="text-xs text-slate-500">
                    {fmtDate(p.firstDate)} – {fmtDate(p.lastDate)}
                  </p>
                </Card>
                <Card>
                  <p className="text-xs uppercase tracking-wide text-slate-500">Already in Muny</p>
                  <p className="mt-1 text-2xl font-semibold">{p.duplicateCount.toLocaleString()}</p>
                  <p className="text-xs text-slate-500">Will be skipped</p>
                </Card>
                <Card>
                  <p className="text-xs uppercase tracking-wide text-slate-500">New categories</p>
                  <p className="mt-1 text-2xl font-semibold">{p.newCategories.length}</p>
                  <p className="truncate text-xs text-slate-500" title={p.newCategories.join(", ")}>
                    {p.newCategories.slice(0, 4).join(", ") || "None"}
                    {p.newCategories.length > 4 && "…"}
                  </p>
                </Card>
              </div>

              {p.errorCount > 0 && (
                <Card className="border-amber-300 dark:border-amber-800">
                  <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
                    {p.errorCount} row{p.errorCount === 1 ? "" : "s"} can't be read and will be
                    skipped
                  </p>
                  <ul className="mt-2 max-h-32 overflow-auto text-xs text-slate-500">
                    {p.errors.map((e) => (
                      <li key={`${e.line}-${e.message}`}>
                        Line {e.line}: {e.message}
                      </li>
                    ))}
                  </ul>
                </Card>
              )}

              <section>
                <h2 className="mb-2 font-semibold">Accounts in this file</h2>
                <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
                  {p.accounts.map((a) => (
                    <li
                      key={a.key}
                      className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                    >
                      <div className="min-w-0">
                        <p className="font-medium">
                          {a.name}
                          {a.mask && <span className="text-slate-500"> ••{a.mask}</span>}
                        </p>
                        <p className="text-xs text-slate-500">
                          {[a.institutionName, ACCOUNT_TYPE_LABELS[a.type]]
                            .filter(Boolean)
                            .join(" · ")}{" "}
                          · {a.transactionCount.toLocaleString()} transactions ·{" "}
                          {fmtDate(a.firstDate)} – {fmtDate(a.lastDate)}
                        </p>
                        {a.statementBalance && map[a.key] !== "skip" && (
                          <label className="mt-1 flex items-center gap-2 text-xs">
                            <input
                              type="checkbox"
                              className="accent-brand-600"
                              checked={applyBalances.has(a.key)}
                              onChange={(e) =>
                                setApplyBalances((cur) => {
                                  const next = new Set(cur);
                                  if (e.target.checked) next.add(a.key);
                                  else next.delete(a.key);
                                  return next;
                                })
                              }
                            />
                            Set balance to{" "}
                            <strong className="tabular-nums">
                              {formatMoney(a.statementBalance.cents)}
                            </strong>{" "}
                            as of {fmtDate(a.statementBalance.asOf)}
                          </label>
                        )}
                      </div>
                      <select
                        aria-label={`Import ${a.name} into`}
                        value={map[a.key] ?? "new"}
                        onChange={(e) => setMap((m) => ({ ...m, [a.key]: e.target.value }))}
                        className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
                      >
                        <option value="new">Create new account</option>
                        {accounts.data?.map((acc) => (
                          <option key={acc.id} value={acc.id}>
                            Into: {acc.name}
                            {acc.id === a.match?.id ? " (match)" : ""}
                          </option>
                        ))}
                        <option value="skip">Don't import</option>
                      </select>
                    </li>
                  ))}
                </ul>
              </section>

              {commit.error && <Alert>{commit.error.message}</Alert>}
              <div className="flex justify-end gap-2">
                <Button variant="secondary" onClick={reset}>
                  Cancel
                </Button>
                <Button
                  onClick={() => commit.mutate()}
                  disabled={commit.isPending || importing === 0}
                >
                  {commit.isPending
                    ? "Importing…"
                    : `Import ${importing.toLocaleString()} transactions`}
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}

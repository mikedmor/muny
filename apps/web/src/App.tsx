import type { HealthResponse, MetaResponse } from "@muny/shared";
import { useEffect, useState } from "react";

type Load<T> = { state: "loading" } | { state: "ok"; data: T } | { state: "error"; error: string };

function useJson<T>(url: string): Load<T> {
  const [result, setResult] = useState<Load<T>>({ state: "loading" });
  useEffect(() => {
    const ctrl = new AbortController();
    fetch(url, { signal: ctrl.signal })
      .then(async (res) => {
        const data = (await res.json()) as T;
        setResult({ state: "ok", data });
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setResult({ state: "error", error: err instanceof Error ? err.message : String(err) });
      });
    return () => ctrl.abort();
  }, [url]);
  return result;
}

export function App() {
  const health = useJson<HealthResponse>("/api/health");
  const meta = useJson<MetaResponse>("/api/meta");

  return (
    <div className="flex min-h-dvh flex-col bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <header className="border-b border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900">
        <div className="mx-auto flex max-w-5xl items-center gap-2">
          <img src="/favicon.svg" alt="" className="size-7" />
          <span className="text-lg font-semibold">Muny</span>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-10">
        <h1 className="text-2xl font-semibold">Welcome to Muny</h1>
        <p className="mt-2 max-w-prose text-slate-600 dark:text-slate-400">
          Self-hosted personal finance and subscription tracking. This is the Phase 0 skeleton.
          Accounts, imports and transactions arrive in Phase 1.
        </p>

        <section className="mt-8 max-w-md rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <h2 className="text-sm font-medium uppercase tracking-wide text-slate-500">
            System status
          </h2>
          {health.state === "loading" && <p className="mt-3 text-slate-500">Checking…</p>}
          {health.state === "error" && (
            <p className="mt-3 text-red-600">Server unreachable: {health.error}</p>
          )}
          {health.state === "ok" && (
            <dl className="mt-3 grid grid-cols-2 gap-y-2 text-sm">
              <dt className="text-slate-500">Server</dt>
              <dd className={health.data.status === "ok" ? "text-emerald-600" : "text-amber-600"}>
                {health.data.status}
              </dd>
              <dt className="text-slate-500">Database</dt>
              <dd className={health.data.db === "ok" ? "text-emerald-600" : "text-red-600"}>
                {health.data.db}
              </dd>
              <dt className="text-slate-500">Migrations applied</dt>
              <dd>{health.data.migrations}</dd>
              <dt className="text-slate-500">Version</dt>
              <dd>{health.data.version}</dd>
            </dl>
          )}
        </section>
      </main>

      <footer className="border-t border-slate-200 px-4 py-4 text-xs text-slate-500 dark:border-slate-800">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2">
          <span>
            Muny {meta.state === "ok" ? `v${meta.data.version}` : ""} · Licensed under AGPL-3.0
          </span>
          {meta.state === "ok" && (
            <a
              href={meta.data.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="underline hover:text-slate-700 dark:hover:text-slate-300"
            >
              Source code
            </a>
          )}
        </div>
      </footer>
    </div>
  );
}

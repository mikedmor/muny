import { Alert, Button, Card } from "../../components/ui.js";
import { useMeta } from "../../lib/auth.js";
import { useBackups, useCreateBackup } from "../../lib/queries.js";

function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const linkButton =
  "inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800";

export function DataSettings() {
  const backups = useBackups();
  const create = useCreateBackup();
  const meta = useMeta();
  const b = backups.data;

  return (
    <section className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Export</h2>
        <p className="mb-3 text-sm text-slate-500">Your data is yours. Take it anywhere.</p>
        <div className="flex flex-wrap gap-2">
          <a className={linkButton} href="/api/export/transactions.csv" download>
            Transactions (CSV)
          </a>
          <a className={linkButton} href="/api/export/muny.json" download>
            Everything (JSON)
          </a>
        </div>
        <p className="mt-2 text-xs text-slate-500">
          The CSV opens in any spreadsheet (split transactions get one row per part). The JSON has
          accounts, categories, merchants, tags, rules and every transaction.
        </p>
      </div>

      <div>
        <h2 className="text-lg font-semibold">Backups</h2>
        <p className="mb-3 text-sm text-slate-500">
          {b
            ? b.intervalHours > 0
              ? `Muny backs up its database every ${b.intervalHours === 24 ? "day" : `${b.intervalHours} hours`} and keeps the newest ${b.keep}.`
              : "Automatic backups are turned off (MUNY_BACKUP_INTERVAL_HOURS=0)."
            : "Loading…"}{" "}
          Backups are stored next to the database, so also copy them off the NAS (for example with
          Hyper Backup).
        </p>
        {backups.isError && (
          <Alert>
            {backups.error.message.includes("owner")
              ? "Only the household owner manages backups."
              : "Couldn't load backups."}
          </Alert>
        )}
        {create.error && <Alert>{create.error.message}</Alert>}
        <Card className="p-0">
          <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
            <span className="truncate text-xs text-slate-500" title={b?.dir}>
              {b?.dir}
            </span>
            <Button variant="secondary" disabled={create.isPending} onClick={() => create.mutate()}>
              {create.isPending ? "Backing up…" : "Back up now"}
            </Button>
          </div>
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {b?.backups.map((x) => (
              <li
                key={x.name}
                className="flex items-center justify-between gap-3 px-4 py-2 text-sm"
              >
                <span>
                  {new Date(x.createdAt).toLocaleString()}{" "}
                  <span className="text-xs text-slate-500">· {fmtBytes(x.sizeBytes)}</span>
                </span>
                <a
                  href={`/api/backups/${x.name}`}
                  download
                  className="text-brand-600 hover:underline"
                >
                  Download
                </a>
              </li>
            ))}
            {b && b.backups.length === 0 && (
              <li className="px-4 py-3 text-sm text-slate-500">No backups yet.</li>
            )}
          </ul>
        </Card>
        <p className="mt-2 text-xs text-slate-500">
          To restore: stop the container, replace <code>muny.db</code> in the data folder with a
          backup file (renamed to <code>muny.db</code>), and start it again. See DEPLOYMENT.md.
        </p>
      </div>

      <div>
        <h2 className="text-lg font-semibold">About</h2>
        <p className="text-sm text-slate-500">
          Muny {meta.data ? `v${meta.data.version}` : ""} is free software under the GNU AGPL-3.0.{" "}
          {meta.data && (
            <a
              href={meta.data.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="text-brand-600 underline"
            >
              Get the source code
            </a>
          )}
        </p>
      </div>
    </section>
  );
}

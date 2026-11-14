import type { UpdateStatus } from "@muny/shared";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ExternalLink, RefreshCw, Sparkles } from "lucide-react";
import { useState } from "react";
import { ReleaseNotes } from "../../components/ReleaseNotes.js";
import { Alert, Button, Card, cx } from "../../components/ui.js";
import { api } from "../../lib/api.js";
import { useAuthStatus, useMeta } from "../../lib/auth.js";
import { updatesKey, useUpdates } from "../../lib/queries.js";

/**
 * Settings → Updates: the version running, the opt-in daily check for a newer
 * release (with what's new), and how to update each kind of install. Muny
 * never updates itself.
 */

const WAYS = [
  {
    key: "compose",
    label: "Docker Compose",
    steps: ["In the folder with compose.yaml, run `docker compose pull && docker compose up -d`"],
  },
  {
    key: "synology",
    label: "Synology",
    steps: [
      "Container Manager → Project → your Muny project → Action → Build. It pulls the newest image and restarts Muny.",
      "Or over SSH, in the project folder, run `sudo docker compose pull && sudo docker compose up -d`",
    ],
  },
  {
    key: "unraid",
    label: "Unraid",
    steps: ["Docker tab → Check for Updates, then apply the update next to Muny."],
  },
  {
    key: "auto",
    label: "Automatically",
    steps: [
      "Muny can't update itself (it has no access to Docker). A tool like Watchtower can pull new images on a schedule; keep the image on `:1` so it never jumps to a major version that might need you to do something.",
    ],
  },
] as const;

const ago = (ms: number) => {
  const min = Math.round((Date.now() - ms) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"} ago`;
  return new Date(ms).toLocaleDateString();
};

function Switch({
  checked,
  label,
  disabled,
  onChange,
}: {
  checked: boolean;
  label: string;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        "relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:opacity-50",
        checked ? "bg-brand-600" : "bg-slate-300 dark:bg-slate-700",
      )}
    >
      <span
        className={cx(
          "absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow transition-transform",
          checked && "translate-x-4",
        )}
      />
    </button>
  );
}

export function UpdatesSettings() {
  const q = useUpdates();
  const meta = useMeta();
  const owner = useAuthStatus().data?.user?.role === "owner";
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [way, setWay] = useState<(typeof WAYS)[number]["key"]>("compose");
  const s = q.data;
  const run = async (fn: () => Promise<UpdateStatus>) => {
    setBusy(true);
    setError(null);
    try {
      qc.setQueryData(updatesKey, await fn());
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work");
    } finally {
      setBusy(false);
    }
  };
  const newest = s?.newer[0];
  return (
    <div className="space-y-6">
      <Card className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-semibold">Muny {s?.current ?? meta.data?.version ?? ""}</h2>
            <p className="text-sm text-slate-500">
              The version running now.{" "}
              {meta.data && (
                <a
                  href={`${meta.data.sourceUrl}/releases`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-brand-600 hover:underline"
                >
                  All releases
                </a>
              )}
            </p>
          </div>
          {s && (
            <span className="flex items-start gap-3">
              <span className="text-right text-sm">
                <span className="block font-medium">Check for new versions</span>
                <span className="block text-xs text-slate-500">Once a day, off by default</span>
              </span>
              <Switch
                checked={s.enabled}
                label="Check for new versions"
                disabled={!owner || busy || !s.repo}
                onChange={(enabled) =>
                  run(() => api.put<UpdateStatus>("/api/updates", { enabled }))
                }
              />
            </span>
          )}
        </div>
        <p className="text-xs text-slate-500">
          When it&apos;s on, Muny&apos;s server asks GitHub&apos;s public list of releases
          {s?.repo ? ` (${s.repo})` : ""} once a day. Nothing about you or your money is sent:
          GitHub only sees your server&apos;s IP address and the words &quot;Muny
          (self-hosted)&quot;. A new version shows here, as a dot on the menu, and as an alert
          (Alerts → A new version of Muny).
          {!owner && " Only the household owner can turn it on."}
        </p>
        {s && !s.repo && (
          <Alert>
            Muny&apos;s source link (MUNY_SOURCE_URL) isn&apos;t a GitHub project, so it can&apos;t
            check for releases.
          </Alert>
        )}
        {(error || s?.error) && <Alert>{error ?? s?.error}</Alert>}
        {s?.enabled && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm dark:bg-slate-800/50">
            {newest ? (
              <span className="flex items-center gap-2 font-medium text-brand-700 dark:text-brand-500">
                <Sparkles aria-hidden="true" className="size-4" />
                Muny {newest.version} is out
                {s.newer.length > 1 && ` (${s.newer.length} new versions)`}
              </span>
            ) : (
              <span className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400">
                <CheckCircle2 aria-hidden="true" className="size-4" />
                {s.latest ? "You're on the latest version." : "No releases found yet."}
              </span>
            )}
            <span className="flex items-center gap-2 text-xs text-slate-500">
              {s.checkedAt && `Checked ${ago(s.checkedAt)}`}
              {owner && (
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => run(() => api.post<UpdateStatus>("/api/updates/check"))}
                >
                  <RefreshCw
                    aria-hidden="true"
                    className={cx("mr-1 inline size-3.5", busy && "animate-spin")}
                  />
                  Check now
                </Button>
              )}
            </span>
          </div>
        )}
      </Card>

      {s && s.newer.length > 0 && (
        <Card className="space-y-4">
          <h2 className="font-semibold">What&apos;s new since {s.current}</h2>
          {s.newer.map((r) => (
            <section
              key={r.version}
              className="space-y-2 border-t border-slate-100 pt-3 first:border-0 first:pt-0 dark:border-slate-800"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="font-semibold">
                  {r.version}
                  {r.publishedAt && (
                    <span className="ml-2 text-xs font-normal text-slate-500">
                      {new Date(r.publishedAt).toLocaleDateString()}
                    </span>
                  )}
                </h3>
                <a
                  href={r.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-brand-600 hover:underline"
                >
                  Release page <ExternalLink aria-hidden="true" className="size-3" />
                </a>
              </div>
              <ReleaseNotes notes={r.notes} />
            </section>
          ))}
        </Card>
      )}

      <Card className="space-y-3">
        <h2 className="font-semibold">How to update</h2>
        <p className="text-sm text-slate-500">
          Your data stays where it is: the new version moves the database forward by itself when it
          starts. Make a backup first if you like (Settings → Data &amp; backups).
        </p>
        <div className="flex flex-wrap gap-1" role="tablist" aria-label="Install type">
          {WAYS.map((w) => (
            <button
              key={w.key}
              type="button"
              role="tab"
              aria-selected={way === w.key}
              onClick={() => setWay(w.key)}
              className={cx(
                "rounded-full px-3 py-1 text-sm",
                way === w.key ? "bg-slate-200 font-medium dark:bg-slate-700" : "text-slate-500",
              )}
            >
              {w.label}
            </button>
          ))}
        </div>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {WAYS.find((w) => w.key === way)?.steps.map((step) => (
            <li key={step}>
              {step.split(/(`[^`]+`)/).map((part) =>
                part.startsWith("`") ? (
                  <code
                    key={part}
                    className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs dark:bg-slate-800"
                  >
                    {part.slice(1, -1)}
                  </code>
                ) : (
                  part
                ),
              )}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

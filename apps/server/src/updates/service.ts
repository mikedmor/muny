import { type MunyDb, newId, schema } from "@muny/db";
import { compareVersions, type ReleaseNote, type UpdateStatus } from "@muny/shared";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { type AlertDeps, ensureAlertRules, sendPending } from "../alerts/service.js";
import { VERSION } from "../version.js";

/**
 * The update check (D-089). Off until the owner turns it on: then, at most
 * once a day, Muny asks GitHub's public API for the project's releases (no
 * key, nothing about you sent; GitHub sees the server's IP address and a
 * "Muny (self-hosted)" User-Agent). A newer release shows in Settings, as a
 * dot on the menu and, once per version, as an "app_update" alert. Muny never
 * updates itself.
 */

const SETTINGS_KEY = "updates.settings";
/** Untracked (not undoable): what the last check found. */
export const UPDATES_STATE_KEY = "updates.state";
const DAY = 24 * 60 * 60 * 1000;
const MAX_NOTES = 6000;

interface State {
  checkedAt: number | null;
  releases: ReleaseNote[];
  error: string | null;
}

export interface UpdateDeps {
  sourceUrl: string;
  fetch?: typeof fetch;
  alerts?: AlertDeps;
}

const read = <T>(db: MunyDb, key: string): T | undefined =>
  db.select().from(schema.appSettings).where(eq(schema.appSettings.key, key)).get()?.value as
    | T
    | undefined;

const write = (db: MunyDb, key: string, value: unknown) =>
  db
    .insert(schema.appSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: schema.appSettings.key, set: { value } })
    .run();

/** "owner/repo" from a GitHub URL; null for anything else. */
export function repoFrom(sourceUrl: string): string | null {
  const m = sourceUrl.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

export const updatesEnabled = (db: MunyDb) =>
  read<{ enabled?: boolean }>(db, SETTINGS_KEY)?.enabled === true;

export function setUpdatesEnabled(db: MunyDb, enabled: boolean) {
  write(db, SETTINGS_KEY, { enabled });
}

const state = (db: MunyDb): State =>
  read<State>(db, UPDATES_STATE_KEY) ?? { checkedAt: null, releases: [], error: null };

export function updateStatus(db: MunyDb, sourceUrl: string, current = VERSION): UpdateStatus {
  const s = state(db);
  const sorted = [...s.releases].sort((a, b) => compareVersions(b.version, a.version));
  return {
    current,
    enabled: updatesEnabled(db),
    repo: repoFrom(sourceUrl),
    checkedAt: s.checkedAt,
    latest: sorted[0]?.version ?? null,
    newer: sorted.filter((r) => compareVersions(r.version, current) > 0),
    error: s.error,
  };
}

const Release = z.object({
  tag_name: z.string().max(100),
  name: z.string().max(300).nullish(),
  body: z.string().nullish(),
  html_url: z.string().url().max(500),
  published_at: z.string().max(40).nullish(),
  draft: z.boolean().optional(),
  prerelease: z.boolean().optional(),
});

/** Ask GitHub now. Records what it found (or why it couldn't) and alerts once per new version. */
export async function checkForUpdates(
  db: MunyDb,
  deps: UpdateDeps,
  now = Date.now(),
  current = VERSION,
): Promise<UpdateStatus> {
  const repo = repoFrom(deps.sourceUrl);
  const prev = state(db);
  const save = (s: Partial<State>) =>
    write(db, UPDATES_STATE_KEY, { ...prev, checkedAt: now, ...s });
  if (!repo) {
    save({ error: "Muny's source isn't on GitHub, so it can't check for releases." });
    return updateStatus(db, deps.sourceUrl, current);
  }
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(`https://api.github.com/repos/${repo}/releases?per_page=10`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "Muny (self-hosted)" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    save({ error: "Couldn't reach GitHub. Muny will try again tomorrow." });
    return updateStatus(db, deps.sourceUrl, current);
  }
  if (!res.ok) {
    save({
      error:
        res.status === 403 || res.status === 429
          ? "GitHub is limiting requests right now. Muny will try again tomorrow."
          : `GitHub answered ${res.status}. Muny will try again tomorrow.`,
    });
    return updateStatus(db, deps.sourceUrl, current);
  }
  const parsed = z.array(Release).safeParse(await res.json().catch(() => null));
  if (!parsed.success) {
    save({ error: "GitHub's answer wasn't a list of releases." });
    return updateStatus(db, deps.sourceUrl, current);
  }
  const releases: ReleaseNote[] = parsed.data
    .filter((r) => !r.draft && !r.prerelease && /^v?\d+\.\d+\.\d+$/.test(r.tag_name))
    .filter((r) => r.html_url.startsWith(`https://github.com/${repo}/`))
    .map((r) => ({
      version: r.tag_name.replace(/^v/, ""),
      name: r.name ?? null,
      publishedAt: r.published_at ?? null,
      url: r.html_url,
      notes: (r.body ?? "").replace(/\r\n/g, "\n").slice(0, MAX_NOTES),
    }));
  write(db, UPDATES_STATE_KEY, { checkedAt: now, releases, error: null } satisfies State);
  const status = updateStatus(db, deps.sourceUrl, current);
  if (status.newer[0]) notify(db, status.newer[0], current, deps.alerts, now);
  return status;
}

/** One notification per new version (if the alert is on). */
function notify(
  db: MunyDb,
  r: ReleaseNote,
  current: string,
  alerts: AlertDeps | undefined,
  now: number,
) {
  ensureAlertRules(db);
  const rule = db
    .select({ enabled: schema.alertRules.enabled })
    .from(schema.alertRules)
    .where(eq(schema.alertRules.type, "app_update"))
    .get();
  if (rule && !rule.enabled) return;
  const summary = r.notes
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#") && !l.startsWith("-"));
  const added = db
    .insert(schema.notifications)
    .values({
      id: newId(),
      ruleType: "app_update",
      dedupeKey: `app_update:${r.version}`,
      severity: "info",
      title: `Muny ${r.version} is out`,
      body: `${summary ? `${summary.slice(0, 300)} ` : ""}You're on ${current}. Settings → Updates says how to update.`,
      link: "/settings#updates",
    })
    .onConflictDoNothing()
    .run().changes;
  if (added && alerts) void sendPending(db, alerts, new Date(now)).catch(() => {});
}

/** Check when it's on and a day has passed since the last check. */
export async function maybeCheckForUpdates(db: MunyDb, deps: UpdateDeps, now = Date.now()) {
  if (!updatesEnabled(db)) return false;
  const last = state(db).checkedAt;
  if (last && now - last < DAY) return false;
  await checkForUpdates(db, deps, now);
  return true;
}

/** Look every hour; ask GitHub at most once a day, and only when it's turned on. */
export function startUpdateChecks(
  db: MunyDb,
  deps: UpdateDeps,
  log?: { warn: (o: object, msg: string) => void },
) {
  const tick = () =>
    void maybeCheckForUpdates(db, deps).catch((err) =>
      log?.warn({ error: err instanceof Error ? err.message : "unknown" }, "Update check failed"),
    );
  const timer = setInterval(tick, 60 * 60 * 1000);
  timer.unref();
  const first = setTimeout(tick, 60_000);
  first.unref();
  return () => {
    clearInterval(timer);
    clearTimeout(first);
  };
}

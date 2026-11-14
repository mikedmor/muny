/**
 * Update check (D-089): when the owner turns it on, Muny asks GitHub once a
 * day for its list of releases and says when a newer one is out, with what's
 * new. It never updates itself.
 */

export interface ReleaseNote {
  /** "1.4.0" */
  version: string;
  name: string | null;
  /** ISO date-time. */
  publishedAt: string | null;
  /** The release page. */
  url: string;
  /** Release notes (markdown, trimmed). */
  notes: string;
}

export interface UpdateStatus {
  /** The version running now. */
  current: string;
  /** The daily check is on. */
  enabled: boolean;
  /** owner/repo releases are checked on; null when the source isn't on GitHub. */
  repo: string | null;
  /** unix ms of the last check. */
  checkedAt: number | null;
  /** The newest release, when known. */
  latest: string | null;
  /** Releases newer than the running one, newest first. */
  newer: ReleaseNote[];
  /** Why the last check didn't work. */
  error: string | null;
}

/** "1.10.0" vs "1.9.2": negative, zero or positive. Non-numeric parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(/[.-]/).slice(0, 3).map(Number);
  const pb = b.replace(/^v/, "").split(/[.-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i++) {
    const d =
      (Number.isFinite(pa[i]) ? (pa[i] as number) : 0) -
      (Number.isFinite(pb[i]) ? (pb[i] as number) : 0);
    if (d) return d;
  }
  return 0;
}

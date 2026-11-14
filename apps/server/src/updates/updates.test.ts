import { schema } from "@muny/db";
import { compareVersions, type UpdateStatus } from "@muny/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { makeSignedInApp } from "../test-utils.js";
import { VERSION } from "../version.js";
import { maybeCheckForUpdates, repoFrom } from "./service.js";

// A fake GitHub: no request leaves the test.

const [maj, min] = VERSION.split(".").map(Number) as [number, number];
const NEXT = `${maj}.${min + 1}.0`;
const RELEASES = [
  {
    tag_name: `v${NEXT}`,
    name: `v${NEXT}`,
    body: "Something new.\n\n### Added\n\n- **A thing.**",
    html_url: `https://github.com/mikedmor/muny/releases/tag/v${NEXT}`,
    published_at: "2026-12-01T00:00:00Z",
  },
  {
    tag_name: `v${maj}.${min + 2}.0-rc.1`,
    html_url: "https://github.com/mikedmor/muny/releases/tag/rc",
    prerelease: true,
  },
  {
    tag_name: `v${VERSION}`,
    body: "Older.",
    html_url: `https://github.com/mikedmor/muny/releases/tag/v${VERSION}`,
  },
  { tag_name: "v99.0.0", body: "Not from this repo.", html_url: "https://example.com/elsewhere" },
];

function fakeGitHub(answer: () => Response) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: init?.headers as Record<string, string> });
    return answer();
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("update check", () => {
  it("reads versions and GitHub addresses", () => {
    expect(compareVersions("1.10.0", "1.9.2")).toBeGreaterThan(0);
    expect(compareVersions("v1.3.0", "1.3.0")).toBe(0);
    expect(repoFrom("https://github.com/mikedmor/muny")).toBe("mikedmor/muny");
    expect(repoFrom("https://github.com/someone/fork.git")).toBe("someone/fork");
    expect(repoFrom("https://gitlab.com/a/b")).toBeNull();
  });

  it("is off until the owner turns it on, then finds newer releases and alerts once", async () => {
    const gh = fakeGitHub(() => Response.json(RELEASES));
    const { client, db } = await makeSignedInApp({ updateFetch: gh.f });
    let s = (await client.get("/api/updates")).json<UpdateStatus>();
    expect(s).toMatchObject({ current: VERSION, enabled: false, repo: "mikedmor/muny", newer: [] });
    expect(
      await maybeCheckForUpdates(db, {
        sourceUrl: "https://github.com/mikedmor/muny",
        fetch: gh.f,
      }),
    ).toBe(false);
    expect(gh.calls).toHaveLength(0);

    s = (await client.put("/api/updates", { enabled: true })).json<UpdateStatus>();
    expect(gh.calls).toHaveLength(1);
    expect(gh.calls[0]?.url).toBe(
      "https://api.github.com/repos/mikedmor/muny/releases?per_page=10",
    );
    expect(gh.calls[0]?.headers["user-agent"]).toBe("Muny (self-hosted)");
    // Pre-releases and releases from elsewhere are left out.
    expect(s.newer.map((r) => r.version)).toEqual([NEXT]);
    expect(s.latest).toBe(NEXT);

    const notes = () =>
      db
        .select()
        .from(schema.notifications)
        .where(eq(schema.notifications.ruleType, "app_update"))
        .all();
    expect(notes()).toHaveLength(1);
    expect(notes()[0]).toMatchObject({ title: `Muny ${NEXT} is out`, link: "/settings#updates" });

    // Checked a moment ago: "Check now" doesn't ask again, and a day later it does, without a second alert.
    await client.post("/api/updates/check");
    expect(gh.calls).toHaveLength(1);
    await maybeCheckForUpdates(
      db,
      { sourceUrl: "https://github.com/mikedmor/muny", fetch: gh.f },
      Date.now() + 25 * 3600_000,
    );
    expect(gh.calls).toHaveLength(2);
    expect(notes()).toHaveLength(1);
  });

  it("says why a check failed and keeps what it knew", async () => {
    let fail = false;
    const gh = fakeGitHub(() =>
      fail ? new Response("{}", { status: 403 }) : Response.json(RELEASES),
    );
    const { client, db } = await makeSignedInApp({ updateFetch: gh.f });
    await client.put("/api/updates", { enabled: true });
    fail = true;
    await maybeCheckForUpdates(
      db,
      { sourceUrl: "https://github.com/mikedmor/muny", fetch: gh.f },
      Date.now() + 25 * 3600_000,
    );
    const s = (await client.get("/api/updates")).json<UpdateStatus>();
    expect(s.error).toContain("limiting requests");
    expect(s.newer.map((r) => r.version)).toEqual([NEXT]);
  });
});

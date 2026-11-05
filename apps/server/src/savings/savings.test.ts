import { addInterval } from "@muny/core";
import type {
  Account,
  AlternativeSuggestion,
  DiyProject,
  InfraCost,
  RecurringSeries,
  Saving,
  SavingsSummary,
} from "@muny/shared";
import { describe, expect, it } from "vitest";
import { localToday } from "../lib/dates.js";
import { makeSignedInApp, type TestClient } from "../test-utils.js";
import { wholeMonths } from "./service.js";

// Synthetic data only.

const today = localToday();
const monthsAgo = (n: number, day = 5) => {
  const d = addInterval(today, "monthly", -n);
  return `${d.slice(0, 8)}${String(day).padStart(2, "0")}`;
};
const csv = (rows: [string, string, string][]) =>
  ["Date,Description,Amount", ...rows.map((r) => r.join(","))].join("\n");

async function setup(lastMonthsAgo = 3) {
  const ctx = await makeSignedInApp();
  const rows: [string, string, string][] = [];
  for (let i = 8; i >= lastMonthsAgo; i--) rows.push([monthsAgo(i, 5), "NETFLIX.COM", "-15.99"]);
  for (let i = 8; i >= lastMonthsAgo; i--)
    rows.push([monthsAgo(i, 9), "MUSICBOX PREMIUM", "-10.99"]);
  for (let i = 8; i >= lastMonthsAgo; i--)
    rows.push([monthsAgo(i, 12), "GYMCO MEMBERSHIP", "-40.00"]);
  await ctx.client.post("/api/import/commit", {
    filename: "bank.csv",
    content: csv(rows),
    accountMap: { csv: "new" },
  });
  const series = (await ctx.client.get("/api/recurring")).json<RecurringSeries[]>();
  const find = (name: string) => series.find((s) => s.name === name) as RecurringSeries;
  const acc = (await ctx.client.get("/api/accounts")).json<Account[]>()[0] as Account;
  const more = (rows: [string, string, string][]) =>
    ctx.client.post("/api/import/commit", {
      filename: "more.csv",
      content: csv(rows),
      accountMap: { csv: acc.id },
    });
  return { ...ctx, find, more };
}

const savings = async (c: TestClient) => (await c.get("/api/savings")).json<Saving[]>();

describe("savings", () => {
  it("counts whole months", () => {
    expect(wholeMonths("2026-01-15", "2026-03-14")).toBe(1);
    expect(wholeMonths("2026-01-15", "2026-03-15")).toBe(2);
    expect(wholeMonths("2026-03-15", "2026-01-01")).toBe(0);
  });

  it("suggests self-hosted alternatives for real subscriptions", async () => {
    const { client } = await setup(1);
    const s = (await client.get("/api/savings/alternatives")).json<AlternativeSuggestion[]>();
    expect(s.map((x) => x.seriesName)).toEqual(["Netflix"]);
    expect(s[0]?.alternatives.map((a) => a.name)).toContain("Jellyfin");
  });

  it("verifies a cancellation once the charge stops, and flags one that didn't stop", async () => {
    const { client, find, more } = await setup();
    const nf = find("Netflix");
    const gym = find("Gymco Membership");
    // Both cancelled right after the last charge, about 3 months ago.
    for (const s of [nf, gym])
      await client.post("/api/savings", {
        kind: "cancelled",
        seriesId: s.id,
        effectiveDate: monthsAgo(3, 20),
      });
    // The gym kept charging.
    await more([[monthsAgo(2, 12), "GYMCO MEMBERSHIP", "-40.00"]]);
    await client.post("/api/savings/verify");

    const list = await savings(client);
    const netflix = list.find((s) => s.seriesId === nf.id) as Saving;
    expect(netflix).toMatchObject({ status: "verified", monthlyCents: 1599, kind: "cancelled" });
    expect(netflix.realizedCents).toBe(wholeMonths(monthsAgo(3, 20), today) * 1599);
    const g = list.find((s) => s.seriesId === gym.id) as Saving;
    expect(g.status).toBe("failed");
    expect(g.statusNote).toContain("Charged $40.00");
    expect(
      (await client.get("/api/recurring")).json<RecurringSeries[]>().find((s) => s.id === nf.id)
        ?.status,
    ).toBe("cancelled");
  });

  it("verifies a downgrade when the new price shows up", async () => {
    const { client, find, more } = await setup();
    const mb = find("Musicbox Premium");
    await client.post("/api/savings", {
      kind: "downgraded",
      seriesId: mb.id,
      afterMonthlyCents: 599,
      effectiveDate: monthsAgo(3, 15),
    });
    expect((await savings(client))[0]?.status).toBe("projected");
    await more([[monthsAgo(2, 9), "MUSICBOX PREMIUM", "-5.99"]]);
    await client.post("/api/savings/verify");
    expect((await savings(client))[0]).toMatchObject({ status: "verified", monthlyCents: 500 });
  });

  it("records a replaced saving when a DIY project cancels the service, net of self-hosting costs", async () => {
    const { client, find } = await setup(1);
    const nf = find("Netflix");
    const p = (
      await client.post("/api/diy", {
        serviceName: "Netflix",
        seriesId: nf.id,
        alternative: "Jellyfin",
        effort: "medium",
        runningMonthlyCents: 100,
      })
    ).json<DiyProject>();
    expect(p).toMatchObject({ status: "idea", serviceMonthlyCents: 1599, savingId: null });
    await client.patch(`/api/diy/${p.id}`, { status: "migrated" });
    const done = (
      await client.patch(`/api/diy/${p.id}`, { status: "cancelled" })
    ).json<DiyProject>();
    expect(done.savingId).toBeTruthy();
    expect((await savings(client))[0]).toMatchObject({
      kind: "replaced",
      name: "Netflix → Jellyfin",
      monthlyCents: 1599,
    });

    const power = (
      await client.post("/api/infra", {
        name: "NAS power",
        kind: "power",
        watts: 30,
        priceDeciCentsPerKwh: 155,
        startDate: monthsAgo(12, 1),
      })
    ).json<InfraCost>();
    expect(power.monthlyCents).toBe(339);
    const nas = (
      await client.post("/api/infra", {
        name: "DS920+",
        kind: "hardware",
        amountCents: 60_000,
        period: "once",
        amortizeMonths: 60,
        startDate: monthsAgo(12, 1),
      })
    ).json<InfraCost>();
    expect(nas.monthlyCents).toBe(1000);
    const sum = (await client.get("/api/savings/summary")).json<SavingsSummary>();
    expect(sum).toMatchObject({
      diyMonthlyCents: 1599,
      infraMonthlyCents: 339 + 1000 + 100,
      diyNetMonthlyCents: 1599 - 1439,
    });
    const bad = await client.post("/api/infra", {
      name: "Oops",
      kind: "power",
      startDate: today,
    });
    expect(bad.statusCode).toBe(400);
  });

  it("supports manual savings without a recurring charge", async () => {
    const { client } = await setup();
    const r = await client.post("/api/savings", {
      kind: "negotiated",
      name: "Car insurance",
      beforeMonthlyCents: 15_000,
      afterMonthlyCents: 12_000,
      effectiveDate: monthsAgo(2, 1),
    });
    expect(r.statusCode).toBe(201);
    const s = r.json<Saving>();
    expect(s).toMatchObject({ status: "projected", monthlyCents: 3000 });
    const v = (await client.patch(`/api/savings/${s.id}`, { status: "verified" })).json<Saving>();
    expect(v.realizedCents).toBe(wholeMonths(monthsAgo(2, 1), today) * 3000);
  });
});

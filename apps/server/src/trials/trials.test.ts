import { addInterval } from "@muny/core";
import type { NotificationList, Trial } from "@muny/shared";
import { describe, expect, it } from "vitest";
import { localToday } from "../lib/dates.js";
import { makeSignedInApp } from "../test-utils.js";

// Synthetic data only.

const today = localToday();
const plusDays = (n: number) => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

describe("free trials", () => {
  it("tracks a trial and reminds before it ends", async () => {
    const { client } = await makeSignedInApp();
    const r = await client.post("/api/trials", {
      name: "StreamBox",
      startDate: plusDays(-5),
      endDate: plusDays(2),
      priceCents: 1499,
      interval: "monthly",
      cancelInfo: "Account > Plan > Cancel",
    });
    expect(r.statusCode).toBe(201);
    const trial = r.json<Trial>();
    expect(trial).toMatchObject({ status: "active", daysLeft: 2 });

    // A trial far out doesn't alert yet.
    await client.post("/api/trials", {
      name: "Later",
      startDate: today,
      endDate: addInterval(today, "monthly"),
    });

    await client.post("/api/alerts/run");
    const n = (await client.get("/api/notifications")).json<NotificationList>();
    const trialAlerts = n.items.filter((i) => i.ruleType === "trial_ending");
    expect(trialAlerts).toHaveLength(1);
    expect(trialAlerts[0]?.body).toContain("$14.99 (monthly)");

    const cancelled = await client.patch(`/api/trials/${trial.id}`, { status: "cancelled" });
    expect(cancelled.json<Trial>().status).toBe("cancelled");
    expect((await client.get("/api/trials")).json<Trial[]>()).toHaveLength(2);
    expect((await client.delete(`/api/trials/${trial.id}`)).statusCode).toBe(200);
  });

  it("rejects a trial that ends before it starts", async () => {
    const { client } = await makeSignedInApp();
    const r = await client.post("/api/trials", {
      name: "Backwards",
      startDate: today,
      endDate: plusDays(-1),
    });
    expect(r.statusCode).toBe(400);
  });
});

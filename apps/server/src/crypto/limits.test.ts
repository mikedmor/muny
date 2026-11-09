import { randomBytes } from "node:crypto";
import { schema } from "@muny/db";
import {
  type ApiLimit,
  type AppNotification,
  type CryptoWallet,
  describeWait,
  limitMessage,
} from "@muny/shared";
import { describe, expect, it } from "vitest";
import { makeSignedInApp } from "../test-utils.js";
import { apiLimits, BudgetError, LIMITS, limitFor, spend } from "./budget.js";

// Synthetic data only.

const day = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

type Db = Awaited<ReturnType<typeof makeSignedInApp>>["db"];
function setUsage(
  db: Db,
  provider: string,
  dayCount: number,
  monthCount: number,
  now = new Date(),
) {
  const value = {
    [provider]: { day: day(now), dayCount, month: day(now).slice(0, 7), monthCount },
  };
  db.insert(schema.appSettings)
    .values({ key: "crypto.usage", value })
    .onConflictDoUpdate({ target: schema.appSettings.key, set: { value } })
    .run();
}

describe("describing a wait", () => {
  it("reads naturally at every size", () => {
    expect(describeWait(20_000)).toBe("under a minute");
    expect(describeWait(5 * 60_000)).toBe("5 minutes");
    expect(describeWait(60 * 60_000)).toBe("1 hour");
    expect(describeWait(192 * 60_000)).toBe("3 hours 12 minutes");
    expect(describeWait(50 * 3_600_000)).toBe("3 days");
  });
});

describe("a service out of requests", () => {
  const noon = new Date(2026, 10, 9, 12, 0, 0);

  it("says exactly how long until a daily limit resets", async () => {
    const { db } = await makeSignedInApp();
    setUsage(db, "carapi", LIMITS.carapi.day, 0, noon);
    const hit = limitFor(db, "carapi", noon) as ApiLimit;
    expect(hit).toMatchObject({ period: "day", resetsAt: new Date(2026, 10, 10).getTime() });
    expect(() => spend(db, "carapi", noon)).toThrow(BudgetError);
    expect(() => spend(db, "carapi", noon)).toThrow(
      /daily limit of 20 requests. It resets in 12 hours/,
    );
  });

  it("waits for the month when both are used up, and clears when the period turns", async () => {
    const { db } = await makeSignedInApp();
    setUsage(db, "carapi", LIMITS.carapi.day, LIMITS.carapi.month, noon);
    expect(limitFor(db, "carapi", noon)).toMatchObject({
      period: "month",
      resetsAt: new Date(2026, 11, 1).getTime(),
    });
    expect(limitFor(db, "carapi", new Date(2026, 11, 1, 0, 0, 1))).toBeNull();
    expect(limitFor(db, "defillama", noon)).toBeNull();
  });

  it("alerts once per period, and sends people to the API settings", async () => {
    const { db, client } = await makeSignedInApp();
    setUsage(db, "carapi", LIMITS.carapi.day, 0);
    await client.post("/api/alerts/run");
    await client.post("/api/alerts/run");
    const all = (await client.get("/api/notifications")).json<{ items: AppNotification[] }>().items;
    const hits = all.filter((n) => n.ruleType === "api_limit");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.title).toContain("reached its daily limit");
    expect(hits[0]?.body).toContain("resets in");
    expect(hits[0]?.link).toBe("/settings#api");
  });

  it("refuses a wallet sync up front, skips it in sync all, and lists it", async () => {
    const { db, client } = await makeSignedInApp({
      env: { MUNY_SECRET_KEY: randomBytes(32).toString("base64") },
    });
    const w = (
      await client.post("/api/crypto/wallets", { name: "Hot", kind: "manual" })
    ).json<CryptoWallet>();
    await client.put(`/api/crypto/wallets/${w.id}/source`, {
      chain: "eth",
      source: "0x000000000000000000000000000000000000dEaD",
    });
    setUsage(db, "blockscout", LIMITS.blockscout.day, 0);
    const res = await client.post(`/api/crypto/wallets/${w.id}/sync`);
    expect(res.statusCode).toBe(429);
    expect(res.body).toContain("It resets in");
    const listed = (await client.get("/api/crypto/wallets")).json<CryptoWallet[]>();
    expect(listed[0]?.limit).toMatchObject({ provider: "blockscout", period: "day" });
    const limits = (await client.get("/api/limits")).json<ApiLimit[]>();
    expect(limits.map((l) => l.provider)).toEqual(["blockscout"]);
    expect(apiLimits(db).length).toBe(1);
    expect(limitMessage(limits[0] as ApiLimit)).toContain("Blockscout");

    // Sync all leaves it waiting, rather than recording a failure that goes stale.
    await client.post("/api/crypto/sync");
    await new Promise((r) => setTimeout(r, 50));
    const after = (await client.get("/api/crypto/wallets")).json<CryptoWallet[]>();
    expect(after[0]).toMatchObject({ status: "never", lastError: null });
  });

  it("refuses a price update up front", async () => {
    const { db, client } = await makeSignedInApp();
    await client.put("/api/crypto/settings", { pricesEnabled: true });
    setUsage(db, "defillama", LIMITS.defillama.day, 0);
    const res = await client.post("/api/crypto/prices/refresh");
    expect(res.statusCode).toBe(429);
    expect(res.body).toContain("It resets in");
  });
});

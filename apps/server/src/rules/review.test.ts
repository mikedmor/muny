import type { Account, RecurringSeries, RuleReview } from "@muny/shared";
import { describe, expect, it } from "vitest";
import { listSeries, rescanRecurring } from "../recurring/service.js";
import { makeSignedInApp } from "../test-utils.js";

// Synthetic data only.
const TODAY = "2026-11-08";

describe("reviewing rules", () => {
  it("offers to combine your rule with Muny's for the same series, and does it", async () => {
    const { db, client } = await makeSignedInApp();
    const acct = (
      await client.post("/api/accounts", { name: "Main", type: "checking", balanceCents: 0 })
    ).json<Account>();
    for (const m of ["06", "07", "08", "09", "10"])
      await client.post("/api/transactions", {
        accountId: acct.id,
        postedDate: `2026-${m}-12`,
        amountCents: -999,
        description: "SAMPLE STREAM 0101",
      });
    db.transaction((tx) => rescanRecurring(tx, TODAY));
    const [series] = listSeries(db, TODAY) as RecurringSeries[];
    await client.patch(`/api/recurring/${series?.id}`, { status: "confirmed" });
    db.transaction((tx) => rescanRecurring(tx, TODAY));
    const cats = (await client.get("/api/categories")).json<
      { categories: { id: string; name: string }[] }[]
    >();
    const cat = cats.flatMap((g) => g.categories)[0];
    const mine = (
      await client.post("/api/rules", {
        name: "Streaming",
        match: "all",
        conditions: [{ field: "description", op: "contains", value: "SAMPLE STREAM" }],
        actions: [{ type: "setCategory", categoryId: cat?.id }],
      })
    ).json<{ id: string }>();

    const review = (await client.get("/api/rules/review")).json<RuleReview>();
    expect(review.automaticIds).toHaveLength(1);
    expect(review.counts[mine.id]).toBe(5);
    expect(review.combine).toHaveLength(1);
    expect(review.combine[0]).toMatchObject({ removeId: review.automaticIds[0], sharedCount: 5 });

    const res = await client.post("/api/rules/combine", { all: true });
    expect(res.json()).toEqual({ combined: 1 });
    const rules = (await client.get("/api/rules")).json<
      { id: string; actions: { type: string; seriesId?: string }[] }[]
    >();
    expect(rules).toHaveLength(1);
    expect(rules[0]?.actions).toContainEqual({ type: "setRecurring", seriesId: series?.id });
    // Its charges stay in the series, and no automatic rule comes back.
    db.transaction((tx) => rescanRecurring(tx, TODAY));
    expect((await client.get("/api/rules")).json<unknown[]>()).toHaveLength(1);
    expect(listSeries(db, TODAY)[0]?.lastDate).toBe("2026-10-12");
  });
});

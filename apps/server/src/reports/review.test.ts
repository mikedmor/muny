import type { YearReview } from "@muny/shared";
import { describe, expect, it } from "vitest";
import { maybeSeedDemo } from "../demo/seed.js";
import { makeSignedInApp } from "../test-utils.js";
import { yearInReview } from "./review.js";

// The made-up demo household: six months of data up to the 14th of November.

const TODAY = "2026-11-14";

describe("year in review", () => {
  it("tells the year so far from the same numbers as the reports", async () => {
    const { db, client } = await makeSignedInApp();
    expect(maybeSeedDemo(db, true, TODAY)).toBe(true);
    const r = yearInReview(db, 2026, TODAY);
    expect(r).toMatchObject({
      year: 2026,
      from: "2026-01-01",
      to: TODAY,
      partial: true,
      lastYear: null,
    });
    // The demo starts in May: no empty months before it.
    expect(r.months.map((m) => m.month)[0]).toBe("2026-05");
    expect(r.months).toHaveLength(7);
    // Bills seen from the start of the history aren't "new", and the big ones are one-offs.
    expect(r.recurring.started).toEqual([]);
    expect(r.biggest.every((b) => b.category !== "Rent & Mortgage")).toBe(true);
    expect(r.earnedCents).toBe(r.months.reduce((s, m) => s + m.earnedCents, 0));
    expect(r.keptCents).toBe(r.earnedCents - r.spentCents);
    expect(r.earnedCents).toBeGreaterThan(0);
    // Rent is the biggest category; the grocery store and the noodle bar are the regulars.
    expect(r.categories[0]?.name).toBe("Rent & Mortgage");
    expect(["Greenleaf Market", "Noodle Bar"]).toContain(r.regular?.name);
    expect(r.regular?.count).toBe(26);
    expect(r.biggest[0]?.cents).toBeGreaterThanOrEqual(r.biggest.at(-1)?.cents ?? 0);
    // Streamflix went up three months ago.
    expect(r.recurring.priceIncreases.map((p) => p.name.toLowerCase())).toContain("streamflix");
    expect(r.recurring.paidCents).toBeGreaterThan(0);
    // Only months fully covered count for lightest and heaviest.
    expect(r.lightestMonth && r.lightestMonth.month >= "2026-06").toBe(true);
    expect(r.facts.transactions).toBeGreaterThan(100);
    expect(r.facts.busiestWeekday).not.toBeNull();
    expect(r.netWorth.points.length).toBeGreaterThan(3);
    // The demo's brokerage counts as investing.
    expect(r.investing?.dividendsCents).toBeGreaterThan(0);

    const res = await client.get("/api/review/2026");
    expect(res.statusCode).toBe(200);
    expect(res.json<YearReview>().year).toBe(2026);
    expect((await client.get("/api/review/abc")).statusCode).toBe(400);
  });
});

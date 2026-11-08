import { addInterval } from "@muny/core";
import type { Account, CategoryGroup, SavingsOpportunities } from "@muny/shared";
import { describe, expect, it } from "vitest";
import { localToday } from "../lib/dates.js";
import { makeSignedInApp } from "../test-utils.js";

// Synthetic data only.

async function setup() {
  const ctx = await makeSignedInApp();
  const { client } = ctx;
  const groups = (await client.get("/api/categories")).json<CategoryGroup[]>();
  const cat = (name: string) =>
    groups.flatMap((g) => g.categories).find((c) => c.name === name)?.id as string;
  const account = async (name: string, type: string, balanceCents = 0) =>
    (await client.post("/api/accounts", { name, type, balanceCents })).json<Account>();
  const add = (
    accountId: string,
    postedDate: string,
    amountCents: number,
    description: string,
    category?: string,
  ) =>
    client.post("/api/transactions", {
      accountId,
      postedDate,
      amountCents,
      description,
      categoryId: category ? cat(category) : null,
    });
  const get = async () =>
    (await client.get("/api/savings/opportunities")).json<SavingsOpportunities>();
  return { ...ctx, cat, account, add, get };
}

const today = localToday();
/** The same day of the month, n months ago. */
const monthsAgo = (n: number, day = "03") =>
  `${addInterval(today, "monthly", -n).slice(0, 8)}${day}`;

describe("savings opportunities", () => {
  it("finds overlaps, price rises, replacements, card interest and idle cash", async () => {
    const { client, account, add, get } = await setup();
    const checking = await account("Everyday", "checking", 1_200_000);
    for (let i = 6; i >= 1; i--) {
      await add(checking.id, monthsAgo(i, "03"), -1599, "STREAMCO", "Streaming");
      await add(checking.id, monthsAgo(i, "05"), -999, "FLIXBOX", "Streaming");
      await add(checking.id, monthsAgo(i, "08"), -1199, "DROPBOX PLUS", "Cloud & Hosting");
      // 9.99 for three months, then 11.99 (three alike makes it a fixed price).
      await add(
        checking.id,
        monthsAgo(i, "11"),
        i > 3 ? -999 : -1199,
        "TUNESPOT",
        "Software & Apps",
      );
    }
    const card = await account("Sample Visa", "credit");
    await add(card.id, `${today.slice(0, 7)}-01`, -2500, "INTEREST CHARGE ON PURCHASES");
    const savings = await account("Rainy Day", "savings", 500_000);
    await client.put(`/api/savings/accounts/${savings.id}/apy`, { apyBps: 400 });
    await client.post("/api/recurring/rescan", {});

    const o = await get();
    const kinds = o.items.map((x) => x.kind);
    expect(kinds).toEqual(
      expect.arrayContaining(["overlap", "price_increase", "diy", "card_interest", "idle_cash"]),
    );
    // Biggest first, and the total adds them up.
    expect(o.items.map((x) => x.yearlyCents)).toEqual(
      [...o.items.map((x) => x.yearlyCents)].sort((a, b) => b - a),
    );
    expect(o.totalYearlyCents).toBe(o.items.reduce((s, x) => s + x.yearlyCents, 0));
    for (const x of o.items) expect(Number.isInteger(x.yearlyCents)).toBe(true);

    const overlap = o.items.find((x) => x.kind === "overlap");
    // Dropping the cheaper of the two.
    expect(overlap?.yearlyCents).toBe(999 * 12);
    expect(overlap?.evidence.map((e) => e.label)).toEqual(["Streamco", "Flixbox"]);
    expect(o.items.find((x) => x.kind === "price_increase")?.yearlyCents).toBe(200 * 12);
    expect(o.items.find((x) => x.kind === "diy")?.yearlyCents).toBe(1199 * 12);
    const month = Number(today.slice(5, 7));
    expect(o.items.find((x) => x.kind === "card_interest")?.yearlyCents).toBe(
      Math.round((2500 * 12) / month),
    );
    const idle = o.items.find((x) => x.kind === "idle_cash");
    expect(idle?.confidence).toBe("guess");
    expect(idle?.title).toContain("Rainy Day");

    // Hide one: it moves to dismissed, and back again.
    const id = overlap?.id as string;
    await client.post("/api/savings/opportunities/dismiss", { id, dismissed: true });
    const hidden = await get();
    expect(hidden.items.map((x) => x.id)).not.toContain(id);
    expect(hidden.dismissed.map((x) => x.id)).toContain(id);
    expect(hidden.totalYearlyCents).toBe(o.totalYearlyCents - (overlap?.yearlyCents ?? 0));
    await client.post("/api/savings/opportunities/dismiss", { id, dismissed: false });
    expect((await get()).items.map((x) => x.id)).toContain(id);
  });

  it("suggests rolling paid-off loan payments into the next loan", async () => {
    const { client, get } = await setup();
    const loan = (
      name: string,
      startBalanceCents: number,
      aprBps: number,
      monthlyPaymentCents: number,
    ) =>
      client.post("/api/loans", {
        name,
        kind: "personal",
        startBalanceCents,
        startDate: today,
        aprBps,
        monthlyPaymentCents,
      });
    await loan("Small Loan", 200_000, 500, 20_000);
    await loan("Big Loan", 2_000_000, 1500, 30_000);
    const debt = (await get()).items.find((x) => x.kind === "debt_order");
    expect(debt?.yearlyCents).toBeGreaterThan(0);
    expect(debt?.detail).toContain("sooner");
  });

  it("has nothing to say about an empty household", async () => {
    const { get } = await setup();
    expect(await get()).toMatchObject({ items: [], dismissed: [], totalYearlyCents: 0 });
  });
});

import { describe, expect, it } from "vitest";
import { findCombinable, type ReviewRule } from "./review.js";

// Synthetic data only.
const f = (description: string, payee: string, amountCents: number, accountId = "a1") => ({
  description,
  payee,
  amountCents,
  accountId,
});
const rule = (id: string, name: string, def: Omit<ReviewRule, "id" | "name" | "enabled">) => ({
  id,
  name,
  enabled: true,
  ...def,
});

describe("rules that can be combined", () => {
  const facts = [
    f("SAMPLE STREAM 0101", "Samplestream", -999),
    f("SAMPLE STREAM 0201", "Samplestream", -999),
    f("SAMPLE GYM", "Sample Gym", -2500),
  ];
  const yours = rule("r1", "Samplestream", {
    match: "all",
    conditions: [{ field: "payee", op: "contains", value: "Samplestream" }],
    actions: [{ type: "setCategory", categoryId: "streaming" }],
  });
  const auto = rule("r2", "Samplestream (recurring)", {
    match: "all",
    conditions: [
      { field: "description", op: "contains", value: "SAMPLE STREAM" },
      { field: "direction", value: "out" },
    ],
    actions: [{ type: "setRecurring", seriesId: "s1" }],
  });

  it("keeps your rule, with the bank-description conditions and both actions", () => {
    const [c, ...rest] = findCombinable([yours, auto], facts);
    expect(rest).toHaveLength(0);
    expect(c).toMatchObject({ keepId: "r1", removeId: "r2", conditionsFrom: "r2", sharedCount: 2 });
    expect(c?.actions).toEqual([
      { type: "setCategory", categoryId: "streaming" },
      { type: "setRecurring", seriesId: "s1" },
    ]);
  });

  it("leaves rules alone when combining would file something differently", () => {
    // The category rule also files a charge the recurring rule doesn't hold.
    const wider = {
      ...yours,
      conditions: [{ field: "payee" as const, op: "contains" as const, value: "Sample" }],
    };
    const found = findCombinable([wider, auto], facts);
    // Only valid as: keep the wider conditions? No, that would put the gym in the series.
    expect(found).toEqual([]);
  });

  it("doesn't combine rules that set the same thing two ways", () => {
    const other = { ...auto, actions: [{ type: "setCategory" as const, categoryId: "fun" }] };
    expect(findCombinable([yours, other], facts)).toEqual([]);
  });

  it("folds an exact copy in too, one pair per rule removed", () => {
    const copy = { ...yours, id: "r3" };
    const found = findCombinable([auto, yours, copy], facts);
    expect(found.map((c) => [c.keepId, c.removeId])).toEqual([
      ["r1", "r2"],
      ["r1", "r3"],
    ]);
  });
});

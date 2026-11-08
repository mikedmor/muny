import { describe, expect, it } from "vitest";
import { applyRules, seriesPicker } from "./engine.js";
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

describe("a paycheck split across accounts", () => {
  const series = [
    { id: "pay", accountId: "main", amountCents: 170_925 },
    { id: "extra", accountId: "side", amountCents: 5_000 },
    { id: "other", accountId: "third", amountCents: 5_000 },
  ];
  const pick = seriesPicker(series);
  const deposit = (accountId: string, amountCents: number) => ({
    description: "ACME CORP PAYROLL PPD",
    payee: "Acme Corp",
    amountCents,
    accountId,
  });
  const blank = { categoryId: null, payeeName: null, tags: [], hidden: false, seriesId: null };
  const one = rule("all", "Acme Corp", {
    match: "all",
    conditions: [{ field: "payee", op: "contains", value: "Acme" }],
    actions: [
      { type: "setCategory", categoryId: "paycheck" },
      { type: "setRecurring", seriesId: "pay" },
      { type: "setRecurring", seriesId: "extra" },
    ],
  });

  it("puts each deposit in the series on its own account", () => {
    const on = (f: ReturnType<typeof deposit>) => applyRules([one], f, blank, pick).next.seriesId;
    expect(on(deposit("main", 170_925))).toBe("pay");
    expect(on(deposit("side", 5_000))).toBe("extra");
    // Same amount, but neither series is on that account.
    expect(on(deposit("third", 5_000))).toBeNull();
  });

  it("lets one rule per employer take over the per-account rules", () => {
    const yours = { ...one, actions: [{ type: "setCategory" as const, categoryId: "paycheck" }] };
    const per = (id: string, acct: string) =>
      rule(`r-${id}`, `Acme ${id} (recurring)`, {
        match: "all",
        conditions: [
          { field: "description", op: "contains", value: "ACME CORP PAYROLL" },
          { field: "account", value: acct },
        ],
        actions: [{ type: "setRecurring", seriesId: id }],
      });
    const facts = [
      deposit("main", 170_925),
      deposit("main", 170_925),
      deposit("side", 5_000),
      deposit("side", 5_000),
      deposit("third", 5_000),
      deposit("third", 5_000),
      // A one-off bonus: in the paycheck series now, out of it once combined.
      deposit("main", 414_031),
    ];
    let leaves = 0;
    let rules: ReviewRule[] = [
      yours,
      per("pay", "main"),
      per("extra", "side"),
      per("other", "third"),
    ];
    for (let n = 0; n < 5; n++) {
      const c = findCombinable(rules, facts, series)[0];
      if (!c) break;
      leaves += c.leaves;
      const src = rules.find((r) => r.id === c.conditionsFrom) as ReviewRule;
      rules = rules
        .filter((r) => r.id !== c.removeId)
        .map((r) =>
          r.id === c.keepId
            ? { ...r, match: src.match, conditions: src.conditions, actions: c.actions }
            : r,
        );
    }
    expect(rules).toHaveLength(1);
    expect(rules[0]?.actions.filter((a) => a.type === "setRecurring")).toHaveLength(3);
    expect(leaves).toBe(1);
  });
});

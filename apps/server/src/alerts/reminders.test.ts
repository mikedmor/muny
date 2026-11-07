import { describe, expect, it } from "vitest";
import { reminderDays, reminderTier } from "./evaluate.js";

describe("bill and trial reminders", () => {
  it("uses the old single setting until a list is saved", () => {
    expect(reminderDays({})).toEqual([3]);
    expect(reminderDays({ daysBefore: 5 })).toEqual([5]);
    expect(reminderDays({ daysBefore: 5, reminderDays: [1, 7, 7] })).toEqual([7, 1]);
  });

  it("reminds once per reminder day, keeping the old key for the first", () => {
    const days = [7, 1];
    expect(reminderTier(days, 9)).toBeNull();
    expect(reminderTier(days, 7)).toEqual({ suffix: "" });
    expect(reminderTier(days, 4)).toEqual({ suffix: "" });
    expect(reminderTier(days, 1)).toEqual({ suffix: ":1d" });
    expect(reminderTier(days, 0)).toEqual({ suffix: ":1d" });
    expect(reminderTier([7, 3, 0], 0)).toEqual({ suffix: ":0d" });
  });
});

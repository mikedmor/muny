import { describe, expect, it } from "vitest";
import { makeSignedInApp } from "../test-utils.js";

interface Listed {
  id: string;
  title: string;
  page: string;
  open: string;
  onOverview: boolean;
  refresh: number;
}

describe("home-screen widgets for the Android app", () => {
  it("lists the Overview cards first, each with a page to draw and a page to open", async () => {
    const { client } = await makeSignedInApp();
    const res = await client.get("/api/app-widgets");
    expect(res.statusCode).toBe(200);
    const { widgets } = res.json<{ widgets: Listed[] }>();
    expect(widgets.length).toBeGreaterThan(5);
    const spending = widgets.find((w) => w.id === "spending");
    expect(spending).toMatchObject({
      title: "Spent this month",
      page: "/app-widget/spending",
      open: "/spending",
      refresh: 30,
    });
    // Cards on the Overview come before the rest.
    const firstOff = widgets.findIndex((w) => !w.onOverview);
    if (firstOff >= 0) expect(widgets.slice(firstOff).every((w) => !w.onOverview)).toBe(true);
    // The AI card is interactive, so it's never a widget.
    expect(widgets.some((w) => w.id === "muny-ai")).toBe(false);
  });

  it("needs a signed-in person", async () => {
    const { app } = await makeSignedInApp();
    expect((await app.inject({ method: "GET", url: "/api/app-widgets" })).statusCode).toBe(401);
  });
});

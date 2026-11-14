import { newId, schema } from "@muny/db";
import { type CreatedApiToken, haYaml } from "@muny/shared";
import { describe, expect, it } from "vitest";
import { makeSignedInApp } from "../test-utils.js";

// Synthetic only: a made-up checking account.

async function setup() {
  const ctx = await makeSignedInApp();
  ctx.db
    .insert(schema.accounts)
    .values({
      id: newId(),
      name: "Everyday Checking",
      type: "checking",
      openingBalanceCents: 123_456,
    })
    .run();
  const token = async (scopes: string[]) =>
    (
      await ctx.client.post("/api/agents/tokens", {
        name: "Home Assistant",
        scopes,
        expiresInDays: null,
      })
    ).json<CreatedApiToken>().token;
  const get = (t?: string) =>
    ctx.app.inject({
      method: "GET",
      url: "/api/v1/home-assistant",
      headers: t ? { authorization: `Bearer ${t}` } : {},
    });
  return { ...ctx, token, get };
}

describe("Home Assistant sensors", () => {
  it("answers with what the token may read, as decimal money", async () => {
    const { token, get } = await setup();
    expect((await get()).statusCode).toBe(401);
    expect((await get(await token(["read:transactions"]))).statusCode).toBe(403);

    const summary = (await get(await token(["read:summary"]))).json<Record<string, unknown>>();
    expect(summary).toMatchObject({
      currency: "USD",
      spent_this_month: "0.00",
      bills_due_7_days: "0.00",
    });
    expect(summary).not.toHaveProperty("net_worth");

    const all = (await get(await token(["read:summary", "read:accounts"]))).json<
      Record<string, unknown>
    >();
    expect(all).toMatchObject({ cash: "1234.56", forecast_account: "Everyday Checking" });
    expect(all.accounts).toEqual([
      { name: "Everyday Checking", type: "checking", balance: "1234.56" },
    ]);
  });

  it("writes the configuration.yaml for the permissions chosen", () => {
    const summaryOnly = haYaml({ url: "https://muny.example.test/", scopes: ["read:summary"] });
    expect(summaryOnly).toContain("resource: https://muny.example.test/api/v1/home-assistant");
    expect(summaryOnly).toContain("Authorization: !secret muny_token");
    expect(summaryOnly).toContain('value_template: "{{ value_json.spent_this_month }}"');
    expect(summaryOnly).toContain("device_class: monetary");
    expect(summaryOnly).not.toContain("net_worth");
    expect(summaryOnly).not.toContain("binary_sensor");
    const both = haYaml({
      url: "https://muny.example.test",
      scopes: ["read:summary", "read:accounts"],
    });
    expect(both).toContain("unique_id: muny_net_worth");
    expect(both).toContain("binary_sensor:");
  });
});

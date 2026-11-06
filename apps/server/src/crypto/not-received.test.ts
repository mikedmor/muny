import { describe, expect, it } from "vitest";
import { makeSignedInApp } from "../test-utils.js";

describe("1099-DA not received", () => {
  it("marks an exchange per year and undoes it", async () => {
    const { client } = await makeSignedInApp();
    const get = async (y: number) =>
      (await client.get(`/api/crypto/tax/${y}/not-received`)).json<string[]>();
    expect(await get(2025)).toEqual([]);
    await client.put("/api/crypto/tax/2025/not-received/w1", { notReceived: true });
    await client.put("/api/crypto/tax/2025/not-received/w2", { notReceived: true });
    expect((await get(2025)).sort()).toEqual(["w1", "w2"]);
    expect(await get(2024)).toEqual([]);
    await client.put("/api/crypto/tax/2025/not-received/w1", { notReceived: false });
    expect(await get(2025)).toEqual(["w2"]);
  });
});

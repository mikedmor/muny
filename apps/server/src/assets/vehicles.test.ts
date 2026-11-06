import { beforeEach, describe, expect, it } from "vitest";
import { makeSignedInApp } from "../test-utils.js";
import { resetVehicleCache } from "./vehicles.js";

// A fake NHTSA vPIC; no network.

describe("vehicle make and model suggestions", () => {
  beforeEach(() => resetVehicleCache());

  it("lists makes once (cached) and models for a make and year", async () => {
    const calls: string[] = [];
    const f = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("GetMakesForVehicleType"))
        return new Response(
          JSON.stringify({ Results: [{ MakeName: "HONDA" }, { MakeName: "BMW" }] }),
        );
      if (url.includes("GetModelsForMakeYear/make/Honda/modelyear/2020"))
        return new Response(
          JSON.stringify({
            Results: [{ Model_Name: "Civic" }, { Model_Name: "Accord" }, { Model_Name: "Civic" }],
          }),
        );
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    const { client } = await makeSignedInApp({ priceFetch: f });
    expect((await client.get("/api/assets/vehicle-makes")).json()).toEqual(["BMW", "Honda"]);
    await client.get("/api/assets/vehicle-makes");
    expect(calls.filter((u) => u.includes("GetMakesForVehicleType"))).toHaveLength(4); // one per type, once
    expect((await client.get("/api/assets/vehicle-models?make=Honda&year=2020")).json()).toEqual([
      "Accord",
      "Civic",
    ]);
  });
});

import { schema } from "@muny/db";
import type { Asset, AssetValuationSettings } from "@muny/shared";
import { describe, expect, it } from "vitest";
import { makeSignedInApp } from "../test-utils.js";

// Fakes only; no network. Synthetic address and car.

function fakes() {
  const calls: { url: string; body?: string; key?: string }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      body: init?.body ? String(init.body) : undefined,
      key: headers["x-api-key"],
    });
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });
    if (url === "https://api.apillow.co/v1/properties") {
      if (headers["x-api-key"] !== "apillow-key-123") return json(401, {});
      return json(200, { job_id: "job-1", status: "processing" });
    }
    if (url.startsWith("https://api.apillow.co/v1/results/job-1"))
      return json(200, {
        status: "complete",
        results: [
          {
            success: true,
            property: {
              zpid: 12345,
              zestimate: 381_500,
              rent_zestimate: 2400,
              bedrooms: 4,
              bathrooms: 2.5,
              living_area: 2100,
              year_built: 2019,
              property_type: "SINGLE_FAMILY",
              last_sold_price: 350_000,
              last_sold_date: "2024-06-01",
              annual_tax: 5200.5,
              home_status: "OFF_MARKET",
            },
          },
        ],
      });
    if (url.startsWith("https://api.carapi.dev/v1/vehicle-valuation")) {
      const u = new URL(url);
      if (u.searchParams.get("token") !== "carapi-key-123") return json(403, {});
      return json(200, {
        make: "honda",
        model: "civic",
        year: 2020,
        valuationPrice: 18_250,
        currency: "USD",
      });
    }
    return json(404, {});
  }) as typeof fetch;
  return { f, calls };
}

describe("automatic asset values", () => {
  it("looks a home up by address and a car by year, make and model", async () => {
    const x = fakes();
    const { client, db } = await makeSignedInApp({
      priceFetch: x.f,
      env: { MUNY_SECRET_KEY: Buffer.alloc(32, 7).toString("base64") },
    });
    const home = (
      await client.post("/api/assets", {
        name: "Home",
        kind: "home",
        valueCents: 35_000_000,
        address: "1 Example St, Springfield, IL 62701",
      })
    ).json<{ accountId: string }>();
    // No key yet: a clear message, nothing sent.
    const noKey = await client.post(`/api/assets/${home.accountId}/lookup`);
    expect(noKey.statusCode).toBe(400);
    expect(x.calls).toHaveLength(0);

    await client.put("/api/assets/valuation/apillow", { key: "apillow-key-123" });
    await client.put("/api/assets/valuation/carapi", { key: "carapi-key-123" });
    const settings = (await client.get("/api/assets/valuation")).json<AssetValuationSettings>();
    expect(settings).toMatchObject({ apillow: true, carapi: true });
    expect(settings.usage.map((u) => u.provider)).toEqual([
      "apillow",
      "apillowreq",
      "carapi",
      "nhtsa",
    ]);
    // Stored encrypted.
    const stored = JSON.stringify(db.select().from(schema.appSettings).all());
    expect(stored).not.toContain("apillow-key-123");

    const r = await client.post(`/api/assets/${home.accountId}/lookup`);
    expect(r.json()).toMatchObject({ valueCents: 38_150_000, source: "apillow" });
    expect(x.calls[0]?.body).toBe(
      JSON.stringify({ addresses: ["1 Example St, Springfield, IL 62701"] }),
    );
    // The same home again today: more requests, still one home.
    await client.post(`/api/assets/${home.accountId}/lookup`);
    const used = (await client.get("/api/assets/valuation")).json<AssetValuationSettings>().usage;
    expect(used.find((u) => u.provider === "apillow")?.today).toBe(1);
    expect(used.find((u) => u.provider === "apillowreq")?.today).toBeGreaterThanOrEqual(2);

    const car = (
      await client.post("/api/assets", {
        name: "Car",
        kind: "vehicle",
        valueCents: 1_500_000,
        vehicleYear: 2020,
        vehicleMake: "Honda",
        vehicleModel: "Civic",
        mileage: 30_000,
      })
    ).json<{ accountId: string }>();
    await client.post(`/api/assets/${car.accountId}/lookup`);
    const carCall = new URL(x.calls.at(-1)?.url ?? "");
    expect(carCall.searchParams.get("mileage")).toBe("48280"); // miles → km
    expect(carCall.searchParams.get("country")).toBe("US");

    const list = (await client.get("/api/assets")).json<Asset[]>();
    const h = list.find((a) => a.name === "Home");
    expect(h).toMatchObject({ valueCents: 38_150_000, valueSource: "apillow" });
    expect(h?.details).toMatchObject({
      bedrooms: 4,
      bathrooms: 2.5,
      livingArea: 2100,
      lastSoldPriceCents: 35_000_000,
      annualTaxCents: 520_050,
    });
    expect(list.find((a) => a.name === "Car")).toMatchObject({
      valueCents: 1_825_000,
      valueSource: "carapi",
      vehicle: { year: 2020, make: "Honda", model: "Civic", mileage: 30_000 },
    });

    // Typing a value in takes over from the lookup.
    await client.patch(`/api/assets/${car.accountId}`, { valueCents: 1_700_000 });
    const after = (await client.get("/api/assets")).json<Asset[]>();
    expect(after.find((a) => a.name === "Car")?.valueSource).toBe("manual");
  });

  it("asks for what a vehicle lookup needs", async () => {
    const x = fakes();
    const { client } = await makeSignedInApp({
      priceFetch: x.f,
      env: { MUNY_SECRET_KEY: Buffer.alloc(32, 7).toString("base64") },
    });
    await client.put("/api/assets/valuation/carapi", { key: "carapi-key-123" });
    const car = (
      await client.post("/api/assets", { name: "Car", kind: "vehicle", valueCents: 100 })
    ).json<{ accountId: string }>();
    const r = await client.post(`/api/assets/${car.accountId}/lookup`);
    expect(r.statusCode).toBe(400);
    expect(r.json<{ error: string }>().error).toMatch(/year, make and model/);
  });
});

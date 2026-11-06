import { type MunyDb, schema } from "@muny/db";
import type { AssetDetails, AssetValuationSettings } from "@muny/shared";
import { eq } from "drizzle-orm";
import { spend, usage } from "../crypto/budget.js";
import { decryptJson, encryptJson } from "../lib/crypto.js";
import { localToday } from "../lib/dates.js";

/**
 * Automatic asset values (D-043), opt-in with your own keys:
 * - Homes: APillow (Zillow data). The address is sent; the Zestimate becomes
 *   the value, plus details (beds, baths, square feet, last sale, taxes).
 *   Asynchronous: submit, then poll for the result. Each property returned
 *   counts toward the plan (free: 50 a month, 5 requests a minute).
 * - Vehicles: CarAPI.dev vehicle valuation by year, make, model and mileage
 *   (US, USD). Free: 100 requests a month.
 * Keys are stored encrypted with MUNY_SECRET_KEY and sent only to their
 * service. A lookup runs when you ask, or at most monthly when Assets is
 * opened.
 */

export interface ValuationDeps {
  fetch?: typeof fetch;
  secretKey?: Buffer;
  /** Pause between result polls (tests use 0). */
  pollMs?: number;
}

const KEYS = "assets.valuationKeys";
const APILLOW = "https://api.apillow.co";
const CARAPI = "https://api.carapi.dev/v1";
export const STALE_MS = 30 * 86_400_000;

type Keys = { apillow?: string; carapi?: string };

function readKeys(db: MunyDb, secret: Buffer | undefined): Keys {
  const enc = db
    .select({ value: schema.appSettings.value })
    .from(schema.appSettings)
    .where(eq(schema.appSettings.key, KEYS))
    .get()?.value as string | undefined;
  if (!enc || !secret) return {};
  try {
    return decryptJson<Keys>(secret, enc);
  } catch {
    return {};
  }
}

/** The services Assets uses, for its request counts. */
const ASSET_SERVICES = new Set(["apillow", "apillowpoll", "carapi", "nhtsa"]);

export function valuationSettings(db: MunyDb, secret: Buffer | undefined): AssetValuationSettings {
  const k = readKeys(db, secret);
  return {
    apillow: !!k.apillow,
    carapi: !!k.carapi,
    usage: usage(db).filter((u) => ASSET_SERVICES.has(u.provider)),
  };
}

/** Set or remove (null) a service's key. */
export function setValuationKey(
  db: MunyDb,
  secret: Buffer | undefined,
  service: "apillow" | "carapi",
  key: string | null,
) {
  if (!secret) throw new Error("MUNY_SECRET_KEY isn't set, so keys can't be stored.");
  const k = readKeys(db, secret);
  if (key) k[service] = key;
  else delete k[service];
  const value = encryptJson(secret, k);
  db.insert(schema.appSettings)
    .values({ key: KEYS, value })
    .onConflictDoUpdate({ target: schema.appSettings.key, set: { value } })
    .run();
  return valuationSettings(db, secret);
}

const dollars = (n: unknown) =>
  typeof n === "number" && Number.isFinite(n) ? Math.round(n * 100) : null;
const num = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? n : null);
const str = (s: unknown) => (typeof s === "string" && s ? s.slice(0, 200) : null);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ValuationError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** Look a home up by address: its Zestimate (cents) and details. */
export async function apillowLookup(
  deps: ValuationDeps,
  db: MunyDb,
  key: string,
  address: string,
): Promise<{ valueCents: number | null; details: AssetDetails }> {
  const f = deps.fetch ?? fetch;
  const headers = {
    "x-api-key": key,
    "content-type": "application/json",
    accept: "application/json",
  };
  spend(db, "apillow");
  const res = await f(`${APILLOW}/v1/properties`, {
    method: "POST",
    headers,
    body: JSON.stringify({ addresses: [address] }),
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 401) throw new ValuationError("APillow didn't accept the API key.");
  if (res.status === 429)
    throw new ValuationError("APillow: rate limit or this month's lookups are used up.", 429);
  if (!res.ok) throw new ValuationError(`APillow answered ${res.status}.`, 502);
  const job = (await res.json()) as { job_id?: string; status?: string; results?: unknown[] };
  let body: { status?: string; results?: { property?: Record<string, unknown> }[] } = job as never;
  // Poll until done (the free plan allows 5 requests a minute: one every 15 seconds).
  for (let i = 0; i < 6 && body.status !== "complete" && body.status !== "failed"; i++) {
    if (!job.job_id) break;
    await sleep(deps.pollMs ?? 15_000);
    spend(db, "apillowpoll");
    const r = await f(`${APILLOW}/v1/results/${encodeURIComponent(job.job_id)}`, {
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    if (r.status === 429) await sleep(deps.pollMs ?? 15_000);
    else if (!r.ok) throw new ValuationError(`APillow answered ${r.status}.`, 502);
    else body = (await r.json()) as typeof body;
  }
  if (body.status !== "complete")
    throw new ValuationError(
      body.status === "failed"
        ? "APillow couldn't find that address. Check it matches the one on Zillow."
        : "APillow is still working on it; try again in a minute.",
      body.status === "failed" ? 400 : 504,
    );
  const p = body.results?.find((x) => x.property)?.property;
  if (!p) throw new ValuationError("APillow found no property at that address.");
  const zestimate = dollars(p.zestimate);
  const status = str(p.home_status);
  return {
    valueCents: zestimate,
    details: {
      bedrooms: num(p.bedrooms),
      bathrooms: num(p.bathrooms),
      livingArea: num(p.living_area),
      lotSize: num(p.lot_size),
      yearBuilt: num(p.year_built),
      propertyType: str(p.property_type),
      rentZestimateCents: dollars(p.rent_zestimate),
      lastSoldPriceCents: dollars(p.last_sold_price),
      lastSoldDate: str(p.last_sold_date),
      annualTaxCents: dollars(p.annual_tax),
      taxRatePct: num(p.property_tax_rate),
      zillowUrl:
        num(p.zpid) || str(p.zpid) ? `https://www.zillow.com/homedetails/${p.zpid}_zpid/` : null,
      note:
        zestimate === null
          ? `Zillow has no estimate for this home${status ? ` (${status.toLowerCase().replace(/_/g, " ")})` : ""}.`
          : null,
    },
  };
}

/** A vehicle's market value (cents, US) by year, make, model and miles. */
export async function carapiLookup(
  deps: ValuationDeps,
  db: MunyDb,
  key: string,
  v: { year: number; make: string; model: string; mileage: number | null },
): Promise<number> {
  const q = new URLSearchParams({
    make: v.make.toLowerCase(),
    model: v.model.toLowerCase(),
    year: String(v.year),
    country: "US",
    token: key,
  });
  // CarAPI takes kilometres.
  if (v.mileage) q.set("mileage", String(Math.round(v.mileage * 1.609344)));
  spend(db, "carapi");
  const res = await (deps.fetch ?? fetch)(`${CARAPI}/vehicle-valuation?${q}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 403) throw new ValuationError("CarAPI didn't accept the API key.");
  if (res.status === 404)
    throw new ValuationError(
      "CarAPI has no value for that year, make and model. Check the spelling.",
    );
  if (res.status === 429)
    throw new ValuationError("CarAPI: this month's requests are used up.", 429);
  if (!res.ok) throw new ValuationError(`CarAPI answered ${res.status}.`, 502);
  const body = (await res.json()) as { valuationPrice?: number; currency?: string };
  const cents = dollars(body.valuationPrice);
  if (cents === null || (body.currency && body.currency !== "USD"))
    throw new ValuationError("CarAPI didn't return a US dollar value.");
  return cents;
}

/** Look up an asset's value now and store it (value, snapshot, details). */
export async function refreshAssetValue(
  db: MunyDb,
  deps: ValuationDeps,
  accountId: string,
  now = Date.now(),
): Promise<{ valueCents: number | null; source: "apillow" | "carapi" }> {
  const row = db
    .select()
    .from(schema.assetDetails)
    .where(eq(schema.assetDetails.accountId, accountId))
    .get();
  if (!row) throw new ValuationError("Asset not found", 404);
  const keys = readKeys(db, deps.secretKey);
  let valueCents: number | null = null;
  let source: "apillow" | "carapi";
  let details: AssetDetails | null = null;
  if (row.kind === "home") {
    if (!keys.apillow) throw new ValuationError("Add your APillow key first.");
    if (!row.address) throw new ValuationError("Add the home's address first (Edit).");
    const r = await apillowLookup(deps, db, keys.apillow, row.address);
    valueCents = r.valueCents;
    details = r.details;
    source = "apillow";
  } else if (row.kind === "vehicle") {
    if (!keys.carapi) throw new ValuationError("Add your CarAPI key first.");
    if (!row.vehicleYear || !row.vehicleMake || !row.vehicleModel)
      throw new ValuationError("Add the vehicle's year, make and model first (Edit).");
    valueCents = await carapiLookup(deps, db, keys.carapi, {
      year: row.vehicleYear,
      make: row.vehicleMake,
      model: row.vehicleModel,
      mileage: row.mileage,
    });
    source = "carapi";
  } else throw new ValuationError("Only homes and vehicles can be looked up.");

  db.update(schema.assetDetails)
    .set({
      valueCheckedAt: now,
      ...(details ? { details: details as Record<string, unknown> } : {}),
      ...(valueCents !== null ? { valueSource: source } : {}),
    })
    .where(eq(schema.assetDetails.accountId, accountId))
    .run();
  if (valueCents !== null) {
    const today = localToday(new Date(now));
    db.update(schema.accounts)
      .set({ currentBalanceCents: valueCents, balanceSource: "reported" })
      .where(eq(schema.accounts.id, accountId))
      .run();
    db.insert(schema.balanceSnapshots)
      .values({ accountId, date: today, balanceCents: valueCents })
      .onConflictDoUpdate({
        target: [schema.balanceSnapshots.accountId, schema.balanceSnapshots.date],
        set: { balanceCents: valueCents, estimated: false },
      })
      .run();
  }
  return { valueCents, source };
}

/** Assets whose automatic value is due (looked up over a month ago, or never). */
export function dueForLookup(db: MunyDb, secret: Buffer | undefined, now = Date.now()): string[] {
  const k = readKeys(db, secret);
  return db
    .select()
    .from(schema.assetDetails)
    .all()
    .filter(
      (d) =>
        ((d.kind === "home" && k.apillow && d.address) ||
          (d.kind === "vehicle" && k.carapi && d.vehicleYear && d.vehicleMake && d.vehicleModel)) &&
        // Only assets that use automatic values (you opted them in by looking them up once).
        d.valueSource !== "manual" &&
        d.valueCheckedAt !== null &&
        now - d.valueCheckedAt > STALE_MS,
    )
    .map((d) => d.accountId);
}

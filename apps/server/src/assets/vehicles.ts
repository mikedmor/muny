/**
 * Make and model suggestions for vehicle assets (D-043), from NHTSA's free
 * public vPIC database: no key, and only the make and model year are sent.
 * Asked for only while you fill in a vehicle; kept in memory for a month.
 */

const VPIC = "https://vpic.nhtsa.dot.gov/api/vehicles";
const MONTH = 30 * 86_400_000;
const TYPES = ["car", "truck", "multipurpose passenger vehicle (mpv)", "motorcycle"];

let makesCache: { at: number; makes: string[] } | null = null;
const modelsCache = new Map<string, { at: number; models: string[] }>();

const title = (s: string) =>
  s
    .toLowerCase()
    .replace(/\b([a-z])/g, (c) => c.toUpperCase())
    .replace(/\bBmw\b|\bGmc\b|\bRam\b/g, (m) => m.toUpperCase());

async function get<T>(f: typeof fetch, url: string): Promise<T> {
  const res = await f(url, {
    headers: { accept: "application/json", "user-agent": "Muny (self-hosted)" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`NHTSA answered ${res.status}`);
  return (await res.json()) as T;
}

export async function vehicleMakes(f: typeof fetch = fetch, now = Date.now()): Promise<string[]> {
  if (makesCache && now - makesCache.at < MONTH) return makesCache.makes;
  const names = new Set<string>();
  for (const t of TYPES) {
    const r = await get<{ Results?: { MakeName?: string }[] }>(
      f,
      `${VPIC}/GetMakesForVehicleType/${encodeURIComponent(t)}?format=json`,
    );
    for (const m of r.Results ?? []) if (m.MakeName) names.add(title(m.MakeName.trim()));
  }
  const makes = [...names].sort((a, b) => a.localeCompare(b));
  makesCache = { at: now, makes };
  return makes;
}

export async function vehicleModels(
  make: string,
  year: number | null,
  f: typeof fetch = fetch,
  now = Date.now(),
): Promise<string[]> {
  const key = `${make.toLowerCase()}|${year ?? ""}`;
  const hit = modelsCache.get(key);
  if (hit && now - hit.at < MONTH) return hit.models;
  const path = year
    ? `GetModelsForMakeYear/make/${encodeURIComponent(make)}/modelyear/${year}`
    : `GetModelsForMake/${encodeURIComponent(make)}`;
  const r = await get<{ Results?: { Model_Name?: string }[] }>(f, `${VPIC}/${path}?format=json`);
  const models = [
    ...new Set((r.Results ?? []).map((m) => m.Model_Name?.trim()).filter(Boolean) as string[]),
  ].sort((a, b) => a.localeCompare(b));
  modelsCache.set(key, { at: now, models });
  return models;
}

/** For tests. */
export function resetVehicleCache() {
  makesCache = null;
  modelsCache.clear();
}

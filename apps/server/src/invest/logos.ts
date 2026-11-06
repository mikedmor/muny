import { type MunyDb, schema } from "@muny/db";
import type { InvestSettings } from "@muny/shared";
import { eq } from "drizzle-orm";
import { spend } from "../crypto/budget.js";

/**
 * Company logos (D-039), opt-in. The NAS fetches a ticker's logo once (only
 * the ticker is sent) from Financial Modeling Prep, else Parqet, keeps it in
 * the database and serves it to the browser itself, so the page never talks
 * to those sites. Only PNG/JPEG/WebP up to 256 KB are kept.
 */

export interface LogoDeps {
  fetch?: typeof fetch;
}

const SETTINGS_KEY = "invest.settings";
const SOURCES = [
  (s: string) => `https://financialmodelingprep.com/image-stock/${encodeURIComponent(s)}.png`,
  (s: string) => `https://assets.parqet.com/logos/symbol/${encodeURIComponent(s)}?format=png`,
];
const TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX = 256 * 1024;
const RETRY_MISSING_MS = 30 * 86_400_000;
export const LOGO_SYMBOL = /^[A-Z][A-Z0-9.-]{0,9}$/;

export function getInvestSettings(db: MunyDb): InvestSettings {
  const v = db
    .select({ value: schema.appSettings.value })
    .from(schema.appSettings)
    .where(eq(schema.appSettings.key, SETTINGS_KEY))
    .get()?.value as Partial<InvestSettings> | undefined;
  return { logos: v?.logos ?? false, market: v?.market ?? false };
}

export function setInvestSettings(db: MunyDb, patch: Partial<InvestSettings>): InvestSettings {
  const next = { ...getInvestSettings(db), ...patch };
  db.insert(schema.appSettings)
    .values({ key: SETTINGS_KEY, value: next })
    .onConflictDoUpdate({ target: schema.appSettings.key, set: { value: next } })
    .run();
  return next;
}

/** The logo for a ticker (cached), or null. Fetches only when logos are turned on. */
export async function logoFor(
  db: MunyDb,
  deps: LogoDeps,
  symbol: string,
  now = Date.now(),
): Promise<{ type: string; body: Buffer } | null> {
  if (!getInvestSettings(db).logos || !LOGO_SYMBOL.test(symbol)) return null;
  const t = schema.securityLogos;
  const cached = db.select().from(t).where(eq(t.symbol, symbol)).get();
  if (cached?.data && cached.contentType) return { type: cached.contentType, body: cached.data };
  if (cached && now - cached.fetchedAt < RETRY_MISSING_MS) return null;
  const f = deps.fetch ?? fetch;
  let found: { type: string; body: Buffer } | null = null;
  for (const url of SOURCES) {
    try {
      spend(db, "logos");
      const res = await f(url(symbol.replace(/\./g, "-")), {
        headers: { accept: "image/png,image/jpeg,image/webp", "user-agent": "Muny (self-hosted)" },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      const type = (res.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
      if (!res.ok || !TYPES.has(type)) continue;
      const body = Buffer.from(await res.arrayBuffer());
      if (body.length < 100 || body.length > MAX) continue;
      found = { type, body };
      break;
    } catch {
      break; // out of budget or unreachable: try again another time
    }
  }
  db.insert(t)
    .values({ symbol, contentType: found?.type ?? null, data: found?.body ?? null, fetchedAt: now })
    .onConflictDoUpdate({
      target: t.symbol,
      set: { contentType: found?.type ?? null, data: found?.body ?? null, fetchedAt: now },
    })
    .run();
  return found;
}

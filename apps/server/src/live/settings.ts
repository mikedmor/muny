import { type MunyDb, schema } from "@muny/db";
import type { LiveSettingsInput } from "@muny/shared";
import { eq } from "drizzle-orm";
import { decryptJson, encryptJson } from "../lib/crypto.js";

/**
 * Settings → API → Live prices. Both off by default (each is an outbound
 * connection). The Finnhub key is stored encrypted and only ever sent to Finnhub.
 */

const KEY = "live.settings";

export interface StoredLive {
  stocks: boolean;
  crypto: boolean;
  /** encryptJson({ key }) */
  finnhubKeyEnc: string | null;
}

export function readLive(db: MunyDb): StoredLive {
  const row = db
    .select({ value: schema.appSettings.value })
    .from(schema.appSettings)
    .where(eq(schema.appSettings.key, KEY))
    .get();
  return {
    stocks: false,
    crypto: false,
    finnhubKeyEnc: null,
    ...(row?.value as Partial<StoredLive>),
  };
}

export class LiveSetupError extends Error {}

export function updateLive(db: MunyDb, secret: Buffer | undefined, input: LiveSettingsInput) {
  const next = { ...readLive(db) };
  if (input.stocks !== undefined) next.stocks = input.stocks;
  if (input.crypto !== undefined) next.crypto = input.crypto;
  if (input.finnhubKey === null) next.finnhubKeyEnc = null;
  else if (input.finnhubKey?.trim()) {
    if (!secret)
      throw new LiveSetupError("Set MUNY_SECRET_KEY first: the key is stored encrypted.");
    next.finnhubKeyEnc = encryptJson(secret, { key: input.finnhubKey.trim() });
  }
  db.insert(schema.appSettings)
    .values({ key: KEY, value: next })
    .onConflictDoUpdate({ target: schema.appSettings.key, set: { value: next } })
    .run();
  return next;
}

export function finnhubKey(db: MunyDb, secret: Buffer | undefined): string | null {
  const s = readLive(db);
  if (!s.finnhubKeyEnc || !secret) return null;
  try {
    return decryptJson<{ key: string }>(secret, s.finnhubKeyEnc).key;
  } catch {
    return null;
  }
}

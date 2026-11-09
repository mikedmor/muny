import { type MunyDb, schema } from "@muny/db";
import {
  AI_DEFAULT_BASE_URLS,
  AI_DEFAULT_MODELS,
  type AiFeatures,
  type AiModelJob,
  type AiProvider,
  type AiSettings,
  type AiSettingsInput,
} from "@muny/shared";
import { eq } from "drizzle-orm";
import { decryptJson, encryptJson } from "../lib/crypto.js";

/**
 * Settings → AI, kept in app settings. The provider key is stored encrypted
 * with MUNY_SECRET_KEY and never leaves the server except to the provider.
 */

const KEY = "ai.settings";

interface Stored {
  enabled: boolean;
  provider: AiProvider;
  model: string;
  baseUrl: string | null;
  features: AiFeatures;
  models: Partial<Record<AiModelJob, string>>;
  /** encryptJson({ key }) */
  keyEnc: string | null;
}

const DEFAULTS: Stored = {
  enabled: false,
  provider: "anthropic",
  model: AI_DEFAULT_MODELS.anthropic,
  baseUrl: null,
  // The ones that send more, or send on their own, start off.
  features: {
    categorize: true,
    monthlyReview: true,
    statementTemplates: true,
    autoCategorize: false,
    merchantNames: true,
    midMonthCheckin: false,
    ask: false,
  },
  models: {},
  keyEnc: null,
};

function read(db: MunyDb): Stored {
  const row = db
    .select({ value: schema.appSettings.value })
    .from(schema.appSettings)
    .where(eq(schema.appSettings.key, KEY))
    .get();
  const v = (row?.value ?? {}) as Partial<Stored>;
  return {
    ...DEFAULTS,
    ...v,
    features: { ...DEFAULTS.features, ...v.features },
    models: { ...v.models },
  };
}

function write(db: MunyDb, s: Stored) {
  db.insert(schema.appSettings)
    .values({ key: KEY, value: s })
    .onConflictDoUpdate({ target: schema.appSettings.key, set: { value: s } })
    .run();
}

export function aiSettings(db: MunyDb, secret: Buffer | undefined): AiSettings {
  const { keyEnc, ...s } = read(db);
  return { ...s, hasKey: !!keyEnc, canStoreKey: !!secret };
}

export class AiSetupError extends Error {}

export function updateAiSettings(
  db: MunyDb,
  secret: Buffer | undefined,
  input: AiSettingsInput,
): AiSettings {
  const now = read(db);
  const next: Stored = {
    ...now,
    ...(input.enabled !== undefined && { enabled: input.enabled }),
    ...(input.provider !== undefined && { provider: input.provider }),
    ...(input.model !== undefined && { model: input.model.trim() }),
    ...(input.baseUrl !== undefined && { baseUrl: input.baseUrl?.trim() || null }),
    features: { ...now.features, ...input.features },
    models: { ...now.models },
  };
  for (const [job, model] of Object.entries(input.models ?? {}) as [AiModelJob, string][]) {
    if (model.trim()) next.models[job] = model.trim();
    else delete next.models[job];
  }
  // A new provider starts from its own suggested model, unless one was given.
  if (input.provider && input.provider !== now.provider && input.model === undefined)
    next.model = AI_DEFAULT_MODELS[input.provider];
  if (input.key === null) next.keyEnc = null;
  else if (input.key?.trim()) {
    if (!secret) throw new AiSetupError("Set MUNY_SECRET_KEY first: the key is stored encrypted.");
    next.keyEnc = encryptJson(secret, { key: input.key.trim() });
  }
  write(db, next);
  return aiSettings(db, secret);
}

/** What a call needs: where to send it and the key (decrypted only here). */
export interface AiConnection {
  provider: AiProvider;
  model: string;
  baseUrl: string | null;
  apiKey: string | null;
}

/** The connection for a feature, or why there isn't one. */
export function aiConnection(
  db: MunyDb,
  secret: Buffer | undefined,
  feature?: keyof AiFeatures,
): AiConnection {
  const s = read(db);
  if (!s.enabled) throw new AiSetupError("Turn on AI in Settings → AI first.");
  if (feature && !s.features[feature])
    throw new AiSetupError("That AI feature is turned off in Settings → AI.");
  // Suggesting categories by itself is the categorize job.
  const job = (feature === "autoCategorize" ? "categorize" : feature) as AiModelJob | undefined;
  const model = (job && s.models[job]) || s.model;
  if (!model) throw new AiSetupError("Choose a model in Settings → AI.");
  let apiKey: string | null = null;
  if (s.keyEnc && secret) apiKey = decryptJson<{ key: string }>(secret, s.keyEnc).key;
  if (!apiKey && s.provider === "anthropic")
    throw new AiSetupError("Add your Anthropic API key in Settings → AI.");
  return {
    provider: s.provider,
    model,
    baseUrl: s.baseUrl ?? AI_DEFAULT_BASE_URLS[s.provider],
    apiKey,
  };
}

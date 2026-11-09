/**
 * Optional built-in AI (Settings → AI). Off by default; when on, Muny sends
 * only what a feature needs to the provider you choose.
 */

export const AI_PROVIDERS = ["anthropic", "openai", "ollama"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export const AI_PROVIDER_LABELS: Record<AiProvider, string> = {
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI-compatible",
  ollama: "Ollama (on your own machine)",
};

/** Suggested model per provider; any model the provider offers can be typed in. */
export const AI_DEFAULT_MODELS: Record<AiProvider, string> = {
  anthropic: "claude-opus-5-5",
  openai: "",
  ollama: "llama3.1",
};

/** Where requests go when no address is set. */
export const AI_DEFAULT_BASE_URLS: Record<AiProvider, string | null> = {
  anthropic: null,
  openai: "https://api.openai.com/v1",
  ollama: "http://localhost:11434",
};

export interface AiFeatures {
  /** Suggest categories for uncategorized transactions (they go to the inbox). */
  categorize: boolean;
  /** A short review of last month, as a notification early each month. */
  monthlyReview: boolean;
  /** Fill in "Teach Muny" from a statement's lines. */
  statementTemplates: boolean;
  /** Suggest categories by itself after a bank sync or import brings in new transactions. */
  autoCategorize: boolean;
  /** Suggest tidier names for merchants that still look like bank text. */
  merchantNames: boolean;
  /** A short note mid-month on how budgets are pacing. */
  midMonthCheckin: boolean;
  /** Ask questions about your money in plain words. */
  ask: boolean;
}

export const AI_FEATURE_KEYS = [
  "categorize",
  "autoCategorize",
  "monthlyReview",
  "midMonthCheckin",
  "merchantNames",
  "statementTemplates",
  "ask",
] as const satisfies readonly (keyof AiFeatures)[];

/** The jobs that can use their own model (the rest of the settings are shared). */
export const AI_MODEL_JOBS = [
  "categorize",
  "monthlyReview",
  "midMonthCheckin",
  "merchantNames",
  "statementTemplates",
  "ask",
] as const satisfies readonly (keyof AiFeatures)[];
export type AiModelJob = (typeof AI_MODEL_JOBS)[number];

export interface AiSettings {
  enabled: boolean;
  provider: AiProvider;
  model: string;
  /** For OpenAI-compatible servers and Ollama; null = the default address. */
  baseUrl: string | null;
  features: AiFeatures;
  /** A model for one job instead of `model` (same provider and server); missing = `model`. */
  models: Partial<Record<AiModelJob, string>>;
  /** A key is stored (it's never sent back). */
  hasKey: boolean;
  /** Muny can store a key: MUNY_SECRET_KEY is set. */
  canStoreKey: boolean;
}

export interface AiSettingsInput {
  enabled?: boolean;
  provider?: AiProvider;
  model?: string;
  baseUrl?: string | null;
  features?: Partial<AiFeatures>;
  /** A model per job; "" goes back to the main model. */
  models?: Partial<Record<AiModelJob, string>>;
  /** A new key; null removes it; leave it out to keep the stored one. */
  key?: string | null;
}

export interface AiCategorizeResult {
  /** Uncategorized transactions looked at. */
  considered: number;
  /** Given a category. */
  suggested: number;
  /** Suggestions put in the inbox (one per category). */
  filed: number;
}

/** A "Teach Muny" draft: only fields whose label really finds a value on the statement. */
export interface AiTemplateDraft {
  name: string;
  matchText: string;
  fields: Record<string, { label: string }>;
}

/** One earlier turn of an Ask Muny conversation. */
export interface AiAskTurn {
  role: "user" | "assistant";
  text: string;
}

export interface AiAskResult {
  answer: string;
  /** What it looked at, for the page to show: "budgets", "transactions". */
  looked: string[];
}

/** A monthly review the built-in AI wrote (Reports → Reviews). */
export interface AiReview {
  /** YYYY-MM, the month reviewed. */
  month: string;
  /** "- " points, then "Next month: ...". */
  body: string;
  /** unix ms */
  createdAt: number;
}

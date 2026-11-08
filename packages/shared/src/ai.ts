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
}

export interface AiSettings {
  enabled: boolean;
  provider: AiProvider;
  model: string;
  /** For OpenAI-compatible servers and Ollama; null = the default address. */
  baseUrl: string | null;
  features: AiFeatures;
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

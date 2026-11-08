import type { z } from "zod";
import { anthropicJson, anthropicText } from "./anthropic.js";
import { compatibleJson, compatibleText } from "./compatible.js";
import type { AiConnection } from "./settings.js";

/** One request to the chosen provider. */
export interface AiCall extends AiConnection {
  system: string;
  prompt: string;
  maxTokens: number;
  /** How hard the model should think (where the model supports it). */
  effort: "low" | "medium" | "high";
  fetch?: typeof fetch;
}

/** A failure worth showing as is: short, ours, no key or content in it. */
export class AiCallError extends Error {}

export function askJson<T>(c: AiCall, schema: z.ZodType<T>): Promise<T> {
  return c.provider === "anthropic" ? anthropicJson(c, schema) : compatibleJson(c, schema);
}

export function askText(c: AiCall): Promise<string> {
  return c.provider === "anthropic" ? anthropicText(c) : compatibleText(c);
}

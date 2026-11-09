import type { AiAskTurn } from "@muny/shared";
import type { z } from "zod";
import { anthropicJson, anthropicText, anthropicToolChat } from "./anthropic.js";
import { compatibleJson, compatibleText, compatibleToolChat } from "./compatible.js";
import type { AiConnection } from "./settings.js";

/** One request to the chosen provider. */
export interface AiCall extends AiConnection {
  system: string;
  prompt: string;
  maxTokens: number;
  /** How hard the model should think (where the model supports it). */
  effort: "low" | "medium" | "high";
  fetch?: typeof fetch;
  /**
   * Whether someone is waiting on the answer. Interactive (the default) only retries
   * short waits and otherwise says how long to wait; background waits it out, within limits.
   */
  mode?: "interactive" | "background";
  /** Told each time Muny waits to send again (a background job's log). */
  onWait?: (reason: string, seconds: number) => void;
  /** For tests: how to wait. */
  sleep?: (seconds: number) => Promise<void>;
}

/** A failure worth showing as is: short, ours, no key or content in it. */
export class AiCallError extends Error {
  /** Seconds until it's worth trying again, when the provider said; absent when retrying won't help. */
  readonly retryAfter?: number;
  /** The provider's reason code, when it gave one (busy, no_machines…). */
  readonly code?: string | null;
  /** The provider's HTTP status, when that's what went wrong. */
  readonly status?: number;
  constructor(
    message: string,
    opts: { retryAfter?: number; code?: string | null; status?: number } = {},
  ) {
    super(message);
    this.retryAfter = opts.retryAfter;
    this.code = opts.code;
    this.status = opts.status;
  }
}

/** A tool offered to the model. */
export interface ChatTool {
  name: string;
  description: string;
  /** JSON Schema for its input. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolAnswer {
  id: string;
  name: string;
  content: string;
  isError: boolean;
}

/** One conversation with tools. send(null) starts it; send(answers) replies to its calls. */
export interface ToolChat {
  send(answers: ToolAnswer[] | null): Promise<{ text: string; calls: ToolCall[] }>;
}

export function toolChat(c: AiCall, tools: ChatTool[], history: AiAskTurn[]): ToolChat {
  return c.provider === "anthropic"
    ? anthropicToolChat(c, tools, history)
    : compatibleToolChat(c, tools, history);
}

export function askJson<T>(c: AiCall, schema: z.ZodType<T>): Promise<T> {
  return c.provider === "anthropic" ? anthropicJson(c, schema) : compatibleJson(c, schema);
}

export function askText(c: AiCall): Promise<string> {
  return c.provider === "anthropic" ? anthropicText(c) : compatibleText(c);
}

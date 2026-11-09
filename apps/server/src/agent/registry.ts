import type { MunyDb } from "@muny/db";
import { schema } from "@muny/db";
import type { AgentScope } from "@muny/shared";
import { eq } from "drizzle-orm";
import { ZodError, z } from "zod";
import { audit } from "../lib/audit.js";
import { localToday } from "../lib/dates.js";
import { HttpError } from "../lib/http.js";
import { describeChange } from "../undo/track.js";
import type { AgentContext } from "./tokens.js";

/**
 * Each capability is defined once, here; MCP and REST are thin adapters over it.
 * Every call goes through runTool, which checks the scope, validates the input and
 * writes the audit log, so no tool can forget to.
 */

export interface ToolContext {
  db: MunyDb;
  agent: AgentContext;
  today: string;
}

export interface Tool {
  name: string;
  /** Written for a model: what it's for and what comes back. */
  description: string;
  /** Null: any valid token. A tool can check more itself, as data tools do per dataset. */
  scope: AgentScope | null;
  /** Changes something. Writes take dry_run, which defaults to true. */
  write?: boolean;
  input: z.ZodObject;
  run: (ctx: ToolContext, input: never) => unknown;
}

export function defineTool<S extends z.ZodObject>(tool: {
  name: string;
  description: string;
  scope: AgentScope | null;
  write?: boolean;
  input: S;
  run: (ctx: ToolContext, input: z.infer<S>) => unknown;
}): Tool {
  return tool as unknown as Tool;
}

export const dryRunField = z
  .boolean()
  .default(true)
  .describe("true (the default) checks and previews without saving. false saves it.");

export const toolJsonSchema = (tool: Tool) => z.toJSONSchema(tool.input, { io: "input" });

export class ToolError extends Error {
  constructor(
    readonly code: "not_allowed" | "invalid" | "not_found" | "conflict" | "failed",
    message: string,
  ) {
    super(message);
  }
}

function toToolError(e: unknown): ToolError {
  if (e instanceof ToolError) return e;
  if (e instanceof ZodError)
    return new ToolError(
      "invalid",
      e.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "),
    );
  if (e instanceof HttpError) {
    if (e.statusCode === 404) return new ToolError("not_found", e.message);
    if (e.statusCode === 409) return new ToolError("conflict", e.message);
    if (e.statusCode < 500) return new ToolError("invalid", e.message);
  }
  // Anything else is a bug here, and its message could hold anything.
  return new ToolError("failed", "That didn't work, and Muny doesn't know why.");
}

export function runTool(
  tools: Map<string, Tool>,
  db: MunyDb,
  agent: AgentContext,
  name: string,
  rawInput: unknown,
): unknown {
  const tool = tools.get(name);
  if (!tool) throw new ToolError("not_found", `There's no tool called ${name}.`);
  const input = (rawInput ?? {}) as { dry_run?: unknown };
  let dryRun = false;
  try {
    if (tool.scope && !agent.scopes.has(tool.scope))
      throw new ToolError(
        "not_allowed",
        `This token doesn't have the ${tool.scope} permission. Its owner can make one that does in Settings → Agents.`,
      );
    const parsed = tool.input.parse(input) as { dry_run?: boolean };
    dryRun = tool.write === true && parsed.dry_run !== false;
    if (tool.write) {
      // In the history (and undoable) as the assistant's, by what it did.
      const token = db
        .select({ name: schema.apiTokens.name })
        .from(schema.apiTokens)
        .where(eq(schema.apiTokens.id, agent.tokenId))
        .get();
      const what = name.replace(/_/g, " ");
      describeChange(db, `${what[0]?.toUpperCase()}${what.slice(1)}`, {
        type: "agent",
        id: agent.tokenId,
        name: token?.name ?? "An assistant",
      });
    }
    const result = tool.run({ db, agent, today: localToday() }, parsed as never);
    audit(db, {
      actorType: "agent",
      actorId: agent.tokenId,
      action: `agent.${name}`,
      entityType: "tool",
      entityId: name,
      details: { ok: true, ...(dryRun ? { dryRun } : {}) },
    });
    return result;
  } catch (e) {
    const failure = toToolError(e);
    audit(db, {
      actorType: "agent",
      actorId: agent.tokenId,
      action: `agent.${name}`,
      entityType: "tool",
      entityId: name,
      details: { ok: false, code: failure.code },
    });
    throw failure;
  }
}

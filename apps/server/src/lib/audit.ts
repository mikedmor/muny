import { type MunyDb, schema } from "@muny/db";

export interface AuditEntry {
  actorType: "user" | "agent" | "system";
  actorId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  /** Must never contain secrets, tokens, passwords or full account numbers. */
  details?: unknown;
}

export function audit(db: MunyDb, e: AuditEntry): void {
  db.insert(schema.auditLog)
    .values({
      actorType: e.actorType,
      actorId: e.actorId ?? null,
      action: e.action,
      entityType: e.entityType ?? null,
      entityId: e.entityId ?? null,
      details: e.details ?? null,
    })
    .run();
}

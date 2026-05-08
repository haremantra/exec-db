import { schema, type Db } from "@exec-db/db";
import { createHash } from "node:crypto";
import type { Session } from "./rbac.js";

export type AuditEntry = {
  schemaName: "core" | "hr" | "comp" | "fin" | "legal" | "ops" | "crm" | "pm";
  tableName: string;
  action: "SELECT" | "EXPORT" | "INSERT" | "UPDATE" | "DELETE";
  intent: string;
  query?: string;
  metadata?: Record<string, unknown>;
};

export async function recordAccess(
  tx: Db,
  session: Session,
  entry: AuditEntry,
): Promise<void> {
  const queryHash = entry.query
    ? createHash("sha256").update(entry.query).digest("hex").slice(0, 64)
    : null;

  await tx.insert(schema.accessLog).values({
    userId: session.userId,
    tier: session.tier,
    action: entry.action,
    schemaName: entry.schemaName,
    tableName: entry.tableName,
    queryHash,
    intent: entry.intent,
    metadata: entry.metadata ?? null,
  });
}

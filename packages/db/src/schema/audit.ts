import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const audit = pgSchema("audit");

/**
 * Every read of `comp.*` and every privileged write across all schemas writes a
 * row here. Trigger-based for DB-level guarantees; the app layer also calls
 * `recordAccess()` for richer query-hash + intent context.
 */
export const accessLog = audit.table(
  "access_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    userId: text("user_id").notNull(),
    tier: varchar("tier", { length: 24 }).notNull(),
    action: varchar("action", { length: 16 }).notNull(),
    schemaName: varchar("schema_name", { length: 32 }).notNull(),
    tableName: varchar("table_name", { length: 64 }).notNull(),
    rowPk: text("row_pk"),
    queryHash: varchar("query_hash", { length: 64 }),
    intent: text("intent"),
    metadata: jsonb("metadata"),
  },
  (t) => [
    index("access_log_user_idx").on(t.userId, t.occurredAt),
    index("access_log_table_idx").on(t.schemaName, t.tableName, t.occurredAt),
  ],
);

/**
 * Append-only audit log for every LLM call made through safeAnthropic /
 * safeAnthropicStream. Satisfies SY-017 (every call gets a row) and
 * AD-005 (365-day minimum retention, enforced by a DB-level trigger).
 *
 * The table is intentionally flat (no JOIN to crm.contact here) so that
 * audit reads never block on CRM availability. contact_id is nullable
 * because non-contact calls (e.g., vision-check) still need rows.
 *
 * No UPDATE or DELETE policies exist. A delete-prevention trigger enforces
 * append-only semantics at the DB level (see packages/db/src/rls/policies.sql).
 */
export const llmCall = audit.table(
  "llm_call",
  {
    id: uuid("id").primaryKey().default(sql`uuid_generate_v4()`),
    timestampUtc: timestamp("timestamp_utc", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    /** Nullable — null for non-contact calls like vision-check. */
    contactId: uuid("contact_id"),
    /** "opus" | "sonnet" */
    model: varchar("model", { length: 64 }).notNull(),
    /** Free-form label: "vision-check" | "autodraft" | "digest-rank" etc. */
    promptClass: varchar("prompt_class", { length: 32 }).notNull(),
    /** sha256 hex of the redacted prompt text. */
    redactedInputHash: varchar("redacted_input_hash", { length: 64 }).notNull(),
    /** sha256 hex of the response text; nullable in case of stream failure. */
    responseHash: varchar("response_hash", { length: 64 }),
    /** Array of RedactionClass values that fired on this call. */
    redactionsApplied: jsonb("redactions_applied").notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    costUsd: numeric("cost_usd", { precision: 10, scale: 6 }),
    /** "ok" | "error" | "killed" */
    outcome: varchar("outcome", { length: 16 }).notNull(),
  },
  (t) => [
    index("llm_call_timestamp_idx").on(t.timestampUtc.desc()),
    index("llm_call_contact_idx").on(t.contactId, t.timestampUtc.desc()),
  ],
);

export const exportLog = audit.table("export_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  occurredAt: timestamp("occurred_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
  userId: text("user_id").notNull(),
  format: varchar("format", { length: 8 }).notNull(),
  domain: varchar("domain", { length: 16 }).notNull(),
  rowCount: text("row_count").notNull(),
  watermark: text("watermark").notNull(),
});

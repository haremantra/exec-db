import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
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

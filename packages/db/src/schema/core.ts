import { sql } from "drizzle-orm";
import {
  date,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const core = pgSchema("core");

/**
 * SCD2 lineage columns. Every fact and slowly-changing dim should embed these
 * so we can answer "what was true on date X" without losing history.
 */
export const lineage = {
  ingestedAt: timestamp("_ingested_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
  sourceSystem: varchar("_source_system", { length: 64 }).notNull(),
  sourceId: varchar("_source_id", { length: 256 }).notNull(),
  validFrom: timestamp("_valid_from", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
  validTo: timestamp("_valid_to", { withTimezone: true }),
};

export const dateDim = core.table("date_dim", {
  dateKey: date("date_key").primaryKey(),
  year: text("year").notNull(),
  quarter: text("quarter").notNull(),
  month: text("month").notNull(),
  isWeekday: text("is_weekday").notNull(),
});

export const entityDim = core.table(
  "entity_dim",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    legalName: text("legal_name").notNull(),
    jurisdiction: varchar("jurisdiction", { length: 8 }).notNull(),
    ...lineage,
  },
  (t) => [uniqueIndex("entity_dim_source_uk").on(t.sourceSystem, t.sourceId)],
);

export const employeeDim = core.table(
  "employee_dim",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workEmail: text("work_email").notNull(),
    fullName: text("full_name").notNull(),
    employeeNumber: varchar("employee_number", { length: 32 }),
    rippllingId: varchar("rippling_id", { length: 64 }),
    cartaStakeholderId: varchar("carta_stakeholder_id", { length: 64 }),
    ...lineage,
  },
  (t) => [
    uniqueIndex("employee_dim_email_uk").on(t.workEmail),
    uniqueIndex("employee_dim_source_uk").on(t.sourceSystem, t.sourceId),
  ],
);

export const customerDim = core.table(
  "customer_dim",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    domain: text("domain"),
    stripeCustomerId: varchar("stripe_customer_id", { length: 64 }),
    ...lineage,
  },
  (t) => [uniqueIndex("customer_dim_source_uk").on(t.sourceSystem, t.sourceId)],
);

export const vendorDim = core.table(
  "vendor_dim",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    category: text("category"),
    ...lineage,
  },
  (t) => [uniqueIndex("vendor_dim_source_uk").on(t.sourceSystem, t.sourceId)],
);

/** Freshness SLA: each ingestion source publishes a row here on every successful sync. */
export const freshnessLog = core.table("freshness_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  source: varchar("source", { length: 64 }).notNull(),
  domain: varchar("domain", { length: 16 }).notNull(),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }).notNull(),
  rowsIngested: text("rows_ingested").notNull(),
  status: varchar("status", { length: 16 }).notNull(),
});

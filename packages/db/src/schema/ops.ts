import {
  date,
  index,
  numeric,
  pgSchema,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { lineage } from "./core";

export const ops = pgSchema("ops");

export const subscription = ops.table(
  "subscription",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id").notNull(),
    plan: varchar("plan", { length: 32 }).notNull(),
    mrrUsd: numeric("mrr_usd", { precision: 12, scale: 2 }).notNull(),
    startedOn: date("started_on").notNull(),
    canceledOn: date("canceled_on"),
    ...lineage,
  },
  (t) => [index("subscription_customer_idx").on(t.customerId)],
);

export const mrrSnapshot = ops.table("mrr_snapshot", {
  id: uuid("id").primaryKey().defaultRandom(),
  asOf: date("as_of").notNull(),
  newMrrUsd: numeric("new_mrr_usd", { precision: 14, scale: 2 }).notNull(),
  expansionMrrUsd: numeric("expansion_mrr_usd", { precision: 14, scale: 2 }).notNull(),
  contractionMrrUsd: numeric("contraction_mrr_usd", { precision: 14, scale: 2 }).notNull(),
  churnedMrrUsd: numeric("churned_mrr_usd", { precision: 14, scale: 2 }).notNull(),
  endingMrrUsd: numeric("ending_mrr_usd", { precision: 14, scale: 2 }).notNull(),
});

export const incident = ops.table(
  "incident",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    severity: varchar("severity", { length: 8 }).notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    rootCause: text("root_cause"),
    ...lineage,
  },
  (t) => [index("incident_severity_idx").on(t.severity)],
);

export const okr = ops.table(
  "okr",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    quarter: varchar("quarter", { length: 8 }).notNull(),
    objective: text("objective").notNull(),
    keyResult: text("key_result").notNull(),
    target: numeric("target", { precision: 14, scale: 2 }).notNull(),
    actual: numeric("actual", { precision: 14, scale: 2 }).notNull(),
    status: varchar("status", { length: 8 }).notNull(),
    owner: text("owner").notNull(),
    ...lineage,
  },
  (t) => [index("okr_quarter_idx").on(t.quarter)],
);

export const kpiSnapshot = ops.table(
  "kpi_snapshot",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    metric: varchar("metric", { length: 64 }).notNull(),
    asOf: date("as_of").notNull(),
    value: numeric("value", { precision: 18, scale: 4 }).notNull(),
    unit: varchar("unit", { length: 16 }).notNull(),
  },
  (t) => [index("kpi_metric_idx").on(t.metric, t.asOf)],
);

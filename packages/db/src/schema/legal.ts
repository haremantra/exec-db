import {
  date,
  index,
  numeric,
  pgSchema,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { lineage } from "./core.js";

export const legal = pgSchema("legal");

export const counterparty = legal.table(
  "counterparty",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    party: varchar("party", { length: 16 }).notNull(),
    ...lineage,
  },
  (t) => [uniqueIndex("counterparty_source_uk").on(t.sourceSystem, t.sourceId)],
);

export const contract = legal.table(
  "contract",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    counterpartyId: uuid("counterparty_id").notNull(),
    title: text("title").notNull(),
    contractType: varchar("contract_type", { length: 24 }).notNull(),
    effectiveOn: date("effective_on").notNull(),
    expiresOn: date("expires_on"),
    autoRenew: varchar("auto_renew", { length: 8 }).notNull(),
    annualValueUsd: numeric("annual_value_usd", { precision: 14, scale: 2 }),
    documentUrl: text("document_url"),
    ...lineage,
  },
  (t) => [index("contract_expires_idx").on(t.expiresOn)],
);

export const obligation = legal.table(
  "obligation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contractId: uuid("contract_id").notNull(),
    description: text("description").notNull(),
    dueOn: date("due_on"),
    status: varchar("status", { length: 16 }).notNull(),
    owner: text("owner"),
    ...lineage,
  },
  (t) => [index("obligation_contract_idx").on(t.contractId)],
);

export const renewalEvent = legal.table(
  "renewal_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contractId: uuid("contract_id").notNull(),
    noticeDeadline: date("notice_deadline").notNull(),
    renewsOn: date("renews_on").notNull(),
    arrAtRiskUsd: numeric("arr_at_risk_usd", { precision: 14, scale: 2 }),
    status: varchar("status", { length: 16 }).notNull(),
    ...lineage,
  },
  (t) => [index("renewal_deadline_idx").on(t.noticeDeadline)],
);

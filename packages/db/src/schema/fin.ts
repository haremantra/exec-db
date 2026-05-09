import {
  date,
  index,
  numeric,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { lineage } from "./core";

export const fin = pgSchema("fin");

export const glAccount = fin.table(
  "gl_account",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: varchar("code", { length: 32 }).notNull(),
    name: text("name").notNull(),
    type: varchar("type", { length: 24 }).notNull(),
    ...lineage,
  },
  (t) => [uniqueIndex("gl_account_code_uk").on(t.code)],
);

export const transaction = fin.table(
  "transaction",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    glAccountId: uuid("gl_account_id").notNull(),
    entityId: uuid("entity_id").notNull(),
    amountUsd: numeric("amount_usd", { precision: 14, scale: 2 }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    direction: varchar("direction", { length: 6 }).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    memo: text("memo"),
    ...lineage,
  },
  (t) => [
    index("transaction_account_idx").on(t.glAccountId),
    index("transaction_occurred_idx").on(t.occurredAt),
  ],
);

export const invoice = fin.table(
  "invoice",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id").notNull(),
    number: varchar("number", { length: 64 }).notNull(),
    amountUsd: numeric("amount_usd", { precision: 14, scale: 2 }).notNull(),
    issuedOn: date("issued_on").notNull(),
    dueOn: date("due_on").notNull(),
    paidOn: date("paid_on"),
    status: varchar("status", { length: 16 }).notNull(),
    ...lineage,
  },
  (t) => [index("invoice_customer_idx").on(t.customerId)],
);

export const bill = fin.table(
  "bill",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    vendorId: uuid("vendor_id").notNull(),
    number: varchar("number", { length: 64 }).notNull(),
    amountUsd: numeric("amount_usd", { precision: 14, scale: 2 }).notNull(),
    issuedOn: date("issued_on").notNull(),
    dueOn: date("due_on").notNull(),
    paidOn: date("paid_on"),
    status: varchar("status", { length: 16 }).notNull(),
    ...lineage,
  },
  (t) => [index("bill_vendor_idx").on(t.vendorId)],
);

export const bankBalance = fin.table("bank_balance", {
  id: uuid("id").primaryKey().defaultRandom(),
  account: varchar("account", { length: 64 }).notNull(),
  balanceUsd: numeric("balance_usd", { precision: 14, scale: 2 }).notNull(),
  asOf: timestamp("as_of", { withTimezone: true }).notNull(),
  ...lineage,
});

export const runwaySnapshot = fin.table("runway_snapshot", {
  id: uuid("id").primaryKey().defaultRandom(),
  asOf: date("as_of").notNull(),
  cashUsd: numeric("cash_usd", { precision: 14, scale: 2 }).notNull(),
  monthlyBurnUsd: numeric("monthly_burn_usd", { precision: 14, scale: 2 }).notNull(),
  runwayMonths: numeric("runway_months", { precision: 6, scale: 2 }).notNull(),
});

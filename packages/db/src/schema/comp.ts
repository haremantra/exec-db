import {
  date,
  index,
  numeric,
  pgSchema,
  text,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { lineage } from "./core.js";

/**
 * Compensation lives in its own Postgres schema with its own role.
 * The default app role MUST NOT have any grants on `comp.*`.
 * See `src/rls/policies.sql` for the row-level access rules.
 */
export const comp = pgSchema("comp");

export const compBand = comp.table(
  "comp_band",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    functionArea: varchar("function_area", { length: 32 }).notNull(),
    level: varchar("level", { length: 16 }).notNull(),
    geo: varchar("geo", { length: 16 }).notNull(),
    minBaseUsd: numeric("min_base_usd", { precision: 12, scale: 2 }).notNull(),
    midBaseUsd: numeric("mid_base_usd", { precision: 12, scale: 2 }).notNull(),
    maxBaseUsd: numeric("max_base_usd", { precision: 12, scale: 2 }).notNull(),
    ...lineage,
  },
  (t) => [index("comp_band_lookup_idx").on(t.functionArea, t.level, t.geo)],
);

export const salary = comp.table(
  "salary",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    employeeId: uuid("employee_id").notNull(),
    baseUsd: numeric("base_usd", { precision: 12, scale: 2 }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    reason: text("reason"),
    ...lineage,
  },
  (t) => [index("salary_employee_idx").on(t.employeeId)],
);

export const bonus = comp.table(
  "bonus",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    employeeId: uuid("employee_id").notNull(),
    amountUsd: numeric("amount_usd", { precision: 12, scale: 2 }).notNull(),
    bonusType: varchar("bonus_type", { length: 24 }).notNull(),
    paidOn: date("paid_on").notNull(),
    ...lineage,
  },
  (t) => [index("bonus_employee_idx").on(t.employeeId)],
);

export const equityGrant = comp.table(
  "equity_grant",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    employeeId: uuid("employee_id").notNull(),
    grantType: varchar("grant_type", { length: 16 }).notNull(),
    sharesGranted: numeric("shares_granted", { precision: 18, scale: 4 }).notNull(),
    strikeUsd: numeric("strike_usd", { precision: 12, scale: 4 }),
    grantDate: date("grant_date").notNull(),
    vestStartDate: date("vest_start_date").notNull(),
    cliffMonths: numeric("cliff_months", { precision: 4, scale: 0 }).notNull(),
    durationMonths: numeric("duration_months", { precision: 4, scale: 0 }).notNull(),
    ...lineage,
  },
  (t) => [index("equity_grant_employee_idx").on(t.employeeId)],
);

export const vestingSchedule = comp.table(
  "vesting_schedule",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    grantId: uuid("grant_id").notNull(),
    vestDate: date("vest_date").notNull(),
    sharesVested: numeric("shares_vested", { precision: 18, scale: 4 }).notNull(),
    cumulativeShares: numeric("cumulative_shares", { precision: 18, scale: 4 }).notNull(),
    ...lineage,
  },
  (t) => [index("vesting_grant_idx").on(t.grantId)],
);

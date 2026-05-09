import {
  date,
  index,
  pgSchema,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { lineage } from "./core";

export const hr = pgSchema("hr");

export const orgUnit = hr.table(
  "org_unit",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    functionArea: varchar("function_area", { length: 32 }).notNull(),
    parentId: uuid("parent_id"),
    ...lineage,
  },
  (t) => [uniqueIndex("org_unit_source_uk").on(t.sourceSystem, t.sourceId)],
);

export const employment = hr.table(
  "employment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    employeeId: uuid("employee_id").notNull(),
    orgUnitId: uuid("org_unit_id").notNull(),
    title: text("title").notNull(),
    level: varchar("level", { length: 16 }),
    employmentType: varchar("employment_type", { length: 16 }).notNull(),
    startDate: date("start_date").notNull(),
    endDate: date("end_date"),
    ...lineage,
  },
  (t) => [
    index("employment_employee_idx").on(t.employeeId),
    index("employment_org_idx").on(t.orgUnitId),
  ],
);

export const managerEdge = hr.table(
  "manager_edge",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    managerId: uuid("manager_id").notNull(),
    reportId: uuid("report_id").notNull(),
    startDate: date("start_date").notNull(),
    endDate: date("end_date"),
    ...lineage,
  },
  (t) => [
    index("manager_edge_manager_idx").on(t.managerId),
    index("manager_edge_report_idx").on(t.reportId),
  ],
);

export const leave = hr.table(
  "leave",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    employeeId: uuid("employee_id").notNull(),
    leaveType: varchar("leave_type", { length: 32 }).notNull(),
    startDate: date("start_date").notNull(),
    endDate: date("end_date"),
    status: varchar("status", { length: 16 }).notNull(),
    ...lineage,
  },
  (t) => [index("leave_employee_idx").on(t.employeeId)],
);

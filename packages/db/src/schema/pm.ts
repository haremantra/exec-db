import { sql } from "drizzle-orm";
import {
  date,
  index,
  integer,
  pgSchema,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const pm = pgSchema("pm");

export const project = pm.table(
  "project",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description"),
    ownerId: uuid("owner_id").notNull(),
    status: varchar("status", { length: 16 }).notNull().default("active"),
    targetCompletionDate: date("target_completion_date"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [index("project_owner_idx").on(t.ownerId, t.status)],
);

export const task = pm.table(
  "task",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    ownerId: uuid("owner_id").notNull(),
    status: varchar("status", { length: 16 }).notNull().default("todo"),
    priority: smallint("priority").notNull().default(5),
    dueDate: date("due_date"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index("task_owner_idx").on(t.ownerId, t.status, t.dueDate),
    index("task_project_idx").on(t.projectId, t.status),
  ],
);

export const taskDependency = pm.table(
  "task_dependency",
  {
    taskId: uuid("task_id").notNull(),
    dependsOnTaskId: uuid("depends_on_task_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.dependsOnTaskId] })],
);

export const digestSend = pm.table(
  "digest_send",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    recipientId: uuid("recipient_id").notNull(),
    cadence: varchar("cadence", { length: 8 }).notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    taskCount: integer("task_count").notNull(),
    bodyMarkdown: text("body_markdown").notNull(),
    gmailMessageId: varchar("gmail_message_id", { length: 128 }),
  },
  (t) => [index("digest_recipient_idx").on(t.recipientId, t.sentAt)],
);

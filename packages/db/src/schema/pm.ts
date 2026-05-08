import { sql } from "drizzle-orm";
import {
  boolean,
  check,
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

/**
 * Task status taxonomy (K3 — US-019, W6.5).
 * `blocked`  = dependency on money or a specific human; there is a plan.
 * `stuck`    = outside the exec's expertise / bandwidth; no plan yet.
 * These are intentionally distinct so the Monday view can filter on each.
 *
 * Migration SQL:
 *   -- Status already exists as varchar(16); just add the CHECK constraint
 *   -- (existing rows with 'todo','in_progress','blocked','done' are valid).
 *   ALTER TABLE pm.task ADD CONSTRAINT task_status_chk
 *     CHECK (status IN ('todo','in_progress','blocked','stuck','done'));
 */
export const TASK_STATUS_VALUES = [
  "todo",
  "in_progress",
  "blocked",
  "stuck",
  "done",
] as const;

export type TaskStatus = (typeof TASK_STATUS_VALUES)[number];

/**
 * Impact taxonomy (K1 — US-021, W8.1).
 * Tags a task with its exec-relevance category so the Monday dashboard can
 * order swimlanes by what matters most.  NULL = impact not yet assessed.
 * Only exec_all tier can set or clear this tag.
 *
 * Migration SQL:
 *   ALTER TABLE pm.task ADD COLUMN impact varchar(16);
 *   ALTER TABLE pm.task ADD CONSTRAINT task_impact_chk
 *     CHECK (impact IS NULL OR impact IN
 *       ('revenue','reputation','both','neither'));
 */
export const IMPACT_VALUES = [
  "revenue",
  "reputation",
  "both",
  "neither",
] as const;

export type Impact = (typeof IMPACT_VALUES)[number];

/**
 * Project-type taxonomy (K4 — US-018, W6.1).
 * Tags a project with the exec's deal/initiative type so reports group
 * correctly.  NULL = type not yet assigned.
 * Only exec_all tier can set or clear this tag.
 *
 * Migration SQL:
 *   ALTER TABLE pm.project ADD COLUMN project_type varchar(16);
 *   ALTER TABLE pm.project ADD CONSTRAINT project_type_chk
 *     CHECK (project_type IS NULL OR project_type IN
 *       ('sales_call','licensing','hire','deal',
 *        'board_prep','okr','other'));
 */
export const PROJECT_TYPE_VALUES = [
  "sales_call",
  "licensing",
  "hire",
  "deal",
  "board_prep",
  "okr",
  "other",
] as const;

export type ProjectType = (typeof PROJECT_TYPE_VALUES)[number];

export const project = pm.table(
  "project",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description"),
    ownerId: uuid("owner_id").notNull(),
    status: varchar("status", { length: 16 }).notNull().default("active"),
    /**
     * Project-type tag (K4 — US-018, W6.1).
     * See PROJECT_TYPE_VALUES for the full taxonomy.
     * NULL means no type has been assigned.
     */
    projectType: varchar("project_type", { length: 16 }),
    targetCompletionDate: date("target_completion_date"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index("project_owner_idx").on(t.ownerId, t.status),
    // CHECK constraint mirrors PROJECT_TYPE_VALUES; keep in sync.
    check(
      "project_type_chk",
      sql`${t.projectType} IS NULL OR ${t.projectType} IN (
        'sales_call',
        'licensing',
        'hire',
        'deal',
        'board_prep',
        'okr',
        'other'
      )`,
    ),
  ],
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
    /**
     * Work-area tag (I3 — US-001, W1.1).
     * Groups the task by the exec's operational work area so the Monday
     * dashboard can render swimlanes by function.  NULL means untagged.
     *
     * Migration SQL:
     *   ALTER TABLE pm.task ADD COLUMN work_area varchar(32);
     *   ALTER TABLE pm.task ADD CONSTRAINT task_work_area_chk
     *     CHECK (work_area IS NULL OR work_area IN
     *       ('prospecting','customer','investor','contractor',
     *        'board','thought_leadership','admin'));
     */
    workArea: varchar("work_area", { length: 32 }),
    /**
     * Impact tag (K1 — US-021, W8.1).
     * See IMPACT_VALUES for the full taxonomy.
     * NULL means impact has not yet been assessed.
     */
    impact: varchar("impact", { length: 16 }),
    /**
     * Pinned flag (K2 — US-004, W1.5).
     * Pinned tasks survive weekly resets and always appear at the top of
     * the relevant swimlane in the Monday dashboard.
     *
     * CONTRACT (enforced by dashboard Stream L):
     *   Dashboard reads `is_pinned AND status != 'done'` for sticky-top
     *   behavior.  Setting status=done does NOT clear is_pinned — the exec
     *   must explicitly unpin, which lets them track "always-present" tasks
     *   like "prospecting curation" and "thought-leadership drafts."
     */
    isPinned: boolean("is_pinned").notNull().default(false),
    /**
     * Awaiting-response deadline (R2 — SY-010, US-020).
     * When set and the date passes without a reply, the task is auto-flagged
     * "Needs check-in" by Stream R.  Added here so all streams (L, M, N, R)
     * can read it consistently without waiting for Stream R to land.
     *
     * Migration SQL:
     *   ALTER TABLE pm.task ADD COLUMN awaiting_response_until timestamptz;
     */
    awaitingResponseUntil: timestamp("awaiting_response_until", {
      withTimezone: true,
    }),
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
    index("task_pinned_idx").on(t.ownerId, t.isPinned),
    // CHECK constraint mirrors WORK_AREA_VALUES in crm.ts; keep in sync.
    check(
      "task_work_area_chk",
      sql`${t.workArea} IS NULL OR ${t.workArea} IN (
        'prospecting',
        'customer',
        'investor',
        'contractor',
        'board',
        'thought_leadership',
        'admin'
      )`,
    ),
    // CHECK constraint mirrors IMPACT_VALUES; keep in sync.
    check(
      "task_impact_chk",
      sql`${t.impact} IS NULL OR ${t.impact} IN (
        'revenue',
        'reputation',
        'both',
        'neither'
      )`,
    ),
    // CHECK constraint mirrors TASK_STATUS_VALUES; keep in sync.
    check(
      "task_status_chk",
      sql`${t.status} IN (
        'todo',
        'in_progress',
        'blocked',
        'stuck',
        'done'
      )`,
    ),
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

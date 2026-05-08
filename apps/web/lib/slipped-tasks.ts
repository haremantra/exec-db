/**
 * slipped-tasks.ts — Slipped-task resurfacing (PR3-N, N2).
 *
 * A task is "slipped" when:
 *   - overdue: due_date < current_date AND status NOT IN ('done'), OR
 *   - response_overdue: awaiting_response_until < now() AND status NOT IN ('done').
 *
 * For each slipped task, optionally attaches an unblockHint if a recent
 * crm.email_thread subject contains a substring of the task title (>=6 chars,
 * case-insensitive). This is a pure SQL ILIKE — no LLM.
 *
 * SY-009 / SY-010 / W6.3 / W6.4 / US-020
 * Pure SQL through query() so RLS applies automatically.
 */

import { query } from "@/lib/db";
import type { Session } from "@/lib/rbac";

export type SlippedReason = "overdue" | "response_overdue";

export interface UnblockHint {
  threadId: string;
  subject: string;
}

export interface SlippedTask {
  taskId: string;
  title: string;
  projectId: string;
  dueDate: string | null;
  awaitingResponseUntil: Date | null;
  slippedReason: SlippedReason;
  /** Present when a recent email thread subject matches the task title. */
  unblockHint?: UnblockHint;
}

/**
 * Returns all slipped tasks for the session user.
 *
 * - "Needs check-in" badge logic: when awaitingResponseUntil < now(), the
 *   UI should display a "Needs check-in" badge. The task status is NOT
 *   changed; only the display layer shows the badge (slippedReason = "response_overdue").
 *
 * - Hint detection: uses SQL ILIKE with the first ≥6 characters of the task
 *   title as a pattern against recent email thread subjects.
 */
export async function getSlippedTasks(session: Session): Promise<SlippedTask[]> {
  const ctx = {
    userId: session.userId,
    tier: session.tier,
    functionArea: session.functionArea,
  };

  const rows = await query(ctx, async (tx) => {
    const { sql } = await import("drizzle-orm");

    return (tx as unknown as { execute: (q: unknown) => Promise<{ rows: Array<Record<string, unknown>> } | Array<Record<string, unknown>>> }).execute(
      sql`
        WITH slipped AS (
          SELECT
            t.id             AS task_id,
            t.title,
            t.project_id,
            t.due_date,
            t.awaiting_response_until,
            CASE
              WHEN t.due_date IS NOT NULL
                AND t.due_date::date < current_date THEN 'overdue'
              ELSE 'response_overdue'
            END AS slipped_reason
          FROM pm.task t
          WHERE t.owner_id = ${session.userId}::uuid
            AND t.status NOT IN ('done')
            AND (
              (t.due_date IS NOT NULL AND t.due_date::date < current_date)
              OR
              (t.awaiting_response_until IS NOT NULL AND t.awaiting_response_until < now())
            )
        ),
        hints AS (
          -- For each slipped task, find the most-recent email thread whose
          -- subject ILIKE the first 6+ chars of the task title.
          -- We use SUBSTRING to cap the pattern length for safety.
          SELECT DISTINCT ON (s.task_id)
            s.task_id,
            et.id      AS thread_id,
            et.subject AS thread_subject
          FROM slipped s
          JOIN crm.email_thread et
            ON length(s.title) >= 6
            AND et.subject ILIKE '%' || substring(s.title, 1, greatest(6, length(s.title))) || '%'
          ORDER BY s.task_id, et.last_message_at DESC NULLS LAST
        )
        SELECT
          s.task_id,
          s.title,
          s.project_id,
          s.due_date::text                        AS due_date,
          s.awaiting_response_until,
          s.slipped_reason,
          h.thread_id                             AS hint_thread_id,
          h.thread_subject                        AS hint_subject
        FROM slipped s
        LEFT JOIN hints h ON h.task_id = s.task_id
        ORDER BY s.due_date NULLS LAST, s.awaiting_response_until NULLS LAST
      `,
    );
  }).then((result) => {
    if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
    const r = result as { rows: Array<Record<string, unknown>> };
    return r.rows ?? [];
  });

  return rows.map((row) => {
    const task: SlippedTask = {
      taskId: String(row["task_id"]),
      title: String(row["title"]),
      projectId: String(row["project_id"]),
      dueDate: row["due_date"] != null ? String(row["due_date"]) : null,
      awaitingResponseUntil: row["awaiting_response_until"] != null
        ? row["awaiting_response_until"] instanceof Date
          ? row["awaiting_response_until"]
          : new Date(String(row["awaiting_response_until"]))
        : null,
      slippedReason: String(row["slipped_reason"]) === "overdue" ? "overdue" : "response_overdue",
    };

    if (row["hint_thread_id"] != null && row["hint_subject"] != null) {
      task.unblockHint = {
        threadId: String(row["hint_thread_id"]),
        subject: String(row["hint_subject"]),
      };
    }

    return task;
  });
}

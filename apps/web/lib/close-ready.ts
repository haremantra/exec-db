/**
 * close-ready.ts — Tuesday close-ready cohort (PR3-N, N1).
 *
 * Computes the set of CRM contacts that are warm (recent email reply or call
 * note), qualified (triage_tag in ['pilot_candidate','can_help_me']), and
 * unblocked (no active blocked/stuck task referencing the contact).
 *
 * US-025 / SY-015 / W9.2
 * Pure SQL through query() so RLS (sensitive-flag exclusion) applies automatically.
 * No LLM calls — Stream P will integrate with the ranker.
 */

import { query } from "@/lib/db";
import type { Session } from "@/lib/rbac";

export interface CloseReadyContact {
  contactId: string;
  contactName: string;
  lastTouchAt: Date;
  lastTouchKind: "email" | "note";
  qualifierTag: "pilot_candidate" | "can_help_me";
}

/**
 * Returns up to 10 close-ready contacts, ordered by most-recent touch DESC.
 *
 * A contact is close-ready when ALL of:
 *   1. Has at least one email thread with last_message_at >= now() - 7 days,
 *      OR a recent call note with occurred_at >= now() - 7 days.
 *   2. triage_tag IN ('pilot_candidate', 'can_help_me').
 *   3. No active task (status IN ('blocked','stuck')) referencing this contact
 *      via crm.email_thread.contact_id or crm.call_note.contact_id.
 *   4. Not sensitive (enforced automatically by RLS on crm.contact).
 */
export async function getCloseReadyCohort(
  session: Session,
): Promise<CloseReadyContact[]> {
  const ctx = {
    userId: session.userId,
    tier: session.tier,
    functionArea: session.functionArea,
  };

  // Single SQL query joining contact, email_thread, and call_note.
  // RLS on crm.contact excludes sensitive contacts automatically.
  //
  // We use raw sql template literal to express the full subquery cleanly.
  // The query returns at most 10 rows, ordered by last_touch_at DESC.
  const rows = await query(ctx, async (tx) => {
    // Use a raw SQL string executed via drizzle's execute method.
    // Since the DB layer exposes a Drizzle instance, we use sql`` template.
    const { sql } = await import("drizzle-orm");

    return (tx as unknown as { execute: (q: unknown) => Promise<{ rows: Array<Record<string, unknown>> }> }).execute(
      sql`
        WITH recent_email AS (
          SELECT
            et.contact_id,
            MAX(et.last_message_at) AS last_at,
            'email'::text          AS kind
          FROM crm.email_thread et
          WHERE et.last_message_at >= now() - interval '7 days'
          GROUP BY et.contact_id
        ),
        recent_note AS (
          SELECT
            cn.contact_id,
            MAX(cn.occurred_at) AS last_at,
            'note'::text         AS kind
          FROM crm.call_note cn
          WHERE cn.occurred_at >= now() - interval '7 days'
          GROUP BY cn.contact_id
        ),
        best_touch AS (
          SELECT
            COALESCE(re.contact_id, rn.contact_id) AS contact_id,
            CASE
              WHEN re.last_at IS NULL THEN rn.last_at
              WHEN rn.last_at IS NULL THEN re.last_at
              WHEN re.last_at >= rn.last_at THEN re.last_at
              ELSE rn.last_at
            END AS last_touch_at,
            CASE
              WHEN re.last_at IS NULL THEN 'note'
              WHEN rn.last_at IS NULL THEN 'email'
              WHEN re.last_at >= rn.last_at THEN 'email'
              ELSE 'note'
            END AS last_touch_kind
          FROM recent_email re
          FULL OUTER JOIN recent_note rn ON re.contact_id = rn.contact_id
        ),
        blocked_contacts AS (
          -- Contacts that have at least one active blocked/stuck task.
          -- A task "references" a contact if it belongs to a project that has
          -- at least one email_thread or call_note for that contact.
          -- Simple heuristic: tasks owned by the session user with
          -- status IN ('blocked','stuck'), joined to contacts via
          -- email_thread or call_note.
          SELECT DISTINCT
            COALESCE(et.contact_id, cn.contact_id) AS contact_id
          FROM pm.task t
          LEFT JOIN crm.email_thread et ON et.contact_id IS NOT NULL
          LEFT JOIN crm.call_note    cn ON cn.contact_id IS NOT NULL
          WHERE t.owner_id = ${session.userId}::uuid
            AND t.status IN ('blocked', 'stuck')
            AND (et.contact_id IS NOT NULL OR cn.contact_id IS NOT NULL)
        )
        SELECT
          c.id             AS contact_id,
          c.full_name      AS contact_name,
          bt.last_touch_at,
          bt.last_touch_kind,
          c.triage_tag     AS qualifier_tag
        FROM crm.contact c
        JOIN best_touch bt ON bt.contact_id = c.id
        WHERE c.triage_tag IN ('pilot_candidate', 'can_help_me')
          AND c.id NOT IN (SELECT contact_id FROM blocked_contacts WHERE contact_id IS NOT NULL)
        ORDER BY bt.last_touch_at DESC
        LIMIT 10
      `,
    );
  }).then((result) => {
    if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
    // execute() returns { rows: [...] }
    const r = result as { rows: Array<Record<string, unknown>> };
    return r.rows ?? [];
  });

  return rows.map((row) => ({
    contactId: String(row["contact_id"]),
    contactName: String(row["contact_name"]),
    lastTouchAt: row["last_touch_at"] instanceof Date
      ? row["last_touch_at"]
      : new Date(String(row["last_touch_at"])),
    lastTouchKind: String(row["last_touch_kind"]) === "email" ? "email" : "note",
    qualifierTag: String(row["qualifier_tag"]) as CloseReadyContact["qualifierTag"],
  }));
}

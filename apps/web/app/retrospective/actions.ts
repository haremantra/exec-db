"use server";

import { eq, sql } from "drizzle-orm";
import { schema } from "@exec-db/db";
import { getSession } from "@/lib/auth";
import { query } from "@/lib/db";
import { recordAccess } from "@/lib/audit";

/**
 * Valid retrospective judgement values.
 * Kept here so UI and tests can import from one place.
 */
export const RETROSPECTIVE_JUDGEMENT_VALUES = [
  "kept_promise",
  "partial",
  "broke_promise",
] as const;

export type RetrospectiveJudgement =
  (typeof RETROSPECTIVE_JUDGEMENT_VALUES)[number];

/**
 * recordRetrospectiveJudgement — R1 (US-022, W8.4).
 *
 * Writes the exec's per-task promise-kept rating to audit.access_log so that
 * future ranking training can weight tasks by their historical delivery rate.
 *
 * The action is bound to a specific taskId via `.bind(null, taskId)` before
 * being passed to a <form action>. The `judgement` value is read from the
 * submitted FormData (radio input named "judgement").
 *
 * Ownership guard: verifies the task belongs to the authenticated user and
 * has status='done' before writing the audit row. Throws if not found.
 *
 * TODO(ranker-training): Feed these rows into the counterfactual ranker
 *   (Stream M) as a signal: tasks whose owners consistently "broke_promise"
 *   should receive a trust-adjusted priority penalty.  When that training
 *   pipeline exists, query audit.access_log WHERE intent='retrospective_judgement'
 *   and join on metadata->>'taskId'.
 *
 * @param taskId   - UUID of the completed pm.task row being judged (bound via .bind).
 * @param formData - Submitted form data; must contain a "judgement" field set to
 *                   one of RETROSPECTIVE_JUDGEMENT_VALUES.
 */
export async function recordRetrospectiveJudgement(
  taskId: string,
  formData: FormData,
): Promise<void> {
  const judgement = String(formData.get("judgement") ?? "").trim();

  // Validate judgement value before any DB work.
  if (
    !(RETROSPECTIVE_JUDGEMENT_VALUES as readonly string[]).includes(judgement)
  ) {
    throw new Error(
      `Invalid judgement value: "${judgement}". ` +
        `Must be one of: ${RETROSPECTIVE_JUDGEMENT_VALUES.join(", ")}.`,
    );
  }

  const session = await getSession();
  if (!session) throw new Error("Sign in required");

  const typedJudgement = judgement as RetrospectiveJudgement;

  await query(
    { userId: session.userId, tier: session.tier, functionArea: session.functionArea },
    async (tx) => {
      // Ownership guard: verify the task belongs to the authenticated user
      // and has status='done' before writing the audit row.
      const ownershipCheck = await tx
        .select({ id: schema.task.id })
        .from(schema.task)
        .where(
          sql`${schema.task.id} = ${taskId}
              AND ${schema.task.ownerId} = ${session.userId}
              AND ${schema.task.status} = 'done'`,
        );

      if (ownershipCheck.length === 0) {
        throw new Error(
          `Task ${taskId} not found, not owned by current user, or not completed.`,
        );
      }

      await recordAccess(tx, session, {
        schemaName: "pm",
        tableName: "task",
        action: "UPDATE",
        intent: "retrospective_judgement",
        metadata: { taskId, judgement: typedJudgement },
      });
    },
  );
}

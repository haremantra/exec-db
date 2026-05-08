"use server";

import { schema } from "@exec-db/db";
import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getSession } from "@/lib/auth";
import { query } from "@/lib/db";

/**
 * Invite an assistant (Chief-of-Staff / EA) to read the exec's CRM/PM data.
 *
 * Only exec_all tier may call this action. The assistant is identified by
 * their work email, which is resolved against core.employee_dim. If no
 * matching employee is found, the action throws an error.
 *
 * Creates a crm.assistant_grant row (AD-002 / US-023 / PR2-H).
 *
 * @param formData - must contain an `email` field.
 */
export async function inviteAssistant(formData: FormData): Promise<void> {
  const session = await getSession();
  if (!session || session.tier !== "exec_all") {
    throw new Error("Forbidden: inviteAssistant requires exec_all tier");
  }

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!email) {
    throw new Error("email is required");
  }

  await query(
    { userId: session.userId, tier: session.tier, functionArea: session.functionArea },
    async (tx) => {
      // Resolve the email to a core.employee_dim row.
      const [employee] = await tx
        .select({ id: schema.employeeDim.id })
        .from(schema.employeeDim)
        .where(eq(schema.employeeDim.workEmail, email))
        .limit(1);

      if (!employee) {
        throw new Error(`No employee found with email: ${email}`);
      }

      // Insert the grant row. The unique index
      // (exec_user_id, assistant_user_id) WHERE revoked_at IS NULL
      // prevents duplicate active grants.
      await tx.insert(schema.assistantGrant).values({
        execUserId: session.userId,
        assistantUserId: employee.id,
      });
    },
  );

  revalidatePath("/settings/assistants");
}

/**
 * Revoke an active assistant grant.
 *
 * Only exec_all tier may call this action, and only for grants they own.
 * Sets revoked_at = now() so the grant becomes inactive.
 *
 * @param grantId - UUID of the crm.assistant_grant row to revoke.
 */
export async function revokeAssistant(grantId: string): Promise<void> {
  const session = await getSession();
  if (!session || session.tier !== "exec_all") {
    throw new Error("Forbidden: revokeAssistant requires exec_all tier");
  }

  await query(
    { userId: session.userId, tier: session.tier, functionArea: session.functionArea },
    async (tx) => {
      await tx
        .update(schema.assistantGrant)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(schema.assistantGrant.id, grantId),
            // Ensure the exec can only revoke their own grants.
            eq(schema.assistantGrant.execUserId, session.userId),
            // Only revoke active (non-revoked) grants.
            isNull(schema.assistantGrant.revokedAt),
          ),
        );
    },
  );

  revalidatePath("/settings/assistants");
}

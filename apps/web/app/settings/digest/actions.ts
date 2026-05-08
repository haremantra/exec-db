"use server";

/**
 * Digest settings server actions (PR3-O / S5.2).
 *
 * setDigestOptin — upserts the crm.user_pref row for the current user with
 * the new daily/weekly opt-in values from the settings form.
 */

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { schema } from "@exec-db/db";
import { getSession } from "@/lib/auth";
import { query } from "@/lib/db";
import crypto from "node:crypto";

/**
 * Save digest opt-in preferences for the signed-in user.
 *
 * FormData fields:
 *   daily  — "on" if the daily digest checkbox is checked, absent otherwise.
 *   weekly — "on" if the weekly digest checkbox is checked, absent otherwise.
 */
export async function setDigestOptin(formData: FormData): Promise<void> {
  const session = await getSession();
  if (!session) {
    throw new Error("setDigestOptin: authentication required");
  }

  const dailyOptin = formData.get("daily") === "on";
  const weeklyOptin = formData.get("weekly") === "on";

  await query(
    {
      userId: session.userId,
      tier: session.tier,
      functionArea: session.functionArea,
    },
    async (tx) => {
      // Check if a preference row already exists for this user.
      const existing = await tx
        .select({ userId: schema.userPref.userId })
        .from(schema.userPref)
        .where(eq(schema.userPref.userId, session.userId))
        .limit(1);

      if (existing.length > 0) {
        // Update existing row.
        await tx
          .update(schema.userPref)
          .set({
            digestDailyOptin: dailyOptin,
            digestWeeklyOptin: weeklyOptin,
            updatedAt: new Date(),
          })
          .where(eq(schema.userPref.userId, session.userId));
      } else {
        // Insert new row with a freshly-generated unsubscribe token.
        const unsubscribeToken = crypto.randomBytes(32).toString("hex");
        await tx.insert(schema.userPref).values({
          userId: session.userId,
          digestDailyOptin: dailyOptin,
          digestWeeklyOptin: weeklyOptin,
          unsubscribeToken,
        });
      }
    },
  );

  revalidatePath("/settings/digest");
}

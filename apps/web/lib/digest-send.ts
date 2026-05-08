/**
 * digest-send.ts — Digest send worker (PR3-O).
 *
 * Export: sendDigest(userId, cadence) — orchestrates pref check, body
 * assembly, Resend delivery, and pm.digest_send insert.
 *
 * Required env vars (inherited from callers):
 *   DATABASE_URL_APP / DATABASE_URL — Postgres connection.
 *   RESEND_API_KEY                  — Resend API key.
 *   RESEND_FROM_ADDRESS             — Sender (optional).
 *   NEXT_PUBLIC_APP_URL             — Base URL for unsubscribe links.
 */

import { and, eq } from "drizzle-orm";
import { schema } from "@exec-db/db";
import { query } from "@/lib/db";
import { assembleDigestBody } from "@/lib/digest-body";
import { sendEmailViaResend } from "@/lib/email-resend";

export interface SendDigestResult {
  delivered: boolean;
  reason?: string;
}

/**
 * Send a digest email to `userId` for the given `cadence`.
 *
 * Steps:
 *  1. Read crm.user_pref; skip if not opted in.
 *  2. Look up work_email from core.employee_dim.
 *  3. Assemble the digest body (deterministic stub — Stream P adds ranking).
 *  4. Send via Resend.
 *  5. Insert a pm.digest_send row.
 *
 * Returns { delivered: false, reason } for skips (not opted in, no email found).
 * Throws on Resend delivery failure so the cron handler can record errors.
 */
export async function sendDigest(
  userId: string,
  cadence: "daily" | "weekly",
): Promise<SendDigestResult> {
  // ── Step 1: read user preferences ─────────────────────────────────────────
  const prefs = await query(
    { userId, tier: "exec_all", functionArea: null },
    async (tx) =>
      tx
        .select({
          digestDailyOptin: schema.userPref.digestDailyOptin,
          digestWeeklyOptin: schema.userPref.digestWeeklyOptin,
          unsubscribeToken: schema.userPref.unsubscribeToken,
        })
        .from(schema.userPref)
        .where(eq(schema.userPref.userId, userId))
        .limit(1),
  );

  if (prefs.length === 0) {
    return { delivered: false, reason: "not_opted_in" };
  }

  const pref = prefs[0]!;
  const optedIn =
    cadence === "daily" ? pref.digestDailyOptin : pref.digestWeeklyOptin;

  if (!optedIn) {
    return { delivered: false, reason: "not_opted_in" };
  }

  // ── Step 2: resolve work email ─────────────────────────────────────────────
  const employees = await query(
    { userId, tier: "exec_all", functionArea: null },
    async (tx) =>
      tx
        .select({ workEmail: schema.employeeDim.workEmail })
        .from(schema.employeeDim)
        .where(eq(schema.employeeDim.id, userId))
        .limit(1),
  );

  if (employees.length === 0 || !employees[0]?.workEmail) {
    return { delivered: false, reason: "no_email_on_record" };
  }

  const toEmail = employees[0].workEmail;

  // ── Step 3: assemble body ──────────────────────────────────────────────────
  const { subject, html, text, taskCount } = await assembleDigestBody(
    userId,
    cadence,
    pref.unsubscribeToken,
  );

  // ── Step 4: send via Resend ────────────────────────────────────────────────
  // Throws on failure — let cron handler capture and report.
  const { messageId } = await sendEmailViaResend({
    to: toEmail,
    subject,
    html,
    text,
  });

  // ── Step 5: record pm.digest_send ─────────────────────────────────────────
  await query(
    { userId, tier: "exec_all", functionArea: null },
    async (tx) =>
      tx.insert(schema.digestSend).values({
        recipientId: userId,
        cadence,
        taskCount,
        bodyMarkdown: text,
        gmailMessageId: messageId,
      }),
  );

  return { delivered: true };
}

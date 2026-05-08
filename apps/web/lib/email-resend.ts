/**
 * email-resend.ts — Resend email sender (S5.1 / PR3-O).
 *
 * This module is the single point of contact for transactional email delivery.
 * We use Resend (not Gmail send) to keep digest delivery separate from the
 * user's Gmail OAuth scope (S6.5, AD-004: no gmail.users.messages.send).
 *
 * Required env vars:
 *   RESEND_API_KEY          — Resend API key (required at runtime).
 *   RESEND_FROM_ADDRESS     — Sender address (optional; defaults to noreply@exec-db.local).
 */

import { Resend } from "resend";

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface SendEmailResult {
  messageId: string;
}

/**
 * Send a transactional email via Resend.
 *
 * Throws with a descriptive message on delivery failure so the caller
 * (digest worker) can decide whether to retry or record the failure.
 *
 * @throws {Error} if RESEND_API_KEY is absent or if Resend returns an error.
 */
export async function sendEmailViaResend(
  input: SendEmailInput,
): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error(
      "sendEmailViaResend: RESEND_API_KEY env var is required but not set",
    );
  }

  const from =
    process.env.RESEND_FROM_ADDRESS ?? "noreply@exec-db.local";

  const client = new Resend(apiKey);

  const { data, error } = await client.emails.send({
    from,
    to: input.to,
    subject: input.subject,
    html: input.html,
    text: input.text,
  });

  if (error || !data) {
    throw new Error(
      `sendEmailViaResend: Resend delivery failed — ${error?.message ?? "no data returned"}`,
    );
  }

  return { messageId: data.id };
}

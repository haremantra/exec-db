/**
 * /api/cron/digest-weekly — Vercel Cron endpoint for weekly digest (PR3-O).
 *
 * Schedule: "0 14 * * 0" (14:00 UTC Sundays = 7:00 am America/Los_Angeles PDT).
 * See apps/web/vercel.json for the cron schedule declaration.
 *
 * Auth: Vercel Cron sends `Authorization: Bearer ${CRON_SECRET}` on every
 * invocation. We reject anything without that header to prevent unauthorized
 * triggering.
 *
 * Required env vars:
 *   CRON_SECRET        — shared secret Vercel sets automatically.
 *   DATABASE_URL_APP   — Postgres connection.
 *   RESEND_API_KEY     — Resend delivery key.
 */

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { schema } from "@exec-db/db";
import { query } from "@/lib/db";
import { sendDigest } from "@/lib/digest-send";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  // ── Auth: require Bearer CRON_SECRET ─────────────────────────────────────
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ── Fetch all users opted into weekly digest ───────────────────────────────
  const SYSTEM_USER = "00000000-0000-0000-0000-000000000000";
  const optedInUsers = await query(
    { userId: SYSTEM_USER, tier: "exec_all", functionArea: null },
    async (tx) =>
      tx
        .select({ userId: schema.userPref.userId })
        .from(schema.userPref)
        .where(eq(schema.userPref.digestWeeklyOptin, true)),
  );

  // ── Send digest to each opted-in user ─────────────────────────────────────
  let delivered = 0;
  let skipped = 0;
  const errors: Array<{ userId: string; error: string }> = [];

  for (const { userId } of optedInUsers) {
    try {
      const result = await sendDigest(userId, "weekly");
      if (result.delivered) {
        delivered++;
      } else {
        skipped++;
      }
    } catch (err) {
      errors.push({
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return NextResponse.json({
    cadence: "weekly",
    users: optedInUsers.length,
    delivered,
    skipped,
    errors,
  });
}

/**
 * /api/digest/unsubscribe — One-click unsubscribe endpoint (PR3-O / S5.7).
 *
 * GET /api/digest/unsubscribe?token=<unsubscribe_token>
 *
 * Looks up the crm.user_pref row by unsubscribe_token.
 * Sets digest_daily_optin = false AND digest_weekly_optin = false.
 * Returns a plain HTML confirmation page — no login required.
 *
 * Security note: the token is a 64-hex-char random value (32 random bytes),
 * providing ~128 bits of entropy. Guessing is not feasible. Tokens are
 * never reused; a new token can be issued by cycling the preference row.
 */

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { schema } from "@exec-db/db";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

// Minimal inline HTML — no templating dependency needed for this page.
const UNSUBSCRIBED_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Unsubscribed — exec-db</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           color: #111; max-width: 480px; margin: 4rem auto; padding: 1.5rem; }
    h1   { font-size: 1.25rem; }
    p    { color: #6b7280; }
    a    { color: #3b82f6; }
  </style>
</head>
<body>
  <h1>You've been unsubscribed.</h1>
  <p>You will no longer receive daily or weekly digest emails from exec-db.</p>
  <p>You can re-enable digests at any time from
     <a href="/settings/digest">Settings → Digest</a>.</p>
</body>
</html>`;

const NOT_FOUND_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>Link not found — exec-db</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           color: #111; max-width: 480px; margin: 4rem auto; padding: 1.5rem; }
    h1   { font-size: 1.25rem; }
    p    { color: #6b7280; }
  </style>
</head>
<body>
  <h1>Unsubscribe link not found.</h1>
  <p>This link may have already been used or has expired.
     If you still receive emails, sign in and visit
     <a href="/settings/digest">Settings → Digest</a>.</p>
</body>
</html>`;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const token = req.nextUrl.searchParams.get("token");

  if (!token) {
    return new NextResponse(NOT_FOUND_HTML, {
      status: 400,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // System-level query — no user session required for unsubscribe.
  const SYSTEM_USER = "00000000-0000-0000-0000-000000000000";

  try {
    const rows = await query(
      { userId: SYSTEM_USER, tier: "exec_all", functionArea: null },
      async (tx) =>
        tx
          .select({ userId: schema.userPref.userId })
          .from(schema.userPref)
          .where(eq(schema.userPref.unsubscribeToken, token))
          .limit(1),
    );

    if (rows.length === 0) {
      return new NextResponse(NOT_FOUND_HTML, {
        status: 404,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    const { userId } = rows[0]!;

    await query(
      { userId: SYSTEM_USER, tier: "exec_all", functionArea: null },
      async (tx) =>
        tx
          .update(schema.userPref)
          .set({
            digestDailyOptin: false,
            digestWeeklyOptin: false,
            updatedAt: new Date(),
          })
          .where(eq(schema.userPref.userId, userId)),
    );

    return new NextResponse(UNSUBSCRIBED_HTML, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  } catch (_err) {
    // On DB error, return a generic failure without leaking internals.
    return new NextResponse(NOT_FOUND_HTML, {
      status: 500,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
}

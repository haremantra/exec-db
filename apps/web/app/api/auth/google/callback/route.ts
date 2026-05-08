/**
 * GET /api/auth/google/callback
 *
 * Handles the OAuth2 callback from Google. Validates the CSRF state token,
 * exchanges the authorization code for tokens, fetches the user's email,
 * and upserts the encrypted token row in crm.oauth_token.
 *
 * Required env vars:
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 *   GOOGLE_OAUTH_REDIRECT_URI
 *   GOOGLE_TOKEN_ENC_KEY  — used by pgp_sym_encrypt inside the DB
 *   DATABASE_URL_APP (or DATABASE_URL)
 */
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { upsertOauthToken } from "@/lib/google";

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");

    if (error) {
      console.error(`[google-oauth-callback] Google returned error: ${error}`);
      return NextResponse.redirect(new URL("/settings?google_error=access_denied", req.url));
    }

    if (!code || !state) {
      return NextResponse.json({ error: "Missing code or state" }, { status: 400 });
    }

    // CSRF: validate state matches cookie
    const cookieStore = await cookies();
    const savedState = cookieStore.get("google_oauth_state")?.value;

    if (!savedState || savedState !== state) {
      console.error("[google-oauth-callback] State token mismatch — possible CSRF attempt");
      return NextResponse.json({ error: "Invalid state token" }, { status: 400 });
    }

    // Clear the state cookie immediately
    cookieStore.delete("google_oauth_state");

    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;

    if (!clientId || !clientSecret || !redirectUri) {
      console.error("[google-oauth-callback] Missing Google OAuth env vars");
      return NextResponse.json(
        { error: "Google OAuth not configured" },
        { status: 503 },
      );
    }

    await upsertOauthToken({
      userId: session.userId,
      code,
      clientId,
      clientSecret,
      redirectUri,
    });

    return NextResponse.redirect(new URL("/settings?google_connected=1", req.url));
  } catch (err) {
    console.error("[google-oauth-callback] Unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

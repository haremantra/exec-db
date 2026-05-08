/**
 * GET /api/auth/google
 *
 * Initiates the Google OAuth2 flow. Generates a random state token for CSRF
 * protection, stores it in a secure httpOnly cookie, and redirects the browser
 * to Google's authorization endpoint.
 *
 * Required env vars:
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_OAUTH_REDIRECT_URI
 */
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { buildGoogleAuthUrl, generateStateToken } from "@/lib/google";

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "openid",
  "email",
];

export async function GET(): Promise<NextResponse> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    console.error(
      "[google-oauth] Missing GOOGLE_CLIENT_ID or GOOGLE_OAUTH_REDIRECT_URI",
    );
    return NextResponse.json(
      { error: "Google OAuth not configured. See docs/pr2-prereqs-runbook.md." },
      { status: 503 },
    );
  }

  const state = generateStateToken();
  const authUrl = buildGoogleAuthUrl({ clientId, redirectUri, scopes: SCOPES, state });

  const cookieStore = await cookies();
  cookieStore.set("google_oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 10, // 10 minutes
    path: "/",
  });

  return NextResponse.redirect(authUrl);
}

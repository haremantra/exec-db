import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Middleware — Clerk auth + security headers.
 *
 * Public routes bypass Clerk's authentication check:
 *   - /api/auth/google/*      — Google OAuth callback; has its own token-based auth.
 *   - /api/cron/*             — Vercel Cron; authenticated via Bearer CRON_SECRET.
 *   - /api/digest/unsubscribe — Token-based unsubscribe; no login required.
 *   - /api/intake/email       — Authenticated via X-Intake-Secret header.
 *   - /sign-in and /sign-up   — Clerk's own catch-all pages.
 *
 * All other routes require a valid Clerk session. Unauthenticated requests are
 * automatically redirected to NEXT_PUBLIC_CLERK_SIGN_IN_URL (/sign-in).
 *
 * Security headers are applied to every response regardless of auth state.
 */

const isPublicRoute = createRouteMatcher([
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/api/auth/google(.*)",
  "/api/cron(.*)",
  "/api/digest/unsubscribe(.*)",
  "/api/intake/email(.*)",
  "/api/health(.*)",
]);

function applySecurityHeaders(response: NextResponse): NextResponse {
  response.headers.set("x-frame-options", "DENY");
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("referrer-policy", "strict-origin-when-cross-origin");
  response.headers.set("permissions-policy", "geolocation=(), microphone=(), camera=()");

  if (process.env.NODE_ENV === "production") {
    response.headers.set(
      "strict-transport-security",
      "max-age=63072000; includeSubDomains; preload",
    );
  }

  return response;
}

// When AUTH_PROVIDER=stub (local dev only), skip Clerk entirely and just apply
// security headers. This preserves the local dev workflow.
const provider = process.env.AUTH_PROVIDER ?? "clerk";

export default provider === "stub"
  ? function stubMiddleware(_req: NextRequest): NextResponse {
      return applySecurityHeaders(NextResponse.next());
    }
  : clerkMiddleware(async (auth, req) => {
      if (!isPublicRoute(req)) {
        await auth.protect();
      }
      return applySecurityHeaders(NextResponse.next());
    });

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

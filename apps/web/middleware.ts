import { NextResponse, type NextRequest } from "next/server";

/**
 * Phase 0: enforce HTTPS in prod, set strict security headers, and short-circuit
 * unauthenticated traffic to /login (not yet implemented). When auth is wired,
 * this is also where you bounce non-SSO sessions and refresh tokens.
 */
export function middleware(req: NextRequest): NextResponse {
  const res = NextResponse.next();

  res.headers.set("x-frame-options", "DENY");
  res.headers.set("x-content-type-options", "nosniff");
  res.headers.set("referrer-policy", "strict-origin-when-cross-origin");
  res.headers.set("permissions-policy", "geolocation=(), microphone=(), camera=()");

  if (process.env.NODE_ENV === "production") {
    res.headers.set("strict-transport-security", "max-age=63072000; includeSubDomains; preload");
  }

  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/health).*)"],
};

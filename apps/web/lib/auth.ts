import type { ExecTier, FunctionArea, Session } from "./rbac";

/**
 * getSession() — resolves the current user's session.
 *
 * Production / staging (AUTH_PROVIDER=clerk):
 *   1. Calls Clerk's auth() to get the Clerk user ID.
 *   2. Looks up crm.user_link for the matching employee_dim row + tier.
 *   3. Returns null if Clerk reports unauthenticated OR if no user_link row exists.
 *      (The latter means the user must be provisioned by an admin before they can use the app.)
 *
 * Local dev / tests (AUTH_PROVIDER=stub, NODE_ENV !== production):
 *   Falls back to the Phase-0 stub (reads from headers/cookies, defaults to a
 *   hard-coded dev UUID). This preserves local-dev and test workflows without
 *   requiring Clerk credentials.
 *
 * The public signature — `getSession(): Promise<Session | null>` — is unchanged.
 * Every server action that calls getSession() continues to work without modification.
 */

// ---------------------------------------------------------------------------
// Shared helpers (used by both branches)
// ---------------------------------------------------------------------------

const TIERS = new Set<ExecTier>(["exec_all", "function_lead", "manager", "employee", "assistant"]);
const FUNCTIONS = new Set<FunctionArea>([
  "eng", "sales", "gtm", "ops", "finance", "legal", "hr",
]);

function parseTier(value: string | undefined): ExecTier {
  return value && TIERS.has(value as ExecTier) ? (value as ExecTier) : "employee";
}

function parseFunction(value: string | undefined): FunctionArea | null {
  return value && FUNCTIONS.has(value as FunctionArea) ? (value as FunctionArea) : null;
}

// ---------------------------------------------------------------------------
// Stub branch (local dev + tests)
// ---------------------------------------------------------------------------

async function getStubSession(): Promise<Session | null> {
  const { cookies, headers } = await import("next/headers");

  const h = await headers();
  const c = await cookies();

  const userId = h.get("x-stub-user-id") ?? c.get("stub_user_id")?.value;
  const email = h.get("x-stub-email") ?? c.get("stub_email")?.value;
  const tier = parseTier(h.get("x-stub-tier") ?? c.get("stub_tier")?.value);
  const functionArea = parseFunction(h.get("x-stub-function") ?? c.get("stub_function")?.value);

  if (!userId || !email) {
    if (process.env.NODE_ENV !== "production") {
      return {
        userId: "00000000-0000-0000-0000-000000000001",
        email: "dev@exec-db.local",
        tier: "exec_all",
        functionArea: null,
      };
    }
    return null;
  }

  return { userId, email, tier, functionArea };
}

// ---------------------------------------------------------------------------
// Clerk branch (staging + production)
// ---------------------------------------------------------------------------

async function getClerkSession(): Promise<Session | null> {
  // Dynamic import so the stub branch never loads @clerk/nextjs/server.
  const { auth, currentUser } = await import("@clerk/nextjs/server");

  const { userId: clerkUserId } = await auth();
  if (!clerkUserId) return null;

  // Look up the user_link row to resolve the Clerk ID → employee_dim UUID + tier.
  const { getDb, schema } = await import("@exec-db/db");
  const { eq } = await import("drizzle-orm");

  const connectionString = process.env.DATABASE_URL_APP ?? process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("[auth] Missing DATABASE_URL_APP / DATABASE_URL env var");
    return null;
  }

  const db = getDb(connectionString);

  const rows = await db
    .select()
    .from(schema.userLink)
    .where(eq(schema.userLink.clerkUserId, clerkUserId))
    .limit(1);

  if (rows.length === 0) {
    console.warn(`[auth] No user_link row for Clerk user ${clerkUserId} — user not provisioned`);
    return null;
  }

  const row = rows[0]!;

  // Resolve the email from Clerk (most authoritative source).
  let email: string;
  try {
    const user = await currentUser();
    email = user?.emailAddresses[0]?.emailAddress ?? `${clerkUserId}@clerk.local`;
  } catch {
    email = `${clerkUserId}@clerk.local`;
  }

  return {
    userId: row.employeeId as string,
    email,
    tier: parseTier(row.tier as string),
    functionArea: parseFunction((row.functionArea ?? undefined) as string | undefined),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function getSession(): Promise<Session | null> {
  const provider = process.env.AUTH_PROVIDER ?? "clerk";

  // Stub fallback: only available outside production for local dev + tests.
  if (provider === "stub") {
    if (process.env.NODE_ENV === "production") {
      console.error("[auth] AUTH_PROVIDER=stub is not allowed in production");
      return null;
    }
    return getStubSession();
  }

  if (provider === "clerk") {
    return getClerkSession();
  }

  throw new Error(`Unknown AUTH_PROVIDER '${provider}'. Supported values: 'clerk', 'stub'.`);
}

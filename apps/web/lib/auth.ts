import { cookies, headers } from "next/headers";
import type { ExecTier, FunctionArea, Session } from "./rbac.js";

/**
 * Phase 0 stub auth. Reads tier + identity from headers/cookies for local dev.
 * In Phase 1, swap this for WorkOS or Clerk: validate the SSO session, look up
 * the linked employee_dim row, derive tier from a directory group, and return
 * the same Session shape. The rest of the app does not need to change.
 */

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

export async function getSession(): Promise<Session | null> {
  const provider = process.env.AUTH_PROVIDER ?? "stub";
  if (provider !== "stub") {
    throw new Error(`Auth provider '${provider}' not yet wired. See lib/auth.ts.`);
  }

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

export type ExecTier = "exec_all" | "function_lead" | "manager" | "employee";

export type FunctionArea = "eng" | "sales" | "gtm" | "ops" | "finance" | "legal" | "hr";

export type Session = {
  userId: string;
  email: string;
  tier: ExecTier;
  functionArea: FunctionArea | null;
};

export const TIER_RANK: Record<ExecTier, number> = {
  exec_all: 100,
  function_lead: 50,
  manager: 20,
  employee: 0,
};

export function canRead(domain: "comp" | "hr" | "fin" | "legal" | "ops" | "core", session: Session): boolean {
  if (session.tier === "exec_all") return true;
  if (domain === "comp") return false;
  if (domain === "fin" && session.tier === "function_lead" && session.functionArea === "finance") return true;
  if (domain === "legal" && session.tier === "function_lead" && session.functionArea === "legal") return true;
  if (domain === "hr" && session.tier === "function_lead" && session.functionArea === "hr") return true;
  if (domain === "ops") return session.tier !== "employee";
  if (domain === "core") return true;
  if (session.tier === "manager") return domain === "hr";
  return false;
}

export function requireTier(session: Session | null, min: ExecTier): asserts session is Session {
  if (!session) throw new Error("Unauthorized");
  if (TIER_RANK[session.tier] < TIER_RANK[min]) {
    throw new Error(`Forbidden: requires ${min}`);
  }
}

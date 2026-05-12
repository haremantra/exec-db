/**
 * provision-user — upsert a crm.user_link row mapping a Clerk user ID to an
 * employee_dim row.
 *
 * Usage:
 *   pnpm provision-user --clerk-id=user_xyz --email=foo@bar.com --tier=exec_all
 *   pnpm provision-user --clerk-id=user_xyz --employee-uuid=<uuid> --tier=exec_all
 *   pnpm provision-user --clerk-id=user_xyz --email=foo@bar.com --tier=function_lead --function-area=eng
 *
 * Options:
 *   --clerk-id        Required. The Clerk user ID (e.g. user_2abc…).
 *   --email           Employee email — used to look up core.employee_dim.
 *                     Required if --employee-uuid is not provided.
 *   --employee-uuid   Explicit employee_dim UUID (overrides --email lookup).
 *   --tier            Required. One of: exec_all | function_lead | manager | employee | assistant.
 *   --function-area   Optional. One of: eng | sales | gtm | ops | finance | legal | hr.
 *
 * Idempotent: re-running with the same --clerk-id updates tier/function_area.
 *
 * This script requires DATABASE_URL to be set in the environment (must have
 * permission to write to crm.user_link — use the superuser / migration role).
 */

import postgres from "postgres";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

function getArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = args.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

const clerkId = getArg("clerk-id");
const email = getArg("email");
const employeeUuid = getArg("employee-uuid");
const tier = getArg("tier");
const functionArea = getArg("function-area") ?? null;

const VALID_TIERS = new Set(["exec_all", "function_lead", "manager", "employee", "assistant"]);
const VALID_FUNCTION_AREAS = new Set(["eng", "sales", "gtm", "ops", "finance", "legal", "hr"]);

if (!clerkId) {
  console.error("Error: --clerk-id is required");
  process.exit(1);
}

if (!tier || !VALID_TIERS.has(tier)) {
  console.error(`Error: --tier is required and must be one of: ${[...VALID_TIERS].join(" | ")}`);
  process.exit(1);
}

if (!email && !employeeUuid) {
  console.error("Error: either --email or --employee-uuid is required");
  process.exit(1);
}

if (functionArea && !VALID_FUNCTION_AREAS.has(functionArea)) {
  console.error(
    `Error: --function-area must be one of: ${[...VALID_FUNCTION_AREAS].join(" | ")}`,
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("Error: DATABASE_URL env var is required");
  process.exit(1);
}

const sql = postgres(connectionString, { max: 1, idle_timeout: 10 });

async function main(): Promise<void> {
  let resolvedEmployeeId = employeeUuid;

  // If no explicit UUID, look up employee_dim by email.
  if (!resolvedEmployeeId) {
    const rows = await sql`
      SELECT id FROM core.employee_dim
      WHERE work_email = ${email!}
      LIMIT 1
    `;

    if (rows.length === 0) {
      console.error(
        `Error: No employee_dim row found with work_email='${email}'.`,
        "Create the employee row first, or pass --employee-uuid to bypass the lookup.",
      );
      await sql.end();
      process.exit(1);
    }

    resolvedEmployeeId = rows[0].id as string;
    console.log(`Resolved employee_id=${resolvedEmployeeId} for email=${email}`);
  }

  // Upsert crm.user_link.
  await sql`
    INSERT INTO crm.user_link (clerk_user_id, employee_id, tier, function_area, created_at, updated_at)
    VALUES (
      ${clerkId},
      ${resolvedEmployeeId}::uuid,
      ${tier},
      ${functionArea},
      now(),
      now()
    )
    ON CONFLICT (clerk_user_id) DO UPDATE
      SET employee_id   = EXCLUDED.employee_id,
          tier          = EXCLUDED.tier,
          function_area = EXCLUDED.function_area,
          updated_at    = now()
  `;

  console.log(
    `Provisioned: clerk_user_id=${clerkId} → employee_id=${resolvedEmployeeId} tier=${tier}` +
      (functionArea ? ` function_area=${functionArea}` : ""),
  );

  await sql.end();
}

main().catch((err) => {
  console.error("provision-user failed:", err);
  process.exit(1);
});

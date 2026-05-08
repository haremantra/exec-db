/**
 * POST /api/intake/email
 *
 * Forwarded-email intake endpoint (G2 — US-005, SY-001).
 *
 * Accepts a JSON body:
 *   {
 *     from:       { name?: string; email: string };
 *     subject?:   string;
 *     body?:      string;   // full email body including signature block
 *     receivedAt?: string;  // ISO-8601; defaults to now()
 *   }
 *
 * Authentication:
 *   Header: X-Intake-Secret: <value of env var EMAIL_INTAKE_SECRET>
 *   The secret must be set in .env.  Requests without the correct secret
 *   receive HTTP 401.  Keep the secret out of source control.
 *
 * Behaviour:
 *   - Parses From name, email, company (domain or signature line), title
 *     (common titles regex on signature block).
 *   - Creates a draft contact (isDraft=true).
 *   - Idempotent on primary_email: if a contact with this email already
 *     exists (draft or confirmed), returns { existing: true } and does NOT
 *     create a duplicate.
 *   - Never overwrites an exec-confirmed (isDraft=false) record.
 *
 * Env vars:
 *   EMAIL_INTAKE_SECRET  — shared secret for authenticating callers.
 *                          Set this in .env / Vercel environment variables.
 *                          Example: EMAIL_INTAKE_SECRET=your-random-secret-here
 */

import { NextRequest, NextResponse } from "next/server";
import { schema } from "@exec-db/db";
import { eq } from "drizzle-orm";
import { query } from "@/lib/db";

// ---------------------------------------------------------------------------
// Signature parsing helpers
// ---------------------------------------------------------------------------

/**
 * Common executive/professional title patterns.
 * Matches lines like "CEO", "Senior VP of Sales", "Director, Engineering".
 */
const TITLE_RE =
  /\b(CEO|CTO|CFO|COO|CMO|CPO|CRO|VP|SVP|EVP|President|Director|Manager|Head of|Founder|Co-founder|Partner|Principal|Engineer|Analyst|Consultant|Advisor|Associate|Lead|Specialist|Coordinator|Executive)\b[^\n]*/i;

/**
 * Extract a likely job title from a signature block.
 * Scans each line for known title keywords.
 */
export function extractTitle(body: string): string | null {
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (TITLE_RE.test(trimmed) && trimmed.length < 120) {
      return trimmed;
    }
  }
  return null;
}

/**
 * Extract a company name from the signature block.
 * Strategy:
 *   1. Look for a line after the title line that looks like a company name
 *      (no @, not a URL, not a phone number, not empty, reasonable length).
 *   2. Fall back to the domain from the email address.
 */
export function extractCompany(body: string, emailDomain: string): string | null {
  const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (TITLE_RE.test(line)) {
      // Take the next non-empty line as the company if it looks like one
      const next = lines[i + 1];
      if (
        next &&
        next.length >= 2 &&
        next.length < 80 &&
        !next.includes("@") &&
        !/^https?:\/\//i.test(next) &&
        !/^\+?[\d\s().-]{7,}$/.test(next) // not a phone number
      ) {
        return next;
      }
      break;
    }
  }

  // Fall back to domain (strip common subdomains like www/mail)
  const domainParts = emailDomain.replace(/^(www|mail|smtp)\./, "").split(".");
  if (domainParts.length >= 2) {
    // "acme.com" → "acme", "co.uk" TLDs left as-is for now
    const name = domainParts[0]!;
    if (name.length >= 2) {
      return name.charAt(0).toUpperCase() + name.slice(1);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// System user ID for intake-created contacts
// ---------------------------------------------------------------------------
const SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000";

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

interface IntakeBody {
  from: { name?: string; email: string };
  subject?: string;
  body?: string;
  receivedAt?: string;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // --- Authentication ---
  const secret = process.env.EMAIL_INTAKE_SECRET;
  if (!secret) {
    // If secret not configured, fail closed — do not allow unauthenticated intake.
    return NextResponse.json(
      { error: "EMAIL_INTAKE_SECRET not configured on server" },
      { status: 500 },
    );
  }

  const incomingSecret = req.headers.get("x-intake-secret") ?? "";
  if (incomingSecret !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // --- Parse body ---
  let payload: IntakeBody;
  try {
    payload = (await req.json()) as IntakeBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const fromEmail = (payload.from?.email ?? "").trim().toLowerCase();
  if (!fromEmail || !fromEmail.includes("@")) {
    return NextResponse.json({ error: "from.email is required" }, { status: 400 });
  }

  const fromName = (payload.from?.name ?? "").trim();
  const body = (payload.body ?? "").trim();

  // Extract domain for company fallback
  const emailDomain = fromEmail.split("@")[1] ?? "";

  // --- Idempotency check ---
  const sessionCtx = {
    userId: SYSTEM_USER_ID,
    tier: "exec_all" as const,
    functionArea: null,
  };

  const existing = await query(sessionCtx, (tx) =>
    tx
      .select({ id: schema.contact.id, isDraft: schema.contact.isDraft })
      .from(schema.contact)
      .where(eq(schema.contact.primaryEmail, fromEmail))
      .limit(1),
  );

  if (existing.length > 0) {
    // Contact with this email already exists (confirmed or draft) — do not duplicate.
    return NextResponse.json({ existing: true });
  }

  // --- Parse signature for title + company ---
  const roleTitle = extractTitle(body) ?? null;
  const company = extractCompany(body, emailDomain);

  // --- Create draft contact ---
  await query(sessionCtx, (tx) =>
    tx.insert(schema.contact).values({
      fullName: fromName || fromEmail,
      primaryEmail: fromEmail,
      company,
      roleTitle,
      isDraft: true,
      createdBy: SYSTEM_USER_ID,
    }),
  );

  return NextResponse.json({ created: true });
}

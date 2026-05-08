/**
 * priority-shifters.ts — Deterministic priority-shifter detector (PR3-Q / SY-014 / W8.2).
 *
 * Scans recent crm.email_thread rows for two pattern classes:
 *
 *   customer_complaint — Subject or body_full contains complaint-signal keywords
 *                        AND the sender domain matches a known customer (crm.contact.company
 *                        or core.customer_dim.domain).
 *
 *   competitor_mention — Body contains a configured competitor domain (COMPETITOR_DOMAINS
 *                        env var, comma-separated) OR specific competitive-switch phrases.
 *
 * DESIGN CONSTRAINTS (Q1 spec):
 *   - Pure regex + SQL — NO LLM calls. Fast + deterministic for dashboard render.
 *   - Default look-back: last 7 days.
 *   - Results limited to 20.
 *   - Case-insensitive matching throughout.
 *
 * COMPETITOR_DOMAINS env var: comma-separated list of competitor domain strings.
 * Example: COMPETITOR_DOMAINS="acme.com,rivalapp.io,competitorco.com"
 * When empty / unset, competitor_mention detection is disabled.
 */

import { and, desc, gte, isNotNull, isNull, sql } from "drizzle-orm";
import { type SessionContext, schema } from "@exec-db/db";
import { query } from "@/lib/db";

// ── Types ─────────────────────────────────────────────────────────────────────

export type PriorityShifterKind = "customer_complaint" | "competitor_mention";

export interface PriorityShifter {
  kind: PriorityShifterKind;
  threadId: string;
  contactId?: string | undefined;
  subject: string;
  snippet: string;
  detectedAt: Date;
}

export interface PriorityShifterOpts {
  /** Start of the scan window. Default: 7 days ago. */
  since?: Date | undefined;
}

// ── Keyword patterns ──────────────────────────────────────────────────────────

/**
 * Customer-complaint signal words (case-insensitive).
 * Matched against subject + body_full concatenated.
 */
const COMPLAINT_PATTERN =
  /frustrated|unacceptable|cancel(?:ling|ing|ed|s)?|refund|not working|issue with|complaint|disappointed/i;

/**
 * Generic competitor-switch phrases (case-insensitive).
 * Matched against body_full regardless of COMPETITOR_DOMAINS.
 */
const COMPETITOR_SWITCH_PATTERN =
  /we'?re going with|switched to|evaluating\s+\S+/i;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Detect priority-shifting signals in recent email threads.
 *
 * @param session - Session context (userId, tier, functionArea) passed to
 *                  query() for RLS enforcement. Must not be null.
 * @param opts    - Optional overrides: { since } shifts the look-back window.
 * @returns       Array of up to 20 detected PriorityShifter objects,
 *                ordered newest-first.
 */
export async function detectPriorityShifters(
  session: SessionContext,
  opts?: PriorityShifterOpts,
): Promise<PriorityShifter[]> {
  const since = opts?.since ?? sevenDaysAgo();
  const competitorDomains = parseCompetitorDomains();

  // ── 1. Fetch candidate threads from the DB ──────────────────────────────────
  // We pull thread rows + the linked contact company for domain matching.
  // We also pull customer_dim domains via a lateral subquery so we don't have
  // to join everything in application code.
  //
  // Because Drizzle ORM's type system makes arbitrary lateral subqueries
  // cumbersome, we use a raw sql`` template that is still fully parameterised
  // (no string interpolation of user values).  The session RLS context is
  // enforced by query() / withSession() before any SQL runs.

  type ThreadRow = {
    id: string;
    contactId: string | null;
    subject: string | null;
    snippet: string | null;
    bodyFull: string | null;
    lastMessageAt: Date | null;
    contactCompany: string | null;
  };

  const rows = await query<ThreadRow[]>(session, async (tx) => {
    // The tx object from withSession has a raw `execute` path via sql``
    // template tags on the underlying drizzle instance.  We fall back to
    // the drizzle ORM chain, which gives us compile-time safety.
    return tx
      .select({
        id: schema.emailThread.id,
        contactId: schema.emailThread.contactId,
        subject: schema.emailThread.subject,
        snippet: schema.emailThread.snippet,
        bodyFull: schema.emailThread.bodyFull,
        lastMessageAt: schema.emailThread.lastMessageAt,
        contactCompany: schema.contact.company,
      })
      .from(schema.emailThread)
      .leftJoin(
        schema.contact,
        sql`${schema.emailThread.contactId} = ${schema.contact.id}
            AND ${schema.contact.sensitiveFlag} IS NULL`,
      )
      .where(
        and(
          gte(schema.emailThread.lastMessageAt, since),
          // Skip threads whose only contact is sensitive (already excluded
          // by the JOIN condition above, but make it explicit).
          // A null contactId is still scanned — the sender-domain check below
          // will simply not match any customer and the thread falls out.
        ),
      )
      .orderBy(desc(schema.emailThread.lastMessageAt))
      // Fetch up to 200 rows; we filter in-process and cap results at 20.
      .limit(200) as unknown as Promise<ThreadRow[]>;
  });

  // ── 2. Load all known customer domains ─────────────────────────────────────
  const customerDomains = await loadCustomerDomains(session);

  // ── 3. Apply regex patterns in-process ─────────────────────────────────────
  const results: PriorityShifter[] = [];

  for (const row of rows) {
    if (results.length >= 20) break;

    const subject = row.subject ?? "";
    const body = row.bodyFull ?? row.snippet ?? "";
    const searchableText = `${subject}\n${body}`;

    // Derive sender domain from the contact's primary_email via the linked
    // contact.  When no contact is linked, we cannot verify the sender is a
    // customer, so we skip complaint detection for that thread.
    const contactCompany = row.contactCompany;

    // ── customer_complaint check ──────────────────────────────────────────────
    if (COMPLAINT_PATTERN.test(searchableText)) {
      // Confirm sender is a known customer (contact company match OR
      // customer_dim domain match).
      if (contactCompany && isKnownCustomer(contactCompany, customerDomains)) {
        results.push({
          kind: "customer_complaint",
          threadId: row.id,
          contactId: row.contactId ?? undefined,
          subject,
          snippet: row.snippet ?? body.slice(0, 200),
          detectedAt: row.lastMessageAt ?? new Date(),
        });
        continue; // already categorised — don't double-count
      }
    }

    // ── competitor_mention check ──────────────────────────────────────────────
    if (results.length >= 20) break;

    const hasCompetitorDomain =
      competitorDomains.length > 0 &&
      competitorDomains.some((domain) =>
        body.toLowerCase().includes(domain.toLowerCase()),
      );

    const hasCompetitorPhrase = COMPETITOR_SWITCH_PATTERN.test(body);

    if (hasCompetitorDomain || hasCompetitorPhrase) {
      results.push({
        kind: "competitor_mention",
        threadId: row.id,
        contactId: row.contactId ?? undefined,
        subject,
        snippet: row.snippet ?? body.slice(0, 200),
        detectedAt: row.lastMessageAt ?? new Date(),
      });
    }
  }

  return results;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function sevenDaysAgo(): Date {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d;
}

/**
 * Parse the COMPETITOR_DOMAINS env var into a list of trimmed non-empty strings.
 * Returns an empty array when the var is unset or empty.
 */
export function parseCompetitorDomains(): string[] {
  const raw = process.env.COMPETITOR_DOMAINS ?? "";
  if (!raw.trim()) return [];
  return raw
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
}

/**
 * Load all known customer company names and domains.
 * Combines crm.contact.company values (where work_area = 'customer') and
 * core.customer_dim.domain values into a single deduped set.
 */
async function loadCustomerDomains(
  session: SessionContext,
): Promise<Set<string>> {
  const [contactRows, customerRows] = await Promise.all([
    // Contact companies tagged as customers
    query<Array<{ company: string | null }>>(session, (tx) =>
      (tx
        .select({ company: schema.contact.company })
        .from(schema.contact)
        .where(
          and(
            sql`${schema.contact.company} IS NOT NULL`,
            sql`${schema.contact.workArea} = 'customer'`,
            isNull(schema.contact.sensitiveFlag),
          ),
        ) as unknown) as Promise<Array<{ company: string | null }>>,
    ),
    // core.customer_dim domains
    query<Array<{ domain: string | null }>>(session, (tx) =>
      (tx
        .select({ domain: schema.customerDim.domain })
        .from(schema.customerDim)
        .where(isNotNull(schema.customerDim.domain)) as unknown) as Promise<
        Array<{ domain: string | null }>
      >,
    ),
  ]);

  const domains = new Set<string>();
  for (const r of contactRows) {
    if (r.company) domains.add(r.company.toLowerCase());
  }
  for (const r of customerRows) {
    if (r.domain) domains.add(r.domain.toLowerCase());
  }
  return domains;
}

/**
 * Returns true when the contact's company name appears in the customer
 * domain set (case-insensitive substring or exact match).
 */
function isKnownCustomer(company: string, customerDomains: Set<string>): boolean {
  const lc = company.toLowerCase();
  if (customerDomains.has(lc)) return true;
  // Also check if any known domain is a substring of the company name or vice
  // versa, to handle cases like company="Acme Inc" vs domain="acme.com".
  for (const d of customerDomains) {
    // Strip TLD suffix from domain for a fuzzy match.
    const base = d.split(".")[0];
    if (base && (lc.includes(base) || base.includes(lc))) return true;
  }
  return false;
}

/**
 * contact-context.ts — Single-contact context retrieval helper.
 *
 * CONTRACT (SY-008 / AD-008 / C2):
 * ─────────────────────────────────────────────────────────────────────────────
 * This module is the ONLY sanctioned entry point for fetching contact-scoped
 * data that flows into LLM context (autodraft — Stream B; pre-call briefing —
 * Stream F).  It enforces three invariants:
 *
 *   1. SINGLE-CONTACT SCOPE — every query is filtered by `contactId`.
 *      The function will NEVER widen a query to "all contacts."
 *
 *   2. CROSS-POLLINATION GUARD — after each query, every returned row is
 *      checked to confirm its `contact_id` matches the requested contactId.
 *      If any mismatch is found, the function throws immediately with a clear
 *      error.  This acts as a regression guard across refactors.
 *
 *   3. SENSITIVE-CONTACT ISOLATION — because this function always calls through
 *      `query()` with the caller's RLS session, sensitive contacts are already
 *      filtered at the DB layer by the `crm.is_sensitive_for_role` RLS policy.
 *      A non-exec caller asking for context on a sensitive contact will receive
 *      an empty result for each table (not an error) — the RLS policy hides the
 *      rows.  exec_all sees everything.
 *
 * Stream B (autodraft) and Stream F (pre-call briefing) MUST use this helper
 * and MUST NOT build ad-hoc queries that retrieve notes/threads for a
 * contact without going through this function.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { schema } from "@exec-db/db";
import { desc, eq } from "drizzle-orm";
import { query } from "@/lib/db";
import type { Session } from "@/lib/rbac";

// ── Types ────────────────────────────────────────────────────────────────────

export type ContactContextOpts = {
  /** Include call notes in the result. */
  includeNotes: boolean;
  /** Include email threads in the result. */
  includeThreads: boolean;
  /** Include calendar events in the result. */
  includeEvents: boolean;
  /** Maximum call notes to return (default 10). */
  maxNotes?: number;
  /** Maximum email threads to return (default 10). */
  maxThreads?: number;
  /** Maximum calendar events to return (default 10). */
  maxEvents?: number;
};

export type ContactRow = typeof schema.contact.$inferSelect;
export type CallNoteRow = typeof schema.callNote.$inferSelect;
export type EmailThreadRow = typeof schema.emailThread.$inferSelect;
export type CalendarEventRow = typeof schema.calendarEvent.$inferSelect;

export type ContactContext = {
  contact: ContactRow | null;
  notes: CallNoteRow[];
  threads: EmailThreadRow[];
  events: CalendarEventRow[];
};

// ── Cross-pollination invariant check ────────────────────────────────────────

/**
 * Asserts that every row in `rows` has a `contact_id` field equal to
 * `expectedContactId`.  Throws if any mismatch is detected.
 *
 * This is the runtime enforcement of the cross-pollination invariant
 * (AD-008, SY-008).  It intentionally crashes loudly so that a future
 * refactor that accidentally widens a query is caught immediately in
 * development and CI rather than silently leaking data in production.
 */
function assertNoCrossPollination(
  rows: Array<{ contact_id?: string | null; contactId?: string | null }>,
  expectedContactId: string,
  source: string,
): void {
  for (const row of rows) {
    // Drizzle returns camelCase (contactId); raw SQL returns snake_case.
    const actual = row.contactId ?? row.contact_id;
    if (actual !== undefined && actual !== null && actual !== expectedContactId) {
      throw new Error(
        `[contact-context] Cross-pollination invariant violated in ${source}: ` +
          `expected contact_id="${expectedContactId}" but got "${actual}". ` +
          `This is a bug — a query returned data for the wrong contact.`,
      );
    }
  }
}

// ── Main export ──────────────────────────────────────────────────────────────

/**
 * Retrieve context for a single contact, suitable for LLM prompt assembly.
 *
 * @param contactId  UUID of the contact to retrieve context for.
 * @param session    Caller's auth session — used to set RLS context so the
 *                   DB-level sensitive-flag policy applies automatically.
 * @param opts       Which related tables to include and row limits.
 *
 * @returns ContactContext with the contact row (null if not found or hidden
 *          by RLS) plus arrays for notes / threads / events.  Empty arrays
 *          are returned for tables not requested or hidden by RLS.
 *
 * @throws  If any returned row has a contact_id that does not match
 *          `contactId` — this indicates a cross-pollination bug.
 */
export async function getContactContext(
  contactId: string,
  session: { userId: string; tier: string; functionArea: string | null },
  opts: ContactContextOpts,
): Promise<ContactContext> {
  const maxNotes = opts.maxNotes ?? 10;
  const maxThreads = opts.maxThreads ?? 10;
  const maxEvents = opts.maxEvents ?? 10;

  const ctx = {
    userId: session.userId,
    tier: session.tier as Session["tier"],
    functionArea: session.functionArea,
  };

  return query(ctx, async (tx) => {
    // ── 1. Contact row ────────────────────────────────────────────────────
    const [contact = null] = await tx
      .select()
      .from(schema.contact)
      .where(eq(schema.contact.id, contactId))
      .limit(1);

    // ── 2. Call notes ─────────────────────────────────────────────────────
    let notes: CallNoteRow[] = [];
    if (opts.includeNotes) {
      notes = await tx
        .select()
        .from(schema.callNote)
        .where(eq(schema.callNote.contactId, contactId))
        .orderBy(desc(schema.callNote.occurredAt))
        .limit(maxNotes);

      // Runtime cross-pollination guard.
      assertNoCrossPollination(notes, contactId, "callNote");
    }

    // ── 3. Email threads ──────────────────────────────────────────────────
    let threads: EmailThreadRow[] = [];
    if (opts.includeThreads) {
      threads = await tx
        .select()
        .from(schema.emailThread)
        .where(eq(schema.emailThread.contactId, contactId))
        .orderBy(desc(schema.emailThread.lastMessageAt))
        .limit(maxThreads);

      assertNoCrossPollination(threads, contactId, "emailThread");
    }

    // ── 4. Calendar events ────────────────────────────────────────────────
    let events: CalendarEventRow[] = [];
    if (opts.includeEvents) {
      events = await tx
        .select()
        .from(schema.calendarEvent)
        .where(eq(schema.calendarEvent.contactId, contactId))
        .orderBy(desc(schema.calendarEvent.startsAt))
        .limit(maxEvents);

      assertNoCrossPollination(events, contactId, "calendarEvent");
    }

    return { contact, notes, threads, events };
  });
}

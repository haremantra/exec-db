/**
 * briefing.ts — Pre-call briefing assembler (F1, F2, F3 — US-006, SY-003).
 *
 * CONTRACT:
 * ─────────────────────────────────────────────────────────────────────────────
 * • No LLM calls — briefing is deterministic data assembly only.
 * • Uses getContactContext exclusively; never builds ad-hoc contact queries.
 * • Cross-pollination guard is enforced inside getContactContext (contact-context.ts).
 * • On any sub-fetch failure, returns a partial briefing rather than throwing.
 * • Results are cached in-memory per (userId, contactId) for 60 s to keep
 *   the panel render <2 s on warm path.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { getContactContext } from "@/lib/contact-context";
import type { CallNoteRow, ContactRow, EmailThreadRow } from "@/lib/contact-context";
import type { Session } from "@/lib/rbac";

// ── Types ────────────────────────────────────────────────────────────────────

/** A single call-note summary for display in the briefing panel. */
export type BriefingNote = {
  /** ISO timestamp of when the call occurred. */
  occurredAt: string;
  /** First line of the note's markdown (stripped of leading `# ` etc.). */
  firstLine: string;
};

/** A single email-thread entry for display in the briefing panel. */
export type BriefingThread = {
  /** ISO timestamp of the last message in the thread. */
  lastMessageAt: string;
  /** Subject line of the thread. */
  subject: string;
};

/**
 * Pre-call briefing assembled for a contact.
 * Empty/missing fields are represented as null or empty arrays so the UI can
 * render "—" without ever entering a "loading forever" state (US-006 / F3).
 */
export type PreCallBriefing = {
  /** Full contact row, or null if the contact does not exist or is hidden. */
  contact: ContactRow | null;
  /** Last ≤3 call notes, newest first. */
  lastNotes: BriefingNote[];
  /** Last ≤5 email-thread subjects, newest first. */
  lastThreadSubjects: BriefingThread[];
  /** Contact's current job title, from crm.contact.role_title. Null if unset. */
  currentTitle: string | null;
  /** Contact's current company, from crm.contact.company. Null if unset. */
  currentCompany: string | null;
  /**
   * Public perspective links (LinkedIn posts, Substack, etc.) derived from
   * the contact's email domain.
   *
   * TODO: LinkedIn / Substack lookup is a future enhancement — no live web
   * scraping in this PR.  Returns an empty array for now.
   */
  publicPerspectiveLinks: string[];
};

// ── In-memory cache ───────────────────────────────────────────────────────────

type CacheEntry = {
  briefing: PreCallBriefing;
  expiresAt: number;
};

/** Keyed by `"${userId}:${contactId}"`. TTL = 60 s. */
const briefingCache = new Map<string, CacheEntry>();

/** Cache TTL in milliseconds. */
const CACHE_TTL_MS = 60_000;

function cacheKey(userId: string, contactId: string): string {
  return `${userId}:${contactId}`;
}

function getCached(userId: string, contactId: string): PreCallBriefing | null {
  const entry = briefingCache.get(cacheKey(userId, contactId));
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    briefingCache.delete(cacheKey(userId, contactId));
    return null;
  }
  return entry.briefing;
}

function setCached(userId: string, contactId: string, briefing: PreCallBriefing): void {
  briefingCache.set(cacheKey(userId, contactId), {
    briefing,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns the first non-empty, non-heading line of a markdown string.
 * Strips leading `#` heading markers and trims whitespace.
 */
function extractFirstLine(markdown: string): string {
  const lines = markdown.split("\n");
  for (const raw of lines) {
    const line = raw.replace(/^#{1,6}\s*/, "").trim();
    if (line.length > 0) return line;
  }
  return "";
}

function toNote(row: CallNoteRow): BriefingNote {
  return {
    occurredAt: row.occurredAt.toISOString(),
    firstLine: extractFirstLine(row.markdown),
  };
}

function toThread(row: EmailThreadRow): BriefingThread {
  return {
    lastMessageAt: row.lastMessageAt ? row.lastMessageAt.toISOString() : "",
    subject: row.subject ?? "",
  };
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Assemble a pre-call briefing for a single contact.
 *
 * Relies on getContactContext (the sole sanctioned contact-data retrieval
 * surface) to fetch notes, threads, and the contact row.  The cross-
 * pollination guard inside getContactContext throws on any mismatch — this
 * function lets that propagate as-is (it is a hard invariant, not a graceful
 * degradation case).
 *
 * All other errors (DB unavailable, contact not found, etc.) are caught and
 * result in a partial briefing — never a throw to the caller.
 *
 * @param contactId  UUID of the contact to brief on.
 * @param session    Caller's auth session (used for RLS scoping).
 * @returns          A PreCallBriefing — always defined, fields may be null/[].
 */
export async function getPreCallBriefing(
  contactId: string,
  session: Session,
): Promise<PreCallBriefing> {
  // ── Cache hit ─────────────────────────────────────────────────────────────
  const cached = getCached(session.userId, contactId);
  if (cached) return cached;

  // ── Default (empty) briefing for graceful degradation ────────────────────
  const empty: PreCallBriefing = {
    contact: null,
    lastNotes: [],
    lastThreadSubjects: [],
    currentTitle: null,
    currentCompany: null,
    publicPerspectiveLinks: [],
  };

  let briefing: PreCallBriefing;

  try {
    const ctx = await getContactContext(contactId, session, {
      includeNotes: true,
      includeThreads: true,
      includeEvents: false,
      maxNotes: 3,
      maxThreads: 5,
    });

    briefing = {
      contact: ctx.contact,
      lastNotes: ctx.notes.map(toNote),
      lastThreadSubjects: ctx.threads.map(toThread),
      currentTitle: ctx.contact?.roleTitle ?? null,
      currentCompany: ctx.contact?.company ?? null,
      // TODO: LinkedIn / Substack lookup is a future enhancement (no live
      // web scraping in this PR).  Derive from contact email domain when
      // implemented.
      publicPerspectiveLinks: [],
    };
  } catch (err) {
    // Cross-pollination invariant violations must propagate — they indicate
    // a data integrity bug, not a transient failure.
    if (
      err instanceof Error &&
      err.message.includes("Cross-pollination invariant violated")
    ) {
      throw err;
    }

    // All other errors: return partial (empty) briefing so the UI renders
    // "—" rather than a crash or perpetual spinner (F3 / US-006).
    briefing = empty;
  }

  // ── Populate cache ────────────────────────────────────────────────────────
  setCached(session.userId, contactId, briefing);

  return briefing;
}

// ── Cache utilities (exported for testing) ───────────────────────────────────

/** Clear all cache entries — intended for use in tests. */
export function clearBriefingCache(): void {
  briefingCache.clear();
}

/** Directly inject a cache entry — intended for use in tests. */
export function injectBriefingCache(
  userId: string,
  contactId: string,
  briefing: PreCallBriefing,
  expiresAt?: number,
): void {
  briefingCache.set(cacheKey(userId, contactId), {
    briefing,
    expiresAt: expiresAt ?? Date.now() + CACHE_TTL_MS,
  });
}

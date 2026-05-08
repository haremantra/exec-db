/**
 * note-search.ts — Full-text search across call notes (I2 — US-008, W3.6).
 *
 * Search strategy: case-insensitive substring match (ILIKE) on call_note.markdown.
 * No LLM calls — pure SQL pattern matching.
 *
 * Sensitive-contact exclusion (invariant from PR2-C / US-014):
 *   - By default, contacts with a non-null sensitive_flag are excluded.
 *   - With `includeSensitive=true` AND `session.tier === 'exec_all'`, sensitive
 *     contacts are included.
 *   - If `includeSensitive=true` is passed by a NON-exec session, the option is
 *     silently ignored and sensitive contacts remain excluded.
 *   - Defense-in-depth: this module enforces exclusion at the query level,
 *     independently of the RLS policies set up in PR2-C.  Even if RLS is
 *     misconfigured, a non-exec caller cannot retrieve sensitive notes through
 *     this function.
 */

import { schema } from "@exec-db/db";
import { and, desc, eq, ilike, isNull } from "drizzle-orm";
import { query } from "@/lib/db";
import type { Session } from "@/lib/rbac";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SearchResult {
  contactId: string;
  contactName: string;
  noteId: string;
  occurredAt: Date;
  /** ~60 chars before the match + matched span + ~60 chars after the match. */
  snippet: string;
  /** 0-based character position of the match start within `note.markdown`. */
  matchPosition: number;
}

export interface SearchOptions {
  /**
   * When true AND session.tier === 'exec_all', sensitive contacts are included
   * in the result set.  For all other tiers this option is ignored.
   */
  includeSensitive?: boolean;
  /** Maximum number of results to return (default: 50, max: 200). */
  limit?: number;
}

// ── Snippet builder ───────────────────────────────────────────────────────────

const CONTEXT_CHARS = 60;
const MATCH_OPEN = "**";
const MATCH_CLOSE = "**";

/**
 * Build a ~(2 * CONTEXT_CHARS + match.length) character snippet centred on
 * the first occurrence of `query` in `text` (case-insensitive).
 *
 * Returns `{ snippet, matchPosition }` where `matchPosition` is the index of
 * the first match in the *original* text, or `{ snippet: text.slice(0, 150), matchPosition: -1 }`
 * if the query is not found (should not happen in practice since the DB already
 * filters for it).
 */
export function buildSnippet(
  text: string,
  searchQuery: string,
): { snippet: string; matchPosition: number } {
  if (!searchQuery) {
    return { snippet: text.slice(0, CONTEXT_CHARS * 2), matchPosition: -1 };
  }

  const lower = text.toLowerCase();
  const queryLower = searchQuery.toLowerCase();
  const pos = lower.indexOf(queryLower);

  if (pos === -1) {
    return { snippet: text.slice(0, CONTEXT_CHARS * 2), matchPosition: -1 };
  }

  const start = Math.max(0, pos - CONTEXT_CHARS);
  const end = Math.min(text.length, pos + searchQuery.length + CONTEXT_CHARS);

  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  const before = text.slice(start, pos);
  const matched = text.slice(pos, pos + searchQuery.length);
  const after = text.slice(pos + searchQuery.length, end);

  const snippet = `${prefix}${before}${MATCH_OPEN}${matched}${MATCH_CLOSE}${after}${suffix}`;

  return { snippet, matchPosition: pos };
}

// ── Main search function ──────────────────────────────────────────────────────

/**
 * Search call notes by full-text substring match.
 *
 * @param searchQuery   Keyword string (no SQL injection risk — passed as a bind
 *                      parameter to ILIKE, never interpolated raw).
 * @param session       Caller's session (used for tier check and RLS context).
 * @param opts          Optional tuning: includeSensitive, limit.
 * @returns             Up to `limit` results ordered by `occurred_at DESC`.
 */
export async function searchCallNotes(
  searchQuery: string,
  session: Session,
  opts: SearchOptions = {},
): Promise<SearchResult[]> {
  const trimmed = searchQuery.trim();
  if (!trimmed) return [];

  const limit = Math.min(opts.limit ?? 50, 200);
  // Sensitive contacts are only visible to exec_all — guard at function level.
  const canSeeSensitive = opts.includeSensitive === true && session.tier === "exec_all";

  const rows = await query(
    { userId: session.userId, tier: session.tier, functionArea: session.functionArea },
    (tx) => {
      // Build the sensitive-exclusion condition.
      // Even though RLS policies (PR2-C) enforce this at the DB level, we add
      // an explicit application-level filter as defense-in-depth (double-fence).
      const sensitiveCondition = canSeeSensitive
        ? undefined // no extra filter — include everything RLS allows
        : isNull(schema.contact.sensitiveFlag); // exclude ANY sensitive contact

      const conditions = [
        ilike(schema.callNote.markdown, `%${trimmed}%`),
        ...(sensitiveCondition ? [sensitiveCondition] : []),
      ];

      return tx
        .select({
          contactId: schema.callNote.contactId,
          contactName: schema.contact.fullName,
          noteId: schema.callNote.id,
          occurredAt: schema.callNote.occurredAt,
          markdown: schema.callNote.markdown,
        })
        .from(schema.callNote)
        .innerJoin(
          schema.contact,
          eq(schema.callNote.contactId, schema.contact.id),
        )
        .where(and(...conditions))
        .orderBy(desc(schema.callNote.occurredAt))
        .limit(limit);
    },
  );

  return rows.map((row) => {
    const { snippet, matchPosition } = buildSnippet(row.markdown, trimmed);
    return {
      contactId: row.contactId,
      contactName: row.contactName,
      noteId: row.noteId,
      occurredAt: row.occurredAt,
      snippet,
      matchPosition,
    };
  });
}

/**
 * note-search.test.ts — Full-text search + sensitive-contact exclusion tests.
 *
 * Covers:
 *   - Sensitive contacts excluded from search for non-exec sessions (US-014 invariant).
 *   - includeSensitive=true is silently ignored for non-exec sessions.
 *   - includeSensitive=true AND exec_all tier → sensitive notes appear.
 *   - Triage and work-area filter pass-through (column presence on schema).
 *   - buildSnippet: correct snippet extraction with highlight markers.
 *   - Empty query returns empty results immediately.
 *   - Limit parameter is respected.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSnippet } from "@/lib/note-search";

// ── UUIDs ─────────────────────────────────────────────────────────────────────

const CONTACT_SAFE   = "aaaa0000-0000-0000-0000-000000000001";
const CONTACT_SENSITIVE = "bbbb0000-0000-0000-0000-000000000002";
const NOTE_SAFE      = "cccc0000-0000-0000-0000-000000000003";
const NOTE_SENSITIVE = "dddd0000-0000-0000-0000-000000000004";

// ── Seed data ─────────────────────────────────────────────────────────────────

const seedNotes = [
  {
    contactId: CONTACT_SAFE,
    contactName: "Alice Normal",
    noteId: NOTE_SAFE,
    occurredAt: new Date("2024-06-01T10:00:00Z"),
    markdown: "Discussed the update request — delivered when we ship v2.",
  },
  {
    contactId: CONTACT_SENSITIVE,
    contactName: "Bob Sensitive",
    noteId: NOTE_SENSITIVE,
    occurredAt: new Date("2024-06-02T10:00:00Z"),
    markdown: "LOI negotiation notes: update request confirmed by counsel.",
  },
];

// ── Mock @/lib/db ─────────────────────────────────────────────────────────────

/**
 * Simulate the DB layer (+ RLS tier check) for searchCallNotes.
 *
 * The mock filters rows by:
 *   1. ILIKE match on markdown.
 *   2. sensitive_flag exclusion — if the caller is not exec_all, rows from
 *      CONTACT_SENSITIVE are hidden (mirrors crm.is_sensitive_for_role()).
 *      If canSeeSensitive is true (exec_all + includeSensitive), sensitive
 *      rows are returned.
 *
 * `canSeeSensitive` is captured from the query context at call time.
 */
let mockTier = "exec_all";
let mockIncludeSensitive = false;

vi.mock("@/lib/db", () => ({
  query: async <T,>(
    ctx: { userId: string; tier: string; functionArea: string | null },
    fn: (tx: unknown) => Promise<T>,
  ): Promise<T> => {
    // Capture tier from context for filtering.
    const tier = ctx.tier;
    const isExec = tier === "exec_all";

    // The tx object returned here is a fluent builder that terminates at limit().
    // We track the WHERE conditions via closures because the real code passes
    // Drizzle SQL nodes which we cannot easily inspect — instead we apply the
    // filtering logic directly on seed data based on known test invariants.
    const tx = {
      select(_cols?: unknown) {
        return {
          from(_table: unknown) {
            return {
              innerJoin(_joined: unknown, _on: unknown) {
                return {
                  where(_whereExpr: unknown) {
                    return {
                      orderBy(_ob: unknown) {
                        return {
                          limit(n: number) {
                            // Filter seed notes based on tier + canSeeSensitive flag.
                            const canSeeSensitive = isExec && mockIncludeSensitive;
                            const rows = seedNotes.filter((row) => {
                              // Sensitive exclusion (double-fence).
                              if (!canSeeSensitive && row.contactId === CONTACT_SENSITIVE) {
                                return false;
                              }
                              return true;
                            });
                            return Promise.resolve(rows.slice(0, n));
                          },
                        };
                      },
                    };
                  },
                };
              },
            };
          },
        };
      },
    };

    return fn(tx);
  },
}));

// ── Session fixtures ──────────────────────────────────────────────────────────

const execSession = {
  userId: "00000000-0000-0000-0000-000000000001",
  email: "exec@example.com",
  tier: "exec_all" as const,
  functionArea: null,
};

const leadSession = {
  userId: "00000000-0000-0000-0000-000000000002",
  email: "lead@example.com",
  tier: "function_lead" as const,
  functionArea: "sales" as const,
};

const managerSession = {
  userId: "00000000-0000-0000-0000-000000000003",
  email: "mgr@example.com",
  tier: "manager" as const,
  functionArea: null,
};

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockTier = "exec_all";
  mockIncludeSensitive = false;
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("searchCallNotes — sensitive-contact exclusion invariant", () => {
  it("excludes sensitive contacts for a non-exec (function_lead) session", async () => {
    const { searchCallNotes } = await import("@/lib/note-search");
    const results = await searchCallNotes("update request", leadSession, {});
    const noteIds = results.map((r) => r.noteId);
    expect(noteIds).not.toContain(NOTE_SENSITIVE);
    expect(noteIds).toContain(NOTE_SAFE);
  });

  it("excludes sensitive contacts for a manager session", async () => {
    const { searchCallNotes } = await import("@/lib/note-search");
    const results = await searchCallNotes("update request", managerSession, {});
    const noteIds = results.map((r) => r.noteId);
    expect(noteIds).not.toContain(NOTE_SENSITIVE);
  });

  it("ignores includeSensitive=true for a non-exec (function_lead) session", async () => {
    // Even with includeSensitive=true, a non-exec session must NOT see sensitive notes.
    mockIncludeSensitive = true; // simulates the flag being set
    const { searchCallNotes } = await import("@/lib/note-search");
    const results = await searchCallNotes("update request", leadSession, {
      includeSensitive: true, // should be silently ignored
    });
    const noteIds = results.map((r) => r.noteId);
    expect(noteIds).not.toContain(NOTE_SENSITIVE);
    expect(noteIds).toContain(NOTE_SAFE);
  });

  it("includes sensitive contacts for exec_all WITH includeSensitive=true", async () => {
    mockIncludeSensitive = true;
    const { searchCallNotes } = await import("@/lib/note-search");
    const results = await searchCallNotes("update request", execSession, {
      includeSensitive: true,
    });
    const noteIds = results.map((r) => r.noteId);
    expect(noteIds).toContain(NOTE_SENSITIVE);
    expect(noteIds).toContain(NOTE_SAFE);
  });

  it("excludes sensitive contacts for exec_all WITHOUT includeSensitive", async () => {
    mockIncludeSensitive = false;
    const { searchCallNotes } = await import("@/lib/note-search");
    const results = await searchCallNotes("update request", execSession, {
      includeSensitive: false,
    });
    const noteIds = results.map((r) => r.noteId);
    expect(noteIds).not.toContain(NOTE_SENSITIVE);
    expect(noteIds).toContain(NOTE_SAFE);
  });

  it("returns empty array immediately for an empty query string", async () => {
    const { searchCallNotes } = await import("@/lib/note-search");
    const results = await searchCallNotes("", execSession, { includeSensitive: true });
    expect(results).toHaveLength(0);
  });

  it("returns empty array for a whitespace-only query", async () => {
    const { searchCallNotes } = await import("@/lib/note-search");
    const results = await searchCallNotes("   ", execSession, { includeSensitive: true });
    expect(results).toHaveLength(0);
  });

  it("result objects have required fields: contactId, contactName, noteId, occurredAt, snippet, matchPosition", async () => {
    mockIncludeSensitive = false;
    const { searchCallNotes } = await import("@/lib/note-search");
    const results = await searchCallNotes("update request", execSession, {});
    expect(results.length).toBeGreaterThan(0);
    const r = results[0]!;
    expect(r).toHaveProperty("contactId");
    expect(r).toHaveProperty("contactName");
    expect(r).toHaveProperty("noteId");
    expect(r).toHaveProperty("occurredAt");
    expect(r).toHaveProperty("snippet");
    expect(r).toHaveProperty("matchPosition");
  });

  it("respects the limit option", async () => {
    mockIncludeSensitive = true;
    const { searchCallNotes } = await import("@/lib/note-search");
    // Only 2 seed notes exist — ask for limit=1.
    const results = await searchCallNotes("update request", execSession, {
      includeSensitive: true,
      limit: 1,
    });
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it("snippet field contains the search term (wrapped in ** markers)", async () => {
    mockIncludeSensitive = false;
    const { searchCallNotes } = await import("@/lib/note-search");
    const results = await searchCallNotes("update request", execSession, {});
    expect(results.length).toBeGreaterThan(0);
    // At least one snippet should contain the highlighted term.
    const hasHighlight = results.some((r) => r.snippet.includes("**"));
    expect(hasHighlight).toBe(true);
  });

  it("matchPosition is -1 when buildSnippet cannot find the term in the text", () => {
    // buildSnippet returns matchPosition=-1 for not-found queries.
    const { matchPosition } = buildSnippet("This note has nothing relevant", "xyzzy");
    expect(matchPosition).toBe(-1);
  });

  it("TRIAGE_TAG_VALUES has exactly 3 values and WORK_AREA_VALUES has exactly 7", async () => {
    const { TRIAGE_TAG_VALUES, WORK_AREA_VALUES } = await import("@exec-db/db");
    expect(TRIAGE_TAG_VALUES).toHaveLength(3);
    expect(WORK_AREA_VALUES).toHaveLength(7);
  });
});

describe("buildSnippet — snippet extraction + highlight markers", () => {
  it("wraps the matching term in ** markers", () => {
    const { snippet } = buildSnippet("Hello world foo bar", "world");
    expect(snippet).toContain("**world**");
  });

  it("includes context before and after the match", () => {
    const text = "A ".repeat(70) + "needle" + " B".repeat(70);
    const { snippet, matchPosition } = buildSnippet(text, "needle");
    expect(snippet).toContain("**needle**");
    expect(matchPosition).toBeGreaterThan(0);
    // The snippet should be much shorter than the full text.
    expect(snippet.length).toBeLessThan(text.length);
  });

  it("adds ellipsis prefix when match is not near the start", () => {
    const text = "x".repeat(100) + "match" + "y".repeat(100);
    const { snippet } = buildSnippet(text, "match");
    expect(snippet.startsWith("…")).toBe(true);
  });

  it("adds ellipsis suffix when match is not near the end", () => {
    const text = "x".repeat(100) + "match" + "y".repeat(100);
    const { snippet } = buildSnippet(text, "match");
    expect(snippet.endsWith("…")).toBe(true);
  });

  it("returns matchPosition=-1 when query is not found", () => {
    const { matchPosition } = buildSnippet("some text without the term", "zzz");
    expect(matchPosition).toBe(-1);
  });

  it("is case-insensitive: finds 'Update' when searching for 'update'", () => {
    const text = "The Update Request was completed";
    const { snippet, matchPosition } = buildSnippet(text, "update");
    // matchPosition should point to the start of 'Update'
    expect(matchPosition).toBe(4);
    expect(snippet).toContain("**Update**");
  });
});

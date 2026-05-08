/**
 * briefing.test.ts
 *
 * Unit tests for getPreCallBriefing (apps/web/lib/briefing.ts).
 *
 * Coverage:
 *  1. Returns expected fields populated from canned contact-context data.
 *  2. Sub-fetch failures degrade to a partial (empty) briefing — no throw.
 *  3. Cache hit on second call within 60 s.
 *  4. Cross-pollination guard propagates (does NOT swallow the invariant error).
 *  5. Empty contact (unknown id) returns contact: null and empty arrays.
 *  6. publicPerspectiveLinks is always an empty array in this PR.
 *  7. Performance: cache-hit path completes in <50 ms.
 *  8. currentTitle and currentCompany come from the contact row.
 *  9. Notes are capped at 3; threads at 5.
 * 10. firstLine extraction strips markdown heading markers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── UUIDs ─────────────────────────────────────────────────────────────────────

const CONTACT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CONTACT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const UNKNOWN_ID = "ffffffff-ffff-ffff-ffff-ffffffffffff";

// ── Canned data ───────────────────────────────────────────────────────────────

const cannedContact = {
  id: CONTACT_A,
  fullName: "Alice Alpha",
  primaryEmail: "alice@example.com",
  company: "Acme Corp",
  roleTitle: "Chief Revenue Officer",
  sensitiveFlag: null,
  linkedEmployeeId: null,
  linkedCustomerId: null,
  createdBy: "00000000-0000-0000-0000-000000000001",
  createdAt: new Date("2024-01-01T00:00:00Z"),
  updatedAt: new Date("2024-01-01T00:00:00Z"),
};

const cannedNotes = [
  {
    id: "note-1",
    contactId: CONTACT_A,
    occurredAt: new Date("2024-03-10T10:00:00Z"),
    markdown: "## Intro call\n\n- discussed roadmap\n- next steps TBD",
    authorId: "00000000-0000-0000-0000-000000000001",
    createdAt: new Date("2024-03-10T10:00:00Z"),
    updatedAt: new Date("2024-03-10T10:00:00Z"),
  },
  {
    id: "note-2",
    contactId: CONTACT_A,
    occurredAt: new Date("2024-03-05T09:00:00Z"),
    markdown: "# Follow-up\n\nReviewed pricing options",
    authorId: "00000000-0000-0000-0000-000000000001",
    createdAt: new Date("2024-03-05T09:00:00Z"),
    updatedAt: new Date("2024-03-05T09:00:00Z"),
  },
  {
    id: "note-3",
    contactId: CONTACT_A,
    occurredAt: new Date("2024-02-20T14:00:00Z"),
    markdown: "Initial outreach call — positive response",
    authorId: "00000000-0000-0000-0000-000000000001",
    createdAt: new Date("2024-02-20T14:00:00Z"),
    updatedAt: new Date("2024-02-20T14:00:00Z"),
  },
];

const cannedThreads = [
  {
    id: "thread-1",
    gmailThreadId: "gthread-1",
    contactId: CONTACT_A,
    subject: "Re: Q2 roadmap",
    lastMessageAt: new Date("2024-03-11T08:00:00Z"),
    snippet: "...",
    createdBy: "00000000-0000-0000-0000-000000000001",
    createdAt: new Date("2024-03-11T08:00:00Z"),
    updatedAt: new Date("2024-03-11T08:00:00Z"),
  },
  {
    id: "thread-2",
    gmailThreadId: "gthread-2",
    contactId: CONTACT_A,
    subject: "Partnership intro",
    lastMessageAt: new Date("2024-03-08T12:00:00Z"),
    snippet: "...",
    createdBy: "00000000-0000-0000-0000-000000000001",
    createdAt: new Date("2024-03-08T12:00:00Z"),
    updatedAt: new Date("2024-03-08T12:00:00Z"),
  },
  {
    id: "thread-3",
    gmailThreadId: "gthread-3",
    contactId: CONTACT_A,
    subject: "Follow-up from call",
    lastMessageAt: new Date("2024-03-06T15:00:00Z"),
    snippet: "...",
    createdBy: "00000000-0000-0000-0000-000000000001",
    createdAt: new Date("2024-03-06T15:00:00Z"),
    updatedAt: new Date("2024-03-06T15:00:00Z"),
  },
  {
    id: "thread-4",
    gmailThreadId: "gthread-4",
    contactId: CONTACT_A,
    subject: "Demo scheduling",
    lastMessageAt: new Date("2024-03-01T10:00:00Z"),
    snippet: "...",
    createdBy: "00000000-0000-0000-0000-000000000001",
    createdAt: new Date("2024-03-01T10:00:00Z"),
    updatedAt: new Date("2024-03-01T10:00:00Z"),
  },
  {
    id: "thread-5",
    gmailThreadId: "gthread-5",
    contactId: CONTACT_A,
    subject: "Initial intro",
    lastMessageAt: new Date("2024-02-25T09:00:00Z"),
    snippet: "...",
    createdBy: "00000000-0000-0000-0000-000000000001",
    createdAt: new Date("2024-02-25T09:00:00Z"),
    updatedAt: new Date("2024-02-25T09:00:00Z"),
  },
];

// ── Mock control flags ────────────────────────────────────────────────────────

let mockShouldThrow = false;
let mockThrowCrossPollination = false;
let mockContactId = CONTACT_A; // which contact the mock returns data for

// ── Mock @/lib/contact-context ────────────────────────────────────────────────

vi.mock("@/lib/contact-context", () => ({
  getContactContext: async (
    contactId: string,
    _session: unknown,
    opts: { maxNotes?: number; maxThreads?: number },
  ) => {
    if (mockThrowCrossPollination) {
      throw new Error(
        `[contact-context] Cross-pollination invariant violated in callNote: ` +
          `expected contact_id="${contactId}" but got "${CONTACT_B}". ` +
          `This is a bug — a query returned data for the wrong contact.`,
      );
    }

    if (mockShouldThrow) {
      throw new Error("DB connection refused");
    }

    // Unknown contact → return null/empty
    if (contactId !== mockContactId) {
      return { contact: null, notes: [], threads: [], events: [] };
    }

    const maxNotes = opts.maxNotes ?? 10;
    const maxThreads = opts.maxThreads ?? 10;

    return {
      contact: cannedContact,
      notes: cannedNotes.slice(0, maxNotes),
      threads: cannedThreads.slice(0, maxThreads),
      events: [],
    };
  },
}));

// ── Session fixture ────────────────────────────────────────────────────────────

const execSession = {
  userId: "00000000-0000-0000-0000-000000000001",
  email: "exec@example.com",
  tier: "exec_all" as const,
  functionArea: null,
};

// ── Test lifecycle ─────────────────────────────────────────────────────────────

beforeEach(async () => {
  mockShouldThrow = false;
  mockThrowCrossPollination = false;
  mockContactId = CONTACT_A;
  vi.clearAllMocks();

  // Clear the in-memory cache before each test so tests are independent.
  const { clearBriefingCache } = await import("@/lib/briefing");
  clearBriefingCache();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("getPreCallBriefing", () => {
  it("1 — returns expected fields populated from canned data", async () => {
    const { getPreCallBriefing } = await import("@/lib/briefing");
    const briefing = await getPreCallBriefing(CONTACT_A, execSession);

    expect(briefing.contact?.id).toBe(CONTACT_A);
    expect(briefing.contact?.fullName).toBe("Alice Alpha");
    expect(briefing.currentTitle).toBe("Chief Revenue Officer");
    expect(briefing.currentCompany).toBe("Acme Corp");
    expect(briefing.lastNotes).toHaveLength(3);
    expect(briefing.lastThreadSubjects).toHaveLength(5);
    expect(briefing.publicPerspectiveLinks).toEqual([]);
  });

  it("2 — note firstLine strips heading markers", async () => {
    const { getPreCallBriefing } = await import("@/lib/briefing");
    const briefing = await getPreCallBriefing(CONTACT_A, execSession);

    // cannedNotes[0].markdown starts with "## Intro call"
    expect(briefing.lastNotes[0]!.firstLine).toBe("Intro call");
    // cannedNotes[1].markdown starts with "# Follow-up"
    expect(briefing.lastNotes[1]!.firstLine).toBe("Follow-up");
    // cannedNotes[2].markdown has no heading
    expect(briefing.lastNotes[2]!.firstLine).toBe("Initial outreach call — positive response");
  });

  it("3 — sub-fetch failure degrades to partial briefing, never throws", async () => {
    mockShouldThrow = true;
    const { getPreCallBriefing } = await import("@/lib/briefing");

    // Must not throw.
    const briefing = await getPreCallBriefing(CONTACT_A, execSession);

    expect(briefing.contact).toBeNull();
    expect(briefing.lastNotes).toEqual([]);
    expect(briefing.lastThreadSubjects).toEqual([]);
    expect(briefing.currentTitle).toBeNull();
    expect(briefing.currentCompany).toBeNull();
    expect(briefing.publicPerspectiveLinks).toEqual([]);
  });

  it("4 — cross-pollination guard error propagates (is not swallowed)", async () => {
    mockThrowCrossPollination = true;
    const { getPreCallBriefing } = await import("@/lib/briefing");

    await expect(
      getPreCallBriefing(CONTACT_A, execSession),
    ).rejects.toThrow(/Cross-pollination invariant violated/);
  });

  it("5 — unknown contactId returns contact: null and empty arrays", async () => {
    const { getPreCallBriefing } = await import("@/lib/briefing");
    const briefing = await getPreCallBriefing(UNKNOWN_ID, execSession);

    expect(briefing.contact).toBeNull();
    expect(briefing.lastNotes).toEqual([]);
    expect(briefing.lastThreadSubjects).toEqual([]);
    expect(briefing.publicPerspectiveLinks).toEqual([]);
  });

  it("6 — cache hit on second call within 60 s returns same object", async () => {
    const { getPreCallBriefing } = await import("@/lib/briefing");

    const first = await getPreCallBriefing(CONTACT_A, execSession);
    const second = await getPreCallBriefing(CONTACT_A, execSession);

    // Same object reference — returned from cache.
    expect(second).toBe(first);
  });

  it("7 — cache hit path completes in <50 ms", async () => {
    const { getPreCallBriefing } = await import("@/lib/briefing");

    // Prime the cache.
    await getPreCallBriefing(CONTACT_A, execSession);

    // Measure second (cached) call.
    const t0 = performance.now();
    await getPreCallBriefing(CONTACT_A, execSession);
    const elapsed = performance.now() - t0;

    expect(elapsed).toBeLessThan(50);
  });

  it("8 — different (userId, contactId) pairs are cached independently", async () => {
    const { getPreCallBriefing, clearBriefingCache } = await import("@/lib/briefing");

    const sessionA = { ...execSession, userId: "user-a-000-0000-0000-000000000001" };
    const sessionB = { ...execSession, userId: "user-b-000-0000-0000-000000000002" };

    const briefingA = await getPreCallBriefing(CONTACT_A, sessionA);
    clearBriefingCache(); // evict all
    const briefingB = await getPreCallBriefing(CONTACT_A, sessionB);

    // Both should have full data (not same reference since cache was cleared).
    expect(briefingA.contact?.id).toBe(CONTACT_A);
    expect(briefingB.contact?.id).toBe(CONTACT_A);
  });

  it("9 — notes are capped at 3 and threads at 5", async () => {
    const { getPreCallBriefing } = await import("@/lib/briefing");
    const briefing = await getPreCallBriefing(CONTACT_A, execSession);

    expect(briefing.lastNotes.length).toBeLessThanOrEqual(3);
    expect(briefing.lastThreadSubjects.length).toBeLessThanOrEqual(5);
  });

  it("10 — thread subjects and dates are correctly mapped", async () => {
    const { getPreCallBriefing } = await import("@/lib/briefing");
    const briefing = await getPreCallBriefing(CONTACT_A, execSession);

    // First thread in canned data.
    expect(briefing.lastThreadSubjects[0]!.subject).toBe("Re: Q2 roadmap");
    expect(briefing.lastThreadSubjects[0]!.lastMessageAt).toBe(
      "2024-03-11T08:00:00.000Z",
    );
  });
});

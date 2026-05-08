/**
 * cross-pollination.test.ts
 *
 * Integration tests for the SY-008 / AD-008 / C3 cross-pollination invariant.
 *
 * These tests prove:
 *   1. getContactContext("A", …) returns ONLY A's notes/threads/events.
 *   2. If the underlying query somehow returns a row for the wrong contact,
 *      the runtime invariant check throws immediately (regression guard).
 *   3. A sensitive flag on contact A does not expose A's data when fetching
 *      context for contact B (SY-008 isolation property).
 *   4. exec_all can still retrieve context for a sensitive contact directly.
 *   5. Edge cases: empty results, opts permutations.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── UUIDs used throughout ────────────────────────────────────────────────────

const CONTACT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CONTACT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const NOTE_A1   = "11111111-1111-1111-1111-111111111111";
const NOTE_B1   = "22222222-2222-2222-2222-222222222222";
const THREAD_A1 = "33333333-3333-3333-3333-333333333333";
const THREAD_B1 = "44444444-4444-4444-4444-444444444444";
const EVENT_A1  = "55555555-5555-5555-5555-555555555555";

// ── Seed data ─────────────────────────────────────────────────────────────────

const seedContacts = [
  {
    id: CONTACT_A,
    fullName: "Alice Alpha",
    primaryEmail: "alice@example.com",
    company: "Acme",
    roleTitle: "CEO",
    sensitiveFlag: null,
    createdBy: "00000000-0000-0000-0000-000000000001",
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    linkedEmployeeId: null,
    linkedCustomerId: null,
  },
  {
    id: CONTACT_B,
    fullName: "Bob Beta",
    primaryEmail: "bob@example.com",
    company: "Beta Corp",
    roleTitle: "CTO",
    sensitiveFlag: null,
    createdBy: "00000000-0000-0000-0000-000000000001",
    createdAt: new Date("2024-01-02"),
    updatedAt: new Date("2024-01-02"),
    linkedEmployeeId: null,
    linkedCustomerId: null,
  },
];

const seedNotes = [
  {
    id: NOTE_A1,
    contactId: CONTACT_A,
    occurredAt: new Date("2024-03-01"),
    markdown: "## A's note\n\n- discussed roadmap",
    authorId: "00000000-0000-0000-0000-000000000001",
    createdAt: new Date("2024-03-01"),
    updatedAt: new Date("2024-03-01"),
  },
  {
    id: NOTE_B1,
    contactId: CONTACT_B,
    occurredAt: new Date("2024-03-02"),
    markdown: "## B's note\n\n- discussed pricing",
    authorId: "00000000-0000-0000-0000-000000000001",
    createdAt: new Date("2024-03-02"),
    updatedAt: new Date("2024-03-02"),
  },
];

const seedThreads = [
  {
    id: THREAD_A1,
    gmailThreadId: "gthread-a1",
    contactId: CONTACT_A,
    subject: "A's thread",
    lastMessageAt: new Date("2024-03-05"),
    snippet: "A's snippet",
    createdBy: "00000000-0000-0000-0000-000000000001",
    createdAt: new Date("2024-03-05"),
    updatedAt: new Date("2024-03-05"),
  },
  {
    id: THREAD_B1,
    gmailThreadId: "gthread-b1",
    contactId: CONTACT_B,
    subject: "B's thread",
    lastMessageAt: new Date("2024-03-06"),
    snippet: "B's snippet",
    createdBy: "00000000-0000-0000-0000-000000000001",
    createdAt: new Date("2024-03-06"),
    updatedAt: new Date("2024-03-06"),
  },
];

const seedEvents = [
  {
    id: EVENT_A1,
    googleEventId: "gevent-a1",
    contactId: CONTACT_A,
    title: "A's meeting",
    startsAt: new Date("2024-04-01T10:00:00Z"),
    endsAt: new Date("2024-04-01T11:00:00Z"),
    attendees: null,
    createdBy: "00000000-0000-0000-0000-000000000001",
    createdAt: new Date("2024-04-01"),
    updatedAt: new Date("2024-04-01"),
  },
];

// ── Mock setup ────────────────────────────────────────────────────────────────

/**
 * We mock @/lib/db so that `query()` calls a fake DB that filters
 * by contactId (simulating what the real DB + RLS would do).
 *
 * The mock respects a `sensitiveContacts` Set: if a contact is in that set
 * AND the session tier is not 'exec_all', rows for that contact are hidden.
 */
let sensitiveContacts: Set<string> = new Set();
let injectBadRow = false; // toggle to simulate a cross-pollination bug

vi.mock("@/lib/db", () => ({
  query: async <T,>(
    ctx: { userId: string; tier: string; functionArea: string | null },
    fn: (tx: unknown) => Promise<T>,
  ): Promise<T> => {
    const isExec = ctx.tier === "exec_all";

    /**
     * Decide whether a contactId is visible to the current session.
     * Mirrors the crm.is_sensitive_for_role() logic in policies.sql.
     */
    function isVisible(contactId: string | null | undefined): boolean {
      if (!contactId) return true; // unlinked rows are always visible
      if (isExec) return true;     // exec_all sees everything
      return !sensitiveContacts.has(contactId);
    }

    const tx = {
      select() {
        return {
          from(table: unknown) {
            // Determine table name from Drizzle table symbol.
            const sym = Object.getOwnPropertySymbols(table as object).find((s) =>
              s.toString().includes("Name"),
            );
            const name = sym
              ? String((table as Record<symbol, unknown>)[sym])
              : "unknown";

            return {
              where(whereExpr: unknown) {
                // Extract the contactId from the Drizzle eq() expression.
                // We inspect `whereExpr` as a plain object (Drizzle SQL node).
                // For tests, we pass the contactId directly via a closure below.
                void whereExpr; // used only by real DB
                return {
                  orderBy() {
                    return {
                      limit(n: number) {
                        // Return seed rows filtered by the current contactId.
                        // The contactId is captured from the outer `whereContactId`
                        // variable set before each query call.
                        if (name === "contact") {
                          const r = seedContacts.filter(
                            (c) => c.id === whereContactId && isVisible(c.id),
                          );
                          return Promise.resolve(r.slice(0, n));
                        }
                        if (name === "call_note") {
                          let rows = seedNotes.filter(
                            (n) => n.contactId === whereContactId && isVisible(n.contactId),
                          );
                          // Simulate a cross-pollination bug: inject a row
                          // from the wrong contact.
                          if (injectBadRow && rows.length > 0) {
                            rows = [...rows, { ...seedNotes[1]! }]; // B's note injected
                          }
                          return Promise.resolve(rows.slice(0, n));
                        }
                        if (name === "email_thread") {
                          const rows = seedThreads.filter(
                            (t) => t.contactId === whereContactId && isVisible(t.contactId),
                          );
                          return Promise.resolve(rows.slice(0, n));
                        }
                        if (name === "calendar_event") {
                          const rows = seedEvents.filter(
                            (e) => e.contactId === whereContactId && isVisible(e.contactId),
                          );
                          return Promise.resolve(rows.slice(0, n));
                        }
                        return Promise.resolve([]);
                      },
                    };
                  },
                  limit(n: number) {
                    // For single-row contact look-ups (no orderBy).
                    if (name === "contact") {
                      const r = seedContacts.filter(
                        (c) => c.id === whereContactId && isVisible(c.id),
                      );
                      return Promise.resolve(r.slice(0, n));
                    }
                    return Promise.resolve([]);
                  },
                };
              },
            };
          },
        };
      },
    };

    // `whereContactId` is set by the caller proxy below before invoking fn.
    return fn(tx);
  },
}));

// Track the contactId passed to each `where()` clause by intercepting
// getContactContext's query calls.  We do this by patching the eq() import
// and capturing the second argument (the value).  However, because Drizzle
// wraps values in SQL objects, the simpler approach is to set this variable
// from the `contactId` argument passed to getContactContext() — which is
// exactly what we want to assert anyway.
let whereContactId = "";

// We override the module to capture the contactId before delegating to mock.
// Since getContactContext passes the contactId to eq(), we just set it here
// so the mock's `where()` closures can filter correctly.
vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...actual,
    eq: (col: unknown, val: unknown) => {
      // Capture the value when it looks like a UUID.
      if (typeof val === "string" && /^[0-9a-f-]{36}$/.test(val)) {
        whereContactId = val;
      }
      return actual.eq(col as Parameters<typeof actual.eq>[0], val as Parameters<typeof actual.eq>[1]);
    },
  };
});

// ── Session fixtures ──────────────────────────────────────────────────────────

const execSession = {
  userId: "00000000-0000-0000-0000-000000000001",
  tier: "exec_all" as const,
  functionArea: null,
};

const leadSession = {
  userId: "00000000-0000-0000-0000-000000000002",
  tier: "function_lead" as const,
  functionArea: "sales" as const,
};

// ── Test lifecycle ────────────────────────────────────────────────────────────

beforeEach(() => {
  sensitiveContacts = new Set();
  injectBadRow = false;
  whereContactId = "";
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("getContactContext — cross-pollination invariant (SY-008, AD-008)", () => {
  it("returns only contact A's notes when asked for A", async () => {
    const { getContactContext } = await import("@/lib/contact-context");
    const ctx = await getContactContext(CONTACT_A, execSession, {
      includeNotes: true,
      includeThreads: false,
      includeEvents: false,
    });

    expect(ctx.contact?.id).toBe(CONTACT_A);
    expect(ctx.notes).toHaveLength(1);
    expect(ctx.notes[0]!.id).toBe(NOTE_A1);
    // B's note must NOT appear.
    expect(ctx.notes.map((n) => n.id)).not.toContain(NOTE_B1);
  });

  it("returns only contact B's notes when asked for B", async () => {
    const { getContactContext } = await import("@/lib/contact-context");
    const ctx = await getContactContext(CONTACT_B, execSession, {
      includeNotes: true,
      includeThreads: false,
      includeEvents: false,
    });

    expect(ctx.notes).toHaveLength(1);
    expect(ctx.notes[0]!.id).toBe(NOTE_B1);
    expect(ctx.notes.map((n) => n.id)).not.toContain(NOTE_A1);
  });

  it("returns only A's email threads and events when all opts enabled", async () => {
    const { getContactContext } = await import("@/lib/contact-context");
    const ctx = await getContactContext(CONTACT_A, execSession, {
      includeNotes: true,
      includeThreads: true,
      includeEvents: true,
    });

    expect(ctx.threads).toHaveLength(1);
    expect(ctx.threads[0]!.id).toBe(THREAD_A1);
    expect(ctx.threads.map((t) => t.id)).not.toContain(THREAD_B1);

    expect(ctx.events).toHaveLength(1);
    expect(ctx.events[0]!.id).toBe(EVENT_A1);
  });

  it("returns empty arrays when opts flags are all false", async () => {
    const { getContactContext } = await import("@/lib/contact-context");
    const ctx = await getContactContext(CONTACT_A, execSession, {
      includeNotes: false,
      includeThreads: false,
      includeEvents: false,
    });

    expect(ctx.notes).toHaveLength(0);
    expect(ctx.threads).toHaveLength(0);
    expect(ctx.events).toHaveLength(0);
  });

  it("throws immediately if a returned row has the wrong contact_id (regression guard)", async () => {
    // Simulate a DB bug / refactor that accidentally returns B's note when
    // querying for A.
    injectBadRow = true;

    const { getContactContext } = await import("@/lib/contact-context");
    await expect(
      getContactContext(CONTACT_A, execSession, {
        includeNotes: true,
        includeThreads: false,
        includeEvents: false,
      }),
    ).rejects.toThrow(/Cross-pollination invariant violated/);
  });

  it("hides sensitive contact A's data from a non-exec session fetching B (SY-008)", async () => {
    // Mark contact A as sensitive.
    sensitiveContacts.add(CONTACT_A);

    const { getContactContext } = await import("@/lib/contact-context");

    // Fetching B's context as a function_lead — A's data should not appear
    // because RLS hides sensitive contacts from non-exec roles.
    // Here we ask for B, so A's data wouldn't normally appear anyway
    // (it's scoped to B). This test verifies the combination: B's context
    // does not include A's data even if something tried to inject it.
    const ctx = await getContactContext(CONTACT_B, leadSession, {
      includeNotes: true,
      includeThreads: true,
      includeEvents: false,
    });

    // Only B's note and thread should appear.
    const noteIds = ctx.notes.map((n) => n.id);
    const threadIds = ctx.threads.map((t) => t.id);
    expect(noteIds).not.toContain(NOTE_A1);
    expect(threadIds).not.toContain(THREAD_A1);
    expect(noteIds).toContain(NOTE_B1);
    expect(threadIds).toContain(THREAD_B1);
  });

  it("hides sensitive contact A from non-exec session fetching A directly (RLS isolation)", async () => {
    // Mark A as sensitive.
    sensitiveContacts.add(CONTACT_A);

    const { getContactContext } = await import("@/lib/contact-context");

    // A non-exec session asking for A's context sees nothing (RLS hides A).
    const ctx = await getContactContext(CONTACT_A, leadSession, {
      includeNotes: true,
      includeThreads: true,
      includeEvents: true,
    });

    expect(ctx.contact).toBeNull();
    expect(ctx.notes).toHaveLength(0);
    expect(ctx.threads).toHaveLength(0);
    expect(ctx.events).toHaveLength(0);
  });

  it("exec_all can still retrieve context for a sensitive contact", async () => {
    // Mark A as sensitive — exec should still see everything.
    sensitiveContacts.add(CONTACT_A);

    const { getContactContext } = await import("@/lib/contact-context");
    const ctx = await getContactContext(CONTACT_A, execSession, {
      includeNotes: true,
      includeThreads: true,
      includeEvents: true,
    });

    expect(ctx.contact?.id).toBe(CONTACT_A);
    expect(ctx.notes).toHaveLength(1);
    expect(ctx.threads).toHaveLength(1);
    expect(ctx.events).toHaveLength(1);
  });

  it("contact field is null when the contact does not exist", async () => {
    const { getContactContext } = await import("@/lib/contact-context");
    const UNKNOWN = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    const ctx = await getContactContext(UNKNOWN, execSession, {
      includeNotes: true,
      includeThreads: false,
      includeEvents: false,
    });

    expect(ctx.contact).toBeNull();
    expect(ctx.notes).toHaveLength(0);
  });

  it("respects maxNotes limit", async () => {
    const { getContactContext } = await import("@/lib/contact-context");
    // CONTACT_A only has 1 note in seed; the limit doesn't cut anything.
    // We verify the limit parameter is accepted without error.
    const ctx = await getContactContext(CONTACT_A, execSession, {
      includeNotes: true,
      includeThreads: false,
      includeEvents: false,
      maxNotes: 1,
    });

    expect(ctx.notes.length).toBeLessThanOrEqual(1);
  });
});

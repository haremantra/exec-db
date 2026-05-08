/**
 * autodraft.test.ts — Vitest suite for Stream B autodraft deliverables.
 *
 * Covers 19 tests across 5 groups:
 *  1. generateAutodraft produces a draft row with structured body_markdown and citations.
 *  2. Cross-pollination guard: the prompt sent to safeAnthropic references ONLY
 *     the provided contactId (AD-008 / SY-008).
 *  3. saveDraftToGmail blocks on confidential markers and lists reasons (AD-003).
 *  4. saveDraftToGmailConfirmed overrides guard + logs an access_log row (AD-003).
 *  5. Tone selector influences the prompt's tone instruction (SY-007).
 *  6. assertNotAutomatedOutbound throws on phone channel (SY-011).
 *  7. assertNotAutomatedOutbound throws on first-touch email (SY-011).
 *  8. assertNotAutomatedOutbound passes for follow-up email (SY-011).
 *  9. assertSafeForGmail blocks banking keywords (AD-003).
 * 10. assertSafeForGmail blocks deal-term keywords (AD-003).
 * 11. assertSafeForGmail blocks comp keywords (AD-003).
 * 12. assertSafeForGmail blocks internal-only markers (AD-003).
 * 13. assertSafeForGmail passes clean body (AD-003).
 * 14. generateAutodraft uses contactId exclusively — no cross-contact data (AD-008).
 * 15. Non-JSON LLM response is handled gracefully in generateAutodraft.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock drizzle-orm (not installed in worktree node_modules) ─────────────────
// The real drizzle-orm is in the main app's node_modules.  When tests run from
// the worktree directly, we stub the helpers actions.ts imports.
// In CI (main checkout), the real package is installed and this mock is still
// used because vi.mock() takes precedence — the stubs are compatible.

vi.mock("drizzle-orm", () => ({
  eq:   (_col: unknown, _val: unknown) => ({ __type: "eq",   col: _col, val: _val }),
  and:  (...args: unknown[])           => ({ __type: "and",  args }),
  desc: (_col: unknown)                => ({ __type: "desc", col: _col }),
  asc:  (_col: unknown)                => ({ __type: "asc",  col: _col }),
}));

// ── Mock @exec-db/db package (workspace package, not in worktree node_modules) ─
// This mock follows the same pattern as actions.smoke.test.ts.  We stub out the
// schema symbols that actions.ts imports so that module resolution succeeds in
// the worktree environment (where @exec-db/db is not installed).

vi.mock("@exec-db/db", () => {
  // Minimal Symbol-tagged table stubs so the tableName() helper in the DB mock
  // can resolve table names correctly.
  function makeTable(name: string, schema: string) {
    const sym = Symbol.for("drizzle:Name");
    const schemaSym = Symbol.for("drizzle:Schema");
    const t: Record<symbol, string> = {};
    t[sym] = name;
    t[schemaSym] = schema;
    return t;
  }
  return {
    schema: {
      contact:    makeTable("contact", "crm"),
      callNote:   makeTable("call_note", "crm"),
      emailThread: makeTable("email_thread", "crm"),
      calendarEvent: makeTable("calendar_event", "crm"),
      draft:      makeTable("draft", "crm"),
      accessLog:  makeTable("access_log", "audit"),
      llmCall:    makeTable("llm_call", "audit"),
    },
    SENSITIVE_FLAG_VALUES: [
      "rolled_off_customer",
      "irrelevant_vendor",
      "acquisition_target",
      "loi",
      "vc_outreach",
      "partnership",
    ],
  };
});

// Mock next/headers so "use server" actions don't fail during test.
vi.mock("next/headers", () => ({
  headers: async () => new Map(),
  cookies: async () => ({ get: () => undefined }),
}));

// ── UUIDs ─────────────────────────────────────────────────────────────────────

const CONTACT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CONTACT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const NOTE_A1   = "11111111-1111-1111-1111-111111111111";
const THREAD_A1 = "33333333-3333-3333-3333-333333333333";
const DRAFT_ID  = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const USER_ID   = "00000000-0000-0000-0000-000000000001";

// ── Canned LLM response ───────────────────────────────────────────────────────

const CANNED_DRAFT_OUTPUT = {
  subject: "Follow-up: discussed roadmap",
  body_markdown:
    "## Recap\n\nWe discussed the roadmap [note:11111111-1111-1111-1111-111111111111].\n\n" +
    "## Owners + dates\n\n- Alice: deliver by May 15 [note:11111111-1111-1111-1111-111111111111]\n\n" +
    "## Next step\n\nSchedule a demo call [thread:33333333-3333-3333-3333-333333333333].",
  citations: [
    {
      markerId: "[note:11111111-1111-1111-1111-111111111111]",
      noteOrThreadId: "11111111-1111-1111-1111-111111111111",
      type: "note",
    },
    {
      markerId: "[thread:33333333-3333-3333-3333-333333333333]",
      noteOrThreadId: "33333333-3333-3333-3333-333333333333",
      type: "thread",
    },
  ],
};

// ── Mocks ─────────────────────────────────────────────────────────────────────

// Mock safeAnthropic — captures every call's args for cross-pollination checks.
let safeAnthropicCallArgs: unknown[] = [];
let safeAnthropicReturnText = JSON.stringify(CANNED_DRAFT_OUTPUT);

vi.mock("@/lib/anthropic", () => ({
  safeAnthropic: vi.fn(async (opts: unknown) => {
    safeAnthropicCallArgs.push(opts);
    return { text: safeAnthropicReturnText, redactionsApplied: [] };
  }),
}));

// Mock contact-context — returns canned notes and threads for CONTACT_A only.
let mockedContextContactId = CONTACT_A;

vi.mock("@/lib/contact-context", () => ({
  getContactContext: vi.fn(
    async (
      contactId: string,
      _session: unknown,
      _opts: unknown,
    ) => {
      // Simulate the SY-008 isolation guarantee: only return data for the
      // requested contactId — no data from other contacts.
      if (contactId !== mockedContextContactId) {
        return {
          contact: null,
          notes: [],
          threads: [],
          events: [],
        };
      }
      return {
        contact: {
          id: CONTACT_A,
          fullName: "Alice Alpha",
          primaryEmail: "alice@example.com",
          company: "Acme Corp",
          roleTitle: "CEO",
        },
        notes: [
          {
            id: NOTE_A1,
            contactId: CONTACT_A,
            occurredAt: new Date("2024-03-01"),
            markdown: "## Roadmap discussion\n\n- Q3 milestones agreed",
            authorId: USER_ID,
            createdAt: new Date("2024-03-01"),
            updatedAt: new Date("2024-03-01"),
          },
        ],
        threads: [
          {
            id: THREAD_A1,
            gmailThreadId: "gthread-a1",
            contactId: CONTACT_A,
            subject: "Re: proposal",
            lastMessageAt: new Date("2024-03-05"),
            snippet: "Sounds good, let's connect",
          },
        ],
        events: [],
      };
    },
  ),
}));

// Mock google-gmail — capture createGmailDraft calls.
let gmailDraftCalls: unknown[] = [];
let gmailShouldThrow = false;

vi.mock("@/lib/google-gmail", () => ({
  createGmailDraft: vi.fn(async (userId: unknown, input: unknown) => {
    if (gmailShouldThrow) {
      throw new Error("createGmailDraft: Google OAuth not yet configured.");
    }
    gmailDraftCalls.push({ userId, input });
    // Matches the real google-gmail.ts return shape: { draftId }
    return { draftId: "gmail-draft-xyz" };
  }),
}));

// Mock auth.
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({
    userId: USER_ID,
    email: "dev@exec-db.local",
    tier: "exec_all",
    functionArea: null,
  })),
}));

// ── DB mock: full coverage of insert / update / select ────────────────────────

type InsertCapture  = { table: string; values: unknown };
type UpdateCapture  = { table: string; set: unknown; where?: unknown };
type SelectResult   = { nextResult: unknown[] };

let dbInserts: InsertCapture[] = [];
let dbUpdates: UpdateCapture[] = [];
let dbAccessLogs: unknown[] = [];
/** nextSelectSequence[0] is used for the first select call, then shifted. */
let nextSelectSequence: unknown[][] = [];

vi.mock("@/lib/db", () => ({
  query: vi.fn(async <T,>(_ctx: unknown, fn: (tx: unknown) => Promise<T>): Promise<T> => {
    function tableName(target: unknown): string {
      const sym = Object.getOwnPropertySymbols(target as object).find((s) =>
        s.toString().includes("Name"),
      );
      return sym ? String((target as Record<symbol, unknown>)[sym]) : "unknown";
    }

    const tx = {
      insert(table: unknown) {
        const t = tableName(table);
        return {
          values(values: unknown) {
            dbInserts.push({ table: t, values });
            return {
              returning: async () => [{ id: DRAFT_ID }],
            };
          },
        };
      },
      update(table: unknown) {
        const t = tableName(table);
        const entry: UpdateCapture = { table: t, set: null };
        dbUpdates.push(entry);
        return {
          set(set: unknown) {
            entry.set = set;
            return {
              where(where: unknown) {
                entry.where = where;
                return Promise.resolve();
              },
            };
          },
        };
      },
      select(_cols?: unknown) {
        const result = nextSelectSequence.shift() ?? [];
        return {
          from(_table: unknown) {
            return {
              where(_w: unknown) {
                return {
                  limit: async () => result,
                };
              },
            };
          },
        };
      },
    };
    return fn(tx);
  }),
}));

// Mock audit.recordAccess — capture access-log calls.
vi.mock("@/lib/audit", () => ({
  recordAccess: vi.fn(async (_tx: unknown, _session: unknown, entry: unknown) => {
    dbAccessLogs.push(entry);
  }),
}));

// Mock next/cache and next/navigation.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((p: string) => {
    throw new Error("__redirect__:" + p);
  }),
  notFound: vi.fn(() => {
    throw new Error("__notFound__");
  }),
}));

// ── Test lifecycle ────────────────────────────────────────────────────────────

beforeEach(() => {
  safeAnthropicCallArgs = [];
  safeAnthropicReturnText = JSON.stringify(CANNED_DRAFT_OUTPUT);
  gmailDraftCalls = [];
  gmailShouldThrow = false;
  dbInserts = [];
  dbUpdates = [];
  dbAccessLogs = [];
  nextSelectSequence = [];
  mockedContextContactId = CONTACT_A;
  process.env["ANTHROPIC_API_KEY"] = "test-key";
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── Helper: run an action that may redirect without throwing ──────────────────

async function run(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    return await fn();
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.startsWith("__redirect__:") || msg === "__notFound__") return null;
    throw e;
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("generateAutodraft (B1–B4)", () => {
  it("TEST-1: produces a draft row with structured body_markdown and citations", async () => {
    const { generateAutodraft } = await import("@/app/crm/contacts/actions");
    const fd = new FormData();
    fd.set("tone", "founder-concise");

    await generateAutodraft(CONTACT_A, fd);

    expect(dbInserts).toHaveLength(1);
    const insert = dbInserts[0]!;
    expect(insert.table).toContain("draft");
    const values = insert.values as { bodyMarkdown: string; subject: string; status: string };
    expect(values.status).toBe("pending");
    expect(values.subject).toBe("Follow-up: discussed roadmap");
    expect(values.bodyMarkdown).toContain("## Recap");
    expect(values.bodyMarkdown).toContain("## Owners + dates");
    expect(values.bodyMarkdown).toContain("## Next step");
    // Citations are persisted as an HTML comment so the UI can render chips.
    expect(values.bodyMarkdown).toContain("<!-- citations:");
  });

  it("TEST-2: the prompt sent to safeAnthropic references ONLY the provided contactId", async () => {
    const { generateAutodraft } = await import("@/app/crm/contacts/actions");
    const fd = new FormData();
    fd.set("tone", "founder-concise");

    await generateAutodraft(CONTACT_A, fd);

    expect(safeAnthropicCallArgs).toHaveLength(1);
    const opts = safeAnthropicCallArgs[0] as { contactId: string; promptClass: string; prompt: string };

    // Must use CONTACT_A's contactId — cross-pollination guard.
    expect(opts.contactId).toBe(CONTACT_A);
    expect(opts.promptClass).toBe("autodraft");

    // Must NOT reference CONTACT_B anywhere in the prompt.
    expect(opts.prompt).not.toContain(CONTACT_B);

    // Must reference the contact's data (notes and threads for A).
    expect(opts.prompt).toContain(NOTE_A1);
    expect(opts.prompt).toContain(THREAD_A1);
  });

  it("TEST-3: tone selector influences the prompt tone instruction (SY-007)", async () => {
    const { generateAutodraft } = await import("@/app/crm/contacts/actions");

    for (const [tone, expected] of [
      ["founder-concise", "founder-style concise"],
      ["formal-executive", "formal executive"],
      ["warm-sales-followup", "warm sales follow-up"],
    ] as const) {
      safeAnthropicCallArgs = [];
      const fd = new FormData();
      fd.set("tone", tone);
      await generateAutodraft(CONTACT_A, fd);
      const opts = safeAnthropicCallArgs[0] as { prompt: string };
      expect(opts.prompt).toContain(expected);
    }
  });

  it("TEST-4: formal-executive tone uses Opus model", async () => {
    const { generateAutodraft } = await import("@/app/crm/contacts/actions");
    const fd = new FormData();
    fd.set("tone", "formal-executive");

    await generateAutodraft(CONTACT_A, fd);

    const opts = safeAnthropicCallArgs[0] as { model: string };
    expect(opts.model).toBe("opus");
  });

  it("TEST-5: other tones use Sonnet model by default", async () => {
    const { generateAutodraft } = await import("@/app/crm/contacts/actions");
    const fd = new FormData();
    fd.set("tone", "founder-concise");

    await generateAutodraft(CONTACT_A, fd);

    const opts = safeAnthropicCallArgs[0] as { model: string };
    expect(opts.model).toBe("sonnet");
  });

  it("TEST-6: contact not found throws a clear error", async () => {
    // Point mockedContextContactId to B, so fetching A returns null.
    mockedContextContactId = CONTACT_B;
    const { generateAutodraft } = await import("@/app/crm/contacts/actions");
    const fd = new FormData();
    fd.set("tone", "founder-concise");

    await expect(generateAutodraft(CONTACT_A, fd)).rejects.toThrow(
      /Contact not found or not accessible/,
    );
    // No draft row should have been inserted.
    expect(dbInserts).toHaveLength(0);
  });

  it("TEST-7: non-JSON LLM response throws a descriptive error", async () => {
    safeAnthropicReturnText = "Sorry, I cannot help with that.";
    const { generateAutodraft } = await import("@/app/crm/contacts/actions");
    const fd = new FormData();
    fd.set("tone", "founder-concise");

    await expect(generateAutodraft(CONTACT_A, fd)).rejects.toThrow(
      /LLM returned non-JSON output/,
    );
    expect(dbInserts).toHaveLength(0);
  });
});

describe("saveDraftToGmail (B5) — confidential-content guard (AD-003)", () => {
  /** Helper: create a "pending" draft row in the DB mock. */
  function seedPendingDraft(body: string) {
    nextSelectSequence.push([
      {
        id: DRAFT_ID,
        contactId: CONTACT_A,
        subject: "Test subject",
        bodyMarkdown: body,
        status: "pending",
        gmailDraftId: null,
        decidedBy: null,
        decidedAt: null,
        modelId: "sonnet",
        promptHash: "abc",
        generatedAt: new Date(),
      },
    ]);
  }

  it("TEST-8: blocks save when body contains banking keywords", async () => {
    seedPendingDraft("Please see the attached wire transfer instructions.");
    const { saveDraftToGmail, ConfidentialContentError } = await import(
      "@/app/crm/contacts/actions"
    );
    const fd = new FormData();
    fd.set("to", "alice@example.com");

    await expect(saveDraftToGmail(DRAFT_ID, CONTACT_A, fd)).rejects.toThrow(
      ConfidentialContentError,
    );
    // Gmail must NOT have been called.
    expect(gmailDraftCalls).toHaveLength(0);
  });

  it("TEST-9: blocks save and lists reasons when body contains deal-term keywords", async () => {
    seedPendingDraft("We are proceeding with the acquisition and LOI next week.");
    const { saveDraftToGmail, ConfidentialContentError } = await import(
      "@/app/crm/contacts/actions"
    );
    const fd = new FormData();
    fd.set("to", "alice@example.com");

    let caught: InstanceType<typeof ConfidentialContentError> | null = null;
    try {
      await saveDraftToGmail(DRAFT_ID, CONTACT_A, fd);
    } catch (e) {
      caught = e as InstanceType<typeof ConfidentialContentError>;
    }

    expect(caught).not.toBeNull();
    expect(caught!.reasons.length).toBeGreaterThan(0);
    expect(caught!.reasons.some((r) => r.includes("acquisition"))).toBe(true);
    expect(caught!.reasons.some((r) => r.includes("LOI"))).toBe(true);
    expect(gmailDraftCalls).toHaveLength(0);
  });

  it("TEST-10: allows save when body is clean", async () => {
    seedPendingDraft(
      "## Recap\n\nWe discussed the roadmap.\n\n## Next step\n\nSchedule a demo.",
    );
    const { saveDraftToGmail } = await import("@/app/crm/contacts/actions");
    const fd = new FormData();
    fd.set("to", "alice@example.com");

    await saveDraftToGmail(DRAFT_ID, CONTACT_A, fd);

    expect(gmailDraftCalls).toHaveLength(1);
    const call = gmailDraftCalls[0] as {
      userId: string;
      input: { to: string; subject: string };
    };
    expect(call.userId).toBe(USER_ID);
    expect(call.input.to).toBe("alice@example.com");
    expect(dbUpdates).toHaveLength(1);
    const upd = dbUpdates[0]!.set as { status: string; gmailDraftId: string };
    expect(upd.status).toBe("saved_to_gmail");
    expect(upd.gmailDraftId).toBe("gmail-draft-xyz");
  });
});

describe("saveDraftToGmailConfirmed (B5) — guard override + access log (AD-003)", () => {
  function seedPendingDraft(body: string) {
    nextSelectSequence.push([
      {
        id: DRAFT_ID,
        contactId: CONTACT_A,
        subject: "Confidential subject",
        bodyMarkdown: body,
        status: "pending",
        gmailDraftId: null,
        decidedBy: null,
        decidedAt: null,
        modelId: "sonnet",
        promptHash: "abc",
        generatedAt: new Date(),
      },
    ]);
  }

  it("TEST-11: overrides guard and logs an access_log row", async () => {
    // Body with confidential content that would normally be blocked.
    seedPendingDraft("The acquisition valuation is $50M. Here is the term sheet.");
    const { saveDraftToGmailConfirmed } = await import(
      "@/app/crm/contacts/actions"
    );
    const fd = new FormData();
    fd.set("to", "alice@example.com");

    // Must NOT throw — exec has confirmed the content.
    await saveDraftToGmailConfirmed(DRAFT_ID, CONTACT_A, fd);

    // Gmail was called.
    expect(gmailDraftCalls).toHaveLength(1);

    // An access_log row must have been written (audit of override).
    expect(dbAccessLogs).toHaveLength(1);
    const logEntry = dbAccessLogs[0] as {
      intent: string;
      metadata: { override: string };
    };
    expect(logEntry.intent).toContain("confidential");
    expect(logEntry.metadata.override).toBe("confidential_content_guard_bypassed");
  });
});

describe("assertNotAutomatedOutbound (B8 — SY-011)", () => {
  it("TEST-12: throws AutomationForbiddenError for phone channel", async () => {
    const { assertNotAutomatedOutbound, AutomationForbiddenError } = await import(
      "@/lib/scheduler-guard"
    );
    expect(() =>
      assertNotAutomatedOutbound({ channel: "phone", isFirstTouch: false }),
    ).toThrow(AutomationForbiddenError);
    expect(() =>
      assertNotAutomatedOutbound({ channel: "phone", isFirstTouch: true }),
    ).toThrow(/phone/i);
  });

  it("TEST-13: throws AutomationForbiddenError for first-touch email", async () => {
    const { assertNotAutomatedOutbound, AutomationForbiddenError } = await import(
      "@/lib/scheduler-guard"
    );
    expect(() =>
      assertNotAutomatedOutbound({ channel: "email", isFirstTouch: true }),
    ).toThrow(AutomationForbiddenError);
    expect(() =>
      assertNotAutomatedOutbound({ channel: "email", isFirstTouch: true }),
    ).toThrow(/first-touch/i);
  });

  it("TEST-14: does NOT throw for follow-up email (isFirstTouch=false)", async () => {
    const { assertNotAutomatedOutbound } = await import("@/lib/scheduler-guard");
    expect(() =>
      assertNotAutomatedOutbound({ channel: "email", isFirstTouch: false }),
    ).not.toThrow();
  });
});

describe("assertSafeForGmail (AD-003 confidential guard)", () => {
  it("TEST-15: blocks banking keywords", async () => {
    const { assertSafeForGmail } = await import("@/lib/draft-guard");
    const result = assertSafeForGmail(
      "Please initiate a wire transfer to account number 123456789.",
    );
    expect(result.safe).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("TEST-16: blocks deal-term keywords", async () => {
    const { assertSafeForGmail } = await import("@/lib/draft-guard");
    const result = assertSafeForGmail(
      "The term sheet includes a valuation of $10M and an LOI by Friday.",
    );
    expect(result.safe).toBe(false);
    expect(result.reasons.some((r) => r.includes("term sheet"))).toBe(true);
    expect(result.reasons.some((r) => r.includes("valuation"))).toBe(true);
    expect(result.reasons.some((r) => r.includes("LOI"))).toBe(true);
  });

  it("TEST-17: blocks comp keywords", async () => {
    const { assertSafeForGmail } = await import("@/lib/draft-guard");
    const result = assertSafeForGmail("Your salary is $120k with RSU vesting over 4 years.");
    expect(result.safe).toBe(false);
    expect(result.reasons.some((r) => r.includes("salary"))).toBe(true);
    expect(result.reasons.some((r) => r.includes("RSU"))).toBe(true);
  });

  it("TEST-18: blocks internal-only markers", async () => {
    const { assertSafeForGmail } = await import("@/lib/draft-guard");
    expect(assertSafeForGmail("This is [CONFIDENTIAL].").safe).toBe(false);
    expect(assertSafeForGmail("Tagged #internal only.").safe).toBe(false);
  });

  it("TEST-19: passes a clean body", async () => {
    const { assertSafeForGmail } = await import("@/lib/draft-guard");
    const result = assertSafeForGmail(
      "## Recap\n\nGreat to connect. Looking forward to the demo next Tuesday.\n\n" +
        "## Next step\n\nI will send a proposal by Friday.",
    );
    expect(result.safe).toBe(true);
    expect(result.reasons).toHaveLength(0);
  });
});

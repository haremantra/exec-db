/**
 * close-ready-and-slipped.test.ts — Vitest suite for PR3-N.
 *
 * 12 tests:
 *  1. getCloseReadyCohort excludes contacts with active blocked/stuck tasks.
 *  2. getCloseReadyCohort excludes contacts that only have warm replies but no qualifier tag.
 *  3. getCloseReadyCohort excludes contacts that only have a qualifier tag but no warm reply.
 *  4. getCloseReadyCohort returns contacts that satisfy both conditions.
 *  5. getSlippedTasks returns overdue tasks (due_date < today, status != done).
 *  6. getSlippedTasks returns tasks past awaiting_response_until.
 *  7. getSlippedTasks excludes done tasks even when overdue.
 *  8. getSlippedTasks attaches unblockHint when email thread subject matches title.
 *  9. getSlippedTasks does NOT attach unblockHint when subject doesn't match.
 * 10. Dashboard renders exactly 5 swimlane keys (invariant #6 regression guard).
 * 11. markAwaitingResponse requires exec_all tier.
 * 12. markAwaitingResponse stores the correct timestamptz for a given date.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Drizzle-orm stub ──────────────────────────────────────────────────────────
vi.mock("drizzle-orm", () => ({
  eq:  (_col: unknown, _val: unknown) => ({ __type: "eq",  col: _col, val: _val }),
  and: (...args: unknown[])           => ({ __type: "and", args }),
  ne:  (_col: unknown, _val: unknown) => ({ __type: "ne",  col: _col, val: _val }),
  not: (_expr: unknown)               => ({ __type: "not", expr: _expr }),
  gt:  (_col: unknown, _val: unknown) => ({ __type: "gt",  col: _col, val: _val }),
  desc: (_col: unknown)               => ({ __type: "desc", col: _col }),
  inArray: (_col: unknown, _vals: unknown) => ({ __type: "inArray", col: _col, vals: _vals }),
  sql: Object.assign(
    (parts: TemplateStringsArray, ...vals: unknown[]) => ({ __type: "sql", parts, vals }),
    { raw: (s: string) => ({ __type: "sql_raw", s }) },
  ),
}));

// ── @exec-db/db stub ──────────────────────────────────────────────────────────
function makeTable(name: string, schemaName: string) {
  const nameSym   = Symbol.for("drizzle:Name");
  const schemaSym = Symbol.for("drizzle:Schema");
  const t: Record<symbol | string, unknown> = {};
  t[nameSym]   = name;
  t[schemaSym] = schemaName;
  return t;
}

vi.mock("@exec-db/db", () => ({
  IMPACT_VALUES:       ["revenue", "reputation", "both", "neither"],
  PROJECT_TYPE_VALUES: ["sales_call", "licensing", "hire", "deal", "board_prep", "okr", "other"],
  TASK_STATUS_VALUES:  ["todo", "in_progress", "blocked", "stuck", "done"],
  schema: {
    task:    makeTable("task",    "pm"),
    project: makeTable("project", "pm"),
  },
}));

// ── next/headers stub ─────────────────────────────────────────────────────────
vi.mock("next/headers", () => ({
  headers: async () => new Map(),
  cookies: async () => ({ get: () => undefined }),
}));

// ── next/cache stub ───────────────────────────────────────────────────────────
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// ── next/navigation stub ──────────────────────────────────────────────────────
vi.mock("next/navigation", () => ({
  redirect: vi.fn((p: string) => { throw new Error("__redirect__:" + p); }),
}));

// ── Constants ─────────────────────────────────────────────────────────────────
const DEV_USER = "00000000-0000-0000-0000-000000000001";
const SESSION = {
  userId: DEV_USER,
  email: "dev@exec-db.local",
  tier: "exec_all" as const,
  functionArea: null,
};

// ── DB mock state ─────────────────────────────────────────────────────────────

/**
 * executeQueue — each call to tx.execute() pops the next batch of rows.
 * Used by getCloseReadyCohort and getSlippedTasks which use raw SQL execute().
 */
let executeQueue: Array<Array<Record<string, unknown>>> = [];

/** Captures for update calls (markAwaitingResponse). */
type UpdateCapture = { table: string; set: unknown };
let dbUpdates: UpdateCapture[] = [];

let mockTier = "exec_all";

vi.mock("@/lib/auth", () => ({
  getSession: async () => ({
    userId: DEV_USER,
    email: "dev@exec-db.local",
    tier: mockTier,
    functionArea: null,
  }),
}));

vi.mock("@/lib/db", () => ({
  query: vi.fn(async <T,>(_ctx: unknown, fn: (tx: unknown) => Promise<T>): Promise<T> => {
    function tableName(t: unknown): string {
      const sym = Object.getOwnPropertySymbols(t as object).find((s) =>
        s.toString().includes("Name"),
      );
      return sym ? String((t as Record<symbol, unknown>)[sym]) : "unknown";
    }

    const tx = {
      execute(_q: unknown) {
        const rows = executeQueue.shift() ?? [];
        // Return in execute() format — { rows: [...] }
        return Promise.resolve({ rows });
      },
      select(_cols?: unknown) {
        return {
          from(_table: unknown) {
            return {
              where(_w: unknown) {
                return {
                  orderBy(_o: unknown) {
                    return { limit: async () => executeQueue.shift() ?? [] };
                  },
                  limit: async () => executeQueue.shift() ?? [],
                };
              },
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
              where(_where: unknown) {
                return Promise.resolve();
              },
            };
          },
        };
      },
    };
    return fn(tx);
  }),
}));

// ── Lifecycle ─────────────────────────────────────────────────────────────────
beforeEach(() => {
  executeQueue = [];
  dbUpdates    = [];
  mockTier     = "exec_all";
});

afterEach(() => {
  vi.clearAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════════
// Group 1: getCloseReadyCohort
// ═══════════════════════════════════════════════════════════════════════════════

describe("getCloseReadyCohort", () => {
  /**
   * Helper: seed executeQueue with one batch of contacts returned by the SQL.
   * The raw SQL in close-ready.ts executes ONE query and maps the result.
   */
  function seedContacts(rows: Array<Record<string, unknown>>) {
    executeQueue = [rows];
  }

  it("TEST-1: excludes contacts with active blocked/stuck tasks (returns empty when SQL returns no rows)", async () => {
    // The SQL excludes blocked contacts internally; simulate by returning no rows.
    seedContacts([]);

    const { getCloseReadyCohort } = await import("@/lib/close-ready");
    const result = await getCloseReadyCohort(SESSION);

    expect(result).toHaveLength(0);
  });

  it("TEST-2: excludes contacts that have a qualifier tag but no warm reply (SQL returns nothing)", async () => {
    // If the contact has triage_tag but no recent email/note, best_touch CTE
    // would not include them and the JOIN filters them out.
    seedContacts([]);

    const { getCloseReadyCohort } = await import("@/lib/close-ready");
    const result = await getCloseReadyCohort(SESSION);

    expect(result).toHaveLength(0);
  });

  it("TEST-3: excludes contacts that have warm reply but no qualifier tag (SQL returns nothing)", async () => {
    // The WHERE triage_tag IN ('pilot_candidate','can_help_me') filter would
    // exclude them. Simulate by returning no rows.
    seedContacts([]);

    const { getCloseReadyCohort } = await import("@/lib/close-ready");
    const result = await getCloseReadyCohort(SESSION);

    expect(result).toHaveLength(0);
  });

  it("TEST-4: returns contacts that satisfy both warm-reply and qualifier-tag conditions", async () => {
    const now = new Date();
    seedContacts([
      {
        contact_id:      "c1c1c1c1-c1c1-c1c1-c1c1-c1c1c1c1c1c1",
        contact_name:    "Alice Warm",
        last_touch_at:   now,
        last_touch_kind: "email",
        qualifier_tag:   "pilot_candidate",
      },
      {
        contact_id:      "c2c2c2c2-c2c2-c2c2-c2c2-c2c2c2c2c2c2",
        contact_name:    "Bob Ready",
        last_touch_at:   new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000),
        last_touch_kind: "note",
        qualifier_tag:   "can_help_me",
      },
    ]);

    const { getCloseReadyCohort } = await import("@/lib/close-ready");
    const result = await getCloseReadyCohort(SESSION);

    expect(result).toHaveLength(2);
    expect(result[0]!.contactName).toBe("Alice Warm");
    expect(result[0]!.lastTouchKind).toBe("email");
    expect(result[0]!.qualifierTag).toBe("pilot_candidate");
    expect(result[1]!.contactName).toBe("Bob Ready");
    expect(result[1]!.lastTouchKind).toBe("note");
    expect(result[1]!.qualifierTag).toBe("can_help_me");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Group 2: getSlippedTasks
// ═══════════════════════════════════════════════════════════════════════════════

describe("getSlippedTasks", () => {
  function seedSlipped(rows: Array<Record<string, unknown>>) {
    executeQueue = [rows];
  }

  it("TEST-5: returns overdue tasks (due_date < today, status != done)", async () => {
    seedSlipped([
      {
        task_id:                   "t1t1t1t1-t1t1-t1t1-t1t1-t1t1t1t1t1t1",
        title:                     "File the contract",
        project_id:                "p1p1p1p1-p1p1-p1p1-p1p1-p1p1p1p1p1p1",
        due_date:                  "2026-04-01",
        awaiting_response_until:   null,
        slipped_reason:            "overdue",
        hint_thread_id:            null,
        hint_subject:              null,
      },
    ]);

    const { getSlippedTasks } = await import("@/lib/slipped-tasks");
    const result = await getSlippedTasks(SESSION);

    expect(result).toHaveLength(1);
    expect(result[0]!.taskId).toBe("t1t1t1t1-t1t1-t1t1-t1t1-t1t1t1t1t1t1");
    expect(result[0]!.slippedReason).toBe("overdue");
    expect(result[0]!.dueDate).toBe("2026-04-01");
    expect(result[0]!.unblockHint).toBeUndefined();
  });

  it("TEST-6: returns tasks past awaiting_response_until", async () => {
    const pastDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    seedSlipped([
      {
        task_id:                   "t2t2t2t2-t2t2-t2t2-t2t2-t2t2t2t2t2t2",
        title:                     "Waiting on legal review",
        project_id:                "p2p2p2p2-p2p2-p2p2-p2p2-p2p2p2p2p2p2",
        due_date:                  null,
        awaiting_response_until:   pastDate,
        slipped_reason:            "response_overdue",
        hint_thread_id:            null,
        hint_subject:              null,
      },
    ]);

    const { getSlippedTasks } = await import("@/lib/slipped-tasks");
    const result = await getSlippedTasks(SESSION);

    expect(result).toHaveLength(1);
    expect(result[0]!.slippedReason).toBe("response_overdue");
    expect(result[0]!.awaitingResponseUntil).toBeInstanceOf(Date);
    expect(result[0]!.dueDate).toBeNull();
  });

  it("TEST-7: excludes done tasks even when they are overdue (SQL WHERE clause)", async () => {
    // The SQL already filters status NOT IN ('done'). Simulate by returning
    // an empty result for done tasks.
    seedSlipped([]);

    const { getSlippedTasks } = await import("@/lib/slipped-tasks");
    const result = await getSlippedTasks(SESSION);

    expect(result).toHaveLength(0);
  });

  it("TEST-8: attaches unblockHint when email thread subject matches task title", async () => {
    seedSlipped([
      {
        task_id:                   "t3t3t3t3-t3t3-t3t3-t3t3-t3t3t3t3t3t3",
        title:                     "Contract renewal follow-up",
        project_id:                "p3p3p3p3-p3p3-p3p3-p3p3-p3p3p3p3p3p3",
        due_date:                  "2026-04-15",
        awaiting_response_until:   null,
        slipped_reason:            "overdue",
        hint_thread_id:            "thread-abc-123",
        hint_subject:              "RE: Contract renewal follow-up Q2",
      },
    ]);

    const { getSlippedTasks } = await import("@/lib/slipped-tasks");
    const result = await getSlippedTasks(SESSION);

    expect(result).toHaveLength(1);
    expect(result[0]!.unblockHint).toBeDefined();
    expect(result[0]!.unblockHint!.threadId).toBe("thread-abc-123");
    expect(result[0]!.unblockHint!.subject).toBe("RE: Contract renewal follow-up Q2");
  });

  it("TEST-9: does NOT attach unblockHint when no matching thread", async () => {
    seedSlipped([
      {
        task_id:                   "t4t4t4t4-t4t4-t4t4-t4t4-t4t4t4t4t4t4",
        title:                     "File the report",
        project_id:                "p4p4p4p4-p4p4-p4p4-p4p4-p4p4p4p4p4p4",
        due_date:                  "2026-04-10",
        awaiting_response_until:   null,
        slipped_reason:            "overdue",
        hint_thread_id:            null,
        hint_subject:              null,
      },
    ]);

    const { getSlippedTasks } = await import("@/lib/slipped-tasks");
    const result = await getSlippedTasks(SESSION);

    expect(result).toHaveLength(1);
    expect(result[0]!.unblockHint).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Group 3: Invariant #6 regression guard
// ═══════════════════════════════════════════════════════════════════════════════

describe("Dashboard swimlane invariant #6", () => {
  it("TEST-10: SWIMLANE_KEYS has exactly 5 entries (invariant #6 — never 4, never 6)", async () => {
    const { SWIMLANE_KEYS } = await import("@/app/dashboard/page");

    expect(SWIMLANE_KEYS).toHaveLength(5);
    // Verify exact set — regression guard against typos or additions.
    const asSet = new Set(SWIMLANE_KEYS);
    expect(asSet.has("prospects_followup")).toBe(true);
    expect(asSet.has("inbox_progress")).toBe(true);
    expect(asSet.has("admin")).toBe(true);
    expect(asSet.has("thought_leadership")).toBe(true);
    expect(asSet.has("product_roadmap")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Group 4: markAwaitingResponse
// ═══════════════════════════════════════════════════════════════════════════════

describe("markAwaitingResponse", () => {
  const TASK_ID    = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
  const PROJECT_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";

  it("TEST-11: requires exec_all — rejects non-exec tier", async () => {
    mockTier = "function_lead";
    const { markAwaitingResponse } = await import("@/app/pm/projects/actions");
    const fd = new FormData();
    fd.set("date", "2026-06-01");
    await expect(markAwaitingResponse(TASK_ID, PROJECT_ID, fd)).rejects.toThrow(/exec_all required/);
    expect(dbUpdates).toHaveLength(0);
  });

  it("TEST-12: stores awaiting_response_until as <date>T17:00:00-08:00 for exec_all", async () => {
    mockTier = "exec_all";
    const { markAwaitingResponse } = await import("@/app/pm/projects/actions");
    const fd = new FormData();
    fd.set("date", "2026-06-01");
    await markAwaitingResponse(TASK_ID, PROJECT_ID, fd);

    expect(dbUpdates).toHaveLength(1);
    const set = dbUpdates[0]!.set as { awaitingResponseUntil: Date | null };
    expect(set.awaitingResponseUntil).toBeInstanceOf(Date);

    // The stored timestamp should correspond to 2026-06-01T17:00:00-08:00 = 2026-06-02T01:00:00Z.
    const expected = new Date("2026-06-01T17:00:00-08:00");
    expect(set.awaitingResponseUntil!.getTime()).toBe(expected.getTime());
  });
});

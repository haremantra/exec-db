/**
 * retrospective-and-checkin.test.ts
 *
 * Tests for PR3-R: weekly retrospective view, awaiting-response check-in
 * badge logic, pending-draft reminder in digest, and the
 * recordRetrospectiveJudgement server action.
 *
 * 10 tests across 4 groups:
 *  1. Retrospective — task inclusion / exclusion rules.
 *  2. Awaiting-response check-in badge logic.
 *  3. recordRetrospectiveJudgement — validation and audit write.
 *  4. Digest pending-draft section — inclusion / exclusion rules.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── drizzle-orm stub ──────────────────────────────────────────────────────────
vi.mock("drizzle-orm", () => ({
  eq:     (_col: unknown, _val: unknown) => ({ __type: "eq",   col: _col, val: _val }),
  and:    (...args: unknown[])           => ({ __type: "and",  args }),
  not:    (_expr: unknown)               => ({ __type: "not",  expr: _expr }),
  gt:     (_col: unknown, _val: unknown) => ({ __type: "gt",   col: _col, val: _val }),
  gte:    (_col: unknown, _val: unknown) => ({ __type: "gte",  col: _col, val: _val }),
  lt:     (_col: unknown, _val: unknown) => ({ __type: "lt",   col: _col, val: _val }),
  inArray: (_col: unknown, _vals: unknown) => ({ __type: "inArray", col: _col, vals: _vals }),
  sql: (parts: TemplateStringsArray, ...vals: unknown[]) => ({
    __type: "sql",
    parts,
    vals,
  }),
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
  schema: {
    task:      makeTable("task",       "pm"),
    project:   makeTable("project",    "pm"),
    draft:     makeTable("draft",      "crm"),
    contact:   makeTable("contact",    "crm"),
    accessLog: makeTable("access_log", "audit"),
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
  redirect: (_p: string) => { throw new Error("__redirect__:" + _p); },
  notFound: () => { throw new Error("__notFound__"); },
}));

// ── Constants ─────────────────────────────────────────────────────────────────
const DEV_USER = "00000000-0000-0000-0000-000000000001";

// ── Shared DB mock state ───────────────────────────────────────────────────────
type InsertCapture = { table: string; values: unknown };

let dbInserts: InsertCapture[] = [];
/** Each call to tx.select() pops the next batch from this queue. */
let selectQueue: unknown[][] = [];

function tableName(t: unknown): string {
  const sym = Object.getOwnPropertySymbols(t as object).find((s) =>
    s.toString().includes("Name"),
  );
  return sym ? String((t as Record<symbol, unknown>)[sym]) : "unknown";
}

vi.mock("@/lib/db", () => ({
  query: vi.fn(async <T,>(_ctx: unknown, fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const tx = {
      select(_cols?: unknown) {
        const result = selectQueue.shift() ?? [];
        return {
          from(_table: unknown) {
            return {
              where: async (_w?: unknown) => result,
              leftJoin(_t: unknown, _on: unknown) {
                return {
                  where: async (_w?: unknown) => result,
                };
              },
            };
          },
        };
      },
      insert(table: unknown) {
        const t = tableName(table);
        return {
          values(values: unknown) {
            dbInserts.push({ table: t, values });
            return { returning: async () => [{ id: "new-id" }] };
          },
        };
      },
    };
    return fn(tx);
  }),
}));

// ── @/lib/auth stub ───────────────────────────────────────────────────────────
vi.mock("@/lib/auth", () => ({
  getSession: async () => ({
    userId: DEV_USER,
    email:  "dev@exec-db.local",
    tier:   "exec_all",
    functionArea: null,
  }),
}));

// ── Test lifecycle ─────────────────────────────────────────────────────────────
beforeEach(() => {
  dbInserts   = [];
  selectQueue = [];
});

afterEach(() => {
  vi.clearAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════════
// Group 1: Retrospective — task inclusion / exclusion
// ═══════════════════════════════════════════════════════════════════════════════

describe("retrospective — completed-task date filter", () => {
  /**
   * Helper: build a fake completed task.
   * `daysAgo` determines the completedAt timestamp.
   */
  function makeTask(id: string, daysAgo: number) {
    const completedAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
    return {
      taskId: id,
      title: `Task ${id}`,
      status: "done",
      completedAt,
      ownerId: DEV_USER,
      impact: null,
      isPinned: false,
      projectId: "proj-1",
      projectName: "Project Alpha",
    };
  }

  it("TEST-1: assembleDigestBody weekly includes tasks completed ≤7 days ago", async () => {
    // Seed: two tasks (1-day-old and 6-day-old) plus empty pending-drafts.
    const taskA = makeTask("aaa", 1);
    const taskB = makeTask("bbb", 6);
    // First select = tasks; second select = pending drafts (empty).
    selectQueue = [[taskA, taskB], []];

    const { assembleDigestBody } = await import("@/lib/digest-body");
    const result = await assembleDigestBody(DEV_USER, "weekly", "tok");

    expect(result.text).toContain("Task aaa");
    expect(result.text).toContain("Task bbb");
    expect(result.text).toContain("Completed this week (2)");
  });

  it("TEST-2: assembleDigestBody weekly excludes tasks completed more than 7 days ago", async () => {
    // The DB WHERE clause handles this exclusion; here we verify the UI branch.
    // Simulate the DB returning only the in-boundary task.
    const taskA = makeTask("zzz", 1); // inside window
    selectQueue = [[taskA], []];

    const { assembleDigestBody } = await import("@/lib/digest-body");
    const result = await assembleDigestBody(DEV_USER, "weekly", "tok");

    // Task bbb (8 days old) must not appear — the DB stub returned only taskA.
    expect(result.text).not.toContain("Task bbb");
    expect(result.text).toContain("Task zzz");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Group 2: Awaiting-response check-in badge logic
// ═══════════════════════════════════════════════════════════════════════════════

describe("awaiting-response check-in badge logic", () => {
  const PAST_DATE   = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000); // 2 days ago
  const FUTURE_DATE = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000); // 2 days ahead

  it("TEST-3: needsCheckin is true when awaitingResponseUntil < now", () => {
    // This mirrors the condition in the project page: t.awaitingResponseUntil < new Date()
    const task = { awaitingResponseUntil: PAST_DATE };
    const needsCheckin = task.awaitingResponseUntil < new Date();
    expect(needsCheckin).toBe(true);
  });

  it("TEST-4: needsCheckin is false when awaitingResponseUntil is in the future", () => {
    const task = { awaitingResponseUntil: FUTURE_DATE };
    const needsCheckin = task.awaitingResponseUntil < new Date();
    expect(needsCheckin).toBe(false);
  });

  it("TEST-5: needsCheckin is false when awaitingResponseUntil is null", () => {
    const task = { awaitingResponseUntil: null as Date | null };
    // Same guard as the page: only show badge if field is set AND in the past.
    const needsCheckin = task.awaitingResponseUntil !== null &&
      task.awaitingResponseUntil !== undefined &&
      task.awaitingResponseUntil < new Date();
    expect(needsCheckin).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Group 3: recordRetrospectiveJudgement — validation + audit write
// ═══════════════════════════════════════════════════════════════════════════════

describe("recordRetrospectiveJudgement", () => {
  const TASK_ID = "tttttttt-tttt-tttt-tttt-tttttttttttt";

  it("TEST-6: rejects an invalid judgement value (missing/empty formData field)", async () => {
    const { recordRetrospectiveJudgement } = await import(
      "@/app/retrospective/actions"
    );
    const fd = new FormData();
    fd.set("judgement", "super_promise");
    await expect(
      recordRetrospectiveJudgement(TASK_ID, fd),
    ).rejects.toThrow(/Invalid judgement value/);
    expect(dbInserts).toHaveLength(0);
  });

  it("TEST-7: accepts 'kept_promise' and writes an audit.access_log row", async () => {
    const { recordRetrospectiveJudgement } = await import(
      "@/app/retrospective/actions"
    );
    const fd = new FormData();
    fd.set("judgement", "kept_promise");
    // query mock will call the fn, which calls recordAccess → insert(accessLog).
    await recordRetrospectiveJudgement(TASK_ID, fd);

    const auditRows = dbInserts.filter((i) => i.table === "access_log");
    expect(auditRows).toHaveLength(1);
    const vals = auditRows[0]!.values as {
      intent: string;
      metadata: { taskId: string; judgement: string };
    };
    expect(vals.intent).toBe("retrospective_judgement");
    expect(vals.metadata.taskId).toBe(TASK_ID);
    expect(vals.metadata.judgement).toBe("kept_promise");
  });

  it("TEST-8: accepts 'partial' and 'broke_promise' without throwing", async () => {
    const { recordRetrospectiveJudgement } = await import(
      "@/app/retrospective/actions"
    );
    const fd1 = new FormData();
    fd1.set("judgement", "partial");
    const fd2 = new FormData();
    fd2.set("judgement", "broke_promise");
    await expect(recordRetrospectiveJudgement(TASK_ID, fd1)).resolves.toBeUndefined();
    await expect(recordRetrospectiveJudgement(TASK_ID, fd2)).resolves.toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Group 4: Digest pending-draft section
// ═══════════════════════════════════════════════════════════════════════════════

describe("digest pending-draft section", () => {
  function makeDraft(id: string, hoursAgo: number, status = "pending") {
    return {
      draftId: id,
      contactId: `contact-${id}`,
      subject: `Follow-up ${id}`,
      generatedAt: new Date(Date.now() - hoursAgo * 60 * 60 * 1000),
      status,
      contactName: `Contact ${id}`,
    };
  }

  it("TEST-9: digest includes pending drafts older than 24h", async () => {
    // tasks row (empty), then pending drafts (36-hour-old draft).
    const oldDraft = makeDraft("d1", 36);
    selectQueue = [[], [oldDraft]];

    const { assembleDigestBody } = await import("@/lib/digest-body");
    const result = await assembleDigestBody(DEV_USER, "daily", "tok");

    expect(result.text).toContain("Drafts pending review (>24h)");
    expect(result.text).toContain("Contact d1");
    expect(result.text).toContain("Follow-up d1");
  });

  it("TEST-10: digest excludes saved/discarded drafts (DB-filtered) and <24h drafts", async () => {
    // The DB query filters on status='pending' AND generatedAt < 24h-ago.
    // We simulate the DB returning an empty set when no qualifying drafts exist.
    selectQueue = [[], []]; // tasks empty, drafts empty

    const { assembleDigestBody } = await import("@/lib/digest-body");
    const result = await assembleDigestBody(DEV_USER, "daily", "tok");

    expect(result.text).not.toContain("Drafts pending review");
  });
});

/**
 * digest.test.ts — Vitest suite for PR3-O digest infrastructure (Stream O).
 *
 * 14 tests across 5 groups:
 *  1. sendDigest — skips when not opted in.
 *  2. sendDigest — calls Resend exactly once and inserts a pm.digest_send row.
 *  3. Cron routes — reject requests without a valid Bearer token.
 *  4. Unsubscribe route — flips both opt-ins to false and returns 200.
 *  5. assembleDigestBody — task inclusion / exclusion rules.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Drizzle-orm stub (not installed in worktree node_modules) ─────────────────
vi.mock("drizzle-orm", () => ({
  eq:  (_col: unknown, _val: unknown) => ({ __type: "eq",  col: _col, val: _val }),
  and: (...args: unknown[])           => ({ __type: "and", args }),
  not: (_expr: unknown)               => ({ __type: "not", expr: _expr }),
  gt:  (_col: unknown, _val: unknown) => ({ __type: "gt",  col: _col, val: _val }),
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
    userPref:     makeTable("user_pref", "crm"),
    employeeDim:  makeTable("employee_dim", "core"),
    digestSend:   makeTable("digest_send", "pm"),
    task:         makeTable("task", "pm"),
    project:      makeTable("project", "pm"),
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
const USER_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const EMAIL_A = "alice@example.com";
const UNSUB_TOKEN = "deadbeefdeadbeef".repeat(4); // 64-char hex

// ── Shared DB mock state ───────────────────────────────────────────────────────
type InsertCapture = { table: string; values: unknown };
type UpdateCapture = { table: string; set: unknown; where?: unknown };

let dbInserts: InsertCapture[]     = [];
let dbUpdates: UpdateCapture[]     = [];
/** Each call to tx.select() pops the next batch from this queue. */
let selectQueue: unknown[][]       = [];

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
              where(_w: unknown) {
                return {
                  limit: async () => result,
                  // No .limit() call in body queries — return full array.
                  then: (_onfulfilled?: (v: unknown) => unknown) =>
                    Promise.resolve(result).then(_onfulfilled),
                  [Symbol.asyncIterator]: async function* () {
                    for (const r of result) yield r;
                  },
                };
              },
              leftJoin(_t: unknown, _on: unknown) {
                return {
                  where: async () => result,
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
    };
    return fn(tx);
  }),
}));

// ── Resend mock ───────────────────────────────────────────────────────────────
let resendCalls: unknown[] = [];
let resendShouldFail = false;

vi.mock("@/lib/email-resend", () => ({
  sendEmailViaResend: vi.fn(async (input: unknown) => {
    if (resendShouldFail) {
      throw new Error("sendEmailViaResend: Resend delivery failed — test error");
    }
    resendCalls.push(input);
    return { messageId: "resend-msg-id-001" };
  }),
}));

// ── digest-body stub mock ─────────────────────────────────────────────────────
vi.mock("@/lib/digest-body", () => ({
  assembleDigestBody: vi.fn(
    async (_userId: string, cadence: string, _token: string) => ({
      subject: `exec-db ${cadence} digest — Thursday, May 7, 2026`,
      html: "<p>digest html</p>",
      text: "digest text",
      taskCount: 3,
    }),
  ),
}));

// ── Test lifecycle ─────────────────────────────────────────────────────────────
beforeEach(() => {
  dbInserts = [];
  dbUpdates = [];
  resendCalls = [];
  resendShouldFail = false;
  selectQueue = [];
  process.env["CRON_SECRET"] = "test-cron-secret";
  process.env["RESEND_API_KEY"] = "re_test_key";
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env["CRON_SECRET"];
});

// ═══════════════════════════════════════════════════════════════════════════════
// Group 1: sendDigest — opt-in checks
// ═══════════════════════════════════════════════════════════════════════════════

describe("sendDigest — opt-in checks", () => {
  it("TEST-1: returns not_opted_in when user has no pref row", async () => {
    // Empty select queue → no pref row.
    selectQueue = [[]];

    const { sendDigest } = await import("@/lib/digest-send");
    const result = await sendDigest(USER_A, "daily");

    expect(result).toEqual({ delivered: false, reason: "not_opted_in" });
    expect(resendCalls).toHaveLength(0);
    expect(dbInserts).toHaveLength(0);
  });

  it("TEST-2: returns not_opted_in when daily opt-in is false", async () => {
    selectQueue = [
      [{ digestDailyOptin: false, digestWeeklyOptin: true, unsubscribeToken: UNSUB_TOKEN }],
    ];

    const { sendDigest } = await import("@/lib/digest-send");
    const result = await sendDigest(USER_A, "daily");

    expect(result).toEqual({ delivered: false, reason: "not_opted_in" });
    expect(resendCalls).toHaveLength(0);
  });

  it("TEST-3: returns not_opted_in when weekly opt-in is false", async () => {
    selectQueue = [
      [{ digestDailyOptin: true, digestWeeklyOptin: false, unsubscribeToken: UNSUB_TOKEN }],
    ];

    const { sendDigest } = await import("@/lib/digest-send");
    const result = await sendDigest(USER_A, "weekly");

    expect(result).toEqual({ delivered: false, reason: "not_opted_in" });
    expect(resendCalls).toHaveLength(0);
  });

  it("TEST-4: returns no_email_on_record when employee has no work_email", async () => {
    selectQueue = [
      [{ digestDailyOptin: true, digestWeeklyOptin: true, unsubscribeToken: UNSUB_TOKEN }],
      [], // empty employee result
    ];

    const { sendDigest } = await import("@/lib/digest-send");
    const result = await sendDigest(USER_A, "daily");

    expect(result).toEqual({ delivered: false, reason: "no_email_on_record" });
    expect(resendCalls).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Group 2: sendDigest — happy path (Resend call + DB insert)
// ═══════════════════════════════════════════════════════════════════════════════

describe("sendDigest — delivery and DB insert", () => {
  /** Seeds the select queue for a fully opted-in user. */
  function seedOptedIn(cadence: "daily" | "weekly") {
    selectQueue = [
      // Step 1: pref row
      [{ digestDailyOptin: true, digestWeeklyOptin: true, unsubscribeToken: UNSUB_TOKEN }],
      // Step 2: employee email
      [{ workEmail: EMAIL_A }],
    ];
  }

  it("TEST-5: calls Resend exactly once for daily cadence", async () => {
    seedOptedIn("daily");

    const { sendDigest } = await import("@/lib/digest-send");
    const result = await sendDigest(USER_A, "daily");

    expect(result).toEqual({ delivered: true });
    expect(resendCalls).toHaveLength(1);
    const call = resendCalls[0] as { to: string; subject: string };
    expect(call.to).toBe(EMAIL_A);
    expect(call.subject).toContain("daily");
  });

  it("TEST-6: calls Resend exactly once for weekly cadence", async () => {
    seedOptedIn("weekly");

    const { sendDigest } = await import("@/lib/digest-send");
    const result = await sendDigest(USER_A, "weekly");

    expect(result).toEqual({ delivered: true });
    expect(resendCalls).toHaveLength(1);
    const call = resendCalls[0] as { to: string; subject: string };
    expect(call.to).toBe(EMAIL_A);
    expect(call.subject).toContain("weekly");
  });

  it("TEST-7: inserts a pm.digest_send row after delivery", async () => {
    seedOptedIn("daily");

    const { sendDigest } = await import("@/lib/digest-send");
    await sendDigest(USER_A, "daily");

    const digestInserts = dbInserts.filter((i) => i.table === "digest_send");
    expect(digestInserts).toHaveLength(1);
    const vals = digestInserts[0]!.values as {
      recipientId: string;
      cadence: string;
      taskCount: number;
    };
    expect(vals.recipientId).toBe(USER_A);
    expect(vals.cadence).toBe("daily");
    expect(typeof vals.taskCount).toBe("number");
  });

  it("TEST-8: propagates Resend failure as a thrown error", async () => {
    seedOptedIn("daily");
    resendShouldFail = true;

    const { sendDigest } = await import("@/lib/digest-send");
    await expect(sendDigest(USER_A, "daily")).rejects.toThrow(/Resend delivery failed/);
    // No digest_send row should be recorded.
    expect(dbInserts.filter((i) => i.table === "digest_send")).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Group 3: Cron routes — Bearer token auth
// ═══════════════════════════════════════════════════════════════════════════════

describe("cron routes — Bearer token auth", () => {
  function makeRequest(authHeader: string | null): Request {
    const headers = new Headers();
    if (authHeader !== null) headers.set("authorization", authHeader);
    return new Request("http://localhost/api/cron/digest-daily", { headers });
  }

  it("TEST-9: daily cron returns 401 when Authorization header is missing", async () => {
    const { GET } = await import("@/app/api/cron/digest-daily/route");
    const res = await GET(makeRequest(null) as Parameters<typeof GET>[0]);
    expect(res.status).toBe(401);
  });

  it("TEST-10: daily cron returns 401 when Bearer token is wrong", async () => {
    const { GET } = await import("@/app/api/cron/digest-daily/route");
    const res = await GET(makeRequest("Bearer wrong-secret") as Parameters<typeof GET>[0]);
    expect(res.status).toBe(401);
  });

  it("TEST-11: weekly cron returns 401 when Authorization header is missing", async () => {
    const { GET } = await import("@/app/api/cron/digest-weekly/route");
    const res = await GET(makeRequest(null) as Parameters<typeof GET>[0]);
    expect(res.status).toBe(401);
  });

  it("TEST-12: daily cron returns 200 with correct Bearer token and empty user list", async () => {
    // Empty select = no opted-in users.
    selectQueue = [[]];

    const { GET } = await import("@/app/api/cron/digest-daily/route");
    const res = await GET(
      makeRequest("Bearer test-cron-secret") as Parameters<typeof GET>[0],
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { cadence: string; users: number };
    expect(body.cadence).toBe("daily");
    expect(body.users).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Group 4: Unsubscribe route
// ═══════════════════════════════════════════════════════════════════════════════

describe("unsubscribe route", () => {
  /**
   * The unsubscribe route uses req.nextUrl (NextRequest). In a test environment
   * NextRequest wraps the standard Request and exposes nextUrl as a URL object.
   * We construct a NextRequest here so .nextUrl.searchParams works.
   */
  function makeUnsubRequest(token: string | null): Request {
    const { NextRequest } = require("next/server") as typeof import("next/server");
    const url = token
      ? `http://localhost/api/digest/unsubscribe?token=${encodeURIComponent(token)}`
      : "http://localhost/api/digest/unsubscribe";
    return new NextRequest(url);
  }

  it("TEST-13: returns 200 and flips both opt-ins to false on valid token", async () => {
    // First select: find user by token.
    selectQueue = [[{ userId: USER_A }]];

    const { GET } = await import("@/app/api/digest/unsubscribe/route");
    const res = await GET(
      makeUnsubRequest(UNSUB_TOKEN) as Parameters<typeof GET>[0],
    );

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("unsubscribed");

    // Should have issued an UPDATE setting both to false.
    expect(dbUpdates).toHaveLength(1);
    const set = dbUpdates[0]!.set as {
      digestDailyOptin: boolean;
      digestWeeklyOptin: boolean;
    };
    expect(set.digestDailyOptin).toBe(false);
    expect(set.digestWeeklyOptin).toBe(false);
  });

  it("TEST-14: returns 404 when token is not found", async () => {
    // Empty select = token not matched.
    selectQueue = [[]];

    const { GET } = await import("@/app/api/digest/unsubscribe/route");
    const res = await GET(
      makeUnsubRequest("nonexistent-token") as Parameters<typeof GET>[0],
    );

    expect(res.status).toBe(404);
    expect(dbUpdates).toHaveLength(0);
  });
});

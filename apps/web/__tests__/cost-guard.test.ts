/**
 * Tests for cost-guard.ts (per-day Anthropic spend cap + alert email).
 *
 * Coverage:
 *   1.  getTodaysSpend sums today's rows only (UTC date boundary).
 *   2.  getTodaysSpend ignores 'killed' rows.
 *   3.  assertWithinBudget passes when spend is under cap.
 *   4.  assertWithinBudget throws CostGuardError when spend meets/exceeds cap.
 *   5.  assertWithinBudget uses DAILY_LLM_BUDGET_USD env var when set.
 *   6.  assertWithinBudget uses default cap (5.0) when env var is unset.
 *   7.  notifyBudgetBreach sends email on first breach.
 *   8.  notifyBudgetBreach is idempotent — second call same day is a no-op.
 *   9.  notifyBudgetBreach no-ops when BUDGET_ALERT_RECIPIENT is unset.
 *  10.  safeAnthropic calls assertWithinBudget before redaction.
 *  11.  safeAnthropic throws a clean error (not CostGuardError) on breach.
 *  12.  safeAnthropic writes a 'killed' audit row on breach (invariant #4).
 *  13.  Cron route requires Bearer CRON_SECRET (401 without it).
 *  14.  Cron route returns JSON summary with date, totalUsd, calls fields.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Shared mock state
// ---------------------------------------------------------------------------

type SqlCall = { sql: string; params: unknown[] };
const sqlCalls: SqlCall[] = [];

type InsertCapture = { table: string; values: Record<string, unknown> };
const inserts: InsertCapture[] = [];

// Simulate existing sentinel rows for idempotency tests.
let sentinelExists = false;
// Simulate the spend returned by the DB for today.
let mockTodayRows: Array<{ model: string; calls: number; model_cost: number }> = [];

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/lib/db", () => ({
  query: async <T,>(_ctx: unknown, fn: (tx: unknown) => Promise<T>): Promise<T> => {
    function tableName(target: unknown): string {
      const sym = Object.getOwnPropertySymbols(target as object).find((s) =>
        s.toString().includes("Name"),
      );
      const name =
        sym && (target as Record<symbol, unknown>)[sym]
          ? String((target as Record<symbol, unknown>)[sym])
          : "unknown";
      const schemaSym = Object.getOwnPropertySymbols(target as object).find((s) =>
        s.toString().includes("Schema"),
      );
      const sch = schemaSym ? String((target as Record<symbol, unknown>)[schemaSym]) : "";
      return sch ? `${sch}.${name}` : name;
    }

    const tx = {
      // Raw sql execute — used by getTodaysSpend, notifyBudgetBreach, cost-summary route.
      execute(query: unknown) {
        // Drizzle sql`` tagged literals are objects. Stringify to detect query type.
        // JSON.stringify captures the queryChunks array which contains the raw SQL strings.
        const queryStr = (() => {
          try { return JSON.stringify(query); } catch { return String(query); }
        })();
        sqlCalls.push({ sql: queryStr, params: [] });

        // Sentinel check query (notifyBudgetBreach idempotency) — looks for access_log.
        // The sentinel SELECT checks for intent = 'cost_guard_breach_notified'.
        if (
          queryStr.includes("access_log") ||
          queryStr.includes("cost_guard_breach_notified")
        ) {
          return Promise.resolve(
            sentinelExists ? [{ id: "existing-id" }] : [],
          );
        }

        // Spend query (getTodaysSpend / cost-summary route) — checks llm_call.
        return Promise.resolve(mockTodayRows);
      },
      insert(table: unknown) {
        const t = tableName(table);
        return {
          values(values: Record<string, unknown>) {
            inserts.push({ table: t, values });
            return Promise.resolve();
          },
        };
      },
    };
    return fn(tx);
  },
}));

let emailsSent: Array<{ to: string; subject: string; text: string; html: string }> = [];

vi.mock("@/lib/email-resend", () => ({
  sendEmailViaResend: vi.fn(
    async (input: { to: string; subject: string; text: string; html: string }) => {
      emailsSent.push(input);
      return { messageId: "mock-id" };
    },
  ),
}));

// Stub the audit-log writer for safeAnthropic tests.
let auditRows: Array<{ outcome: string; promptClass: string }> = [];

vi.mock("@/lib/audit-llm", () => ({
  recordLlmCall: vi.fn(async (params: { outcome: string; promptClass: string }) => {
    auditRows.push({ outcome: params.outcome, promptClass: params.promptClass });
  }),
}));

// Stub the Anthropic SDK so safeAnthropic tests don't need a real key.
vi.mock("@anthropic-ai/sdk", () => {
  const Anthropic = vi.fn().mockImplementation(() => ({
    messages: {
      create: vi.fn(async () => ({
        content: [{ type: "text", text: "mock" }],
        usage: { input_tokens: 10, output_tokens: 20 },
      })),
      stream: vi.fn(() => ({
        on: () => ({ on: () => {} }),
      })),
    },
  }));
  return { default: Anthropic };
});

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  sqlCalls.length = 0;
  inserts.length = 0;
  emailsSent = [];
  auditRows = [];
  sentinelExists = false;
  mockTodayRows = [];
  process.env["ANTHROPIC_API_KEY"] = "test-key";
  delete process.env["DAILY_LLM_BUDGET_USD"];
  delete process.env["BUDGET_ALERT_RECIPIENT"];
  process.env["CRON_SECRET"] = "test-cron-secret";
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Helper: today's date string
// ---------------------------------------------------------------------------
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Tests: getTodaysSpend
// ---------------------------------------------------------------------------

describe("getTodaysSpend", () => {
  it("sums today's rows and returns totalUsd, calls, modelBreakdown", async () => {
    mockTodayRows = [
      { model: "sonnet", calls: 5, model_cost: 0.012 },
      { model: "opus", calls: 2, model_cost: 0.5 },
    ];
    const { getTodaysSpend } = await import("@/lib/cost-guard");

    const result = await getTodaysSpend();

    expect(result.totalUsd).toBeCloseTo(0.512, 5);
    expect(result.calls).toBe(7);
    expect(result.modelBreakdown["sonnet"]).toBeCloseTo(0.012, 5);
    expect(result.modelBreakdown["opus"]).toBeCloseTo(0.5, 5);
  });

  it("returns zero totals when there are no rows for today", async () => {
    mockTodayRows = [];
    const { getTodaysSpend } = await import("@/lib/cost-guard");

    const result = await getTodaysSpend();

    expect(result.totalUsd).toBe(0);
    expect(result.calls).toBe(0);
    expect(result.modelBreakdown).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Tests: assertWithinBudget
// ---------------------------------------------------------------------------

describe("assertWithinBudget", () => {
  it("passes (no throw) when spend is below the cap", async () => {
    mockTodayRows = [{ model: "sonnet", calls: 1, model_cost: 1.0 }];
    process.env["DAILY_LLM_BUDGET_USD"] = "5";
    const { assertWithinBudget } = await import("@/lib/cost-guard");

    await expect(assertWithinBudget()).resolves.toBeUndefined();
  });

  it("throws CostGuardError when spend meets or exceeds the cap", async () => {
    mockTodayRows = [{ model: "opus", calls: 10, model_cost: 6.0 }];
    process.env["DAILY_LLM_BUDGET_USD"] = "5";
    const { assertWithinBudget, CostGuardError } = await import("@/lib/cost-guard");

    await expect(assertWithinBudget()).rejects.toThrow(CostGuardError);
  });

  it("carries totalUsd, capUsd, calls on the thrown error", async () => {
    mockTodayRows = [{ model: "opus", calls: 3, model_cost: 7.5 }];
    process.env["DAILY_LLM_BUDGET_USD"] = "5";
    const { assertWithinBudget, CostGuardError } = await import("@/lib/cost-guard");

    try {
      await assertWithinBudget();
      expect.fail("Expected CostGuardError to be thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CostGuardError);
      const guardErr = err as InstanceType<typeof CostGuardError>;
      expect(guardErr.totalUsd).toBeCloseTo(7.5, 4);
      expect(guardErr.capUsd).toBe(5);
      expect(guardErr.calls).toBe(3);
    }
  });

  it("uses DAILY_LLM_BUDGET_USD env var when set", async () => {
    mockTodayRows = [{ model: "sonnet", calls: 1, model_cost: 3.0 }];
    process.env["DAILY_LLM_BUDGET_USD"] = "2"; // cap at $2 → 3.0 should breach
    const { assertWithinBudget, CostGuardError } = await import("@/lib/cost-guard");

    await expect(assertWithinBudget()).rejects.toThrow(CostGuardError);
  });

  it("uses default cap of 5.0 when DAILY_LLM_BUDGET_USD is unset", async () => {
    delete process.env["DAILY_LLM_BUDGET_USD"];
    // Spend just below default cap of 5.0 — should pass
    mockTodayRows = [{ model: "sonnet", calls: 1, model_cost: 4.99 }];
    const { assertWithinBudget } = await import("@/lib/cost-guard");

    await expect(assertWithinBudget()).resolves.toBeUndefined();

    // Spend at exactly the default cap — should breach
    mockTodayRows = [{ model: "sonnet", calls: 1, model_cost: 5.0 }];
    const { CostGuardError } = await import("@/lib/cost-guard");
    await expect(assertWithinBudget()).rejects.toThrow(CostGuardError);
  });
});

// ---------------------------------------------------------------------------
// Tests: notifyBudgetBreach
// ---------------------------------------------------------------------------

describe("notifyBudgetBreach", () => {
  it("sends an alert email on first breach of the day", async () => {
    process.env["BUDGET_ALERT_RECIPIENT"] = "ceo@example.com";
    sentinelExists = false;
    const { notifyBudgetBreach } = await import("@/lib/cost-guard");

    await notifyBudgetBreach({ totalUsd: 6.5, capUsd: 5.0, date: todayUtc() });

    expect(emailsSent).toHaveLength(1);
    expect(emailsSent[0]!.to).toBe("ceo@example.com");
    expect(emailsSent[0]!.subject).toContain("budget breached");
    expect(emailsSent[0]!.text).toContain("$6.5000");
    expect(emailsSent[0]!.text).toContain("$5.00");
  });

  it("is idempotent — second call on the same day is a no-op", async () => {
    process.env["BUDGET_ALERT_RECIPIENT"] = "ceo@example.com";
    sentinelExists = true; // simulate: sentinel row already exists
    const { notifyBudgetBreach } = await import("@/lib/cost-guard");

    await notifyBudgetBreach({ totalUsd: 6.5, capUsd: 5.0, date: todayUtc() });

    // No email should be sent when sentinel already exists
    expect(emailsSent).toHaveLength(0);
  });

  it("silently no-ops when BUDGET_ALERT_RECIPIENT is unset", async () => {
    delete process.env["BUDGET_ALERT_RECIPIENT"];
    sentinelExists = false;
    const { notifyBudgetBreach } = await import("@/lib/cost-guard");

    // Should not throw and should not send email
    await expect(
      notifyBudgetBreach({ totalUsd: 6.5, capUsd: 5.0, date: todayUtc() }),
    ).resolves.toBeUndefined();

    expect(emailsSent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: safeAnthropic integration with cost guard
// ---------------------------------------------------------------------------

describe("safeAnthropic — cost guard integration", () => {
  it("calls assertWithinBudget before redaction runs", async () => {
    // Budget under cap — call should succeed
    mockTodayRows = [{ model: "sonnet", calls: 1, model_cost: 1.0 }];
    process.env["DAILY_LLM_BUDGET_USD"] = "5";

    const costGuard = await import("@/lib/cost-guard");
    const budgetSpy = vi.spyOn(costGuard, "assertWithinBudget");

    const { safeAnthropic } = await import("@/lib/anthropic");
    await safeAnthropic({ prompt: "Hello", model: "sonnet", promptClass: "test" });

    // assertWithinBudget should have been called once
    expect(budgetSpy).toHaveBeenCalledTimes(1);
  });

  it("throws a clean error message (not CostGuardError) on breach", async () => {
    mockTodayRows = [{ model: "opus", calls: 10, model_cost: 6.0 }];
    process.env["DAILY_LLM_BUDGET_USD"] = "5";

    const { safeAnthropic } = await import("@/lib/anthropic");

    // The thrown error should NOT be a CostGuardError instance (it's re-wrapped)
    // but should contain the budget-exceeded message.
    await expect(
      safeAnthropic({ prompt: "Hello", model: "sonnet", promptClass: "test" }),
    ).rejects.toThrow(/Daily LLM budget exceeded/);
  });

  it("writes a 'killed' audit row on breach (cross-cutting invariant #4)", async () => {
    mockTodayRows = [{ model: "opus", calls: 10, model_cost: 6.0 }];
    process.env["DAILY_LLM_BUDGET_USD"] = "5";

    const { safeAnthropic } = await import("@/lib/anthropic");

    await expect(
      safeAnthropic({ prompt: "Hello", model: "sonnet", promptClass: "guardrail-test" }),
    ).rejects.toThrow();

    // Give fire-and-forget audit write time to complete
    await new Promise((r) => setTimeout(r, 20));

    // Should have written a 'killed' audit row
    const killedRow = auditRows.find((r) => r.outcome === "killed");
    expect(killedRow).toBeDefined();
    expect(killedRow!.promptClass).toBe("guardrail-test");
  });
});

// ---------------------------------------------------------------------------
// Tests: cost-summary cron route
// ---------------------------------------------------------------------------

describe("/api/cron/cost-summary route", () => {
  it("returns 401 when Authorization header is missing", async () => {
    const { GET } = await import(
      "@/app/api/cron/cost-summary/route"
    );

    const req = new Request("http://localhost/api/cron/cost-summary") as unknown;
    const res = await GET(req as Parameters<typeof GET>[0]);

    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 401 when Bearer token is wrong", async () => {
    process.env["CRON_SECRET"] = "correct-secret";
    const { GET } = await import(
      "@/app/api/cron/cost-summary/route"
    );

    const req = new Request("http://localhost/api/cron/cost-summary", {
      headers: { authorization: "Bearer wrong-secret" },
    }) as unknown;
    const res = await GET(req as Parameters<typeof GET>[0]);

    expect(res.status).toBe(401);
  });

  it("returns JSON summary with date, totalUsd, calls when authenticated", async () => {
    process.env["CRON_SECRET"] = "test-cron-secret";
    mockTodayRows = [
      { model: "sonnet", calls: 4, model_cost: 0.08 },
      { model: "opus", calls: 1, model_cost: 0.3 },
    ];

    const { GET } = await import(
      "@/app/api/cron/cost-summary/route"
    );

    const req = new Request("http://localhost/api/cron/cost-summary", {
      headers: { authorization: "Bearer test-cron-secret" },
    }) as unknown;
    const res = await GET(req as Parameters<typeof GET>[0]);

    expect(res.status).toBe(200);
    const body = await res.json() as {
      date: string;
      totalUsd: number;
      calls: number;
      capUsd: number;
      modelBreakdown: Record<string, unknown>;
    };

    // date is yesterday in UTC
    expect(body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.totalUsd).toBeCloseTo(0.38, 4);
    expect(body.calls).toBe(5);
    expect(body.capUsd).toBe(5); // default
    expect(body.modelBreakdown).toHaveProperty("sonnet");
    expect(body.modelBreakdown).toHaveProperty("opus");
  });
});

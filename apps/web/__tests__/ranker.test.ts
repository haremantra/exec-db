// Tests for the counterfactual task ranker (M1-M3 — SY-013, US-024, W8.3,
// cross-cutting invariant #7).
//
// Coverage targets:
//   1. rankTasks produces topPick + alternatives from a canned LLM response.
//   2. JSON parse failure falls back to deterministic ranking.
//   3. SDK error falls back to deterministic ranking.
//   4. Empty input returns null topPick.
//   5. System prompt mentions "counterfactual" (regression guard for invariant #7).
//   6. Pinned tasks are always passed into the prompt (candidate selection).
//   7. Deterministic fallback honors the documented tie-break order.
//   8. recordRankingOverride writes the right audit row.
//   9. Ranker uses Opus.
//  10. Output drops alternatives whose taskId isn't in the candidate set.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const DEV_USER = "00000000-0000-0000-0000-000000000001";

const SESSION = {
  userId: DEV_USER,
  email: "dev@exec-db.local",
  tier: "exec_all" as const,
  functionArea: null,
};

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

type CapturedSafe = {
  args: {
    model: string;
    prompt: string;
    system?: string;
    promptClass?: string;
    contactId?: string | null;
  };
};

type AccessInsert = {
  table: string;
  values: Record<string, unknown>;
};

let safeCaptured: CapturedSafe[] = [];
let llmResponseText = "";
let llmShouldThrow = false;
let dbInserts: AccessInsert[] = [];

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/lib/anthropic", () => ({
  safeAnthropic: vi.fn(async (args: CapturedSafe["args"]) => {
    safeCaptured.push({ args });
    if (llmShouldThrow) throw new Error("Simulated SDK failure");
    return {
      text: llmResponseText,
      redactionsApplied: [] as string[],
    };
  }),
}));

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
      insert(table: unknown) {
        const t = tableName(table);
        return {
          values(values: Record<string, unknown>) {
            dbInserts.push({ table: t, values });
            return Promise.resolve();
          },
        };
      },
    };
    return fn(tx);
  },
}));

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  safeCaptured = [];
  dbInserts = [];
  llmResponseText = "";
  llmShouldThrow = false;
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<{
  id: string;
  title: string;
  workArea: string | null;
  impact: "revenue" | "reputation" | "both" | "neither" | null;
  isPinned: boolean;
  dueDate: string | null;
  priority: number;
  status: string;
}> = {}) {
  return {
    id: overrides.id ?? "11111111-1111-1111-1111-111111111111",
    title: overrides.title ?? "Default task",
    workArea: overrides.workArea ?? null,
    impact: overrides.impact ?? null,
    isPinned: overrides.isPinned ?? false,
    dueDate: overrides.dueDate ?? null,
    priority: overrides.priority ?? 5,
    status: overrides.status ?? "todo",
  };
}

const T1 = makeTask({
  id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  title: "Close the Acme renewal",
  impact: "both",
  priority: 1,
  workArea: "customer",
});

const T2 = makeTask({
  id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  title: "Reply to investor intro",
  impact: "revenue",
  priority: 2,
  workArea: "investor",
});

const T3 = makeTask({
  id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
  title: "Draft thought-leadership post",
  impact: "reputation",
  priority: 4,
  workArea: "thought_leadership",
});

const T4 = makeTask({
  id: "dddddddd-dddd-dddd-dddd-dddddddddddd",
  title: "Review compensation memo",
  impact: "neither",
  priority: 7,
  workArea: "admin",
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("rankTasks — happy path", () => {
  it("produces topPick + alternatives from a canned LLM response", async () => {
    const { rankTasks } = await import("@/lib/ranker");

    llmResponseText = JSON.stringify({
      topPick: { taskId: T1.id, reason: "Largest revenue + reputation impact." },
      alternatives: [
        { taskId: T2.id, deprioritizationReason: "Revenue impact but lower priority." },
        { taskId: T3.id, deprioritizationReason: "Reputation only; no immediate revenue." },
      ],
    });

    const result = await rankTasks([T1, T2, T3, T4], SESSION);

    expect(result.topPick).toEqual({
      taskId: T1.id,
      reason: "Largest revenue + reputation impact.",
    });
    expect(result.alternatives).toHaveLength(2);
    expect(result.alternatives[0]!.taskId).toBe(T2.id);
    expect(result.alternatives[0]!.deprioritizationReason).toContain("Revenue");
    expect(result.alternatives[1]!.taskId).toBe(T3.id);
  });

  it("uses Opus (M is correctness-critical, per the model matrix)", async () => {
    const { rankTasks } = await import("@/lib/ranker");

    llmResponseText = JSON.stringify({
      topPick: { taskId: T1.id, reason: "x" },
      alternatives: [],
    });

    await rankTasks([T1, T2], SESSION);

    expect(safeCaptured).toHaveLength(1);
    expect(safeCaptured[0]!.args.model).toBe("opus");
    expect(safeCaptured[0]!.args.promptClass).toBe("rank");
    expect(safeCaptured[0]!.args.contactId).toBeNull();
  });

  it("system prompt mentions 'counterfactual' (regression guard for invariant #7)", async () => {
    const { rankTasks } = await import("@/lib/ranker");

    llmResponseText = JSON.stringify({
      topPick: { taskId: T1.id, reason: "x" },
      alternatives: [],
    });

    await rankTasks([T1, T2], SESSION);

    const sys = safeCaptured[0]!.args.system ?? "";
    expect(sys.toLowerCase()).toContain("counterfactual");
  });

  it("user prompt instructs the model to weight impact: both > revenue > reputation > neither > null", async () => {
    const { rankTasks } = await import("@/lib/ranker");

    llmResponseText = JSON.stringify({
      topPick: { taskId: T1.id, reason: "x" },
      alternatives: [],
    });

    await rankTasks([T1, T2], SESSION);

    const userPrompt = safeCaptured[0]!.args.prompt;
    expect(userPrompt).toContain("both > revenue > reputation > neither > null");
  });

  it("includes pinned tasks in the prompt even when there are >10 candidates", async () => {
    const { rankTasks } = await import("@/lib/ranker");

    // 12 tasks: one pinned at the END so naive trim-to-10 would drop it.
    const many = Array.from({ length: 11 }, (_, i) =>
      makeTask({
        id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
        title: `Filler ${i}`,
        impact: "neither",
        priority: 9,
      }),
    );
    const pinnedLast = makeTask({
      id: "99999999-9999-9999-9999-999999999999",
      title: "Pinned-but-last task",
      isPinned: true,
      impact: "neither",
      priority: 9,
    });

    llmResponseText = JSON.stringify({
      topPick: { taskId: many[0]!.id, reason: "x" },
      alternatives: [],
    });

    await rankTasks([...many, pinnedLast], SESSION);

    const prompt = safeCaptured[0]!.args.prompt;
    // Pinned task must survive the candidate trim.
    expect(prompt).toContain(pinnedLast.id);
  });

  it("drops alternatives whose taskId is not in the candidate set", async () => {
    const { rankTasks } = await import("@/lib/ranker");

    llmResponseText = JSON.stringify({
      topPick: { taskId: T1.id, reason: "ok" },
      alternatives: [
        { taskId: T2.id, deprioritizationReason: "lower priority" },
        // Hallucinated id — should be filtered out
        {
          taskId: "ffffffff-ffff-ffff-ffff-ffffffffffff",
          deprioritizationReason: "ghost",
        },
      ],
    });

    const result = await rankTasks([T1, T2, T3], SESSION);

    expect(result.alternatives).toHaveLength(1);
    expect(result.alternatives[0]!.taskId).toBe(T2.id);
  });
});

describe("rankTasks — fallback paths", () => {
  it("returns null topPick on empty input (no LLM call)", async () => {
    const { rankTasks } = await import("@/lib/ranker");
    const result = await rankTasks([], SESSION);
    expect(result.topPick).toBeNull();
    expect(result.alternatives).toEqual([]);
    expect(safeCaptured).toHaveLength(0);
  });

  it("falls back to deterministic ranking when JSON parse fails", async () => {
    const { rankTasks } = await import("@/lib/ranker");

    llmResponseText = "this is not JSON {{{";

    const result = await rankTasks([T4, T3, T2, T1], SESSION);

    // Deterministic order: impact both (T1) > revenue (T2) > reputation (T3) > neither (T4)
    expect(result.topPick?.taskId).toBe(T1.id);
    expect(result.alternatives.map((a) => a.taskId)).toEqual([T2.id, T3.id, T4.id]);
    // Each alternative carries a non-empty deprioritization reason.
    for (const a of result.alternatives) {
      expect(a.deprioritizationReason.length).toBeGreaterThan(0);
    }
  });

  it("falls back to deterministic ranking when the SDK throws", async () => {
    const { rankTasks } = await import("@/lib/ranker");

    llmShouldThrow = true;

    const result = await rankTasks([T4, T2, T1], SESSION);

    expect(result.topPick?.taskId).toBe(T1.id);
    expect(result.alternatives[0]!.taskId).toBe(T2.id);
  });

  it("deterministic fallback honors documented order: pinned > impact > priority > due > title", async () => {
    const { deterministicRank } = await import("@/lib/ranker");

    const pinnedNeither = makeTask({
      id: "11111111-1111-1111-1111-aaaaaaaaaaaa",
      title: "Pinned Neither",
      impact: "neither",
      priority: 9,
      isPinned: true,
    });
    const bothLowPrio = makeTask({
      id: "22222222-2222-2222-2222-aaaaaaaaaaaa",
      title: "Both impact, low priority",
      impact: "both",
      priority: 8,
    });
    const revenueDueSoon = makeTask({
      id: "33333333-3333-3333-3333-aaaaaaaaaaaa",
      title: "Revenue, due tomorrow",
      impact: "revenue",
      priority: 5,
      dueDate: "2026-01-01",
    });
    const repHighPrio = makeTask({
      id: "44444444-4444-4444-4444-aaaaaaaaaaaa",
      title: "Reputation, high priority",
      impact: "reputation",
      priority: 1,
    });

    const sorted = deterministicRank([
      revenueDueSoon,
      repHighPrio,
      bothLowPrio,
      pinnedNeither,
    ]);

    // Pinned wins regardless of impact.
    expect(sorted[0]!.id).toBe(pinnedNeither.id);
    // Then impact: both > revenue > reputation.
    expect(sorted[1]!.id).toBe(bothLowPrio.id);
    expect(sorted[2]!.id).toBe(revenueDueSoon.id);
    expect(sorted[3]!.id).toBe(repHighPrio.id);
  });
});

describe("recordRankingOverride", () => {
  it("writes a row to audit.access_log with override metadata", async () => {
    const { recordRankingOverride } = await import("@/lib/ranker");

    const ranking = {
      topPick: { taskId: T1.id, reason: "best" },
      alternatives: [
        { taskId: T2.id, deprioritizationReason: "second-best" },
      ],
    };

    await recordRankingOverride(ranking, T2.id, SESSION);

    expect(dbInserts).toHaveLength(1);
    const row = dbInserts[0]!;
    expect(row.table).toContain("access_log");
    expect(row.values.action).toBe("SELECT");
    expect(row.values.schemaName).toBe("pm");
    expect(row.values.tableName).toBe("task");
    expect(String(row.values.intent)).toContain("exec overrode ranker top pick");
    expect(String(row.values.intent)).toContain(T2.id);
    expect(String(row.values.intent)).toContain(T1.id);

    const meta = row.values.metadata as Record<string, unknown>;
    expect(meta.override).toBe("ranker_top_pick");
    expect(meta.originalTopPickId).toBe(T1.id);
    expect(meta.chosenTaskId).toBe(T2.id);
    // Full ranking captured for replay.
    expect(meta.ranking).toEqual(ranking);
  });

  it("handles a null original top pick gracefully", async () => {
    const { recordRankingOverride } = await import("@/lib/ranker");

    const ranking = { topPick: null, alternatives: [] };
    await recordRankingOverride(ranking, T1.id, SESSION);

    const row = dbInserts[0]!;
    const meta = row.values.metadata as Record<string, unknown>;
    expect(meta.originalTopPickId).toBeNull();
    expect(String(row.values.intent)).toContain("<none>");
  });
});

// Tests for the LLM audit log (SY-017, AD-005, cross-cutting invariant #4).
//
// Coverage targets:
//   1. recordLlmCall inserts a row with correct hash + promptClass.
//   2. safeAnthropic (one-shot) invokes recordLlmCall exactly once.
//   3. safeAnthropicStream invokes recordLlmCall exactly once (via finalMessage).
//   4. Sheet append failure does NOT bubble to the caller.
//   5. outcome: "error" is recorded when the SDK throws.
//   6. SHA-256 hashing is stable across repeated calls.
//   7. Cost computation is correct for opus.
//   8. Cost computation is correct for sonnet.
//   9. recordLlmCall with null contactId inserts correctly.
//  10. safeAnthropic records outcome: "error" when SDK throws.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Shared mock state
// ---------------------------------------------------------------------------

type InsertCapture = {
  table: string;
  values: Record<string, unknown>;
};

let inserts: InsertCapture[] = [];
let mockSheetFails = false;

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

vi.mock("@/lib/audit-sheet", () => ({
  appendLlmCallToSheet: async () => {
    if (mockSheetFails) {
      throw new Error("Simulated Sheet failure");
    }
  },
}));

// Mock the Anthropic SDK for safeAnthropic / safeAnthropicStream tests
type FakeMessage = {
  content: Array<{ type: string; text: string }>;
  usage: { input_tokens: number; output_tokens: number };
};

let sdkShouldThrow = false;
let fakeMessage: FakeMessage = {
  content: [{ type: "text", text: "hello world" }],
  usage: { input_tokens: 10, output_tokens: 20 },
};
let fakeStreamHandlers: Record<string, ((...args: unknown[]) => void)[]> = {};

vi.mock("@anthropic-ai/sdk", () => {
  const mockStream = {
    on(event: string, handler: (...args: unknown[]) => void) {
      if (!fakeStreamHandlers[event]) fakeStreamHandlers[event] = [];
      fakeStreamHandlers[event].push(handler);
      return mockStream;
    },
  };

  const Anthropic = vi.fn().mockImplementation(() => ({
    messages: {
      create: async () => {
        if (sdkShouldThrow) throw new Error("SDK error");
        return fakeMessage;
      },
      stream: () => mockStream,
    },
  }));

  return { default: Anthropic };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  inserts = [];
  mockSheetFails = false;
  sdkShouldThrow = false;
  fakeStreamHandlers = {};
  fakeMessage = {
    content: [{ type: "text", text: "hello world" }],
    usage: { input_tokens: 10, output_tokens: 20 },
  };
  process.env["ANTHROPIC_API_KEY"] = "test-key";
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("recordLlmCall", () => {
  it("inserts a row with the correct prompt hash and promptClass", async () => {
    const { recordLlmCall } = await import("@/lib/audit-llm");

    const input = "redacted prompt text";
    await recordLlmCall({
      contactId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      model: "sonnet",
      promptClass: "vision-check",
      redactedInput: input,
      responseText: "some response",
      redactionsApplied: ["phi", "ssn"],
      inputTokens: 100,
      outputTokens: 50,
      outcome: "ok",
    });

    expect(inserts).toHaveLength(1);
    const row = inserts[0]!;
    expect(row.table).toContain("llm_call");
    expect(row.values.redactedInputHash).toBe(sha256hex(input));
    expect(row.values.promptClass).toBe("vision-check");
    expect(row.values.model).toBe("sonnet");
    expect(row.values.outcome).toBe("ok");
    expect(row.values.redactionsApplied).toEqual(["phi", "ssn"]);
  });

  it("inserts with null contactId for non-contact calls", async () => {
    const { recordLlmCall } = await import("@/lib/audit-llm");

    await recordLlmCall({
      contactId: null,
      model: "opus",
      promptClass: "digest-rank",
      redactedInput: "some text",
      responseText: null,
      redactionsApplied: [],
      outcome: "ok",
    });

    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.values.contactId).toBeNull();
  });

  it("SHA-256 hash is stable across repeated calls", async () => {
    const { recordLlmCall } = await import("@/lib/audit-llm");

    const input = "stable input text";
    await recordLlmCall({
      contactId: null,
      model: "sonnet",
      promptClass: "test",
      redactedInput: input,
      responseText: "response",
      redactionsApplied: [],
      outcome: "ok",
    });
    await recordLlmCall({
      contactId: null,
      model: "sonnet",
      promptClass: "test",
      redactedInput: input,
      responseText: "response",
      redactionsApplied: [],
      outcome: "ok",
    });

    expect(inserts[0]!.values.redactedInputHash).toBe(inserts[1]!.values.redactedInputHash);
    expect(inserts[0]!.values.redactedInputHash).toBe(sha256hex(input));
  });

  it("computes correct cost for opus", async () => {
    const { recordLlmCall } = await import("@/lib/audit-llm");

    // opus: $15/M input + $75/M output
    // 1000 input tokens = 0.015, 2000 output tokens = 0.15
    await recordLlmCall({
      contactId: null,
      model: "opus",
      promptClass: "test",
      redactedInput: "test",
      responseText: "response",
      redactionsApplied: [],
      inputTokens: 1000,
      outputTokens: 2000,
      outcome: "ok",
    });

    const costUsd = inserts[0]!.values.costUsd as string;
    // (1000/1_000_000)*15 + (2000/1_000_000)*75 = 0.015 + 0.15 = 0.165
    expect(parseFloat(costUsd)).toBeCloseTo(0.165, 5);
  });

  it("computes correct cost for sonnet", async () => {
    const { recordLlmCall } = await import("@/lib/audit-llm");

    // sonnet: $3/M input + $15/M output
    // 500 input + 1000 output = 0.0015 + 0.015 = 0.0165
    await recordLlmCall({
      contactId: null,
      model: "sonnet",
      promptClass: "test",
      redactedInput: "test",
      responseText: "response",
      redactionsApplied: [],
      inputTokens: 500,
      outputTokens: 1000,
      outcome: "ok",
    });

    const costUsd = inserts[0]!.values.costUsd as string;
    expect(parseFloat(costUsd)).toBeCloseTo(0.0165, 5);
  });

  it("Sheet append failure does NOT bubble to the caller", async () => {
    const { recordLlmCall } = await import("@/lib/audit-llm");
    mockSheetFails = true;

    // Should NOT throw even though sheet append throws
    await expect(
      recordLlmCall({
        contactId: null,
        model: "sonnet",
        promptClass: "test",
        redactedInput: "test input",
        responseText: "response",
        redactionsApplied: [],
        outcome: "ok",
      }),
    ).resolves.toBeUndefined();

    // Postgres insert still happened
    expect(inserts).toHaveLength(1);
  });
});

describe("safeAnthropic wrapper (cross-cutting invariant #4)", () => {
  it("invokes recordLlmCall exactly once per successful call", async () => {
    const auditLlm = await import("@/lib/audit-llm");
    const spy = vi.spyOn(auditLlm, "recordLlmCall");

    const { safeAnthropic } = await import("@/lib/anthropic");

    await safeAnthropic({
      prompt: "Hello world",
      model: "sonnet",
      promptClass: "test-class",
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const callArgs = spy.mock.calls[0]![0];
    expect(callArgs.outcome).toBe("ok");
    expect(callArgs.promptClass).toBe("test-class");
  });

  it("records outcome: 'error' when the SDK throws", async () => {
    sdkShouldThrow = true;

    const auditLlm = await import("@/lib/audit-llm");
    const spy = vi.spyOn(auditLlm, "recordLlmCall");

    const { safeAnthropic } = await import("@/lib/anthropic");

    await expect(
      safeAnthropic({
        prompt: "test prompt",
        model: "sonnet",
        promptClass: "test-error",
      }),
    ).rejects.toThrow("SDK error");

    // Give the async error-recording call time to complete
    await new Promise((r) => setTimeout(r, 10));

    // recordLlmCall should have been called with outcome: "error"
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0].outcome).toBe("error");
  });
});

describe("safeAnthropicStream wrapper (cross-cutting invariant #4)", () => {
  it("invokes recordLlmCall exactly once when stream terminates", async () => {
    const auditLlm = await import("@/lib/audit-llm");
    const spy = vi.spyOn(auditLlm, "recordLlmCall");

    const { safeAnthropicStream } = await import("@/lib/anthropic");

    safeAnthropicStream({
      model: "sonnet",
      system: { text: "system prompt" },
      messages: [{ role: "user", text: "user message" }],
      promptClass: "stream-test",
    });

    // Simulate stream terminal event
    const finalMsgHandler = fakeStreamHandlers["finalMessage"]?.[0];
    expect(finalMsgHandler).toBeDefined();
    finalMsgHandler!(fakeMessage);

    // Wait for the async recordLlmCall inside the handler
    await new Promise((r) => setTimeout(r, 10));

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0].outcome).toBe("ok");
    expect(spy.mock.calls[0]![0].promptClass).toBe("stream-test");
  });

  it("records outcome: 'error' when stream emits error event", async () => {
    const auditLlm = await import("@/lib/audit-llm");
    const spy = vi.spyOn(auditLlm, "recordLlmCall");

    const { safeAnthropicStream } = await import("@/lib/anthropic");

    safeAnthropicStream({
      model: "sonnet",
      system: { text: "system prompt" },
      messages: [{ role: "user", text: "user message" }],
      promptClass: "stream-error-test",
    });

    // Simulate stream error event
    const errorHandler = fakeStreamHandlers["error"]?.[0];
    expect(errorHandler).toBeDefined();
    errorHandler!(new Error("stream aborted"));

    await new Promise((r) => setTimeout(r, 10));

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0].outcome).toBe("error");
  });
});

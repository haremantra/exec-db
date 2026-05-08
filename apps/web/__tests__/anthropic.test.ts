import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Anthropic SDK BEFORE importing the wrapper, so the wrapper
// resolves our mock instead of the real client. We capture every call's
// arguments so the tests can assert no raw PII reached the SDK.

type CapturedCall = {
  method: "create" | "stream";
  args: unknown;
};

const captured: CapturedCall[] = [];

vi.mock("@anthropic-ai/sdk", () => {
  // Default constructor returns an object with a .messages.create / .stream
  // pair that records the call and returns canned data.
  const Mock = vi.fn().mockImplementation(() => ({
    messages: {
      create: vi.fn(async (args: unknown) => {
        captured.push({ method: "create", args });
        return {
          content: [{ type: "text", text: "mock response" }],
        };
      }),
      stream: vi.fn((args: unknown) => {
        captured.push({ method: "stream", args });
        // Minimal stream stub — tests don't need finalMessage().
        return {
          on: () => {
            /* no-op */
          },
          finalMessage: async () => ({ content: [{ type: "text", text: "" }] }),
        };
      }),
    },
  }));
  return { default: Mock };
});

beforeEach(() => {
  captured.length = 0;
  process.env["ANTHROPIC_API_KEY"] = "test-key";
  delete process.env["REDACTION_PUBLIC_DOMAINS"];
});

afterEach(() => {
  vi.clearAllMocks();
});

// Lazy import so the mock above is in place first.
async function loadWrapper() {
  return import("../lib/anthropic");
}

describe("safeAnthropic — SY-016 invariant: SDK never sees raw PII", () => {
  it("redacts the prompt before calling messages.create", async () => {
    const { safeAnthropic } = await loadWrapper();

    const raw = "Customer SSN 123-45-6789 and card 4111 1111 1111 1111 noted.";
    const result = await safeAnthropic({ prompt: raw, model: "sonnet" });

    expect(captured).toHaveLength(1);
    const callArgs = captured[0]!.args as {
      messages: Array<{ content: string }>;
    };
    const sentPrompt = callArgs.messages[0]!.content;
    expect(sentPrompt).not.toContain("123-45-6789");
    expect(sentPrompt).not.toContain("4111 1111 1111 1111");
    expect(sentPrompt).toContain("<SSN>");
    expect(sentPrompt).toContain("<BANK>");
    expect(result.redactionsApplied).toEqual(["banking", "ssn"]);
  });

  it("redacts the system prompt too when provided", async () => {
    const { safeAnthropic } = await loadWrapper();

    await safeAnthropic({
      prompt: "Hello.",
      system: "Patient MRN: 1234567 in chart.",
      model: "sonnet",
    });

    const callArgs = captured[0]!.args as { system?: string };
    expect(callArgs.system).toContain("<PHI>");
    expect(callArgs.system).not.toContain("1234567");
  });

  it("returns redactionsApplied in canonical declaration order", async () => {
    const { safeAnthropic } = await loadWrapper();

    // Build a prompt that triggers banking + ssn + dl, in REVERSE declaration
    // order in the input. The result must reorder to declaration order.
    const raw =
      "CA DL D1234567 then SSN 123-45-6789 then card 4111 1111 1111 1111.";
    const { redactionsApplied } = await safeAnthropic({
      prompt: raw,
      model: "sonnet",
    });

    // Canonical order is: phi, pi, banking, ssn, drivers_license, non_public_address
    expect(redactionsApplied).toEqual(["banking", "ssn", "drivers_license"]);
  });

  it("throws when ANTHROPIC_API_KEY is unset", async () => {
    delete process.env["ANTHROPIC_API_KEY"];
    const { safeAnthropic } = await loadWrapper();
    await expect(
      safeAnthropic({ prompt: "anything", model: "sonnet" }),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
    expect(captured).toHaveLength(0);
  });

  it("returns empty redactionsApplied when input has no PII", async () => {
    const { safeAnthropic } = await loadWrapper();
    const { redactionsApplied } = await safeAnthropic({
      prompt: "Plain question with nothing to mask.",
      model: "sonnet",
    });
    expect(redactionsApplied).toEqual([]);
  });
});

describe("safeAnthropicStream — SY-016 invariant: streaming path is also gated", () => {
  it("redacts every message text + system before calling messages.stream", async () => {
    const { safeAnthropicStream } = await loadWrapper();

    safeAnthropicStream({
      model: "opus",
      system: { text: "Patient MRN: 9876543 in chart.", cacheable: true },
      messages: [
        { role: "user", text: "SSN 123-45-6789 first message", cacheable: false },
        { role: "assistant", text: "Card 4111 1111 1111 1111 reply", cacheable: false },
      ],
    });

    expect(captured).toHaveLength(1);
    const callArgs = captured[0]!.args as {
      system: Array<{ text: string }>;
      messages: Array<{ content: Array<{ text: string }> }>;
    };
    expect(callArgs.system[0]!.text).toContain("<PHI>");
    expect(callArgs.system[0]!.text).not.toContain("9876543");
    expect(callArgs.messages[0]!.content[0]!.text).toContain("<SSN>");
    expect(callArgs.messages[0]!.content[0]!.text).not.toContain("123-45-6789");
    expect(callArgs.messages[1]!.content[0]!.text).toContain("<BANK>");
    expect(callArgs.messages[1]!.content[0]!.text).not.toContain(
      "4111 1111 1111 1111",
    );
  });

  it("aggregates redactionsApplied from all messages + system in stable order", async () => {
    const { safeAnthropicStream } = await loadWrapper();

    const handle = safeAnthropicStream({
      model: "opus",
      system: { text: "MRN: 1234567" },
      messages: [
        { role: "user", text: "SSN 111-22-3333" },
        { role: "user", text: "card 4111 1111 1111 1111" },
      ],
    });

    expect(handle.redactionsApplied).toEqual(["phi", "banking", "ssn"]);
  });

  it("propagates cacheable flag as cache_control: ephemeral on the SDK call", async () => {
    const { safeAnthropicStream } = await loadWrapper();

    safeAnthropicStream({
      model: "opus",
      system: { text: "system text", cacheable: true },
      messages: [{ role: "user", text: "hello", cacheable: false }],
    });

    const callArgs = captured[0]!.args as {
      system: Array<{ cache_control?: unknown }>;
      messages: Array<{ content: Array<{ cache_control?: unknown }> }>;
    };
    expect(callArgs.system[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(callArgs.messages[0]!.content[0]!.cache_control).toBeUndefined();
  });

  it("throws when ANTHROPIC_API_KEY is unset", async () => {
    delete process.env["ANTHROPIC_API_KEY"];
    const { safeAnthropicStream } = await loadWrapper();
    expect(() =>
      safeAnthropicStream({
        model: "opus",
        system: { text: "x" },
        messages: [{ role: "user", text: "y" }],
      }),
    ).toThrow(/ANTHROPIC_API_KEY/);
    expect(captured).toHaveLength(0);
  });
});

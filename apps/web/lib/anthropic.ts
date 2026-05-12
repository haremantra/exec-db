// Single sanctioned surface for Anthropic SDK calls from this app.
//
// Why this file exists
// --------------------
// SY-016 / W10.4 require that no raw text reach an LLM until the redaction
// filter has run over it. The cheapest way to enforce that is to make
// `safeAnthropic` the *only* exported symbol that touches the SDK. Anything
// else has to import the SDK directly — which is grep-able, lintable, and
// blockable in code review.
//
// We deliberately do NOT re-export `Anthropic` or `Anthropic.MessageParam`
// from this module. If a caller needs a type from the SDK, let them import
// it from the SDK package itself; that import is a clear signal in review
// that they may be bypassing redaction.
//
// Audit logging (SY-017 / AD-005) is handled by stream E. The TODO markers
// below have been replaced with actual recordLlmCall calls (PR2-E).

import Anthropic from "@anthropic-ai/sdk";

import { REDACTION_CLASS_ORDER, redact, type RedactionClass } from "./redaction";
import { recordLlmCall } from "./audit-llm";
import { assertWithinBudget, CostGuardError, notifyBudgetBreach } from "./cost-guard";

const MODEL_IDS = {
  opus: "claude-opus-4-7",
  sonnet: "claude-sonnet-4-6",
} as const;

export type SafeAnthropicModel = keyof typeof MODEL_IDS;

export interface SafeAnthropicOptions {
  prompt: string;
  model: SafeAnthropicModel;
  // Optional caller-declared expected classes — informational only. The
  // redaction filter is authoritative; we never skip filtering based on this.
  redactionClasses?: RedactionClass[];
  // Hard upper bound on response length. Default chosen to match the
  // existing vision-check usage so its behavior doesn't drift.
  maxTokens?: number;
  // Optional system prompt. System prompts are also redacted.
  system?: string;
  // Audit metadata — required by cross-cutting invariant #4 (SY-017).
  promptClass?: string;
  contactId?: string | null;
}

export interface SafeAnthropicResult {
  text: string;
  redactionsApplied: RedactionClass[];
}

let cachedClient: Anthropic | null = null;
function client(): Anthropic {
  if (!cachedClient) cachedClient = new Anthropic();
  return cachedClient;
}

/**
 * Run a one-shot Anthropic call with redaction enforced on the prompt
 * (and any provided system text) before the SDK is reached.
 *
 * Determinism note: Anthropic API output is non-deterministic, but the
 * redaction step that gates it IS deterministic and unit-tested by
 * `redaction.test.ts`.
 *
 * Every call writes a row to audit.llm_call (SY-017, cross-cutting invariant #4).
 */
export async function safeAnthropic(
  opts: SafeAnthropicOptions,
): Promise<SafeAnthropicResult> {
  if (!process.env["ANTHROPIC_API_KEY"]) {
    throw new Error(
      "safeAnthropic: ANTHROPIC_API_KEY is not set. Refusing to call the SDK.",
    );
  }

  // ── Cost guard (hard floor — runs BEFORE redaction) ───────────────────────
  // Intentionally before redaction: the guard is a kill switch that must not
  // be bypassed by redaction failures or any later pipeline step.
  try {
    await assertWithinBudget();
  } catch (err: unknown) {
    if (err instanceof CostGuardError) {
      // Record the killed call in audit.llm_call so invariant #4 holds.
      const today = new Date().toISOString().slice(0, 10);
      await recordLlmCall({
        contactId: opts.contactId ?? null,
        model: opts.model,
        promptClass: opts.promptClass ?? "unknown",
        redactedInput: "[blocked — daily budget exceeded]",
        responseText: null,
        redactionsApplied: [],
        outcome: "killed",
      }).catch((auditErr: unknown) => {
        console.error("[safeAnthropic] Failed to write killed audit row:", auditErr);
      });
      // Fire-and-forget breach notification (one email per UTC day).
      const capUsd = parseFloat(
        process.env["DAILY_LLM_BUDGET_USD"] ?? "5",
      );
      notifyBudgetBreach({
        totalUsd: err.totalUsd,
        capUsd,
        date: today,
      }).catch((notifyErr: unknown) => {
        console.error("[safeAnthropic] Failed to send breach notification:", notifyErr);
      });
      throw new Error(err.message);
    }
    throw err;
  }

  const promptScrub = redact(opts.prompt);
  const systemScrub = opts.system ? redact(opts.system) : null;

  // Combine class hits from prompt + system into a unique, stable-ordered set.
  const seen = new Set<RedactionClass>([
    ...promptScrub.classesHit,
    ...(systemScrub?.classesHit ?? []),
  ]);
  const redactionsApplied = REDACTION_CLASS_ORDER.filter((c) => seen.has(c));

  let message: Awaited<ReturnType<typeof client.prototype.messages.create>>;
  try {
    message = await client().messages.create({
      model: MODEL_IDS[opts.model],
      max_tokens: opts.maxTokens ?? 8192,
      ...(systemScrub ? { system: systemScrub.redacted } : {}),
      messages: [{ role: "user", content: promptScrub.redacted }],
    });
  } catch (err: unknown) {
    // Record the failed call before re-throwing.
    await recordLlmCall({
      contactId: opts.contactId ?? null,
      model: opts.model,
      promptClass: opts.promptClass ?? "unknown",
      redactedInput: promptScrub.redacted,
      responseText: null,
      redactionsApplied,
      outcome: "error",
    }).catch((auditErr: unknown) => {
      console.error("[safeAnthropic] Failed to write audit row on error:", auditErr);
    });
    throw err;
  }

  const text = (message.content as Anthropic.ContentBlock[])
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  const usage = message.usage as { input_tokens?: number; output_tokens?: number } | undefined;

  // Record the successful call to audit.llm_call (SY-017 / AD-005).
  const auditParams: Parameters<typeof recordLlmCall>[0] = {
    contactId: opts.contactId ?? null,
    model: opts.model,
    promptClass: opts.promptClass ?? "unknown",
    redactedInput: promptScrub.redacted,
    responseText: text,
    redactionsApplied,
    outcome: "ok",
  };
  if (usage?.input_tokens != null) auditParams.inputTokens = usage.input_tokens;
  if (usage?.output_tokens != null) auditParams.outputTokens = usage.output_tokens;
  await recordLlmCall(auditParams);

  return { text, redactionsApplied };
}

// Streaming-flavored variant. The vision-check script needs token streaming
// + finalMessage access, which the simple `safeAnthropic` does not surface.
// We keep redaction enforced at the entry point and hand the stream back.
//
// Note on `cacheable`: Anthropic prompt caching is opted into per content
// block by setting `cache_control: { type: "ephemeral" }` (the "ephemeral"
// label refers to the ~5-minute cache TTL — it ENABLES caching, it does not
// disable it). We expose this as a `cacheable: boolean` so the field name
// matches its effect rather than the SDK's internal vocabulary.

export interface SafeAnthropicStreamOptions {
  model: SafeAnthropicModel;
  system: { text: string; cacheable?: boolean };
  messages: Array<{ role: "user" | "assistant"; text: string; cacheable?: boolean }>;
  maxTokens?: number;
  // Audit metadata — required by cross-cutting invariant #4 (SY-017).
  promptClass?: string;
  contactId?: string | null;
}

export interface SafeAnthropicStreamHandle {
  stream: ReturnType<Anthropic["messages"]["stream"]>;
  redactionsApplied: RedactionClass[];
}

/**
 * Streaming variant. All `text` fields (system + every message) are
 * redacted before being passed to the SDK. Returns the underlying stream
 * plus the union of redaction classes that fired across all inputs.
 *
 * Audit logging: the stream object is wrapped so that when the terminal
 * `finalMessage` event fires the audit row is written automatically.
 * Callers continue to consume the stream exactly as before — no API change.
 *
 * Every call writes a row to audit.llm_call (SY-017, cross-cutting invariant #4).
 */
export async function safeAnthropicStream(
  opts: SafeAnthropicStreamOptions,
): Promise<SafeAnthropicStreamHandle> {
  if (!process.env["ANTHROPIC_API_KEY"]) {
    throw new Error(
      "safeAnthropicStream: ANTHROPIC_API_KEY is not set. Refusing to call the SDK.",
    );
  }

  // ── Cost guard (hard floor — runs BEFORE redaction) ───────────────────────
  try {
    await assertWithinBudget();
  } catch (err: unknown) {
    if (err instanceof CostGuardError) {
      const today = new Date().toISOString().slice(0, 10);
      await recordLlmCall({
        contactId: opts.contactId ?? null,
        model: opts.model,
        promptClass: opts.promptClass ?? "unknown",
        redactedInput: "[blocked — daily budget exceeded]",
        responseText: null,
        redactionsApplied: [],
        outcome: "killed",
      }).catch((auditErr: unknown) => {
        console.error("[safeAnthropicStream] Failed to write killed audit row:", auditErr);
      });
      const capUsd = parseFloat(
        process.env["DAILY_LLM_BUDGET_USD"] ?? "5",
      );
      notifyBudgetBreach({
        totalUsd: err.totalUsd,
        capUsd,
        date: today,
      }).catch((notifyErr: unknown) => {
        console.error("[safeAnthropicStream] Failed to send breach notification:", notifyErr);
      });
      throw new Error(err.message);
    }
    throw err;
  }

  const sysScrub = redact(opts.system.text);
  const seen = new Set<RedactionClass>(sysScrub.classesHit);

  // Concatenate all message texts for the input hash (stable, order-preserved).
  let concatenatedInput = sysScrub.redacted;

  const sdkMessages: Anthropic.MessageParam[] = opts.messages.map((m) => {
    const r = redact(m.text);
    for (const c of r.classesHit) seen.add(c);
    concatenatedInput += "\n" + r.redacted;
    return {
      role: m.role,
      content: [
        {
          type: "text",
          text: r.redacted,
          ...(m.cacheable ? { cache_control: { type: "ephemeral" as const } } : {}),
        },
      ],
    };
  });

  const redactionsApplied = REDACTION_CLASS_ORDER.filter((c) => seen.has(c));
  const redactedInput = concatenatedInput;
  const contactId = opts.contactId ?? null;
  const model = opts.model;
  const promptClass = opts.promptClass ?? "unknown";

  const rawStream = client().messages.stream({
    model: MODEL_IDS[opts.model],
    max_tokens: opts.maxTokens ?? 8192,
    system: [
      {
        type: "text",
        text: sysScrub.redacted,
        ...(opts.system.cacheable
          ? { cache_control: { type: "ephemeral" as const } }
          : {}),
      },
    ],
    messages: sdkMessages,
  });

  // Wire audit on stream terminal events.
  // `finalMessage` fires once when the stream is fully consumed (success path).
  rawStream.on("finalMessage", (msg: Anthropic.Message) => {
    const text = (msg.content as Anthropic.ContentBlock[])
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const usage = msg.usage as { input_tokens?: number; output_tokens?: number } | undefined;
    const streamAuditParams: Parameters<typeof recordLlmCall>[0] = {
      contactId,
      model,
      promptClass,
      redactedInput,
      responseText: text,
      redactionsApplied,
      outcome: "ok",
    };
    if (usage?.input_tokens != null) streamAuditParams.inputTokens = usage.input_tokens;
    if (usage?.output_tokens != null) streamAuditParams.outputTokens = usage.output_tokens;
    recordLlmCall(streamAuditParams).catch((err: unknown) => {
      console.error("[safeAnthropicStream] Failed to write audit row:", err);
    });
  });

  // `error` fires if the stream aborts before finalMessage.
  rawStream.on("error", (err: Error) => {
    recordLlmCall({
      contactId,
      model,
      promptClass,
      redactedInput,
      responseText: null,
      redactionsApplied,
      outcome: "error",
    }).catch((auditErr: unknown) => {
      console.error("[safeAnthropicStream] Failed to write error audit row:", auditErr);
    });
    // The error is re-emitted by the stream itself; we don't swallow it.
    void err;
  });

  return {
    stream: rawStream,
    redactionsApplied,
  };
}

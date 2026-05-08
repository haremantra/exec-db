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
// Audit logging (SY-017 / AD-005) is handled by stream E. A TODO marker
// below shows where the call will land.

import Anthropic from "@anthropic-ai/sdk";

import { REDACTION_CLASS_ORDER, redact, type RedactionClass } from "./redaction";

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
 */
export async function safeAnthropic(
  opts: SafeAnthropicOptions,
): Promise<SafeAnthropicResult> {
  if (!process.env["ANTHROPIC_API_KEY"]) {
    throw new Error(
      "safeAnthropic: ANTHROPIC_API_KEY is not set. Refusing to call the SDK.",
    );
  }

  const promptScrub = redact(opts.prompt);
  const systemScrub = opts.system ? redact(opts.system) : null;

  // Combine class hits from prompt + system into a unique, stable-ordered set.
  const seen = new Set<RedactionClass>([
    ...promptScrub.classesHit,
    ...(systemScrub?.classesHit ?? []),
  ]);
  const redactionsApplied = REDACTION_CLASS_ORDER.filter((c) => seen.has(c));

  // TODO(stream E): record to audit.llm_call here with
  //   { model, prompt_class, redacted_input_hash, response_hash, tokens, costUsd }
  // and append a row to the daily Google Sheet (SY-017, AD-005).

  const message = await client().messages.create({
    model: MODEL_IDS[opts.model],
    max_tokens: opts.maxTokens ?? 8192,
    ...(systemScrub ? { system: systemScrub.redacted } : {}),
    messages: [{ role: "user", content: promptScrub.redacted }],
  });

  const text = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

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
}

export interface SafeAnthropicStreamHandle {
  stream: ReturnType<Anthropic["messages"]["stream"]>;
  redactionsApplied: RedactionClass[];
}

/**
 * Streaming variant. All `text` fields (system + every message) are
 * redacted before being passed to the SDK. Returns the underlying stream
 * plus the union of redaction classes that fired across all inputs.
 */
export function safeAnthropicStream(
  opts: SafeAnthropicStreamOptions,
): SafeAnthropicStreamHandle {
  if (!process.env["ANTHROPIC_API_KEY"]) {
    throw new Error(
      "safeAnthropicStream: ANTHROPIC_API_KEY is not set. Refusing to call the SDK.",
    );
  }

  const sysScrub = redact(opts.system.text);
  const seen = new Set<RedactionClass>(sysScrub.classesHit);

  const sdkMessages: Anthropic.MessageParam[] = opts.messages.map((m) => {
    const r = redact(m.text);
    for (const c of r.classesHit) seen.add(c);
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

  // TODO(stream E): record to audit.llm_call after stream completion.

  const stream = client().messages.stream({
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

  return {
    stream,
    redactionsApplied: REDACTION_CLASS_ORDER.filter((c) => seen.has(c)),
  };
}

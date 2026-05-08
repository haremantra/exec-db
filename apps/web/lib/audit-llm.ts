// Audit helper for LLM calls (SY-017, AD-005).
//
// Every call to safeAnthropic / safeAnthropicStream MUST invoke
// recordLlmCall exactly once. This is cross-cutting invariant #4 from
// docs/pr2-spec.md. The test in __tests__/audit-llm.test.ts spies on
// this function to verify the invariant on every wrapper call.
//
// Cost constants map SafeAnthropicModel to ($/M input, $/M output).
// Source: Anthropic published pricing as of 2026-05.
// These are intentionally stored here — not in a DB table — so that
// historical rows retain the cost computed at call time even if prices change.

import { createHash } from "node:crypto";
import { schema } from "@exec-db/db";
import { query } from "@/lib/db";
import { appendLlmCallToSheet, type AuditLlmCallRow } from "@/lib/audit-sheet";

// ---------------------------------------------------------------------------
// Cost constants ($/million tokens)
// ---------------------------------------------------------------------------

const COST_PER_MILLION: Record<string, { inputUsd: number; outputUsd: number }> = {
  opus: { inputUsd: 15.0, outputUsd: 75.0 },
  sonnet: { inputUsd: 3.0, outputUsd: 15.0 },
};

function computeCostUsd(
  model: string,
  inputTokens: number | undefined,
  outputTokens: number | undefined,
): string | undefined {
  const rates = COST_PER_MILLION[model];
  if (!rates || inputTokens == null || outputTokens == null) return undefined;
  const cost =
    (inputTokens / 1_000_000) * rates.inputUsd +
    (outputTokens / 1_000_000) * rates.outputUsd;
  return cost.toFixed(6);
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type AuditLlmCallParams = {
  /** null for non-contact calls (e.g., vision-check). */
  contactId: string | null;
  /** "opus" | "sonnet" */
  model: string;
  /** Free-form label: "vision-check" | "autodraft" | "digest-rank" etc. */
  promptClass: string;
  /** Raw redacted prompt text — hashed inside this function. */
  redactedInput: string;
  /** Raw response text — hashed inside this function; null on stream failure. */
  responseText: string | null;
  /** RedactionClass values that fired on this call. */
  redactionsApplied: string[];
  inputTokens?: number;
  outputTokens?: number;
  /** "ok" | "error" | "killed" */
  outcome: "ok" | "error" | "killed";
};

// ---------------------------------------------------------------------------
// SHA-256 hashing — sync, no external deps (Node crypto module).
// ---------------------------------------------------------------------------

function sha256hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Core record function
// ---------------------------------------------------------------------------

/**
 * Insert one row into audit.llm_call and fire-and-forget the Sheet append.
 *
 * Always runs as app_exec (audit writes are privileged per the RLS policy).
 * Throws on insert failure so the caller can record outcome: "error".
 */
export async function recordLlmCall(params: AuditLlmCallParams): Promise<void> {
  const redactedInputHash = sha256hex(params.redactedInput);
  const responseHash =
    params.responseText != null ? sha256hex(params.responseText) : null;
  const costUsd = computeCostUsd(
    params.model,
    params.inputTokens,
    params.outputTokens,
  );

  const row = {
    contactId: params.contactId ?? null,
    model: params.model,
    promptClass: params.promptClass,
    redactedInputHash,
    responseHash,
    redactionsApplied: params.redactionsApplied,
    inputTokens: params.inputTokens ?? null,
    outputTokens: params.outputTokens ?? null,
    costUsd: costUsd ?? null,
    outcome: params.outcome,
  };

  // Audit writes always run as app_exec per the INSERT policy on audit.llm_call.
  // We use a synthetic session with a fixed system user ID so the session
  // context is valid; this user is never a real user (uuid is all-zeros).
  await query(
    { userId: "00000000-0000-0000-0000-000000000000", tier: "exec_all", functionArea: null },
    async (tx) => {
      await tx.insert(schema.llmCall).values(row);
    },
  );

  // Fire-and-forget Sheet append. Per the plan: Postgres is source of truth;
  // Sheet is secondary tier. Failures must NOT bubble to the caller.
  const sheetRow: AuditLlmCallRow = {
    timestampUtc: new Date().toISOString(),
    contactId: params.contactId ?? "",
    model: params.model,
    promptClass: params.promptClass,
    redactedInputHash,
    responseHash: responseHash ?? "",
    redactionsApplied: params.redactionsApplied.join(","),
    inputTokens: params.inputTokens ?? 0,
    outputTokens: params.outputTokens ?? 0,
    costUsd: costUsd ?? "",
    outcome: params.outcome,
  };
  appendLlmCallToSheet(sheetRow).catch((err: unknown) => {
    console.error("[audit-llm] Sheet append failed (non-fatal):", err);
  });
}

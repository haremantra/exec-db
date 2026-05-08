// Counterfactual task ranker (M1, SY-013, US-024, W8.3, invariant #7).
//
// Why this file exists
// --------------------
// The trust threshold for a "Do this first" recommendation, per W8.3, is that
// the system explains what it deprioritized and why — i.e. every top pick
// carries a counterfactual. Cross-cutting invariant #7 (docs/pr3-spec.md)
// hard-codes that requirement: the dashboard MUST surface alternatives with
// 1-sentence deprioritization reasons or the recommendation cannot ship.
//
// Design choices
//   * Model: Opus (correctness-critical, scoring rationale).
//   * LLM surface: `safeAnthropic` only — redaction + audit logging come for
//     free. No direct Anthropic SDK imports here (cross-cutting invariant #2).
//   * Output: strict JSON, parsed into a typed `RankingResult`. On any parse
//     failure or LLM error we fall back to a deterministic ranking so the
//     dashboard always renders something, even offline.
//   * Override audit: when the exec disagrees, we write to `audit.access_log`
//     with the original ranking + chosen pick captured in `metadata`. This is
//     the same pattern used by `saveDraftToGmailConfirmed` (AD-003).
//
// Out of scope here: cohort selection (Stream N), digest assembly (Stream P),
// dashboard layout (Stream L). M only ranks; consumers decide what to render.
//
// File charter (PR3-M):
//   - rankTasks(tasks, session) → { topPick, alternatives }
//   - recordRankingOverride(rankingResult, chosenTaskId, session) → audit row

import { safeAnthropic } from "@/lib/anthropic";
import { recordAccess } from "@/lib/audit";
import { query } from "@/lib/db";
import type { Session } from "@/lib/rbac";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Subset of `pm.task` fields the ranker needs. Kept narrow on purpose so the
 * caller (dashboard) can pass plain JS objects without leaking the full row.
 */
export interface RankerTask {
  id: string;
  title: string;
  workArea: string | null;
  impact: "revenue" | "reputation" | "both" | "neither" | null;
  isPinned: boolean;
  dueDate: string | null;
  priority: number;
  status: string;
}

export interface RankingTopPick {
  taskId: string;
  reason: string;
}

export interface RankingAlternative {
  taskId: string;
  deprioritizationReason: string;
}

export interface RankingResult {
  /** `null` only when the input list is empty. */
  topPick: RankingTopPick | null;
  /** Up to 3 alternatives, each with a 1-sentence "why not first" reason. */
  alternatives: RankingAlternative[];
}

/**
 * How many candidates the ranker considers. Anything beyond this is trimmed
 * before the prompt is built to keep token spend bounded (Opus budget).
 */
const MAX_CANDIDATES = 10;

/**
 * How many alternatives we surface in `RankingResult`. Spec: "≤3".
 */
const MAX_ALTERNATIVES = 3;

const SYSTEM_PROMPT =
  "You rank tasks by revenue and reputation impact for a busy CEO. " +
  "Always produce a counterfactual: for every task you do NOT pick first, " +
  "explain in one sentence why it was deprioritized relative to the top pick.";

// ---------------------------------------------------------------------------
// Deterministic fallback ranking
// ---------------------------------------------------------------------------

/**
 * Impact weight for the deterministic tie-break. Higher = stronger.
 * Order matches the prompt instruction to the LLM:
 *   both > revenue > reputation > neither > null (unassessed)
 */
const IMPACT_WEIGHT: Record<string, number> = {
  both: 4,
  revenue: 3,
  reputation: 2,
  neither: 1,
};

function impactScore(impact: RankerTask["impact"]): number {
  if (!impact) return 0;
  return IMPACT_WEIGHT[impact] ?? 0;
}

/**
 * Deterministic ranking, used as fallback when the LLM call or JSON parse
 * fails. Documented order (highest priority first):
 *   1. Pinned items first (`is_pinned DESC`)
 *   2. Impact weight (both > revenue > reputation > neither > null)
 *   3. Priority (lower number = higher priority — matches the kanban convention)
 *   4. Due date (earlier date first; null dates sort last)
 *   5. Title (stable tiebreaker, alphabetical)
 *
 * Exported so the test suite can pin the documented order down with a
 * regression guard.
 */
export function deterministicRank(tasks: RankerTask[]): RankerTask[] {
  return [...tasks].sort((a, b) => {
    // 1. Pinned first
    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
    // 2. Impact
    const impactDiff = impactScore(b.impact) - impactScore(a.impact);
    if (impactDiff !== 0) return impactDiff;
    // 3. Priority — convention: 0 = highest, 9 = lowest. Lower wins.
    if (a.priority !== b.priority) return a.priority - b.priority;
    // 4. Due date — earlier first; nulls sort last.
    if (a.dueDate !== b.dueDate) {
      if (a.dueDate == null) return 1;
      if (b.dueDate == null) return -1;
      return a.dueDate < b.dueDate ? -1 : 1;
    }
    // 5. Title alphabetic
    return a.title.localeCompare(b.title);
  });
}

function fallbackRanking(tasks: RankerTask[]): RankingResult {
  if (tasks.length === 0) return { topPick: null, alternatives: [] };
  const sorted = deterministicRank(tasks);
  const head = sorted[0]!;
  const rest = sorted.slice(1, 1 + MAX_ALTERNATIVES);
  return {
    topPick: {
      taskId: head.id,
      reason: fallbackReason(head),
    },
    alternatives: rest.map((t) => ({
      taskId: t.id,
      deprioritizationReason: fallbackDeprioritizationReason(t, head),
    })),
  };
}

function fallbackReason(t: RankerTask): string {
  const bits: string[] = [];
  if (t.isPinned) bits.push("pinned by exec");
  if (t.impact) bits.push(`impact=${t.impact}`);
  if (t.dueDate) bits.push(`due ${t.dueDate}`);
  bits.push(`priority ${t.priority}`);
  return `Selected by deterministic fallback: ${bits.join(", ")}.`;
}

function fallbackDeprioritizationReason(t: RankerTask, top: RankerTask): string {
  if (top.isPinned && !t.isPinned) {
    return "Top pick is pinned; this one is not.";
  }
  if (impactScore(top.impact) > impactScore(t.impact)) {
    return `Top pick has stronger impact (${top.impact ?? "n/a"} > ${t.impact ?? "unassessed"}).`;
  }
  if (top.priority < t.priority) {
    return `Lower priority (P${t.priority} vs P${top.priority}).`;
  }
  if (top.dueDate && (!t.dueDate || top.dueDate < t.dueDate)) {
    return "Top pick is due sooner.";
  }
  return "Tied on signals; alphabetical fallback placed top pick first.";
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

function buildPrompt(tasks: RankerTask[]): string {
  const lines = tasks.map((t, i) => {
    const fields = [
      `id=${t.id}`,
      `title=${JSON.stringify(t.title)}`,
      `work_area=${t.workArea ?? "null"}`,
      `impact=${t.impact ?? "null"}`,
      `is_pinned=${t.isPinned}`,
      `due_date=${t.dueDate ?? "null"}`,
      `priority=${t.priority}`,
      `status=${t.status}`,
    ];
    return `(${i + 1}) ${fields.join(" | ")}`;
  });

  return [
    "Candidate tasks (each one line):",
    lines.join("\n"),
    "",
    "Rank these tasks for a busy CEO who wants to do ONE thing first.",
    "Weight `impact` strongly: both > revenue > reputation > neither > null.",
    "Pinned items are always pick-eligible (the exec has flagged them as always-on),",
    "but you may still surface qualitative reasons for or against them.",
    "",
    `Return at most ${MAX_ALTERNATIVES + 1} candidates total: 1 top pick + up to ${MAX_ALTERNATIVES} alternatives.`,
    "Each alternative MUST include a counterfactual — one sentence explaining",
    "why this OTHER task was deprioritized relative to the top pick.",
    "",
    "Output ONLY a JSON object on a single line, no prose, matching this shape:",
    '{"topPick":{"taskId":"<uuid>","reason":"<one sentence>"},',
    '"alternatives":[{"taskId":"<uuid>","deprioritizationReason":"<one sentence>"}]}',
  ].join("\n");
}

// ---------------------------------------------------------------------------
// JSON parse
// ---------------------------------------------------------------------------

function tryParseRanking(
  raw: string,
  validIds: Set<string>,
): RankingResult | null {
  // Strip code fences if Claude wrapped the JSON.
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;

  const topPickObj = obj["topPick"];
  if (!topPickObj || typeof topPickObj !== "object") return null;
  const tp = topPickObj as Record<string, unknown>;
  const tpId = typeof tp["taskId"] === "string" ? (tp["taskId"] as string) : null;
  const tpReason =
    typeof tp["reason"] === "string" ? (tp["reason"] as string) : null;
  if (!tpId || !tpReason || !validIds.has(tpId)) return null;

  const altsRaw = Array.isArray(obj["alternatives"]) ? (obj["alternatives"] as unknown[]) : [];
  const alternatives: RankingAlternative[] = [];
  for (const a of altsRaw) {
    if (!a || typeof a !== "object") continue;
    const ar = a as Record<string, unknown>;
    const id = typeof ar["taskId"] === "string" ? (ar["taskId"] as string) : null;
    const reason =
      typeof ar["deprioritizationReason"] === "string"
        ? (ar["deprioritizationReason"] as string)
        : null;
    if (!id || !reason) continue;
    if (!validIds.has(id)) continue;
    if (id === tpId) continue;
    alternatives.push({ taskId: id, deprioritizationReason: reason });
    if (alternatives.length >= MAX_ALTERNATIVES) break;
  }

  return {
    topPick: { taskId: tpId, reason: tpReason },
    alternatives,
  };
}

// ---------------------------------------------------------------------------
// Public API: rankTasks
// ---------------------------------------------------------------------------

/**
 * Rank up to {@link MAX_CANDIDATES} tasks via Opus, returning a top pick plus
 * up to {@link MAX_ALTERNATIVES} alternatives — each with a counterfactual
 * deprioritization reason (invariant #7).
 *
 * Always returns a result. On LLM error or malformed JSON, falls back to
 * {@link deterministicRank}.
 */
export async function rankTasks(
  tasks: RankerTask[],
  // Session is accepted for parity with other LLM-touching helpers (briefing,
  // autodraft) and to reserve future per-tier behavior; not used today.
  _session: Session,
): Promise<RankingResult> {
  if (!tasks || tasks.length === 0) {
    return { topPick: null, alternatives: [] };
  }

  // Trim before LLM. Pinned items always fit in the candidate window: we
  // include all pinned tasks, then fill the remainder with non-pinned tasks
  // in deterministic order. This satisfies the spec contract that "pinned
  // items are always pick-eligible."
  const candidates = pickCandidates(tasks);
  const validIds = new Set(candidates.map((c) => c.id));

  const prompt = buildPrompt(candidates);

  let llmText: string | null = null;
  try {
    const result = await safeAnthropic({
      model: "opus",
      system: SYSTEM_PROMPT,
      prompt,
      contactId: null,
      promptClass: "rank",
      maxTokens: 1024,
    });
    llmText = result.text;
  } catch (err) {
    // Audit log already captured by safeAnthropic on the error path.
    console.error("[ranker] Opus call failed; falling back:", err);
    return fallbackRanking(candidates);
  }

  const parsed = tryParseRanking(llmText ?? "", validIds);
  if (!parsed) {
    console.error("[ranker] JSON parse failed; falling back. Raw:", llmText);
    return fallbackRanking(candidates);
  }

  return parsed;
}

function pickCandidates(tasks: RankerTask[]): RankerTask[] {
  if (tasks.length <= MAX_CANDIDATES) return tasks;
  const pinned = tasks.filter((t) => t.isPinned);
  const rest = tasks.filter((t) => !t.isPinned);
  const remainingSlots = Math.max(0, MAX_CANDIDATES - pinned.length);
  const restRanked = deterministicRank(rest).slice(0, remainingSlots);
  // If there are more pinned than the cap, the deterministic order still
  // picks the strongest by impact/priority/due-date.
  const pinnedRanked = deterministicRank(pinned).slice(0, MAX_CANDIDATES);
  return [...pinnedRanked, ...restRanked].slice(0, MAX_CANDIDATES);
}

// ---------------------------------------------------------------------------
// Public API: recordRankingOverride
// ---------------------------------------------------------------------------

/**
 * Record an exec override of the ranker's top pick into `audit.access_log`.
 *
 * Triggered by the dashboard "I disagree" button. Writes a single row with:
 *   - intent: human-readable summary including chosen vs original taskId.
 *   - metadata: full ranking JSON + chosenTaskId, so an auditor can replay
 *     the decision.
 *
 * The override is non-destructive: the original ranking is preserved as-is.
 */
export async function recordRankingOverride(
  ranking: RankingResult,
  chosenTaskId: string,
  session: Session,
): Promise<void> {
  const originalTopPickId = ranking.topPick?.taskId ?? null;
  const intent =
    `exec overrode ranker top pick — chose ${chosenTaskId} ` +
    `instead of ${originalTopPickId ?? "<none>"}; reason absent`;

  await query(
    {
      userId: session.userId,
      tier: session.tier,
      functionArea: session.functionArea,
    },
    async (tx) => {
      await recordAccess(tx, session, {
        schemaName: "pm",
        tableName: "task",
        action: "SELECT",
        intent,
        metadata: {
          override: "ranker_top_pick",
          originalTopPickId,
          chosenTaskId,
          ranking,
        },
      });
    },
  );
}

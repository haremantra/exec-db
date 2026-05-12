/**
 * metrics.ts — Pure data helpers for the /metrics page.
 *
 * Each function issues exactly one query through query(ctx, …) so RLS applies.
 * No LLM calls — pure SQL aggregation.
 *
 * Signal sources:
 *   1. Disagree rate      — audit.access_log (intent = 'ranker_override')
 *   2. Sensitive flags    — crm.contact (sensitive_flag IS NOT NULL)
 *   3. Draft status dist. — crm.draft (status distribution)
 *   4. LLM calls by class — audit.llm_call (grouped by prompt_class, 14d window)
 *   5. Retro judgements   — audit.access_log (intent = 'retrospective_judgement')
 *   6. Resend stats       — external link only (no proxy)
 */

import { schema } from "@exec-db/db";
import { and, eq, gte, isNotNull, sql } from "drizzle-orm";
import type { Session } from "@/lib/rbac";
import { query } from "@/lib/db";

// ── Types ────────────────────────────────────────────────────────────────────

export type DisagreeRate = {
  overrides: number;
  rankings: number;
  rate: number;
};

export type SensitiveFlagActivations = {
  total: number;
  last7Days: number;
  byTag: Record<string, number>;
};

export type DraftStatusDistribution = {
  pending: number;
  savedToGmail: number;
  discarded: number;
};

export type LlmCallByClass = {
  promptClass: string;
  count: number;
  totalCostUsd: number;
};

export type RetrospectiveJudgements = {
  kept_promise: number;
  partial: number;
  broke_promise: number;
  total: number;
};

// ── Helper: build session context from Session ────────────────────────────────

function ctx(session: Session) {
  return {
    userId: session.userId,
    tier: session.tier,
    functionArea: session.functionArea,
  };
}

// ── 1. Disagree rate ─────────────────────────────────────────────────────────

/**
 * Disagree rate = overrides / total_rankings.
 *
 * Overrides: audit.access_log rows with intent = 'ranker_override'
 *            (written by recordRankingOverride in lib/ranker.ts)
 *
 * Rankings:  audit.llm_call rows with prompt_class = 'rank'
 *            (written by safeAnthropic inside rankTasks)
 */
export async function getDisagreeRate(session: Session): Promise<DisagreeRate> {
  const [overridesResult, rankingsResult] = await Promise.all([
    query(ctx(session), (tx) =>
      tx
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.accessLog)
        .where(eq(schema.accessLog.intent, "ranker_override")),
    ),
    query(ctx(session), (tx) =>
      tx
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.llmCall)
        .where(eq(schema.llmCall.promptClass, "rank")),
    ),
  ]);

  const overrides = overridesResult[0]?.count ?? 0;
  const rankings = rankingsResult[0]?.count ?? 0;
  const rate = rankings === 0 ? 0 : overrides / rankings;

  return { overrides, rankings, rate };
}

// ── 2. Sensitive-flag activations ────────────────────────────────────────────

/**
 * Count of crm.contact rows where sensitive_flag IS NOT NULL.
 * Includes a 7-day delta (contacts where updated_at >= now() - 7 days AND
 * sensitive_flag IS NOT NULL).
 * Also breaks down by tag value.
 *
 * Note: RLS on crm.contact already excludes sensitive contacts from non-exec
 * readers. No need to add a duplicate filter here.
 */
export async function getSensitiveFlagActivations(
  session: Session,
): Promise<SensitiveFlagActivations> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [allRows, recentRows] = await Promise.all([
    query(ctx(session), (tx) =>
      tx
        .select({
          sensitiveFlag: schema.contact.sensitiveFlag,
          count: sql<number>`count(*)::int`,
        })
        .from(schema.contact)
        .where(isNotNull(schema.contact.sensitiveFlag))
        .groupBy(schema.contact.sensitiveFlag),
    ),
    query(ctx(session), (tx) =>
      tx
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.contact)
        .where(
          and(
            isNotNull(schema.contact.sensitiveFlag),
            gte(schema.contact.updatedAt, sevenDaysAgo),
          ),
        ),
    ),
  ]);

  const byTag: Record<string, number> = {};
  let total = 0;
  for (const row of allRows) {
    if (row.sensitiveFlag) {
      byTag[row.sensitiveFlag] = row.count;
      total += row.count;
    }
  }

  const last7Days = recentRows[0]?.count ?? 0;

  return { total, last7Days, byTag };
}

// ── 3. Draft status distribution ─────────────────────────────────────────────

/**
 * Distribution of crm.draft.status values.
 * Expected values: 'pending' | 'saved_to_gmail' | 'discarded'
 */
export async function getDraftStatusDistribution(
  session: Session,
): Promise<DraftStatusDistribution> {
  const rows = await query(ctx(session), (tx) =>
    tx
      .select({
        status: schema.draft.status,
        count: sql<number>`count(*)::int`,
      })
      .from(schema.draft)
      .groupBy(schema.draft.status),
  );

  const dist: DraftStatusDistribution = {
    pending: 0,
    savedToGmail: 0,
    discarded: 0,
  };

  for (const row of rows) {
    if (row.status === "pending") dist.pending = row.count;
    else if (row.status === "saved_to_gmail") dist.savedToGmail = row.count;
    else if (row.status === "discarded") dist.discarded = row.count;
  }

  return dist;
}

// ── 4. LLM calls by class ────────────────────────────────────────────────────

/**
 * Rows from audit.llm_call grouped by prompt_class over the last `windowDays`.
 * Returns count and total cost per class, ordered by count descending.
 */
export async function getLlmCallsByClass(
  session: Session,
  windowDays = 14,
): Promise<Array<LlmCallByClass>> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  const rows = await query(ctx(session), (tx) =>
    tx
      .select({
        promptClass: schema.llmCall.promptClass,
        count: sql<number>`count(*)::int`,
        totalCostUsd: sql<number>`coalesce(sum(cost_usd::numeric), 0)::float`,
      })
      .from(schema.llmCall)
      .where(gte(schema.llmCall.timestampUtc, since))
      .groupBy(schema.llmCall.promptClass),
  );

  return rows
    .map((r) => ({
      promptClass: r.promptClass,
      count: r.count,
      totalCostUsd: r.totalCostUsd,
    }))
    .sort((a, b) => b.count - a.count);
}

// ── 5. Retrospective judgements ───────────────────────────────────────────────

/**
 * Counts of audit.access_log rows with intent = 'retrospective_judgement',
 * grouped by metadata.judgement value.
 *
 * Each row's metadata.judgement is one of:
 *   'kept_promise' | 'partial' | 'broke_promise'
 */
export async function getRetrospectiveJudgements(
  session: Session,
): Promise<RetrospectiveJudgements> {
  const rows = await query(ctx(session), (tx) =>
    tx
      .select({
        judgement: sql<string>`metadata->>'judgement'`,
        count: sql<number>`count(*)::int`,
      })
      .from(schema.accessLog)
      .where(eq(schema.accessLog.intent, "retrospective_judgement"))
      .groupBy(sql`metadata->>'judgement'`),
  );

  const result: RetrospectiveJudgements = {
    kept_promise: 0,
    partial: 0,
    broke_promise: 0,
    total: 0,
  };

  for (const row of rows) {
    if (row.judgement === "kept_promise") result.kept_promise = row.count;
    else if (row.judgement === "partial") result.partial = row.count;
    else if (row.judgement === "broke_promise") result.broke_promise = row.count;
    result.total += row.count;
  }

  return result;
}

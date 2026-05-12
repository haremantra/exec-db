/**
 * cost-guard.ts — Per-day Anthropic spend cap + breach alerting.
 *
 * Why this exists
 * ---------------
 * The $200/mo platform ceiling (S10.1) is enforced at the Anthropic account
 * level, but a runaway loop (bad prompt retrying forever, or an
 * Opus-on-every-call regression) can exhaust the budget in a single day before
 * any platform alert fires. This module adds a hard in-app floor:
 *
 *   1. getTodaysSpend()     — query audit.llm_call for today's cumulative cost.
 *   2. assertWithinBudget() — throw CostGuardError if the cap is exceeded.
 *   3. notifyBudgetBreach() — send one alert email per UTC day (idempotent).
 *
 * Default cap: $5 USD/day = $150/mo at max daily usage, leaving 25% headroom
 * under the $200/mo ceiling. Override with DAILY_LLM_BUDGET_USD env var.
 *
 * Idempotency for notifyBudgetBreach: a sentinel row is written to
 * audit.access_log (intent="cost_guard_breach_notified", metadata.date=today)
 * before sending. A second call on the same UTC day finds the row and returns
 * without re-sending.
 *
 * Required env vars (see docs/pr3-prereqs-runbook.md):
 *   DAILY_LLM_BUDGET_USD    — default "5" (fail-closed)
 *   BUDGET_ALERT_RECIPIENT  — email address to receive breach alerts
 */

import { sql } from "drizzle-orm";
import { schema } from "@exec-db/db";
import { query } from "@/lib/db";
import { sendEmailViaResend } from "@/lib/email-resend";
import type { Session } from "@/lib/rbac";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SYSTEM_USER = "00000000-0000-0000-0000-000000000000";
const SYSTEM_SESSION = {
  userId: SYSTEM_USER,
  tier: "exec_all" as const,
  functionArea: null,
};

const DEFAULT_DAILY_CAP_USD = 5.0; // $5/day = $150/mo at ceiling; 25% headroom under $200/mo

// ---------------------------------------------------------------------------
// Public error class
// ---------------------------------------------------------------------------

export class CostGuardError extends Error {
  readonly totalUsd: number;
  readonly capUsd: number;
  readonly calls: number;

  constructor(opts: { totalUsd: number; capUsd: number; calls: number }) {
    super(
      `Daily LLM budget exceeded — $${opts.totalUsd.toFixed(4)} spent of $${opts.capUsd.toFixed(2)} cap (${opts.calls} calls today). Try again tomorrow or raise DAILY_LLM_BUDGET_USD.`,
    );
    this.name = "CostGuardError";
    this.totalUsd = opts.totalUsd;
    this.capUsd = opts.capUsd;
    this.calls = opts.calls;
  }
}

// ---------------------------------------------------------------------------
// Public: getTodaysSpend
// ---------------------------------------------------------------------------

export interface TodaysSpend {
  totalUsd: number;
  calls: number;
  modelBreakdown: Record<string, number>;
}

/**
 * Query audit.llm_call for rows where timestamp_utc::date = current_date (UTC).
 * Pure read — never throws on missing cost rows (they may have null cost_usd
 * for calls without token counts).
 */
export async function getTodaysSpend(session?: Session): Promise<TodaysSpend> {
  const ctx = session ?? SYSTEM_SESSION;

  // Raw SQL for the aggregation — Drizzle's aggregate helpers don't expose
  // ::date casting cleanly, so we use sql`` tagged literals.
  const rows = await query(ctx, async (tx) => {
    return tx.execute(sql`
      SELECT
        model,
        COUNT(*)::int AS calls,
        COALESCE(SUM(cost_usd::numeric), 0)::float8 AS model_cost
      FROM audit.llm_call
      WHERE timestamp_utc::date = current_date
        AND outcome != 'killed'
      GROUP BY model
    `);
  });

  let totalUsd = 0;
  let totalCalls = 0;
  const modelBreakdown: Record<string, number> = {};

  for (const row of rows.rows as Array<{
    model: string;
    calls: number;
    model_cost: number;
  }>) {
    const cost = Number(row.model_cost ?? 0);
    const calls = Number(row.calls ?? 0);
    totalUsd += cost;
    totalCalls += calls;
    modelBreakdown[row.model] = (modelBreakdown[row.model] ?? 0) + cost;
  }

  return { totalUsd, calls: totalCalls, modelBreakdown };
}

// ---------------------------------------------------------------------------
// Public: assertWithinBudget
// ---------------------------------------------------------------------------

/**
 * Throw CostGuardError if today's cumulative Anthropic spend exceeds the cap.
 *
 * Default cap: DAILY_LLM_BUDGET_USD env var (default 5.0).
 * Callers may pass opts.dailyCapUsd to override the cap for a single call
 * (e.g. staging environments).
 */
export async function assertWithinBudget(
  session?: Session,
  opts?: { dailyCapUsd?: number },
): Promise<void> {
  const capUsd =
    opts?.dailyCapUsd ??
    parseFloat(process.env["DAILY_LLM_BUDGET_USD"] ?? String(DEFAULT_DAILY_CAP_USD));

  const spend = await getTodaysSpend(session);

  if (spend.totalUsd >= capUsd) {
    throw new CostGuardError({
      totalUsd: spend.totalUsd,
      capUsd,
      calls: spend.calls,
    });
  }
}

// ---------------------------------------------------------------------------
// Public: notifyBudgetBreach
// ---------------------------------------------------------------------------

export interface BreachNotifyParams {
  totalUsd: number;
  capUsd: number;
  date: string; // YYYY-MM-DD UTC
}

/**
 * Send a single breach-alert email per UTC day.
 *
 * Idempotency: writes a sentinel row to audit.access_log before sending.
 * If the sentinel row already exists for today, returns immediately without
 * re-sending. This prevents duplicate emails when multiple concurrent requests
 * hit the budget wall simultaneously.
 *
 * Silently no-ops if BUDGET_ALERT_RECIPIENT is unset (no crash — the guard
 * still blocks LLM calls; the absence of an alert recipient is intentional
 * for environments that don't need email alerts).
 */
export async function notifyBudgetBreach(params: BreachNotifyParams): Promise<void> {
  const recipient = process.env["BUDGET_ALERT_RECIPIENT"];
  if (!recipient) {
    // No alert recipient configured — guard still works, alert is silent.
    console.warn(
      "[cost-guard] BUDGET_ALERT_RECIPIENT not set; breach alert not sent.",
    );
    return;
  }

  const sentinelIntent = "cost_guard_breach_notified";

  // Check for an existing sentinel row for today.
  const existing = await query(SYSTEM_SESSION, async (tx) => {
    return tx.execute(sql`
      SELECT id FROM audit.access_log
      WHERE intent = ${sentinelIntent}
        AND occurred_at::date = ${params.date}::date
      LIMIT 1
    `);
  });

  if ((existing.rows as unknown[]).length > 0) {
    // Already notified today — idempotent no-op.
    return;
  }

  // Write the sentinel row BEFORE sending to prevent duplicate sends
  // even under concurrent requests.
  await query(SYSTEM_SESSION, async (tx) => {
    await tx.insert(schema.accessLog).values({
      userId: SYSTEM_USER,
      tier: "exec_all",
      action: "INSERT",
      schemaName: "audit",
      tableName: "access_log",
      rowPk: null,
      queryHash: null,
      intent: sentinelIntent,
      metadata: {
        date: params.date,
        totalUsd: params.totalUsd,
        capUsd: params.capUsd,
      },
    });
  });

  // Build the alert email.
  const subject = `[exec-db] Daily LLM budget breached — $${params.totalUsd.toFixed(4)} on ${params.date}`;

  const overage = (params.totalUsd - params.capUsd).toFixed(4);
  const pct = ((params.totalUsd / params.capUsd) * 100).toFixed(1);

  const text = [
    `exec-db cost alert`,
    ``,
    `Date (UTC): ${params.date}`,
    `Spent today: $${params.totalUsd.toFixed(4)}`,
    `Daily cap:   $${params.capUsd.toFixed(2)}`,
    `Overage:     $${overage} (${pct}% of cap)`,
    ``,
    `All further LLM calls for today are blocked.`,
    `To resume before tomorrow (UTC midnight), raise DAILY_LLM_BUDGET_USD`,
    `in your Vercel env vars and redeploy.`,
    ``,
    `— exec-db automated alert`,
  ].join("\n");

  const html = `
<p><strong>exec-db cost alert</strong></p>
<table>
  <tr><td>Date (UTC)</td><td>${params.date}</td></tr>
  <tr><td>Spent today</td><td>$${params.totalUsd.toFixed(4)}</td></tr>
  <tr><td>Daily cap</td><td>$${params.capUsd.toFixed(2)}</td></tr>
  <tr><td>Overage</td><td>$${overage} (${pct}% of cap)</td></tr>
</table>
<p>All further LLM calls for today are <strong>blocked</strong>.</p>
<p>To resume before tomorrow (UTC midnight), raise
<code>DAILY_LLM_BUDGET_USD</code> in your Vercel env vars and redeploy.</p>
<p><em>— exec-db automated alert</em></p>
`.trim();

  await sendEmailViaResend({ to: recipient, subject, html, text });
}

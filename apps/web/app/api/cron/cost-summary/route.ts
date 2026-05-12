/**
 * /api/cron/cost-summary — Daily cost visibility cron (cost guardrails).
 *
 * Schedule: "0 15 * * *" (15:00 UTC = 7:00 am America/Los_Angeles PDT).
 * See apps/web/vercel.json for the cron schedule declaration.
 *
 * This cron fires AFTER UTC midnight rolls over, so "yesterday" is the
 * complete day that just ended. It sends a one-line cost summary to the
 * BUDGET_ALERT_RECIPIENT address. This is the "I have visibility" signal —
 * it always sends, even on days with $0 spend. The breach alert (one per day,
 * idempotent) fires from safeAnthropic/safeAnthropicStream at breach time.
 *
 * Auth: Vercel Cron sends `Authorization: Bearer ${CRON_SECRET}` on every
 * invocation. We reject anything without that header to prevent unauthorized
 * triggering.
 *
 * Required env vars:
 *   CRON_SECRET              — shared secret Vercel sets automatically.
 *   BUDGET_ALERT_RECIPIENT   — email address for the cost summary.
 *   DATABASE_URL_APP         — Postgres connection.
 *   RESEND_API_KEY           — Resend delivery key.
 */

import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { query } from "@/lib/db";
import { sendEmailViaResend } from "@/lib/email-resend";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SYSTEM_SESSION = {
  userId: "00000000-0000-0000-0000-000000000000",
  tier: "exec_all" as const,
  functionArea: null,
};

export async function GET(req: NextRequest): Promise<NextResponse> {
  // ── Auth: require Bearer CRON_SECRET ─────────────────────────────────────
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ── Compute yesterday's spend ─────────────────────────────────────────────
  // "Yesterday" in UTC — the complete day that just finished.
  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const dateStr = yesterday.toISOString().slice(0, 10); // YYYY-MM-DD

  const rows = await query(SYSTEM_SESSION, async (tx) => {
    return tx.execute(sql`
      SELECT
        model,
        COUNT(*)::int AS calls,
        COALESCE(SUM(cost_usd::numeric), 0)::float8 AS model_cost
      FROM audit.llm_call
      WHERE timestamp_utc::date = ${dateStr}::date
      GROUP BY model
    `);
  });

  let totalUsd = 0;
  let totalCalls = 0;
  const modelBreakdown: Record<string, { calls: number; costUsd: number }> = {};

  for (const row of rows as unknown as Array<{
    model: string;
    calls: number;
    model_cost: number;
  }>) {
    const cost = Number(row.model_cost ?? 0);
    const calls = Number(row.calls ?? 0);
    totalUsd += cost;
    totalCalls += calls;
    modelBreakdown[row.model] = { calls, costUsd: cost };
  }

  const capUsd = parseFloat(process.env["DAILY_LLM_BUDGET_USD"] ?? "5");
  const pctOfCap = capUsd > 0 ? ((totalUsd / capUsd) * 100).toFixed(1) : "N/A";

  const summary = {
    date: dateStr,
    totalUsd: parseFloat(totalUsd.toFixed(6)),
    calls: totalCalls,
    capUsd,
    pctOfCap,
    modelBreakdown,
  };

  // ── Send summary email ─────────────────────────────────────────────────────
  const recipient = process.env["BUDGET_ALERT_RECIPIENT"];
  if (recipient) {
    const breakdownLines = Object.entries(modelBreakdown)
      .map(
        ([model, { calls, costUsd }]) =>
          `  ${model}: ${calls} calls, $${costUsd.toFixed(4)}`,
      )
      .join("\n");

    const text = [
      `exec-db daily cost summary for ${dateStr}`,
      ``,
      `Total spent: $${totalUsd.toFixed(4)} (${pctOfCap}% of $${capUsd.toFixed(2)} daily cap)`,
      `Total calls: ${totalCalls}`,
      ``,
      breakdownLines || `  No LLM calls recorded.`,
      ``,
      `— exec-db automated summary`,
    ].join("\n");

    const htmlBreakdown =
      Object.entries(modelBreakdown)
        .map(
          ([model, { calls, costUsd }]) =>
            `<tr><td>${model}</td><td>${calls}</td><td>$${costUsd.toFixed(4)}</td></tr>`,
        )
        .join("") || `<tr><td colspan="3">No LLM calls recorded.</td></tr>`;

    const html = `
<p><strong>exec-db daily cost summary — ${dateStr}</strong></p>
<table>
  <tr><td>Total spent</td><td>$${totalUsd.toFixed(4)} (${pctOfCap}% of $${capUsd.toFixed(2)} cap)</td></tr>
  <tr><td>Total calls</td><td>${totalCalls}</td></tr>
</table>
<h4>By model</h4>
<table>
  <tr><th>Model</th><th>Calls</th><th>Cost</th></tr>
  ${htmlBreakdown}
</table>
<p><em>— exec-db automated summary</em></p>
`.trim();

    await sendEmailViaResend({
      to: recipient,
      subject: `[exec-db] Daily cost summary ${dateStr} — $${totalUsd.toFixed(4)}`,
      html,
      text,
    });
  }

  return NextResponse.json(summary);
}

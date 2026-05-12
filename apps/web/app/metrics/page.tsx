/**
 * /metrics — Week-1/2 signal dashboard for exec_all tier.
 *
 * Server component, force-dynamic.
 * Returns a 403-style "Forbidden" message for any non-exec_all session
 * (does NOT redirect — per spec).
 *
 * Six sections in order:
 *   1. Disagree rate on Do-this-first
 *   2. Sensitive-flag activations (current + 7-day delta + by-tag table)
 *   3. Draft save vs. discard ratio (current + 7-day delta of pending count)
 *   4. LLM call row count vs. expected (text-bar by prompt_class, 14-day window)
 *   5. Retrospective judgements (kept / partial / broke)
 *   6. Resend stats (external link only)
 */

import { getSession } from "@/lib/auth";
import {
  getDisagreeRate,
  getDraftStatusDistribution,
  getLlmCallsByClass,
  getRetrospectiveJudgements,
  getSensitiveFlagActivations,
} from "@/lib/metrics";

export const dynamic = "force-dynamic";

// ── Text-bar renderer ─────────────────────────────────────────────────────────

const BAR_CHARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/**
 * Render a simple proportional text bar for a single value relative to `max`.
 * Returns a string of bar-block chars proportional to value/max, up to width chars.
 */
function textBar(value: number, max: number, width = 20): string {
  if (max === 0) return "—";
  const filled = Math.round((value / max) * width);
  const lastIdx = filled > 0 ? Math.floor(((value / max) * width - (filled - 1)) * (BAR_CHARS.length - 1)) : 0;
  if (filled === 0) return BAR_CHARS[0]!;
  return BAR_CHARS[BAR_CHARS.length - 1]!.repeat(Math.max(0, filled - 1)) +
    (BAR_CHARS[lastIdx] ?? BAR_CHARS[0]!);
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SectionHeader({ title }: { title: string }) {
  return (
    <div className="border-b border-neutral-200 pb-2 dark:border-neutral-800">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-700 dark:text-neutral-300">
        {title}
      </h2>
    </div>
  );
}

function Metric({
  label,
  value,
  sub,
}: {
  label: string;
  value: string | number;
  sub?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-2xl font-bold tabular-nums">{value}</span>
      <span className="text-xs text-neutral-500">{label}</span>
      {sub && <span className="text-xs text-neutral-400">{sub}</span>}
    </div>
  );
}

function DeltaBadge({ delta }: { delta: number }) {
  if (delta === 0)
    return (
      <span className="rounded bg-neutral-100 px-2 py-0.5 text-xs text-neutral-500 dark:bg-neutral-800">
        +0 this week
      </span>
    );
  return (
    <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-800 dark:bg-amber-900 dark:text-amber-200">
      +{delta} last 7 days
    </span>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function MetricsPage(): Promise<JSX.Element> {
  const session = await getSession();

  // Access control: exec_all only. Return 403-style message, no redirect.
  if (!session || session.tier !== "exec_all") {
    return (
      <div className="rounded-md border border-red-300 bg-red-50 px-6 py-8 dark:border-red-700 dark:bg-red-950">
        <h1 className="text-base font-semibold text-red-800 dark:text-red-200">
          403 Forbidden
        </h1>
        <p className="mt-2 text-sm text-red-700 dark:text-red-300">
          The /metrics page is restricted to the exec_all tier.
        </p>
      </div>
    );
  }

  // Fetch all 5 queryable signals in parallel.
  const [disagreeRate, sensitiveFlagData, draftDist, llmCalls, judgements] =
    await Promise.all([
      getDisagreeRate(session),
      getSensitiveFlagActivations(session),
      getDraftStatusDistribution(session),
      getLlmCallsByClass(session, 14),
      getRetrospectiveJudgements(session),
    ]);

  // ── Signal 1: Disagree rate ──────────────────────────────────────────────────
  const disagreeRatePct =
    disagreeRate.rate === 0
      ? "0%"
      : `${(disagreeRate.rate * 100).toFixed(1)}%`;

  // ── Signal 4: Text bars for LLM calls by class ───────────────────────────────
  const maxLlmCount = Math.max(...llmCalls.map((r) => r.count), 1);
  const totalLlmCalls = llmCalls.reduce((s, r) => s + r.count, 0);
  const totalLlmCost = llmCalls.reduce((s, r) => s + r.totalCostUsd, 0);

  // ── Signal 3: Totals ─────────────────────────────────────────────────────────
  const draftTotal =
    draftDist.pending + draftDist.savedToGmail + draftDist.discarded;
  const draftSaveRate =
    draftTotal === 0
      ? "—"
      : `${Math.round((draftDist.savedToGmail / draftTotal) * 100)}%`;

  // ── Signal 5: Judgement percentages ─────────────────────────────────────────
  const j = judgements;
  const jKeptPct =
    j.total === 0 ? "—" : `${Math.round((j.kept_promise / j.total) * 100)}%`;
  const jPartialPct =
    j.total === 0 ? "—" : `${Math.round((j.partial / j.total) * 100)}%`;
  const jBrokePct =
    j.total === 0 ? "—" : `${Math.round((j.broke_promise / j.total) * 100)}%`;

  return (
    <div className="space-y-10">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">
          Week-1/2 signal metrics
        </h1>
        <p className="mt-1 text-sm text-neutral-500">
          Six signals queryable today from existing tables — no additional
          instrumentation required.
        </p>
      </header>

      {/* ── Signal 1: Disagree rate ─────────────────────────────────────────── */}
      <section className="space-y-4" aria-label="Disagree rate on Do-this-first">
        <SectionHeader title="1. Disagree rate on Do-this-first" />
        <div className="flex flex-wrap items-end gap-8">
          <Metric
            value={disagreeRatePct}
            label="exec overrides / ranker calls"
            sub={`${disagreeRate.overrides} overrides out of ${disagreeRate.rankings} rankings`}
          />
        </div>
        <p className="text-xs text-neutral-500">
          Source: <code>audit.access_log</code> (intent = &apos;ranker_override&apos;) /{" "}
          <code>audit.llm_call</code> (prompt_class = &apos;rank&apos;). A rate above 50%
          indicates the ranker needs recalibration.
        </p>
      </section>

      {/* ── Signal 2: Sensitive-flag activations ──────────────────────────────── */}
      <section
        className="space-y-4"
        aria-label="Sensitive-flag activations"
      >
        <SectionHeader title="2. Sensitive-flag activations" />
        <div className="flex flex-wrap items-end gap-8">
          <Metric
            value={sensitiveFlagData.total}
            label="total flagged contacts"
          />
          <div className="flex flex-col gap-0.5">
            <DeltaBadge delta={sensitiveFlagData.last7Days} />
            <span className="text-xs text-neutral-400">
              contacts flagged in last 7 days
            </span>
          </div>
        </div>
        {Object.keys(sensitiveFlagData.byTag).length > 0 ? (
          <table className="w-full max-w-sm text-xs">
            <thead>
              <tr className="border-b border-neutral-200 dark:border-neutral-800">
                <th className="pb-1 text-left font-medium text-neutral-500">
                  Tag
                </th>
                <th className="pb-1 text-right font-medium text-neutral-500">
                  Count
                </th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(sensitiveFlagData.byTag).map(([tag, count]) => (
                <tr
                  key={tag}
                  className="border-b border-neutral-100 dark:border-neutral-900"
                >
                  <td className="py-1 font-mono text-neutral-700 dark:text-neutral-300">
                    {tag}
                  </td>
                  <td className="py-1 text-right tabular-nums">{count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-xs italic text-neutral-400">
            No contacts flagged as sensitive yet.
          </p>
        )}
        <p className="text-xs text-neutral-500">
          Source: <code>crm.contact.sensitive_flag</code> + <code>updated_at</code>.
          Only exec_all tier can set or clear this flag.
        </p>
      </section>

      {/* ── Signal 3: Draft save vs. discard ratio ────────────────────────────── */}
      <section
        className="space-y-4"
        aria-label="Draft save vs discard ratio"
      >
        <SectionHeader title="3. Draft save vs. discard ratio" />
        <div className="flex flex-wrap items-end gap-8">
          <Metric
            value={draftSaveRate}
            label="save rate (saved to Gmail / total decided)"
            sub={`${draftDist.savedToGmail} saved · ${draftDist.discarded} discarded · ${draftDist.pending} pending`}
          />
          <div className="flex flex-col gap-0.5">
            <DeltaBadge delta={draftDist.pending} />
            <span className="text-xs text-neutral-400">
              currently pending (unreviewed)
            </span>
          </div>
        </div>
        {draftTotal > 0 && (
          <dl className="grid max-w-xs grid-cols-3 gap-4 text-xs">
            <div className="flex flex-col gap-0.5">
              <dt className="text-neutral-500">Pending</dt>
              <dd className="text-base font-semibold tabular-nums">
                {draftDist.pending}
              </dd>
            </div>
            <div className="flex flex-col gap-0.5">
              <dt className="text-neutral-500">Saved</dt>
              <dd className="text-base font-semibold tabular-nums text-emerald-700 dark:text-emerald-400">
                {draftDist.savedToGmail}
              </dd>
            </div>
            <div className="flex flex-col gap-0.5">
              <dt className="text-neutral-500">Discarded</dt>
              <dd className="text-base font-semibold tabular-nums text-red-600 dark:text-red-400">
                {draftDist.discarded}
              </dd>
            </div>
          </dl>
        )}
        <p className="text-xs text-neutral-500">
          Source: <code>crm.draft.status</code> distribution. Target: save rate above
          60% indicates drafts are useful.
        </p>
      </section>

      {/* ── Signal 4: LLM call row count vs. expected ─────────────────────────── */}
      <section
        className="space-y-4"
        aria-label="LLM call row count by prompt class (14 days)"
      >
        <SectionHeader title="4. LLM calls by prompt_class (last 14 days)" />
        <div className="flex flex-wrap items-end gap-8">
          <Metric
            value={totalLlmCalls}
            label="total audit.llm_call rows (14d)"
            sub={`$${totalLlmCost.toFixed(4)} total cost`}
          />
        </div>
        {llmCalls.length === 0 ? (
          <p className="text-xs italic text-neutral-400">
            No LLM calls recorded in the last 14 days.
          </p>
        ) : (
          <div className="space-y-2">
            {llmCalls.map((r) => (
              <div key={r.promptClass} className="flex items-center gap-3">
                <span className="w-32 shrink-0 font-mono text-xs text-neutral-700 dark:text-neutral-300">
                  {r.promptClass}
                </span>
                <span
                  className="font-mono text-sm text-neutral-800 dark:text-neutral-200"
                  aria-label={`${r.count} calls`}
                  title={`${r.count} calls, $${r.totalCostUsd.toFixed(4)}`}
                >
                  {textBar(r.count, maxLlmCount)}
                </span>
                <span className="tabular-nums text-xs text-neutral-500">
                  {r.count}
                </span>
                <span className="text-xs text-neutral-400">
                  ${r.totalCostUsd.toFixed(4)}
                </span>
              </div>
            ))}
          </div>
        )}
        <p className="text-xs text-neutral-500">
          Source: <code>audit.llm_call</code>, append-only (AD-005). Bar chart is
          proportional to call count within the 14-day window.
        </p>
      </section>

      {/* ── Signal 5: Retrospective judgements ────────────────────────────────── */}
      <section
        className="space-y-4"
        aria-label="Retrospective judgements"
      >
        <SectionHeader title="5. Retrospective judgements" />
        <div className="flex flex-wrap items-end gap-8">
          <Metric
            value={j.total}
            label="total judgements recorded"
          />
        </div>
        {j.total === 0 ? (
          <p className="text-xs italic text-neutral-400">
            No retrospective judgements yet. Use the{" "}
            <a href="/retrospective" className="underline">
              /retrospective
            </a>{" "}
            page to record kept/partial/broke-promise scores.
          </p>
        ) : (
          <dl className="grid max-w-xs grid-cols-3 gap-4 text-xs">
            <div className="flex flex-col gap-0.5">
              <dt className="text-neutral-500">Kept promise</dt>
              <dd className="text-base font-semibold tabular-nums text-emerald-700 dark:text-emerald-400">
                {j.kept_promise}
                <span className="ml-1 text-xs font-normal text-neutral-500">
                  ({jKeptPct})
                </span>
              </dd>
            </div>
            <div className="flex flex-col gap-0.5">
              <dt className="text-neutral-500">Partial</dt>
              <dd className="text-base font-semibold tabular-nums text-amber-700 dark:text-amber-400">
                {j.partial}
                <span className="ml-1 text-xs font-normal text-neutral-500">
                  ({jPartialPct})
                </span>
              </dd>
            </div>
            <div className="flex flex-col gap-0.5">
              <dt className="text-neutral-500">Broke promise</dt>
              <dd className="text-base font-semibold tabular-nums text-red-600 dark:text-red-400">
                {j.broke_promise}
                <span className="ml-1 text-xs font-normal text-neutral-500">
                  ({jBrokePct})
                </span>
              </dd>
            </div>
          </dl>
        )}
        <p className="text-xs text-neutral-500">
          Source: <code>audit.access_log</code> (intent = &apos;retrospective_judgement&apos;,
          metadata.judgement). Written by the /retrospective page server action.
        </p>
      </section>

      {/* ── Signal 6: Resend stats (external link) ────────────────────────────── */}
      <section className="space-y-4" aria-label="Resend delivery stats">
        <SectionHeader title="6. Resend delivery / open stats" />
        <p className="text-sm text-neutral-700 dark:text-neutral-300">
          Digest delivery and open-rate data lives in the Resend dashboard —
          exec-db does not proxy this data.
        </p>
        <a
          href="https://resend.com/emails"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 rounded border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          Open Resend dashboard
          <span aria-hidden="true">↗</span>
        </a>
        <p className="text-xs text-neutral-500">
          Target: delivery rate above 95%, open rate above 40% in week 1. Check
          Resend for bounce and spam-complaint rates.
        </p>
      </section>
    </div>
  );
}

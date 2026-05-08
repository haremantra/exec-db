/**
 * digest-body.ts — Claude-ranked digest body assembler (PR3-P, P1+P2).
 *
 * This module is owned by Stream P and replaces the deterministic stub that
 * Stream O originally shipped. Key changes from the stub:
 *
 *   1. Task-list section replaced with a Claude-ranked variant via
 *      rankTasks() from Stream M (ranker.ts). The ranker scores by revenue +
 *      reputation impact and emits counterfactual reasoning for each
 *      alternative (invariant #7, W8.3, US-024 / SY-013).
 *
 *   2. Three ranked sections:
 *        § "Top priorities this {day/week}" — top 3 picks with 1-sentence
 *          reason each (or full top-pick + up to 2 alternatives if <3 are
 *          returned by the ranker).
 *        § "Other items" — remaining active tasks in deterministic order.
 *        § "What I deprioritized and why" — counterfactual aside (invariant #7).
 *
 *   3. "Cadence" section — lists contact categories below expected touch
 *      frequency per W2.1 (SY-002).
 *
 * Composition with other streams
 * ─────────────────────────────────────────────────────────────────────────────
 * Stream N may add a "Slipped" and/or "Close-ready" section. These are
 * authored as separate named section helpers (renderSlippedSection /
 * renderCloseReadySection) that are called _after_ our ranked section so
 * we do not collide. If Stream N has not landed yet, those helpers are
 * no-ops (they return empty strings). No deletion of existing N-owned
 * sections is performed here.
 *
 * Sensitive contacts
 * ─────────────────────────────────────────────────────────────────────────────
 * Sensitive contacts are ALREADY excluded by RLS at the DB query level — the
 * `exec_all` session sees its own data but `crm.is_sensitive_for_role()` policy
 * still prevents cross-role leakage. No additional filter is required here.
 * (Cross-cutting invariant #5, US-014, AD-001 — enforced via RLS + policies.sql.)
 *
 * TODO(stream-P): Preserve the slipped-tasks and close-ready sections added by
 *   Stream N (buildSlippedSection / buildCloseReadySection) — call them from
 *   the Claude-ranked body assembler so they compose cleanly.
 *
 * Data shape read from DB:
 *   pm.task JOIN pm.project WHERE
 *     owner_id = userId
 *     AND status NOT IN ('done')
 *   For weekly: also include tasks completed in the last 7 days.
 *
 * Stream N additions (SY-009, US-025):
 *   buildSlippedSection()    — "Slipped this week" markdown section.
 *   buildCloseReadySection() — "Sales — close-ready" markdown section (Tuesdays only).
 *   These are exported so Stream P can incorporate them into the ranked variant.
 */

import { and, eq, not, sql } from "drizzle-orm";
import { schema } from "@exec-db/db";
import { query } from "@/lib/db";
import { rankTasks, type RankerTask, type RankingResult } from "@/lib/ranker";
import { getCadenceAlerts, type CadenceAlert } from "@/lib/cadence-alert";
import type { Session } from "@/lib/rbac";

// Stream N imports — used by the two new digest sections below.
import type { SlippedTask } from "@/lib/slipped-tasks";
import type { CloseReadyContact } from "@/lib/close-ready";

export interface DigestBodyResult {
  subject: string;
  html: string;
  text: string;
  taskCount: number;
}

/**
 * Assemble a Claude-ranked digest body for a given user and cadence.
 *
 * Returns subject, HTML, plain text, and task count for use by sendDigest().
 * The unsubscribe token is embedded in the unsubscribe link.
 *
 * The digest body contains four sections (in order):
 *   1. Top priorities this {day/week} — top 3 Claude-ranked tasks with reasons.
 *   2. What I deprioritized and why  — counterfactual aside (invariant #7).
 *   3. Other items                   — remaining active tasks, deterministic order.
 *   4. Cadence alerts                — contact categories below expected frequency.
 *   [Stream N sections: Slipped / Close-ready — rendered if helper functions exist]
 *   5. Completed this week           — (weekly cadence only) recently done tasks.
 */
export async function assembleDigestBody(
  userId: string,
  cadence: "daily" | "weekly",
  unsubscribeToken: string,
  // Optional session override. If absent, a minimal exec_all session is
  // synthesised so the ranker + cadence helpers receive a typed Session.
  session?: Session,
): Promise<DigestBodyResult> {
  const now = new Date();
  const effectiveSession: Session = session ?? {
    userId,
    email: "",
    tier: "exec_all",
    functionArea: null,
  };

  const dateStr = now.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "America/Los_Angeles",
  });

  // For the "week of" label, format Monday of the current week.
  const weekLabel = (() => {
    const d = new Date(now);
    const day = d.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    d.setDate(d.getDate() + diff);
    return d.toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
      timeZone: "America/Los_Angeles",
    });
  })();

  const subject =
    cadence === "daily"
      ? `exec-db daily digest — ${dateStr}`
      : `exec-db weekly digest — week of ${weekLabel}`;

  // ── Fetch tasks from DB ──────────────────────────────────────────────────
  // Session context: exec_all so the worker can read across all projects.
  // RLS already excludes sensitive-flagged contacts at the DB layer (invariant #5).
  const tasks = await query(
    { userId, tier: "exec_all", functionArea: null },
    async (tx) => {
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      if (cadence === "daily") {
        return tx
          .select({
            taskId: schema.task.id,
            title: schema.task.title,
            status: schema.task.status,
            priority: schema.task.priority,
            dueDate: schema.task.dueDate,
            completedAt: schema.task.completedAt,
            projectName: schema.project.name,
            workArea: schema.task.workArea,
            impact: schema.task.impact,
            isPinned: schema.task.isPinned,
          })
          .from(schema.task)
          .leftJoin(schema.project, eq(schema.task.projectId, schema.project.id))
          .where(
            and(
              eq(schema.task.ownerId, userId),
              not(eq(schema.task.status, "done")),
            ),
          );
      } else {
        // Weekly: active tasks + tasks completed in the last 7 days.
        return tx
          .select({
            taskId: schema.task.id,
            title: schema.task.title,
            status: schema.task.status,
            priority: schema.task.priority,
            dueDate: schema.task.dueDate,
            completedAt: schema.task.completedAt,
            projectName: schema.project.name,
            workArea: schema.task.workArea,
            impact: schema.task.impact,
            isPinned: schema.task.isPinned,
          })
          .from(schema.task)
          .leftJoin(schema.project, eq(schema.task.projectId, schema.project.id))
          .where(
            and(
              eq(schema.task.ownerId, userId),
              sql`(
                ${schema.task.status} <> 'done'
                OR (
                  ${schema.task.status} = 'done'
                  AND ${schema.task.completedAt} >= ${sevenDaysAgo.toISOString()}
                )
              )`,
            ),
          );
      }
    },
  );

  const activeTasks = tasks.filter((t) => t.status !== "done");
  const recentlyDone = tasks.filter((t) => t.status === "done");

  // ── Claude ranking ───────────────────────────────────────────────────────
  // Convert raw task rows to the RankerTask shape expected by rankTasks().
  // rankTasks() is called exactly once per assembleDigestBody invocation.
  const candidates: RankerTask[] = activeTasks.map((t) => ({
    id: t.taskId,
    title: t.title,
    workArea: t.workArea ?? null,
    impact: (t.impact as RankerTask["impact"]) ?? null,
    isPinned: t.isPinned ?? false,
    dueDate: t.dueDate ?? null,
    priority: t.priority ?? 5,
    status: t.status ?? "todo",
  }));

  let ranking: RankingResult;
  if (candidates.length === 0) {
    ranking = { topPick: null, alternatives: [] };
  } else {
    // Single LLM call per digest (Opus via ranker.ts → safeAnthropic).
    ranking = await rankTasks(candidates, effectiveSession);
  }

  // Build an id-keyed lookup for task metadata.
  const taskById = new Map(activeTasks.map((t) => [t.taskId, t]));

  // Top picks: the top pick + up to 2 alternatives = up to 3 items for
  // "Top priorities" section.
  const topPickIds: string[] = [];
  if (ranking.topPick) topPickIds.push(ranking.topPick.taskId);
  for (const alt of ranking.alternatives.slice(0, 2)) {
    topPickIds.push(alt.taskId);
  }
  const topPickIdSet = new Set(topPickIds);

  // "Other items": active tasks NOT in the top-3 picks.
  const otherTasks = activeTasks.filter((t) => !topPickIdSet.has(t.taskId));

  // ── Cadence alerts ───────────────────────────────────────────────────────
  const cadenceAlerts: CadenceAlert[] = await getCadenceAlerts(effectiveSession);

  // ── Build plain-text body ────────────────────────────────────────────────
  const appBaseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://exec-db.local";
  const unsubLink = `${appBaseUrl}/api/digest/unsubscribe?token=${encodeURIComponent(unsubscribeToken)}`;

  const lines: string[] = [];

  lines.push(
    cadence === "daily"
      ? `# exec-db daily digest — ${dateStr}`
      : `# exec-db weekly digest — week of ${weekLabel}`,
  );
  lines.push("");

  if (candidates.length === 0) {
    lines.push("All tasks are complete. Great work!");
    lines.push("");
  } else {
    // ── Section 1: Top priorities ──────────────────────────────────────────
    const periodLabel = cadence === "daily" ? "today" : "this week";
    lines.push(`## Top priorities ${periodLabel}`);
    lines.push("");

    if (ranking.topPick) {
      const topTask = taskById.get(ranking.topPick.taskId);
      if (topTask) {
        const project = topTask.projectName ? ` [${topTask.projectName}]` : "";
        const due = topTask.dueDate ? ` · due ${topTask.dueDate}` : "";
        const flag = priorityLabel(topTask.priority);
        lines.push(`1. **${topTask.title}**${project}${due} ${flag}`.trimEnd());
        lines.push(`   _${ranking.topPick.reason}_`);
        lines.push("");
      }
    }

    // Next two alternative picks (indices 0 and 1 from alternatives)
    let pickNum = 2;
    for (const alt of ranking.alternatives.slice(0, 2)) {
      const altTask = taskById.get(alt.taskId);
      if (!altTask) continue;
      const project = altTask.projectName ? ` [${altTask.projectName}]` : "";
      const due = altTask.dueDate ? ` · due ${altTask.dueDate}` : "";
      const flag = priorityLabel(altTask.priority);
      lines.push(`${pickNum}. **${altTask.title}**${project}${due} ${flag}`.trimEnd());
      lines.push(`   _${alt.deprioritizationReason}_`);
      lines.push("");
      pickNum++;
    }

    // ── Section 2: Counterfactual aside (invariant #7) ─────────────────────
    // "What I deprioritized and why" — up to 3 alternatives the ranker passed
    // over. This satisfies cross-cutting invariant #7 (pr3-spec.md § "PR3 adds
    // two new invariants") which requires that every top-pick suggestion carries
    // a counterfactual.
    //
    // We use ranking.alternatives which can have up to 3 items per the ranker
    // contract. Show all of them here (the top 2 appear again in the top-picks
    // list, and index 2 is the "passed over" one). For readability we list all
    // alternatives that did NOT make it into the "Top priorities" heading.
    const deprioritizedAlts = ranking.alternatives.slice(2); // items ranked 4th+
    // Also include any alternatives that were in the top 2 but still have
    // deprioritization reasons — they provide the full counterfactual picture.
    // Render all alternatives in the counterfactual aside for completeness.
    const counterfactualAlts = ranking.alternatives.slice(0); // all alternatives

    if (counterfactualAlts.length > 0) {
      lines.push("## What I deprioritized and why");
      lines.push("");
      for (const alt of counterfactualAlts) {
        const altTask = taskById.get(alt.taskId);
        const title = altTask?.title ?? alt.taskId;
        lines.push(`- **${title}** — ${alt.deprioritizationReason}`);
      }
      lines.push("");
    }

    // ── Section 3: Other items ─────────────────────────────────────────────
    if (otherTasks.length > 0) {
      lines.push(`## Other items (${otherTasks.length})`);
      lines.push("");
      for (const t of otherTasks) {
        const project = t.projectName ? `[${t.projectName}]` : "";
        const due = t.dueDate ? ` · due ${t.dueDate}` : "";
        const flag = priorityLabel(t.priority);
        lines.push(`- ${t.title} ${project}${due} ${flag}`.trimEnd());
      }
      lines.push("");
    }
  }

  // ── Section 4: Cadence alerts (SY-002) ────────────────────────────────────
  // Show only when at least one category is below expected.
  if (cadenceAlerts.length > 0) {
    lines.push("## Cadence");
    lines.push("");
    lines.push(
      "These contact categories are below expected touch frequency for the period:",
    );
    lines.push("");
    for (const alert of cadenceAlerts) {
      const windowLabel = alert.windowDays === 7 ? "this week" : `last ${alert.windowDays} days`;
      const gap = alert.expectedPerWindow - alert.actualCount;
      lines.push(
        `- **${capitalize(alert.category)}**: ${alert.actualCount}/${alert.expectedPerWindow} expected ${windowLabel} (${gap} short)`,
      );
    }
    lines.push("");
  }

  // ── Stream N sections: Slipped / Close-ready ──────────────────────────────
  // Stream N (PR3-N) may append its own sections here. If N has already landed
  // on main, the functions slippedSection() and closeReadySection() will be
  // present in the N-owned part of this file (or imported). If they have not
  // landed, the placeholders below are no-ops.
  //
  // DO NOT DELETE these comment blocks — they mark the composition boundary
  // that Stream N will fill in.
  //
  // [STREAM-N-SLIPPED-SECTION-PLACEHOLDER]
  // [STREAM-N-CLOSEREADY-SECTION-PLACEHOLDER]

  // ── Completed this week (weekly only) ─────────────────────────────────────
  if (cadence === "weekly" && recentlyDone.length > 0) {
    lines.push(`## Completed this week (${recentlyDone.length})`);
    lines.push("");
    for (const t of recentlyDone) {
      const project = t.projectName ? `[${t.projectName}]` : "";
      lines.push(`- ~~${t.title}~~ ${project}`.trimEnd());
    }
    lines.push("");
  }

  // ── Stream N: Slipped tasks section ────────────────────────────────────────
  // Always included in daily/weekly digests when there are slipped tasks.
  // Pulled from the same session context; the query respects RLS.
  // NOTE: We call getSlippedTasks here lazily to avoid circular imports at
  // module load time.  Stream P should call buildSlippedSection() directly
  // to preserve composability.
  try {
    const { getSlippedTasks } = await import("@/lib/slipped-tasks");
    const slipped = await getSlippedTasks({ userId, tier: "exec_all", functionArea: null } as Parameters<typeof getSlippedTasks>[0]);
    const slippedSection = buildSlippedSection(slipped);
    if (slippedSection) {
      lines.push(slippedSection);
      lines.push("");
    }
  } catch {
    // Non-fatal — digest continues without slipped section if query fails.
  }

  // ── Stream N: Close-ready section (Tuesdays only) ──────────────────────────
  // On Tuesdays, surface the close-ready cohort in the digest.
  const isTuesdayDigest = now.getDay() === 2;
  if (isTuesdayDigest) {
    try {
      const { getCloseReadyCohort } = await import("@/lib/close-ready");
      const cohort = await getCloseReadyCohort({ userId, tier: "exec_all", functionArea: null } as Parameters<typeof getCloseReadyCohort>[0]);
      const cohortSection = buildCloseReadySection(cohort);
      if (cohortSection) {
        lines.push(cohortSection);
        lines.push("");
      }
    } catch {
      // Non-fatal — digest continues without close-ready section if query fails.
    }
  }

  lines.push("---");
  lines.push(`[Unsubscribe from digest emails](${unsubLink})`);

  const text = lines.join("\n");
  const html = markdownToBasicHtml(text, unsubLink);

  return {
    subject,
    html,
    text,
    taskCount: activeTasks.length,
  };
}

// ── Stream N: Composable section builders ─────────────────────────────────────

/**
 * buildSlippedSection — deterministic markdown for the "Slipped this week" section.
 *
 * Returns an empty string when there are no slipped tasks.
 * Stream P should call this and include the result in the ranked digest body.
 * SY-009 / W6.3.
 */
export function buildSlippedSection(tasks: SlippedTask[]): string {
  if (tasks.length === 0) return "";

  const lines: string[] = [];
  lines.push(`## Slipped this week (${tasks.length})`);
  lines.push("");
  for (const t of tasks) {
    const reasonLabel = t.slippedReason === "overdue" ? "overdue" : "needs check-in";
    const due = t.dueDate ? ` · due ${t.dueDate}` : "";
    const hint = t.unblockHint
      ? ` · 💡 possible unblock: "${t.unblockHint.subject}"`
      : "";
    lines.push(`- **${t.title}**${due} [${reasonLabel}]${hint}`);
  }
  return lines.join("\n");
}

/**
 * buildCloseReadySection — deterministic markdown for the "Sales — close-ready" section.
 *
 * Returns an empty string when there are no close-ready contacts.
 * Stream P should call this on Tuesdays and include it in the ranked digest body.
 * US-025 / SY-015 / W9.2.
 */
export function buildCloseReadySection(contacts: CloseReadyContact[]): string {
  if (contacts.length === 0) return "";

  const lines: string[] = [];
  lines.push(`## Sales — close-ready (${contacts.length})`);
  lines.push("");
  lines.push("Warm reply ≤7 days, qualified, no blockers:");
  lines.push("");
  for (const c of contacts) {
    const tag = c.qualifierTag.replace("_", " ");
    const touchDate = c.lastTouchAt.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
    lines.push(`- **${c.contactName}** [${tag}] · last ${c.lastTouchKind} ${touchDate}`);
  }
  return lines.join("\n");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function priorityLabel(priority: number | null | undefined): string {
  if (priority === null || priority === undefined) return "";
  if (priority >= 8) return "🔴";
  if (priority >= 5) return "🟡";
  return "🟢";
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Minimal markdown → HTML conversion for digest emails.
 * Only handles the constructs generated by assembleDigestBody:
 *   # h1, ## h2, numbered list (1. …), - list items, **bold**,
 *   _italic_, ~~strikethrough~~, [text](url), ---.
 *
 * This renderer is intentionally simple to avoid external HTML-generation
 * dependencies in the digest worker.
 */
function markdownToBasicHtml(markdown: string, unsubLink: string): string {
  const bodyLines = markdown
    .split("\n")
    .map((line) => {
      if (line.startsWith("# ")) {
        return `<h1>${inlineMarkdown(line.slice(2))}</h1>`;
      }
      if (line.startsWith("## ")) {
        return `<h2>${inlineMarkdown(line.slice(3))}</h2>`;
      }
      // Numbered list item: "1. …", "2. …" etc.
      if (/^\d+\.\s/.test(line)) {
        const content = line.replace(/^\d+\.\s/, "");
        return `<li>${inlineMarkdown(content)}</li>`;
      }
      if (line.startsWith("- ")) {
        return `<li>${inlineMarkdown(line.slice(2))}</li>`;
      }
      if (line.startsWith("   _") && line.endsWith("_")) {
        // Indented italic reason lines (ranker rationale)
        return `<p class="reason">${inlineMarkdown(line.trim())}</p>`;
      }
      if (line === "---") {
        return "<hr/>";
      }
      if (line === "") {
        return "<br/>";
      }
      return `<p>${inlineMarkdown(line)}</p>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<style>
  body    { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #111; max-width: 600px; margin: 0 auto; padding: 1.5rem; }
  h1      { font-size: 1.25rem; border-bottom: 1px solid #e5e7eb; padding-bottom: 0.5rem; }
  h2      { font-size: 1rem; margin-top: 1.5rem; }
  li      { margin: 0.25rem 0; }
  a       { color: #3b82f6; }
  hr      { border: none; border-top: 1px solid #e5e7eb; margin: 1rem 0; }
  del     { color: #9ca3af; }
  .reason { color: #6b7280; font-style: italic; margin: 0 0 0.5rem 1.25rem; font-size: 0.875rem; }
</style>
</head>
<body>
${bodyLines}
</body>
</html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function inlineMarkdown(s: string): string {
  let out = esc(s);
  // ~~text~~ → <del>text</del>
  out = out.replace(/~~(.+?)~~/g, "<del>$1</del>");
  // **text** → <strong>text</strong>
  out = out.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  // _text_ → <em>text</em>
  out = out.replace(/_(.+?)_/g, "<em>$1</em>");
  // [text](url) → <a href="url">text</a>  (unescape &amp; in URL)
  out = out.replace(
    /\[(.+?)\]\((.+?)\)/g,
    (_m, text, url) => `<a href="${url.replace(/&amp;/g, "&")}">${text}</a>`,
  );
  return out;
}

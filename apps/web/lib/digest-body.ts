/**
 * digest-body.ts — Deterministic digest body assembler (PR3-O stub).
 *
 * This module is owned by Stream O (infrastructure) and provides a
 * deterministic markdown body for the digest email. Stream P will replace
 * assembleDigestBody() with a Claude-ranked version (S5.5 / S5.6 overrides).
 *
 * TODO(stream-P): Replace assembleDigestBody() with a Claude-ranked variant
 *   that weights tasks by revenue + reputation impact and provides counterfactual
 *   reasoning ("here's what was deprioritized and why") per US-024 / SY-013.
 *
 * TODO(stream-P): Integrate getContactContext()-style sensitive-contact exclusion
 *   so that tasks linked to sensitive contacts are filtered from the digest body
 *   before rendering. Currently omitted per the spec (defer to Stream P).
 *
 * Data shape read from DB:
 *   pm.task JOIN pm.project WHERE
 *     owner_id = userId
 *     AND status NOT IN ('done')
 *   For weekly: also include tasks completed in the last 7 days.
 */

import { and, eq, gt, inArray, not, sql } from "drizzle-orm";
import { schema } from "@exec-db/db";
import { query } from "@/lib/db";

export interface DigestBodyResult {
  subject: string;
  html: string;
  text: string;
  taskCount: number;
}

/**
 * Assemble a deterministic digest body for a given user and cadence.
 *
 * Returns subject, HTML, plain text, and task count for use by sendDigest().
 * The unsubscribe token is embedded in the unsubscribe link.
 */
export async function assembleDigestBody(
  userId: string,
  cadence: "daily" | "weekly",
  unsubscribeToken: string,
): Promise<DigestBodyResult> {
  const now = new Date();
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
    // Adjust to Monday (getDay() 0=Sun, 1=Mon ... 6=Sat).
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

  // --- Fetch tasks from DB ---
  // session context: exec_all so the worker can read across all projects.
  const tasks = await query(
    { userId, tier: "exec_all", functionArea: null },
    async (tx) => {
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      if (cadence === "daily") {
        // Active (non-done) tasks owned by the user.
        return tx
          .select({
            taskId: schema.task.id,
            title: schema.task.title,
            status: schema.task.status,
            priority: schema.task.priority,
            dueDate: schema.task.dueDate,
            completedAt: schema.task.completedAt,
            projectName: schema.project.name,
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

  // --- Build plain-text and HTML body ---
  const appBaseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://exec-db.local";
  const unsubLink = `${appBaseUrl}/api/digest/unsubscribe?token=${encodeURIComponent(unsubscribeToken)}`;

  const lines: string[] = [];

  lines.push(
    cadence === "daily"
      ? `# exec-db daily digest — ${dateStr}`
      : `# exec-db weekly digest — week of ${weekLabel}`,
  );
  lines.push("");

  if (activeTasks.length === 0) {
    lines.push("All tasks are complete. Great work!");
    lines.push("");
  } else {
    lines.push(`## Your tasks (${activeTasks.length})`);
    lines.push("");
    for (const t of activeTasks) {
      const project = t.projectName ? `[${t.projectName}]` : "";
      const due = t.dueDate ? ` · due ${t.dueDate}` : "";
      const priority = priorityLabel(t.priority);
      lines.push(`- ${t.title} ${project}${due} ${priority}`.trimEnd());
    }
    lines.push("");
  }

  if (cadence === "weekly" && recentlyDone.length > 0) {
    lines.push(`## Completed this week (${recentlyDone.length})`);
    lines.push("");
    for (const t of recentlyDone) {
      const project = t.projectName ? `[${t.projectName}]` : "";
      lines.push(`- ~~${t.title}~~ ${project}`.trimEnd());
    }
    lines.push("");
  }

  lines.push("---");
  lines.push(`[Unsubscribe from digest emails](${unsubLink})`);

  const text = lines.join("\n");

  // Basic HTML conversion (no external libs needed for this stub).
  const html = markdownToBasicHtml(text, unsubLink);

  return {
    subject,
    html,
    text,
    taskCount: activeTasks.length,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function priorityLabel(priority: number | null | undefined): string {
  if (priority === null || priority === undefined) return "";
  if (priority >= 8) return "🔴";
  if (priority >= 5) return "🟡";
  return "🟢";
}

/**
 * Minimal markdown → HTML conversion for digest emails.
 * Only handles the constructs generated by assembleDigestBody:
 *   # h1, ## h2, - list items, ~~strikethrough~~, [text](url), ---.
 *
 * Stream P may replace this with a richer renderer.
 */
function markdownToBasicHtml(markdown: string, unsubLink: string): string {
  const bodyLines = markdown
    .split("\n")
    .map((line) => {
      if (line.startsWith("# ")) {
        return `<h1>${esc(line.slice(2))}</h1>`;
      }
      if (line.startsWith("## ")) {
        return `<h2>${esc(line.slice(3))}</h2>`;
      }
      if (line.startsWith("- ")) {
        return `<li>${inlineMarkdown(line.slice(2))}</li>`;
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
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #111; max-width: 600px; margin: 0 auto; padding: 1.5rem; }
  h1   { font-size: 1.25rem; border-bottom: 1px solid #e5e7eb; padding-bottom: 0.5rem; }
  h2   { font-size: 1rem; margin-top: 1.5rem; }
  li   { margin: 0.25rem 0; }
  a    { color: #3b82f6; }
  hr   { border: none; border-top: 1px solid #e5e7eb; margin: 1rem 0; }
  del  { color: #9ca3af; }
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
  // ~~text~~ → <del>text</del>
  let out = esc(s).replace(/~~(.+?)~~/g, "<del>$1</del>");
  // [text](url) → <a href="url">text</a>  (already escaped, so unescape &amp; in URL)
  out = out.replace(
    /\[(.+?)\]\((.+?)\)/g,
    (_m, text, url) => `<a href="${url.replace(/&amp;/g, "&")}">${text}</a>`,
  );
  return out;
}

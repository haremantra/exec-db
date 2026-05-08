import { and, eq, gte } from "drizzle-orm";
import { schema } from "@exec-db/db";
import { getSession } from "@/lib/auth";
import { query } from "@/lib/db";
import { recordRetrospectiveJudgement, RETROSPECTIVE_JUDGEMENT_VALUES } from "./actions";

export const dynamic = "force-dynamic";

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Return the ISO date string for the Monday of the week containing `d`. */
function mondayOf(d: Date): Date {
  const day = d.getDay(); // 0=Sun, 1=Mon … 6=Sat
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(d);
  monday.setDate(monday.getDate() + diff);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

function formatDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const dt = typeof d === "string" ? new Date(d) : d;
  return dt.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "America/Los_Angeles",
  });
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default async function RetrospectivePage(): Promise<JSX.Element> {
  const session = await getSession();
  if (!session) return <p className="text-sm">Sign in required.</p>;

  const now = new Date();
  const monday = mondayOf(now);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const weekLabel = monday.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "America/Los_Angeles",
  });

  const ctx = {
    userId: session.userId,
    tier: session.tier,
    functionArea: session.functionArea,
  };

  // Fetch tasks completed in the last 7 days, joined to their project name.
  const completedTasks = await query(ctx, async (tx) =>
    tx
      .select({
        taskId: schema.task.id,
        title: schema.task.title,
        completedAt: schema.task.completedAt,
        ownerId: schema.task.ownerId,
        impact: schema.task.impact,
        isPinned: schema.task.isPinned,
        projectId: schema.task.projectId,
        projectName: schema.project.name,
      })
      .from(schema.task)
      .leftJoin(schema.project, eq(schema.task.projectId, schema.project.id))
      .where(
        and(
          eq(schema.task.ownerId, session.userId),
          eq(schema.task.status, "done"),
          gte(schema.task.completedAt, sevenDaysAgo),
        ),
      ),
  );

  // Jobs-to-be-done: completed tasks with high-impact designation.
  const jtbdImpactValues = ["revenue", "reputation", "both"] as const;
  const jobsDone = completedTasks.filter(
    (t) => t.impact && (jtbdImpactValues as readonly string[]).includes(t.impact),
  );

  // Group completed tasks by project.
  // Use "no-project" as a sentinel key when projectId is null (Copilot fix).
  const byProject = new Map<string, { name: string; tasks: typeof completedTasks; projectId: string | null }>();
  for (const t of completedTasks) {
    const key = t.projectId ?? "no-project";
    if (!byProject.has(key)) {
      byProject.set(key, {
        name: t.projectName ?? "(No project)",
        tasks: [],
        projectId: t.projectId,
      });
    }
    byProject.get(key)!.tasks.push(t);
  }

  return (
    <div className="space-y-8">
      <header className="space-y-1">
        <h2 className="text-lg font-medium">
          Weekly retrospective — week of {weekLabel}
        </h2>
        <p className="text-sm text-neutral-500">
          Tasks completed in the last 7 days.
          Mark each item to inform future priority ranking.
        </p>
      </header>

      {/* ── Jobs-to-be-done resolved ──────────────────────────────────────── */}
      {jobsDone.length > 0 && (
        <section className="space-y-3">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
            Jobs-to-be-done resolved ({jobsDone.length})
          </h3>
          <ul className="space-y-2">
            {jobsDone.map((t) => (
              <li
                key={t.taskId}
                className="rounded-md border border-emerald-300 bg-emerald-50 p-3 dark:border-emerald-700 dark:bg-emerald-950"
              >
                <TaskJudgementRow task={t} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ── All completed tasks by project ───────────────────────────────── */}
      {byProject.size === 0 ? (
        <p className="text-sm text-neutral-500">
          No tasks completed in the last 7 days.
        </p>
      ) : (
        <section className="space-y-6">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
            Completed tasks by project ({completedTasks.length})
          </h3>
          {Array.from(byProject.entries()).map(([key, { name, tasks, projectId }]) => (
            <div key={key} className="space-y-2">
              <h4 className="font-medium text-sm">
                {/* Only render a link when we have an actual project ID */}
                {projectId ? (
                  <a
                    href={`/pm/projects/${projectId}`}
                    className="text-neutral-800 underline-offset-2 hover:underline dark:text-neutral-200"
                  >
                    {name}
                  </a>
                ) : (
                  <span className="text-neutral-800 dark:text-neutral-200">{name}</span>
                )}
              </h4>
              <ul className="space-y-2">
                {tasks.map((t) => (
                  <li
                    key={t.taskId}
                    className="rounded-md border border-neutral-200 p-3 dark:border-neutral-700"
                  >
                    <TaskJudgementRow task={t} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

// ── TaskJudgementRow component ─────────────────────────────────────────────────

type TaskRow = {
  taskId: string;
  title: string;
  completedAt: Date | null;
  ownerId: string;
  impact: string | null;
  isPinned: boolean;
  projectName: string | null;
};

function TaskJudgementRow({ task }: { task: TaskRow }): JSX.Element {
  const judgeAction = recordRetrospectiveJudgement.bind(null, task.taskId);

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
      {/* Left: task info */}
      <div className="space-y-0.5">
        <div className="flex items-center gap-2 font-medium text-sm leading-tight">
          {task.isPinned && <span title="Pinned" className="text-amber-500">📌</span>}
          <span>{task.title}</span>
          {task.impact && task.impact !== "neither" && (
            <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
              {task.impact}
            </span>
          )}
        </div>
        <div className="text-xs text-neutral-500">
          Completed {formatDate(task.completedAt)}
        </div>
      </div>

      {/* Right: promise-kept radio form */}
      <form
        action={judgeAction}
        className="flex items-center gap-1 text-xs"
      >
        {RETROSPECTIVE_JUDGEMENT_VALUES.map((val) => (
          <label
            key={val}
            className="flex cursor-pointer items-center gap-0.5 rounded border border-neutral-200 px-2 py-1 hover:border-neutral-400 dark:border-neutral-700 dark:hover:border-neutral-500"
          >
            <input
              type="radio"
              name="judgement"
              value={val}
              required
              className="sr-only"
            />
            {val === "kept_promise"
              ? "Kept its promise"
              : val === "partial"
                ? "Partially"
                : "Broke its promise"}
          </label>
        ))}
        <button
          type="submit"
          className="rounded bg-neutral-900 px-2 py-1 text-white dark:bg-neutral-100 dark:text-neutral-900"
        >
          Save
        </button>
      </form>
    </div>
  );
}

import { IMPACT_VALUES, PROJECT_TYPE_VALUES, schema } from "@exec-db/db";
import { asc, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { getSession } from "@/lib/auth";
import { query } from "@/lib/db";
import {
  createTask,
  setProjectType,
  setTaskImpact,
  setTaskPinned,
  updateTaskStatus,
} from "../actions";

export const dynamic = "force-dynamic";

/**
 * Task status type now includes "stuck" (K3 — US-019, W6.5).
 *   blocked = dependency on money or a specific human; there is a plan.
 *   stuck   = outside the exec's expertise/bandwidth; no plan yet.
 * The kanban renders 5 columns: todo | in_progress | blocked | stuck | done
 */
type TaskStatus = "todo" | "in_progress" | "blocked" | "stuck" | "done";

const COLUMNS: TaskStatus[] = ["todo", "in_progress", "blocked", "stuck", "done"];

const COLUMN_LABEL: Record<TaskStatus, string> = {
  todo: "To Do",
  in_progress: "In Progress",
  blocked: "Blocked",
  stuck: "Stuck",
  done: "Done",
};

const NEXT_STATUS: Record<TaskStatus, TaskStatus> = {
  todo: "in_progress",
  in_progress: "done",
  blocked: "in_progress",
  stuck: "in_progress",
  done: "todo",
};

const IMPACT_LABEL: Record<(typeof IMPACT_VALUES)[number] | "none", string> = {
  none: "— impact",
  revenue: "💰 Revenue",
  reputation: "⭐ Reputation",
  both: "💰⭐ Both",
  neither: "Neither",
};

const PROJECT_TYPE_LABEL: Record<
  (typeof PROJECT_TYPE_VALUES)[number] | "none",
  string
> = {
  none: "— project type",
  sales_call: "Sales Call",
  licensing: "Licensing",
  hire: "Hire",
  deal: "Deal",
  board_prep: "Board Prep",
  okr: "OKR",
  other: "Other",
};

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<JSX.Element> {
  const { id } = await params;
  const session = await getSession();
  if (!session) return <p className="text-sm">Sign in required.</p>;

  const ctx = {
    userId: session.userId,
    tier: session.tier,
    functionArea: session.functionArea,
  };

  const data = await query(ctx, async (tx) => {
    const [p] = await tx.select().from(schema.project).where(eq(schema.project.id, id)).limit(1);
    if (!p) return null;

    const tasks = await tx
      .select()
      .from(schema.task)
      .where(eq(schema.task.projectId, id))
      .orderBy(asc(schema.task.priority), asc(schema.task.dueDate));

    return { project: p, tasks };
  });

  if (!data) notFound();

  const canWrite = session.tier === "exec_all";
  const addTask = createTask.bind(null, id);
  const setType = setProjectType.bind(null, id);

  const grouped: Record<string, typeof data.tasks> = {
    todo: [],
    in_progress: [],
    blocked: [],
    stuck: [],
    done: [],
  };
  for (const t of data.tasks) {
    (grouped[t.status] ??= []).push(t);
  }

  return (
    <div className="space-y-8">
      <header className="space-y-1">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-medium">{data.project.name}</h2>
          {/* Project type selector (K4 — exec_all only) */}
          {canWrite && (
            <form action={setType} className="flex items-center gap-1">
              <select
                name="project_type"
                defaultValue={data.project.projectType ?? "none"}
                className="rounded border border-neutral-300 px-2 py-0.5 text-xs dark:border-neutral-700 dark:bg-neutral-900"
              >
                <option value="none">— project type</option>
                {PROJECT_TYPE_VALUES.map((v) => (
                  <option key={v} value={v}>
                    {PROJECT_TYPE_LABEL[v]}
                  </option>
                ))}
              </select>
              <button
                type="submit"
                className="text-xs text-neutral-500 underline hover:text-neutral-900 dark:hover:text-neutral-100"
              >
                set
              </button>
            </form>
          )}
          {!canWrite && data.project.projectType && (
            <span className="rounded bg-neutral-100 px-2 py-0.5 text-xs dark:bg-neutral-800">
              {PROJECT_TYPE_LABEL[data.project.projectType as (typeof PROJECT_TYPE_VALUES)[number]] ??
                data.project.projectType}
            </span>
          )}
        </div>
        {data.project.description && (
          <p className="text-sm text-neutral-500">{data.project.description}</p>
        )}
        <p className="text-xs text-neutral-500">
          Status: {data.project.status}
          {data.project.targetCompletionDate
            ? ` · Target: ${data.project.targetCompletionDate}`
            : ""}
        </p>
      </header>

      {canWrite && (
        <section>
          <h3 className="mb-2 text-sm font-medium">Add task</h3>
          <form action={addTask} className="grid grid-cols-4 gap-2">
            <input
              name="title"
              placeholder="Title"
              required
              className="col-span-2 rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
            <input
              name="priority"
              type="number"
              min={0}
              max={10}
              defaultValue={5}
              className="rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
            <input
              name="dueDate"
              type="date"
              className="rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
            <textarea
              name="description"
              placeholder="Description"
              rows={2}
              className="col-span-3 rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
            <button
              type="submit"
              className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white dark:bg-neutral-100 dark:text-neutral-900"
            >
              Add
            </button>
          </form>
        </section>
      )}

      {/* 5-column kanban: todo | in_progress | blocked | stuck | done */}
      <section className="grid grid-cols-5 gap-4">
        {COLUMNS.map((col) => (
          <div
            key={col}
            className="rounded-md border border-neutral-200 p-3 text-sm dark:border-neutral-800"
          >
            <div className="mb-2 text-xs font-medium uppercase text-neutral-500">
              {COLUMN_LABEL[col]} ({grouped[col]?.length ?? 0})
            </div>
            <ul className="space-y-2">
              {(grouped[col] ?? []).map((t) => {
                const setImpact = setTaskImpact.bind(null, t.id, id);
                const setPinned = setTaskPinned.bind(null, t.id, id);
                return (
                  <li
                    key={t.id}
                    className={`rounded border p-2 ${
                      t.isPinned
                        ? "border-amber-400 bg-amber-50 dark:border-amber-600 dark:bg-amber-950"
                        : "border-neutral-200 dark:border-neutral-700"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-1">
                      <div className="font-medium leading-tight">{t.title}</div>
                      {/* Pin toggle (K2 — exec_all only) */}
                      {canWrite && (
                        <form action={setPinned}>
                          <input
                            type="hidden"
                            name="pinned"
                            value={t.isPinned ? "false" : "true"}
                          />
                          <button
                            type="submit"
                            title={t.isPinned ? "Unpin" : "Pin"}
                            className={`text-sm leading-none ${
                              t.isPinned
                                ? "text-amber-500"
                                : "text-neutral-400 hover:text-amber-400"
                            }`}
                          >
                            {t.isPinned ? "📌" : "📍"}
                          </button>
                        </form>
                      )}
                    </div>
                    {t.description && (
                      <div className="mt-0.5 text-xs text-neutral-500">{t.description}</div>
                    )}
                    {/* Needs check-in badge (R2 — SY-010, US-020, W6.4).
                        Shown when awaiting_response_until is set and has passed. */}
                    {t.awaitingResponseUntil &&
                      t.awaitingResponseUntil < new Date() && (
                        <div className="mb-1 mt-1 flex items-center gap-2">
                          <span className="inline-flex items-center rounded bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-700 dark:bg-orange-900 dark:text-orange-300">
                            Needs check-in
                          </span>
                          <a
                            href={`/crm/contacts?draft_checkin=1&task_title=${encodeURIComponent(t.title)}`}
                            className="text-xs text-blue-600 underline underline-offset-2 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-200"
                          >
                            Draft check-in
                          </a>
                        </div>
                      )}
                    <div className="mt-1 flex flex-wrap items-center justify-between gap-1 text-xs text-neutral-500">
                      <span>
                        P{t.priority}
                        {t.dueDate ? ` · due ${t.dueDate}` : ""}
                        {t.impact ? ` · ${t.impact}` : ""}
                      </span>
                      <div className="flex items-center gap-1">
                        {/* Impact selector (K1 — exec_all only) */}
                        {canWrite && (
                          <form action={setImpact} className="flex items-center gap-0.5">
                            <select
                              name="impact"
                              defaultValue={t.impact ?? "none"}
                              className="rounded border border-neutral-300 px-1 py-0.5 text-xs dark:border-neutral-700 dark:bg-neutral-900"
                            >
                              <option value="none">— impact</option>
                              {IMPACT_VALUES.map((v) => (
                                <option key={v} value={v}>
                                  {IMPACT_LABEL[v]}
                                </option>
                              ))}
                            </select>
                            <button
                              type="submit"
                              className="text-xs text-neutral-400 underline hover:text-neutral-900 dark:hover:text-neutral-100"
                            >
                              ✓
                            </button>
                          </form>
                        )}
                        {/* Status advance button */}
                        {canWrite && (
                          <form
                            action={updateTaskStatus.bind(
                              null,
                              t.id,
                              id,
                              NEXT_STATUS[col as TaskStatus],
                            )}
                          >
                            <button
                              type="submit"
                              className="underline hover:text-neutral-900 dark:hover:text-neutral-100"
                            >
                              → {NEXT_STATUS[col as TaskStatus]}
                            </button>
                          </form>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </section>
    </div>
  );
}

"use server";

import { IMPACT_VALUES, PROJECT_TYPE_VALUES, TASK_STATUS_VALUES, schema } from "@exec-db/db";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { query } from "@/lib/db";

// Los Angeles UTC offset for PST. During PDT (summer) it is -07:00; during PST
// (winter) it is -08:00. We use the standard PST offset (-08:00) as required by
// the spec's `<date>T17:00:00-08:00` format. The exec sees 5 pm PST / 6 pm PDT.
const LA_OFFSET = "-08:00";

function ctx(session: Awaited<ReturnType<typeof getSession>>) {
  if (!session) throw new Error("Unauthorized");
  return {
    userId: session.userId,
    tier: session.tier,
    functionArea: session.functionArea,
  };
}

export async function createProject(formData: FormData): Promise<void> {
  const session = await getSession();
  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim() || null;
  const targetRaw = String(formData.get("targetCompletionDate") ?? "").trim();
  const targetCompletionDate = targetRaw ? targetRaw : null;
  if (!name) throw new Error("name is required");

  const [row] = await query(ctx(session), (tx) =>
    tx
      .insert(schema.project)
      .values({
        name,
        description,
        ownerId: session!.userId,
        targetCompletionDate,
      })
      .returning({ id: schema.project.id }),
  );

  revalidatePath("/pm/projects");
  if (row) redirect(`/pm/projects/${row.id}`);
}

export async function createTask(projectId: string, formData: FormData): Promise<void> {
  const session = await getSession();
  const title = String(formData.get("title") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim() || null;
  const priorityRaw = Number(formData.get("priority") ?? 5);
  const priority = Number.isFinite(priorityRaw) ? Math.max(0, Math.min(10, priorityRaw)) : 5;
  const dueDateRaw = String(formData.get("dueDate") ?? "").trim();
  const dueDate = dueDateRaw ? dueDateRaw : null;
  if (!title) throw new Error("title is required");

  await query(ctx(session), (tx) =>
    tx.insert(schema.task).values({
      projectId,
      title,
      description,
      ownerId: session!.userId,
      priority,
      dueDate,
    }),
  );

  revalidatePath(`/pm/projects/${projectId}`);
}

export async function updateTaskStatus(
  taskId: string,
  projectId: string,
  status: (typeof TASK_STATUS_VALUES)[number],
): Promise<void> {
  const session = await getSession();

  if (!(TASK_STATUS_VALUES as readonly string[]).includes(status)) {
    throw new Error(`Invalid status: ${status}`);
  }

  await query(ctx(session), (tx) =>
    tx
      .update(schema.task)
      .set({
        status,
        completedAt: status === "done" ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(schema.task.id, taskId)),
  );

  revalidatePath(`/pm/projects/${projectId}`);
}

/**
 * Set or clear the impact tag on a task (K1 — US-021, W8.1).
 * exec_all only. Pass "none" in formData to clear (sets null).
 */
export async function setTaskImpact(
  taskId: string,
  projectId: string,
  formData: FormData,
): Promise<void> {
  const session = await getSession();
  const c = ctx(session);
  if (c.tier !== "exec_all") throw new Error("exec_all required");

  const raw = String(formData.get("impact") ?? "").trim();
  const impact =
    raw === "none" || raw === ""
      ? null
      : (IMPACT_VALUES as readonly string[]).includes(raw)
        ? (raw as (typeof IMPACT_VALUES)[number])
        : null;

  if (raw !== "none" && raw !== "" && impact === null) {
    throw new Error(`Invalid impact value: ${raw}`);
  }

  await query(c, (tx) =>
    tx
      .update(schema.task)
      .set({ impact, updatedAt: new Date() })
      .where(eq(schema.task.id, taskId)),
  );

  revalidatePath(`/pm/projects/${projectId}`);
}

/**
 * Toggle the is_pinned flag on a task (K2 — US-004, W1.5).
 * exec_all only. formData must carry `pinned` = "true" | "false".
 *
 * CONTRACT: setting is_pinned=true on a done task is allowed — the pin
 * persists across weekly resets.  Dashboard (Stream L) uses
 * `is_pinned AND status != 'done'` to determine sticky-top visibility.
 */
export async function setTaskPinned(
  taskId: string,
  projectId: string,
  formData: FormData,
): Promise<void> {
  const session = await getSession();
  const c = ctx(session);
  if (c.tier !== "exec_all") throw new Error("exec_all required");

  const raw = String(formData.get("pinned") ?? "").trim();
  const isPinned = raw === "true";

  await query(c, (tx) =>
    tx
      .update(schema.task)
      .set({ isPinned, updatedAt: new Date() })
      .where(eq(schema.task.id, taskId)),
  );

  revalidatePath(`/pm/projects/${projectId}`);
}

/**
 * Set the awaiting_response_until timestamp on a task (N — SY-010, US-020, W6.4).
 * exec_all only. The form must carry a `date` field (YYYY-MM-DD).
 *
 * The stored value is `<date>T17:00:00-08:00` (5 pm PST) so the check-in
 * window ends at the end of the Los Angeles business day.
 *
 * When awaiting_response_until < now(), the task is flagged "Needs check-in"
 * in the dashboard's slipped-task code path (slippedReason = "response_overdue").
 * The task status itself does NOT change — only the UI badge changes.
 *
 * Pass an empty or "none" date to clear the deadline.
 */
export async function markAwaitingResponse(
  taskId: string,
  projectId: string,
  formData: FormData,
): Promise<void> {
  const session = await getSession();
  const c = ctx(session);
  if (c.tier !== "exec_all") throw new Error("exec_all required");

  const raw = String(formData.get("date") ?? "").trim();

  // Validate date format (YYYY-MM-DD) or empty/none to clear.
  let awaitingResponseUntil: Date | null = null;
  if (raw && raw !== "none") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      throw new Error(`Invalid date format: ${raw}. Expected YYYY-MM-DD.`);
    }
    // Build ISO timestamp with fixed PST offset per spec.
    awaitingResponseUntil = new Date(`${raw}T17:00:00${LA_OFFSET}`);
    if (isNaN(awaitingResponseUntil.getTime())) {
      throw new Error(`Invalid date: ${raw}`);
    }
  }

  await query(c, (tx) =>
    tx
      .update(schema.task)
      .set({ awaitingResponseUntil, updatedAt: new Date() })
      .where(eq(schema.task.id, taskId)),
  );

  revalidatePath(`/pm/projects/${projectId}`);
  revalidatePath("/dashboard");
}

/**
 * Set or clear the project_type tag on a project (K4 — US-018, W6.1).
 * exec_all only. Pass "none" in formData to clear (sets null).
 */
export async function setProjectType(
  projectId: string,
  formData: FormData,
): Promise<void> {
  const session = await getSession();
  const c = ctx(session);
  if (c.tier !== "exec_all") throw new Error("exec_all required");

  const raw = String(formData.get("project_type") ?? "").trim();
  const projectType =
    raw === "none" || raw === ""
      ? null
      : (PROJECT_TYPE_VALUES as readonly string[]).includes(raw)
        ? (raw as (typeof PROJECT_TYPE_VALUES)[number])
        : null;

  if (raw !== "none" && raw !== "" && projectType === null) {
    throw new Error(`Invalid project_type value: ${raw}`);
  }

  await query(c, (tx) =>
    tx
      .update(schema.project)
      .set({ projectType, updatedAt: new Date() })
      .where(eq(schema.project.id, projectId)),
  );

  revalidatePath(`/pm/projects/${projectId}`);
  revalidatePath("/pm/projects");
}

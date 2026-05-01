"use server";

import { schema } from "@exec-db/db";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { query } from "@/lib/db";

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
  status: "todo" | "in_progress" | "blocked" | "done",
): Promise<void> {
  const session = await getSession();

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

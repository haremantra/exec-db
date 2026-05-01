import { schema } from "@exec-db/db";
import { desc } from "drizzle-orm";
import Link from "next/link";
import { getSession } from "@/lib/auth";
import { query } from "@/lib/db";
import { createProject } from "./actions";

export const dynamic = "force-dynamic";

export default async function ProjectsPage(): Promise<JSX.Element> {
  const session = await getSession();
  if (!session) return <p className="text-sm">Sign in required.</p>;

  const projects = await query(
    { userId: session.userId, tier: session.tier, functionArea: session.functionArea },
    (tx) =>
      tx
        .select()
        .from(schema.project)
        .orderBy(desc(schema.project.updatedAt))
        .limit(100),
  );

  const canWrite = session.tier === "exec_all";

  return (
    <div className="space-y-6">
      <header className="flex items-baseline justify-between">
        <h2 className="text-base font-medium">Projects</h2>
        <span className="text-xs text-neutral-500">{projects.length} shown</span>
      </header>

      {canWrite && (
        <form
          action={createProject}
          className="grid grid-cols-2 gap-3 rounded-md border border-neutral-200 p-4 dark:border-neutral-800"
        >
          <input
            name="name"
            placeholder="Project name"
            required
            className="col-span-2 rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
          <textarea
            name="description"
            placeholder="Description"
            rows={2}
            className="col-span-2 rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
          <input
            name="targetCompletionDate"
            type="date"
            className="rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
          <button
            type="submit"
            className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white dark:bg-neutral-100 dark:text-neutral-900"
          >
            Create project
          </button>
        </form>
      )}

      <ul className="divide-y divide-neutral-200 rounded-md border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
        {projects.length === 0 && (
          <li className="px-4 py-6 text-sm text-neutral-500">No projects yet.</li>
        )}
        {projects.map((p) => (
          <li key={p.id} className="px-4 py-3 text-sm">
            <Link href={`/pm/projects/${p.id}`} className="flex items-baseline justify-between">
              <span>
                <span className="font-medium">{p.name}</span>
                {p.description && (
                  <span className="ml-2 text-neutral-500">{p.description}</span>
                )}
              </span>
              <span className="flex gap-2 text-xs text-neutral-500">
                <span className="rounded border border-neutral-300 px-2 py-0.5 dark:border-neutral-700">
                  {p.status}
                </span>
                {p.targetCompletionDate && (
                  <span className="rounded border border-neutral-300 px-2 py-0.5 dark:border-neutral-700">
                    due {p.targetCompletionDate}
                  </span>
                )}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

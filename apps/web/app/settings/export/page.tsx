/**
 * Settings — Export page (US-026 / AD-006 / S1 PR3).
 *
 * Visible only to exec_all tier.
 * Shows the last-export timestamp (from audit.access_log) and an
 * "Export my CRM" button that calls GET /api/export/crm.
 *
 * Rate limit: 1 export per 24 hours (enforced server-side).
 */
import { redirect } from "next/navigation";
import { schema } from "@exec-db/db";
import { and, desc, eq, like } from "drizzle-orm";
import { getSession } from "@/lib/auth";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function ExportPage() {
  const session = await getSession();

  // Page is exec_all only.
  if (!session || session.tier !== "exec_all") {
    redirect("/");
  }

  const ctx = {
    userId: session.userId,
    tier: session.tier,
    functionArea: session.functionArea,
  };

  // Fetch the most recent successful CRM export from audit.access_log.
  const lastExportRows = await query(ctx, async (tx) => {
    return tx
      .select({
        occurredAt: schema.accessLog.occurredAt,
        metadata: schema.accessLog.metadata,
      })
      .from(schema.accessLog)
      .where(
        and(
          eq(schema.accessLog.userId, session.userId),
          like(schema.accessLog.intent, "crm_export%"),
        ),
      )
      .orderBy(desc(schema.accessLog.occurredAt))
      .limit(1);
  });

  const lastExport = lastExportRows[0] ?? null;

  return (
    <div className="space-y-6 max-w-xl">
      <header>
        <h2 className="text-lg font-medium">Export my CRM</h2>
        <p className="mt-1 text-sm text-neutral-500">
          Download a portable zip archive of all your CRM data — contacts,
          accounts, call notes (as markdown), drafts, calendar events, email
          threads, projects, and tasks.
        </p>
      </header>

      {/* Last export info */}
      <div className="rounded-md border border-neutral-200 bg-neutral-50 p-4 text-sm dark:border-neutral-700 dark:bg-neutral-900">
        <p className="font-medium">Last export</p>
        {lastExport ? (
          <p className="mt-1 text-neutral-600 dark:text-neutral-400">
            {lastExport.occurredAt.toLocaleString()} UTC
          </p>
        ) : (
          <p className="mt-1 text-neutral-400 italic">No exports yet.</p>
        )}
      </div>

      {/* Rate-limit notice */}
      <div
        role="note"
        className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200"
      >
        <strong>Rate limit:</strong> one export per 24 hours. The export is
        audit-logged and includes all of your data (including sensitive contacts
        — this is your personal data).
      </div>

      {/* Export button — navigates to the API endpoint which returns a zip download */}
      <a
        href="/api/export/crm"
        className="inline-block rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
      >
        Export my CRM
      </a>
    </div>
  );
}

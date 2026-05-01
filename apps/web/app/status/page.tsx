import { getDb, withSession } from "@exec-db/db";
import { schema } from "@exec-db/db";
import { desc } from "drizzle-orm";
import { getSession } from "@/lib/auth";

const FRESHNESS_SLA_HOURS: Record<string, number> = {
  finance: 1,
  hr: 24,
  comp: 24,
  legal: 24,
  ops: 0.083, // ~5 minutes
};

export const dynamic = "force-dynamic";

export default async function StatusPage(): Promise<JSX.Element> {
  const session = await getSession();
  if (!session) {
    return <p className="text-sm">Sign in required.</p>;
  }

  const url = process.env.DATABASE_URL_APP ?? process.env.DATABASE_URL;
  if (!url) {
    return <p className="text-sm">DATABASE_URL_APP is not set.</p>;
  }

  const db = getDb(url);

  const rows = await withSession(
    db,
    { userId: session.userId, tier: session.tier, functionArea: session.functionArea },
    (tx) =>
      tx
        .select()
        .from(schema.freshnessLog)
        .orderBy(desc(schema.freshnessLog.lastSyncAt))
        .limit(50),
  );

  const now = Date.now();
  return (
    <div>
      <h2 className="mb-3 text-base font-medium">Ingestion freshness</h2>
      <table className="w-full text-sm">
        <thead className="border-b border-neutral-200 text-left text-xs uppercase text-neutral-500 dark:border-neutral-800">
          <tr>
            <th className="py-2">Source</th>
            <th>Domain</th>
            <th>Last sync</th>
            <th>Rows</th>
            <th>SLA</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
          {rows.length === 0 && (
            <tr>
              <td colSpan={5} className="py-4 text-neutral-500">
                No syncs recorded yet.
              </td>
            </tr>
          )}
          {rows.map((r) => {
            const ageHours = (now - r.lastSyncAt.getTime()) / 3_600_000;
            const slaHours = FRESHNESS_SLA_HOURS[r.domain] ?? 24;
            const breached = ageHours > slaHours;
            return (
              <tr key={r.id}>
                <td className="py-2 font-mono text-xs">{r.source}</td>
                <td>{r.domain}</td>
                <td>{r.lastSyncAt.toISOString()}</td>
                <td>{r.rowsIngested}</td>
                <td className={breached ? "text-red-600" : "text-emerald-600"}>
                  {breached ? "BREACHED" : "OK"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

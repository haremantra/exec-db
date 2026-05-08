/**
 * GET /api/export/crm
 *
 * CRM export endpoint (US-026 / AD-006 / S1 PR3).
 *
 * Auth:    exec_all tier required.
 * Rate:    1 successful export per user per 24 hours.
 *          Tracked via audit.access_log — queries for rows with
 *          intent LIKE 'crm_export%' in the last 24h.
 * Returns: zip with Content-Disposition: attachment.
 * Audit:   every successful export is recorded in audit.access_log.
 */

import { NextResponse } from "next/server";
import { schema } from "@exec-db/db";
import { and, eq, gte, like } from "drizzle-orm";
import { getSession } from "@/lib/auth";
import { query } from "@/lib/db";
import { recordAccess } from "@/lib/audit";
import { buildCrmExport } from "@/lib/export";

export const dynamic = "force-dynamic";

const RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

export async function GET(): Promise<NextResponse> {
  // ── Auth ────────────────────────────────────────────────────────────────
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.tier !== "exec_all") {
    return NextResponse.json(
      { error: "Forbidden: CRM export requires exec_all tier" },
      { status: 403 },
    );
  }

  const ctx = { userId: session.userId, tier: session.tier, functionArea: session.functionArea };

  // ── Rate limit check ────────────────────────────────────────────────────
  // Count export events in the last 24h for this user.
  const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MS);

  const recentExports = await query(ctx, async (tx) => {
    return tx
      .select({ id: schema.accessLog.id })
      .from(schema.accessLog)
      .where(
        and(
          eq(schema.accessLog.userId, session.userId),
          gte(schema.accessLog.occurredAt, windowStart),
          like(schema.accessLog.intent, "crm_export%"),
        ),
      );
  });

  if (recentExports.length > 0) {
    return NextResponse.json(
      {
        error: "Rate limit exceeded: only 1 CRM export per 24 hours is allowed.",
        retryAfter: new Date(windowStart.getTime() + RATE_LIMIT_WINDOW_MS).toISOString(),
      },
      { status: 429 },
    );
  }

  // ── Build the zip ────────────────────────────────────────────────────────
  let exportResult: Awaited<ReturnType<typeof buildCrmExport>>;
  try {
    exportResult = await query(ctx, async (tx) => buildCrmExport(session, tx));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }

  // ── Audit log ────────────────────────────────────────────────────────────
  await query(ctx, async (tx) => {
    await recordAccess(tx, session, {
      schemaName: "crm",
      tableName: "contact",
      action: "EXPORT",
      intent: `crm_export userId=${session.userId} file=${exportResult.filename}`,
      metadata: {
        filename: exportResult.filename,
        userId: session.userId,
        exportedAt: new Date().toISOString(),
      },
    });
  });

  // ── Return the zip ───────────────────────────────────────────────────────
  // Use the Web Streams API ReadableStream to satisfy NextResponse's BodyInit type.
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(exportResult.zipBuffer);
      controller.close();
    },
  });
  return new NextResponse(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${exportResult.filename}"`,
      "Content-Length": String(exportResult.zipBuffer.byteLength),
    },
  });
}

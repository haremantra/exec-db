"use server";

import { schema } from "@exec-db/db";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { query } from "@/lib/db";
import { recordRankingOverride, type RankingResult } from "@/lib/ranker";

/**
 * Server action wired to the dashboard "I disagree — pick a different one"
 * button. Records the override into `audit.access_log` (M3 — US-024) and
 * redirects to the chosen task's project page.
 *
 * formData fields:
 *   - chosenTaskId       (uuid, required) — task the exec actually wants to do
 *   - originalTopPickId  (uuid, required) — the ranker's top pick the exec is rejecting
 *   - rankingJson        (string, required) — JSON-serialized RankingResult, written
 *                          verbatim to audit metadata so the decision is replayable
 */
export async function disagreeWithRanker(formData: FormData): Promise<void> {
  const session = await getSession();
  if (!session) throw new Error("Unauthorized");

  const chosenTaskId = String(formData.get("chosenTaskId") ?? "").trim();
  const originalTopPickId = String(formData.get("originalTopPickId") ?? "").trim();
  const rankingJson = String(formData.get("rankingJson") ?? "").trim();

  if (!chosenTaskId) throw new Error("disagreeWithRanker: chosenTaskId is required.");
  if (!originalTopPickId) {
    throw new Error("disagreeWithRanker: originalTopPickId is required.");
  }
  if (!rankingJson) throw new Error("disagreeWithRanker: rankingJson is required.");

  let ranking: RankingResult;
  try {
    ranking = JSON.parse(rankingJson) as RankingResult;
  } catch (err) {
    throw new Error(
      `disagreeWithRanker: rankingJson is not valid JSON (${(err as Error).message}).`,
    );
  }

  await recordRankingOverride(ranking, chosenTaskId, session);

  // Redirect to the chosen task's project page so the exec lands somewhere
  // useful. We look up the project id rather than encoding it in the form
  // (the form already has the chosen task; one extra read is trivial).
  const projectId = await query(
    {
      userId: session.userId,
      tier: session.tier,
      functionArea: session.functionArea,
    },
    async (tx) => {
      const [row] = await tx
        .select({ projectId: schema.task.projectId })
        .from(schema.task)
        .where(eq(schema.task.id, chosenTaskId))
        .limit(1);
      return row?.projectId ?? null;
    },
  );

  if (!projectId) {
    throw new Error(`disagreeWithRanker: chosen task ${chosenTaskId} not found.`);
  }

  redirect(`/pm/projects/${projectId}`);
}

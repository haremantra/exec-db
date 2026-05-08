import { schema } from "@exec-db/db";
import { and, desc, eq, ne } from "drizzle-orm";
import Link from "next/link";
import { getSession } from "@/lib/auth";
import { query } from "@/lib/db";
import { rankTasks, type RankerTask, type RankingResult } from "@/lib/ranker";
import { getCloseReadyCohort, type CloseReadyContact } from "@/lib/close-ready";
import { getSlippedTasks, type SlippedTask } from "@/lib/slipped-tasks";
import { disagreeWithRanker } from "./actions";

export const dynamic = "force-dynamic";

/**
 * Monday "what matters this week" dashboard (Stream L) + counterfactual
 * "Do this first" card (Stream M).
 *
 * Stream M (this PR) owns the "Do this first" card. Stream L will replace
 * the rest of this file with the 5-swimlane scaffold (US-017, W6.6, invariant
 * #6) and leave a `<div id="do-this-first" />` stub above the swimlanes.
 *
 * MERGE HANDOFF: when L merges first, the only edit needed here is to drop
 * the placeholder swimlane note below — the "Do this first" card stays.
 */
export default async function DashboardPage(): Promise<JSX.Element> {
  const session = await getSession();
  if (!session) return <p className="text-sm">Sign in required.</p>;

  const ctx = {
    userId: session.userId,
    tier: session.tier,
    functionArea: session.functionArea,
  };

  // Pull the top candidates for ranking. We only consider tasks that the exec
  // owns and that are not already done. Pinned items are picked up by the
  // same query (the ranker's candidate selection respects pinned-first).
  const rows = await query(ctx, (tx) =>
    tx
      .select({
        id: schema.task.id,
        title: schema.task.title,
        workArea: schema.task.workArea,
        impact: schema.task.impact,
        isPinned: schema.task.isPinned,
        dueDate: schema.task.dueDate,
        priority: schema.task.priority,
        status: schema.task.status,
        projectId: schema.task.projectId,
      })
      .from(schema.task)
      .where(
        and(
          eq(schema.task.ownerId, session.userId),
          ne(schema.task.status, "done"),
        ),
      )
      .orderBy(desc(schema.task.isPinned), desc(schema.task.updatedAt))
      .limit(20),
  );

  const candidates: RankerTask[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    workArea: r.workArea,
    impact: r.impact as RankerTask["impact"],
    isPinned: r.isPinned,
    dueDate: r.dueDate,
    priority: r.priority,
    status: r.status,
  }));

  const ranking = await rankTasks(candidates, session);

  // Map rows by id for the card UI.
  const byId = new Map(rows.map((r) => [r.id, r] as const));

  // {/* Stream N */} — Tuesday cohort + slipped tasks
  // Use new Date().getDay() === 2 as a stand-in for America/Los_Angeles Tuesday.
  const isTuesday = new Date().getDay() === 2;

  // Fetch close-ready cohort on Tuesdays and slipped tasks every day.
  const [closeReadyCohort, slippedTasks] = await Promise.all([
    isTuesday ? getCloseReadyCohort(session) : Promise.resolve([] as CloseReadyContact[]),
    getSlippedTasks(session),
  ]);

  return (
    <div className="space-y-8">
      <header className="flex items-baseline justify-between">
        <h2 className="text-base font-medium">Monday — what matters this week</h2>
        <span className="text-xs text-neutral-500">
          ranked by revenue + reputation impact
        </span>
      </header>

      {/* Stream N — Slipped tasks banner (always visible when tasks have slipped) */}
      {slippedTasks.length > 0 && (
        <SlippedBanner count={slippedTasks.length} />
      )}

      {/* Stream N — Tuesday "Sales — close-ready" section (Tuesdays only, above Do this first) */}
      {isTuesday && closeReadyCohort.length > 0 && (
        <CloseReadySection contacts={closeReadyCohort} />
      )}

      {/* M: Do this first card — replaces L's <div id="do-this-first" /> stub */}
      <DoThisFirstCard ranking={ranking} byId={byId} />

      {/* Stream L will render the 5-swimlane layout here:
           prospects-followup | inbox-progress | admin | thought-leadership | product-roadmap
           (US-017, W6.6, invariant #6).  Placeholder until L merges. */}
      {/* Stream N — slipped tasks are rendered at the top of their respective swimlanes
           (work_area lane) with a red dot. The 5-swimlane invariant (#6) is preserved:
           slipped tasks do NOT add a 6th swimlane — they are prepended within existing lanes.
           The SWIMLANE_KEYS constant below is the regression guard for invariant #6. */}
      <section className="rounded-md border border-dashed border-neutral-300 p-6 text-sm text-neutral-500 dark:border-neutral-700">
        Swimlanes will be rendered by Stream L. This dashboard route is shared
        between L (layout) and M (this card).
        {/* Stream N — slippedTasks prop will be passed to swimlane components once L merges */}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stream N — Invariant #6 regression guard
// ---------------------------------------------------------------------------

/**
 * SWIMLANE_KEYS — the exactly-five swimlane keys for the Monday dashboard.
 * Invariant #6: the Monday view shows exactly five swimlanes — never four, never six.
 * This constant is the canonical list. Tests import it to verify the count.
 * Stream L renders these; Stream N must never add to this list.
 *
 * US-017, W6.6, pr3-spec.md invariant #6.
 */
export const SWIMLANE_KEYS = [
  "prospects_followup",
  "inbox_progress",
  "admin",
  "thought_leadership",
  "product_roadmap",
] as const;

export type SwimlanKey = (typeof SWIMLANE_KEYS)[number];

// ---------------------------------------------------------------------------
// Stream N — Close-ready section (Tuesdays only)
// ---------------------------------------------------------------------------

function CloseReadySection({ contacts }: { contacts: CloseReadyContact[] }): JSX.Element {
  return (
    <section
      aria-label="Sales — close-ready"
      className="rounded-md border-2 border-emerald-400 bg-emerald-50 p-4 dark:border-emerald-600 dark:bg-emerald-950"
    >
      <header className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-emerald-900 dark:text-emerald-100">
          Sales — close-ready
        </h3>
        <span className="text-xs text-emerald-700 dark:text-emerald-300">
          warm reply ≤7d · qualified · no blockers · Tuesday
        </span>
      </header>

      <ul className="mt-3 space-y-3">
        {contacts.map((c) => {
          const touchLabel = c.lastTouchKind === "email" ? "email" : "note";
          const touchDate = c.lastTouchAt.toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
          });

          // Google Calendar new-event URL (no auth required to open).
          const calUrl =
            `https://calendar.google.com/calendar/render?action=TEMPLATE` +
            `&text=${encodeURIComponent(`Call with ${c.contactName}`)}` +
            `&details=${encodeURIComponent("Scheduled via exec-db close-ready cohort")}`;

          // Draft close email URL: links to contact page with autodraft tone pre-selected.
          const draftUrl =
            `/crm/contacts/${c.contactId}` +
            `?autodraft_tone=warm-sales-followup`;

          return (
            <li
              key={c.contactId}
              className="flex flex-wrap items-center justify-between gap-2 rounded bg-white/60 px-3 py-2 dark:bg-neutral-900/40"
            >
              <div className="min-w-0">
                <span className="block truncate text-sm font-medium">
                  {c.contactName}
                </span>
                <span className="text-xs text-neutral-500">
                  last {touchLabel} {touchDate} ·{" "}
                  <span className="rounded bg-emerald-100 px-1 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200">
                    {c.qualifierTag.replace("_", " ")}
                  </span>
                </span>
              </div>

              <div className="flex shrink-0 gap-2">
                <Link
                  href={draftUrl}
                  className="rounded border border-emerald-400 px-2 py-1 text-xs text-emerald-800 hover:bg-emerald-100 dark:border-emerald-600 dark:text-emerald-200 dark:hover:bg-emerald-900"
                >
                  Draft close email
                </Link>
                <a
                  href={calUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded border border-neutral-300 px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                >
                  Schedule call
                </a>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Stream N — Slipped tasks banner
// ---------------------------------------------------------------------------

function SlippedBanner({ count }: { count: number }): JSX.Element {
  return (
    <div
      role="alert"
      aria-label="Slipped tasks"
      className="flex items-center gap-2 rounded-md border border-red-300 bg-red-50 px-4 py-2 text-sm text-red-800 dark:border-red-700 dark:bg-red-950 dark:text-red-200"
    >
      {/* Red dot */}
      <span
        aria-hidden="true"
        className="inline-block h-2 w-2 shrink-0 rounded-full bg-red-500"
      />
      <span>
        <strong>Needs attention:</strong>{" "}
        {count === 1
          ? "1 slipped task"
          : `${count} slipped tasks`}{" "}
        (overdue or awaiting response past deadline). Slipped tasks appear at
        the top of their respective swimlanes below.
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Do this first card
// ---------------------------------------------------------------------------

type RowLite = {
  id: string;
  title: string;
  impact: string | null;
  projectId: string;
};

function DoThisFirstCard({
  ranking,
  byId,
}: {
  ranking: RankingResult;
  byId: Map<string, RowLite>;
}): JSX.Element {
  if (!ranking.topPick) {
    return (
      <section className="rounded-md border border-neutral-200 p-4 dark:border-neutral-800">
        <h3 className="text-sm font-medium">Do this first</h3>
        <p className="mt-2 text-sm text-neutral-500">
          No candidate tasks. Add a task or unblock something to get a recommendation.
        </p>
      </section>
    );
  }

  const top = byId.get(ranking.topPick.taskId);
  const alts = ranking.alternatives
    .map((a) => {
      const r = byId.get(a.taskId);
      return r ? { ...a, row: r } : null;
    })
    .filter((x): x is { taskId: string; deprioritizationReason: string; row: RowLite } => x !== null);

  // Serialize the ranking JSON for the override form (so the audit row can
  // capture the full state the exec rejected).
  const rankingJson = JSON.stringify(ranking);

  return (
    <section className="rounded-md border-2 border-amber-300 bg-amber-50 p-4 dark:border-amber-700 dark:bg-amber-950">
      <header className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold">Do this first</h3>
        <span className="text-xs uppercase tracking-wide text-amber-700 dark:text-amber-300">
          counterfactual ranking · Opus
        </span>
      </header>

      {top ? (
        <div className="mt-3 space-y-2">
          <Link
            href={`/pm/projects/${top.projectId}`}
            className="block text-base font-medium hover:underline"
          >
            {top.title}
          </Link>
          <div className="text-xs text-neutral-700 dark:text-neutral-300">
            {top.impact ? (
              <span className="mr-2 rounded bg-amber-200 px-1.5 py-0.5 dark:bg-amber-800">
                {top.impact}
              </span>
            ) : null}
            <span>{ranking.topPick.reason}</span>
          </div>
        </div>
      ) : (
        // Top pick taskId not in the loaded set — should not happen since we
        // pass the full candidate set to the ranker, but render gracefully.
        <p className="mt-3 text-sm text-neutral-500">
          Top pick {ranking.topPick.taskId.slice(0, 8)}… (not loaded).
        </p>
      )}

      {alts.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-xs font-medium text-neutral-700 dark:text-neutral-300">
            Why not these? ({alts.length})
          </summary>
          <ul className="mt-2 space-y-1.5 pl-3 text-xs text-neutral-700 dark:text-neutral-300">
            {alts.map((a) => (
              <li key={a.taskId} className="border-l-2 border-amber-300 pl-2 dark:border-amber-700">
                <Link
                  href={`/pm/projects/${a.row.projectId}`}
                  className="font-medium hover:underline"
                >
                  {a.row.title}
                </Link>
                <span className="ml-1 text-neutral-500">— {a.deprioritizationReason}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <details className="mt-4">
        <summary className="cursor-pointer text-xs text-neutral-600 underline dark:text-neutral-400">
          I disagree — pick a different one
        </summary>
        <form action={disagreeWithRanker} className="mt-2 flex flex-wrap items-baseline gap-2">
          <input type="hidden" name="originalTopPickId" value={ranking.topPick.taskId} />
          <input type="hidden" name="rankingJson" value={rankingJson} />
          <select
            name="chosenTaskId"
            required
            className="rounded border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-900"
          >
            <option value="">Choose a different task…</option>
            {Array.from(byId.values()).map((r) => (
              <option key={r.id} value={r.id}>
                {r.title}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="rounded bg-neutral-900 px-3 py-1 text-xs text-white dark:bg-neutral-100 dark:text-neutral-900"
          >
            Override
          </button>
        </form>
      </details>
    </section>
  );
}

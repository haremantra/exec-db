/**
 * dashboard/page.tsx — Monday "What matters this week" dashboard.
 *
 * Server component, force-dynamic (live data per session).
 * Renders exactly 5 swimlanes (cross-cutting invariant #6 from user-stories.md).
 *
 * Swimlane order matches W6.6 verbatim:
 *   1. Prospects to follow up
 *   2. Inbox progress
 *   3. Admin (vendors / contractors)
 *   4. Thought leadership
 *   5. Product roadmap
 *
 * Stream M conflict note:
 *   The <div id="do-this-first" /> placeholder above the swimlanes is reserved
 *   for Stream M, which will fill it with the "Do this first" counterfactual
 *   card (US-024, SY-013).  Stream M will edit THIS FILE to replace the stub.
 */

import { getSession } from "@/lib/auth";
import { getDashboardLanes, LANE_LIMIT } from "@/lib/dashboard";
import type { DashboardInbox, DashboardProspect, DashboardTask } from "@/lib/dashboard";

export const dynamic = "force-dynamic";

// ── Sub-components ─────────────────────────────────────────────────────────────

function SwimlaneHeader({ title, count }: { title: string; count: number | null }) {
  return (
    <div className="flex items-baseline justify-between border-b border-neutral-200 pb-2 dark:border-neutral-800">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-700 dark:text-neutral-300">
        {title}
      </h2>
      {count !== null && (
        <span className="text-xs text-neutral-400">{count} item{count !== 1 ? "s" : ""}</span>
      )}
    </div>
  );
}

function EmptyLane({ message }: { message: string }) {
  return (
    <p className="px-1 py-3 text-xs italic text-neutral-400">{message}</p>
  );
}

function PinnedBadge() {
  return (
    <span className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900 dark:text-amber-300">
      pinned
    </span>
  );
}

function ImpactBadge({ impact }: { impact: string | null }) {
  if (!impact) return null;
  const colours: Record<string, string> = {
    both:       "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300",
    revenue:    "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
    reputation: "bg-violet-100 text-violet-700 dark:bg-violet-900 dark:text-violet-300",
    neither:    "bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400",
  };
  const cls = colours[impact] ?? colours.neither;
  return (
    <span className={`ml-1.5 rounded px-1.5 py-0.5 text-xs font-medium ${cls}`}>
      {impact}
    </span>
  );
}

// ── Lane 1: Prospects ─────────────────────────────────────────────────────────

function ProspectsLane({ items }: { items: DashboardProspect[] }) {
  return (
    <section className="space-y-2" aria-label="Prospects to follow up">
      <SwimlaneHeader title="Prospects to follow up" count={items.length} />
      {items.length === 0 ? (
        <EmptyLane message="No prospects to follow up — tag a contact with can_help_them, can_help_me, or pilot_candidate to populate this lane." />
      ) : (
        <ul className="divide-y divide-neutral-100 dark:divide-neutral-900">
          {items.map((p) => (
            <li key={p.id} className="flex flex-col gap-0.5 py-2.5">
              <div className="flex items-baseline justify-between">
                <span className="text-sm font-medium">{p.fullName}</span>
                <span className="text-xs text-neutral-400">
                  {p.lastTouchAt
                    ? `last touch ${new Date(p.lastTouchAt).toLocaleDateString()}`
                    : "never touched"}
                </span>
              </div>
              <div className="flex items-center gap-2 text-xs text-neutral-500">
                {p.company && <span>{p.company}</span>}
                {p.roleTitle && <span>· {p.roleTitle}</span>}
                <span className="ml-auto rounded bg-neutral-100 px-1.5 py-0.5 dark:bg-neutral-800">
                  {p.reason}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ── Lane 2: Inbox progress ────────────────────────────────────────────────────

function InboxLane({ inbox }: { inbox: DashboardInbox }) {
  const hasItems = inbox.pendingDraftCount > 0 || inbox.gmailUnreadCount !== null;
  return (
    <section className="space-y-2" aria-label="Inbox progress">
      <SwimlaneHeader title="Inbox progress" count={null} />
      {!hasItems && inbox.pendingDraftCount === 0 ? (
        <EmptyLane message="No pending drafts — generate a follow-up from a call note to populate this lane." />
      ) : (
        <ul className="divide-y divide-neutral-100 dark:divide-neutral-900">
          <li className="flex items-center justify-between py-2.5">
            <span className="text-sm">Pending drafts awaiting review</span>
            <span className="text-sm font-medium">{inbox.pendingDraftCount}</span>
          </li>
          <li className="flex items-center justify-between py-2.5">
            <span className="text-sm">Unread emails</span>
            {/* TODO: Stream A (Google/Gmail) will provide getGmailUnreadCount().
                       Until that PR lands, this count is unavailable. See US-002. */}
            <span className="text-sm text-neutral-400">
              {inbox.gmailUnreadCount !== null ? inbox.gmailUnreadCount : "—"}
            </span>
          </li>
        </ul>
      )}
    </section>
  );
}

// ── Lane 3, 4, 5: Task lanes ──────────────────────────────────────────────────

function TaskLane({
  label,
  ariaLabel,
  items,
  emptyMessage,
}: {
  label: string;
  ariaLabel: string;
  items: DashboardTask[];
  emptyMessage: string;
}) {
  return (
    <section className="space-y-2" aria-label={ariaLabel}>
      <SwimlaneHeader title={label} count={items.length} />
      {items.length === 0 ? (
        <EmptyLane message={emptyMessage} />
      ) : (
        <ul className="divide-y divide-neutral-100 dark:divide-neutral-900">
          {items.map((t) => (
            <li key={t.id} className="flex flex-col gap-0.5 py-2.5">
              <div className="flex items-baseline gap-1">
                <span className="text-sm font-medium">{t.title}</span>
                {t.isPinned && <PinnedBadge />}
                <ImpactBadge impact={t.impact} />
              </div>
              <div className="flex items-center gap-2 text-xs text-neutral-400">
                <span className="rounded border border-neutral-200 px-1.5 py-0.5 dark:border-neutral-700">
                  {t.status}
                </span>
                {t.dueDate && <span>due {t.dueDate}</span>}
                {t.projectType && (
                  <span className="ml-auto text-neutral-400">{t.projectType}</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function DashboardPage(): Promise<JSX.Element> {
  const session = await getSession();
  if (!session) {
    return (
      <p className="text-sm text-neutral-500">Sign in required to view the dashboard.</p>
    );
  }

  const lanes = await getDashboardLanes(session);

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">What matters this week</h1>
        <p className="mt-1 text-sm text-neutral-500">
          {new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}
        </p>
      </header>

      {/*
        Stream M placeholder — "Do this first" counterfactual card (US-024).
        Stream M will replace this stub with the ranking card implementation.
        See: apps/web/lib/dashboard.ts for the DashboardLanes type it can consume.
      */}
      <div id="do-this-first" />

      {/* Exactly 5 swimlanes — invariant #6 */}
      <div className="grid gap-6">
        {/* Lane 1 */}
        <ProspectsLane items={lanes.prospects} />

        {/* Lane 2 */}
        <InboxLane inbox={lanes.inbox} />

        {/* Lane 3 */}
        <TaskLane
          label="Admin (vendors / contractors)"
          ariaLabel="Admin tasks"
          items={lanes.admin}
          emptyMessage={`No admin tasks — tag a task with work_area=admin to populate this lane. (Shows up to ${LANE_LIMIT} items.)`}
        />

        {/* Lane 4 */}
        <TaskLane
          label="Thought leadership"
          ariaLabel="Thought leadership tasks"
          items={lanes.thoughtLeadership}
          emptyMessage={`No thought-leadership tasks — tag a task with work_area=thought_leadership to populate this lane. (Shows up to ${LANE_LIMIT} items.)`}
        />

        {/* Lane 5 */}
        <TaskLane
          label="Product roadmap"
          ariaLabel="Product roadmap tasks"
          items={lanes.productRoadmap}
          emptyMessage={`No roadmap tasks — tag a task with a project of type hire, deal, okr, or other (and work_area outside admin/thought_leadership) to populate this lane. (Shows up to ${LANE_LIMIT} items.)`}
        />
      </div>
    </div>
  );
}

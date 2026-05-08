/**
 * dashboard.ts — Monday "What matters this week" data layer (L1-L4 — US-017, W6.6).
 *
 * CONTRACT:
 * ─────────────────────────────────────────────────────────────────────────────
 * • No LLM calls — pure SQL + ordering.  Stream M handles counterfactual ranking.
 * • All queries go through query() so RLS applies (sensitive contacts already
 *   hidden by Stream C).
 * • Exactly 5 lanes returned — cross-cutting invariant #6 (user-stories.md).
 * • Ordering within each lane:
 *     1. Pinned items first (is_pinned DESC)
 *     2. Impact: both > revenue > reputation > neither > null
 *     3. priority ASC
 *     4. due_date ASC NULLS LAST
 * • At most LANE_LIMIT (5) items per lane.
 * • Done tasks (status = 'done') are excluded from all lanes.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { schema } from "@exec-db/db";
import type { SessionContext } from "@exec-db/db";
import { and, asc, desc, eq, inArray, isNull, not, notInArray, sql } from "drizzle-orm";
import { query } from "@/lib/db";
import type { Session } from "@/lib/rbac";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Maximum items shown per lane (US-017 acceptance criterion). */
export const LANE_LIMIT = 5;

/**
 * Impact ordering expression for the tie-break rule.
 * both=1 > revenue=2 > reputation=3 > neither=4 > null=5
 * Lower number = higher priority.
 */
const IMPACT_ORDER_SQL = sql<number>`CASE
  WHEN impact = 'both'       THEN 1
  WHEN impact = 'revenue'    THEN 2
  WHEN impact = 'reputation' THEN 3
  WHEN impact = 'neither'    THEN 4
  ELSE 5
END`;

// ── Types ─────────────────────────────────────────────────────────────────────

/** A single task row as returned for a dashboard lane. */
export interface DashboardTask {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: number;
  dueDate: string | null;
  workArea: string | null;
  impact: string | null;
  isPinned: boolean;
  projectId: string;
  /** The project_type from the joined project row, or null if project not found. */
  projectType: string | null;
}

/** A single contact row as returned for the Prospects lane. */
export interface DashboardProspect {
  id: string;
  fullName: string;
  primaryEmail: string;
  company: string | null;
  roleTitle: string | null;
  triageTag: string | null;
  workArea: string | null;
  /** ISO timestamp of the most recent call note, or null if no notes exist. */
  lastTouchAt: string | null;
  /**
   * Human-readable reason this contact appears in the lane, derived from their
   * triage tag.
   */
  reason: string;
}

/** Pending draft count and inbox stub for the Inbox lane. */
export interface DashboardInbox {
  /**
   * Count of crm.draft rows with status = 'pending'.
   * These are autodrafts awaiting exec review.
   */
  pendingDraftCount: number;
  /**
   * Unread email count from Gmail.
   * TODO: Stream A (Google) has not yet landed the Gmail unread-count endpoint.
   *       This field is always null until that stream provides
   *       getGmailUnreadCount(session) from apps/web/lib/google-gmail.ts.
   */
  gmailUnreadCount: number | null;
}

/** The full dashboard lanes payload. */
export interface DashboardLanes {
  /** Lane 1 — contacts with a triage tag and last touch >7 days ago. */
  prospects: DashboardProspect[];
  /** Lane 2 — inbox progress: pending drafts + Gmail unread stub. */
  inbox: DashboardInbox;
  /** Lane 3 — pm.task where work_area = 'admin' AND status != 'done'. */
  admin: DashboardTask[];
  /** Lane 4 — pm.task where work_area = 'thought_leadership' AND status != 'done'. */
  thoughtLeadership: DashboardTask[];
  /**
   * Lane 5 — pm.task where work_area NOT IN ('admin', 'thought_leadership')
   *           AND project.project_type IN ('hire', 'deal', 'okr', 'other')
   *           AND status != 'done'.
   */
  productRoadmap: DashboardTask[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Map a triage tag to a short human-readable reason for the prospects lane. */
function triageReason(tag: string | null): string {
  switch (tag) {
    case "can_help_them":
      return "You can help them";
    case "can_help_me":
      return "They can help you";
    case "pilot_candidate":
      return "Pilot candidate";
    default:
      return "Follow up";
  }
}

// ── Lane queries ──────────────────────────────────────────────────────────────

/**
 * Lane 1 — Prospects to follow up.
 *
 * Criteria: crm.contact with triage_tag IN ('can_help_them', 'can_help_me',
 * 'pilot_candidate') AND last call_note.occurred_at > 7 days ago (or no notes).
 * Ordered alphabetically; pinning does not apply to contacts.
 */
async function getProspects(ctx: SessionContext): Promise<DashboardProspect[]> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const contacts = await query(ctx, (tx) =>
    tx
      .select({
        id: schema.contact.id,
        fullName: schema.contact.fullName,
        primaryEmail: schema.contact.primaryEmail,
        company: schema.contact.company,
        roleTitle: schema.contact.roleTitle,
        triageTag: schema.contact.triageTag,
        workArea: schema.contact.workArea,
      })
      .from(schema.contact)
      .where(
        and(
          inArray(schema.contact.triageTag, ["can_help_them", "can_help_me", "pilot_candidate"]),
          isNull(schema.contact.sensitiveFlag),
        ),
      )
      .orderBy(asc(schema.contact.fullName)),
  );

  const results: DashboardProspect[] = [];

  for (const c of contacts) {
    const lastNotes = await query(ctx, (tx) =>
      tx
        .select({ occurredAt: schema.callNote.occurredAt })
        .from(schema.callNote)
        .where(eq(schema.callNote.contactId, c.id))
        .orderBy(desc(schema.callNote.occurredAt))
        .limit(1),
    );

    const lastTouchAt = lastNotes[0]?.occurredAt ?? null;
    const isDue = lastTouchAt === null || lastTouchAt < sevenDaysAgo;

    if (isDue) {
      results.push({
        id: c.id,
        fullName: c.fullName,
        primaryEmail: c.primaryEmail,
        company: c.company ?? null,
        roleTitle: c.roleTitle ?? null,
        triageTag: c.triageTag ?? null,
        workArea: c.workArea ?? null,
        lastTouchAt: lastTouchAt?.toISOString() ?? null,
        reason: triageReason(c.triageTag ?? null),
      });
    }

    if (results.length >= LANE_LIMIT) break;
  }

  return results;
}

/**
 * Lane 2 — Inbox progress.
 *
 * Counts pending drafts in crm.draft (status='pending').
 * Gmail unread count is a future stream A deliverable — stubbed as null.
 */
async function getInbox(ctx: SessionContext): Promise<DashboardInbox> {
  const rows = await query(ctx, (tx) =>
    tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.draft)
      .where(eq(schema.draft.status, "pending")),
  );

  return {
    pendingDraftCount: rows[0]?.count ?? 0,
    // TODO: Stream A (Google) needs to land getGmailUnreadCount(session)
    //       in apps/web/lib/google-gmail.ts before this field can be populated.
    //       See apps/web/lib/google-gmail.ts and US-002.
    gmailUnreadCount: null,
  };
}

/**
 * Shared task query — fetches tasks joined with their project.
 *
 * Tie-break ordering:
 *   1. is_pinned DESC (pinned items always at top — US-004)
 *   2. IMPACT_ORDER_SQL (both=1, revenue=2, reputation=3, neither=4, null=5)
 *   3. priority ASC
 *   4. due_date ASC NULLS LAST
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getTasksForLane(ctx: SessionContext, whereClause: any): Promise<DashboardTask[]> {
  const rows = await query(ctx, (tx) =>
    tx
      .select({
        id: schema.task.id,
        title: schema.task.title,
        description: schema.task.description,
        status: schema.task.status,
        priority: schema.task.priority,
        dueDate: schema.task.dueDate,
        workArea: schema.task.workArea,
        impact: schema.task.impact,
        isPinned: schema.task.isPinned,
        projectId: schema.task.projectId,
        projectType: schema.project.projectType,
      })
      .from(schema.task)
      .leftJoin(schema.project, eq(schema.task.projectId, schema.project.id))
      .where(whereClause)
      .orderBy(
        desc(schema.task.isPinned),
        IMPACT_ORDER_SQL,
        asc(schema.task.priority),
        sql`${schema.task.dueDate} ASC NULLS LAST`,
      )
      .limit(LANE_LIMIT),
  );

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description ?? null,
    status: r.status,
    priority: r.priority,
    dueDate: r.dueDate ?? null,
    workArea: r.workArea ?? null,
    impact: r.impact ?? null,
    isPinned: r.isPinned,
    projectId: r.projectId,
    projectType: r.projectType ?? null,
  }));
}

/**
 * Lane 3 — Admin (vendors / contractors).
 *
 * pm.task where work_area = 'admin' AND status NOT IN ('done').
 */
async function getAdminTasks(ctx: SessionContext): Promise<DashboardTask[]> {
  return getTasksForLane(
    ctx,
    and(
      eq(schema.task.workArea, "admin"),
      not(eq(schema.task.status, "done")),
    ),
  );
}

/**
 * Lane 4 — Thought leadership.
 *
 * pm.task where work_area = 'thought_leadership' AND status NOT IN ('done').
 */
async function getThoughtLeadershipTasks(ctx: SessionContext): Promise<DashboardTask[]> {
  return getTasksForLane(
    ctx,
    and(
      eq(schema.task.workArea, "thought_leadership"),
      not(eq(schema.task.status, "done")),
    ),
  );
}

/**
 * Lane 5 — Product roadmap.
 *
 * pm.task where work_area NOT IN ('admin', 'thought_leadership')
 *             AND project.project_type IN ('hire', 'deal', 'okr', 'other')
 *             AND status NOT IN ('done').
 */
async function getProductRoadmapTasks(ctx: SessionContext): Promise<DashboardTask[]> {
  return getTasksForLane(
    ctx,
    and(
      notInArray(schema.task.workArea, ["admin", "thought_leadership"]),
      inArray(schema.project.projectType, ["hire", "deal", "okr", "other"]),
      not(eq(schema.task.status, "done")),
    ),
  );
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Assemble all five dashboard lanes for a given session.
 *
 * Invariant #6: always returns exactly 5 lanes — never four, never six.
 * Each lane is an array (or struct for inbox) that may be empty; the UI
 * handles the empty-lane prompt.
 *
 * @param session - The authenticated user session (from getSession()).
 * @returns DashboardLanes with exactly 5 keys.
 */
export async function getDashboardLanes(session: Session): Promise<DashboardLanes> {
  const ctx: SessionContext = {
    userId: session.userId,
    tier: session.tier,
    functionArea: session.functionArea,
  };

  const [prospects, inbox, admin, thoughtLeadership, productRoadmap] = await Promise.all([
    getProspects(ctx),
    getInbox(ctx),
    getAdminTasks(ctx),
    getThoughtLeadershipTasks(ctx),
    getProductRoadmapTasks(ctx),
  ]);

  // Invariant #6: the return shape MUST have exactly these 5 keys.
  return { prospects, inbox, admin, thoughtLeadership, productRoadmap };
}

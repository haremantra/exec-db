/**
 * cadence-alert.ts — Contact-category cadence alerts (PR3-P, P2, SY-002).
 *
 * Checks whether the exec has maintained expected touch frequency per contact
 * category over the relevant time window, per W2.1:
 *
 *   investor    → ≥1 touch/week       (window: 7 days)
 *   customer    → ≥3 touches/week     (window: 7 days)
 *   prospect    → ≥1 touch/2 weeks    (window: 14 days — biweekly per W2.1)
 *   contractor  → ≥3 touches/week     (window: 7 days)
 *   board       → ≥1 touch/week       (window: 7 days)
 *
 * HEURISTIC — contact category inference (no explicit category column yet)
 * ─────────────────────────────────────────────────────────────────────────────
 * Until a dedicated `category` column exists on `crm.contact`, we infer it
 * from the existing `sensitive_flag`, `triage_tag`, and `work_area` columns:
 *
 *   investor   → contact.sensitive_flag IN ('vc_outreach', 'partnership')
 *                OR contact.work_area = 'investor'
 *   customer   → contact.sensitive_flag = 'rolled_off_customer'
 *                OR contact.work_area = 'customer'
 *   prospect   → contact.triage_tag IN ('pilot_candidate', 'can_help_me')
 *                OR contact.work_area = 'prospecting'
 *   contractor → contact.sensitive_flag = 'irrelevant_vendor'
 *                OR contact.work_area = 'contractor'
 *   board      → contact.work_area = 'board'
 *
 * Precedence: sensitive_flag binding takes priority over work_area so that
 * flagged contacts are counted correctly even if work_area is unset.
 *
 * TODO: When a `category` column is added to `crm.contact`, replace this
 *       heuristic with a direct column read. The spec leaves this open
 *       (docs/pr3-spec.md § P2).
 *
 * A "touch" is any row in `crm.call_note` or `crm.email_thread` linked to the
 * contact with an occurred_at / last_message_at within the category's window.
 *
 * Sensitive-contact exclusion note: The RLS policy on `crm.contact` already
 * excludes contacts that are hidden from the session role. No additional
 * filter is required here — the DB query runs as exec_all which sees
 * all contacts but respects is_sensitive_for_role().
 */

import { and, eq, gte, or, sql } from "drizzle-orm";
import { schema } from "@exec-db/db";
import { query } from "@/lib/db";
import type { Session } from "@/lib/rbac";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ContactCategory = "investor" | "customer" | "prospect" | "contractor" | "board";

/**
 * A single per-category cadence alert record.
 *
 * `actualCount` is the number of touches observed in the window.
 * `expectedPerWindow` is the minimum required in that same window.
 * When `actualCount < expectedPerWindow` the caller should surface an alert.
 */
export interface CadenceAlert {
  category: ContactCategory;
  /** Minimum touches expected in the window. */
  expectedPerWindow: number;
  /** Actual touches recorded in the window. */
  actualCount: number;
  /** Length of the evaluation window in days. */
  windowDays: number;
}

// ---------------------------------------------------------------------------
// Per-category configuration (W2.1)
// ---------------------------------------------------------------------------

interface CategoryConfig {
  expectedPerWindow: number;
  windowDays: number;
}

const CATEGORY_CONFIG: Record<ContactCategory, CategoryConfig> = {
  investor:   { expectedPerWindow: 1, windowDays: 7  },
  customer:   { expectedPerWindow: 3, windowDays: 7  },
  prospect:   { expectedPerWindow: 1, windowDays: 14 }, // biweekly per W2.1
  contractor: { expectedPerWindow: 3, windowDays: 7  },
  board:      { expectedPerWindow: 1, windowDays: 7  },
};

// ---------------------------------------------------------------------------
// Heuristic: classify a contact row into a category
// ---------------------------------------------------------------------------

/**
 * Infer the contact category from available fields.
 *
 * Binding order (highest to lowest priority):
 * 1. sensitive_flag → investor / customer / contractor
 * 2. triage_tag     → prospect
 * 3. work_area      → any category
 *
 * Returns null when no category can be inferred.
 */
export function inferContactCategory(contact: {
  sensitiveFlag: string | null;
  triageTag: string | null;
  workArea: string | null;
}): ContactCategory | null {
  // 1. sensitive_flag bindings
  if (
    contact.sensitiveFlag === "vc_outreach" ||
    contact.sensitiveFlag === "partnership"
  ) {
    return "investor";
  }
  if (contact.sensitiveFlag === "rolled_off_customer") {
    return "customer";
  }
  if (contact.sensitiveFlag === "irrelevant_vendor") {
    return "contractor";
  }

  // 2. triage_tag → prospect
  if (
    contact.triageTag === "pilot_candidate" ||
    contact.triageTag === "can_help_me"
  ) {
    return "prospect";
  }

  // 3. work_area fallback
  switch (contact.workArea) {
    case "investor":      return "investor";
    case "customer":      return "customer";
    case "prospecting":   return "prospect";
    case "contractor":    return "contractor";
    case "board":         return "board";
    default:              return null;
  }
}

// ---------------------------------------------------------------------------
// Touch counting: raw count of call_notes + email_threads per contact in window
// ---------------------------------------------------------------------------

interface TouchCounts {
  /** contactId → count of touches in the window */
  [contactId: string]: number;
}

/**
 * Return the total number of touches (call_notes + email_threads) per contact
 * for all contacts whose ID appears in `contactIds`, within the last
 * `windowDays` days.
 */
async function countTouchesInWindow(
  contactIds: string[],
  windowDays: number,
  session: Session,
): Promise<TouchCounts> {
  if (contactIds.length === 0) return {};

  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const sinceIso = since.toISOString();

  const counts: TouchCounts = {};

  await query(
    { userId: session.userId, tier: session.tier, functionArea: session.functionArea },
    async (tx) => {
      // Call-note touches per contact
      const noteRows = await tx
        .select({
          contactId: schema.callNote.contactId,
          cnt: sql<number>`count(*)::int`,
        })
        .from(schema.callNote)
        .where(
          and(
            sql`${schema.callNote.contactId} = ANY(${sql.raw(`ARRAY[${contactIds.map((id) => `'${id}'`).join(",")}]::uuid[]`)})`,
            gte(schema.callNote.occurredAt, new Date(sinceIso)),
          ),
        )
        .groupBy(schema.callNote.contactId);

      for (const row of noteRows) {
        counts[row.contactId] = (counts[row.contactId] ?? 0) + (row.cnt ?? 0);
      }

      // Email-thread touches per contact
      const threadRows = await tx
        .select({
          contactId: schema.emailThread.contactId,
          cnt: sql<number>`count(*)::int`,
        })
        .from(schema.emailThread)
        .where(
          and(
            sql`${schema.emailThread.contactId} = ANY(${sql.raw(`ARRAY[${contactIds.map((id) => `'${id}'`).join(",")}]::uuid[]`)})`,
            gte(schema.emailThread.lastMessageAt, new Date(sinceIso)),
          ),
        )
        .groupBy(schema.emailThread.contactId);

      for (const row of threadRows) {
        const id = row.contactId ?? "";
        if (id) counts[id] = (counts[id] ?? 0) + (row.cnt ?? 0);
      }
    },
  );

  return counts;
}

// ---------------------------------------------------------------------------
// Public API: getCadenceAlerts
// ---------------------------------------------------------------------------

/**
 * For each contact category with at least one contact in the DB, compute
 * the total touches in the category's expected window and return an alert
 * when the count falls below the threshold.
 *
 * Returns only categories that are BELOW their expected threshold
 * (callers should surface these as warnings in the digest / dashboard).
 *
 * Sensitive contacts are NOT double-filtered here. The `exec_all` session
 * context used below means the exec can always see their own flagged contacts
 * for cadence-monitoring purposes. The digest rendering layer separately
 * decides whether to show names.
 */
export async function getCadenceAlerts(session: Session): Promise<CadenceAlert[]> {
  // Step 1: Fetch all contacts with their classification fields.
  const contacts = await query(
    { userId: session.userId, tier: session.tier, functionArea: session.functionArea },
    async (tx) =>
      tx
        .select({
          id: schema.contact.id,
          sensitiveFlag: schema.contact.sensitiveFlag,
          triageTag: schema.contact.triageTag,
          workArea: schema.contact.workArea,
        })
        .from(schema.contact),
  );

  // Step 2: Classify each contact into a category.
  // Build a map: category → list of contactIds
  const categoryContacts: Record<ContactCategory, string[]> = {
    investor:   [],
    customer:   [],
    prospect:   [],
    contractor: [],
    board:      [],
  };

  for (const c of contacts) {
    const cat = inferContactCategory({
      sensitiveFlag: c.sensitiveFlag ?? null,
      triageTag: c.triageTag ?? null,
      workArea: c.workArea ?? null,
    });
    if (cat) categoryContacts[cat].push(c.id);
  }

  // Step 3: For each category that has contacts, count touches in the window.
  //         Use the longest window per batch to minimise round-trips.
  const alerts: CadenceAlert[] = [];

  for (const [cat, contactIds] of Object.entries(categoryContacts) as [ContactCategory, string[]][]) {
    if (contactIds.length === 0) continue;

    const cfg = CATEGORY_CONFIG[cat];
    const touchCounts = await countTouchesInWindow(contactIds, cfg.windowDays, session);

    // Total touches across all contacts in this category within the window.
    const totalTouches = Object.values(touchCounts).reduce((sum, n) => sum + n, 0);

    if (totalTouches < cfg.expectedPerWindow) {
      alerts.push({
        category: cat,
        expectedPerWindow: cfg.expectedPerWindow,
        actualCount: totalTouches,
        windowDays: cfg.windowDays,
      });
    }
  }

  // Return alerts in a stable order for deterministic digest rendering.
  const ORDER: ContactCategory[] = ["investor", "customer", "prospect", "contractor", "board"];
  alerts.sort((a, b) => ORDER.indexOf(a.category) - ORDER.indexOf(b.category));

  return alerts;
}

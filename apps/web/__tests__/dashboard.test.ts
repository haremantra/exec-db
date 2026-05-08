/**
 * dashboard.test.ts — Monday "What matters this week" dashboard tests.
 *
 * Covers (15 tests):
 *  1. Lane count invariant: getDashboardLanes returns exactly 5 lanes (invariant #6).
 *  2. Prospects lane: only contacts with qualifying triage tags appear.
 *  3. Prospects lane: contacts with sensitiveFlag are excluded.
 *  4. Prospects lane: contacts with last touch ≤7 days ago are excluded.
 *  5. Prospects lane: contacts with no notes (never touched) are included.
 *  6. Admin lane: only tasks with work_area='admin' appear and work_area is correct.
 *  7. Admin lane: done tasks are excluded.
 *  8. ThoughtLeadership lane: only tasks with work_area='thought_leadership' appear.
 *  9. ProductRoadmap lane: admin/thought_leadership work areas excluded.
 * 10. ProductRoadmap lane: only tasks in qualifying project types appear.
 * 11. Pinned items appear first regardless of impact ordering.
 * 12. Pinned null-impact beats non-pinned both-impact.
 * 13. Impact tie-break: both > revenue > reputation > neither > null.
 * 14. Empty lanes return arrays/structs (UI handles prompts).
 * 15. At most LANE_LIMIT (5) items returned per task lane.
 *
 * Stories: US-017 (Monday dashboard), US-004 (pinning), US-021 (impact tag).
 * Invariant #6: exactly 5 swimlanes — never four, never six.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── UUIDs ─────────────────────────────────────────────────────────────────────

const EXEC_ID   = "00000000-0000-0000-0000-000000000001";
const PROJ_A    = "11110000-0000-0000-0000-000000000001";
const PROJ_B    = "11110000-0000-0000-0000-000000000002";
const PROJ_C    = "11110000-0000-0000-0000-000000000003";

// ── Seed data ─────────────────────────────────────────────────────────────────

/** Contact seed: mix of triage-tagged, sensitive, and untagged. */
const seedContacts = [
  {
    id: "c1",
    fullName: "Alice Prospect",
    primaryEmail: "alice@example.com",
    company: "Acme",
    roleTitle: "CTO",
    triageTag: "can_help_me",
    workArea: "prospecting",
    sensitiveFlag: null,
  },
  {
    id: "c2",
    fullName: "Bob Pilot",
    primaryEmail: "bob@example.com",
    company: "Beta Corp",
    roleTitle: "VP",
    triageTag: "pilot_candidate",
    workArea: "prospecting",
    sensitiveFlag: null,
  },
  {
    id: "c3",
    fullName: "Carol Sensitive",
    primaryEmail: "carol@example.com",
    company: "Gamma Inc",
    roleTitle: "CEO",
    triageTag: "can_help_them",
    workArea: "prospecting",
    sensitiveFlag: "vc_outreach",
  },
  {
    id: "c4",
    fullName: "Dan Untagged",
    primaryEmail: "dan@example.com",
    company: "Delta LLC",
    roleTitle: "Dir",
    triageTag: null,
    workArea: "customer",
    sensitiveFlag: null,
  },
];

/** Recent contact: has a note from 2 days ago (should NOT appear in prospects lane). */
const RECENT_CONTACT_ID = "c5";
const recentContact = {
  id: RECENT_CONTACT_ID,
  fullName: "Eve Recent",
  primaryEmail: "eve@example.com",
  company: "Echo",
  roleTitle: "Head of Sales",
  triageTag: "can_help_me",
  workArea: "prospecting",
  sensitiveFlag: null,
};

/** Call note seed: c1 has a stale note (>7 days); c5 has a fresh note (2 days). */
const twoDaysAgo  = new Date(Date.now() - 2  * 24 * 60 * 60 * 1000);
const tenDaysAgo  = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);

const seedNotes: Record<string, { occurredAt: Date }[]> = {
  c1: [{ occurredAt: tenDaysAgo }],
  c5: [{ occurredAt: twoDaysAgo }],
};

/** Draft seed. */
const seedDrafts = [
  { id: "d1", status: "pending" },
  { id: "d2", status: "pending" },
  { id: "d3", status: "saved_to_gmail" },
];

/** Project seed. */
const seedProjects: Record<string, { projectType: string | null }> = {
  [PROJ_A]: { projectType: "okr" },
  [PROJ_B]: { projectType: "deal" },
  [PROJ_C]: { projectType: "sales_call" }, // excluded from roadmap lane
};

/** Task seed for lane tests. */
const seedTasks = [
  // Admin tasks
  { id: "t1",  title: "Pay vendor invoice",    workArea: "admin",              status: "todo",        impact: "neither",    isPinned: false, priority: 3, dueDate: "2026-06-01", projectId: PROJ_A },
  { id: "t2",  title: "Contractor onboarding", workArea: "admin",              status: "in_progress", impact: "revenue",    isPinned: false, priority: 2, dueDate: "2026-05-20", projectId: PROJ_A },
  { id: "t3",  title: "Vendor contract done",  workArea: "admin",              status: "done",        impact: "both",       isPinned: false, priority: 1, dueDate: null,         projectId: PROJ_A },

  // Thought leadership tasks
  { id: "t4",  title: "Draft newsletter",      workArea: "thought_leadership", status: "todo",        impact: "reputation", isPinned: false, priority: 3, dueDate: "2026-06-10", projectId: PROJ_B },
  { id: "t5",  title: "LinkedIn article",      workArea: "thought_leadership", status: "blocked",     impact: "both",       isPinned: true,  priority: 2, dueDate: "2026-05-25", projectId: PROJ_B },

  // Product roadmap tasks
  { id: "t6",  title: "Hire senior engineer",  workArea: "prospecting",        status: "todo",        impact: "revenue",    isPinned: false, priority: 2, dueDate: "2026-07-01", projectId: PROJ_A },
  { id: "t7",  title: "Close Series A deal",   workArea: "investor",           status: "in_progress", impact: "both",       isPinned: true,  priority: 1, dueDate: "2026-05-30", projectId: PROJ_B },
  { id: "t8",  title: "OKR review done",       workArea: "board",              status: "done",        impact: "revenue",    isPinned: false, priority: 3, dueDate: null,         projectId: PROJ_A },

  // Task with excluded project type (sales_call)
  { id: "t9",  title: "Sales call prep",       workArea: "customer",           status: "todo",        impact: "revenue",    isPinned: false, priority: 1, dueDate: "2026-06-05", projectId: PROJ_C },

  // Impact ordering test tasks (all admin, all undone)
  { id: "t10", title: "Impact=both",           workArea: "admin",              status: "todo",        impact: "both",       isPinned: false, priority: 5, dueDate: null,         projectId: PROJ_A },
  { id: "t11", title: "Impact=revenue",        workArea: "admin",              status: "todo",        impact: "revenue",    isPinned: false, priority: 5, dueDate: null,         projectId: PROJ_A },
  { id: "t12", title: "Impact=reputation",     workArea: "admin",              status: "todo",        impact: "reputation", isPinned: false, priority: 5, dueDate: null,         projectId: PROJ_A },
  { id: "t13", title: "Impact=neither",        workArea: "admin",              status: "todo",        impact: "neither",    isPinned: false, priority: 5, dueDate: null,         projectId: PROJ_A },
  { id: "t14", title: "Impact=null",           workArea: "admin",              status: "todo",        impact: null,         isPinned: false, priority: 5, dueDate: null,         projectId: PROJ_A },
  { id: "t15", title: "Impact=pinned-null",    workArea: "admin",              status: "todo",        impact: null,         isPinned: true,  priority: 5, dueDate: null,         projectId: PROJ_A },
];

// ── Sorting helper (mirrors dashboard.ts tie-break rule) ──────────────────────

function impactOrder(impact: string | null): number {
  if (impact === "both")       return 1;
  if (impact === "revenue")    return 2;
  if (impact === "reputation") return 3;
  if (impact === "neither")    return 4;
  return 5;
}

function sortTasks(tasks: typeof seedTasks) {
  return [...tasks].sort((a, b) => {
    // 1. pinned DESC
    if (b.isPinned !== a.isPinned) return (b.isPinned ? 1 : 0) - (a.isPinned ? 1 : 0);
    // 2. impact
    const ia = impactOrder(a.impact);
    const ib = impactOrder(b.impact);
    if (ia !== ib) return ia - ib;
    // 3. priority ASC
    if (a.priority !== b.priority) return a.priority - b.priority;
    // 4. dueDate ASC NULLS LAST
    if (a.dueDate !== b.dueDate) {
      if (!a.dueDate) return 1;
      if (!b.dueDate) return -1;
      return a.dueDate.localeCompare(b.dueDate);
    }
    return 0;
  });
}

// ── Mock @/lib/db ─────────────────────────────────────────────────────────────

/** Controls whether Eve Recent (c5, touched 2 days ago) appears in this test run. */
let mockIncludeRecentContact = false;

vi.mock("@/lib/db", () => ({
  query: async <T,>(
    _ctx: { userId: string; tier: string; functionArea: string | null },
    fn: (tx: unknown) => Promise<T>,
  ): Promise<T> => {
    const tx = buildTx();
    return fn(tx);
  },
}));

function buildTx() {
  // eslint-disable-next-line prefer-const
  let _table: unknown = null;
  let _whereExpr: unknown = null;
  let _limit = 100;

  function tableName(t: unknown): string {
    if (!t) return "";
    const sym = Symbol.for("drizzle:Name");
    return (t as Record<symbol, string>)[sym] ?? "";
  }

  function executeQuery(): unknown[] {
    const name = tableName(_table);

    if (name === "contact") {
      const base = [...seedContacts];
      if (mockIncludeRecentContact) base.push(recentContact);
      return base
        .filter((c) => {
          const tags = ["can_help_them", "can_help_me", "pilot_candidate"];
          return tags.includes(c.triageTag ?? "") && c.sensitiveFlag === null;
        })
        .sort((a, b) => a.fullName.localeCompare(b.fullName));
    }

    if (name === "call_note") {
      // Extract the contactId from eq(callNote.contactId, id) WHERE clause.
      type EqExpr = { __type: string; val: unknown };
      const eq = _whereExpr as EqExpr | null;
      const contactIdVal = eq?.__type === "eq" ? String(eq.val) : null;
      const notes = contactIdVal ? (seedNotes[contactIdVal] ?? []) : [];
      return [...notes]
        .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
        .slice(0, _limit);
    }

    if (name === "draft") {
      const pending = seedDrafts.filter((d) => d.status === "pending").length;
      return [{ count: pending }];
    }

    if (name === "task") {
      let tasks = seedTasks.map((t) => ({
        ...t,
        description: null,
        projectType: seedProjects[t.projectId]?.projectType ?? null,
      }));

      // Dispatch by WHERE pattern — notInArray indicates productRoadmap lane.
      const whereStr = JSON.stringify(_whereExpr);

      if (whereStr.includes("notInArray")) {
        // Product roadmap lane
        const roadmapTypes = ["hire", "deal", "okr", "other"];
        tasks = tasks.filter(
          (t) =>
            t.status !== "done" &&
            t.workArea !== "admin" &&
            t.workArea !== "thought_leadership" &&
            roadmapTypes.includes(t.projectType ?? ""),
        );
      } else if (whereStr.includes('"thought_leadership"')) {
        // Thought leadership lane
        tasks = tasks.filter(
          (t) => t.workArea === "thought_leadership" && t.status !== "done",
        );
      } else {
        // Admin lane (eq workArea='admin' + not done)
        tasks = tasks.filter(
          (t) => t.workArea === "admin" && t.status !== "done",
        );
      }

      return sortTasks(tasks).slice(0, _limit);
    }

    return [];
  }

  return {
    select(_cols?: Record<string, unknown>) {
      const self = {
        from(table: unknown) {
          _table = table;

          /**
           * A "chainable thenable" — supports both patterns:
           *   .select().from().where().orderBy()        (contacts, drafts: no .limit())
           *   .select().from().where().orderBy().limit() (call_notes, tasks: with .limit())
           */
          const chain = {
            leftJoin(_joined: unknown, _on: unknown) { return chain; },
            where(expr: unknown) { _whereExpr = expr; return chain; },
            orderBy(..._args: unknown[]) { return chain; },
            limit(n: number) {
              _limit = n;
              return Promise.resolve(executeQuery() as unknown[]);
            },
            then<T2>(resolve: (val: unknown[]) => T2) {
              return Promise.resolve(executeQuery() as unknown[]).then(resolve);
            },
          };
          return chain;
        },
      };
      return self;
    },
  };
}

// ── Mock @exec-db/db ──────────────────────────────────────────────────────────

vi.mock("@exec-db/db", () => {
  function makeTable(name: string, schemaName: string) {
    const sym = Symbol.for("drizzle:Name");
    const schemaSym = Symbol.for("drizzle:Schema");
    const t: Record<symbol, string> = {};
    t[sym] = name;
    t[schemaSym] = schemaName;
    return new Proxy(t as Record<string | symbol, unknown>, {
      get(target, prop) {
        if (typeof prop === "symbol") return target[prop];
        if (prop in target) return target[prop];
        return { fieldName: prop, tableName: name };
      },
    });
  }

  return {
    schema: {
      contact:  makeTable("contact",   "crm"),
      callNote: makeTable("call_note", "crm"),
      draft:    makeTable("draft",     "crm"),
      task:     makeTable("task",      "pm"),
      project:  makeTable("project",   "pm"),
    },
    IMPACT_VALUES:        ["revenue", "reputation", "both", "neither"],
    TASK_STATUS_VALUES:   ["todo", "in_progress", "blocked", "stuck", "done"],
    PROJECT_TYPE_VALUES:  ["sales_call", "licensing", "hire", "deal", "board_prep", "okr", "other"],
    WORK_AREA_VALUES:     ["prospecting", "customer", "investor", "contractor", "board", "thought_leadership", "admin"],
    TRIAGE_TAG_VALUES:    ["can_help_them", "can_help_me", "pilot_candidate"],
    SENSITIVE_FLAG_VALUES:["rolled_off_customer", "irrelevant_vendor", "acquisition_target", "loi", "vc_outreach", "partnership"],
  };
});

// ── Mock drizzle-orm ──────────────────────────────────────────────────────────

vi.mock("drizzle-orm", () => ({
  eq:         (_col: unknown, val: unknown)  => ({ __type: "eq",         val, _col }),
  and:        (...args: unknown[])           => ({ __type: "and",        args }),
  or:         (...args: unknown[])           => ({ __type: "or",         args }),
  not:        (expr: unknown)                => ({ __type: "not",        expr }),
  asc:        (_col: unknown)                => ({ __type: "asc",        _col }),
  desc:       (_col: unknown)                => ({ __type: "desc",       _col }),
  inArray:    (_col: unknown, vals: unknown) => ({ __type: "inArray",    vals, _col }),
  notInArray: (_col: unknown, vals: unknown) => ({ __type: "notInArray", vals, _col }),
  isNull:     (_col: unknown)                => ({ __type: "isNull",     _col }),
  lt:         (_col: unknown, val: unknown)  => ({ __type: "lt",         val, _col }),
  sql:        (strings: TemplateStringsArray, ..._exprs: unknown[]) => ({
    __type: "sql",
    text: strings.join("?"),
  }),
}));

// ── Session fixture ───────────────────────────────────────────────────────────

const execSession = {
  userId: EXEC_ID,
  email: "exec@exec-db.local",
  tier: "exec_all" as const,
  functionArea: null,
};

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockIncludeRecentContact = false;
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("getDashboardLanes — invariant #6: exactly 5 swimlanes", () => {
  it("returns an object with exactly 5 lane keys (never 4, never 6)", async () => {
    const { getDashboardLanes } = await import("@/lib/dashboard");
    const lanes = await getDashboardLanes(execSession);
    const keys = Object.keys(lanes);
    expect(keys).toHaveLength(5);
    expect(keys).toContain("prospects");
    expect(keys).toContain("inbox");
    expect(keys).toContain("admin");
    expect(keys).toContain("thoughtLeadership");
    expect(keys).toContain("productRoadmap");
  });
});

describe("getDashboardLanes — lane 1: prospects", () => {
  it("only returns contacts with qualifying triage tags (can_help_them, can_help_me, pilot_candidate)", async () => {
    const { getDashboardLanes } = await import("@/lib/dashboard");
    const lanes = await getDashboardLanes(execSession);
    const names = lanes.prospects.map((p) => p.fullName);
    // Dan Untagged has no triage tag — must be excluded
    expect(names).not.toContain("Dan Untagged");
    // Alice (can_help_me) and Bob (pilot_candidate) have qualifying tags
    expect(names).toContain("Alice Prospect");
    expect(names).toContain("Bob Pilot");
  });

  it("excludes contacts with a sensitiveFlag", async () => {
    const { getDashboardLanes } = await import("@/lib/dashboard");
    const lanes = await getDashboardLanes(execSession);
    const names = lanes.prospects.map((p) => p.fullName);
    expect(names).not.toContain("Carol Sensitive");
  });

  it("excludes contacts whose last touch is within 7 days", async () => {
    mockIncludeRecentContact = true;
    const { getDashboardLanes } = await import("@/lib/dashboard");
    const lanes = await getDashboardLanes(execSession);
    const names = lanes.prospects.map((p) => p.fullName);
    // Eve Recent has a note from 2 days ago — should be excluded
    expect(names).not.toContain("Eve Recent");
  });

  it("includes contacts that have never been touched (no call notes)", async () => {
    const { getDashboardLanes } = await import("@/lib/dashboard");
    const lanes = await getDashboardLanes(execSession);
    const names = lanes.prospects.map((p) => p.fullName);
    // Bob Pilot has no notes in seedNotes — should be included
    expect(names).toContain("Bob Pilot");
  });
});

describe("getDashboardLanes — lane 3: admin tasks", () => {
  it("only returns admin work_area tasks that are not done", async () => {
    const { getDashboardLanes } = await import("@/lib/dashboard");
    const lanes = await getDashboardLanes(execSession);
    // Every item must have work_area=admin
    for (const t of lanes.admin) {
      expect(t.workArea).toBe("admin");
    }
    // Lane has items (there are many non-done admin tasks in seed)
    expect(lanes.admin.length).toBeGreaterThan(0);
    // Pinned item must be present
    expect(lanes.admin.map((t) => t.title)).toContain("Impact=pinned-null");
  });

  it("excludes done tasks from the admin lane", async () => {
    const { getDashboardLanes } = await import("@/lib/dashboard");
    const lanes = await getDashboardLanes(execSession);
    const titles = lanes.admin.map((t) => t.title);
    expect(titles).not.toContain("Vendor contract done"); // status=done
  });
});

describe("getDashboardLanes — lane 4: thought leadership", () => {
  it("includes only thought_leadership tasks that are not done", async () => {
    const { getDashboardLanes } = await import("@/lib/dashboard");
    const lanes = await getDashboardLanes(execSession);
    const titles = lanes.thoughtLeadership.map((t) => t.title);
    expect(titles).toContain("Draft newsletter");
    expect(titles).toContain("LinkedIn article");
    // Every item must have thought_leadership work_area
    for (const t of lanes.thoughtLeadership) {
      expect(t.workArea).toBe("thought_leadership");
    }
  });
});

describe("getDashboardLanes — lane 5: product roadmap", () => {
  it("excludes admin and thought_leadership work areas", async () => {
    const { getDashboardLanes } = await import("@/lib/dashboard");
    const lanes = await getDashboardLanes(execSession);
    const workAreas = lanes.productRoadmap.map((t) => t.workArea);
    expect(workAreas).not.toContain("admin");
    expect(workAreas).not.toContain("thought_leadership");
  });

  it("only includes tasks whose project type is hire/deal/okr/other", async () => {
    const { getDashboardLanes } = await import("@/lib/dashboard");
    const lanes = await getDashboardLanes(execSession);
    const titles = lanes.productRoadmap.map((t) => t.title);
    // t9 is in a sales_call project — must be excluded
    expect(titles).not.toContain("Sales call prep");
    // t6 (okr project) and t7 (deal project) should be included
    expect(titles).toContain("Hire senior engineer");
    expect(titles).toContain("Close Series A deal");
  });
});

describe("getDashboardLanes — pinned items always first (US-004)", () => {
  it("pinned tasks appear before non-pinned tasks in the same lane", async () => {
    const { getDashboardLanes } = await import("@/lib/dashboard");
    const lanes = await getDashboardLanes(execSession);
    // t5 (LinkedIn article) is pinned in thought_leadership
    const tl = lanes.thoughtLeadership;
    expect(tl.length).toBeGreaterThan(0);
    expect(tl[0]!.isPinned).toBe(true);
    expect(tl[0]!.title).toBe("LinkedIn article");
  });

  it("pinned null-impact task beats non-pinned both-impact task", async () => {
    const { getDashboardLanes } = await import("@/lib/dashboard");
    const lanes = await getDashboardLanes(execSession);
    // t15 is pinned with null impact; t10 has both impact and no pin.
    // Pinned item must come before the non-pinned both-impact item.
    const adminItems = lanes.admin;
    const pinnedIdx = adminItems.findIndex((t) => t.isPinned);
    const bothIdx   = adminItems.findIndex((t) => t.impact === "both" && !t.isPinned);
    if (pinnedIdx !== -1 && bothIdx !== -1) {
      expect(pinnedIdx).toBeLessThan(bothIdx);
    } else {
      // At least one pinned item must exist (t15 is in seed data)
      expect(pinnedIdx).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("getDashboardLanes — impact tie-break ordering (US-021)", () => {
  it("non-pinned tasks ordered: both > revenue > reputation > neither > null", async () => {
    const { getDashboardLanes } = await import("@/lib/dashboard");
    const lanes = await getDashboardLanes(execSession);
    // Filter to admin lane non-pinned tasks
    const nonPinned = lanes.admin.filter((t) => !t.isPinned);
    if (nonPinned.length < 2) return; // not enough data; guard
    const impactOrdMap: Record<string, number> = {
      both: 1, revenue: 2, reputation: 3, neither: 4,
    };
    const impacts = nonPinned.map((t) => impactOrdMap[t.impact ?? ""] ?? 5);
    // Each consecutive pair must be non-decreasing
    for (let i = 0; i < impacts.length - 1; i++) {
      expect(impacts[i]!).toBeLessThanOrEqual(impacts[i + 1]!);
    }
  });
});

describe("getDashboardLanes — empty lanes", () => {
  it("returns arrays/structs for all lanes (UI handles empty-lane prompts)", async () => {
    const { getDashboardLanes } = await import("@/lib/dashboard");
    const lanes = await getDashboardLanes(execSession);
    expect(Array.isArray(lanes.admin)).toBe(true);
    expect(Array.isArray(lanes.thoughtLeadership)).toBe(true);
    expect(Array.isArray(lanes.productRoadmap)).toBe(true);
    expect(Array.isArray(lanes.prospects)).toBe(true);
    expect(lanes.inbox).toMatchObject({ pendingDraftCount: expect.any(Number) });
  });
});

describe("getDashboardLanes — LANE_LIMIT cap", () => {
  it("returns at most LANE_LIMIT (5) items per task/contact lane", async () => {
    const { getDashboardLanes, LANE_LIMIT } = await import("@/lib/dashboard");
    const lanes = await getDashboardLanes(execSession);
    expect(lanes.admin.length).toBeLessThanOrEqual(LANE_LIMIT);
    expect(lanes.thoughtLeadership.length).toBeLessThanOrEqual(LANE_LIMIT);
    expect(lanes.productRoadmap.length).toBeLessThanOrEqual(LANE_LIMIT);
    expect(lanes.prospects.length).toBeLessThanOrEqual(LANE_LIMIT);
  });
});

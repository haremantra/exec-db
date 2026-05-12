import { sql as drizzleSql } from "drizzle-orm";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema/index";

const DEV_USER_ID = "00000000-0000-0000-0000-000000000001";

// Each contact carries the columns added in PR2-C (sensitive_flag),
// PR2-G (is_draft), and PR2-I (triage_tag, work_area) so seeded demo
// data exercises every CRM feature.
const CONTACTS = [
  {
    id: "11111111-1111-1111-1111-000000000001",
    fullName: "Ada Lovelace",
    primaryEmail: "ada@analytical.example",
    company: "Analytical Engines",
    roleTitle: "Founder",
    sensitiveFlag: null,
    triageTag: "pilot_candidate",
    workArea: "prospecting",
    isDraft: false,
  },
  {
    id: "11111111-1111-1111-1111-000000000002",
    fullName: "Grace Hopper",
    primaryEmail: "grace@cobol.example",
    company: "UNIVAC",
    roleTitle: "Rear Admiral",
    sensitiveFlag: null,
    triageTag: "can_help_me",
    workArea: "investor",
    isDraft: false,
  },
  {
    id: "11111111-1111-1111-1111-000000000003",
    fullName: "Alan Turing",
    primaryEmail: "alan@bletchley.example",
    company: "Bletchley Park",
    roleTitle: "Cryptanalyst",
    sensitiveFlag: null,
    triageTag: "can_help_them",
    workArea: "board",
    isDraft: false,
  },
  {
    id: "11111111-1111-1111-1111-000000000004",
    fullName: "Margaret Hamilton",
    primaryEmail: "margaret@apollo.example",
    company: "MIT Draper Lab",
    roleTitle: "Director of SE",
    // Exercises the sensitive-flag exclusion invariant (#5) in queries.
    sensitiveFlag: "acquisition_target",
    triageTag: null,
    workArea: "customer",
    isDraft: false,
  },
  {
    id: "11111111-1111-1111-1111-000000000005",
    fullName: "Katherine Johnson",
    primaryEmail: "katherine@nasa.example",
    company: "NASA Langley",
    roleTitle: "Mathematician",
    sensitiveFlag: null,
    triageTag: "pilot_candidate",
    workArea: "prospecting",
    isDraft: false,
  },
  // Draft contact (PR2-G) so the "drafts pending review" UI is non-empty.
  {
    id: "11111111-1111-1111-1111-000000000006",
    fullName: "Linkedin Draft",
    primaryEmail: "linkedin-draft@linkedin-draft.invalid",
    company: null,
    roleTitle: null,
    sensitiveFlag: null,
    triageTag: null,
    workArea: null,
    isDraft: true,
  },
];

const ACCOUNTS = [
  { id: "22222222-2222-2222-2222-000000000001", name: "Analytical Engines Ltd", domain: "analytical.example", notes: "Founder-led, early conversations." },
  { id: "22222222-2222-2222-2222-000000000002", name: "UNIVAC",                  domain: "cobol.example",      notes: "Hardware partner discussion." },
];

// Projects carry project_type (PR3-K) so the dashboard "Product roadmap"
// lane query filter matches.
const PROJECTS = [
  { id: "33333333-3333-3333-3333-000000000001", name: "Q2 board prep",       description: "Slides + financial pack for the Q2 board meeting.", targetCompletionDate: "2026-06-15", projectType: "board_prep" },
  { id: "33333333-3333-3333-3333-000000000002", name: "Hire VP Engineering", description: "Source, interview, close VP Eng candidate.",          targetCompletionDate: "2026-08-01", projectType: "hire" },
  { id: "33333333-3333-3333-3333-000000000003", name: "Pricing v2 launch",   description: "Update tiers, draft customer comms, ship.",            targetCompletionDate: "2026-07-10", projectType: "deal" },
];

// Tasks carry the PR3-K columns: impact, is_pinned, work_area, and the
// extended status set (todo / in_progress / blocked / stuck / done).
// Plus one task with awaiting_response_until in the past so the "Needs
// check-in" badge (PR3-R) lights up on the kanban.
const TASKS = [
  { id: "44444444-4444-4444-4444-000000000001", projectId: PROJECTS[0]!.id, title: "Pull MRR + churn pack",         priority: 8, status: "in_progress", dueDate: "2026-05-20", impact: "both",       isPinned: true,  workArea: "admin",              awaitingResponseUntil: null },
  { id: "44444444-4444-4444-4444-000000000002", projectId: PROJECTS[0]!.id, title: "Draft narrative slides",        priority: 7, status: "todo",         dueDate: "2026-05-30", impact: "reputation", isPinned: false, workArea: "thought_leadership", awaitingResponseUntil: null },
  { id: "44444444-4444-4444-4444-000000000003", projectId: PROJECTS[1]!.id, title: "Shortlist 5 candidates",        priority: 9, status: "in_progress", dueDate: "2026-05-15", impact: "revenue",    isPinned: false, workArea: "admin",              awaitingResponseUntil: "2026-05-10T17:00:00-08:00" },
  { id: "44444444-4444-4444-4444-000000000004", projectId: PROJECTS[1]!.id, title: "Reference checks for finalists",priority: 6, status: "blocked",      dueDate: "2026-06-30", impact: "revenue",    isPinned: false, workArea: "admin",              awaitingResponseUntil: null },
  { id: "44444444-4444-4444-4444-000000000005", projectId: PROJECTS[2]!.id, title: "Internal pricing review",       priority: 5, status: "done",         dueDate: "2026-04-30", impact: "revenue",    isPinned: false, workArea: "admin",              awaitingResponseUntil: null },
  { id: "44444444-4444-4444-4444-000000000006", projectId: PROJECTS[2]!.id, title: "Customer comms draft",          priority: 7, status: "stuck",        dueDate: "2026-06-20", impact: "both",       isPinned: false, workArea: "thought_leadership", awaitingResponseUntil: null },
];

// One starred note (PR3-S) so the star-sort behaviour shows up.
const CALL_NOTES = [
  {
    id: "55555555-5555-5555-5555-000000000001",
    contactId: CONTACTS[0]!.id,
    occurredAt: "2026-05-01T16:00:00Z",
    markdown: "## Discovery call with Ada\n\n- Validated **fit** with our product\n- Wants a follow-up with pricing in the next week\n- Action: send case study + pricing tier doc",
    isStarred: true,
  },
  {
    id: "55555555-5555-5555-5555-000000000002",
    contactId: CONTACTS[2]!.id,
    occurredAt: "2026-05-04T10:30:00Z",
    markdown: "## Intro chat with Alan\n\nWarm intro from Grace. Looking for an advisory role; will revisit next quarter.",
    isStarred: false,
  },
];

// One pending draft so the autodraft review UI has something to show
// the moment the dev opens Ada's contact page.
const DRAFTS = [
  {
    id: "66666666-6666-6666-6666-000000000001",
    contactId: CONTACTS[0]!.id,
    subject: "Follow-up: pricing tier doc",
    bodyMarkdown:
      "Hi Ada,\n\nGreat speaking with you on May 1. As discussed [note:55555555-5555-5555-5555-000000000001]:\n\n**Recap.** You're evaluating fit with our product.\n\n**Owners + dates.** I'll send pricing + a case study by EOW.\n\n**Next step.** 30-min review call the following week.\n\n— exec\n\n<!-- citations: [{\"markerId\":\"[note:55555555-...-001]\",\"noteOrThreadId\":\"55555555-5555-5555-5555-000000000001\",\"type\":\"note\"}] -->",
    status: "pending",
    modelId: "claude-sonnet-4-6",
  },
];

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required (run as superuser to bypass RLS).");

  const pg = postgres(url, { max: 1, prepare: false });
  const db = drizzle(pg, { schema });

  try {
    console.log(">> seed: ensuring dev employee exists");
    await db.execute(drizzleSql`
      INSERT INTO core.employee_dim
        (id, work_email, full_name, _source_system, _source_id)
      VALUES
        (${DEV_USER_ID}::uuid, 'dev@exec-db.local', 'Dev Exec', 'seed', 'dev-1')
      ON CONFLICT (id) DO NOTHING
    `);

    console.log(">> seed: dev user_link for stub-auth bypass");
    // Stub-mode (AUTH_PROVIDER=stub) doesn't read crm.user_link, but if the
    // dev flips to AUTH_PROVIDER=clerk locally the dev-UUID still needs a
    // mapping. We use a sentinel Clerk ID so this is recognizable as seed.
    await db.execute(drizzleSql`
      INSERT INTO crm.user_link
        (clerk_user_id, employee_id, tier, function_area)
      VALUES
        ('user_dev_seed_0000000000', ${DEV_USER_ID}::uuid, 'exec_all', NULL)
      ON CONFLICT (clerk_user_id) DO NOTHING
    `);

    console.log(">> seed: contacts");
    for (const c of CONTACTS) {
      await db.execute(drizzleSql`
        INSERT INTO crm.contact
          (id, full_name, primary_email, company, role_title, sensitive_flag,
           triage_tag, work_area, is_draft, created_by)
        VALUES (
          ${c.id}::uuid, ${c.fullName}, ${c.primaryEmail}, ${c.company},
          ${c.roleTitle}, ${c.sensitiveFlag}, ${c.triageTag}, ${c.workArea},
          ${c.isDraft}, ${DEV_USER_ID}::uuid
        )
        ON CONFLICT (id) DO NOTHING
      `);
    }

    console.log(">> seed: accounts");
    for (const a of ACCOUNTS) {
      await db.execute(drizzleSql`
        INSERT INTO crm.account (id, name, domain, notes)
        VALUES (${a.id}::uuid, ${a.name}, ${a.domain}, ${a.notes})
        ON CONFLICT (id) DO NOTHING
      `);
    }

    console.log(">> seed: projects");
    for (const p of PROJECTS) {
      await db.execute(drizzleSql`
        INSERT INTO pm.project
          (id, name, description, owner_id, target_completion_date, project_type)
        VALUES (
          ${p.id}::uuid, ${p.name}, ${p.description}, ${DEV_USER_ID}::uuid,
          ${p.targetCompletionDate}::date, ${p.projectType}
        )
        ON CONFLICT (id) DO NOTHING
      `);
    }

    console.log(">> seed: tasks");
    for (const t of TASKS) {
      await db.execute(drizzleSql`
        INSERT INTO pm.task
          (id, project_id, title, owner_id, priority, status, due_date,
           impact, is_pinned, work_area, awaiting_response_until)
        VALUES (
          ${t.id}::uuid, ${t.projectId}::uuid, ${t.title}, ${DEV_USER_ID}::uuid,
          ${t.priority}, ${t.status}, ${t.dueDate}::date,
          ${t.impact}, ${t.isPinned}, ${t.workArea},
          ${t.awaitingResponseUntil ? drizzleSql`${t.awaitingResponseUntil}::timestamptz` : drizzleSql`NULL`}
        )
        ON CONFLICT (id) DO NOTHING
      `);
    }

    console.log(">> seed: call notes");
    for (const n of CALL_NOTES) {
      await db.execute(drizzleSql`
        INSERT INTO crm.call_note
          (id, contact_id, occurred_at, markdown, author_id, is_starred)
        VALUES (
          ${n.id}::uuid, ${n.contactId}::uuid, ${n.occurredAt}::timestamptz,
          ${n.markdown}, ${DEV_USER_ID}::uuid, ${n.isStarred}
        )
        ON CONFLICT (id) DO NOTHING
      `);
    }

    console.log(">> seed: drafts");
    for (const d of DRAFTS) {
      await db.execute(drizzleSql`
        INSERT INTO crm.draft
          (id, contact_id, subject, body_markdown, status, model_id)
        VALUES (
          ${d.id}::uuid, ${d.contactId}::uuid, ${d.subject},
          ${d.bodyMarkdown}, ${d.status}, ${d.modelId}
        )
        ON CONFLICT (id) DO NOTHING
      `);
    }

    console.log("Seed complete.");
    console.log("  6 contacts (1 sensitive=acquisition_target, 1 is_draft=true)");
    console.log("  2 accounts");
    console.log("  3 projects (board_prep / hire / deal)");
    console.log("  6 tasks (1 pinned, 1 stuck, 1 awaiting-response past)");
    console.log("  2 call notes (1 starred)");
    console.log("  1 pending draft for autodraft review UI");
    console.log("  1 user_link row for the dev UUID");
  } finally {
    await pg.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

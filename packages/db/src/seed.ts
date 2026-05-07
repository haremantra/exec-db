import { sql as drizzleSql } from "drizzle-orm";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema/index.js";

const DEV_USER_ID = "00000000-0000-0000-0000-000000000001";

const CONTACTS = [
  { id: "11111111-1111-1111-1111-000000000001", fullName: "Ada Lovelace",     primaryEmail: "ada@analytical.example",  company: "Analytical Engines",  roleTitle: "Founder" },
  { id: "11111111-1111-1111-1111-000000000002", fullName: "Grace Hopper",     primaryEmail: "grace@cobol.example",     company: "UNIVAC",              roleTitle: "Rear Admiral" },
  { id: "11111111-1111-1111-1111-000000000003", fullName: "Alan Turing",      primaryEmail: "alan@bletchley.example",  company: "Bletchley Park",      roleTitle: "Cryptanalyst" },
  { id: "11111111-1111-1111-1111-000000000004", fullName: "Margaret Hamilton",primaryEmail: "margaret@apollo.example", company: "MIT Draper Lab",      roleTitle: "Director of SE" },
  { id: "11111111-1111-1111-1111-000000000005", fullName: "Katherine Johnson",primaryEmail: "katherine@nasa.example",  company: "NASA Langley",        roleTitle: "Mathematician" },
];

const ACCOUNTS = [
  { id: "22222222-2222-2222-2222-000000000001", name: "Analytical Engines Ltd", domain: "analytical.example", notes: "Founder-led, early conversations." },
  { id: "22222222-2222-2222-2222-000000000002", name: "UNIVAC",                  domain: "cobol.example",      notes: "Hardware partner discussion." },
];

const PROJECTS = [
  { id: "33333333-3333-3333-3333-000000000001", name: "Q2 board prep",        description: "Slides + financial pack for the Q2 board meeting.", targetCompletionDate: "2026-06-15" },
  { id: "33333333-3333-3333-3333-000000000002", name: "Hire VP Engineering",  description: "Source, interview, close VP Eng candidate.",          targetCompletionDate: "2026-08-01" },
  { id: "33333333-3333-3333-3333-000000000003", name: "Pricing v2 launch",    description: "Update tiers, draft customer comms, ship.",            targetCompletionDate: "2026-07-10" },
];

const TASKS = [
  { id: "44444444-4444-4444-4444-000000000001", projectId: PROJECTS[0]!.id, title: "Pull MRR + churn pack",         priority: 8, status: "in_progress", dueDate: "2026-05-20" },
  { id: "44444444-4444-4444-4444-000000000002", projectId: PROJECTS[0]!.id, title: "Draft narrative slides",        priority: 7, status: "todo",         dueDate: "2026-05-30" },
  { id: "44444444-4444-4444-4444-000000000003", projectId: PROJECTS[1]!.id, title: "Shortlist 5 candidates",        priority: 9, status: "in_progress", dueDate: "2026-05-15" },
  { id: "44444444-4444-4444-4444-000000000004", projectId: PROJECTS[1]!.id, title: "Reference checks for finalists",priority: 6, status: "blocked",      dueDate: "2026-06-30" },
  { id: "44444444-4444-4444-4444-000000000005", projectId: PROJECTS[2]!.id, title: "Internal pricing review",       priority: 5, status: "done",         dueDate: "2026-04-30" },
  { id: "44444444-4444-4444-4444-000000000006", projectId: PROJECTS[2]!.id, title: "Customer comms draft",          priority: 7, status: "todo",         dueDate: "2026-06-20" },
];

const CALL_NOTES = [
  {
    id: "55555555-5555-5555-5555-000000000001",
    contactId: CONTACTS[0]!.id,
    occurredAt: "2026-05-01T16:00:00Z",
    markdown: "## Discovery call with Ada\n\n- Validated **fit** with our product\n- Wants a follow-up with pricing in the next week\n- Action: send case study + pricing tier doc",
  },
  {
    id: "55555555-5555-5555-5555-000000000002",
    contactId: CONTACTS[2]!.id,
    occurredAt: "2026-05-04T10:30:00Z",
    markdown: "## Intro chat with Alan\n\nWarm intro from Grace. Looking for an advisory role; will revisit next quarter.",
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

    console.log(">> seed: contacts");
    for (const c of CONTACTS) {
      await db.execute(drizzleSql`
        INSERT INTO crm.contact (id, full_name, primary_email, company, role_title, created_by)
        VALUES (${c.id}::uuid, ${c.fullName}, ${c.primaryEmail}, ${c.company}, ${c.roleTitle}, ${DEV_USER_ID}::uuid)
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
        INSERT INTO pm.project (id, name, description, owner_id, target_completion_date)
        VALUES (${p.id}::uuid, ${p.name}, ${p.description}, ${DEV_USER_ID}::uuid, ${p.targetCompletionDate}::date)
        ON CONFLICT (id) DO NOTHING
      `);
    }

    console.log(">> seed: tasks");
    for (const t of TASKS) {
      await db.execute(drizzleSql`
        INSERT INTO pm.task (id, project_id, title, owner_id, priority, status, due_date)
        VALUES (${t.id}::uuid, ${t.projectId}::uuid, ${t.title}, ${DEV_USER_ID}::uuid,
                ${t.priority}, ${t.status}, ${t.dueDate}::date)
        ON CONFLICT (id) DO NOTHING
      `);
    }

    console.log(">> seed: call notes");
    for (const n of CALL_NOTES) {
      await db.execute(drizzleSql`
        INSERT INTO crm.call_note (id, contact_id, occurred_at, markdown, author_id)
        VALUES (${n.id}::uuid, ${n.contactId}::uuid, ${n.occurredAt}::timestamptz, ${n.markdown}, ${DEV_USER_ID}::uuid)
        ON CONFLICT (id) DO NOTHING
      `);
    }

    console.log("Seed complete.");
  } finally {
    await pg.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

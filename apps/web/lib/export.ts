/**
 * CRM export — "Export my CRM" (US-026 / AD-006 / S1 PR3).
 *
 * Produces a zip archive containing:
 *   - One JSON file per CRM/PM table the exec can read.
 *   - One .md file per call note (notes/<contactName>-<noteId>.md) with
 *     YAML frontmatter (contact, occurred_at, author) and body markdown.
 *
 * Sensitive contacts and their notes ARE included — the exec is exporting
 * their own data, not data belonging to another user.
 *
 * No LLM calls are made.  Pure data export.
 */

import JSZip from "jszip";
import { schema, type Db } from "@exec-db/db";
import type { Session } from "./rbac.js";

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

export type CrmExportResult = {
  filename: string;
  zipBuffer: Buffer;
};

// ---------------------------------------------------------------------------
// Main export function
// ---------------------------------------------------------------------------

/**
 * Build a CRM export zip for the given session.
 *
 * Requires exec_all tier — throws "Forbidden" for any other tier.
 *
 * @param session  The current user session (must be exec_all).
 * @param db       A Drizzle DB instance (already set up with withSession if
 *                 needed; callers should pass a session-bound tx or a raw db).
 */
export async function buildCrmExport(
  session: Session,
  db: Db,
): Promise<CrmExportResult> {
  if (session.tier !== "exec_all") {
    throw new Error("Forbidden: buildCrmExport requires exec_all tier");
  }

  // ── 1. Fetch all CRM/PM tables ──────────────────────────────────────────

  const [
    contacts,
    accounts,
    callNotes,
    drafts,
    calendarEvents,
    emailThreads,
    projects,
    tasks,
  ] = await Promise.all([
    db.select().from(schema.contact),
    db.select().from(schema.account),
    db.select().from(schema.callNote),
    db.select().from(schema.draft),
    db.select().from(schema.calendarEvent),
    db.select().from(schema.emailThread),
    db.select().from(schema.project),
    db.select().from(schema.task),
  ]);

  // ── 2. Build a contact-id → name lookup for .md filenames ─────────────

  const contactNameById = new Map<string, string>(
    contacts.map((c: { id: string; fullName: string }) => [c.id, c.fullName]),
  );

  // ── 3. Assemble the zip ─────────────────────────────────────────────────

  const zip = new JSZip();

  // JSON tables
  zip.file("contact.json", JSON.stringify(contacts, null, 2));
  zip.file("account.json", JSON.stringify(accounts, null, 2));
  zip.file("call_note.json", JSON.stringify(callNotes, null, 2));
  zip.file("draft.json", JSON.stringify(drafts, null, 2));
  zip.file("calendar_event.json", JSON.stringify(calendarEvents, null, 2));
  zip.file("email_thread.json", JSON.stringify(emailThreads, null, 2));
  zip.file("project.json", JSON.stringify(projects, null, 2));
  zip.file("task.json", JSON.stringify(tasks, null, 2));

  // One .md file per call note
  const notesFolder = zip.folder("notes");
  if (notesFolder) {
    for (const note of callNotes) {
      const contactName = contactNameById.get(note.contactId) ?? "unknown";
      // Sanitise name for filesystem: replace anything not alphanumeric/hyphen/underscore
      const safeName = contactName.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_");
      const filename = `${safeName}-${note.id}.md`;

      const frontmatter = [
        "---",
        `contact: "${contactName}"`,
        `contact_id: "${note.contactId}"`,
        `occurred_at: "${note.occurredAt.toISOString()}"`,
        `author_id: "${note.authorId}"`,
        `is_starred: ${note.isStarred}`,
        "---",
        "",
      ].join("\n");

      notesFolder.file(filename, frontmatter + note.markdown);
    }
  }

  // ── 4. Generate zip buffer ──────────────────────────────────────────────

  const isoDate = new Date().toISOString().slice(0, 10);
  const filename = `crm-export-${isoDate}.zip`;

  const zipBuffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });

  return { filename, zipBuffer };
}

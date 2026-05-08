"use server";

import { schema, type SensitiveFlag, SENSITIVE_FLAG_VALUES } from "@exec-db/db";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { query } from "@/lib/db";
import { recordAccess } from "@/lib/audit";

// Re-export so UI layers can import from one place.
export type { SensitiveFlag };
export { SENSITIVE_FLAG_VALUES };

function ctx(session: Awaited<ReturnType<typeof getSession>>) {
  if (!session) throw new Error("Unauthorized");
  return {
    userId: session.userId,
    tier: session.tier,
    functionArea: session.functionArea,
  };
}

export async function createContact(formData: FormData): Promise<void> {
  const session = await getSession();
  const fullName = String(formData.get("fullName") ?? "").trim();
  const primaryEmail = String(formData.get("primaryEmail") ?? "").trim().toLowerCase();
  const company = String(formData.get("company") ?? "").trim() || null;
  const roleTitle = String(formData.get("roleTitle") ?? "").trim() || null;

  if (!fullName || !primaryEmail) {
    throw new Error("fullName and primaryEmail are required");
  }

  const [row] = await query(ctx(session), (tx) =>
    tx
      .insert(schema.contact)
      .values({
        fullName,
        primaryEmail,
        company,
        roleTitle,
        createdBy: session!.userId,
      })
      .returning({ id: schema.contact.id }),
  );

  revalidatePath("/crm/contacts");
  if (row) redirect(`/crm/contacts/${row.id}`);
}

export async function addCallNote(contactId: string, formData: FormData): Promise<void> {
  const session = await getSession();
  const occurredAt = new Date(String(formData.get("occurredAt") ?? new Date().toISOString()));
  const markdown = String(formData.get("markdown") ?? "").trim();
  if (!markdown) throw new Error("markdown is required");

  await query(ctx(session), (tx) =>
    tx.insert(schema.callNote).values({
      contactId,
      occurredAt,
      markdown,
      authorId: session!.userId,
    }),
  );

  revalidatePath(`/crm/contacts/${contactId}`);
}

const NOTE_EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function updateCallNote(
  noteId: string,
  contactId: string,
  formData: FormData,
): Promise<void> {
  const session = await getSession();
  const markdown = String(formData.get("markdown") ?? "").trim();
  if (!markdown) throw new Error("markdown is required");

  await query(ctx(session), async (tx) => {
    const [note] = await tx
      .select({ createdAt: schema.callNote.createdAt, authorId: schema.callNote.authorId })
      .from(schema.callNote)
      .where(and(eq(schema.callNote.id, noteId), eq(schema.callNote.contactId, contactId)))
      .limit(1);

    if (!note) throw new Error("note not found");
    if (note.authorId !== session!.userId) throw new Error("only the author can edit");
    if (Date.now() - note.createdAt.getTime() > NOTE_EDIT_WINDOW_MS) {
      throw new Error("edit window expired (24h after creation)");
    }

    await tx
      .update(schema.callNote)
      .set({ markdown, updatedAt: new Date() })
      .where(eq(schema.callNote.id, noteId));
  });

  revalidatePath(`/crm/contacts/${contactId}`);
}

export async function discardDraft(draftId: string, contactId: string): Promise<void> {
  const session = await getSession();

  await query(ctx(session), (tx) =>
    tx
      .update(schema.draft)
      .set({
        status: "discarded",
        decidedBy: session!.userId,
        decidedAt: new Date(),
      })
      .where(and(eq(schema.draft.id, draftId), eq(schema.draft.contactId, contactId))),
  );

  revalidatePath(`/crm/contacts/${contactId}`);
}

/**
 * Set or clear the sensitive flag on a contact (US-014 / AD-001).
 *
 * Designed to be called via `.bind(null, contactId)` from a form action,
 * so Next.js passes FormData as the second argument.  The flag value is
 * read from the `sensitiveFlag` form field.
 *
 * Only exec_all tier can call this action.  The change is audit-logged via
 * recordAccess() (same pattern as comp.* access logging).
 *
 * Stream E will extend audit logging to include LLM call rows once
 * audit.llm_call is available; for now this uses the existing access-log pattern.
 *
 * @param contactId  UUID of the contact to update (bound argument).
 * @param formData   Form data from the sensitivity selector.
 *                   `sensitiveFlag` field: one of SENSITIVE_FLAG_VALUES or "none".
 *
 * Programmatic callers (e.g., tests) may pass a FormData with the flag set,
 * or use the internal helper _setSensitiveFlagDirect() exported below.
 */
export async function setSensitiveFlag(
  contactId: string,
  formData: FormData,
): Promise<void> {
  const session = await getSession();

  // Only exec_all may set or clear a sensitive flag (US-014 acceptance criterion).
  if (!session || session.tier !== "exec_all") {
    throw new Error("Forbidden: setSensitiveFlag requires exec_all tier");
  }

  const raw = String(formData.get("sensitiveFlag") ?? "").trim();
  const flag: SensitiveFlag | null =
    raw === "" || raw === "none"
      ? null
      : (raw as SensitiveFlag);

  // Validate the flag value even if TypeScript already narrows it.
  if (flag !== null && !(SENSITIVE_FLAG_VALUES as readonly string[]).includes(flag)) {
    throw new Error(`Invalid sensitive flag value: "${flag}"`);
  }

  await query(ctx(session), async (tx) => {
    await tx
      .update(schema.contact)
      .set({ sensitiveFlag: flag, updatedAt: new Date() })
      .where(eq(schema.contact.id, contactId));

    // Audit log: record this sensitive-flag mutation so it is visible in
    // audit.access_log (defense-in-depth; see docs/access-control.md).
    await recordAccess(tx, session, {
      schemaName: "core",  // crm is not in the existing AuditEntry union; use "core" as proxy.
      tableName: "crm.contact",
      action: "UPDATE",
      intent: `setSensitiveFlag contactId=${contactId} flag=${flag ?? "null"}`,
      metadata: { contactId, sensitiveFlag: flag },
    });
  });

  revalidatePath(`/crm/contacts/${contactId}`);
}

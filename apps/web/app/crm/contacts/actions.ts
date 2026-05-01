"use server";

import { schema } from "@exec-db/db";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { query } from "@/lib/db";

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

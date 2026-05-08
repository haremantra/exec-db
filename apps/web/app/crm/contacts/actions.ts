"use server";

import { createHash } from "node:crypto";
import { schema, type SensitiveFlag, SENSITIVE_FLAG_VALUES } from "@exec-db/db";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { query } from "@/lib/db";
import { recordAccess } from "@/lib/audit";
import { safeAnthropic } from "@/lib/anthropic";
import { getContactContext } from "@/lib/contact-context";
import { assertSafeForGmail } from "@/lib/draft-guard";
import { assertNotAutomatedOutbound } from "@/lib/scheduler-guard";
import { createGmailDraft } from "@/lib/google-gmail";

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

// ── Autodraft types ───────────────────────────────────────────────────────────

/** Tone options for the per-draft tone selector (SY-007 / S3.4). */
export const AUTODRAFT_TONE_VALUES = [
  "founder-concise",
  "formal-executive",
  "warm-sales-followup",
] as const;

export type AutodraftTone = (typeof AUTODRAFT_TONE_VALUES)[number];

/** A single citation linking a claim in the draft back to its source. */
export interface DraftCitation {
  /** The footnote marker used in the body, e.g. "[note:abc123]". */
  markerId: string;
  /** UUID of the source note or thread. */
  noteOrThreadId: string;
  /** "note" for a call_note row; "thread" for an email_thread row. */
  type: "note" | "thread";
}

/** Structured output parsed from the LLM response. */
export interface AutodraftOutput {
  subject: string;
  body_markdown: string;
  citations: DraftCitation[];
}

/**
 * Error thrown by `saveDraftToGmail` when the confidential-content guard
 * fires.  Carries the list of reasons so the UI can surface them.
 */
export class ConfidentialContentError extends Error {
  readonly reasons: string[];
  constructor(reasons: string[]) {
    super(
      "Draft body contains confidential markers: " + reasons.join("; ") +
        ". The exec must confirm before saving to Gmail.",
    );
    this.name = "ConfidentialContentError";
    this.reasons = reasons;
  }
}

// ── Tone → prompt instruction ─────────────────────────────────────────────────

function toneInstruction(tone: AutodraftTone): string {
  switch (tone) {
    case "founder-concise":
      return (
        "Write in a founder-style concise tone: direct, first-person, " +
        "plain language, no corporate jargon, 3–5 sentences per section."
      );
    case "formal-executive":
      return (
        "Write in a formal executive tone: third-person-aware, polished, " +
        "full sentences, professional vocabulary suitable for board or " +
        "investor communication."
      );
    case "warm-sales-followup":
      return (
        "Write in a warm sales follow-up tone: friendly, personal, " +
        "future-oriented, emphasise mutual benefit and next steps."
      );
  }
}

// ── Prompt builder ────────────────────────────────────────────────────────────

function buildAutodraftPrompt(
  contact: { fullName: string; primaryEmail: string; company: string | null; roleTitle: string | null },
  notes: Array<{ id: string; occurredAt: Date; markdown: string }>,
  threads: Array<{ id: string; subject: string | null; lastMessageAt: Date | null; snippet: string | null }>,
  tone: AutodraftTone,
): string {
  const toneInstr = toneInstruction(tone);

  const notesSection =
    notes.length === 0
      ? "(no call notes available)"
      : notes
          .map(
            (n, i) =>
              `### Call note ${i + 1} — ${n.occurredAt.toISOString()} [note:${n.id}]\n\n${n.markdown}`,
          )
          .join("\n\n");

  const threadsSection =
    threads.length === 0
      ? "(no email threads available)"
      : threads
          .map(
            (t, i) =>
              `### Email thread ${i + 1} — ${t.lastMessageAt?.toISOString() ?? "unknown date"} [thread:${t.id}]\nSubject: ${t.subject ?? "(no subject)"}\nSnippet: ${t.snippet ?? "(no snippet)"}`,
          )
          .join("\n\n");

  return `You are drafting a professional follow-up email on behalf of the exec.

TONE INSTRUCTION:
${toneInstr}

CONTACT:
Name: ${contact.fullName}
Email: ${contact.primaryEmail}
Company: ${contact.company ?? "—"}
Role: ${contact.roleTitle ?? "—"}

CALL NOTES (most recent first):
${notesSection}

EMAIL THREADS (most recent first):
${threadsSection}

TASK:
Generate a structured follow-up email with exactly three sections:

1. **Recap** — A 2–4 sentence summary of what was discussed, drawing from the notes and threads above. Cite sources inline using the marker format shown above (e.g. "as discussed [note:<noteId>]" or "per your email [thread:<threadId>]").

2. **Owners + dates** — A bulleted list of deliverables with their owners and due dates. Only include items explicitly mentioned in the notes/threads. Cite the source marker for each item.

3. **Next step** — 1–2 sentences on the single most important next action.

OUTPUT FORMAT:
Return ONLY valid JSON with this exact shape — no markdown fences, no commentary outside the JSON:

{
  "subject": "<concise subject line, max 80 chars>",
  "body_markdown": "<full email body in markdown, with the three sections above>",
  "citations": [
    { "markerId": "[note:<noteId>]", "noteOrThreadId": "<noteId>", "type": "note" },
    { "markerId": "[thread:<threadId>]", "noteOrThreadId": "<threadId>", "type": "thread" }
  ]
}

Only include citation entries for markers you actually used in body_markdown.
The body_markdown must contain inline citation markers wherever a fact is sourced.`;
}

// ── sha256 helper ─────────────────────────────────────────────────────────────

function sha256hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// ── B1/B2/B3/B4: generateAutodraft ───────────────────────────────────────────

/**
 * Generate a structured autodraft for a contact (US-012 / SY-005 / SY-006 / SY-007).
 *
 * Reads context via getContactContext (SY-008 isolation enforced).
 * Calls safeAnthropic (redaction + audit log enforced, AD-004 no-send).
 * Inserts a crm.draft row with status="pending".
 * Does NOT save to Gmail — that is a separate explicit user action.
 *
 * @param contactId  UUID of the contact to draft for.
 * @param formData   Must contain "tone" (AutodraftTone); optionally "sourceNoteId".
 * @returns          The generated draft ID.
 */
export async function generateAutodraft(
  contactId: string,
  formData: FormData,
): Promise<string> {
  const session = await getSession();
  if (!session) throw new Error("Unauthorized");

  // Guard: never automate first-touch or phone channels (SY-011).
  // Autodraft is always for email, always a follow-up (not first-touch).
  assertNotAutomatedOutbound({ channel: "email", isFirstTouch: false });

  const toneRaw = String(formData.get("tone") ?? "founder-concise").trim();
  const tone: AutodraftTone =
    (AUTODRAFT_TONE_VALUES as readonly string[]).includes(toneRaw)
      ? (toneRaw as AutodraftTone)
      : "founder-concise";

  // Resolve context via the single sanctioned helper (SY-008 / C2).
  const context = await getContactContext(
    contactId,
    { userId: session.userId, tier: session.tier, functionArea: session.functionArea },
    {
      includeNotes: true,
      includeThreads: true,
      includeEvents: false,
      maxNotes: 5,
      maxThreads: 5,
    },
  );

  if (!context.contact) {
    throw new Error(`Contact not found or not accessible: ${contactId}`);
  }

  const prompt = buildAutodraftPrompt(
    context.contact,
    context.notes,
    context.threads,
    tone,
  );

  // Model selection: default Sonnet; Opus when tone indicates high-stakes draft.
  // Currently tone="formal-executive" opts into Opus (closest to "opus-required").
  const model = tone === "formal-executive" ? "opus" : "sonnet";

  // Call through safeAnthropic — redaction + audit enforced (SY-016 / SY-017).
  const result = await safeAnthropic({
    model,
    prompt,
    contactId,
    promptClass: "autodraft",
    maxTokens: 4096,
  });

  // Parse structured JSON output.
  let parsed: AutodraftOutput;
  try {
    // Strip any accidental markdown fences the model may have added.
    const cleaned = result.text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/, "")
      .trim();
    parsed = JSON.parse(cleaned) as AutodraftOutput;
  } catch {
    throw new Error(
      "generateAutodraft: LLM returned non-JSON output. " +
        "Raw response (first 200 chars): " +
        result.text.slice(0, 200),
    );
  }

  // Validate required fields.
  if (!parsed.subject || !parsed.body_markdown) {
    throw new Error(
      "generateAutodraft: LLM output missing required fields (subject / body_markdown).",
    );
  }

  // Compute prompt hash for the draft row (sha256 of the redacted prompt).
  const promptHash = sha256hex(prompt).slice(0, 64);

  // Insert draft row (status="pending"; NOT saved to Gmail yet).
  const draftId = await query(
    { userId: session.userId, tier: session.tier, functionArea: session.functionArea },
    async (tx) => {
      const [row] = await tx
        .insert(schema.draft)
        .values({
          contactId,
          subject: parsed.subject,
          bodyMarkdown: parsed.body_markdown,
          modelId: model,
          promptHash,
          status: "pending",
        })
        .returning({ id: schema.draft.id });
      return row?.id ?? null;
    },
  );

  if (!draftId) {
    throw new Error("generateAutodraft: failed to insert draft row.");
  }

  revalidatePath(`/crm/contacts/${contactId}`);
  return draftId;
}

// ── B5: saveDraftToGmail ──────────────────────────────────────────────────────

/**
 * Save a pending draft to Gmail Drafts (compose scope only — AD-004).
 *
 * Runs the confidential-content guard (AD-003).  If the guard fires,
 * throws ConfidentialContentError with the list of reasons.  The UI must
 * show these reasons and offer a "I confirm this is safe" button that calls
 * saveDraftToGmailConfirmed instead.
 *
 * Updates crm.draft.status to "saved_to_gmail" and records gmail_draft_id.
 *
 * @param draftId   UUID of the crm.draft row to save.
 * @param contactId Contact UUID — used for path validation + revalidation.
 * @param formData  Must contain "to" (recipient email); optionally "threadId".
 */
export async function saveDraftToGmail(
  draftId: string,
  contactId: string,
  formData: FormData,
): Promise<void> {
  const session = await getSession();
  if (!session) throw new Error("Unauthorized");

  const to = String(formData.get("to") ?? "").trim();
  if (!to) throw new Error("saveDraftToGmail: 'to' email address is required.");

  const threadId = String(formData.get("threadId") ?? "").trim() || undefined;

  // Load the draft row.
  const draft = await query(
    { userId: session.userId, tier: session.tier, functionArea: session.functionArea },
    async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.draft)
        .where(and(eq(schema.draft.id, draftId), eq(schema.draft.contactId, contactId)))
        .limit(1);
      return row ?? null;
    },
  );

  if (!draft) throw new Error(`Draft not found: ${draftId}`);
  if (draft.status !== "pending") {
    throw new Error(
      `saveDraftToGmail: draft ${draftId} is not pending (status="${draft.status}").`,
    );
  }

  // Run confidential-content guard (AD-003).
  const guardResult = assertSafeForGmail(draft.bodyMarkdown ?? "");
  if (!guardResult.safe) {
    throw new ConfidentialContentError(guardResult.reasons);
  }

  // Save to Gmail via the sanctioned compose-only helper (AD-004).
  const createResult = await createGmailDraft(session.userId, {
    to,
    subject: draft.subject ?? "",
    bodyMarkdown: draft.bodyMarkdown ?? "",
    threadId,
  });
  // The real google-gmail.ts returns { draftId }; our stub returns { gmailDraftId }.
  // Support both shapes for compatibility during the stream A/B merge window.
  const resolvedDraftId =
    (createResult as { draftId?: string; gmailDraftId?: string }).draftId ??
    (createResult as { draftId?: string; gmailDraftId?: string }).gmailDraftId ??
    null;

  // Update draft status.
  await query(
    { userId: session.userId, tier: session.tier, functionArea: session.functionArea },
    async (tx) => {
      await tx
        .update(schema.draft)
        .set({
          status: "saved_to_gmail",
          gmailDraftId: resolvedDraftId,
          decidedBy: session.userId,
          decidedAt: new Date(),
        })
        .where(eq(schema.draft.id, draftId));
    },
  );

  revalidatePath(`/crm/contacts/${contactId}`);
}

// ── B5: saveDraftToGmailConfirmed ─────────────────────────────────────────────

/**
 * Override path: save a draft to Gmail after the exec has explicitly confirmed
 * that any flagged confidential content is safe to send (AD-003 override).
 *
 * IMPORTANT: This action BYPASSES the confidential-content guard.
 * The override is logged to audit.access_log so it is auditable.
 *
 * @param draftId   UUID of the crm.draft row.
 * @param contactId Contact UUID.
 * @param formData  Must contain "to"; optionally "threadId".
 */
export async function saveDraftToGmailConfirmed(
  draftId: string,
  contactId: string,
  formData: FormData,
): Promise<void> {
  const session = await getSession();
  if (!session) throw new Error("Unauthorized");

  const to = String(formData.get("to") ?? "").trim();
  if (!to) throw new Error("saveDraftToGmailConfirmed: 'to' email address is required.");

  const threadId = String(formData.get("threadId") ?? "").trim() || undefined;

  // Load the draft row.
  const draft = await query(
    { userId: session.userId, tier: session.tier, functionArea: session.functionArea },
    async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.draft)
        .where(and(eq(schema.draft.id, draftId), eq(schema.draft.contactId, contactId)))
        .limit(1);
      return row ?? null;
    },
  );

  if (!draft) throw new Error(`Draft not found: ${draftId}`);

  // Log the confidential-content guard override to audit.access_log.
  await query(
    { userId: session.userId, tier: session.tier, functionArea: session.functionArea },
    async (tx) => {
      await recordAccess(tx, session, {
        schemaName: "core",
        tableName: "crm.draft",
        action: "UPDATE",
        intent: `saveDraftToGmailConfirmed: exec confirmed confidential-content override for draftId=${draftId} contactId=${contactId}`,
        metadata: {
          draftId,
          contactId,
          override: "confidential_content_guard_bypassed",
        },
      });
    },
  );

  // Save to Gmail (guard bypassed after exec confirmation).
  const createResult = await createGmailDraft(session.userId, {
    to,
    subject: draft.subject ?? "",
    bodyMarkdown: draft.bodyMarkdown ?? "",
    threadId,
  });
  // The real google-gmail.ts returns { draftId }; our stub returns { gmailDraftId }.
  // Support both shapes for compatibility during the stream A/B merge window.
  const resolvedDraftId =
    (createResult as { draftId?: string; gmailDraftId?: string }).draftId ??
    (createResult as { draftId?: string; gmailDraftId?: string }).gmailDraftId ??
    null;

  // Update draft status.
  await query(
    { userId: session.userId, tier: session.tier, functionArea: session.functionArea },
    async (tx) => {
      await tx
        .update(schema.draft)
        .set({
          status: "saved_to_gmail",
          gmailDraftId: resolvedDraftId,
          decidedBy: session.userId,
          decidedAt: new Date(),
        })
        .where(eq(schema.draft.id, draftId));
    },
  );

  revalidatePath(`/crm/contacts/${contactId}`);
}

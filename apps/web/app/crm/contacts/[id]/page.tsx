import { schema } from "@exec-db/db";
import { and, desc, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { getSession } from "@/lib/auth";
import { query } from "@/lib/db";
import { renderMarkdown } from "@/lib/markdown";
import {
  addCallNote,
  discardDraft,
  updateCallNote,
  setSensitiveFlag,
  generateAutodraft,
  saveDraftToGmail,
  saveDraftToGmailConfirmed,
  SENSITIVE_FLAG_VALUES,
  AUTODRAFT_TONE_VALUES,
} from "../actions";
import type { SensitiveFlag, AutodraftTone, DraftCitation } from "../actions";

const NOTE_EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;

export const dynamic = "force-dynamic";

export default async function ContactDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ edit?: string }>;
}): Promise<JSX.Element> {
  const { id } = await params;
  const { edit: editingNoteId } = await searchParams;
  const session = await getSession();
  if (!session) return <p className="text-sm">Sign in required.</p>;

  const ctx = {
    userId: session.userId,
    tier: session.tier,
    functionArea: session.functionArea,
  };

  const data = await query(ctx, async (tx) => {
    const [c] = await tx.select().from(schema.contact).where(eq(schema.contact.id, id)).limit(1);
    if (!c) return null;

    const notes = await tx
      .select()
      .from(schema.callNote)
      .where(eq(schema.callNote.contactId, id))
      .orderBy(desc(schema.callNote.occurredAt))
      .limit(50);

    const events = await tx
      .select()
      .from(schema.calendarEvent)
      .where(eq(schema.calendarEvent.contactId, id))
      .orderBy(desc(schema.calendarEvent.startsAt))
      .limit(20);

    const threads = await tx
      .select()
      .from(schema.emailThread)
      .where(eq(schema.emailThread.contactId, id))
      .orderBy(desc(schema.emailThread.lastMessageAt))
      .limit(20);

    const drafts = await tx
      .select()
      .from(schema.draft)
      .where(and(eq(schema.draft.contactId, id), eq(schema.draft.status, "pending")))
      .orderBy(desc(schema.draft.generatedAt))
      .limit(10);

    return { contact: c, notes, events, threads, drafts };
  });

  if (!data) notFound();

  const canWrite = session.tier === "exec_all";
  const addNote = addCallNote.bind(null, id);
  const setFlag = setSensitiveFlag.bind(null, id);

  /** Human-readable tone labels for the selector (SY-007). */
  const TONE_LABELS: Record<AutodraftTone, string> = {
    "founder-concise": "Founder-style concise (default)",
    "formal-executive": "Formal executive",
    "warm-sales-followup": "Warm sales follow-up",
  };

  /**
   * Parse citations JSON stored in the draft.
   * The draft row doesn't have a dedicated citations column yet, so we
   * embed them as a JSON comment at the end of body_markdown:
   * <!-- citations: [...] -->
   * This avoids a schema change in Stream B.
   */
  function parseCitations(bodyMarkdown: string | null): DraftCitation[] {
    if (!bodyMarkdown) return [];
    const match = bodyMarkdown.match(/<!--\s*citations:\s*(\[.*?\])\s*-->/s);
    if (!match || !match[1]) return [];
    try {
      return JSON.parse(match[1]) as DraftCitation[];
    } catch {
      return [];
    }
  }

  /**
   * Strip the embedded citations comment from the body before rendering
   * so the exec doesn't see raw JSON in the draft preview.
   */
  function stripCitationsComment(bodyMarkdown: string | null): string {
    if (!bodyMarkdown) return "";
    return bodyMarkdown.replace(/\s*<!--\s*citations:\s*\[.*?\]\s*-->\s*$/s, "");
  }

  /** Human-readable label for each sensitive-flag value. */
  const SENSITIVE_FLAG_LABELS: Record<SensitiveFlag, string> = {
    rolled_off_customer: "Rolled-off customer",
    irrelevant_vendor: "Irrelevant vendor",
    acquisition_target: "Acquisition target",
    loi: "LOI (letter of intent)",
    vc_outreach: "VC outreach",
    partnership: "Partnership",
  };

  const currentFlag = data.contact.sensitiveFlag as SensitiveFlag | null;

  return (
    <div className="space-y-8">
      {/* Sensitive-contact banner — visible to exec_all when a flag is set */}
      {canWrite && currentFlag && (
        <div
          role="alert"
          className="rounded-md border border-red-400 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-700 dark:bg-red-950 dark:text-red-200"
        >
          <strong>This contact is marked sensitive: {SENSITIVE_FLAG_LABELS[currentFlag]}.</strong>
          {" "}Excluded from drafts, search, and digests for non-exec users.
        </div>
      )}

      <header>
        <h2 className="text-lg font-medium">{data.contact.fullName}</h2>
        <p className="text-sm text-neutral-500">
          {data.contact.primaryEmail}
          {data.contact.company ? ` · ${data.contact.company}` : ""}
          {data.contact.roleTitle ? ` · ${data.contact.roleTitle}` : ""}
        </p>
      </header>

      {/* ── Autodraft generation form (B2: tone selector + generate button) ── */}
      {canWrite && (
        <section>
          <h3 className="mb-2 text-sm font-medium">Generate follow-up draft</h3>
          <form
            action={generateAutodraft.bind(null, id)}
            className="flex items-center gap-3 flex-wrap"
          >
            {/* Tone selector — SY-007 / S3.4 */}
            <label className="text-xs text-neutral-600 dark:text-neutral-400">
              Tone
            </label>
            <select
              name="tone"
              defaultValue="founder-concise"
              className="rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            >
              {AUTODRAFT_TONE_VALUES.map((t: AutodraftTone) => (
                <option key={t} value={t}>
                  {TONE_LABELS[t]}
                </option>
              ))}
            </select>
            <button
              type="submit"
              className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white dark:bg-neutral-100 dark:text-neutral-900"
            >
              Generate draft
            </button>
          </form>
        </section>
      )}

      {/* ── Structured draft review UI (B5) ── */}
      {data.drafts.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-medium">Drafts pending review</h3>
          <ul className="space-y-4">
            {data.drafts.map((d) => {
              const citations = parseCitations(d.bodyMarkdown);
              const bodyForRender = stripCitationsComment(d.bodyMarkdown);
              return (
                <li
                  key={d.id}
                  className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-700 dark:bg-amber-950"
                >
                  {/* Subject */}
                  <div className="mb-2 font-medium text-base">
                    {d.subject ?? "(no subject)"}
                  </div>

                  {/* Body — structured markdown (SY-005) */}
                  <div
                    className="prose prose-sm dark:prose-invert max-w-none"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(bodyForRender) }}
                  />

                  {/* Citations footnotes (SY-006) */}
                  {citations.length > 0 && (
                    <div className="mt-3 border-t border-amber-200 pt-2 dark:border-amber-800">
                      <p className="text-xs font-medium text-neutral-500 mb-1">
                        Sources cited:
                      </p>
                      <ul className="flex flex-wrap gap-2">
                        {citations.map((c: DraftCitation) => (
                          <li key={c.markerId}>
                            <a
                              href={
                                c.type === "note"
                                  ? `#note-${c.noteOrThreadId}`
                                  : `#thread-${c.noteOrThreadId}`
                              }
                              className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800 hover:bg-amber-200 dark:bg-amber-900 dark:text-amber-200"
                            >
                              {c.markerId}
                            </a>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Action buttons */}
                  {canWrite && (
                    <div className="mt-3 flex flex-wrap items-center gap-3">
                      {/* Save to Gmail Drafts */}
                      <form
                        action={saveDraftToGmail.bind(null, d.id, id)}
                        className="flex items-center gap-2"
                      >
                        <input
                          type="hidden"
                          name="to"
                          value={data.contact.primaryEmail}
                        />
                        <button
                          type="submit"
                          className="rounded bg-blue-700 px-3 py-1.5 text-xs text-white hover:bg-blue-800 dark:bg-blue-600 dark:hover:bg-blue-700"
                        >
                          Save to Gmail Drafts
                        </button>
                      </form>

                      {/* Confirmed override (shown alongside normal save for simplicity;
                          in production the UI would swap buttons after a guard error) */}
                      <form
                        action={saveDraftToGmailConfirmed.bind(null, d.id, id)}
                        className="flex items-center gap-2"
                      >
                        <input
                          type="hidden"
                          name="to"
                          value={data.contact.primaryEmail}
                        />
                        <button
                          type="submit"
                          className="rounded border border-orange-400 px-3 py-1.5 text-xs text-orange-700 hover:bg-orange-50 dark:border-orange-600 dark:text-orange-400"
                          title="Bypasses the confidential-content guard. Use only after reviewing for sensitive data."
                        >
                          I confirm this is safe — save anyway
                        </button>
                      </form>

                      {/* Discard */}
                      <form action={discardDraft.bind(null, d.id, id)}>
                        <button
                          type="submit"
                          className="text-xs text-neutral-600 underline hover:text-neutral-900 dark:text-neutral-300"
                        >
                          Discard
                        </button>
                      </form>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* Sensitivity selector — exec_all only (US-014 / AD-001) */}
      {canWrite && (
        <section>
          <h3 className="mb-2 text-sm font-medium">Sensitivity</h3>
          <form action={setFlag} className="flex items-center gap-3">
            <select
              name="sensitiveFlag"
              defaultValue={currentFlag ?? "none"}
              className="rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            >
              <option value="none">— None (not sensitive)</option>
              {SENSITIVE_FLAG_VALUES.map((v: SensitiveFlag) => (
                <option key={v} value={v}>
                  {SENSITIVE_FLAG_LABELS[v]}
                </option>
              ))}
            </select>
            <button
              type="submit"
              className="rounded border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700"
            >
              Save
            </button>
          </form>
        </section>
      )}

      {canWrite && (
        <section>
          <h3 className="mb-2 text-sm font-medium">Add call note</h3>
          <form action={addNote} className="space-y-2">
            <input
              name="occurredAt"
              type="datetime-local"
              className="rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
            <textarea
              name="markdown"
              required
              rows={5}
              placeholder="Markdown notes — what was discussed, what's next…"
              className="block w-full rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
            <button
              type="submit"
              className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white dark:bg-neutral-100 dark:text-neutral-900"
            >
              Save note
            </button>
          </form>
        </section>
      )}

      <section>
        <h3 className="mb-2 text-sm font-medium">Call notes ({data.notes.length})</h3>
        <ul className="space-y-3">
          {data.notes.length === 0 && (
            <li className="text-sm text-neutral-500">No notes yet.</li>
          )}
          {data.notes.map((n) => {
            const isEditing = editingNoteId === n.id;
            const withinWindow =
              Date.now() - n.createdAt.getTime() <= NOTE_EDIT_WINDOW_MS;
            const isAuthor = n.authorId === session.userId;
            const canEdit = canWrite && isAuthor && withinWindow;
            return (
              <li
                key={n.id}
                className="rounded-md border border-neutral-200 p-3 text-sm dark:border-neutral-800"
              >
                <div className="mb-1 flex items-center justify-between text-xs text-neutral-500">
                  <span>{n.occurredAt.toISOString()}</span>
                  {canEdit && !isEditing && (
                    <a
                      href={`?edit=${n.id}#note-${n.id}`}
                      id={`note-${n.id}`}
                      className="text-xs underline hover:text-neutral-900 dark:hover:text-neutral-200"
                    >
                      Edit
                    </a>
                  )}
                  {!withinWindow && isAuthor && (
                    <span className="text-xs italic">Edit window expired</span>
                  )}
                </div>
                {isEditing && canEdit ? (
                  <form
                    action={updateCallNote.bind(null, n.id, id)}
                    className="space-y-2"
                  >
                    <textarea
                      name="markdown"
                      required
                      rows={5}
                      defaultValue={n.markdown}
                      className="block w-full rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                    />
                    <div className="flex gap-2">
                      <button
                        type="submit"
                        className="rounded bg-neutral-900 px-3 py-1.5 text-xs text-white dark:bg-neutral-100 dark:text-neutral-900"
                      >
                        Save changes
                      </button>
                      <a
                        href="?"
                        className="rounded border border-neutral-300 px-3 py-1.5 text-xs dark:border-neutral-700"
                      >
                        Cancel
                      </a>
                    </div>
                  </form>
                ) : (
                  <div
                    className="prose prose-sm dark:prose-invert max-w-none"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(n.markdown) }}
                  />
                )}

                {/* B6: "Generate follow-up" button on each call note (US-012) */}
                {canWrite && !isEditing && (
                  <form
                    action={generateAutodraft.bind(null, id)}
                    className="mt-2 flex items-center gap-2"
                  >
                    {/* sourceNoteId is informational — the action uses getContactContext
                        which retrieves the 5 most recent notes anyway (including this one). */}
                    <input type="hidden" name="sourceNoteId" value={n.id} />
                    <input type="hidden" name="tone" value="founder-concise" />
                    <button
                      type="submit"
                      className="rounded border border-neutral-300 px-2 py-1 text-xs text-neutral-700 hover:border-neutral-500 hover:text-neutral-900 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-neutral-500"
                    >
                      Generate follow-up
                    </button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <section className="grid grid-cols-2 gap-4">
        <div>
          <h3 className="mb-2 text-sm font-medium">Calendar events ({data.events.length})</h3>
          <p className="text-xs text-neutral-500">Synced in PR 2.</p>
          <ul className="mt-2 space-y-1 text-sm">
            {data.events.map((e) => (
              <li key={e.id}>
                <span className="text-neutral-500">{e.startsAt?.toISOString() ?? ""}</span>{" "}
                {e.title}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="mb-2 text-sm font-medium">Email threads ({data.threads.length})</h3>
          <p className="text-xs text-neutral-500">Synced in PR 2.</p>
          <ul className="mt-2 space-y-1 text-sm">
            {data.threads.map((t) => (
              <li key={t.id}>
                <span className="text-neutral-500">{t.lastMessageAt?.toISOString() ?? ""}</span>{" "}
                {t.subject}
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}

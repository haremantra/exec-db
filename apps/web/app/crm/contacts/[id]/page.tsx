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
  SENSITIVE_FLAG_VALUES,
} from "../actions";
import type { SensitiveFlag } from "../actions";

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

      {data.drafts.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-medium">Drafts pending review</h3>
          <ul className="space-y-3">
            {data.drafts.map((d) => (
              <li
                key={d.id}
                className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950"
              >
                <div className="mb-1 font-medium">{d.subject ?? "(no subject)"}</div>
                <div
                  className="prose prose-sm dark:prose-invert max-w-none"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(d.bodyMarkdown) }}
                />
                {canWrite && (
                  <form action={discardDraft.bind(null, d.id, id)} className="mt-2">
                    <button
                      type="submit"
                      className="text-xs text-neutral-600 underline hover:text-neutral-900 dark:text-neutral-300"
                    >
                      Discard
                    </button>
                  </form>
                )}
              </li>
            ))}
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

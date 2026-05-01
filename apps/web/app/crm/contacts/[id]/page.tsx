import { schema } from "@exec-db/db";
import { and, desc, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { getSession } from "@/lib/auth";
import { query } from "@/lib/db";
import { addCallNote, discardDraft } from "../actions";

export const dynamic = "force-dynamic";

export default async function ContactDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<JSX.Element> {
  const { id } = await params;
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

  return (
    <div className="space-y-8">
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
                <pre className="whitespace-pre-wrap font-sans text-sm">{d.bodyMarkdown}</pre>
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
          {data.notes.map((n) => (
            <li
              key={n.id}
              className="rounded-md border border-neutral-200 p-3 text-sm dark:border-neutral-800"
            >
              <div className="mb-1 text-xs text-neutral-500">{n.occurredAt.toISOString()}</div>
              <pre className="whitespace-pre-wrap font-sans text-sm">{n.markdown}</pre>
            </li>
          ))}
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
